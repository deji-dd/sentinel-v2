import swagger from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { clientContextPlugin } from "./middleware/client-context";
import { corsPlugin } from "./middleware/cors";
import { requestLoggerPlugin } from "./middleware/request-logger";
import { staticSpaPlugin } from "./middleware/static-spa";
import { healthRoutes } from "./routes/health";
import { pondRoutes } from "./routes/pond";
import { v1Routes } from "./routes/v1";
import { wsBattlestatsLedgerRoutes } from "./routes/ws-battlestats-ledger";
import { wsCrimeLedgerRoutes } from "./routes/ws-crime-ledger";
import { wsGymLedgerRoutes } from "./routes/ws-gym-ledger";
import { wsLogManagerRoutes } from "./routes/ws-log-manager";
import { wsStockLedgerRoutes } from "./routes/ws-stocks-ledger";

export const app = new Elysia()
	.use(corsPlugin)
	.use(clientContextPlugin)
	.use(requestLoggerPlugin)
	.use(
		swagger({
			documentation: {
				info: {
					title: "Sentinel V2 API Documentation",
					version: "2.0.0",
					description:
						"Scalable backend API serving Sentinel V2 UIs and automation services.",
				},
			},
		}),
	)
	.use(healthRoutes)
	.use(wsLogManagerRoutes)
	.use(wsCrimeLedgerRoutes)
	.use(wsBattlestatsLedgerRoutes)
	.use(wsGymLedgerRoutes)
	.use(wsStockLedgerRoutes)
	.use(pondRoutes)
	.use(v1Routes)
	.use(staticSpaPlugin)

	.onError(({ code, error, set }) => {
		if (code === "NOT_FOUND") {
			set.status = 404;
			return {
				success: false,
				error: "Resource not found",
			};
		}

		if (code === "VALIDATION") {
			set.status = 400;
			return {
				success: false,
				error: "Validation failed",
				details: error.message,
			};
		}

		set.status = 500;
		return {
			success: false,
			error: "Internal Server Error",
		};
	});

export type App = typeof app;
