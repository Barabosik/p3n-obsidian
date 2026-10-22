import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const manifest = read('manifest.json');
const versions = read('versions.json');
const pkg = read('package.json');

// The community directory's rules for manifest.json (Manifest reference, Submission requirements, and the
// validate-manifest rule of eslint-plugin-obsidianmd).
describe('manifest.json', () => {
	it('has every required field, and nothing else', () => {
		const allowed = ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'authorUrl', 'fundingUrl', 'isDesktopOnly'];
		for (const k of ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly']) assert.ok(k in manifest, k);
		for (const k of Object.keys(manifest)) assert.ok(allowed.includes(k), `${k} isn't allowed`);
		assert.equal(manifest.isDesktopOnly, false);
	});

	it('id and name: short, no "obsidian" or "plugin"', () => {
		for (const k of ['id', 'name', 'description']) assert.doesNotMatch(String(manifest[k]), /obsidian|plugin/i, k);
		// Only lowercase letters and hyphens: the directory refused "p3n" for its digit.
		assert.match(String(manifest.id), /^[a-z]+(-[a-z]+)*$/);
		assert.doesNotMatch(String(manifest.id), /plugin$/);
		assert.match(String(manifest.name), /^[A-Za-z0-9 +()-]+$/);
	});

	it('description: 10 to 250 characters, a capital first, a period last, plain characters', () => {
		const d = String(manifest.description);
		assert.ok(d.length >= 10 && d.length <= 250, `${d.length} characters`);
		assert.match(d, /^[A-Z]/);
		assert.ok(d.endsWith('.'));
		assert.match(d, /^[A-Za-z0-9\s.,!?'"-]+$/);
		// The product line every p3n app uses; a rewrite isn't promised to read as human.
		assert.doesNotMatch(d, /reads as human/i);
	});

	it('version is x.y.z and matches package.json and versions.json', () => {
		assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
		assert.equal(manifest.version, pkg.version);
		assert.equal(versions[String(manifest.version)], manifest.minAppVersion);
	});
});
