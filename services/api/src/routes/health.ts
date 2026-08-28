import { Elysia, t } from "elysia";

export const healthRoutes = new Elysia({ prefix: "/api/health" }).get(
	"/",
	() => {
		const platformName =
			process.platform === "darwin"
				? "MAC"
				: process.platform === "linux"
					? "LINUX"
					: process.platform.toUpperCase();
		const arch = process.arch.toUpperCase();
		const bunVersion =
			typeof Bun !== "undefined" && Bun.version ? Bun.version : process.version;

		return {
			status: "ok",
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
			environment: process.env.NODE_ENV ?? "development",
			host: `${platformName}-${arch}`,
			platform: process.platform,
			arch: process.arch,
			bunVersion,
		};
	},
	{
		response: t.Object({
			status: t.String(),
			timestamp: t.String(),
			uptime: t.Number(),
			environment: t.String(),
			host: t.String(),
			platform: t.String(),
			arch: t.String(),
			bunVersion: t.String(),
		}),
		detail: {
			summary: "Health Check",
			description:
				"Verifies the operational status of the Sentinel V2 API service.",
		},
	},
);
