import { Elysia, t } from "elysia";
import { getStockLedgerStateObject } from "./v1/stock-ledger";

export async function getStockLedgerSnapshot(scope = "active") {
	const state = await getStockLedgerStateObject(scope);
	return {
		type: "state_snapshot",
		state,
	};
}

const activeSockets = new Set<{ send: (msg: unknown) => void }>();

export function broadcastStockLedgerState(
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

export const wsStockLedgerRoutes = new Elysia().ws("/api/ws/stocks-ledger", {
	body: t.Object({
		type: t.String(),
		scope: t.Optional(t.String()),
		timestamp: t.Optional(t.Number()),
	}),
	async open(ws) {
		activeSockets.add(ws);
		const snapshot = await getStockLedgerSnapshot("active");
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
		} else if (message.type === "refresh" || message.type === "set_scope") {
			const snapshot = await getStockLedgerSnapshot(message.scope ?? "active");
			ws.send(snapshot);
		}
	},
});
