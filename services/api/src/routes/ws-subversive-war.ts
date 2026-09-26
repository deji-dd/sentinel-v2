import { Elysia, t } from "elysia";
import { subversiveDibsManager } from "../lib/dibs-manager";
import {
	type CachedUserSession,
	subversiveTargetCache,
} from "../lib/subversive-target-cache";
import { resolveUserSession } from "./v1/subversive-target-finder";

interface WarSocketClient {
	send: (msg: unknown) => void;
	session?: CachedUserSession;
}

const activeWarSockets = new Set<WarSocketClient>();

// Set callback so any dibs changes immediately push to all connected userscripts
subversiveDibsManager.setBroadcastCallback((dibs) => {
	if (activeWarSockets.size === 0) return;
	for (const client of activeWarSockets) {
		try {
			client.send({
				type: "dibs_update",
				dibs,
				timestamp: Date.now(),
			});
		} catch {
			activeWarSockets.delete(client);
		}
	}
});

export function broadcastWarUpdate(): void {
	if (activeWarSockets.size === 0) return;

	const war = subversiveTargetCache.getWarState();
	const baseHospitalQueue = subversiveTargetCache.getHospitalQueue({
		limit: 25,
		attackerBsScore: 0,
	});

	// Process queue through Dibs Manager
	void subversiveDibsManager.processWarHospitalQueue(baseHospitalQueue, war);
	const dibs = subversiveDibsManager.getActiveDibs();

	for (const client of activeWarSockets) {
		try {
			const attackerBsScore = client.session?.bsScore ?? 0;
			const targets = subversiveTargetCache.getAvailableWarTargets({
				attackerBsScore,
			});
			const hospitalQueue = subversiveTargetCache.getHospitalQueue({
				limit: 25,
				attackerBsScore,
			});

			const opponentIds = subversiveTargetCache.getWarOpponentIds();

			client.send({
				type: "war_update",
				war,
				targets,
				hospitalQueue,
				dibs,
				opponentIds,
				timestamp: Date.now(),
			});
		} catch {
			activeWarSockets.delete(client);
		}
	}
}

export const wsSubversiveWarRoutes = new Elysia().ws("/api/ws/subversive-war", {
	query: t.Object({
		token: t.Optional(t.String()),
	}),
	async open(ws) {
		const token = ws.data.query.token;
		let session: CachedUserSession | null = null;
		if (token) {
			session = await resolveUserSession(token);
		}

		const client: WarSocketClient = {
			send: (msg) => ws.send(msg),
			session: session ?? undefined,
		};
		activeWarSockets.add(client);
		(ws as unknown as { clientRef: WarSocketClient }).clientRef = client;

		// Send immediate initial snapshot
		const war = subversiveTargetCache.getWarState();
		const attackerBsScore = session?.bsScore ?? 0;
		const targets = subversiveTargetCache.getAvailableWarTargets({
			attackerBsScore,
		});
		const hospitalQueue = subversiveTargetCache.getHospitalQueue({
			limit: 25,
			attackerBsScore,
		});
		const opponentIds = subversiveTargetCache.getWarOpponentIds();
		const dibs = subversiveDibsManager.getActiveDibs();

		ws.send({
			type: "war_snapshot",
			war,
			targets,
			hospitalQueue,
			dibs,
			opponentIds,
			timestamp: Date.now(),
		});
	},
	close(ws) {
		const client = (ws as unknown as { clientRef?: WarSocketClient }).clientRef;
		if (client) {
			activeWarSockets.delete(client);
		}
	},
	async message(ws, message: unknown) {
		if (typeof message === "object" && message !== null) {
			const msg = message as {
				type?: string;
				token?: string;
				targetId?: number;
			};
			const client = (ws as unknown as { clientRef?: WarSocketClient })
				.clientRef;

			if (msg.type === "auth" && msg.token) {
				const session = await resolveUserSession(msg.token);
				if (client && session) {
					client.session = session;
					const targets = subversiveTargetCache.getAvailableWarTargets({
						attackerBsScore: session.bsScore,
					});
					ws.send({
						type: "auth_ok",
						user: {
							tornId: session.tornId,
							tornName: session.tornName,
							bsScore: session.bsScore,
						},
						targets,
					});
				}
			} else if (
				msg.type === "claim_dibs" &&
				typeof msg.targetId === "number"
			) {
				if (!client?.session) {
					ws.send({
						type: "claim_dibs_error",
						targetId: msg.targetId,
						reason: "Authentication required to claim dibs.",
					});
					return;
				}

				const result = await subversiveDibsManager.claimDibs(msg.targetId, {
					tornId: client.session.tornId,
					tornName: client.session.tornName,
					platform: "script",
				});

				if (result.success) {
					ws.send({
						type: "claim_dibs_success",
						targetId: msg.targetId,
						dibs: result.dibs,
					});
				} else {
					ws.send({
						type: "claim_dibs_error",
						targetId: msg.targetId,
						reason: result.reason ?? "Failed to claim dibs.",
					});
				}
			} else if (
				msg.type === "release_dibs" &&
				typeof msg.targetId === "number"
			) {
				if (!client?.session) {
					ws.send({
						type: "release_dibs_error",
						targetId: msg.targetId,
						reason: "Authentication required to release dibs.",
					});
					return;
				}

				const result = await subversiveDibsManager.releaseDibs(msg.targetId, {
					tornId: client.session.tornId,
				});

				if (result.success) {
					ws.send({
						type: "release_dibs_success",
						targetId: msg.targetId,
					});
				} else {
					ws.send({
						type: "release_dibs_error",
						targetId: msg.targetId,
						reason: result.reason ?? "Failed to release dibs.",
					});
				}
			} else if (msg.type === "ping") {
				ws.send({ type: "pong", timestamp: Date.now() });
			}
		}
	},
});
