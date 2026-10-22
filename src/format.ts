// What the results say: numbers, labels and copy, kept free of the DOM so the tests can read them.
// The wording is the browser extension's and the Word add-in's, with "page" and "document" turned into "note".
import { type ApiError, type DetectOutput, type HumanizeOutput, type Run, type Skill, LINKS, MAX_CHARS, MIN_DETECT_CHARS } from './api.ts';

export type Tone = 'ai' | 'mid' | 'human';

export const pct = (x: number | null | undefined) => Math.round((x || 0) * 100);
export const tone = (x: number): Tone => (x >= 0.7 ? 'ai' : x >= 0.4 ? 'mid' : 'human');
export const LABELS: Record<string, string> = { human: 'Likely human-written', ai: 'Likely AI-written', ai_edited: 'AI-written, then edited', humanized: 'AI-written, then humanized', mixed: 'Mixed: part human, part AI' };
export const words = (t: string | null | undefined) => (t || '').trim().split(/\s+/).filter(Boolean).length;
export const clip = (t: string, n = 220) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t);
export const limit = (hasKey: boolean) => (hasKey ? MAX_CHARS.key : MAX_CHARS.free);
export const count = (n: number) => n.toLocaleString('en-US');

// Why a selection can't be sent, or null when it can.
export function refuse(skill: Skill, text: string, hasKey: boolean): string | null {
	const n = text.length;
	if (n > limit(hasKey)) {
		return hasKey
			? `That's ${count(n)} characters; the API takes up to ${count(MAX_CHARS.key)}. Select less.`
			: `That's ${count(n)} characters. Without an API key p3n takes up to ${count(MAX_CHARS.free)}. Select less, or add a key.`;
	}
	if (skill === 'detect' && [...text].length < MIN_DETECT_CHARS) {
		return `Check needs at least ${MIN_DETECT_CHARS} characters, a sentence or two. Select more.`;
	}
	return null;
}

export const sourceLine = (note: string, n: number, hasKey: boolean) => `From ${note}: ${count(n)} / ${count(limit(hasKey))} characters`;

export function busyText(skill: Skill, seconds: number): string {
	const what = skill === 'detect' ? 'Checking' : 'Rewriting';
	return `${what}… ${seconds} s` + (skill === 'humanize' && seconds > 8 ? ' (a rewrite takes up to a minute)' : '');
}

// Without the fields this version reads, say so: don't show 0% or a script error.
export function missingResult(run: Run): boolean {
	const o = run.output ?? {};
	if (run.skill === 'detect') return typeof o.ai !== 'number';
	if (run.skill === 'humanize') return typeof o.text !== 'string' || typeof o.ai_after !== 'number';
	return false;
}
export const MISSING_RESULT = 'p3n answered without a result. Try again. If it keeps happening, update the plugin.';

export const metaLine = (run: Run, hasKey: boolean) => {
	const version = typeof run.output?.version === 'string' ? run.output.version : run.skill;
	const cost = hasKey && run.charged_usd ? ` · $${Number(run.charged_usd).toFixed(4)}` : '';
	return `${version}${run.cached ? ' · from cache' : ''}${cost}`;
};

const norm = (t: string | undefined) => (t || '').replace(/\s+/g, ' ').trim();

// The view is narrow: the sentences come first, and a pattern hit is listed only if its sentence isn't already there.
export function detectParts(o: DetectOutput) {
	const sentences = (o.sentences ?? []).slice(0, 5);
	const shown = new Set(sentences.map((s) => norm(s.text)));
	const hits = (o.examples ?? [])
		.filter((e) => !shown.has(norm(e.sentence)))
		.slice(0, 6)
		.map((e) => ({ rules: (e.rules ?? []).map((r) => String(r.name ?? '').replace(/\s*\(LLM\)$/, '')).join(' · '), sentence: e.sentence }));
	return {
		label: LABELS[o.label ?? ''] ?? 'Unknown',
		score: pct(o.ai),
		tone: tone(o.ai),
		verdict: o.verdict || null,
		confidence: o.confidence?.level ? `Confidence ${o.confidence.level}: ${o.confidence.reason ?? ''}` : null,
		sentences,
		hits,
	};
}
export const DETECT_NOTE = 'A score is a probability, not proof. Read the sentences yourself before deciding anything about a person.';

// "No longer" and "Still" only when the detector model put the text sent in the AI class: it can score
// text at 0% that Check called likely AI, and "No longer reads as AI, 0% → 2%" reads wrong.
export function headline(o: Pick<HumanizeOutput, 'passes' | 'ai_before'>): string {
	const wasAI = o.ai_before != null && o.ai_before >= 0.5;
	return o.passes ? (wasAI ? 'No longer reads as AI' : "Doesn't read as AI") : (wasAI ? 'Still reads as AI' : 'Reads as AI');
}

// The rewrite ends with a line break; keep only the whitespace the selection itself had at each end, so
// Replace doesn't join it to the line or word before or after.
export function fitRewrite(selected: string, rewrite: string): string {
	return (selected.match(/^\s*/)?.[0] ?? '') + rewrite.trim() + (selected.match(/\s*$/)?.[0] ?? '');
}

export function humanizeParts(o: HumanizeOutput, sent: string) {
	const notes: { text: string; warn: boolean }[] = [];
	if (words(o.text) / Math.max(1, words(sent)) < 0.6) {
		notes.push({ warn: true, text: `Kept ${words(o.text)} of ${words(sent)} words. Most of this text was general statements with no facts in them, and those are what reads as AI. Add the specifics you meant (who, what, numbers) and run it again.` });
	}
	if (o.invented_blocked?.length) {
		notes.push({ warn: false, text: `Kept as sent where a rewrite added ${o.invented_blocked.join(', ')}, which the text does not have.` });
	}
	return {
		headline: headline(o),
		model: `Detector model: ${LABELS[o.label_after ?? ''] ?? 'unknown'}`,
		before: o.ai_before != null ? pct(o.ai_before) : null,
		score: pct(o.ai_after),
		tone: tone(o.ai_after),
		notes,
	};
}
export const HUMANIZE_NOTE = 'The rewrite drops filler and general statements that carry no fact. Check that every claim you need is still there.';

export type ErrorAction = { kind: 'link'; label: string; href: string; primary: boolean } | { kind: 'key'; label: string };

// What an error says, and the buttons under it.
export function errorParts(e: ApiError | Error): { lines: string[]; small: string | null; actions: ErrorAction[] } {
	const type = 'type' in e ? e.type : '';
	switch (type) {
		case 'free_limit': {
			const err = e as ApiError;
			const mins = err.retryAfter ? Math.max(1, Math.ceil(err.retryAfter / 60)) : null;
			return {
				lines: [`The free calls for this hour are used up${mins ? `; more in about ${mins} min` : ''}.`],
				small: 'Sign up at p3n.si for free credit, then create an API key and add it here to keep going.',
				actions: [{ kind: 'link', label: 'Sign up', href: err.signupUrl || LINKS.signup, primary: true }, { kind: 'key', label: 'Add an API key' }],
			};
		}
		case 'insufficient_credit':
			return { lines: ['Your p3n balance is too low for this.'], small: null, actions: [{ kind: 'link', label: 'Top up', href: LINKS.billing, primary: true }] };
		case 'unauthorized':
			return { lines: ["p3n didn't accept your API key. It may have been revoked."], small: null, actions: [{ kind: 'key', label: 'Change the key' }] };
		case 'rate_limited':
			return { lines: ['Too many requests at once. Wait a minute and try again.'], small: null, actions: [] };
		default:
			return { lines: [e.message || 'Something went wrong.'], small: null, actions: [] };
	}
}

export function quotaLine(hasKey: boolean, free: number | null): string | null {
	if (hasKey) return null;
	return free != null
		? `${free} free ${free === 1 ? 'call' : 'calls'} left this hour without a key.`
		: 'Free without a key: 10 calls an hour, up to 5,000 characters each.';
}

export const balanceLine = (balance: string | number | undefined, keyName: string | undefined) => `Balance $${Number(balance ?? 0).toFixed(2)} · key ${keyName ?? ''}`.trim();

// The undo shortcut, for the line after Replace.
export function undoKey(platform: { isMacOS: boolean; isMobile: boolean }): string {
	if (platform.isMobile) return 'Undo';
	return platform.isMacOS ? 'Cmd+Z' : 'Ctrl+Z';
}
