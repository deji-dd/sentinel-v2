import { Elysia } from "elysia";
import { serveBlastedUserscript } from "../v2/personal";
import { personalBountiesRoutes } from "../v2/personal-bounties";
import { subversiveRoutes } from "../v2/subversive";
import { subversiveTargetFinderRoutes } from "../v2/subversive-target-finder";

/**
 * Legacy v1 API Route Gateway.
 * All core platform APIs (auth, elims, guilds, merc, tt, system) have been retired and migrated to /v2.
 * This gateway strictly preserves endpoints required by the public Subversive Alliance userscript
 * and legacy Blasted's Script installations to ensure backward compatibility for players with existing browser script installations.
 */
export const v1Routes = new Elysia({ prefix: "/api/v1" })
	// Legacy Blasted's Script update endpoints
	.get(
		"/system/crime-ledger/script",
		async ({ query, set }) => {
			return serveBlastedUserscript(query, set);
		},
		{ detail: { hide: true } },
	)
	.get(
		"/system/crime-ledger/script.user.js",
		async ({ query, set }) => {
			return serveBlastedUserscript(query, set);
		},
		{ detail: { hide: true } },
	)
	// Bounty endpoints called by Subversive userscript
	.use(personalBountiesRoutes)
	// Target finder endpoints called by Subversive userscript
	.use(subversiveTargetFinderRoutes)
	// Backward-compatibility alias for legacy scripts requesting /subversive/target-finder
	.group("/subversive/target-finder", (app) => {
		const forward = ({ request }: { request: Request }): Promise<Response> => {
			const url = new URL(request.url);
			const targetPath = url.pathname.slice(
				url.pathname.indexOf("/target-finder"),
			);
			const targetUrl = new URL(targetPath + url.search, url.origin);
			return subversiveTargetFinderRoutes.handle(
				new Request(targetUrl.toString(), request),
			);
		};

		return app
			.get("", forward, { detail: { hide: true } })
			.get("/*", forward, { detail: { hide: true } })
			.post("", forward, { detail: { hide: true } })
			.post("/*", forward, { detail: { hide: true } })
			.put("", forward, { detail: { hide: true } })
			.put("/*", forward, { detail: { hide: true } })
			.delete("", forward, { detail: { hide: true } })
			.delete("/*", forward, { detail: { hide: true } })
			.patch("", forward, { detail: { hide: true } })
			.patch("/*", forward, { detail: { hide: true } });
	})
	// Backward-compatibility dibs endpoints called by legacy Subversive userscript
	.group("/subversive/dibs", (app) => {
		const forward = ({ request }: { request: Request }): Promise<Response> => {
			const url = new URL(request.url);
			const targetPath = url.pathname.slice(
				url.pathname.indexOf("/subversive"),
			);
			const targetUrl = new URL(targetPath + url.search, url.origin);
			return subversiveRoutes.handle(
				new Request(targetUrl.toString(), request),
			);
		};

		return app
			.post("/claim", forward, { detail: { hide: true } })
			.post("/release", forward, { detail: { hide: true } });
	});
