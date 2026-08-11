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

			if (env.NODE_ENV === "development") {
				return true;
			}

			return env.ALLOWED_ORIGINS.includes(origin);
		},
		credentials: true,
		allowedHeaders: [
			"Content-Type",
			"Authorization",
			"X-Client-App",
			"X-Requested-With",
		],
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);
