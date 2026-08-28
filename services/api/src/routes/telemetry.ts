import { Elysia, t } from "elysia";
import { getFleetTelemetry, getHistoricalTelemetry } from "../lib/telemetry";

/**
 * GET /api/telemetry — full fleet telemetry snapshot over plain HTTP.
 * GET /api/telemetry/history — historical timeseries for area chart visualizations.
 */
export const telemetryRoutes = new Elysia({ prefix: "/api/telemetry" })
	.get("/", async () => {
		const fleet = await getFleetTelemetry();
		return {
			success: true,
			...fleet,
		};
	})
	.get(
		"/history",
		async ({ query }) => {
			const range = (query.range ?? "24h") as "1h" | "6h" | "24h" | "7d";
			const points = await getHistoricalTelemetry(range);
			return {
				success: true,
				range,
				points,
			};
		},
		{
			query: t.Object({
				range: t.Optional(
					t.Union([
						t.Literal("1h"),
						t.Literal("6h"),
						t.Literal("24h"),
						t.Literal("7d"),
					]),
				),
			}),
		},
	);
