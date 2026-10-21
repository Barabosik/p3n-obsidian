// The p3n API (https://p3n.si/docs). Calls without a key are free, a few an hour per IP;
// a key from p3n.si/dashboard/keys goes in as a bearer token.
// Ported from the browser extension's lib/api.js: same calls, errors and wording. The HTTP call itself is a
// Transport, so Obsidian's requestUrl goes in here and tests pass a stand-in.
export const API = 'https://api.p3n.si';
export const SITE = 'https://p3n.si';
export const LINKS = {
	keys: `${SITE}/dashboard/keys`,
	billing: `${SITE}/dashboard/billing`,
	signup: `${SITE}/register`,
	docs: `${SITE}/docs`,
	privacy: `${SITE}/privacy`,
};
// The API's input limits: without a key, and with one (https://p3n.si/docs).
export const MAX_CHARS = { free: 5_000, key: 200_000 };
// Detect refuses shorter text (counted in code points, after trimming).
export const MIN_DETECT_CHARS = 40;

export type Skill = 'detect' | 'humanize';

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

// Sends one request and resolves with the answer, whatever its status. Rejects only when there's no answer.
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export interface Sentence {
	text: string;
	why?: string;
}

export interface Example {
	sentence: string;
	rules?: { name?: string }[];
}

export interface DetectOutput {
	version?: string;
	ai: number;
	label?: string;
	verdict?: string;
	confidence?: { level?: string; reason?: string };
	sentences?: Sentence[];
	examples?: Example[];
}

export interface HumanizeOutput {
	version?: string;
	text: string;
	ai_before?: number | null;
	ai_after: number;
	label_after?: string;
	passes?: boolean;
	invented_blocked?: string[];
}

export interface Run {
	id: string;
	skill: string;
	status: string;
	cached?: boolean;
	error?: string | null;
	charged_usd?: string | number | null;
	output?: Record<string, unknown> | null;
}

// { email, balance_usd, key: { name, prefix } }
export interface Me {
	email?: string;
	balance_usd?: string | number;
	key?: { name?: string; prefix?: string };
}

export interface ErrorExtra {
	signupUrl?: string | null;
	retryAfter?: number | null;
	free?: number | null;
}

export class ApiError extends Error {
	status: number;
	type: string;
	signupUrl: string | null;
	retryAfter: number | null;
	free: number | null;

	constructor(status: number, type: string, message: string, extra: ErrorExtra = {}) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.type = type;
		this.signupUrl = extra.signupUrl ?? null;
		this.retryAfter = extra.retryAfter ?? null;
		this.free = extra.free ?? null;
	}
}

export const abortError = () => new DOMException('Aborted', 'AbortError');
export const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

const TYPE_BY_STATUS: Record<number, string> = { 401: 'unauthorized', 402: 'insufficient_credit', 403: 'forbidden', 404: 'not_found', 422: 'invalid_request', 429: 'rate_limited', 502: 'upstream_error' };

// Header names come back lower-cased on desktop, but not on every platform.
function header(headers: Record<string, string>, name: string): string | null {
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === want) return v;
	return null;
}

const numberOrNull = (v: string | null) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null; // empty, or an HTML error page
	}
}

interface CallOptions {
	method?: string;
	body?: unknown;
	key?: string;
	signal?: AbortSignal;
}

interface Answer<T> {
	data: T;
	status: number;
	free: number | null;
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) return reject(abortError());
	const t = window.setTimeout(resolve, ms);
	signal?.addEventListener('abort', () => {
		window.clearTimeout(t);
		reject(abortError());
	}, { once: true });
});

export class P3nClient {
	transport: Transport;
	// Every call names this client (X-P3N-Client), for the user's usage page: p3n-obsidian and its version.
	client: string;
	// The wait between polls of a long run (the tests make it instant).
	pause: (ms: number, signal?: AbortSignal) => Promise<void> = sleep;

	constructor(transport: Transport, client: string) {
		this.transport = transport;
		this.client = client;
	}

	async call<T>(path: string, { method = 'GET', body, key, signal }: CallOptions = {}): Promise<Answer<T>> {
		const headers: Record<string, string> = { Accept: 'application/json', 'X-P3N-Client': this.client };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		if (key) headers.Authorization = `Bearer ${key}`;
		if (signal?.aborted) throw abortError();
		let res: HttpResponse;
		try {
			res = await this.transport({ url: API + path, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		} catch {
			if (signal?.aborted) throw abortError();
			throw new ApiError(0, 'network', "Can't reach p3n. Check your connection and try again.");
		}
		// requestUrl can't be stopped: once Cancel is pressed, its answer is dropped.
		if (signal?.aborted) throw abortError();
		const free = numberOrNull(header(res.headers, 'X-Free-Remaining'));
		const data = parse(res.text) as Record<string, unknown> | null;
		if (res.status < 200 || res.status >= 300) {
			const err = (data?.error ?? {}) as Record<string, unknown>;
			const message = typeof err.message === 'string' ? err.message : typeof data?.message === 'string' ? data.message : `p3n answered ${res.status}.`;
			const signup = typeof err.signup_url === 'string' ? err.signup_url : '';
			throw new ApiError(res.status, typeof err.type === 'string' ? err.type : TYPE_BY_STATUS[res.status] ?? 'error', message, {
				// Only p3n's own sign-up page goes into the Sign up button.
				signupUrl: signup.startsWith(`${SITE}/`) ? signup : null,
				retryAfter: Number(err.retry_after_seconds ?? header(res.headers, 'Retry-After')) || null,
				free,
			});
		}
		return { data: data as T, status: res.status, free };
	}

	// Runs a skill on `text` and returns { run, free }. Long inputs come back as 202 and are polled.
	async runSkill(skill: Skill, text: string, { key, options, signal }: { key?: string; options?: Record<string, unknown>; signal?: AbortSignal } = {}) {
		const body: Record<string, unknown> = { text };
		if (options) body.options = options;
		const first = await this.call<Run>(`/v1/${skill}`, { method: 'POST', body, key, signal });
		let run = first.data;
		let status = first.status;
		const free = first.free;
		const going = () => status === 202 || run?.status === 'queued' || run?.status === 'running';
		for (let i = 0; going() && i < 150; i++) {
			await this.pause(2000, signal);
			try {
				({ data: run, status } = await this.call<Run>(`/v1/runs/${run.id}`, { key, signal }));
			} catch (e) {
				// A connection blip doesn't stop the run on the server (it's still charged): keep polling.
				if (!(e instanceof ApiError) || e.type !== 'network') throw e;
			}
		}
		// Still going after 5 minutes: it may yet finish (and be charged), so don't call it failed.
		if (run?.status === 'queued' || run?.status === 'running') {
			throw new ApiError(504, 'still_running', 'p3n stopped waiting after 5 minutes. The run may still finish and be charged. Try a shorter text.');
		}
		if (run?.status === 'failed' || !run?.output) {
			throw new ApiError(502, 'run_failed', run?.error || 'The run failed. You were not charged. Try again.');
		}
		return { run, free };
	}

	async me(key: string): Promise<Me> {
		return (await this.call<Me>('/v1/me', { key })).data;
	}
}
