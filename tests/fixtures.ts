// Test texts and canned API answers, the same as the browser extension's and the Word add-in's tests.
import type { HttpRequest, HttpResponse, Run, Transport } from '../src/api.ts';

export const AI_TEXT = "In today's fast-paced world, it's worth noting that effective communication is more important than ever. Moreover, leveraging the right tools can help teams unlock their full potential and navigate the complexities of modern work.";
export const SHORT = 'Ultimately, this seamless transition unlocks a rich tapestry of possibilities for teams of all sizes, empowering everyone to thrive in an ever-evolving landscape.';

export const FIXTURES: Record<'detect' | 'humanize', Run> = {
	detect: {
		id: 'mock-detect', skill: 'detect', status: 'succeeded', cached: false, error: null, charged_usd: '0',
		output: {
			version: 'detect-v1.2', ai: 0.96, label: 'ai', verdict: 'Generic filler phrases with no specific claim or example.', confidence: { level: 'medium', reason: 'Two short sentences.' },
			sentences: [{ text: AI_TEXT.split('. ')[0] + '.', why: 'A stock opening with a vague claim.' }], examples: [],
		},
	},
	humanize: {
		id: 'mock-humanize', skill: 'humanize', status: 'succeeded', cached: false, error: null, charged_usd: '0',
		// The live API ends the rewrite with a line break; the plugin must not carry it into the note.
		output: { version: 'humanize-v1.3', model: 'haiku', text: 'This transition helps teams of all sizes.\n', ai_before: 0.95, ai_after: 0.01, label_after: 'human', passes: true, invented_blocked: [] },
	},
};

// The rewrite headline says "No longer" or "Still" only when the detector model put the text sent in the AI
// class (ai_before >= 0.5).
export const HEADLINES: [{ ai_before: number | null; ai_after: number; passes: boolean }, string][] = [
	[{ ai_before: 0.95, ai_after: 0.01, passes: true }, 'No longer reads as AI'],
	[{ ai_before: 0.08, ai_after: 0.02, passes: true }, "Doesn't read as AI"],
	[{ ai_before: 0.88, ai_after: 0.71, passes: false }, 'Still reads as AI'],
	[{ ai_before: 0.3, ai_after: 0.62, passes: false }, 'Reads as AI'],
	[{ ai_before: null, ai_after: 0.04, passes: true }, "Doesn't read as AI"],
];

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, text: JSON.stringify(body) });

// A stand-in for requestUrl: answers in turn from `answers` (a function, a response, or an Error to throw),
// and keeps every request it got.
export function fakeTransport(answers: (HttpResponse | Error | ((req: HttpRequest) => HttpResponse))[]) {
	const requests: HttpRequest[] = [];
	const transport: Transport = (req) => {
		requests.push(req);
		const next = answers.shift();
		if (next === undefined) return Promise.reject(new Error('no answer queued'));
		if (next instanceof Error) return Promise.reject(next);
		return Promise.resolve(typeof next === 'function' ? next(req) : next);
	};
	return { transport, requests };
}
