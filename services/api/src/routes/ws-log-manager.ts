import { db, eq, personalLogs, sql, systemStates } from "@sentinel/database";
import { Elysia, t } from "elysia";

export async function getLogManagerSnapshot() {
	const [stateRecord] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, "personal:log_manager"));

	const [stats] = await db
		.select({
			totalInDb: sql<number>`count(${personalLogs.id})`,
			oldestTimestamp: sql<number>`min(${personalLogs.timestamp})`,
			newestTimestamp: sql<number>`max(${personalLogs.timestamp})`,
		})
		.from(personalLogs);

	const defaultState = {
		status: "idle",
		backfillStatus: "in_progress",
		forwardStatus: "idle",
		totalLogsRecorded: stats?.totalInDb ?? 0,
		backfillLogsCount: 0,
		forwardLogsCount: 0,
		oldestTimestampReached: stats?.oldestTimestamp ?? null,
		newestTimestampReached: stats?.newestTimestamp ?? null,
		lastForwardCheckedAt: null,
		lastBackfillCheckedAt: null,
		lastError: null,
		lastSyncDurationMs: null,
		updatedAt: new Date().toISOString(),
	};

	const state = stateRecord?.data
		? { ...defaultState, ...(stateRecord.data as Record<string, unknown>) }
		: defaultState;

	return {
		type: "state_snapshot",
		state: {
			...state,
			totalInDb: stats?.totalInDb ?? 0,
			dbOldestDate: stats?.oldestTimestamp
				? new Date(stats.oldestTimestamp * 1000).toISOString()
				: null,
			dbNewestDate: stats?.newestTimestamp
				? new Date(stats.newestTimestamp * 1000).toISOString()
				: null,
		},
	};
}

export const wsLogManagerRoutes = new Elysia().ws("/api/ws/log-manager", {
	body: t.Object({
		type: t.String(),
		timestamp: t.Optional(t.Number()),
	}),
	async open(ws) {
		const snapshot = await getLogManagerSnapshot();
		ws.send(snapshot);
	},
	async message(ws, message) {
		if (message.type === "ping") {
			ws.send({
				type: "pong",
				timestamp: message.timestamp ?? Date.now(),
			});
		} else if (message.type === "refresh") {
			const snapshot = await getLogManagerSnapshot();
			ws.send(snapshot);
		}
	},
});
