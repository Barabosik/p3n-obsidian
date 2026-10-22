import { type Editor, type MarkdownFileInfo, MarkdownView, Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { P3nClient, type Skill } from './api.ts';
import { DEFAULT_SETTINGS, KeyModal, type P3nSettings, P3nSettingTab } from './settings.ts';
import { CAPTURE_HINTS, type Source, capture, findSentence, replace, select } from './source.ts';
import { obsidianTransport } from './transport.ts';
import { ICON, P3nView, VIEW_TYPE } from './view.ts';

// A note in reading view: its editor still holds the last selection made in editing view, which isn't what the
// reader sees selected. Obsidian's own editor commands aren't offered there either.
const reading = (v: unknown) => v instanceof MarkdownView && v.getMode() === 'preview';

export default class P3nPlugin extends Plugin {
	settings: P3nSettings = { ...DEFAULT_SETTINGS };
	client!: P3nClient;
	// Free calls left this hour without a key, from the API's last answer (X-Free-Remaining).
	free: number | null = null;

	async onload() {
		await this.loadSettings();
		this.client = new P3nClient(obsidianTransport, `p3n-obsidian/${this.manifest.version}`);
		this.registerView(VIEW_TYPE, (leaf) => new P3nView(leaf, this));

		// In a note, or in the p3n view, where they work on the note last worked in (as the view's buttons do).
		this.addCommand({
			id: 'check',
			name: 'Check for AI',
			icon: 'scan-text',
			checkCallback: (checking) => this.command('detect', checking),
		});
		this.addCommand({
			id: 'rewrite',
			name: 'Rewrite',
			icon: ICON,
			checkCallback: (checking) => this.command('humanize', checking),
		});
		this.addCommand({
			id: 'open',
			name: 'Open results',
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: 'set-api-key',
			name: 'Set API key',
			callback: () => this.openKey(),
		});
		this.addRibbonIcon(ICON, 'Open p3n', () => void this.activateView());

		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, ctx) => {
			if (!editor.somethingSelected()) return;
			menu.addItem((item) => item
				.setTitle('Check for AI with p3n')
				.setIcon('scan-text')
				.setSection('selection')
				.onClick(() => void this.runFromEditor('detect', editor, ctx)));
			menu.addItem((item) => item
				.setTitle('Rewrite with p3n')
				.setIcon(ICON)
				.setSection('selection')
				.onClick(() => void this.runFromEditor('humanize', editor, ctx)));
		}));

		this.addSettingTab(new P3nSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<P3nSettings> | null) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshViews();
	}

	// The API key, from Obsidian's secret storage, or '' for keyless use.
	getKey(): string {
		if (!this.settings.keySecret) return '';
		return (this.app.secretStorage.getSecret(this.settings.keySecret) ?? '').trim();
	}

	// The API key window: the Set API key command, and the view's Add an API key buttons.
	openKey() {
		new KeyModal(this.app, this).open();
	}

	// Shows the view. `focus`: make it the active leaf when it's new (Open results, the ribbon); a check or a
	// rewrite leaves the focus in the note, whether the view was open already or not.
	async activateView(focus = true): Promise<P3nView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: VIEW_TYPE, active: focus });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof P3nView ? leaf.view : null;
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof P3nView) void leaf.view.refreshAccount();
		}
	}

	// Sends the editor's selection, after a click: the command, the right-click menu or the view's buttons.
	async runFromEditor(skill: Skill, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) {
		const file = ctx.file;
		const view = await this.activateView(false);
		if (!view) return;
		if (!file) return view.hint(CAPTURE_HINTS.noNote);
		const got = capture(editor, file.path, file.basename);
		if (!got.ok) return view.hint(CAPTURE_HINTS[got.reason]);
		await view.start(skill, got.source);
	}

	// The Check for AI and Rewrite commands: there whenever a note is open for editing, and in the p3n view,
	// so the palette and hotkeys still find them after a click in the view.
	private command(skill: Skill, checking: boolean): boolean {
		const { workspace } = this.app;
		const active = workspace.activeEditor;
		if (active?.editor && !reading(active)) {
			if (!checking) void this.runFromEditor(skill, active.editor, active);
			return true;
		}
		if (!workspace.getActiveViewOfType(P3nView)) return false;
		if (!checking) void this.runFromRecentEditor(skill);
		return true;
	}

	// The view's own buttons: the selection in the note last worked in.
	async runFromRecentEditor(skill: Skill) {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (leaf?.view instanceof MarkdownView && !reading(leaf.view)) return this.runFromEditor(skill, leaf.view.editor, leaf.view);
		const view = await this.activateView();
		view?.hint(leaf?.view instanceof MarkdownView ? CAPTURE_HINTS.reading : CAPTURE_HINTS.noNote);
	}

	// The open note a source came from, most recently used first.
	private viewFor(path: string): MarkdownView | null {
		const { workspace } = this.app;
		const recent = workspace.getMostRecentLeaf()?.view;
		const views = [recent, ...workspace.getLeavesOfType('markdown').map((l) => l.view)];
		for (const v of views) if (v instanceof MarkdownView && v.file?.path === path) return v;
		return null;
	}

	replaceInNote(source: Source, rewrite: string): 'ok' | 'closed' | 'changed' {
		const view = this.viewFor(source.path);
		if (!view) return 'closed';
		const done = replace(view.editor, source, rewrite);
		if (!done.ok) return done.reason;
		// The same rewrite can't go in twice: the selection is now the rewrite.
		Object.assign(source, { text: rewrite, from: done.from, to: done.to });
		return 'ok';
	}

	showInNote(source: Source, sentence: string) {
		const view = this.viewFor(source.path);
		if (!view) {
			new Notice(`${source.note} isn't open any more.`);
			return;
		}
		const at = findSentence(view.editor.getValue(), source, sentence);
		if (!at) {
			new Notice("That sentence isn't in the note as written any more.");
			return;
		}
		this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		select(view.editor, at);
	}
}
