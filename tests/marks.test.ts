import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type MarkWanted, findMarks } from '../src/marks.ts';

const s = (text: string, why = ''): MarkWanted => ({ text, kind: 'sentence', why });
const at = (text: string, wanted: MarkWanted[]) => findMarks(text, wanted).map((m) => text.slice(m.from, m.to));

describe('highlights: where the sentences are in the checked text', () => {
	it('a sentence as written, with its kind and why', () => {
		const text = 'Intro. Moreover, it unlocks potential. End.';
		const [m] = findMarks(text, [{ text: 'Moreover, it unlocks potential.', kind: 'hit', why: 'Moreover' }]);
		assert.deepEqual(m, { from: 7, to: 37, kind: 'hit', why: 'Moreover' });
	});

	it('curly quotes as straight, any case, whitespace runs and line breaks as one space', () => {
		const text = "In today’s  fast-paced\nworld, it’s worth noting.";
		assert.deepEqual(at(text, [s("IN TODAY'S FAST-PACED WORLD, it's worth noting.")]), ["In today’s  fast-paced\nworld, it’s worth noting"]);
	});

	it('punctuation at either end is left out', () => {
		assert.deepEqual(at('He said "teams thrive here." Then left.', [s('"Teams thrive here."')]), ['teams thrive here']);
	});

	it('a repeated sentence goes to its next occurrence', () => {
		const text = 'Teams thrive. Teams thrive. Teams thrive.';
		const marks = findMarks(text, [s('Teams thrive.'), s('teams thrive')]);
		assert.deepEqual(marks.map((m) => m.from), [0, 14]);
	});

	it('one that is not there is skipped; empty ones too', () => {
		assert.deepEqual(at('Only this.', [s('Not here.'), s('  '), s('...'), s('Only this.')]), ['Only this']);
	});

	it('sorted by place in the text', () => {
		assert.deepEqual(at('First one. Second one.', [s('Second one.'), s('First one.')]), ['First one', 'Second one']);
	});
});
