import cors from "@elysiajs/cors";
import { Elysia } from "elysia";
import { env } from "../config/env";

/**
 * Scalable CORS plugin supporting multiple UI domains / origins.
 */
export const corsPlugin = new Elysia({ name: "middleware.cors" }).use(
	cors({
		origin: (request: Request): boolean => {
			const origin = request.headers.get("origin");
			if (!origin) return true; // Allow non-browser / server-to-server calls

			let url: URL;
			try {
				url = new URL(origin);
			} catch {
				return false;
			}

			if (url.hostname === "sentinel.ayodejib.dev") {
				return false;
			}

			if (env.NODE_ENV === "development") {
				return true;
			}

			if (env.ALLOWED_ORIGINS.includes(origin)) {
				return true;
			}

			if (
				url.hostname === "blasted-labs.tech" ||
				url.hostname.endsWith(".blasted-labs.tech") ||
				url.hostname === "ayodejib.dev" ||
				url.hostname.endsWith(".ayodejib.dev")
			) {
				return true;
			}

			return false;
		},
		credentials: true,
		allowedHeaders: [
			"Content-Type",
			"Authorization",
			"X-Client-App",
			"X-Requested-With",
			"X-Api-Key",
		],
		exposeHeaders: ["Content-Disposition", "Content-Type"],
		maxAge: 86400,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);
