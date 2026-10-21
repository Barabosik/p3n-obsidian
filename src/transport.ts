import { requestUrl } from 'obsidian';
import type { Transport } from './api.ts';

// Obsidian's requestUrl: works on desktop and mobile, and isn't held to the browser's cross-origin rules.
// throw: false hands every status back, so the API's own error messages reach the user.
export const obsidianTransport: Transport = async ({ url, method, headers, body }) => {
	const { 'Content-Type': contentType, ...rest } = headers;
	const res = await requestUrl({ url, method, headers: rest, body, contentType, throw: false });
	let text = '';
	try {
		text = res.text;
	} catch {
		// not text: the API layer reads it as no answer
	}
	return { status: res.status, headers: res.headers ?? {}, text };
};
