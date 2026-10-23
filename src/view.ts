import { ItemView, Platform, type WorkspaceLeaf } from 'obsidian';
import { ApiError, type DetectOutput, type HumanizeOutput, LINKS, type Run, type Skill, isAbort } from './api.ts';
import { DETECT_NOTE, HUMANIZE_NOTE, MISSING_RESULT, balanceLine, busyText, clip, detectParts, errorParts, fitRewrite, humanizeParts, metaLine, missingResult, quotaLine, refuse, sourceLine, type Tone, tone, undoKey } from './format.ts';
import type P3nPlugin from './main.ts';
import type { Source } from './source.ts';

export const VIEW_TYPE = 'p3n';
export const ICON = 'pen-line';

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The results view in the right sidebar (a drawer on mobile): what was sent, the score, and for a rewrite,
// Replace selection. Runs one job at a time; a new one cancels the last.
export class P3nView extends ItemView {
	plugin: P3nPlugin;
	private sourceEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private busyEl!: HTMLElement;
	private busyText!: HTMLElement;
	private resultEl!: HTMLElement;
	private quotaEl!: HTMLElement;
	private keyBtn!: HTMLButtonElement;
	private clearRow: HTMLElement | null = null;
	private buttons: HTMLButtonElement[] = [];
	private controller: AbortController | null = null;
	private timer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: P3nPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return this.plugin.manifest.name;
	}

	getIcon() {
		return ICON;
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('p3n-view');
		root.createEl('p', { cls: 'p3n-muted p3n-small', text: 'Select text in a note, then check it for AI or rewrite it with the buttons below, the command palette or the right-click menu.' });
		const row = root.createDiv({ cls: 'p3n-row' });
		this.buttons = [
			row.createEl('button', { cls: 'mod-cta', text: 'Check for AI' }),
			row.createEl('button', { text: 'Rewrite' }),
		];
		this.buttons[0]?.addEventListener('click', () => void this.plugin.runFromRecentEditor('detect'));
		this.buttons[1]?.addEventListener('click', () => void this.plugin.runFromRecentEditor('humanize'));
		this.sourceEl = root.createEl('p', { cls: 'p3n-source p3n-small p3n-muted' });
		this.sourceEl.hide();
		this.hintEl = root.createEl('p', { cls: 'p3n-note p3n-warn p3n-small' });
		this.hintEl.hide();

		this.busyEl = root.createDiv({ cls: 'p3n-busy' });
		this.busyEl.createDiv({ cls: 'p3n-progress' }).createEl('i');
		const busyRow = this.busyEl.createDiv({ cls: 'p3n-row' });
		this.busyText = busyRow.createSpan({ cls: 'p3n-small p3n-muted', attr: { role: 'status' } });
		busyRow.createEl('button', { cls: 'p3n-push', text: 'Cancel' }).addEventListener('click', () => this.controller?.abort());
		this.busyEl.hide();

		this.resultEl = root.createDiv({ cls: 'p3n-result', attr: { 'aria-live': 'polite' } });

		const footer = root.createDiv({ cls: 'p3n-footer p3n-row' });
		this.quotaEl = footer.createSpan({ cls: 'p3n-small p3n-muted' });
		// Next to the quota line, not in it: refreshAccount() replaces its text.
		const links = footer.createDiv({ cls: 'p3n-footer-links p3n-push' });
		siteLink(links, 'p3n-link p3n-small');
		this.keyBtn = links.createEl('button', { cls: 'p3n-link p3n-small' });
		this.keyBtn.addEventListener('click', () => this.plugin.openKey());
		void this.refreshAccount();
	}

	async onClose() {
		this.controller?.abort();
		this.stopTimer();
	}

	hint(msg: string) {
		this.hintEl.setText(msg);
		this.hintEl.toggle(!!msg);
	}

	// ---- running a skill ----------------------------------------------------------------------

	async start(skill: Skill, source: Source, options?: Record<string, unknown>) {
		const text = source.text.trim();
		this.controller?.abort();
		this.plugin.clearHighlights();
		this.hint('');
		const key = this.plugin.getKey();
		this.sourceEl.setText(sourceLine(source.note, text.length, !!key));
		this.sourceEl.show();
		const why = refuse(skill, text, !!key);
		if (why) return this.showError(new ApiError(422, why.type, why.message));
		const controller = new AbortController();
		this.controller = controller;
		// Try another rewrite is inside the result: clearing it drops keyboard focus, so bring it back after.
		// The view's own document: in a pop-out window it isn't the main one.
		const refocus = this.resultEl.contains(this.resultEl.doc.activeElement);
		this.resultEl.empty();
		this.setBusy(skill);
		try {
			const { run, free } = await this.plugin.client.runSkill(skill, text, { key, options, signal: controller.signal });
			if (free !== null) this.plugin.free = free;
			this.render(run, text, source);
		} catch (e) {
			if (!isAbort(e)) this.showError(e instanceof Error ? e : new Error(String(e)));
			if (e instanceof ApiError && e.free != null) this.plugin.free = e.free;
		} finally {
			if (this.controller === controller) {
				this.controller = null;
				this.setBusy(null);
			}
			void this.refreshAccount();
			if (refocus) focusOn(this.resultEl.firstElementChild);
		}
	}

	private stopTimer() {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
	}

	private setBusy(skill: Skill | null) {
		this.stopTimer();
		this.busyEl.toggle(!!skill);
		for (const b of this.buttons) b.disabled = !!skill;
		if (!skill) return;
		const t0 = Date.now();
		const tick = () => this.busyText.setText(busyText(skill, Math.round((Date.now() - t0) / 1000)));
		tick();
		this.timer = window.setInterval(tick, 1000);
	}

	// ---- results ------------------------------------------------------------------------------

	private render(run: Run, sent: string, source: Source) {
		if (missingResult(run)) return this.showError(new ApiError(502, 'bad_output', MISSING_RESULT));
		const box = this.resultEl.createDiv({ cls: 'p3n-result-in' });
		if (run.skill === 'humanize') this.renderHumanize(box, run.output as unknown as HumanizeOutput, sent, source);
		else this.renderDetect(box, run.output as unknown as DetectOutput, source);
		box.createEl('p', { cls: 'p3n-small p3n-muted', text: metaLine(run, !!this.plugin.getKey()) });
		stagger(box);
		runScore(box);
	}

	private renderDetect(box: HTMLElement, o: DetectOutput, source: Source) {
		const d = detectParts(o);
		score(box, { label: d.label, sub: null, from: 0, to: d.score, tone: d.tone, unit: 'likely AI', title: null });
		meter(box, d.score, d.tone);
		if (d.verdict) box.createEl('p', { text: d.verdict });
		if (d.confidence) box.createEl('p', { cls: 'p3n-small p3n-muted', text: d.confidence });
		if (d.sentences.length) {
			const part = box.createDiv();
			part.createEl('h4', { text: 'Sentences that read as AI' });
			part.createEl('p', { cls: 'p3n-small p3n-muted', text: 'Select one to find it in the note.' });
			const list = part.createEl('ul', { cls: 'p3n-quotes' });
			d.sentences.forEach((s, j) => {
				const li = list.createEl('li', { cls: 'p3n-hit p3n-clickable', attr: { role: 'button', tabindex: '0', 'aria-label': `Find in the note: ${s.text}` } });
				li.setCssProps({ '--p3n-j': String(j) });
				if (s.why) li.createSpan({ cls: 'p3n-why', text: s.why });
				li.createEl('q', { text: clip(s.text) });
				const go = () => this.plugin.showInNote(source, s.text);
				li.addEventListener('click', go);
				li.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						go();
					}
				});
			});
		}
		if (d.hits.length) {
			const part = box.createDiv();
			part.createEl('h4', { text: 'Pattern hits' });
			const list = part.createEl('ul', { cls: 'p3n-quotes' });
			for (const h of d.hits) {
				const li = list.createEl('li');
				li.createSpan({ cls: 'p3n-why', text: h.rules });
				li.createEl('q', { text: clip(h.sentence) });
			}
		}
		const marked = this.plugin.highlight(source, [
			...d.sentences.map((s) => ({ text: s.text, kind: 'sentence' as const, why: s.why ?? '' })),
			...d.hits.map((h) => ({ text: h.sentence, kind: 'hit' as const, why: h.rules })),
		]);
		if (marked) {
			this.clearRow = box.createDiv({ cls: 'p3n-row' });
			this.clearRow.createEl('button', { cls: 'p3n-link p3n-small', text: 'Clear highlights' })
				.addEventListener('click', () => this.plugin.clearHighlights());
		}
		box.createEl('p', { cls: 'p3n-small p3n-muted', text: DETECT_NOTE });
	}

	// The highlights went (Clear highlights, an edit, the next run): so does their button.
	highlightsCleared() {
		this.clearRow?.remove();
		this.clearRow = null;
	}

	private renderHumanize(box: HTMLElement, o: HumanizeOutput, sent: string, source: Source) {
		const h = humanizeParts(o, sent);
		const rewrite = fitRewrite(source.text, o.text);
		score(box, { label: h.headline, sub: h.model, from: h.before ?? h.score, to: h.score, tone: h.tone, unit: 'AI class', title: 'Detector model, AI class', before: h.before });
		meter(box, h.score, h.tone);
		box.createDiv({ cls: 'p3n-rewrite', text: rewrite.trim() });
		const row = box.createDiv({ cls: 'p3n-row' });
		const status = box.createEl('p', { cls: 'p3n-note p3n-small' });
		status.hide();
		const say = (msg: string, kind: 'ok' | 'warn') => {
			status.setText(msg);
			status.toggleClass('p3n-ok', kind === 'ok');
			status.toggleClass('p3n-warn', kind === 'warn');
			status.show();
		};
		const rep = row.createEl('button', { cls: 'mod-cta', text: 'Replace selection' });
		rep.addEventListener('click', () => {
			const r = this.plugin.replaceInNote(source, rewrite);
			if (r === 'ok') {
				const hadFocus = rep.doc.activeElement === rep;
				rep.setText('Replaced');
				rep.disabled = true; // a disabled button loses focus: keep it on the status that says what happened
				say(`Replaced in the note and selected there. ${undoKey(Platform)} in the note undoes it.`, 'ok');
				if (hadFocus) focusOn(status);
				return;
			}
			const why = {
				closed: `${source.note} isn't open any more.`,
				changed: 'That text changed in the note since you selected it, so p3n left it alone.',
			}[r];
			say(`${why} Copy the rewrite and paste it instead, or select the text again and rewrite it.`, 'warn');
		});
		const copy = row.createEl('button', { text: 'Copy' });
		let reset = 0;
		// The clipboard of the window the view is in: a pop-out window's own, which has the focus.
		const copyText = async () => {
			try {
				await copy.win.navigator.clipboard.writeText(rewrite.trim());
			} catch {
				say("p3n couldn't copy it. Select the text in the box above and copy it.", 'warn');
				return;
			}
			copy.setText('Copied');
			window.clearTimeout(reset);
			reset = window.setTimeout(() => copy.setText('Copy'), 1500);
		};
		copy.addEventListener('click', () => void copyText());
		row.createEl('button', { cls: 'p3n-link p3n-push p3n-small', text: 'Try another rewrite' })
			.addEventListener('click', () => void this.start('humanize', source, { fresh: true }));
		for (const n of h.notes) box.createEl('p', { cls: n.warn ? 'p3n-note p3n-warn p3n-small' : 'p3n-small p3n-muted', text: n.text });
		box.createEl('p', { cls: 'p3n-small p3n-muted', text: HUMANIZE_NOTE });
	}

	showError(e: Error) {
		this.resultEl.empty();
		const p = errorParts(e);
		const box = this.resultEl.createDiv({ cls: 'p3n-note p3n-error p3n-result-in' });
		for (const line of p.lines) box.createEl('p', { text: line });
		if (p.small) box.createEl('p', { cls: 'p3n-small', text: p.small });
		if (p.actions.length) {
			const row = box.createDiv({ cls: 'p3n-row' });
			for (const a of p.actions) {
				if (a.kind === 'link') row.createEl('a', { cls: `p3n-button${a.primary ? ' mod-cta' : ''}`, text: a.label, href: a.href });
				else row.createEl('button', { text: a.label }).addEventListener('click', () => this.plugin.openKey());
			}
		}
		stagger(box);
	}

	// ---- account ------------------------------------------------------------------------------

	async refreshAccount() {
		if (!this.quotaEl) return;
		const key = this.plugin.getKey();
		this.keyBtn.setText(key ? 'API key' : 'Add API key');
		const line = quotaLine(!!key, this.plugin.free);
		if (line !== null) return this.quotaEl.setText(line);
		this.quotaEl.setText('');
		try {
			const m = await this.plugin.client.me(key);
			this.quotaEl.setText(balanceLine(m.balance_usd, m.key?.name ?? m.key?.prefix));
		} catch (e) {
			this.quotaEl.setText(e instanceof ApiError && e.type === 'unauthorized' ? "Your API key wasn't accepted. Change it under API key." : '');
		}
	}
}

// The link to p3n.si, in the view's footer and in the settings. The arrow is hidden from screen readers, so it
// reads "p3n.si". On desktop, Obsidian's Web viewer (when it's on) opens links inside Obsidian; "_external" is
// Obsidian's own way to send one to the browser. On mobile the link opens in the browser as it is.
export function siteLink(parent: HTMLElement | DocumentFragment, cls = ''): HTMLAnchorElement {
	const a = parent.createEl('a', { cls: `p3n-site ${cls}`.trim(), href: LINKS.site, attr: { title: 'Open p3n.si in your browser' } });
	a.appendText('p3n.si ');
	a.createSpan({ text: '↗', attr: { 'aria-hidden': 'true' } });
	a.addEventListener('click', (e) => {
		if (!Platform.isDesktopApp) return;
		e.preventDefault();
		a.win.open(a.href, '_external');
	});
	return a;
}

// Moves keyboard focus to something that isn't focusable by itself (a result, a status line).
// instanceOf, not instanceof: in a pop-out window the element comes from that window's HTMLElement.
function focusOn(el: Element | null) {
	if (!el?.instanceOf(HTMLElement)) return;
	el.tabIndex = -1;
	el.focus({ preventScroll: true });
}

interface ScoreParts {
	label: string;
	sub: string | null;
	from: number;
	to: number;
	tone: Tone;
	unit: string;
	title: string | null;
	before?: number | null;
}

// The big number: animated for the eye, stated once for screen readers (the result is a live region).
function score(box: HTMLElement, s: ScoreParts) {
	const el = box.createDiv({ cls: 'p3n-score', attr: { 'data-from': String(s.from), 'data-to': String(s.to), 'data-tone': s.tone } });
	const left = el.createDiv();
	left.createEl('p', { cls: 'p3n-label', text: s.label });
	if (s.sub) left.createEl('p', { cls: 'p3n-small p3n-muted', text: s.sub });
	const p = el.createEl('p', { cls: `p3n-pct p3n-t-${s.tone}` });
	if (s.title) p.setAttr('title', s.title);
	if (s.before != null) p.createSpan({ cls: 'p3n-from', text: `${s.before}% → ` });
	p.createSpan({ cls: 'p3n-num', text: `${s.to}%`, attr: { 'aria-hidden': 'true' } });
	p.createSpan({ cls: 'p3n-sr', text: `${s.to}%` });
	p.createEl('small', { text: s.unit });
}

function meter(box: HTMLElement, value: number, t: Tone) {
	const bar = box.createDiv({ cls: 'p3n-meter' }).createEl('i', { cls: `p3n-b-${t}` });
	bar.setCssProps({ '--p3n-w': `${Math.max(3, value)}%` });
}

// Result parts arrive in reading order.
function stagger(box: HTMLElement) {
	Array.from(box.children).forEach((c, i) => (c as HTMLElement).setCssProps({ '--p3n-i': String(i) }));
}

const toneOf = (v: number) => tone(v / 100);

// The one moment that moves: the score runs from where the text was to where it is now (0 for a check, the
// score before for a rewrite), and the number and the bar take the colour of each band they pass through.
// The markup already holds the end state, so reduced motion or a failed frame shows the right result.
function runScore(root: HTMLElement) {
	const scoreEl = root.querySelector<HTMLElement>('[data-to]');
	const num = scoreEl?.querySelector<HTMLElement>('.p3n-num');
	const pctEl = scoreEl?.querySelector<HTMLElement>('.p3n-pct');
	const bar = root.querySelector<HTMLElement>('.p3n-meter i');
	if (!scoreEl || !num || !pctEl) return;
	const from = Number(scoreEl.dataset.from);
	const to = Number(scoreEl.dataset.to);
	const end = (scoreEl.dataset.tone as Tone | undefined) ?? toneOf(to);
	// A hidden window gets no animation frames, so the count would stop part way: show the end state. The frames
	// and the clock are the view's own window's: in a pop-out window, the main one may be hidden.
	const win = root.win;
	if (calm() || from === to || root.doc.hidden) return;
	const draw = (v: number, t = toneOf(v)) => {
		num.setText(`${Math.round(v)}%`);
		pctEl.removeClass('p3n-t-ai', 'p3n-t-mid', 'p3n-t-human');
		pctEl.addClass(`p3n-t-${t}`);
		if (bar) bar.className = `p3n-b-${t}`;
	};
	const scale = (v: number) => bar?.setCssProps({ '--p3n-scale': String(Math.max(3, v) / Math.max(3, to)) });
	const t0 = win.performance.now() + 120;
	const ms = 800;
	draw(from);
	scale(from);
	const step = (now: number) => {
		if (!num.isConnected) return;
		const p = Math.min(1, Math.max(0, (now - t0) / ms));
		const v = from + (to - from) * (1 - (1 - p) ** 4);
		if (p < 1) {
			draw(v);
			scale(v);
			win.requestAnimationFrame(step);
		} else {
			draw(to, end);
			bar?.setCssProps({ '--p3n-scale': '1' });
		}
	};
	win.requestAnimationFrame(step);
}
