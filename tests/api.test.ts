import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API, ApiError, P3nClient } from '../src/api.ts';
import { FIXTURES, fakeTransport, json } from './fixtures.ts';

// sleep() uses window's timers, as the plugin does in Obsidian.
(globalThis as { window?: unknown }).window ??= globalThis;

const CLIENT = 'p3n-obsidian/0.1.0';
const client = (answers: Parameters<typeof fakeTransport>[0]) => {
	const fake = fakeTransport(answers);
	const c = new P3nClient(fake.transport, CLIENT);
	c.pause = () => Promise.resolve();
	return { c, requests: fake.requests };
};

describe('API calls', () => {
	it('posts the text to /v1/<skill> and names the client, keyless', async () => {
		const { c, requests } = client([json(200, FIXTURES.detect, { 'x-free-remaining': '9' })]);
		const { run, free } = await c.runSkill('detect', 'Some text');
		assert.equal(run.output?.ai, 0.96);
		assert.equal(free, 9);
		const [req] = requests;
		assert.ok(req);
		assert.equal(req.url, `${API}/v1/detect`);
		assert.equal(req.method, 'POST');
		assert.deepEqual(JSON.parse(req.body ?? ''), { text: 'Some text' });
		assert.equal(req.headers['X-P3N-Client'], CLIENT);
		assert.equal(req.headers['Content-Type'], 'application/json');
		assert.equal(req.headers.Accept, 'application/json');
		assert.equal('Authorization' in req.headers, false);
	});

	it('sends the key as a bearer token, and options when given', async () => {
		const { c, requests } = client([json(200, FIXTURES.humanize)]);
		await c.runSkill('humanize', 'Text', { key: 'p3n_abc', options: { fresh: true } });
		assert.equal(requests[0]?.headers.Authorization, 'Bearer p3n_abc');
		assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), { text: 'Text', options: { fresh: true } });
	});

	it('reads X-Free-Remaining whatever its case', async () => {
		const { c } = client([json(200, FIXTURES.detect, { 'X-Free-Remaining': '3' })]);
		assert.equal((await c.runSkill('detect', 'x')).free, 3);
	});

	it('polls a long run until it finishes, through a connection blip', async () => {
		const { c, requests } = client([
			json(202, { id: 'r1', skill: 'humanize', status: 'queued' }, { 'x-free-remaining': '8' }),
			json(200, { id: 'r1', skill: 'humanize', status: 'running' }),
			new Error('net::ERR_NETWORK_CHANGED'),
			json(200, { ...FIXTURES.humanize, id: 'r1' }),
		]);
		const { run, free } = await c.runSkill('humanize', 'Long text');
		assert.equal(run.status, 'succeeded');
		assert.equal(free, 8);
		assert.deepEqual(requests.map((r) => `${r.method} ${r.url.replace(API, '')}`), ['POST /v1/humanize', 'GET /v1/runs/r1', 'GET /v1/runs/r1', 'GET /v1/runs/r1']);
		assert.equal(requests[1]?.body, undefined);
	});

	it("stops after 5 minutes of polling and doesn't call the run failed", async () => {
		const answers = [json(202, { id: 'r2', skill: 'detect', status: 'queued' })];
		for (let i = 0; i < 150; i++) answers.push(json(200, { id: 'r2', skill: 'detect', status: 'running' }));
		const { c } = client(answers);
		await assert.rejects(c.runSkill('detect', 'x'), (e: ApiError) => e.type === 'still_running' && /may still finish and be charged/.test(e.message));
	});

	it('cancel drops the answer', async () => {
		const controller = new AbortController();
		// Cancel is pressed while the request is out: requestUrl still answers, and the answer is dropped.
		const { c } = client([() => {
			controller.abort();
			return json(200, FIXTURES.detect);
		}]);
		await assert.rejects(c.runSkill('detect', 'x', { signal: controller.signal }), { name: 'AbortError' });
	});

	it('GET /v1/me with the key', async () => {
		const { c, requests } = client([json(200, { email: 'a@b.c', balance_usd: '1.5', key: { name: 'laptop' } })]);
		const m = await c.me('p3n_k');
		assert.equal(m.email, 'a@b.c');
		assert.equal(requests[0]?.method, 'GET');
		assert.equal(requests[0]?.url, `${API}/v1/me`);
		assert.equal(requests[0]?.headers.Authorization, 'Bearer p3n_k');
		assert.equal('Content-Type' in (requests[0]?.headers ?? {}), false);
	});
});

describe('API errors', () => {
	const fails = async (answer: Parameters<typeof fakeTransport>[0][number], check: (e: ApiError) => void, skill: 'detect' | 'humanize' = 'detect') => {
		const { c } = client([answer]);
		await assert.rejects(c.runSkill(skill, 'x'), (e: unknown) => {
			assert.ok(e instanceof ApiError);
			check(e);
			return true;
		});
	};

	it('free limit: its type, retry time and remaining count; Sign up only to p3n.si', () => fails(
		json(429, { error: { type: 'free_limit', message: 'Free calls are used up.', signup_url: 'javascript:alert(1)', retry_after_seconds: 600 } }, { 'x-free-remaining': '0' }),
		(e) => {
			assert.equal(e.type, 'free_limit');
			assert.equal(e.retryAfter, 600);
			assert.equal(e.free, 0);
			assert.equal(e.signupUrl, null);
		},
	));

	it("keeps p3n's own sign-up link", () => fails(
		json(429, { error: { type: 'free_limit', message: 'x', signup_url: 'https://p3n.si/register?from=limit' } }),
		(e) => assert.equal(e.signupUrl, 'https://p3n.si/register?from=limit'),
	));

	it("504 too_long: the API's message", () => fails(
		json(504, { error: { type: 'too_long', message: 'The text took longer than 85 s to process; send a shorter text. Not charged.' } }),
		(e) => {
			assert.equal(e.type, 'too_long');
			assert.match(e.message, /send a shorter text/);
		},
		'humanize',
	));

	it('an HTML error page', () => fails(
		{ status: 502, headers: { 'content-type': 'text/html' }, text: '<!doctype html><title>502</title>Bad gateway' },
		(e) => {
			assert.equal(e.type, 'upstream_error');
			assert.equal(e.message, 'p3n answered 502.');
		},
	));

	it('statuses without a type get one', () => fails(json(401, {}), (e) => assert.equal(e.type, 'unauthorized')));

	it('a failed run: its error', () => fails(
		json(200, { ...FIXTURES.humanize, status: 'failed', output: null, error: 'The model provider failed. You were not charged.' }),
		(e) => {
			assert.equal(e.type, 'run_failed');
			assert.match(e.message, /provider failed/);
		},
		'humanize',
	));

	it('no connection', () => fails(new Error('net::ERR_INTERNET_DISCONNECTED'), (e) => {
		assert.equal(e.type, 'network');
		assert.equal(e.message, "Can't reach p3n. Check your connection and try again.");
	}));
});
