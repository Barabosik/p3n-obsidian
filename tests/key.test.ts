import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API, P3nClient } from '../src/api.ts';
import { checkKey } from '../src/key.ts';
import { fakeTransport, json } from './fixtures.ts';

const client = (answers: Parameters<typeof fakeTransport>[0]) => {
	const fake = fakeTransport(answers);
	return { c: new P3nClient(fake.transport, 'p3n-obsidian/0.1.4'), requests: fake.requests };
};
const ME = { email: 'a@b.c', balance_usd: '1.5', key: { name: 'laptop', prefix: 'p3n_ab' } };

// A key picked in the settings is saved only when p3n accepts it, so a typo never replaces a good key.
describe('checking an API key', () => {
	it('picked and accepted: Saved, with the account and its balance', async () => {
		const { c, requests } = client([json(200, ME)]);
		assert.deepEqual(await checkKey(c, 'p3n_good', true), { ok: true, kind: 'ok', text: 'Saved. Signed in as a@b.c, balance $1.50.' });
		assert.equal(requests[0]?.url, `${API}/v1/me`);
		assert.equal(requests[0]?.headers.Authorization, 'Bearer p3n_good');
	});

	it('the saved key, when the settings open: no Saved', async () => {
		const { c } = client([json(200, ME)]);
		assert.equal((await checkKey(c, 'p3n_good', false)).text, 'Signed in as a@b.c, balance $1.50.');
	});

	it("refused: not saved, and says where to copy it again", async () => {
		const { c } = client([json(401, { error: { type: 'unauthorized', message: 'Invalid API key.' } })]);
		assert.deepEqual(await checkKey(c, 'p3n_typo', true), { ok: false, kind: 'error', text: "p3n doesn't accept this key, so it wasn't saved. Copy it again from the API keys page." });
		const saved = client([json(401, {})]);
		assert.equal((await checkKey(saved.c, 'p3n_old', false)).text, "p3n doesn't accept this key. Copy it again from the API keys page.");
	});

	it("not a p3n key, or an empty secret: no call, not saved", async () => {
		const { c, requests } = client([]);
		assert.deepEqual(await checkKey(c, 'sk-123', true), { ok: false, kind: 'warn', text: "Keys start with p3n_. Copy the whole key from the API keys page. The key wasn't saved." });
		assert.deepEqual(await checkKey(c, 'p3n_ with a space', true), { ok: false, kind: 'warn', text: "Keys start with p3n_. Copy the whole key from the API keys page. The key wasn't saved." });
		assert.equal((await checkKey(c, '', true)).text, "That secret is empty on this device. Pick another, or add the key again. The key wasn't saved.");
		assert.equal((await checkKey(c, '', false)).text, 'That secret is empty on this device. Pick another, or add the key again.');
		assert.equal(requests.length, 0);
	});

	it("no connection: not saved, since p3n couldn't say", async () => {
		const { c } = client([new Error('net::ERR_INTERNET_DISCONNECTED')]);
		assert.deepEqual(await checkKey(c, 'p3n_good', true), { ok: false, kind: 'error', text: "Can't reach p3n. Check your connection and try again. The key wasn't saved." });
	});
});
