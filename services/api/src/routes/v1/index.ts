import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { guildRoutes } from "./guilds";

export const v1Routes = new Elysia({ prefix: "/api/v1" })
	.use(authRoutes)
	.use(guildRoutes);
