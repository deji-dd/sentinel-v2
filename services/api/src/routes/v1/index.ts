import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { guildRoutes } from "./guilds";
import { systemRoutes } from "./system";
import { ttRoutes } from "./tt";

export const v1Routes = new Elysia({ prefix: "/api/v1" })
	.use(authRoutes)
	.use(guildRoutes)
	.use(systemRoutes)
	.use(ttRoutes);
