import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { elimsRoutes } from "./elims";
import { giveawayRoutes } from "./giveaways";
import { guildRoutes } from "./guilds";
import { subversiveRoutes } from "./subversive";
import { systemRoutes } from "./system";
import { ttRoutes } from "./tt";

export const v1Routes = new Elysia({ prefix: "/api/v1" })
	.use(authRoutes)
	.use(elimsRoutes)
	.use(giveawayRoutes)
	.use(guildRoutes)
	.use(subversiveRoutes)
	.use(systemRoutes)
	.use(ttRoutes);
