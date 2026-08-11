import {
	db,
	desc,
	deviceControls,
	eq,
	sensorReadings,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "fyp:pond_simulation";
const logger = new Logger(WORKER_NAME);
const DEVICE_ID = "pond_01";
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Applies a bounded random walk step to generate realistic metric fluctuations.
 */
function randomWalk(
	current: number,
	min: number,
	max: number,
	maxStep: number,
	decimals = 1,
): number {
	const delta = (Math.random() * 2 - 1) * maxStep;
	const next = Math.max(min, Math.min(max, current + delta));
	return Number(next.toFixed(decimals));
}

export async function executePondSimulation(): Promise<void> {
	const finishSync = logger.time();

	try {
		// Fetch both the last reading AND the current control state via Drizzle
		const [lastReading, controlState] = await Promise.all([
			db.query.sensorReadings.findFirst({
				where: eq(sensorReadings.deviceId, DEVICE_ID),
				orderBy: [desc(sensorReadings.createdAt)],
			}),
			db.query.deviceControls.findFirst({
				where: eq(deviceControls.deviceId, DEVICE_ID),
			}),
		]);

		const now = new Date();

		// Skip simulation if live telemetry came in within the last 2 minutes
		if (
			lastReading &&
			now.getTime() - lastReading.createdAt.getTime() < STALE_THRESHOLD_MS
		) {
			finishSync();
			return;
		}

		logger.info(
			`No live telemetry for ${DEVICE_ID} in last 2m. Injecting simulated data point...`,
		);

		let simulatedTemp: number;
		let simulatedPh: number;
		let simulatedTurb: number;
		const isBreachActive = controlState?.simulateBreach ?? false;

		if (isBreachActive) {
			// 🚨 BREACH MODE: Inject highly dangerous values with slight jitter to look real
			simulatedTemp = Number((45.0 + Math.random() * 2).toFixed(1));
			simulatedPh = Number((3.0 + Math.random() * 0.5).toFixed(2));
			simulatedTurb = Number((95.0 + Math.random() * 4).toFixed(1));
			logger.warn(
				"BREACH SIMULATION ACTIVE: Injecting critical danger metrics.",
			);
		} else {
			// 🌊 NORMAL MODE: Standard random walk around baseline
			const baseTemp = lastReading ? lastReading.temperatureC : 24.5;
			const basePh = lastReading ? lastReading.ph : 7.2;
			const baseTurb = lastReading ? lastReading.turbidityNtu : 12.0;

			simulatedTemp = randomWalk(baseTemp, 21.0, 28.5, 0.2, 1);
			simulatedPh = randomWalk(basePh, 6.8, 7.8, 0.05, 2);
			simulatedTurb = randomWalk(baseTurb, 5.0, 25.0, 0.5, 1);
		}

		const isManual = controlState?.manualMode ?? false;
		const simPumpIn = isManual ? (controlState?.pumpIn ?? false) : false;
		const simPumpDrain = isManual ? (controlState?.pumpDrain ?? false) : false;

		await db.insert(sensorReadings).values({
			deviceId: DEVICE_ID,
			temperatureC: simulatedTemp,
			ph: simulatedPh,
			turbidityNtu: simulatedTurb,
			pondLevelPct: isBreachActive ? 10 : 100,
			pumpInActive: simPumpIn,
			pumpDrainActive: simPumpDrain,
			createdAt: now,
		});

		logger.info(
			`Simulated data injected: Temp=${simulatedTemp}°C | pH=${simulatedPh} | Turbidity=${simulatedTurb} NTU | Pumps: [In: ${simPumpIn}, Drain: ${simPumpDrain}]`,
		);
		finishSync();
	} catch (error) {
		logger.error("Error executing pond simulation worker:", error);
	}
}

/**
 * Starts the periodic Pond Simulation worker.
 */
export function startPondSimulation(options?: WorkerStartOptions): void {
	const SIXTY_SECONDS = 60;

	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: SIXTY_SECONDS,
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await executePondSimulation();
		},
	});
}
