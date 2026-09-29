import { Elysia } from "elysia";

export type ClientAppType =
	| "tt-selector"
	| "bot-dashboard"
	| "elims-dashboard"
	| "subversive-dashboard"
	| "blasted-script"
	| "unknown";

/**
 * Client context derive plugin. Identifies which UI app sent the request
 * and enforces domain access restrictions.
 */
export const clientContextPlugin = new Elysia({
	name: "middleware.clientContext",
})
	.onBeforeHandle({ as: "global" }, ({ request, set }) => {
		const host = request.headers.get("host") ?? "";
		const forwardedHost = request.headers.get("x-forwarded-host") ?? "";
		const origin = request.headers.get("origin") ?? "";

		let urlHost = "";
		try {
			urlHost = new URL(request.url).hostname.toLowerCase();
		} catch {
			// Ignore invalid URL
		}

		if (
			host.toLowerCase().startsWith("sentinel.ayodejib.dev") ||
			forwardedHost.toLowerCase().startsWith("sentinel.ayodejib.dev") ||
			origin.toLowerCase().startsWith("https://sentinel.ayodejib.dev") ||
			urlHost === "sentinel.ayodejib.dev"
		) {
			set.status = 404;
			return {
				success: false,
				error: "Domain not found",
			};
		}
	})
	.derive(({ request }) => {
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
			clientHeader === "elims-dashboard" ||
			host.startsWith("elims.blasted-labs.tech") ||
			origin.startsWith("https://api.elims.blasted-labs.tech") ||
			origin.startsWith("https://elims.blasted-labs.tech")
		) {
			clientApp = "elims-dashboard";
		} else if (
			clientHeader === "subversive-dashboard" ||
			host.startsWith("subversive.blasted-labs.tech") ||
			origin.startsWith("https://subversive.blasted-labs.tech")
		) {
			clientApp = "subversive-dashboard";
		} else if (clientHeader === "blasted-script") {
			clientApp = "blasted-script";
		}

		return {
			clientApp,
		};
	});
