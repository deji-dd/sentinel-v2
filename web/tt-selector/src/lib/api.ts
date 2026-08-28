import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

const API_BASE_URL =
	typeof window !== "undefined"
		? window.location.origin
		: "http://127.0.0.1:3000";

export const api = treaty<App>(API_BASE_URL);
