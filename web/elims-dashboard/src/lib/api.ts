import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

/**
 * Eden Treaty client providing 100% end-to-end TypeScript autocomplete & type safety.
 * Connects to the same origin as the serving API (or local dev proxy).
 */
export const api = treaty<App>(
	typeof window !== "undefined"
		? window.location.origin
		: "http://localhost:3000",
);
