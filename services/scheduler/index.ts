import {
	closeDatabase,
	ensureTargetGuildConfigs,
	recordBootAlert,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { setupSchedulerIpc } from "./src/lib/ipc";
import { getAllRunnerStatuses, stopAllRunners } from "./src/lib/scheduler";
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

	// 4. Start registered background workers with staggered boot
	const workerCount = await startRegisteredWorkers();
	logger.info(`${workerCount} registered workers.`);

	// 5. Start lightweight internal healthcheck server with telemetry
	const healthPort = Number(process.env.SCHEDULER_HEALTH_PORT) || 3001;
	const healthServer = Bun.serve({
		port: healthPort,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health" || url.pathname === "/") {
				const runners = getAllRunnerStatuses();
				const hasFailures = runners.some((r) => r.consecutiveFailures > 0);
				return Response.json({
					status: hasFailures ? "degraded" : "ok",
					service: "sentinel-scheduler",
					uptime: process.uptime(),
					workerCount,
					activeRunnersCount: runners.length,
					runners: runners.map((r) => ({
						worker: r.worker,
						schedule: r.schedule,
						isExecuting: r.isExecuting,
						consecutiveFailures: r.consecutiveFailures,
						lastError: r.lastError,
						lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
						lastSuccessAt: r.lastSuccessAt
							? new Date(r.lastSuccessAt).toISOString()
							: null,
						nextRunAt: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : null,
					})),
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
		await stopAllRunners();
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
