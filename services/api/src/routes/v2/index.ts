import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { elimsRoutes } from "./elims";
import { giveawayRoutes } from "./giveaways";
import { guildRoutes } from "./guilds";
import { mercRoutes } from "./merc";
import { personalBountiesRoutes } from "./personal-bounties";
import { subversiveRoutes } from "./subversive";
import { subversiveTargetFinderRoutes } from "./subversive-target-finder";
import { systemRoutes } from "./system";
import { ttRoutes } from "./tt";

export {
	authRoutes,
	elimsRoutes,
	giveawayRoutes,
	guildRoutes,
	mercRoutes,
	personalBountiesRoutes,
	subversiveRoutes,
	subversiveTargetFinderRoutes,
	systemRoutes,
	ttRoutes,
};

export const v2Routes = new Elysia({ prefix: "/v2" })
	.use(authRoutes)
	.use(elimsRoutes)
	.use(giveawayRoutes)
	.use(guildRoutes)
	.use(mercRoutes)
	.use(personalBountiesRoutes)
	.use(subversiveRoutes)
	.use(subversiveTargetFinderRoutes)
	.use(systemRoutes)
	.use(ttRoutes);
