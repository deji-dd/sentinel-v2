import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	db,
	desc,
	deviceControls,
	eq,
	sensorReadings,
} from "@sentinel/database";
import { executePondSimulation } from "../src/workers/fyp/pond-simulation";

describe("Pond Simulation Worker", () => {
	const DEVICE_ID = "pond_01";

	beforeEach(async () => {
		// Reset test device controls & readings for pond_01
		await db
			.delete(deviceControls)
			.where(eq(deviceControls.deviceId, DEVICE_ID));
		await db
			.delete(sensorReadings)
			.where(eq(sensorReadings.deviceId, DEVICE_ID));
	});

	afterEach(async () => {
		await db
			.delete(deviceControls)
			.where(eq(deviceControls.deviceId, DEVICE_ID));
		await db
			.delete(sensorReadings)
			.where(eq(sensorReadings.deviceId, DEVICE_ID));
	});

	test("injects simulated data point when no recent telemetry exists", async () => {
		await executePondSimulation();

		const latest = await db.query.sensorReadings.findFirst({
			where: eq(sensorReadings.deviceId, DEVICE_ID),
			orderBy: [desc(sensorReadings.createdAt)],
		});

		expect(latest).toBeDefined();
		if (latest) {
			expect(latest.temperatureC).toBeGreaterThanOrEqual(20);
			expect(latest.ph).toBeGreaterThanOrEqual(6);
			expect(latest.pondLevelPct).toBe(100);
		}
	});

	test("injects critical danger metrics when breach simulation mode is active", async () => {
		await db.insert(deviceControls).values({
			deviceId: DEVICE_ID,
			simulateBreach: true,
			manualMode: true,
			pumpIn: true,
			pumpDrain: false,
		});

		await executePondSimulation();

		const latest = await db.query.sensorReadings.findFirst({
			where: eq(sensorReadings.deviceId, DEVICE_ID),
			orderBy: [desc(sensorReadings.createdAt)],
		});

		expect(latest).toBeDefined();
		if (latest) {
			expect(latest.temperatureC).toBeGreaterThanOrEqual(44.0);
			expect(latest.ph).toBeLessThanOrEqual(4.0);
			expect(latest.pondLevelPct).toBe(10);
			expect(latest.pumpInActive).toBe(true);
			expect(latest.pumpDrainActive).toBe(false);
		}
	});

	test("skips simulation if live telemetry is fresh (< 2 minutes old)", async () => {
		// Insert fresh reading right now
		await db.insert(sensorReadings).values({
			deviceId: DEVICE_ID,
			temperatureC: 25.0,
			ph: 7.2,
			turbidityNtu: 10.0,
			pondLevelPct: 100,
			pumpInActive: false,
			pumpDrainActive: false,
			createdAt: new Date(),
		});

		const countBefore = (
			await db.query.sensorReadings.findMany({
				where: eq(sensorReadings.deviceId, DEVICE_ID),
			})
		).length;

		await executePondSimulation();

		const countAfter = (
			await db.query.sensorReadings.findMany({
				where: eq(sensorReadings.deviceId, DEVICE_ID),
			})
		).length;

		expect(countAfter).toBe(countBefore);
	});
});
