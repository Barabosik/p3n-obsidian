# Privacy

The p3n plugin for Obsidian sends text to p3n only when you ask it to.

- **What it sends.** The text you selected in a note, when you choose Check for AI or Rewrite. If you added an API key, the key goes with it so p3n can bill your account, and the plugin also asks p3n for your balance when the p3n view opens, after each check or rewrite, and when the key changes (the key only, no text). Each call also names the plugin and its version (for example `p3n-obsidian/0.1.0`), so your usage page can show which tool made it.
- **Where it goes.** Only to `api.p3n.si`, over HTTPS.
- **What it doesn't do.** It sends no text until you choose, and never reads your vault, other notes or file names on its own. It keeps no history, and has no analytics, telemetry or ads.
- **What stays on your device.** Your API key, in Obsidian's keychain (**Settings → Keychain**), not in your notes. The plugin's `data.json` holds only the name of that keychain entry. Removing the plugin deletes `data.json`; the key stays in the keychain until you delete it there.

What p3n does with the text it receives:
- It keeps the text for up to 7 days, to return results and debug failures, then deletes it.
- It sends the text through OpenRouter to the AI model providers that run the check or rewrite.
- It logs the time and IP address of each call. That's how the free limit works.
- It doesn't sell data or use your text to train models.

The full policy is at [p3n.si/privacy](https://p3n.si/privacy). Questions go to [p3n.si/contact](https://p3n.si/contact).
