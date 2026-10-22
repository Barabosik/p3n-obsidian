// The text p3n works on: one selection in one note, and putting a rewrite back where it was.
// Only the Editor methods used here, so the tests can pass a stand-in.
import type { EditorPosition, EditorTransaction } from 'obsidian';

export interface EditorLike {
	getValue(): string;
	listSelections(): { anchor: EditorPosition; head: EditorPosition }[];
	posToOffset(pos: EditorPosition): number;
	offsetToPos(offset: number): EditorPosition;
	transaction(tx: EditorTransaction, origin?: string): void;
	setSelection(anchor: EditorPosition, head?: EditorPosition): void;
	scrollIntoView(range: { from: EditorPosition; to: EditorPosition }, center?: boolean): void;
}

// What was selected, and where: the note's path and the selection's offsets in it when it was taken.
export interface Source {
	path: string;
	note: string;
	text: string;
	from: number;
	to: number;
}

export type Capture = { ok: true; source: Source } | { ok: false; reason: 'none' | 'many' };

export const CAPTURE_HINTS = {
	none: 'Nothing is selected in the note. Select some text first.',
	many: 'p3n works on one selection at a time. Select one passage.',
	noNote: 'Open a note and select some text first.',
	reading: 'This note is in reading view. Switch to editing view and select the text there.',
};

export function capture(editor: EditorLike, path: string, note: string): Capture {
	const ranges = editor.listSelections()
		.map((s) => [editor.posToOffset(s.anchor), editor.posToOffset(s.head)].sort((a, b) => a - b) as [number, number])
		.filter(([from, to]) => from !== to);
	if (ranges.length > 1) return { ok: false, reason: 'many' };
	const [range] = ranges;
	if (!range) return { ok: false, reason: 'none' };
	const [from, to] = range;
	const text = editor.getValue().slice(from, to);
	if (!text.trim()) return { ok: false, reason: 'none' };
	return { ok: true, source: { path, note, text, from, to } };
}

export type Located = { ok: true; from: number; to: number } | { ok: false; reason: 'changed' };

// Where the selected text is now: where it was, or, after edits above it, the one place it occurs.
export function locate(doc: string, source: Source): Located {
	if (doc.slice(source.from, source.to) === source.text) return { ok: true, from: source.from, to: source.to };
	const first = doc.indexOf(source.text);
	if (first !== -1 && doc.indexOf(source.text, first + 1) === -1) return { ok: true, from: first, to: first + source.text.length };
	return { ok: false, reason: 'changed' };
}

// Puts the rewrite where the selection was, as one change (one undo step), and selects it.
export function replace(editor: EditorLike, source: Source, rewrite: string): Located {
	const at = locate(editor.getValue(), source);
	if (!at.ok) return at;
	const from = editor.offsetToPos(at.from);
	editor.transaction({ changes: [{ from, to: editor.offsetToPos(at.to), text: rewrite }] }, 'p3n');
	const to = editor.offsetToPos(at.from + rewrite.length);
	editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
	return { ok: true, from: at.from, to: at.from + rewrite.length };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A flagged sentence in the note: the first match at or after the selection, else anywhere. The API may
// collapse spaces and line breaks, so any run of whitespace matches any other.
export function findSentence(doc: string, source: Source | null, sentence: string): { from: number; to: number } | null {
	const words = sentence.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return null;
	const re = new RegExp(words.map(escape).join('\\s+'), 'g');
	let fallback: { from: number; to: number } | null = null;
	for (const m of doc.matchAll(re)) {
		const hit = { from: m.index, to: m.index + m[0].length };
		if (!source || hit.from >= source.from) return hit;
		fallback ??= hit;
	}
	return fallback;
}

export function select(editor: EditorLike, at: { from: number; to: number }) {
	const from = editor.offsetToPos(at.from);
	const to = editor.offsetToPos(at.to);
	editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
}
