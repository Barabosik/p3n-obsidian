import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, type DetectOutput, type HumanizeOutput } from '../src/api.ts';
import { busyText, detectParts, errorParts, fitRewrite, headline, humanizeParts, metaLine, missingResult, quotaLine, refuse, sourceLine, tone, undoKey } from '../src/format.ts';
import { AI_TEXT, FIXTURES, HEADLINES, SHORT } from './fixtures.ts';

describe('what a result says', () => {
	for (const [scores, want] of HEADLINES) {
		it(`rewrite headline: ${want} (${scores.ai_before} → ${scores.ai_after})`, () => assert.equal(headline(scores), want));
	}

	it('tones: 70% and up reads as AI, 40% in between', () => {
		assert.deepEqual([0.96, 0.7, 0.69, 0.4, 0.39, 0].map(tone), ['ai', 'ai', 'mid', 'mid', 'human', 'human']);
	});

	it('check: label, score, reason, the flagged sentence once', () => {
		const o = { ...(FIXTURES.detect.output as unknown as DetectOutput) };
		o.examples = [
			{ sentence: o.sentences?.[0]?.text ?? '', rules: [{ name: 'Stock opener (LLM)' }] },
			{ sentence: 'Moreover, leveraging the right tools can help.', rules: [{ name: 'Moreover (LLM)' }, { name: 'Leverage' }] },
		];
		const d = detectParts(o);
		assert.equal(d.label, 'Likely AI-written');
		assert.equal(d.score, 96);
		assert.equal(d.tone, 'ai');
		assert.equal(d.verdict, 'Generic filler phrases with no specific claim or example.');
		assert.equal(d.confidence, 'Confidence medium: Two short sentences.');
		assert.equal(d.sentences.length, 1);
		assert.deepEqual(d.hits, [{ rules: 'Moreover · Leverage', sentence: 'Moreover, leveraging the right tools can help.' }]);
	});

	it('an unknown label says Unknown', () => assert.equal(detectParts({ ai: 0.1, label: 'new-kind' }).label, 'Unknown'));

	it('rewrite: score from before to after, model label, no warnings for a fair rewrite', () => {
		const o = FIXTURES.humanize.output as unknown as HumanizeOutput;
		const h = humanizeParts({ ...o, text: SHORT.replace('Ultimately, ', '') }, SHORT);
		assert.equal(h.headline, 'No longer reads as AI');
		assert.equal(h.model, 'Detector model: Likely human-written');
		assert.equal(h.before, 95);
		assert.equal(h.score, 1);
		assert.deepEqual(h.notes, []);
	});

	it('rewrite: warns when most words were dropped, and names what was kept as sent', () => {
		const o = { ...(FIXTURES.humanize.output as unknown as HumanizeOutput), invented_blocked: ['a date'] };
		const h = humanizeParts(o, SHORT);
		assert.match(h.notes[0]?.text ?? '', /^Kept 7 of 23 words\./);
		assert.equal(h.notes[0]?.warn, true);
		assert.equal(h.notes[1]?.text, 'Kept as sent where a rewrite added a date, which the text does not have.');
	});

	it("a rewrite keeps the selection's own whitespace at each end, not the API's line break", () => {
		assert.equal(fitRewrite('  Old text.\n', 'New text.\n'), '  New text.\n');
		assert.equal(fitRewrite('Old text.', '\nNew text.\n'), 'New text.');
	});

	it('answers without the fields this version reads', () => {
		assert.equal(missingResult({ ...FIXTURES.detect, output: { version: 'detect-v9' } }), true);
		assert.equal(missingResult({ ...FIXTURES.humanize, output: { version: 'humanize-v9', ai_after: 0.1 } }), true);
		assert.equal(missingResult(FIXTURES.detect), false);
		assert.equal(missingResult(FIXTURES.humanize), false);
	});

	it('the line under a result: version, cache, cost only with a key', () => {
		assert.equal(metaLine(FIXTURES.detect, false), 'detect-v1.2');
		assert.equal(metaLine({ ...FIXTURES.detect, cached: true, charged_usd: '0.0123' }, true), 'detect-v1.2 · from cache · $0.0123');
		assert.equal(metaLine({ ...FIXTURES.detect, charged_usd: '0.0123' }, false), 'detect-v1.2');
	});
});

describe('before sending', () => {
	it('refuses more than 5,000 characters without a key', () => {
		assert.equal(refuse('detect', 'a'.repeat(5001), false), "That's 5,001 characters. Without an API key p3n takes up to 5,000. Select less, or add a key.");
		assert.equal(refuse('detect', 'a'.repeat(5001), true), null);
		assert.equal(refuse('humanize', 'a'.repeat(200_001), true), "That's 200,001 characters; the API takes up to 200,000. Select less.");
	});

	it('Check needs 40 characters; Rewrite takes less', () => {
		assert.equal(refuse('detect', 'Too short to check.', false), 'Check needs at least 40 characters, a sentence or two. Select more.');
		assert.equal(refuse('humanize', 'Too short to check.', false), null);
		assert.equal(refuse('detect', AI_TEXT, false), null);
	});

	it('the source line and the busy line', () => {
		assert.equal(sourceLine('Draft', 1234, false), 'From Draft: 1,234 / 5,000 characters');
		assert.equal(busyText('detect', 3), 'Checking… 3 s');
		assert.equal(busyText('humanize', 9), 'Rewriting… 9 s (a rewrite takes up to a minute)');
	});
});

describe('errors and the account line', () => {
	it('free limit: when more come, Sign up and Add an API key', () => {
		const p = errorParts(new ApiError(429, 'free_limit', 'x', { retryAfter: 590, signupUrl: null }));
		assert.deepEqual(p.lines, ['The free checks for this hour are used up; more in about 10 min.']);
		assert.deepEqual(p.actions.map((a) => a.label), ['Sign up', 'Add an API key']);
		assert.equal(p.actions[0]?.kind === 'link' && p.actions[0].href, 'https://p3n.si/register');
	});

	it('low balance: Top up', () => {
		const p = errorParts(new ApiError(402, 'insufficient_credit', 'x'));
		assert.deepEqual(p.lines, ['Your p3n balance is too low for this.']);
		assert.equal(p.actions[0]?.kind === 'link' && p.actions[0].href, 'https://p3n.si/dashboard/billing');
	});

	it('a revoked key: Change the key', () => {
		const p = errorParts(new ApiError(401, 'unauthorized', 'x'));
		assert.deepEqual(p.lines, ["p3n didn't accept your API key. It may have been revoked."]);
		assert.deepEqual(p.actions, [{ kind: 'key', label: 'Change the key' }]);
	});

	it("anything else: the API's own message", () => {
		assert.deepEqual(errorParts(new ApiError(504, 'too_long', 'Send a shorter text.')).lines, ['Send a shorter text.']);
		assert.deepEqual(errorParts(new ApiError(429, 'rate_limited', 'x')).lines, ['Too many requests at once. Wait a minute and try again.']);
	});

	it('free calls left, or what keyless use gives', () => {
		assert.equal(quotaLine(false, null), 'Free without a key: 10 calls an hour, up to 5,000 characters each.');
		assert.equal(quotaLine(false, 9), '9 free calls left this hour without a key.');
		assert.equal(quotaLine(false, 1), '1 free call left this hour without a key.');
		assert.equal(quotaLine(true, 9), null);
	});

	it('the undo shortcut per platform', () => {
		assert.equal(undoKey({ isMacOS: true, isMobile: false }), 'Cmd+Z');
		assert.equal(undoKey({ isMacOS: false, isMobile: false }), 'Ctrl+Z');
		assert.equal(undoKey({ isMacOS: false, isMobile: true }), 'Undo');
	});
});
