import { Logger } from "@sentinel/utils";

export const logger = new Logger("API");

const methodLoggers = new Map<string, Logger>();

/**
 * Returns a child logger instance dedicated to an HTTP method/action (e.g. GET, POST, DELETE, WS).
 */
export function getMethodLogger(method: string): Logger {
	const upper = method.toUpperCase();
	let l = methodLoggers.get(upper);
	if (!l) {
		l = logger.child(upper);
		methodLoggers.set(upper, l);
	}
	return l;
}

export const getLogger = getMethodLogger("GET");
export const postLogger = getMethodLogger("POST");
export const putLogger = getMethodLogger("PUT");
export const deleteLogger = getMethodLogger("DELETE");
export const patchLogger = getMethodLogger("PATCH");
export const wsLogger = getMethodLogger("WS");
