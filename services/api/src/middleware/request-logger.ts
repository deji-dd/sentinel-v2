import type { Elysia } from "elysia";
import { getMethodLogger } from "../lib/logger";

/**
 * Request logger plugin function.
 * Attaches onRequest and onAfterHandle hooks directly to the app pipeline.
 * Example output: [8/8/2026, 8:05:27 AM] [INFO] [API] [GET] /api/v1/auth/me (2ms)
 */
export const requestLoggerPlugin = (app: Elysia) =>
	app
		.onRequest(({ store }) => {
			(store as Record<string, unknown>).startTime = performance.now();
		})
		.onAfterHandle(({ request, store }) => {
			const startTime = (store as Record<string, unknown>).startTime as
				| number
				| undefined;
			const duration = startTime
				? Math.round(performance.now() - startTime)
				: 0;
			const pathname = new URL(request.url).pathname;
			const methodLog = getMethodLogger(request.method);
			methodLog.info(`${pathname} (${duration}ms)`);
		});
