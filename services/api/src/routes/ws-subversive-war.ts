import { Elysia, t } from "elysia";
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

export function broadcastWarUpdate(): void {
	if (activeWarSockets.size === 0) return;

	const war = subversiveTargetCache.getWarState();
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

		ws.send({
			type: "war_snapshot",
			war,
			targets,
			hospitalQueue,
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
			const msg = message as { type?: string; token?: string };
			if (msg.type === "auth" && msg.token) {
				const session = await resolveUserSession(msg.token);
				const client = (ws as unknown as { clientRef?: WarSocketClient })
					.clientRef;
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
			} else if (msg.type === "ping") {
				ws.send({ type: "pong", timestamp: Date.now() });
			}
		}
	},
});
