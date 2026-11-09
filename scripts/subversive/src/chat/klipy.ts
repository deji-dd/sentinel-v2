// KLIPY GIF search, called directly from the browser as KLIPY's terms require.
// The app key is delivered by the Sentinel API on the authenticated /me call so
// it is configured once in the server env, not rebuilt into the userscript.
import type { ChatGifResult } from "./protocol";

export const KLIPY_BASE = "https://api.klipy.com/api/v1";
export const KLIPY_PER_PAGE = 24;

export interface KlipyUrlOptions {
	apiKey: string;
	query: string;
	/** 1-based page. */
	page?: number;
	/** Stable per-player id; KLIPY uses it for personalisation/analytics. */
	customerId: number | string;
	locale?: string;
}

/** Builds the KLIPY search (or trending, for an empty query) URL. */
export function buildKlipyUrl(opts: KlipyUrlOptions): string | null {
	const apiKey = opts.apiKey.trim();
	if (!apiKey) return null;
	const query = opts.query.trim().slice(0, 50);
	const endpoint = query ? "search" : "trending";
	const url = new URL(
		`${KLIPY_BASE}/${encodeURIComponent(apiKey)}/gifs/${endpoint}`,
	);
	if (query) url.searchParams.set("q", query);
	url.searchParams.set("page", String(Math.max(1, Math.floor(opts.page ?? 1))));
	url.searchParams.set("per_page", String(KLIPY_PER_PAGE));
	url.searchParams.set("customer_id", String(opts.customerId || "0"));
	url.searchParams.set("locale", opts.locale ?? "en");
	url.searchParams.set("content_filter", "high");
	return url.toString();
}

interface KlipyVariant {
	url?: unknown;
	width?: unknown;
	height?: unknown;
}

interface KlipyFormat {
	gif?: KlipyVariant;
	webp?: KlipyVariant;
	mp4?: KlipyVariant;
}

interface KlipyFile {
	hd?: KlipyFormat;
	md?: KlipyFormat;
	sm?: KlipyFormat;
	xs?: KlipyFormat;
}

interface KlipyItem {
	id?: unknown;
	slug?: unknown;
	title?: unknown;
	file?: KlipyFile;
	content?: unknown;
}

interface KlipyResponse {
	result?: unknown;
	data?: unknown;
}

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

/** KLIPY media is served from klipy.com and its static*.klipy.com mirrors. */
export function isKlipyMediaUrl(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("https://")) return false;
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === "klipy.com" || host.endsWith(".klipy.com");
	} catch {
		return false;
	}
}

function variant(format: KlipyFormat | undefined): {
	url: string;
	width: number;
	height: number;
} | null {
	if (!format) return null;
	for (const candidate of [format.gif, format.webp]) {
		if (!candidate || !isKlipyMediaUrl(candidate.url)) continue;
		const width = Number(candidate.width);
		const height = Number(candidate.height);
		return {
			url: candidate.url,
			width: Number.isFinite(width) && width > 0 ? width : 0,
			height: Number.isFinite(height) && height > 0 ? height : 0,
		};
	}
	return null;
}

/**
 * Maps a KLIPY response to the wire shape. KLIPY returns:
 * `{ result, data: { data: [{ id, slug, title, file: { hd, md, sm, xs } }] } }`
 * where each size has `gif`/`webp`/`mp4` variants. Content-only items (ads) are
 * skipped; they carry no `file`.
 */
export function mapKlipyResponse(raw: unknown): ChatGifResult[] {
	const response = asObject(raw) as KlipyResponse | null;
	if (!response) return [];
	const container = asObject(response.data);
	const items = Array.isArray(response.data)
		? response.data
		: Array.isArray(container?.data)
			? container.data
			: [];
	const out: ChatGifResult[] = [];
	const seen = new Set<string>();

	for (const rawItem of items) {
		const item = asObject(rawItem) as KlipyItem | null;
		const file = item?.file;
		if (!item || !file) continue;

		const full =
			variant(file.hd) ??
			variant(file.md) ??
			variant(file.sm) ??
			variant(file.xs);
		if (!full) continue;
		const preview =
			variant(file.sm)?.url ??
			variant(file.xs)?.url ??
			variant(file.md)?.url ??
			full.url;

		const id =
			typeof item.id === "number" || typeof item.id === "string"
				? String(item.id)
				: typeof item.slug === "string"
					? item.slug
					: full.url;
		if (seen.has(id)) continue;
		seen.add(id);

		out.push({
			id,
			url: full.url,
			previewUrl: preview,
			width: full.width,
			height: full.height,
			title:
				typeof item.title === "string"
					? item.title.slice(0, 120)
					: typeof item.slug === "string"
						? item.slug.slice(0, 120)
						: "",
		});
	}
	return out;
}
