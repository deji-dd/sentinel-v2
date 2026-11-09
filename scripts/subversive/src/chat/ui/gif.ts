// GIF picker: searches KLIPY directly from the browser (KLIPY requires
// client-side requests) and hands the chosen GIF back to the composer. Falls
// back to a clear "paste a link" hint when no key is configured.
import { type Child, fill, h, icon, text } from "../dom";
import { buildKlipyUrl, mapKlipyResponse } from "../klipy";
import type { ChatGif, ChatGifResult } from "../protocol";
import { state } from "../store";
import { textInput, warning } from "./forms";

export interface GifPickerHandle {
	el: HTMLElement;
	close: () => void;
}

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;
const cache = new Map<string, { at: number; results: ChatGifResult[] }>();

function cachedResults(key: string): ChatGifResult[] | null {
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.at > CACHE_MS) {
		cache.delete(key);
		return null;
	}
	return entry.results;
}

function rememberResults(key: string, results: ChatGifResult[]): void {
	cache.set(key, { at: Date.now(), results });
	if (cache.size > CACHE_MAX) {
		const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (oldest) cache.delete(oldest[0]);
	}
}

export function openGifPicker(opts: {
	onPick: (gif: ChatGif) => void;
	onClose: () => void;
	/** The button that toggles the picker; its own click must not be treated as an outside click. */
	ignore?: HTMLElement;
}): GifPickerHandle {
	const grid = h("div", { c: "sc-gif-grid" });
	const status = h("div", { c: "sc-gif-status" });
	const search = textInput({
		placeholder: "Search GIFs",
		icon: "search",
		cls: "sc-gif-search",
		onInput: (value) => {
			clearTimeout(timer);
			timer = setTimeout(() => load(value.trim()), 300);
		},
		onEnter: (value) => load(value.trim()),
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	let requestSeq = 0;
	let closed = false;

	const el = h(
		"div",
		{ c: "sc-gif-picker", role: "dialog", "aria-label": "GIF picker" },
		h(
			"div",
			{ c: "sc-gif-head" },
			search.root,
			h(
				"button",
				{
					type: "button",
					c: "sc-gif-close",
					title: "Close GIF picker",
					on: { click: () => close() },
				},
				icon("cross", "sc-gif-close-icon"),
			),
		),
		status,
		grid,
		h(
			"div",
			{ c: "sc-gif-attr" },
			"Powered by ",
			h(
				"a",
				{
					href: "https://klipy.com",
					target: "_blank",
					rel: "noopener noreferrer",
				},
				"KLIPY",
			),
		),
	);

	const close = () => {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		document.removeEventListener("pointerdown", outside, true);
		document.removeEventListener("keydown", escape, true);
		el.remove();
		opts.onClose();
	};
	const outside = (event: Event) => {
		const target = event.target as Node;
		if (opts.ignore?.contains(target)) return;
		if (!el.contains(target)) close();
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key === "Escape") close();
	};
	document.addEventListener("pointerdown", outside, true);
	document.addEventListener("keydown", escape, true);

	const setStatus = (...children: Child[]) => {
		fill(status, ...children);
	};

	const render = (results: ChatGifResult[]) => {
		setStatus();
		grid.replaceChildren(
			...results.map((result) =>
				h(
					"button",
					{
						type: "button",
						c: "sc-gif-item",
						title: result.title || "Send GIF",
						on: {
							click: () => {
								opts.onPick({
									url: result.url,
									width: result.width,
									height: result.height,
									title: result.title,
								});
								close();
							},
						},
					},
					h("img", {
						src: result.previewUrl || result.url,
						alt: result.title || "GIF",
						loading: "lazy",
					}),
				),
			),
		);
	};

	const load = (query: string) => {
		const seq = ++requestSeq;
		const apiKey = state.gif.apiKey?.trim() ?? "";
		if (
			!state.gif.enabled ||
			state.gif.provider !== "klipy" ||
			!apiKey ||
			!state.me
		) {
			setStatus(
				warning("GIF search is not configured on this server."),
				text(
					"body",
					"sc-gif-hint",
					{},
					"You can still paste a KLIPY, Tenor or Giphy image link into the message box and send it.",
				),
			);
			return;
		}

		const cacheKey = query || "__trending__";
		const cached = cachedResults(cacheKey);
		if (cached) {
			render(cached);
			return;
		}

		const url = buildKlipyUrl({
			apiKey,
			query,
			page: 1,
			customerId: state.me.id,
		});
		if (!url) {
			setStatus(warning("GIF search is not configured on this server."));
			return;
		}

		setStatus(
			text(
				"body",
				"sc-gif-hint",
				{},
				query ? "Searching…" : "Loading trending GIFs…",
			),
		);

		GM_xmlhttpRequest({
			method: "GET",
			url,
			headers: { Accept: "application/json" },
			timeout: 10_000,
			onload: (response) => {
				if (closed || seq !== requestSeq) return;
				if (response.status < 200 || response.status >= 300) {
					setStatus(warning(`GIF search failed (${response.status}).`));
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(response.responseText);
				} catch {
					setStatus(warning("GIF search returned an invalid response."));
					return;
				}
				const results = mapKlipyResponse(parsed);
				if (!results.length) {
					setStatus(
						text(
							"body",
							"sc-gif-hint",
							{},
							query ? "No GIFs found." : "No trending GIFs right now.",
						),
					);
					return;
				}
				rememberResults(cacheKey, results);
				render(results);
			},
			onerror: () => {
				if (closed || seq !== requestSeq) return;
				setStatus(warning("Could not reach KLIPY. Try again in a moment."));
			},
			ontimeout: () => {
				if (closed || seq !== requestSeq) return;
				setStatus(warning("KLIPY took too long to answer."));
			},
		});
	};

	load("");
	search.input.focus();
	return { el, close };
}

/** True when the typed text is a provider image URL, so it can be sent as a GIF. */
export function gifFromTypedText(value: string): ChatGif | null {
	const textValue = value.trim();
	if (!/^https:\/\//i.test(textValue) || /\s/.test(textValue)) return null;
	return /\.(gif|webp|png|jpe?g)(?:[?#]|$)/i.test(textValue) &&
		/(^|\.)(tenor|giphy|klipy|imgur)\.com/i.test(textValue)
		? { url: textValue, width: 0, height: 0, title: "" }
		: null;
}
