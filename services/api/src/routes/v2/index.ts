import { Elysia } from "elysia";

import { authRoutes } from "./auth";
import { capitalRoutes } from "./capital";
import { chatRoutes } from "./chat";
import { elimsRoutes } from "./elims";
import { giveawayRoutes } from "./giveaways";
import { guildRoutes } from "./guilds";
import { mercRoutes } from "./merc";
import { personalRoutes } from "./personal";
import { personalBountiesRoutes } from "./personal-bounties";
import { subversiveRoutes } from "./subversive";
import { subversiveTargetFinderRoutes } from "./subversive-target-finder";
import { systemRoutes } from "./system";
import { ttRoutes } from "./tt";

export {
	authRoutes,
	capitalRoutes,
	chatRoutes,
	elimsRoutes,
	giveawayRoutes,
	guildRoutes,
	mercRoutes,
	personalBountiesRoutes,
	personalRoutes,
	subversiveRoutes,
	subversiveTargetFinderRoutes,
	systemRoutes,
	ttRoutes,
};

export const v2Routes = new Elysia({ prefix: "/v2" })
	.use(authRoutes)
	.use(capitalRoutes)
	.use(chatRoutes)
	.use(elimsRoutes)
	.use(giveawayRoutes)
	.use(guildRoutes)
	.use(mercRoutes)
	.use(personalRoutes)
	.use(personalBountiesRoutes)
	.use(subversiveRoutes)
	.use(subversiveTargetFinderRoutes)
	.use(systemRoutes)
	.use(ttRoutes);
