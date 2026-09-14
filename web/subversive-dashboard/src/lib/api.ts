import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

/**
 * Eden Treaty client providing full type safety and auto-completion.
 */
export const api = treaty<App>(
	typeof window !== "undefined"
		? window.location.origin
		: "http://localhost:3000",
);
