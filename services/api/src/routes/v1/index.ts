import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { elimsRoutes } from "./elims";
import { giveawayRoutes } from "./giveaways";
import { guildRoutes } from "./guilds";
import { personalBountiesRoutes } from "./personal-bounties";
import { subversiveRoutes } from "./subversive";
import { subversiveTargetFinderRoutes } from "./subversive-target-finder";
import { systemRoutes } from "./system";
import { ttRoutes } from "./tt";

export const v1Routes = new Elysia({ prefix: "/api/v1" })
	.use(authRoutes)
	.use(elimsRoutes)
	.use(giveawayRoutes)
	.use(guildRoutes)
	.use(personalBountiesRoutes)
	.use(subversiveRoutes)
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
	.use(systemRoutes)
	.use(ttRoutes);
