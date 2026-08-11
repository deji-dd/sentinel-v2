import { Elysia, t } from "elysia";

export const healthRoutes = new Elysia({ prefix: "/api/health" }).get(
	"/",
	() => {
		return {
			status: "ok",
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
			environment: process.env.NODE_ENV ?? "development",
		};
	},
	{
		response: t.Object({
			status: t.String(),
			timestamp: t.String(),
			uptime: t.Number(),
			environment: t.String(),
		}),
		detail: {
			summary: "Health Check",
			description:
				"Verifies the operational status of the Sentinel V2 API service.",
		},
	},
);
