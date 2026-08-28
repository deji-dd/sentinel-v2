import { Elysia } from "elysia";

export type ClientAppType =
	| "tt-selector"
	| "bot-dashboard"
	| "user-dashboard"
	| "unknown";

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
		clientHeader === "tt-selector" ||
		host.startsWith("tt-selector.blasted-labs.tech") ||
		origin.startsWith("https://tt-selector.blasted-labs.tech")
	) {
		clientApp = "tt-selector";
	} else if (
		clientHeader === "bot-dashboard" ||
		host.startsWith("sentinel.blasted-labs.tech") ||
		origin.startsWith("https://sentinel.blasted-labs.tech")
	) {
		clientApp = "bot-dashboard";
	} else if (
		clientHeader === "user-dashboard" ||
		host.startsWith("sentinel.ayodejib.dev") ||
		origin.startsWith("https://sentinel.ayodejib.dev")
	) {
		clientApp = "user-dashboard";
	}

	return {
		clientApp,
	};
});
