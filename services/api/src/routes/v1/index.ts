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
	.group("/subversive", (app) => app.use(subversiveTargetFinderRoutes))
	.use(systemRoutes)
	.use(ttRoutes);
