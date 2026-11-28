import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

/**
 * Eden Treaty client for the YABA report. Public reads need no session, admin
 * writes rely on the session cookie shared across *.blasted-labs.tech.
 */
export function getApiBaseUrl(): string {
	if (import.meta.env.VITE_API_URL) {
		return import.meta.env.VITE_API_URL;
	}

	if (typeof window !== "undefined") {
		const hostname = window.location.hostname.toLowerCase();
		const isLocal =
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal");

		if (
			!isLocal &&
			(hostname === "blasted-labs.tech" ||
				hostname.endsWith(".blasted-labs.tech"))
		) {
			return "https://api.blasted-labs.tech";
		}

		return window.location.origin;
	}

	return import.meta.env.PROD
		? "https://api.blasted-labs.tech"
		: "http://localhost:3000";
}

export const api = treaty<App>(getApiBaseUrl(), {
	fetch: {
		credentials: "include",
	},
	headers: {
		"X-Client-App": "yaba-dashboard",
	},
});
