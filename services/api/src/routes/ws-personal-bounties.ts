import { Elysia, t } from "elysia";
import {
	getBountyStateObject,
	type PersonalBountyState,
	toClientTarget,
} from "./v1/personal-bounties";

export async function getPersonalBountiesSnapshot() {
	const state = await getBountyStateObject();
	const nowSec = Math.floor(Date.now() / 1000);

	const readyTargets = state.readyTargets.map(toClientTarget);
	const hospitalQueue = state.hospitalQueue
		.map((t) => {
			const until = t.status?.until ?? nowSec;
			return {
				...toClientTarget(t),
				secondsRemaining: Math.max(0, until - nowSec),
			};
		})
		.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

	return {
		type: "state_snapshot",
		readyTargets,
		hospitalQueue,
		lastSyncTimestamp: state.lastSyncTimestamp,
		totalCount: readyTargets.length + hospitalQueue.length,
		pendingCount: state.pendingCount ?? 0,
	};
}

const activeSockets = new Set<{ send: (msg: unknown) => void }>();

export function broadcastPersonalBountiesState(
	state: Partial<PersonalBountyState>,
): void {
	const nowSec = Math.floor(Date.now() / 1000);
	const rawReady = Array.isArray(state.readyTargets) ? state.readyTargets : [];
	const rawHosp = Array.isArray(state.hospitalQueue) ? state.hospitalQueue : [];

	const readyTargets = rawReady.map(toClientTarget);
	const hospitalQueue = rawHosp
		.map((t) => {
			const until = t.status?.until ?? nowSec;
			return {
				...toClientTarget(t),
				secondsRemaining: Math.max(0, until - nowSec),
			};
		})
		.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

	const payload = {
		type: "state_update",
		readyTargets,
		hospitalQueue,
		lastSyncTimestamp: Number(state.lastSyncTimestamp ?? nowSec),
		totalCount: readyTargets.length + hospitalQueue.length,
		pendingCount: Number(state.pendingCount ?? 0),
	};

	for (const ws of activeSockets) {
		try {
			ws.send(payload);
		} catch {
			activeSockets.delete(ws);
		}
	}
}

export function getActivePersonalBountiesSocketCount(): number {
	return activeSockets.size;
}

export const wsPersonalBountiesRoutes = new Elysia().ws(
	"/api/ws/personal-bounties",
	{
		query: t.Object({
			apiKey: t.Optional(t.String()),
			token: t.Optional(t.String()),
		}),
		body: t.Object({
			type: t.String(),
			apiKey: t.Optional(t.String()),
			timestamp: t.Optional(t.Number()),
		}),
		async open(ws) {
			activeSockets.add(ws);
			const snapshot = await getPersonalBountiesSnapshot();
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
				const snapshot = await getPersonalBountiesSnapshot();
				ws.send(snapshot);
			}
		},
	},
);
