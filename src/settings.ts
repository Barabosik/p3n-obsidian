import { type App, Modal, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from 'obsidian';
import { ApiError, LINKS } from './api.ts';
import type P3nPlugin from './main.ts';

export interface P3nSettings {
	// The name of the secret in Obsidian's secret storage that holds the API key, not the key itself.
	keySecret: string;
}

export const DEFAULT_SETTINGS: P3nSettings = {
	keySecret: '',
};

const KEY_PATTERN = /^p3n_\S+$/;

function keyDesc(): DocumentFragment {
	return createFragment((f) => {
		f.appendText('Optional. Without a key, p3n gives you 10 calls an hour, up to 5,000 characters each. For more, ');
		f.createEl('a', { text: 'sign up at p3n.si', href: LINKS.signup });
		f.appendText(' (you get free credit), create a key on the ');
		f.createEl('a', { text: 'API keys', href: LINKS.keys });
		f.appendText(" page and add it here. The key is kept in Obsidian's keychain on this device, not in your notes or the plugin's data.json.");
	});
}

const PRIVACY = 'Only the text you select, and only when you choose Check for AI or Rewrite. It goes to api.p3n.si and nowhere else. The plugin doesn\'t read your notes on its own, keeps no history and has no analytics.';

// The key row: Obsidian's secret picker, a Remove button and a line saying whether p3n accepts the key.
// Used by the settings tab and by the API key window the results view opens.
function keyRow(setting: Setting, plugin: P3nPlugin) {
	const status = setting.descEl.createDiv({ cls: 'p3n-key-status' });
	let pending = 0;
	const say = (msg: string, kind = '') => {
		status.setText(msg);
		status.className = `p3n-key-status${kind ? ` p3n-${kind}` : ''}`;
	};
	const check = async () => {
		const mine = ++pending;
		const key = plugin.getKey();
		if (!plugin.settings.keySecret) return say('');
		if (!key) return say('That secret is empty on this device. Pick another, or add the key again.', 'warn');
		if (!KEY_PATTERN.test(key)) return say('Keys start with p3n_. Copy the whole key from the API keys page.', 'warn');
		say('Checking the key…');
		try {
			const m = await plugin.client.me(key);
			if (mine !== pending) return;
			say(`Signed in as ${m.email ?? 'your account'}, balance $${Number(m.balance_usd ?? 0).toFixed(2)}.`, 'ok');
		} catch (e) {
			if (mine !== pending) return;
			say(e instanceof ApiError && e.type === 'unauthorized' ? "p3n doesn't accept this key. Copy it again from the API keys page." : e instanceof Error ? e.message : String(e), 'error');
		}
	};
	let picker: SecretComponent | null = null;
	setting.addComponent((el) => {
		picker = new SecretComponent(plugin.app, el)
			.setValue(plugin.settings.keySecret)
			.onChange(async (name) => {
				plugin.settings.keySecret = name ?? '';
				await plugin.saveSettings();
				void check();
			});
		return picker;
	});
	setting.addButton((b) => b
		.setButtonText('Remove key')
		.onClick(async () => {
			// A key check still on its way must not overwrite this.
			pending++;
			plugin.settings.keySecret = '';
			await plugin.saveSettings();
			picker?.setValue('');
			say('Key removed. p3n still works without one, with the free hourly limit. The key itself stays in the keychain (Settings, Keychain) until you delete it there.');
		}));
	void check();
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
			{ type: 'group', heading: 'Privacy', items: [{ name: 'What p3n sends', desc: PRIVACY }] },
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		keyRow(new Setting(containerEl).setName('API key').setDesc(keyDesc()), this.plugin);
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
