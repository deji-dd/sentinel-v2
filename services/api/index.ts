import { ensureTargetGuildConfigs, recordBootAlert } from "@sentinel/database";
import { app } from "./src/app";
import { env } from "./src/config/env";
import { logger } from "./src/lib/logger";
import { initSchedulerIpcListener } from "./src/lib/scheduler-ipc";

await ensureTargetGuildConfigs();
await recordBootAlert("api");
initSchedulerIpcListener();

app.listen(env.PORT, () => {
	logger.info(
		`Server running at http://${app.server?.hostname}:${app.server?.port}`,
	);
	logger.info(
		`Swagger Documentation available at http://${app.server?.hostname}:${app.server?.port}/swagger`,
	);
});

const shutdown = (signal: string) => {
	logger.info(`Received ${signal}. Gracefully stopping server...`);
	app.stop();
	process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export type { App } from "./src/app";
