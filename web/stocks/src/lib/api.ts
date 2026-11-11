import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

function getApiBaseUrl(): string {
	if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
	if (typeof window !== "undefined") {
		const hostname = window.location.hostname.toLowerCase();
		const isLocal =
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal");
		if (!isLocal && hostname.endsWith(".blasted-labs.tech")) {
			return "https://api.blasted-labs.tech";
		}
		return window.location.origin;
	}
	return import.meta.env.PROD
		? "https://api.blasted-labs.tech"
		: "http://localhost:3000";
}

export const apiBaseUrl = getApiBaseUrl();

export const api = treaty<App>(apiBaseUrl, {
	fetch: { credentials: "include" },
});

/** Small typed JSON helper for endpoints whose dynamic Eden path is awkward. */
export async function apiFetch<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const url = `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
	const response = await fetch(url, {
		...init,
		credentials: "include",
		headers: {
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	if (!response.ok) {
		const message =
			body && typeof body === "object" && "error" in body
				? String((body as { error: unknown }).error)
				: `Request failed (${response.status})`;
		throw new Error(message);
	}
	return body as T;
}

export function money(value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === "") return "—";
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return "—";
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(parsed);
}

export function compactMoney(
	value: string | number | null | undefined,
): string {
	if (value === null || value === undefined || value === "") return "—";
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return "—";
	const abs = Math.abs(parsed);
	if (abs >= 1e12) return `$${(parsed / 1e12).toFixed(2)}T`;
	if (abs >= 1e9) return `$${(parsed / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `$${(parsed / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `$${(parsed / 1e3).toFixed(2)}K`;
	return money(parsed);
}

export function pct(value: number | null | undefined, digits = 2): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return `${value.toFixed(digits)}%`;
}

export function isoDate(value: string | null | undefined): string {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		? date.toLocaleString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
			})
		: "—";
}
