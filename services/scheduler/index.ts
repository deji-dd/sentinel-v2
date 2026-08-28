import {
	closeDatabase,
	ensureTargetGuildConfigs,
	recordBootAlert,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { setupSchedulerIpc } from "./src/lib/ipc";
import { startRegisteredWorkers } from "./src/workers/registry";

const logger = new Logger("Scheduler");

async function main() {
	logger.info("Initializing Sentinel Scheduler...");

	// 1. Auto-provision target guild configs
	await ensureTargetGuildConfigs();

	// 2. Setup & Start IPC Server
	const ipcServer = await setupSchedulerIpc();
	await ipcServer.start();

	// 3. Record boot alert in database
	await recordBootAlert("scheduler");

	// 3. Start registered background workers with staggered boot
	const workerCount = await startRegisteredWorkers();
	logger.info(`${workerCount} registered workers.`);

	// Graceful shutdown handling
	const shutdown = async (signal: string) => {
		logger.warn(`Received ${signal}. Shutting down Scheduler...`);
		await ipcServer.close();
		closeDatabase();
		logger.info("Scheduler shutdown complete.");
		process.exit(0);
	};

	process.on("unhandledRejection", (reason) => {
		logger.error("Unhandled Promise Rejection in Scheduler engine:", reason);
	});

	process.on("uncaughtException", (error) => {
		logger.error("Uncaught Exception in Scheduler engine:", error);
	});

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
	logger.error("Fatal error during Scheduler startup:", err);
	process.exit(1);
});
