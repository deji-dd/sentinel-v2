import { Elysia, t } from "elysia";
import { getCrimeLedgerStateObject } from "./v1/crime-ledger";

export async function getCrimeLedgerSnapshot() {
	const state = await getCrimeLedgerStateObject();
	return {
		type: "state_snapshot",
		state,
	};
}

const activeSockets = new Set<{ send: (msg: unknown) => void }>();

export function broadcastCrimeLedgerState(
	state: Record<string, unknown>,
): void {
	const payload = {
		type: "state_update",
		state,
	};
	for (const ws of activeSockets) {
		try {
			ws.send(payload);
		} catch {
			activeSockets.delete(ws);
		}
	}
}

export const wsCrimeLedgerRoutes = new Elysia().ws("/api/ws/crime-ledger", {
	body: t.Object({
		type: t.String(),
		timestamp: t.Optional(t.Number()),
	}),
	async open(ws) {
		activeSockets.add(ws);
		const snapshot = await getCrimeLedgerSnapshot();
		ws.send(snapshot);
	},
	close(ws) {
		activeSockets.delete(ws);
	},
	async message(ws, message) {
		if (message.type === "ping") {
			ws.send({
				type: "pong",
				timestamp: message.timestamp ?? Date.now(),
			});
		} else if (message.type === "refresh") {
			const snapshot = await getCrimeLedgerSnapshot();
			ws.send(snapshot);
		}
	},
});
