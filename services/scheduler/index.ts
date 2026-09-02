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

	// 4. Start lightweight internal healthcheck server
	const healthPort = Number(process.env.SCHEDULER_HEALTH_PORT) || 3001;
	const healthServer = Bun.serve({
		port: healthPort,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health" || url.pathname === "/") {
				return Response.json({
					status: "ok",
					service: "sentinel-scheduler",
					uptime: process.uptime(),
					workerCount,
				});
			}
			return new Response("Not Found", { status: 404 });
		},
	});
	logger.info(`Lightweight healthcheck server listening on port ${healthPort}`);

	// Graceful shutdown handling
	const shutdown = async (signal: string) => {
		logger.warn(`Received ${signal}. Shutting down Scheduler...`);
		healthServer.stop();
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
