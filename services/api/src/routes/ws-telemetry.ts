import { Elysia, t } from "elysia";
import { getFleetTelemetry } from "../lib/telemetry";

export const wsTelemetryRoutes = new Elysia().ws("/api/ws/telemetry", {
	body: t.Object({
		type: t.String(),
		timestamp: t.Optional(t.Number()),
	}),
	async open(ws) {
		const fleet = await getFleetTelemetry();
		ws.send({
			type: "snapshot",
			...fleet,
		});
	},
	async message(ws, message) {
		if (message.type === "ping") {
			const fleet = await getFleetTelemetry();
			ws.send({
				type: "pong",
				...fleet,
			});
		} else if (message.type === "refresh") {
			const fleet = await getFleetTelemetry();
			ws.send({
				type: "snapshot",
				...fleet,
			});
		}
	},
});
