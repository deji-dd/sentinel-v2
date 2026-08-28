import { Elysia, t } from "elysia";
import { getBattlestatsLedgerStateObject } from "./v1/battlestats-ledger";

export async function getBattlestatsLedgerSnapshot() {
	const state = await getBattlestatsLedgerStateObject();
	return {
		type: "state_snapshot",
		state,
	};
}

export const getGymLedgerSnapshot = getBattlestatsLedgerSnapshot;

const activeSockets = new Set<{ send: (msg: unknown) => void }>();

export function broadcastBattlestatsLedgerState(
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

export const broadcastGymLedgerState = broadcastBattlestatsLedgerState;

export const wsBattlestatsLedgerRoutes = new Elysia()
	.ws("/api/ws/battlestats-ledger", {
		body: t.Object({
			type: t.String(),
			timestamp: t.Optional(t.Number()),
		}),
		async open(ws) {
			activeSockets.add(ws);
			const snapshot = await getBattlestatsLedgerSnapshot();
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
				const snapshot = await getBattlestatsLedgerSnapshot();
				ws.send(snapshot);
			}
		},
	})
	.ws("/api/ws/gym-ledger", {
		body: t.Object({
			type: t.String(),
			timestamp: t.Optional(t.Number()),
		}),
		async open(ws) {
			activeSockets.add(ws);
			const snapshot = await getBattlestatsLedgerSnapshot();
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
				const snapshot = await getBattlestatsLedgerSnapshot();
				ws.send(snapshot);
			}
		},
	});

export const wsGymLedgerRoutes = wsBattlestatsLedgerRoutes;
