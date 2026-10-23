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

	// `clip`: a part of the page, in CSS pixels, at `clip.scale`. `title`: another window's page, found by its title
	// (Obsidian 1.13 and later open the settings in a window of their own).
	async shot(name, { clip, title } = {}) {
		if (process.env.SHOTS !== '1') return;
		await sleep(1200); // let the result's motion finish
		let page = this;
		const other = title && (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.title === title);
		if (other) {
			const ws = new WebSocket(other.webSocketDebuggerUrl);
			await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
			page = new Cdp(ws);
		}
		try {
			const { data } = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
			writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
		} finally {
			if (page !== this) page.ws.close();
		}
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
const keyModal = () => {
	const m = document.querySelector('.modal.p3n-key-modal');
	return m ? { title: m.querySelector('.modal-title')?.textContent ?? '', text: m.innerText } : null;
};
const clickButton = (label) => {
	const b = [...document.querySelectorAll('.p3n-view button, .p3n-view a.p3n-button')].find((x) => x.textContent.trim() === label);
	if (!b) return false;
	b.click();
	return true;
};
// Picks a secret with the API key window's picker, as a person would: its button (Link... or Change), the
// secret, Save. Returns true, or what's missing.
async function pickSecret(name) {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const row = document.querySelector('.modal.p3n-key-modal .setting-item-control');
	const open = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent !== 'Remove key');
	if (!open) return 'no picker button';
	open.click();
	for (let i = 0; i < 50 && !document.querySelector('.modal.mod-secret .suggestion-item'); i++) await wait(100);
	const item = [...document.querySelectorAll('.modal.mod-secret .suggestion-item')].find((e) => e.querySelector('.suggestion-title')?.textContent === name);
	if (!item) return `no ${name} in ${document.querySelector('.modal.mod-secret')?.innerText}`;
	item.click();
	const save = [...document.querySelectorAll('.modal.mod-secret button')].find((b) => b.textContent === 'Save');
	if (!save) return 'no Save';
	save.click();
	return true;
}
const keyStatus = () => document.querySelector('.modal.p3n-key-modal .p3n-key-status')?.textContent ?? null;
// The p3n.si link in the view's footer or in the settings tab: its text, address, tooltip and the arrow screen
// readers skip.
const siteLink = (where) => {
	const root = where === 'settings' ? window.app.setting.activeTab?.containerEl : document.querySelector('.p3n-view .p3n-footer');
	const a = root?.querySelector('a.p3n-site');
	return a ? `${a.textContent}|${a.getAttribute('href')}|${a.title}|${a.querySelector('[aria-hidden="true"]')?.textContent ?? ''}` : null;
};
// Clicks the p3n.si link with its window's open() stubbed, so nothing reaches the browser. The 'open-url' guard
// catches a plain link's way out: Obsidian's Web viewer, when it's on, takes it there and opens it inside Obsidian.
async function clickSite(where) {
	const root = where === 'settings' ? window.app.setting.activeTab?.containerEl : document.querySelector('.p3n-view .p3n-footer');
	const a = root?.querySelector('a.p3n-site');
	if (!a) return 'no link';
	const w = a.win;
	const calls = [];
	const seen = [];
	const guard = (e) => { seen.push(e.detail?.url); e.preventDefault(); };
	for (const x of new Set([window, w])) x.addEventListener('open-url', guard);
	const open = w.open;
	w.open = (...args) => { calls.push(args); return null; };
	const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
	try {
		a.dispatchEvent(ev);
	} finally {
		w.open = open;
	}
	// A navigation would come back from the main process as 'open-url' a moment later.
	await new Promise((r) => setTimeout(r, 1000));
	for (const x of new Set([window, w])) x.removeEventListener('open-url', guard);
	return JSON.stringify({ prevented: ev.defaultPrevented, calls, seen });
}
// The settings window's title when the settings have a window of their own (Obsidian 1.13 and later), else null.
const settingsWindow = () => { const d = window.app.setting.activeTab?.containerEl.doc; return d && d !== document ? d.title : null; };
const SITE_OPENED = JSON.stringify({ prevented: true, calls: [['https://p3n.si/', '_external']], seen: [] });
const SITE_LINK = 'p3n.si ↗|https://p3n.si/|Open p3n.si in your browser|↗';

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
			const cmds = await cdp.ev((id) => ['check', 'rewrite', 'open', 'set-api-key'].map((c) => window.app.commands.findCommand(`${id}:${c}`)).map((c) => c && { name: c.name, hotkeys: c.hotkeys ?? [] }), ID);
			assert(cmds[0]?.name === 'p3n: Check for AI', `check is "${cmds[0]?.name}"`);
			assert(cmds[1]?.name === 'p3n: Rewrite', `rewrite is "${cmds[1]?.name}"`);
			assert(cmds[2]?.name === 'p3n: Open results', `open is "${cmds[2]?.name}"`);
			assert(cmds[3]?.name === 'p3n: Set API key', `set-api-key is "${cmds[3]?.name}"`);
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

		await check('focus: the first check opens the results and leaves the focus in the note', async () => {
			await cdp.ev(() => window.app.workspace.getLeavesOfType('p3n').forEach((l) => l.detach()));
			assert(await cdp.ev(selectInNote, AI_TEXT), 'could not select');
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			const where = await cdp.ev(() => ({ views: window.app.workspace.getLeavesOfType('p3n').length, collapsed: window.app.workspace.rightSplit.collapsed, active: window.app.workspace.activeLeaf?.view.getViewType(), focus: !!window.__ed()?.hasFocus() }));
			assert(where.views === 1 && !where.collapsed, `results not shown: ${JSON.stringify(where)}`);
			assert(where.active === 'markdown' && where.focus, `the note lost the focus: ${JSON.stringify(where)}`);
		});

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

		await check('footer: p3n.si after the quota line, styled like Add API key, kept when the line changes; opens in the browser', async () => {
			assert(await cdp.ev(siteLink, 'view') === SITE_LINK, await cdp.ev(siteLink, 'view'));
			const where = await cdp.ev(() => {
				const f = document.querySelector('.p3n-view .p3n-footer');
				const quota = f.firstElementChild;
				const a = f.querySelector('a.p3n-site');
				const key = [...f.querySelectorAll('button')].find((b) => b.textContent === 'Add API key');
				window.__site = a;
				const css = (el) => { const s = getComputedStyle(el); return `${s.color} ${s.fontSize} ${s.textDecorationLine}`; };
				return { after: !quota.contains(a) && !!(quota.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING), beforeKey: !!key && !!(a.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING), css: css(a), keyCss: key && css(key) };
			});
			assert(where.after && where.beforeKey, JSON.stringify(where));
			assert(where.css === where.keyCss && where.css.endsWith('underline'), JSON.stringify(where));
			// The quota line's text is replaced on every answer; the link sits beside it, so it stays.
			await cdp.ev(() => { window.__plugin().free = 3; window.__plugin().refreshViews(); });
			await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-footer')?.firstElementChild?.textContent === '3 free calls left this hour without a key.');
			assert(await cdp.ev(() => window.__site.isConnected && document.querySelector('.p3n-view .p3n-footer a.p3n-site') === window.__site), 'the link was replaced or dropped');
			const opened = await cdp.ev(clickSite, 'view');
			assert(opened === SITE_OPENED, opened);
		});

		await check('rewrite: headline, scores, rewrite without the trailing line break', async () => {
			assert(await cdp.ev(selectInNote, SHORT), 'could not select');
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			await cdp.waitFor(scoreSettled, [], 5000).catch(async (e) => {
				throw new Error(`${e.message.slice(0, 40)}: ${JSON.stringify(await cdp.ev(() => ({ num: document.querySelector('.p3n-view .p3n-num')?.textContent, sr: document.querySelector('.p3n-view .p3n-sr')?.textContent, busy: document.querySelector('.p3n-view .p3n-busy')?.style.display, hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() })))}`);
			});
			const t = await cdp.ev(resultText);
			for (const want of ['No longer reads as AI', 'Detector model: Likely human-written', '95% →', '1%', 'AI class', REWRITE, 'Kept 7 of 23 words.', 'The rewrite drops filler', 'humanize-v1.3']) {
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

		await check('rewrite: says so when it dropped a link from the selection', async () => {
			const linked = 'Our [[Q3 plan]] covers the launch for teams of every size, from small ones to large ones.';
			await cdp.ev(selectInNote, null);
			await cdp.ev((text) => window.__ed().replaceRange(`${text}\n`, { line: 0, ch: 0 }), linked);
			assert(await cdp.ev(selectInNote, linked), 'could not select');
			await cdp.ev((body) => window.__p3n.queue.push({ status: 200, body }), { ...FIXTURES.humanize, output: { ...FIXTURES.humanize.output, text: 'The Q3 plan covers the launch for every team, small or large.\n' } });
			await run(cdp, 'rewrite');
			await cdp.waitFor(idle);
			const t = await cdp.ev(resultText);
			assert(t.includes('The rewrite dropped the link in your selection. Add it back after you replace it if you need it.'), t);
			await cdp.ev((note) => window.__ed().setValue(note), NOTE);
		});

		await check('rewrite: Copy copies the rewrite, and says so when the clipboard refuses', async () => {
			// A stand-in clipboard: the run must not overwrite yours.
			await cdp.ev(() => {
				window.__copied = null;
				navigator.clipboard.writeText = async (t) => { window.__copied = t; };
			});
			try {
				await cdp.ev(selectInNote, SHORT);
				await run(cdp, 'rewrite');
				await cdp.waitFor(idle);
				assert(await cdp.ev(clickButton, 'Copy'), 'no Copy');
				await cdp.waitFor(() => [...document.querySelectorAll('.p3n-view button')].some((b) => b.textContent === 'Copied'));
				assert(await cdp.ev(() => window.__copied) === REWRITE, `copied "${await cdp.ev(() => window.__copied)}"`);
				await cdp.ev(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')); });
				await cdp.waitFor(() => [...document.querySelectorAll('.p3n-view button')].some((b) => b.textContent === 'Copy'), [], 5000);
				await cdp.ev(clickButton, 'Copy');
				const status = await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-result .p3n-note.p3n-warn')?.innerText);
				assert(status === "p3n couldn't copy it. Select the text in the box above and copy it.", status);
			} finally {
				await cdp.ev(() => { delete navigator.clipboard.writeText; });
			}
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
			let t = await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-error')?.innerText);
			assert(t === 'Check needs at least 40 characters, a sentence or two. Select more.', t);
			// Rewrite counts words as the API does: seven words and a year are too few.
			await cdp.ev(() => window.__ed().replaceRange('We shipped the new release in March 2029.\n', { line: 0, ch: 0 }));
			await cdp.ev(selectInNote, 'We shipped the new release in March 2029.');
			await run(cdp, 'rewrite');
			t = await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-error')?.innerText);
			assert(t === 'Rewrite needs at least a sentence of eight words. Select more.', t);
			await cdp.ev((note) => window.__ed().setValue(note), NOTE);
			assert(await cdp.ev(() => window.__p3n.requests.length) === before, 'a call was sent');
		});

		await check("select: a note in reading view: the commands aren't offered; the view's buttons say to switch", async () => {
			const before = await cdp.ev(() => window.__p3n.requests.length);
			await cdp.ev(selectInNote, AI_TEXT);
			await cdp.ev(async () => {
				const leaf = window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md');
				const vs = leaf.getViewState();
				await leaf.setViewState({ ...vs, state: { ...vs.state, mode: 'preview' } });
				window.app.workspace.setActiveLeaf(leaf, { focus: true });
			});
			try {
				const offered = await cdp.ev((id) => window.app.commands.listCommands().filter((c) => c.id === `${id}:check` || c.id === `${id}:rewrite`).length, ID);
				assert(offered === 0, `${offered} offered in reading view`);
				await cdp.ev(() => document.querySelector('.p3n-view .p3n-result')?.replaceChildren());
				assert(await cdp.ev(clickButton, 'Check for AI'), 'no Check for AI');
				const hint = await cdp.waitFor(() => { const h = document.querySelector('.p3n-view > .p3n-note.p3n-warn'); return h && h.style.display !== 'none' && h.innerText; });
				assert(hint === 'This note is in reading view. Switch to editing view and select the text there.', hint);
				assert(await cdp.ev(() => window.__p3n.requests.length) === before, 'a call was sent');
			} finally {
				await cdp.ev(async () => {
					const leaf = window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md');
					const vs = leaf.getViewState();
					await leaf.setViewState({ ...vs, state: { ...vs.state, mode: 'source' } });
				});
			}
		});

		await check('select: too long without a key: no call, and Add an API key opens the key window', async () => {
			const before = await cdp.ev(() => window.__p3n.requests.length);
			const long = `${SHORT} `.repeat(32).trim();
			await cdp.ev((text) => window.__ed().replaceRange(`${text}\n`, { line: 0, ch: 0 }), long);
			await cdp.ev(selectInNote, long);
			await run(cdp, 'check');
			const t = await cdp.waitFor(() => document.querySelector('.p3n-view .p3n-error')?.innerText);
			assert(t.startsWith(`That's ${long.length.toLocaleString('en-US')} characters. Without an API key p3n takes up to 5,000. Select less, or add a key.`), t);
			assert(await cdp.ev(() => window.__p3n.requests.length) === before, 'a call was sent');
			await cdp.ev((note) => window.__ed().setValue(note), NOTE);
			assert(await cdp.ev(clickButton, 'Add an API key'), 'no Add an API key');
			await cdp.waitFor(keyModal);
			await cdp.key('Escape', 'Escape', 27);
			await cdp.waitFor(() => !document.querySelector('.modal.p3n-key-modal'));
		});

		await check('errors: free limit, with Sign up to p3n.si only and Add an API key', async () => {
			await cdp.ev(() => window.__p3n.queue.push({ status: 429, body: { error: { type: 'free_limit', message: 'Free calls are used up.', signup_url: 'javascript:alert(1)', retry_after_seconds: 600 } } }));
			await cdp.ev(selectInNote, AI_TEXT);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			const t = await cdp.ev(resultText);
			assert(t.includes('The free calls for this hour are used up; more in about 10 min.'), t);
			assert(t.includes('Sign up at p3n.si for free credit, then create an API key and add it here to keep going.'), t);
			const links = await cdp.ev(() => [...document.querySelectorAll('.p3n-view .p3n-error a, .p3n-view .p3n-error button')].map((a) => `${a.textContent}|${a.getAttribute('href') ?? ''}`));
			assert(JSON.stringify(links) === JSON.stringify(['Sign up|https://p3n.si/register', 'Add an API key|']), JSON.stringify(links));
			await cdp.shot('free-limit');
			assert(await cdp.ev(clickButton, 'Add an API key'), 'no Add an API key');
			const m = await cdp.waitFor(keyModal);
			assert(m.title === 'API key' && m.text.includes('sign up at p3n.si'), JSON.stringify(m));
			// Escape: the close button's class differs between Obsidian versions.
			await cdp.key('Escape', 'Escape', 27);
			await cdp.waitFor(() => !document.querySelector('.modal.p3n-key-modal'));
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
			const items = await cdp.waitFor(() => { const t = [...document.querySelectorAll('.prompt .suggestion-item')].map((e) => e.innerText.trim()); return t.length >= 4 && t; });
			for (const want of ['Check for AI', 'Rewrite', 'Open results', 'Set API key']) assert(items.some((i) => /^p3n:?\s*/.test(i) && i.replace(/^p3n:?\s*/, '') === want), `${want} not in ${JSON.stringify(items)}`);
			await cdp.shot('palette');
			await cdp.key('Escape', 'Escape', 27);
		});

		await check('palette: from the p3n view, Check for AI works on the note last worked in', async () => {
			await cdp.waitFor(() => !document.querySelector('.prompt'));
			await cdp.ev(selectInNote, AI_TEXT);
			await cdp.ev(() => window.app.workspace.setActiveLeaf(window.app.workspace.getLeavesOfType('p3n')[0], { focus: true }));
			assert(await cdp.ev(() => window.app.workspace.activeLeaf?.view.getViewType()) === 'p3n', 'the p3n view is not active');
			await cdp.ev(() => window.app.commands.executeCommandById('command-palette:open'));
			await cdp.waitFor(() => document.querySelector('.prompt-input'));
			await cdp.send('Input.insertText', { text: 'p3n' });
			const items = await cdp.waitFor(() => { const t = [...document.querySelectorAll('.prompt .suggestion-item')].map((e) => e.innerText.trim().replace(/^p3n:?\s*/, '')); return t.length >= 4 && t; });
			for (const want of ['Check for AI', 'Rewrite']) assert(items.includes(want), `${want} not in ${JSON.stringify(items)}`);
			await cdp.key('Escape', 'Escape', 27);
			await cdp.waitFor(() => !document.querySelector('.prompt'));
			const n = await cdp.ev(() => window.__p3n.requests.length);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			const req = await cdp.ev(() => window.__p3n.requests.at(-1));
			assert(await cdp.ev(() => window.__p3n.requests.length) === n + 1 && JSON.parse(req.body).text === AI_TEXT, `sent ${req.url} ${req.body?.slice(0, 60)}`);
		});

		await check('key: Set API key opens the API key window', async () => {
			await cdp.waitFor(() => !document.querySelector('.prompt'));
			await cdp.ev((id) => window.app.commands.executeCommandById(`${id}:set-api-key`), ID);
			const m = await cdp.waitFor(keyModal);
			assert(m.title === 'API key', m.title);
			for (const want of ['10 calls an hour', 'sign up at p3n.si', 'API keys', "Obsidian's keychain", 'Remove key']) assert(m.text.includes(want), `missing "${want}" in ${m.text}`);
			await cdp.shot('key-window');
			await cdp.key('Escape', 'Escape', 27);
			await cdp.waitFor(() => !document.querySelector('.modal.p3n-key-modal'));
		});

		await check('key: a picked key is saved only once p3n accepts it', async () => {
			await cdp.ev(() => {
				const s = window.app.secretStorage;
				s.setSecret('p3n-e2e-typo', 'sk-not-a-p3n-key');
				s.setSecret('p3n-e2e-good', 'p3n_e2e_good');
				s.setSecret('p3n-e2e-revoked', 'p3n_e2e_revoked');
			});
			await cdp.ev((id) => window.app.commands.executeCommandById(`${id}:set-api-key`), ID);
			await cdp.waitFor(keyModal);
			const statusIs = (want) => cdp.waitFor((w) => { const t = document.querySelector('.modal.p3n-key-modal .p3n-key-status')?.textContent; return t === w && t; }, [want])
				.catch(async () => { throw new Error(`key status: "${await cdp.ev(keyStatus)}", want "${want}"`); });
			const saved = () => cdp.ev(() => window.__plugin().settings.keySecret);
			const n = await cdp.ev(() => window.__p3n.requests.length);
			// Not a p3n key: no call, nothing saved.
			let r = await cdp.ev(pickSecret, 'p3n-e2e-typo');
			assert(r === true, r);
			await statusIs("Keys start with p3n_. Copy the whole key from the API keys page. The key wasn't saved.");
			assert(await saved() === '', `saved "${await saved()}"`);
			assert(await cdp.ev(() => window.__p3n.requests.length) === n, 'a call was sent');
			// Accepted: saved, with who it signs in as.
			// Two answers: the key check, then the results view's balance line once the key is saved.
			await cdp.ev(() => {
				const me = { status: 200, body: { email: 'test@example.com', balance_usd: '1.5', key: { name: 'laptop', prefix: 'p3n_e2e' } } };
				window.__p3n.queue.push(me, me);
			});
			r = await cdp.ev(pickSecret, 'p3n-e2e-good');
			assert(r === true, r);
			await statusIs('Saved. Signed in as test@example.com, balance $1.50.');
			assert(await saved() === 'p3n-e2e-good', `saved "${await saved()}"`);
			const me = await cdp.ev((from) => window.__p3n.requests.slice(from).find((q) => q.url.endsWith('/v1/me')), n);
			assert(me?.method === 'GET' && me.headers.Authorization === 'Bearer p3n_e2e_good', JSON.stringify(me));
			await cdp.shot('key-saved');
			// Refused (the mock refuses any key it wasn't told to accept): the good key stays.
			r = await cdp.ev(pickSecret, 'p3n-e2e-revoked');
			assert(r === true, r);
			await statusIs("p3n doesn't accept this key, so it wasn't saved. Copy it again from the API keys page.");
			assert(await saved() === 'p3n-e2e-good', `saved "${await saved()}"`);
			await cdp.ev(() => [...document.querySelectorAll('.modal.p3n-key-modal button')].find((b) => b.textContent === 'Remove key').click());
			await cdp.waitFor(() => document.querySelector('.modal.p3n-key-modal .p3n-key-status')?.textContent.startsWith('Key removed'));
			assert(await saved() === '', 'key name still saved');
			await cdp.key('Escape', 'Escape', 27);
			await cdp.waitFor(() => !document.querySelector('.modal.p3n-key-modal'));
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
			assert(await cdp.ev(siteLink, 'view') === SITE_LINK, 'no p3n.si link with a key');
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
			for (const want of ['API key', '10 calls an hour', "keychain on this device, not in your notes or the plugin's data.json", 'Pricing, your balance and the docs: p3n.si ↗', 'Privacy', 'What p3n sends', 'It goes to api.p3n.si and nowhere else.']) assert(t.includes(want), `missing "${want}"`);
			assert(await cdp.ev(siteLink, 'settings') === SITE_LINK, await cdp.ev(siteLink, 'settings'));
			const opened = await cdp.ev(clickSite, 'settings');
			assert(opened === SITE_OPENED, opened);
			const status = await cdp.waitFor(() => window.app.setting.activeTab.containerEl.querySelector('.p3n-key-status')?.innerText);
			assert(/doesn't accept this key|Checking/.test(status), status);
			await cdp.shot('settings', { title: await cdp.ev(settingsWindow) });
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
			// The footer up close, from the line under the result: the quota line, p3n.si and Add API key.
			const foot = await cdp.ev(() => {
				const v = document.querySelector('.p3n-view').getBoundingClientRect();
				const meta = document.querySelector('.p3n-view .p3n-result-in > p:last-child').getBoundingClientRect();
				const f = document.querySelector('.p3n-view .p3n-footer').getBoundingClientRect();
				return { x: v.x, y: meta.y - 10, width: v.width, height: f.bottom - meta.y + 30, scale: 2 };
			});
			await cdp.shot('footer-dark', { clip: foot });
			await cdp.ev(selectInNote, AI_TEXT);
			await run(cdp, 'check');
			await cdp.waitFor(idle);
			await cdp.shot('check-dark');
			await cdp.ev((id) => { window.app.setting.open(); window.app.setting.openTabById(id); }, ID);
			await cdp.waitFor((id) => window.app.setting.activeTab?.id === id && window.app.setting.activeTab.containerEl.innerText.includes('p3n.si'), [ID]);
			assert(await cdp.ev(siteLink, 'settings') === SITE_LINK, 'no p3n.si line in the settings');
			await cdp.shot('settings-dark', { title: await cdp.ev(settingsWindow) });
			await cdp.ev(() => window.app.setting.close());
			// In Obsidian 1.12 the settings close with an animation; changing the theme during it made the phone
			// layout's reload, further on, fail to switch back.
			await cdp.waitFor(() => !document.querySelector('.modal.mod-settings'));
			await cdp.ev(() => window.app.changeTheme('moonstone'));
		// The test note's editor. Obsidian 1.14 has no workspace.activeEditor while the p3n view is the active leaf.
		await cdp.ev(() => { window.__ed = () => window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md')?.view.editor; });
		});

		// The view dragged into its own window: its elements and document are that window's, not the main one's.
		await check('popout: results in their own window; the score settles; Try another rewrite keeps the focus', async () => {
			await cdp.ev(() => {
				const leaf = window.app.workspace.getLeavesOfType('p3n')[0];
				window.app.workspace.moveLeafToPopout(leaf);
			});
			await cdp.ev(() => {
				// The view, wherever it is; and its score once the count has finished.
				window.__pv = () => window.app.workspace.getLeavesOfType('p3n')[0]?.view.containerEl;
				window.__settled = () => {
					const el = window.__pv();
					const n = el?.querySelector('.p3n-num');
					return el?.querySelector('.p3n-busy')?.style.display.includes('none') && !!n && n.textContent === el.querySelector('.p3n-sr')?.textContent && n.textContent;
				};
			});
			await cdp.waitFor(() => window.__pv()?.doc !== document && !!window.__pv()?.querySelector('.p3n-view'), [], 20_000);
			try {
				await cdp.ev(selectInNote, SHORT);
				await cdp.ev(() => window.__pv().querySelector('.p3n-result').replaceChildren());
				await cdp.ev((c) => window.app.commands.executeCommandById(c), `${ID}:rewrite`);
				const pct = await cdp.waitFor(() => window.__settled(), [], 15_000);
				assert(pct === '1%', `score ${pct}`);
				// Keyboard: Try another rewrite clears the result it's in; the focus comes back to the new one.
				await cdp.ev(() => {
					const b = [...window.__pv().querySelectorAll('button')].find((x) => x.textContent === 'Try another rewrite');
					b.focus();
					b.click();
				});
				await cdp.waitFor(() => window.__settled(), [], 15_000);
				const focus = await cdp.ev(() => { const el = window.__pv(); return el.doc.activeElement === el.querySelector('.p3n-result').firstElementChild || el.doc.activeElement?.outerHTML.slice(0, 80) || 'nothing'; });
				assert(focus === true, `focus on ${focus}`);
				const sent = await cdp.ev(() => JSON.parse(window.__p3n.requests.at(-1).body));
				assert(sent.options?.fresh === true, JSON.stringify(sent));
			} finally {
				// Closing the window's only tab closes the window; the next run opens the view in the sidebar again.
				await cdp.ev(() => window.app.workspace.getLeavesOfType('p3n').forEach((l) => l.detach()));
			}
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
		// In the dark theme, as the README's phone screenshot shows it.
		await check('mobile: Check and Rewrite in the phone layout, Replace says Undo', async () => {
			await cdp.send('Emulation.setDeviceMetricsOverride', { width: 450, height: 800, deviceScaleFactor: 2, mobile: true });
			await cdp.ev(() => window.app.emulateMobile(true)).catch(() => null);
			await sleep(2000);
			try {
				await cdp.waitFor((id) => window.app?.workspace?.layoutReady && window.app.isMobile && !!window.app.plugins.plugins[id], [ID], 60_000);
				await cdp.ev(() => window.app.changeTheme('obsidian'));
				await cdp.ev(() => { window.__ed = () => window.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === 'Team update.md')?.view.editor; });
				await cdp.ev(installMock, FIXTURES, ID);
				await cdp.ev(selectInNote, AI_TEXT);
				await run(cdp, 'check');
				await cdp.waitFor(idle);
				assert((await cdp.ev(resultText)).includes('Likely AI-written'), 'no result');
				assert(await cdp.ev(siteLink, 'view') === SITE_LINK, 'no p3n.si link in the phone layout');
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
				await cdp.ev(() => window.app.changeTheme('moonstone'));
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
