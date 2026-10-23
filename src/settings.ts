import { type App, Modal, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from 'obsidian';
import { LINKS } from './api.ts';
import { KEY_PATTERN, checkKey } from './key.ts';
import type P3nPlugin from './main.ts';
import { siteLink } from './view.ts';

export interface P3nSettings {
	// The name of the secret in Obsidian's secret storage that holds the API key, not the key itself.
	keySecret: string;
}

export const DEFAULT_SETTINGS: P3nSettings = {
	keySecret: '',
};

function keyDesc(): DocumentFragment {
	return createFragment((f) => {
		f.appendText('Optional. Without a key, p3n gives you 10 calls an hour, up to 5,000 characters each. For more, ');
		f.createEl('a', { text: 'sign up at p3n.si', href: LINKS.signup });
		f.appendText(' (you get free credit), create a key on the ');
		f.createEl('a', { text: 'API keys', href: LINKS.keys });
		f.appendText(" page and add it here; it's saved once p3n accepts it. The key is kept in Obsidian's keychain on this device, not in your notes or the plugin's data.json.");
	});
}

// Under the key: pricing, the balance and the docs are on p3n.si, not in Obsidian.
function siteLine(): DocumentFragment {
	return createFragment((f) => {
		f.appendText('Pricing, your balance and the docs: ');
		siteLink(f);
	});
}

const PRIVACY = 'Only the text you select, and only when you choose Check for AI or Rewrite. It goes to api.p3n.si and nowhere else. The plugin doesn\'t read your notes on its own, keeps no history and has no analytics.';

// The key row: Obsidian's secret picker, a Remove button and a line saying whether p3n accepts the key.
// Used by the settings tab and by the API key window the results view opens.
function keyRow(setting: Setting, plugin: P3nPlugin) {
	const status = setting.descEl.createDiv({ cls: 'p3n-key-status', attr: { role: 'status' } });
	let pending = 0;
	const say = (msg: string, kind = '') => {
		status.setText(msg);
		status.className = `p3n-key-status${kind ? ` p3n-${kind}` : ''}`;
	};
	// Each check takes a number: an older one still on its way must not overwrite a newer line.
	const check = async (key: string, saving: boolean) => {
		const mine = ++pending;
		if (KEY_PATTERN.test(key)) say('Checking the key…');
		const r = await checkKey(plugin.client, key, saving);
		return mine === pending ? r : null;
	};
	let picker: SecretComponent | null = null;
	// Setting the picker back must not count as a new pick.
	let quiet = false;
	const setPicker = (name: string) => {
		quiet = true;
		picker?.setValue(name);
		quiet = false;
	};
	const remove = async () => {
		pending++;
		plugin.settings.keySecret = '';
		await plugin.saveSettings();
		setPicker('');
		say('Key removed. p3n still works without one, with the free hourly limit. The key itself stays in the keychain (Settings, Keychain) until you delete it there.');
	};
	// A picked key is saved only when p3n accepts it; otherwise the picker goes back to the saved one.
	const pick = async (name: string) => {
		const r = await check((plugin.app.secretStorage.getSecret(name) ?? '').trim(), true);
		if (!r) return;
		if (r.ok) {
			plugin.settings.keySecret = name;
			await plugin.saveSettings();
		} else {
			setPicker(plugin.settings.keySecret);
		}
		say(r.text, r.kind);
	};
	setting.addComponent((el) => {
		picker = new SecretComponent(plugin.app, el)
			.setValue(plugin.settings.keySecret)
			.onChange((name) => {
				if (!quiet) void (name ? pick(name) : remove());
			});
		return picker;
	});
	setting.addButton((b) => b
		.setButtonText('Remove key')
		.onClick(() => void remove()));
	// The saved key, when the row opens.
	const show = async () => {
		const r = await check(plugin.getKey(), false);
		if (r) say(r.text, r.kind);
	};
	if (plugin.settings.keySecret) void show();
}

export class P3nSettingTab extends PluginSettingTab {
	plugin: P3nPlugin;

	constructor(app: App, plugin: P3nPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Obsidian 1.13 and later draw the tab from this (and can search it); older versions call display().
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'API key', desc: keyDesc(), render: (setting) => keyRow(setting.setName('API key').setDesc(keyDesc()), this.plugin) },
			{ name: 'Pricing, your balance and the docs', aliases: ['p3n.si'], render: (setting) => { setting.setName(siteLine()); } },
			{ type: 'group', heading: 'Privacy', items: [{ name: 'What p3n sends', desc: PRIVACY }] },
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		keyRow(new Setting(containerEl).setName('API key').setDesc(keyDesc()), this.plugin);
		new Setting(containerEl).setName(siteLine());
		new Setting(containerEl).setName('Privacy').setHeading();
		new Setting(containerEl).setName('What p3n sends').setDesc(PRIVACY);
	}
}

// The same key row in a window, for the Set API key command and the Add an API key buttons in the results view.
export class KeyModal extends Modal {
	plugin: P3nPlugin;

	constructor(app: App, plugin: P3nPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.setTitle('API key');
		this.modalEl.addClass('p3n-key-modal');
		keyRow(new Setting(this.contentEl).setDesc(keyDesc()), this.plugin);
	}

	onClose() {
		this.contentEl.empty();
		this.plugin.refreshViews();
	}
}
