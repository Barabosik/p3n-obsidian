// What p3n says about an API key: its format, then GET /v1/me. A key picked in the settings is saved only when
// p3n accepts it, so a typo never replaces a good key. Kept free of Obsidian's runtime so the tests can run it.
import { ApiError, type P3nClient } from './api.ts';

export const KEY_PATTERN = /^p3n_\S+$/;

export interface KeyCheck {
	ok: boolean;
	text: string;
	kind: 'ok' | 'warn' | 'error';
}

// `saving`: the key was just picked, and is saved only if this comes back ok. Otherwise it's the saved key.
export async function checkKey(client: P3nClient, key: string, saving: boolean): Promise<KeyCheck> {
	const unsaved = saving ? " The key wasn't saved." : '';
	if (!key) return { ok: false, kind: 'warn', text: `That secret is empty on this device. Pick another, or add the key again.${unsaved}` };
	if (!KEY_PATTERN.test(key)) return { ok: false, kind: 'warn', text: `Keys start with p3n_. Copy the whole key from the API keys page.${unsaved}` };
	try {
		const m = await client.me(key);
		return { ok: true, kind: 'ok', text: `${saving ? 'Saved. ' : ''}Signed in as ${m.email ?? 'your account'}, balance $${Number(m.balance_usd ?? 0).toFixed(2)}.` };
	} catch (e) {
		if (e instanceof ApiError && e.type === 'unauthorized') {
			return { ok: false, kind: 'error', text: `p3n doesn't accept this key${saving ? ", so it wasn't saved" : ''}. Copy it again from the API keys page.` };
		}
		return { ok: false, kind: 'error', text: `${e instanceof Error ? e.message : String(e)}${unsaved}` };
	}
}
