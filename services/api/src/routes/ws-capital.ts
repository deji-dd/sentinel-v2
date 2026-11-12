import type {
	CapitalAdminOverview,
	CapitalBook,
	CapitalInvestorPortfolio,
	CapitalLiveSnapshot,
	CapitalLiveView,
	CapitalPublicOverview,
} from "@sentinel/schemas";
import { Elysia, t } from "elysia";

import { env } from "../config/env";
import { canReadCapital, resolveCapitalAccess } from "../lib/capital-access";
import {
	findInvestorByTornId,
	getCapitalAdminOverview,
	getCapitalPublicOverview,
	getInvestorPortfolio,
} from "../lib/capital-service";
import { type AuthUser, resolveAuthSession } from "../middleware/auth";

const STREAM_INTERVAL_MS = 10_000;
const AUTH_RECHECK_MS = 60_000;

const ALLOWED_ORIGINS = new Set([
	"https://stocks.blasted-labs.tech",
	"https://api.blasted-labs.tech",
	"http://localhost:5177",
	"http://127.0.0.1:5177",
	"http://localhost:3000",
	"http://127.0.0.1:3000",
]);

type CapitalLiveData =
	CapitalPublicOverview | CapitalInvestorPortfolio | CapitalAdminOverview;

interface CapitalSocketClient {
	socket: {
		send: (data: unknown) => unknown;
		close: (code?: number, reason?: string) => unknown;
	};
	view: CapitalLiveView;
	book: CapitalBook;
	investorId: string | null;
	sessionToken: string | undefined;
	authCheckedAt: number;
}

const clients = new Map<string, CapitalSocketClient>();
let ticking = false;

function isOwner(user: AuthUser | null): boolean {
	if (!user) return false;
	if (user.role === "owner" || user.role === "admin") return true;
	return Boolean(env.DISCORD_USER_ID) && user.discordId === env.DISCORD_USER_ID;
}

function parseView(value: string | undefined): CapitalLiveView | null {
	return value === "public" || value === "portfolio" || value === "admin"
		? value
		: null;
}

function parseBook(value: string | undefined): CapitalBook {
	return value === "paper" ? "paper" : "live";
}

function originAllowed(request: Request): boolean {
	const origin = request.headers.get("origin");
	// Non-browser clients do not send an Origin header. Browser callers must be
	// one of the capital app origins, matching the REST host isolation.
	return !origin || ALLOWED_ORIGINS.has(origin);
}

/**
 * Reads the session cookie from the upgrade request. The WebSocket route does
 * not declare a cookie schema, so Elysia's parsed `cookie` context is not
 * guaranteed on `ws.data`.
 */
function sessionTokenFromRequest(request: Request): string | undefined {
	const header = request.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== "session") continue;
		try {
			return decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			return part.slice(separator + 1).trim();
		}
	}
	return undefined;
}

function emptyPortfolio(message: string): CapitalInvestorPortfolio {
	return {
		success: true,
		investor: null,
		totals: null,
		lots: [],
		payouts: [],
		withdrawals: [],
		performance: [],
		warnings: [message],
	};
}

async function resolveInvestorId(user: AuthUser): Promise<string | null> {
	const access = await resolveCapitalAccess(user, "live", env.DISCORD_USER_ID);
	if (!canReadCapital(access)) return null;
	if (access.investorId) return access.investorId;
	if (access.tornId) return findInvestorByTornId("live", access.tornId);
	return null;
}

/**
 * Re-checks a connected client's access. A session or role revoked while the
 * socket is open must stop the stream instead of leaking admin data until the
 * browser reconnects.
 */
async function revalidate(client: CapitalSocketClient): Promise<boolean> {
	client.authCheckedAt = Date.now();
	if (client.view === "public") return true;

	const resolved = await resolveAuthSession(client.sessionToken);
	const user = resolved.user;
	if (!user) return false;

	if (client.view === "admin") return isOwner(user);

	const access = await resolveCapitalAccess(user, "live", env.DISCORD_USER_ID);
	if (!canReadCapital(access)) return false;
	client.investorId = access.investorId ?? (await resolveInvestorId(user));
	return true;
}

async function buildSnapshot(
	client: CapitalSocketClient,
): Promise<CapitalLiveData> {
	switch (client.view) {
		case "admin":
			return getCapitalAdminOverview(client.book);
		case "portfolio":
			return client.investorId
				? getInvestorPortfolio("live", client.investorId)
				: emptyPortfolio("No active investment is linked to this account.");
		default:
			return getCapitalPublicOverview(client.book);
	}
}

function cacheKey(client: CapitalSocketClient): string {
	return client.view === "portfolio"
		? `portfolio:${client.investorId ?? ""}`
		: `${client.view}:${client.book}`;
}

function snapshotFor(
	key: string,
	client: CapitalSocketClient,
	cache: Map<string, Promise<CapitalLiveData>>,
): Promise<CapitalLiveData> {
	const existing = cache.get(key);
	if (existing) return existing;
	const pending = buildSnapshot(client);
	cache.set(key, pending);
	return pending;
}

function sendSnapshot(client: CapitalSocketClient, data: CapitalLiveData) {
	const snapshot: CapitalLiveSnapshot<CapitalLiveData> = {
		type: "capital_snapshot",
		view: client.view,
		book: client.book,
		data,
		updatedAtIso: new Date().toISOString(),
	};
	client.socket.send(snapshot);
}

async function tick() {
	if (clients.size === 0 || ticking) return;
	ticking = true;
	try {
		const now = Date.now();
		const cache = new Map<string, Promise<CapitalLiveData>>();
		const entries = [...clients.entries()];
		await Promise.all(
			entries.map(async ([id, client]) => {
				try {
					if (
						client.view !== "public" &&
						now - client.authCheckedAt >= AUTH_RECHECK_MS
					) {
						if (!(await revalidate(client))) {
							clients.delete(id);
							client.socket.close(1008, "Access revoked");
							return;
						}
					}
					const data = await snapshotFor(cacheKey(client), client, cache);
					sendSnapshot(client, data);
				} catch {
					clients.delete(id);
					client.socket.close(1011, "Snapshot failed");
				}
			}),
		);
	} finally {
		ticking = false;
	}
}

setInterval(() => void tick(), STREAM_INTERVAL_MS);

export const wsCapitalRoutes = new Elysia().ws("/api/ws/capital", {
	query: t.Object({
		view: t.Optional(t.String()),
		book: t.Optional(t.String()),
	}),
	async open(ws) {
		const view = parseView(ws.data.query.view);
		const book = parseBook(ws.data.query.book);

		if (!view || !originAllowed(ws.data.request)) {
			ws.close(1008, "Not allowed");
			return;
		}

		try {
			const sessionToken = sessionTokenFromRequest(ws.data.request);
			const resolved = await resolveAuthSession(sessionToken);
			const user = resolved.user;
			let investorId: string | null = null;

			if (view === "admin") {
				if (!isOwner(user)) {
					ws.close(1008, "Admin access required");
					return;
				}
			} else if (view === "portfolio") {
				if (!user) {
					ws.close(1008, "Unauthorized");
					return;
				}
				const access = await resolveCapitalAccess(
					user,
					"live",
					env.DISCORD_USER_ID,
				);
				if (!canReadCapital(access)) {
					ws.close(1008, "Capital access denied");
					return;
				}
				investorId = await resolveInvestorId(user);
			}

			const client: CapitalSocketClient = {
				socket: ws,
				view,
				book,
				investorId,
				sessionToken,
				authCheckedAt: Date.now(),
			};
			clients.set(ws.id, client);
			sendSnapshot(client, await buildSnapshot(client));
		} catch {
			clients.delete(ws.id);
			ws.close(1011, "Snapshot failed");
		}
	},
	close(ws) {
		clients.delete(ws.id);
	},
	async message(ws, message) {
		if (typeof message !== "object" || message === null) return;
		const type = (message as { type?: unknown }).type;
		if (type === "ping") {
			ws.send({ type: "pong", timestamp: Date.now() });
			return;
		}
		if (type === "refresh") {
			const client = clients.get(ws.id);
			if (!client) return;
			try {
				sendSnapshot(client, await buildSnapshot(client));
			} catch {
				clients.delete(ws.id);
				ws.close(1011, "Snapshot failed");
			}
		}
	},
});
