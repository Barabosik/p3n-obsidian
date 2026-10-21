import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EditorPosition, EditorTransaction } from 'obsidian';
import { type EditorLike, type Source, capture, findSentence, locate, replace } from '../src/source.ts';
import { AI_TEXT, SHORT } from './fixtures.ts';

// A stand-in for Obsidian's Editor over a plain string, with the same line/ch positions.
class FakeEditor implements EditorLike {
	doc: string;
	selections: { anchor: number; head: number }[];
	transactions: EditorTransaction[] = [];
	selected: [number, number] | null = null;

	constructor(doc: string, selections: [number, number][] = []) {
		this.doc = doc;
		this.selections = selections.map(([anchor, head]) => ({ anchor, head }));
	}

	getValue() {
		return this.doc;
	}

	offsetToPos(offset: number): EditorPosition {
		const before = this.doc.slice(0, Math.min(offset, this.doc.length)).split('\n');
		return { line: before.length - 1, ch: before[before.length - 1]?.length ?? 0 };
	}

	posToOffset(pos: EditorPosition): number {
		const lines = this.doc.split('\n');
		let offset = 0;
		for (let i = 0; i < pos.line; i++) offset += (lines[i]?.length ?? 0) + 1;
		return offset + pos.ch;
	}

	listSelections() {
		return this.selections.map((s) => ({ anchor: this.offsetToPos(s.anchor), head: this.offsetToPos(s.head) }));
	}

	transaction(tx: EditorTransaction) {
		this.transactions.push(tx);
		// Apply from the end, so earlier offsets stay right.
		const changes = [...(tx.changes ?? [])].map((c) => ({ from: this.posToOffset(c.from), to: this.posToOffset(c.to ?? c.from), text: c.text })).sort((a, b) => b.from - a.from);
		for (const c of changes) this.doc = this.doc.slice(0, c.from) + c.text + this.doc.slice(c.to);
	}

	setSelection(anchor: EditorPosition, head?: EditorPosition) {
		this.selected = [this.posToOffset(anchor), this.posToOffset(head ?? anchor)];
	}

	scrollIntoView() {}
}

const NOTE = `# Draft\n\nIntro line.\n${SHORT}\n\nThe end.`;
const at = (doc: string, text: string): [number, number] => [doc.indexOf(text), doc.indexOf(text) + text.length];

describe('taking the selection', () => {
	it('takes the selected text and where it is', () => {
		const ed = new FakeEditor(NOTE, [at(NOTE, SHORT)]);
		const got = capture(ed, 'Drafts/Draft.md', 'Draft');
		assert.deepEqual(got, { ok: true, source: { path: 'Drafts/Draft.md', note: 'Draft', text: SHORT, from: NOTE.indexOf(SHORT), to: NOTE.indexOf(SHORT) + SHORT.length } });
	});

	it('a selection made backwards is the same selection', () => {
		const [from, to] = at(NOTE, SHORT);
		const got = capture(new FakeEditor(NOTE, [[to, from]]), 'a.md', 'a');
		assert.equal(got.ok && got.source.text, SHORT);
	});

	it('across lines', () => {
		const text = `Intro line.\n${SHORT}`;
		const got = capture(new FakeEditor(NOTE, [at(NOTE, text)]), 'a.md', 'a');
		assert.equal(got.ok && got.source.text, text);
	});

	it('nothing selected, or only spaces', () => {
		assert.deepEqual(capture(new FakeEditor(NOTE, [[5, 5]]), 'a.md', 'a'), { ok: false, reason: 'none' });
		assert.deepEqual(capture(new FakeEditor(NOTE, [at(NOTE, '\n\n')]), 'a.md', 'a'), { ok: false, reason: 'none' });
	});

	it('several selections: one at a time', () => {
		assert.deepEqual(capture(new FakeEditor(NOTE, [at(NOTE, 'Intro'), at(NOTE, 'The end')]), 'a.md', 'a'), { ok: false, reason: 'many' });
		// A cursor next to a selection is still one selection.
		assert.equal(capture(new FakeEditor(NOTE, [[0, 0], at(NOTE, 'Intro line.')]), 'a.md', 'a').ok, true);
	});
});

describe('Replace selection', () => {
	const source = (doc: string, text: string): Source => ({ path: 'a.md', note: 'a', text, from: at(doc, text)[0], to: at(doc, text)[1] });

	it('puts the rewrite where the selection was, in one change, and selects it', () => {
		const ed = new FakeEditor(NOTE);
		const r = replace(ed, source(NOTE, SHORT), 'This transition helps teams of all sizes.');
		assert.equal(r.ok, true);
		assert.equal(ed.doc, NOTE.replace(SHORT, 'This transition helps teams of all sizes.'));
		assert.equal(ed.transactions.length, 1);
		assert.equal(ed.transactions[0]?.changes?.length, 1);
		const start = NOTE.indexOf(SHORT);
		assert.deepEqual(ed.selected, [start, start + 'This transition helps teams of all sizes.'.length]);
	});

	it('finds the text after edits above it', () => {
		const src = source(NOTE, SHORT);
		const ed = new FakeEditor(NOTE.replace('Intro line.', 'A longer intro line, added later.'));
		assert.equal(replace(ed, src, 'New.').ok, true);
		assert.equal(ed.doc, `# Draft\n\nA longer intro line, added later.\nNew.\n\nThe end.`);
	});

	it('refuses when the text changed, and changes nothing', () => {
		const src = source(NOTE, SHORT);
		const edited = NOTE.replace('seamless', 'smooth');
		const ed = new FakeEditor(edited);
		assert.deepEqual(replace(ed, src, 'New.'), { ok: false, reason: 'changed' });
		assert.equal(ed.doc, edited);
		assert.equal(ed.transactions.length, 0);
	});

	it('refuses when the text moved and now occurs twice', () => {
		const src = source(NOTE, 'The end.');
		const doc = `The end.\n${NOTE}x`;
		assert.deepEqual(locate(doc, src), { ok: false, reason: 'changed' });
	});
});

describe('finding a flagged sentence in the note', () => {
	const doc = `${AI_TEXT}\n\nLater: ${AI_TEXT}`;
	const sentence = "In today's fast-paced world, it's worth noting that effective communication is more important than ever.";

	it('the one in the selection, not the first in the note', () => {
		const second = doc.lastIndexOf(AI_TEXT);
		const hit = findSentence(doc, { path: 'a.md', note: 'a', text: AI_TEXT, from: second, to: second + AI_TEXT.length }, sentence);
		assert.deepEqual(hit, { from: second, to: second + sentence.length });
	});

	it('whatever whitespace the note has between the words', () => {
		const wrapped = sentence.replace('that effective', 'that\neffective');
		assert.deepEqual(findSentence(wrapped, null, sentence), { from: 0, to: wrapped.length });
	});

	it('nothing when it is gone', () => assert.equal(findSentence('Other text.', null, sentence), null));
});
