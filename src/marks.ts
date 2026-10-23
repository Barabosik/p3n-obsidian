// Where Check's sentences are in the checked text, for the highlights in the note. Kept free of the editor so
// the tests can read it. Compared as the engine does: curly quotes as straight, any run of whitespace as one
// space, any case, punctuation at either end left out.

export type MarkKind = 'sentence' | 'hit';

export interface MarkWanted {
	text: string;
	kind: MarkKind;
	why: string;
}

export interface Mark {
	from: number;
	to: number;
	kind: MarkKind;
	why: string;
}

const QUOTES: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"' };

// The text compared, and for each of its characters the offset it came from.
function fold(s: string): { text: string; at: number[] } {
	let text = '';
	const at: number[] = [];
	for (let i = 0; i < s.length; i++) {
		const c = s[i] ?? '';
		if (/\s/.test(c)) {
			if (text.endsWith(' ')) continue;
			text += ' ';
		} else {
			const lower = c.toLowerCase();
			text += QUOTES[c] ?? (lower.length === 1 ? lower : c);
		}
		at.push(i);
	}
	return { text, at };
}

const trimEdges = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// Each wanted sentence's place in `text` (offsets into it), in order. A sentence asked for again goes to its
// next occurrence; one that isn't there is left out.
export function findMarks(text: string, wanted: MarkWanted[]): Mark[] {
	const hay = fold(text);
	const next = new Map<string, number>();
	const marks: Mark[] = [];
	for (const w of wanted) {
		const needle = fold(trimEdges(w.text.trim())).text;
		if (!needle) continue;
		const i = hay.text.indexOf(needle, next.get(needle) ?? 0);
		if (i < 0) continue;
		next.set(needle, i + needle.length);
		const from = hay.at[i] ?? 0;
		const to = (hay.at[i + needle.length - 1] ?? from) + 1;
		marks.push({ from, to, kind: w.kind, why: w.why });
	}
	return marks.sort((a, b) => a.from - b.from || a.to - b.to);
}
