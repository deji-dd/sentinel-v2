import {
	db,
	desc,
	deviceControls,
	eq,
	sensorReadings,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { Elysia, t } from "elysia";

const logger = new Logger("API", "Pond");

export const pondRoutes = new Elysia({ prefix: "/pond" })
	.post(
		"/data",
		async ({ body, set }) => {
			try {
				const [reading] = await db
					.insert(sensorReadings)
					.values({
						deviceId: body.device_id,
						temperatureC: body.temperature_c,
						ph: body.ph,
						turbidityNtu: body.turbidity_ntu,
						pondLevelPct: body.pond_level_pct,
						pumpInActive: body.pump_in_active,
						pumpDrainActive: body.pump_drain_active,
					})
					.returning({ id: sensorReadings.id });

				if (!reading) {
					set.status = 500;
					return {
						error: "InternalServerError",
						message: "Failed to save reading",
					};
				}

				set.status = 201;
				return { success: true, id: reading.id };
			} catch (error) {
				logger.error("Failed to save sensor reading:", error);
				set.status = 500;
				return {
					error: "InternalServerError",
					message: "Failed to save reading",
				};
			}
		},
		{
			body: t.Object({
				device_id: t.String(),
				temperature_c: t.Number(),
				ph: t.Number(),
				turbidity_ntu: t.Number(),
				pond_level_pct: t.Number(),
				pump_in_active: t.Boolean(),
				pump_drain_active: t.Boolean(),
			}),
			response: {
				201: t.Object({
					success: t.Boolean(),
					id: t.String(),
				}),
				500: t.Object({
					error: t.String(),
					message: t.String(),
				}),
			},
			detail: {
				summary: "Ingest Sensor Data",
				description: "ESP32 pushes IoT sensor data reading",
			},
		},
	)
	.get(
		"/data/:deviceId",
		async ({ params: { deviceId }, set }) => {
			try {
				const readings = await db
					.select()
					.from(sensorReadings)
					.where(eq(sensorReadings.deviceId, deviceId))
					.orderBy(desc(sensorReadings.createdAt))
					.limit(100);

				return readings.reverse();
			} catch (error) {
				logger.error("Failed to fetch history:", error);
				set.status = 500;
				return {
					error: "InternalServerError",
					message: "Failed to fetch history",
				};
			}
		},
		{
			params: t.Object({
				deviceId: t.String(),
			}),
			detail: {
				summary: "Fetch Sensor History",
				description: "Fetch last 100 historical readings for a device",
			},
		},
	)
	.get(
		"/control/:deviceId",
		async ({ params: { deviceId }, set }) => {
			try {
				let [controlState] = await db
					.select()
					.from(deviceControls)
					.where(eq(deviceControls.deviceId, deviceId))
					.limit(1);

				if (!controlState) {
					[controlState] = await db
						.insert(deviceControls)
						.values({ deviceId })
						.onConflictDoNothing()
						.returning();

					if (!controlState) {
						[controlState] = await db
							.select()
							.from(deviceControls)
							.where(eq(deviceControls.deviceId, deviceId))
							.limit(1);
					}
				}

				return {
					manual_mode: controlState?.manualMode ?? false,
					pump_in: controlState?.pumpIn ?? false,
					pump_drain: controlState?.pumpDrain ?? false,
					simulate_breach: controlState?.simulateBreach ?? false,
				};
			} catch (error) {
				logger.error("Failed to fetch control state:", error);
				set.status = 500;
				return {
					error: "InternalServerError",
					message: "Failed to fetch control state",
				};
			}
		},
		{
			params: t.Object({
				deviceId: t.String(),
			}),
			response: {
				200: t.Object({
					manual_mode: t.Boolean(),
					pump_in: t.Boolean(),
					pump_drain: t.Boolean(),
					simulate_breach: t.Boolean(),
				}),
				500: t.Object({
					error: t.String(),
					message: t.String(),
				}),
			},
			detail: {
				summary: "Fetch ESP32 Control State",
				description: "ESP32 checks if it should activate pumps or breach",
			},
		},
	)
	.post(
		"/control/:deviceId",
		async ({ params: { deviceId }, body, set }) => {
			try {
				const [updatedState] = await db
					.insert(deviceControls)
					.values({
						deviceId,
						manualMode: body.manual_mode,
						pumpIn: body.pump_in,
						pumpDrain: body.pump_drain,
						simulateBreach: body.simulate_breach,
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: deviceControls.deviceId,
						set: {
							manualMode: body.manual_mode,
							pumpIn: body.pump_in,
							pumpDrain: body.pump_drain,
							simulateBreach: body.simulate_breach,
							updatedAt: new Date(),
						},
					})
					.returning();

				if (!updatedState) {
					set.status = 500;
					return {
						error: "InternalServerError",
						message: "Failed to update control state",
					};
				}

				return { success: true, state: updatedState };
			} catch (error) {
				logger.error("Failed to update control state:", error);
				set.status = 500;
				return {
					error: "InternalServerError",
					message: "Failed to update control state",
				};
			}
		},
		{
			params: t.Object({
				deviceId: t.String(),
			}),
			body: t.Object({
				manual_mode: t.Boolean(),
				pump_in: t.Boolean(),
				pump_drain: t.Boolean(),
				simulate_breach: t.Boolean(),
			}),
			detail: {
				summary: "Update Control State",
				description: "UI sends commands to update ESP32 control state",
			},
		},
	);
