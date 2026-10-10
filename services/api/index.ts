import { ensureTargetGuildConfigs, recordBootAlert } from "@sentinel/database";
import { app } from "./src/app";
import { env } from "./src/config/env";
import { subversiveDibsManager } from "./src/lib/dibs-manager";
import { logger } from "./src/lib/logger";
import { initSchedulerIpcListener } from "./src/lib/scheduler-ipc";

await ensureTargetGuildConfigs();
await recordBootAlert("api");

// The dibs board is held in RAM for the 1-second evaluation loop, so restore the
// persisted board — claims included — before the scheduler's first war snapshot
// arrives. Without this a redeploy released every held dibs, and the channel
// sweep then deleted those members' callouts as orphans.
await subversiveDibsManager.hydrateFromStore();

initSchedulerIpcListener();

app.listen(env.PORT, () => {
	logger.info(
		`Server running at http://${app.server?.hostname}:${app.server?.port}`,
	);
	logger.info(
		`Swagger Documentation available at http://${app.server?.hostname}:${app.server?.port}/swagger`,
	);
});

const shutdown = async (signal: string) => {
	logger.info(`Received ${signal}. Gracefully stopping server...`);

	// Flush the dibs board on the way out: a redeploy sends SIGTERM, and writes
	// are coalesced, so the last few seconds of claims would otherwise be lost.
	try {
		await subversiveDibsManager.flushPersist();
	} catch (err) {
		logger.warn("Failed to persist dibs board during shutdown:", err);
	}

	app.stop();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export type { App } from "./src/app";
