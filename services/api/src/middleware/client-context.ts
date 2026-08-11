import { Elysia } from "elysia";

export type ClientAppType = "bot-dashboard" | "user-dashboard" | "unknown";

/**
 * Client context derive plugin. Identifies which UI app sent the request.
 */
export const clientContextPlugin = new Elysia({
	name: "middleware.clientContext",
}).derive(({ request }) => {
	const origin = request.headers.get("origin") ?? "";
	const host = request.headers.get("host") ?? "";
	const clientHeader = request.headers.get("x-client-app") ?? "";

	let clientApp: ClientAppType = "unknown";

	if (
		clientHeader === "bot-dashboard" ||
		origin.includes("blasted-labs.tech") ||
		host.includes("blasted-labs.tech") ||
		origin.includes("bot-dashboard") ||
		host.startsWith("bot.")
	) {
		clientApp = "bot-dashboard";
	} else if (
		clientHeader === "user-dashboard" ||
		origin.includes("ayodejib.dev") ||
		host.includes("ayodejib.dev") ||
		origin.includes("user-dashboard") ||
		host.startsWith("user.")
	) {
		clientApp = "user-dashboard";
	}

	return {
		clientApp,
	};
});
