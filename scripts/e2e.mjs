// Drives the plugin in a real Obsidian desktop app, over the DevTools protocol.
// Obsidian runs with its own profile (--user-data-dir) and a throwaway vault, both under .e2e/, so your own
// vaults and settings are never touched. By default every API call is answered in the page with canned runs
// (the plugin's transport is swapped), so nothing reaches api.p3n.si. LIVE=1 instead runs one Check and one
// Rewrite against the real API: 2 keyless calls.
//
//   npm run build && node scripts/e2e.mjs
//   OBSIDIAN=path/to/Obsidian.exe   the app (default: the usual Windows install)
//   ASAR=path/to/obsidian-x.y.z.asar   which Obsidian version to run (default: the newest in your profile)
//   ONLY=check,rewrite   run only these scenarios      KEEP=1   leave Obsidian open at the end
//   SHOTS=1   save screenshots to .e2e/shots/          LIVE=1   the real API, 2 calls
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E = path.join(ROOT, '.e2e');
const VAULT = path.join(E2E, 'vault');
const SHOTS = path.join(E2E, 'shots');
const PORT = Number(process.env.PORT || 9339);
const LIVE = process.env.LIVE === '1';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const VAULT_ID = 'a3e2e0b5d1c4f7a9';
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const OBSIDIAN = process.env.OBSIDIAN || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Obsidian', 'Obsidian.exe');

const AI_TEXT = "In today's fast-paced world, it's worth noting that effective communication is more important than ever. Moreover, leveraging the right tools can help teams unlock their full potential and navigate the complexities of modern work.";
const SHORT = 'Ultimately, this seamless transition unlocks a rich tapestry of possibilities for teams of all sizes, empowering everyone to thrive in an ever-evolving landscape.';
const NOTE = `${AI_TEXT}\n\n${SHORT}\n\nIntro line.\n`;
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
// The plugin's id, as Obsidian knows it: its folder, its commands (id:command), its settings tab.
const ID = manifest.id;

// ---- the vault and the profile --------------------------------------------------------------------

function newestAsar() {
	const dir = path.join(appData, 'obsidian');
	const found = existsSync(dir) ? readdirSync(dir).filter((f) => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(f)) : [];
	const v = (f) => f.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
	found.sort((a, b) => { const [x, y] = [v(a), v(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
	return found.length ? path.join(dir, found[found.length - 1]) : null;
}

function setUp() {
	rmSync(VAULT, { recursive: true, force: true });
	const plugin = path.join(VAULT, '.obsidian', 'plugins', manifest.id);
	mkdirSync(plugin, { recursive: true });
	for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(path.join(ROOT, f), path.join(plugin, f));
	writeFileSync(path.join(VAULT, '.obsidian', 'community-plugins.json'), JSON.stringify([manifest.id]));
	writeFileSync(path.join(VAULT, 'Team update.md'), NOTE);
	writeFileSync(path.join(VAULT, 'Other note.md'), 'Nothing to see here.\n');

	const asar = process.env.ASAR || newestAsar();
	const version = asar ? path.basename(asar).match(/\d+\.\d+\.\d+/)[0] : 'installer';
	const profile = path.join(E2E, `profile-${version}`);
	mkdirSync(profile, { recursive: true });
	if (asar && !existsSync(path.join(profile, path.basename(asar)))) copyFileSync(asar, path.join(profile, path.basename(asar)));
	writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({ vaults: { [VAULT_ID]: { path: VAULT, ts: Date.now(), open: true } }, updateDisabled: true }));
	writeFileSync(path.join(profile, `${VAULT_ID}.json`), JSON.stringify({ x: 40, y: 40, width: 1200, height: 800, isMaximized: false, devTools: false, zoom: 0 }));
	mkdirSync(SHOTS, { recursive: true });
	return { profile, version };
}

// ---- DevTools protocol ----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		this.errors = [];
		ws.addEventListener('message', (m) => {
			const msg = JSON.parse(m.data);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result);
			} else if (msg.method === 'Runtime.exceptionThrown') {
				this.errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
			} else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
				this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
			}
		});
	}

	static async connect() {
		for (let i = 0; i < 120; i++) {
			try {
				const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
				const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://'));
				if (page) {
					const ws = new WebSocket(page.webSocketDebuggerUrl);
					await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
					const cdp = new Cdp(ws);
					await cdp.send('Runtime.enable');
					await cdp.send('Page.enable');
					return cdp;
				}
			} catch { /* not up yet */ }
			await sleep(500);
		}
		throw new Error(`no Obsidian page on port ${PORT}`);
	}

	send(method, params = {}) {
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 60_000);
		});
	}

	// Runs fn(...args) in the page and returns its (awaited) value.
	async ev(fn, ...args) {
		const r = await this.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}

	async waitFor(fn, args = [], timeout = 15_000) {
		const t0 = Date.now();
		for (;;) {
			const v = await this.ev(fn, ...args).catch(() => null);
			if (v) return v;
			if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${String(fn).slice(0, 120)}`);
			await sleep(100);
		}
	}

	async key(key, code, keyCode, modifiers = 0) {
		await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
		await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
	}

	async click(x, y, button = 'left') {
		await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
		await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
		await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
	}

	async shot(name) {
		if (process.env.SHOTS !== '1') return;
		await sleep(1200); // let the result's motion finish
		const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
	}
}

// ---- in-page helpers (stringified into the page) ---------------------------------------------------

// The stand-in for api.p3n.si: canned runs (the browser extension's fixtures), queued odd answers, and a log.
function installMock(fixtures, id) {
	window.__plugin = () => window.app.plugins.plugins[id];
	const p = window.__plugin();
	window.__p3n = { queue: [], requests: [], fixtures, real: window.__p3n?.real ?? p.client.transport };
	p.client.transport = async (req) => {
		const m = window.__p3n;
		m.requests.push(req);
		const json = (status, body) => ({ status, headers: { 'content-type': 'application/json', 'x-free-remaining': '9' }, text: JSON.stringify(body) });
		const next = m.queue.shift();
		if (next?.drop) throw new Error('net::ERR_CONNECTION_RESET');
		if (next?.html) return { status: next.status, headers: { 'content-type': 'text/html' }, text: next.html };
		if (next) return json(next.status ?? 200, next.body);
		const skill = req.url.match(/\/v1\/(detect|humanize)$/)?.[1];
		if (skill) return json(200, m.fixtures[skill]);
		if (req.url.endsWith('/v1/me')) return json(401, { error: { type: 'unauthorized', message: 'Invalid API key.' } });
		return json(404, { error: { type: 'not_found', message: 'Not found.' } });
	};
	return true;
}

// Opens the test note and selects `text` in it (or puts the cursor at the start when text is null).
async function selectInNote(text) {
	const { app } = window;
	let leaf = app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md');
	if (!leaf) {
		leaf = app.workspace.getLeaf(false);
		await leaf.openFile(app.vault.getAbstractFileByPath('Team update.md'));
	}
	app.workspace.setActiveLeaf(leaf, { focus: true });
	const ed = leaf.view.editor;
	if (text === null) {
		ed.setCursor({ line: 0, ch: 0 });
		return true;
	}
	const i = ed.getValue().indexOf(text);
	if (i < 0) return false;
	ed.setSelection(ed.offsetToPos(i), ed.offsetToPos(i + text.length));
	ed.focus();
	return ed.getSelection() === text;
}

const noteText = () => window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md')?.view.editor.getValue() ?? null;
const view = () => document.querySelector('.workspace-leaf-content[data-type="p3n"] .p3n-view');
const resultText = () => document.querySelector('.p3n-view .p3n-result')?.innerText ?? '';
const scoreSettled = () => {
	const n = document.querySelector('.p3n-view .p3n-num');
	const sr = document.querySelector('.p3n-view .p3n-sr');
	return !!n && !!sr && n.textContent === sr.textContent && !!document.querySelector('.p3n-view .p3n-busy')?.style.display.includes('none');
};
const idle = () => document.querySelector('.p3n-view .p3n-busy')?.style.display.includes('none') && !!document.querySelector('.p3n-view .p3n-result')?.textContent.trim();
const clickButton = (label) => {
	const b = [...document.querySelectorAll('.p3n-view button, .p3n-view a.p3n-button')].find((x) => x.textContent.trim() === label);
	if (!b) return false;
	b.click();
	return true;
};

// ---- the run ---------------------------------------------------------------------------------------

// Runs a p3n command after clearing the last result, so waiting for a result waits for this one.
async function run(cdp, command) {
	await cdp.ev(() => document.querySelector('.p3n-view .p3n-result')?.replaceChildren());
	await cdp.ev((c) => window.app.commands.executeCommandById(c), `${ID}:${command}`);
}

const results = [];
async function check(name, fn) {
	if (ONLY && !ONLY.has(name.split(':')[0])) return;
	try {
		if (current) await current.ev(() => { if (window.__p3n) window.__p3n.queue.length = 0; });
		await fn();
		results.push([name, true]);
		console.log(`  ok  ${name}`);
	} catch (e) {
		results.push([name, false, e.message]);
		console.log(`  FAIL ${name}: ${e.message}`);
	}
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let current = null;

const FIXTURES = {
	detect: { id: 'mock-detect', skill: 'detect', status: 'succeeded', cached: false, error: null, charged_usd: '0',
		output: { version: 'detect-v1.2', ai: 0.96, label: 'ai', verdict: 'Generic filler phrases with no specific claim or example.', confidence: { level: 'medium', reason: 'Two short sentences.' },
			sentences: [{ text: AI_TEXT.split('. ')[0] + '.', why: 'A stock opening with a vague claim.' }], examples: [{ sentence: 'Moreover, leveraging the right tools can help teams unlock their full potential.', rules: [{ name: 'Moreover (LLM)' }, { name: 'Leverage' }] }] } },
	humanize: { id: 'mock-humanize', skill: 'humanize', status: 'succeeded', cached: false, error: null, charged_usd: '0',
		output: { version: 'humanize-v1.3', model: 'haiku', text: 'This transition helps teams of all sizes.\n', ai_before: 0.95, ai_after: 0.01, label_after: 'human', passes: true, invented_blocked: [] } },
};
const REWRITE = 'This transition helps teams of all sizes.';

async function main() {
	assert(existsSync(path.join(ROOT, 'main.js')), 'main.js is missing: run npm run build first');
	assert(existsSync(OBSIDIAN), `Obsidian not found at ${OBSIDIAN}`);
	const { profile, version } = setUp();
	console.log(`Obsidian ${version}, profile ${path.relative(ROOT, profile)}, vault ${path.relative(ROOT, VAULT)}${LIVE ? ', LIVE API' : ', mocked API'}`);
	const keep = process.env.KEEP === '1' || process.env.KEEP === 'mobile';
	// Render as if on screen while other windows cover it: no occlusion tracking, no background throttling.
	// Without these, a covered window gets no animation frames, and drawers and the score count stop part way.
	const flags = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
	const proc = spawn(OBSIDIAN, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, ...flags], { stdio: 'ignore', detached: keep });
	if (keep) proc.unref();
	let cdp;
	try {
		cdp = await Cdp.connect();
		current = cdp;
		await cdp.waitFor(() => window.app?.workspace?.layoutReady, [], 60_000);
		console.log(`page hidden: ${await cdp.ev(() => document.hidden)}`);
		const appVersion = await cdp.ev(() => {
			try {
				return window.require('electron').ipcRenderer.sendSync('version');
			} catch {
				return null;
			}
		});
		console.log(`app ${appVersion} (installer ${await cdp.ev(() => navigator.userAgent.match(/obsidian\/(\S+)/)?.[1])})`);
		await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
		await cdp.ev(() => document.querySelectorAll('.modal-close-button').forEach((b) => b.click()));
		await cdp.ev(() => window.app.changeTheme('moonstone'));
		// The test note's editor. Obsidian 1.14 has no workspace.activeEditor while the p3n view is the active leaf.
		await cdp.ev(() => { window.__ed = () => window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md')?.view.editor; });

		await check('boot: restricted mode off, plugin enabled', async () => {
			const ok = await cdp.ev(async (id) => {
				const { plugins } = window.app;
				await plugins.setEnable(true);
				await plugins.loadManifests();
				await plugins.enablePluginAndSave(id);
				return !!plugins.plugins[id];
			}, manifest.id);
			assert(ok, 'plugin did not load');
		});
		if (!LIVE) await cdp.ev(installMock, FIXTURES, ID);

		await check('boot: commands named as in the palette, no default hotkeys', async () => {
			const cmds = await cdp.ev((id) => ['check', 'rewrite', 'open'].map((c) => window.app.commands.findCommand(`${id}:${c}`)).map((c) => c && { name: c.name, hotkeys: c.hotkeys ?? [] }), ID);
			assert(cmds[0]?.name === 'p3n: Check for AI', `check is "${cmds[0]?.name}"`);
			assert(cmds[1]?.name === 'p3n: Rewrite', `rewrite is "${cmds[1]?.name}"`);
			assert(cmds[2]?.name === 'p3n: Open results', `open is "${cmds[2]?.name}"`);
			assert(cmds.every((c) => c.hotkeys.length === 0), 'a command has a default hotkey');
		});

		if (LIVE) {
			await check('live: Check for AI', async () => {
				await cdp.ev(selectInNote, AI_TEXT);
				await run(cdp, 'check');
				await cdp.waitFor(idle, [], 120_000);
				await cdp.waitFor(scoreSettled, [], 5000).catch(() => null);
				const t = await cdp.ev(resultText);
				console.log(`      ${t.split('\n').slice(0, 3).join(' | ')} | free left: ${await cdp.ev(() => window.__plugin().free)}`);
				assert(/likely AI|AI class/.test(t), t.slice(0, 200));
				await cdp.shot('live-check');
			});
			await check('live: Rewrite, then Replace selection', async () => {
				await cdp.ev(selectInNote, SHORT);
				await run(cdp, 'rewrite');
				await cdp.waitFor(idle, [], 180_000);
				await cdp.waitFor(scoreSettled, [], 5000).catch(() => null);
				const t = await cdp.ev(resultText);
				console.log(`      ${t.split('\n').slice(0, 4).join(' | ')} | free left: ${await cdp.ev(() => window.__plugin().free)}`);
				assert(await cdp.ev(() => !!document.querySelector('.p3n-view .p3n-rewrite')), t.slice(0, 200));
				await cdp.shot('live-rewrite');
				assert(await cdp.ev(clickButton, 'Replace selection'), 'no Replace selection');
				await sleep(300);
				const doc = await cdp.ev(noteText);
				assert(!doc.includes(SHORT), 'the selection is still in the note');
				await cdp.shot('live-replaced');
			});
			return;
		}

		await check('check: score, label, reason, sentences; X-P3N-Client, keyless', async () => {
			assert(await cdp.ev(selectInNote, AI_TEXT), 'could not select');
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			await cdp.waitFor(scoreSettled, [], 5000);
			const t = await cdp.ev(resultText);
			for (const want of ['Likely AI-written', '96%', 'likely AI', 'Generic filler phrases', 'Confidence medium: Two short sentences.', 'Sentences that read as AI', 'A stock opening with a vague claim.', 'Pattern hits', 'Moreover · Leverage', 'A score is a probability, not proof.', 'detect-v1.2']) {
				assert(t.includes(want), `missing "${want}"`);
			}
			const req = await cdp.ev(() => window.__p3n.requests.at(-1));
			assert(req.url === 'https://api.p3n.si/v1/detect' && req.method === 'POST', `${req.method} ${req.url}`);
			assert(req.headers['X-P3N-Client'] === `p3n-obsidian/${manifest.version}`, `X-P3N-Client ${req.headers['X-P3N-Client']}`);
			assert(!('Authorization' in req.headers), 'sent an Authorization header without a key');
			assert(JSON.parse(req.body).text === AI_TEXT, 'sent other text');
			const foot = await cdp.ev(() => document.querySelector('.p3n-view .p3n-footer').innerText);
			assert(foot.includes('9 free calls left this hour without a key.'), foot);
			const src = await cdp.ev(() => document.querySelector('.p3n-view .p3n-source').innerText);
			assert(src === `From Team update: ${AI_TEXT.length} / 5,000 characters`, src);
			await cdp.shot('check');
		});

		await check('check: a flagged sentence is found and selected in the note', async () => {
			await cdp.ev(() => document.querySelector('.p3n-view li.p3n-hit').click());
			const sel = await cdp.ev(() => window.__ed()?.getSelection());
			assert(sel === AI_TEXT.split('. ')[0] + '.', `selected "${sel}"`);
		});

		await check('rewrite: headline, scores, rewrite without the trailing line break', async () => {
			assert(await cdp.ev(selectInNote, SHORT), 'could not select');
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			await cdp.waitFor(scoreSettled, [], 5000).catch(async (e) => {
				throw new Error(`${e.message.slice(0, 40)}: ${JSON.stringify(await cdp.ev(() => ({ num: document.querySelector('.p3n-view .p3n-num')?.textContent, sr: document.querySelector('.p3n-view .p3n-sr')?.textContent, busy: document.querySelector('.p3n-view .p3n-busy')?.style.display, hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() })))}`);
			});
			const t = await cdp.ev(resultText);
			for (const want of ['No longer reads as AI', 'Detector model: Likely human-written', '95% →', '1%', 'AI class', REWRITE, 'Kept 7 of 23 words.', 'Humanize drops filler', 'humanize-v1.3']) {
				assert(t.includes(want), `missing "${want}"`);
			}
			assert(await cdp.ev(() => document.querySelector('.p3n-view .p3n-rewrite').textContent) === REWRITE, 'rewrite box text');
			await cdp.shot('rewrite');
		});

		await check('rewrite: Replace selection puts it in the note and selects it', async () => {
			assert(await cdp.ev(clickButton, 'Replace selection'), 'no Replace selection');
			const doc = await cdp.ev(noteText);
			assert(doc === NOTE.replace(SHORT, REWRITE), `note is now:\n${doc}`);
			const sel = await cdp.ev(() => window.__ed()?.getSelection());
			assert(sel === REWRITE, `selected "${sel}"`);
			const status = await cdp.ev(() => document.querySelector('.p3n-view .p3n-result .p3n-note.p3n-ok')?.innerText);
			assert(status === 'Replaced in the note and selected there. Ctrl+Z in the note undoes it.', status);
			assert(await cdp.ev(() => [...document.querySelectorAll('.p3n-view button')].find((b) => b.textContent === 'Replaced')?.disabled), 'button not Replaced/disabled');
			await cdp.shot('replaced');
		});

		await check('rewrite: one Ctrl+Z keystroke in the note undoes Replace', async () => {
			// Click into the note, as a person would, then press Ctrl+Z.
			await cdp.ev(() => {
				const leaf = window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md');
				window.app.workspace.setActiveLeaf(leaf, { focus: true });
				window.__ed().focus();
			});
			await cdp.key('z', 'KeyZ', 90, 2);
			await sleep(200);
			const doc = await cdp.ev(noteText);
			assert(doc === NOTE, `after one undo the note is:\n${doc}`);
		});

		await check('rewrite: refuses when the text changed since, and leaves the note alone', async () => {
			await cdp.ev(selectInNote, SHORT);
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			const edited = await cdp.ev(() => {
				const ed = window.__ed();
				const i = ed.getValue().indexOf('seamless');
				ed.replaceRange('smooth', ed.offsetToPos(i), ed.offsetToPos(i + 'seamless'.length));
				return ed.getValue();
			});
			await cdp.ev(clickButton, 'Replace selection');
			const status = await cdp.ev(() => document.querySelector('.p3n-view .p3n-result .p3n-note.p3n-warn')?.innerText);
			assert(status?.startsWith('That text changed in the note since you selected it, so p3n left it alone.'), status);
			assert(await cdp.ev(noteText) === edited, 'note changed');
			await cdp.ev(() => window.__ed().undo());
		});

		await check('rewrite: finds the text after edits above it', async () => {
			assert(await cdp.ev(noteText) === NOTE, 'note not reset');
			await cdp.ev(selectInNote, SHORT);
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			await cdp.ev(() => window.__ed().replaceRange('A new first line.\n', { line: 0, ch: 0 }));
			await cdp.ev(clickButton, 'Replace selection');
			assert(await cdp.ev(noteText) === `A new first line.\n${NOTE.replace(SHORT, REWRITE)}`, 'not replaced in place');
			await cdp.ev(() => { const ed = window.__ed(); ed.setValue(ed.getValue()); });
		});

		await check('rewrite: refuses when the note was closed', async () => {
			await cdp.ev(async (note) => {
				const ed = window.__ed();
				ed.setValue(note);
			}, NOTE);
			await cdp.ev(selectInNote, SHORT);
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			await cdp.ev(() => window.app.workspace.getLeavesOfType('markdown').forEach((l) => l.detach()));
			await cdp.ev(clickButton, 'Replace selection');
			const status = await cdp.ev(() => document.querySelector('.p3n-view .p3n-result .p3n-note.p3n-warn')?.innerText);
			assert(status?.startsWith("Team update isn't open any more."), status);
			await cdp.ev(selectInNote, null);
		});

		await check('select: nothing selected, several selections, too short: no call', async () => {
			const before = await cdp.ev(() => window.__p3n.requests.length);
			await cdp.ev(selectInNote, null);
			await run(cdp, 'check');
			let hint = await cdp.waitFor(() => { const h = document.querySelector('.p3n-view .p3n-note.p3n-warn.p3n-small'); return h && h.style.display !== 'none' && h.innerText; });
			assert(hint === 'Nothing is selected in the note. Select some text first.', hint);
			await cdp.ev(() => {
				const ed = window.__ed();
				ed.setSelections([{ anchor: { line: 2, ch: 0 }, head: { line: 2, ch: 10 } }, { anchor: { line: 4, ch: 0 }, head: { line: 4, ch: 10 } }]);
			});
			await run(cdp, 'check');
			hint = await cdp.ev(() => document.querySelector('.p3n-view > .p3n-note.p3n-warn')?.innerText);
			assert(hint === 'p3n works on one selection at a time. Select one passage.', hint);
			await cdp.ev(selectInNote, 'Intro line.');
			await run(cdp, 'check');
			const t = await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-error')?.innerText);
			assert(t === 'Check needs at least 40 characters, a sentence or two. Select more.', t);
			assert(await cdp.ev(() => window.__p3n.requests.length) === before, 'a call was sent');
		});

		await check('errors: free limit, with Sign up to p3n.si only and Add an API key', async () => {
			await cdp.ev(() => window.__p3n.queue.push({ status: 429, body: { error: { type: 'free_limit', message: 'Free calls are used up.', signup_url: 'javascript:alert(1)', retry_after_seconds: 600 } } }));
			await cdp.ev(selectInNote, AI_TEXT);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			const t = await cdp.ev(resultText);
			assert(t.includes('The free checks for this hour are used up; more in about 10 min.'), t);
			const links = await cdp.ev(() => [...document.querySelectorAll('.p3n-view .p3n-error a, .p3n-view .p3n-error button')].map((a) => `${a.textContent}|${a.getAttribute('href') ?? ''}`));
			assert(JSON.stringify(links) === JSON.stringify(['Sign up|https://p3n.si/register', 'Add an API key|']), JSON.stringify(links));
			await cdp.shot('free-limit');
		});

		const ODD = [
			['504 too_long', 'rewrite', { status: 504, body: { error: { type: 'too_long', message: 'The text took longer than 85 s to process; send a shorter text. Not charged.' } } }, /send a shorter text/],
			['an HTML error page', 'check', { status: 502, html: '<!doctype html><title>502</title>Bad gateway' }, /p3n answered 502\./],
			['a failed run', 'rewrite', { status: 200, body: { ...FIXTURES.humanize, status: 'failed', output: null, error: 'The model provider failed. You were not charged.' } }, /provider failed/],
			['detect without a score', 'check', { status: 200, body: { ...FIXTURES.detect, output: { version: 'detect-v9' } } }, /without a result/],
			['humanize without a rewrite', 'rewrite', { status: 200, body: { ...FIXTURES.humanize, output: { version: 'humanize-v9', ai_after: 0.1 } } }, /without a result/],
			['a revoked key', 'check', { status: 401, body: { error: { type: 'unauthorized', message: 'Invalid API key.' } } }, /didn't accept your API key/],
			['low balance', 'rewrite', { status: 402, body: { error: { type: 'insufficient_credit', message: 'x' } } }, /balance is too low/],
			['no connection', 'check', { drop: true }, /Can't reach p3n/],
		];
		for (const [name, cmd, next, want] of ODD) {
			await check(`errors: ${name}`, async () => {
				await cdp.ev((n) => window.__p3n.queue.push(n), next);
				await cdp.ev(selectInNote, AI_TEXT);
				await run(cdp, cmd);
				await cdp.waitFor(idle);
				const t = await cdp.ev(resultText);
				assert(want.test(t), t);
			});
		}

		await check('errors: a long run is polled; Cancel stops waiting', async () => {
			await cdp.ev(() => window.__p3n.queue.push({ status: 202, body: { id: 'long', skill: 'humanize', status: 'queued' } }, { status: 200, body: { id: 'long', skill: 'humanize', status: 'running' } }, { status: 200, body: { id: 'long', skill: 'humanize', status: 'running' } }));
			await cdp.ev(selectInNote, SHORT);
			await run(cdp, 'rewrite');
			await cdp.waitFor(() => /Rewriting… \d+ s/.test(document.querySelector('.p3n-view .p3n-busy')?.innerText ?? ''));
			// The first poll comes 2 s after the 202 (later in a hidden window, whose timers are throttled).
			await cdp.waitFor(() => window.__p3n.requests.some((r) => r.url.endsWith('/v1/runs/long')), [], 20_000);
			await cdp.ev(clickButton, 'Cancel');
			await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-busy')?.style.display.includes('none'));
			const n = await cdp.ev(() => window.__p3n.requests.length);
			await sleep(4500);
			assert(await cdp.ev(() => window.__p3n.requests.length) === n, 'still polling after Cancel');
			await cdp.ev(() => { window.__p3n.queue.length = 0; });
		});

		await check('menu: right-click on a selection offers p3n, and it runs', async () => {
			await cdp.ev(selectInNote, AI_TEXT);
			await sleep(300);
			const r = await cdp.ev(() => {
				const sel = window.getSelection();
				const b = sel?.rangeCount ? [...sel.getRangeAt(0).getClientRects()].find((x) => x.width > 20) : null;
				return b && { x: b.left + Math.min(60, b.width / 2), y: b.top + b.height / 2 };
			});
			assert(r, 'no selection on screen');
			await cdp.click(r.x, r.y, 'right');
			const items = await cdp.waitFor(() => { const t = [...document.querySelectorAll('.menu .menu-item-title')].map((e) => e.textContent); return t.length && t; });
			assert(items.includes('Check for AI with p3n') && items.includes('Rewrite with p3n'), JSON.stringify(items));
			await cdp.shot('menu');
			const n = await cdp.ev(() => window.__p3n.requests.length);
			await cdp.ev(() => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Check for AI with p3n')).click());
			await cdp.waitFor(idle);
			assert(await cdp.ev(() => window.__p3n.requests.length) === n + 1, 'menu item did not run a check');
		});

		await check('palette: the p3n commands', async () => {
			await cdp.ev(selectInNote, AI_TEXT);
			await cdp.ev(() => window.app.commands.executeCommandById('command-palette:open'));
			await cdp.waitFor(() => document.querySelector('.prompt-input'));
			await cdp.send('Input.insertText', { text: 'p3n' });
			const items = await cdp.waitFor(() => { const t = [...document.querySelectorAll('.prompt .suggestion-item')].map((e) => e.innerText.trim()); return t.length >= 3 && t; });
			for (const want of ['Check for AI', 'Rewrite', 'Open results']) assert(items.some((i) => /^p3n:?\s*/.test(i) && i.replace(/^p3n:?\s*/, '') === want), `${want} not in ${JSON.stringify(items)}`);
			await cdp.shot('palette');
			await cdp.key('Escape', 'Escape', 27);
		});

		await check('key: a key from secret storage is sent; balance shown; a wrong one is named', async () => {
			await cdp.ev(async () => {
				const p = window.__plugin();
				window.app.secretStorage.setSecret('p3n-e2e', 'p3n_e2e_not_a_real_key');
				p.settings.keySecret = 'p3n-e2e';
				await p.saveSettings();
			});
			let foot = await cdp.waitFor(() => { const t = document.querySelector('.p3n-view .p3n-footer')?.innerText ?? ''; return t.includes('accepted') && t; });
			assert(foot.includes("Your API key wasn't accepted. Change it under API key."), foot);
			await cdp.ev(() => window.__p3n.queue.push({ status: 200, body: { email: 'test@example.com', balance_usd: '1.5', key: { name: 'laptop', prefix: 'p3n_e2e' } } }));
			await cdp.ev(() => window.__plugin().refreshViews());
			foot = await cdp.waitFor(() => { const t = document.querySelector('.p3n-view .p3n-footer')?.innerText ?? ''; return t.includes('Balance') && t; });
			assert(foot.includes('Balance $1.50 · key laptop'), foot);
			await cdp.ev(selectInNote, AI_TEXT);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			const req = await cdp.ev(() => window.__p3n.requests.filter((r) => r.url.endsWith('/v1/detect')).at(-1));
			assert(req.headers.Authorization === 'Bearer p3n_e2e_not_a_real_key', JSON.stringify(req.headers));
		});

		await check('settings: the tab, its key row and privacy text', async () => {
			await cdp.ev((id) => { window.app.setting.open(); window.app.setting.openTabById(id); }, ID);
			// The tab's own element: the settings window's layout differs between Obsidian versions.
			const t = await cdp.waitFor((id) => { const c = window.app.setting.activeTab?.containerEl; return window.app.setting.activeTab?.id === id && c?.innerText.includes('What p3n sends') && c.innerText; }, [ID]);
			for (const want of ['API key', '10 calls an hour', "keychain on this device, not in your notes or the plugin's data.json", 'Privacy', 'What p3n sends', 'It goes to api.p3n.si and nowhere else.']) assert(t.includes(want), `missing "${want}"`);
			const status = await cdp.waitFor(() => window.app.setting.activeTab.containerEl.querySelector('.p3n-key-status')?.innerText);
			assert(/doesn't accept this key|Checking/.test(status), status);
			await cdp.shot('settings');
			await cdp.ev(() => [...window.app.setting.activeTab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Remove key').click());
			const after = await cdp.waitFor(() => window.app.setting.activeTab.containerEl.querySelector('.p3n-key-status')?.innerText.startsWith('Key removed') && window.app.setting.activeTab.containerEl.querySelector('.p3n-key-status').innerText);
			assert(after.startsWith('Key removed. p3n still works without one'), after);
			assert(await cdp.ev(() => window.__plugin().settings.keySecret) === '', 'key name still saved');
			const saved = JSON.parse(readFileSync(path.join(VAULT, '.obsidian', 'plugins', ID, 'data.json'), 'utf8'));
			assert(JSON.stringify(saved) === '{"keySecret":""}', `data.json: ${JSON.stringify(saved)}`);
			await cdp.ev(() => window.app.setting.close());
		});

		await check('key: the data.json never holds the key itself', async () => {
			const raw = readFileSync(path.join(VAULT, '.obsidian', 'plugins', ID, 'data.json'), 'utf8');
			assert(!raw.includes('p3n_e2e'), raw);
		});

		await check('theme: dark', async () => {
			await cdp.ev(() => window.app.changeTheme('obsidian'));
			await cdp.ev(selectInNote, SHORT);
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			assert(await cdp.ev(() => document.body.classList.contains('theme-dark')), 'not dark');
			await cdp.shot('rewrite-dark');
			await cdp.ev(selectInNote, AI_TEXT);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			await cdp.shot('check-dark');
			await cdp.ev(() => window.app.changeTheme('moonstone'));
		// The test note's editor. Obsidian 1.14 has no workspace.activeEditor while the p3n view is the active leaf.
		await cdp.ev(() => { window.__ed = () => window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md')?.view.editor; });
		});

		await check('unload: disabling and enabling again leaves no errors and keeps the view', async () => {
			await cdp.ev(async (id) => {
				await window.app.plugins.disablePlugin(id);
				await window.app.plugins.enablePlugin(id);
			}, ID);
			await cdp.ev(installMock, FIXTURES, ID);
			await cdp.ev(selectInNote, AI_TEXT);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			assert(await cdp.ev(() => document.querySelectorAll('.workspace-leaf-content[data-type="p3n"]').length) === 1, 'not one view');
		});

		// Obsidian's own mobile emulation (app.emulateMobile reloads the app in its phone layout), at phone size.
		await check('mobile: Check and Rewrite in the phone layout, Replace says Undo', async () => {
			await cdp.send('Emulation.setDeviceMetricsOverride', { width: 450, height: 800, deviceScaleFactor: 2, mobile: true });
			await cdp.ev(() => window.app.emulateMobile(true)).catch(() => null);
			await sleep(2000);
			try {
				await cdp.waitFor((id) => window.app?.workspace?.layoutReady && window.app.isMobile && !!window.app.plugins.plugins[id], [ID], 60_000);
				await cdp.ev(() => { window.__ed = () => window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md')?.view.editor; });
				await cdp.ev(installMock, FIXTURES, ID);
				await cdp.ev(selectInNote, AI_TEXT);
				await run(cdp, 'check');
				await cdp.waitFor(idle);
				assert((await cdp.ev(resultText)).includes('Likely AI-written'), 'no result');
				await cdp.shot('mobile-check');
				await cdp.ev(selectInNote, SHORT);
				await sleep(800); // going back to the note closes the drawer, with an animation
				await run(cdp, 'rewrite');
				await cdp.waitFor(idle);
				assert(await cdp.ev(() => !window.app.workspace.rightSplit.collapsed), 'the drawer is closed');
				await cdp.shot('mobile-rewrite');
				assert(await cdp.ev(clickButton, 'Replace selection'), 'no Replace selection');
				const status = await cdp.ev(() => document.querySelector('.p3n-view .p3n-result .p3n-note.p3n-ok')?.innerText);
				assert(status === 'Replaced in the note and selected there. Undo in the note undoes it.', status);
				assert(await cdp.ev(noteText) === NOTE.replace(SHORT, REWRITE), 'not replaced');
				await cdp.ev(() => window.__ed().undo());
			} finally {
				if (process.env.KEEP === 'mobile') return;
				await cdp.ev(() => window.app.emulateMobile(false)).catch(() => null);
				await sleep(2000);
				await cdp.waitFor(() => window.app?.workspace?.layoutReady && !window.app.isMobile, [], 60_000);
				await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
			}
		});

		await check('errors: no script errors in the console', async () => {
			const mine = cdp.errors.filter((e) => /p3n/i.test(e ?? ''));
			assert(!mine.length, mine.join('\n'));
		});
	} finally {
		const failed = results.filter((r) => !r[1]);
		console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f[0]).join(', ')}` : ''}`);
		if (!keep) {
			await cdp?.ev(() => window.require?.('electron')?.remote?.app?.quit?.() ?? window.close()).catch(() => null);
			await sleep(1500);
			if (proc.exitCode === null) proc.kill();
		}
		process.exitCode = failed.length ? 1 : 0;
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
