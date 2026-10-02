import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

/**
 * Eden Treaty client providing 100% end-to-end TypeScript autocomplete & type safety.
 * In production, requests are routed directly to the dedicated API gateway (https://api.blasted-labs.tech).
 */
function getApiBaseUrl(): string {
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
});
