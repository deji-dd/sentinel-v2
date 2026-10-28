import type { Elysia } from "elysia";

import { getMethodLogger } from "../lib/logger";

/**
 * Endpoints polled by the userscript/HUD. Logging every healthy poll at INFO
 * floods the log once a few dozen clients are online, so these are only logged
 * when they are slow or fail. Everything else keeps the normal INFO line.
 */
const POLL_PATHS = new Set([
	"/v2/target-finder/war/status",
	"/v2/target-finder/war/events",
	"/v2/target-finder/war/targets/available",
	"/v2/target-finder/war/hospital-queue",
	"/v2/personal/bounties",
]);

/** Requests slower than this are always logged, even on polling endpoints. */
const SLOW_REQUEST_MS = 1000;

/**
 * `/war/events` is a long poll that is deliberately held open for up to 25s,
 * so its "slow" threshold has to be above that or every healthy poll logs.
 */
const POLL_SLOW_REQUEST_MS = new Map([
	["/v2/target-finder/war/events", 35_000],
]);

function normalizePath(pathname: string): string {
	return pathname.length > 1 && pathname.endsWith("/")
		? pathname.slice(0, -1)
		: pathname;
}

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
		.onAfterHandle(({ request, store, set }) => {
			const startTime = (store as Record<string, unknown>).startTime as
				number | undefined;
			const duration = startTime
				? Math.round(performance.now() - startTime)
				: 0;
			const pathname = new URL(request.url).pathname;
			const methodLog = getMethodLogger(request.method);
			const message = `${pathname} (${duration}ms)`;

			const status = set.status;
			// A string status is an Elysia status name (e.g. "Unauthorized"),
			// which always represents an error response.
			const failed =
				typeof status === "string" ||
				(typeof status === "number" && status >= 400);
			const pollPath = normalizePath(pathname);
			const isHealthyPoll =
				!failed &&
				duration < (POLL_SLOW_REQUEST_MS.get(pollPath) ?? SLOW_REQUEST_MS) &&
				POLL_PATHS.has(pollPath);

			if (isHealthyPoll) {
				// `debug` is suppressed in production.
				methodLog.debug(message);
			} else {
				methodLog.info(message);
			}
		});
