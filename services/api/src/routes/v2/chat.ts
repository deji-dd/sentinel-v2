/**
 * HTTP + SSE routes for the chat bar embedded by the Subversive userscript.
 *
 * Authentication reuses the target-finder session token (`satf_<id>_<sig>`), so
 * the chat appears as soon as the member connects their Torn API key in the
 * existing panel — there is no second login.
 */
import { TornApiClient } from "@sentinel/torn-api";
import { Elysia, t } from "elysia";

import { env } from "../../config/env";
import type { ChatMe } from "../../lib/chat-protocol";
import {
	addGrant,
	browseRooms,
	type ChatCaller,
	ChatError,
	closeChatStreamFromRoute,
	createRoom,
	deleteMessage,
	deleteRoom,
	enforceInviteLimit,
	enforceReadLimit,
	enforceTypingLimit,
	enforceWriteLimit,
	ensureChatUserSettings,
	getAccess,
	getFactionTag,
	getGifConfig,
	getMe,
	history,
	joinRoom,
	leaveRoom,
	listRooms,
	markRead,
	openChatStream,
	poll,
	postMessage,
	react,
	removeGrant,
	seeMentions,
	setAdmin,
	setAvatarConsent,
	setGlobalBan,
	setRoomBan,
	setTyping,
	snapshot,
	updateRoom,
} from "../../lib/chat-service";
import type { CachedUserSession } from "../../lib/subversive-target-cache";
import {
	resolveMemberApiKey,
	resolveUserSession,
} from "./subversive-target-finder";

const encoder = new TextEncoder();

function extractBearer(authHeader?: string | null): string | null {
	if (!authHeader) return null;
	const parts = authHeader.split(" ");
	if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
		return parts[1] ?? null;
	}
	return null;
}

function superadminIds(): Set<number> {
	const raw = `${env.CHAT_SUPERADMINS},${env.SUPERADMINS}`;
	return new Set(
		raw
			.split(",")
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isInteger(value) && value > 0),
	);
}

const SUPERADMINS = superadminIds();

async function resolveCaller(headers: {
	authorization?: string | null;
}): Promise<{ caller: ChatCaller; session: CachedUserSession }> {
	const token = extractBearer(headers.authorization);
	if (!token) throw new ChatError(401, "Authentication token required.");
	const session = await resolveUserSession(token);
	if (!session?.isActive) {
		throw new ChatError(
			401,
			"Session expired or membership revoked. Reconnect your API key in the Subversive panel.",
		);
	}

	const settings = await ensureChatUserSettings(session.tornId);
	if (settings.banned) {
		throw new ChatError(403, "You are banned from Subversive chat");
	}

	const factionId = session.factionId ?? null;
	const factionTag = factionId ? await getFactionTag(factionId) : null;
	const superadmin = SUPERADMINS.has(session.tornId);

	return {
		session,
		caller: {
			id: session.tornId,
			name: session.tornName,
			factionId,
			factionTag,
			avatar: settings.avatarUrl,
			showAvatar: settings.showAvatar,
			superadmin,
		},
	};
}

type SetLike = { status?: number | string };

function ok<T extends object>(body: T) {
	return { success: true as const, ...body };
}

function fail(set: SetLike, error: ChatError) {
	set.status = error.status;
	return { success: false as const, error: error.message };
}

async function run<T extends object>(
	set: SetLike,
	fn: () => Promise<T>,
): Promise<T | { success: false; error: string }> {
	try {
		return ok(await fn());
	} catch (error) {
		if (error instanceof ChatError) return fail(set, error);
		throw error;
	}
}

function asBody(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

async function loadTornAvatar(
	session: CachedUserSession,
): Promise<string | null> {
	const apiKey = await resolveMemberApiKey(session);
	if (!apiKey) return null;
	try {
		const profile = await new TornApiClient().getRaw<{
			profile?: { image?: string | null };
		}>("user/", { apiKey, queryParams: { selections: "profile" } });
		const image = profile.profile?.image;
		return typeof image === "string" && image.startsWith("https://")
			? image
			: null;
	} catch {
		return null;
	}
}

export const chatRoutes = new Elysia({ prefix: "/chat" })
	// ─── who am I ───────────────────────────────────────────────────────────
	.get("/me", async ({ headers, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceReadLimit(caller);
			const me: ChatMe = await getMe(caller);
			return { me, gif: getGifConfig(true) };
		}),
	)

	// ─── rooms ──────────────────────────────────────────────────────────────
	.get("/rooms", async ({ headers, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceReadLimit(caller);
			return { rooms: await listRooms(caller) };
		}),
	)

	.get("/rooms/browse", async ({ headers, query, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceReadLimit(caller);
			return { rooms: await browseRooms(caller, query.q ?? "") };
		}),
	)

	.post("/rooms", async ({ headers, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			const room = await createRoom(caller, asBody(body));
			return { room };
		}),
	)

	.patch("/rooms/:id", async ({ headers, params, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			return { room: await updateRoom(caller, params.id, asBody(body)) };
		}),
	)

	.delete("/rooms/:id", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await deleteRoom(caller, params.id);
			return {};
		}),
	)

	.post("/rooms/:id/join", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			return { room: await joinRoom(caller, params.id) };
		}),
	)

	.post("/rooms/:id/leave", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await leaveRoom(caller, params.id);
			return {};
		}),
	)

	.post("/rooms/:id/read", async ({ headers, params, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await markRead(caller, params.id, Number(asBody(body).id));
			return {};
		}),
	)

	.post("/rooms/:id/typing", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceTypingLimit(caller);
			await setTyping(caller, params.id);
			return {};
		}),
	)

	.get("/rooms/:id/messages", async ({ headers, params, query, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceReadLimit(caller);
			return {
				messages: await history(caller, params.id, Number(query.before ?? 0)),
			};
		}),
	)

	.post("/rooms/:id/messages", async ({ headers, params, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			const input = asBody(body);
			const message = await postMessage(
				caller,
				params.id,
				input.text,
				input.gif,
			);
			return { message };
		}),
	)

	.delete("/rooms/:id/messages/:messageId", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await deleteMessage(caller, params.id, Number(params.messageId));
			return {};
		}),
	)

	.post(
		"/rooms/:id/messages/:messageId/reactions",
		async ({ headers, params, body, set }) =>
			run(set, async () => {
				const { caller } = await resolveCaller(headers);
				enforceWriteLimit(caller);
				const input = asBody(body);
				const update = await react(
					caller,
					params.id,
					Number(params.messageId),
					input.emoji,
					input.on !== false,
				);
				return update;
			}),
	)

	.post("/rooms/:id/mentions/seen", async ({ headers, params, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await seeMentions(caller, params.id, asBody(body).ids);
			return {};
		}),
	)

	// ─── access ─────────────────────────────────────────────────────────────
	.get("/rooms/:id/access", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceReadLimit(caller);
			return await getAccess(caller, params.id);
		}),
	)

	.post("/rooms/:id/grants", async ({ headers, params, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			enforceInviteLimit(caller);
			const input = asBody(body);
			await addGrant(caller, params.id, input.kind, input.id, input.label);
			return {};
		}),
	)

	.delete("/rooms/:id/grants/:kind/:target", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await removeGrant(caller, params.id, params.kind, Number(params.target));
			return {};
		}),
	)

	.post("/rooms/:id/admins/:userId", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await setAdmin(caller, params.id, Number(params.userId), true);
			return {};
		}),
	)

	.delete("/rooms/:id/admins/:userId", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await setAdmin(caller, params.id, Number(params.userId), false);
			return {};
		}),
	)

	.post("/rooms/:id/bans/:userId", async ({ headers, params, body, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await setRoomBan(
				caller,
				params.id,
				Number(params.userId),
				true,
				asBody(body).label,
			);
			return {};
		}),
	)

	.delete("/rooms/:id/bans/:userId", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			enforceWriteLimit(caller);
			await setRoomBan(caller, params.id, Number(params.userId), false, "");
			return {};
		}),
	)

	// ─── site-wide moderation ───────────────────────────────────────────────
	.post("/admin/bans/:userId", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			await setGlobalBan(caller, Number(params.userId), true);
			return {};
		}),
	)

	.delete("/admin/bans/:userId", async ({ headers, params, set }) =>
		run(set, async () => {
			const { caller } = await resolveCaller(headers);
			await setGlobalBan(caller, Number(params.userId), false);
			return {};
		}),
	)

	// ─── avatar consent ─────────────────────────────────────────────────────
	.patch(
		"/me",
		async ({ headers, body, set }) =>
			run(set, async () => {
				const { caller, session } = await resolveCaller(headers);
				enforceWriteLimit(caller);
				const show = asBody(body).showAvatar === true;
				let avatar: string | null = null;
				if (show) {
					avatar = await loadTornAvatar(session);
					if (!avatar) {
						throw new ChatError(
							502,
							"Could not load your Torn profile picture. Try again in a moment.",
						);
					}
				}
				return { me: await setAvatarConsent(caller, show, avatar) };
			}),
		{
			body: t.Object({ showAvatar: t.Boolean() }),
		},
	)

	// ─── poll fallback ──────────────────────────────────────────────────────
	.get(
		"/poll",
		async ({ headers, query, set }) =>
			run(set, async () => {
				const { caller } = await resolveCaller(headers);
				enforceReadLimit(caller);
				return await poll(
					caller,
					query.open ?? "",
					query.after,
					query.reactionsAfter,
				);
			}),
		{
			query: t.Object({
				open: t.Optional(t.String()),
				after: t.Optional(t.String()),
				reactionsAfter: t.Optional(t.String()),
			}),
		},
	)

	// ─── server-sent events ─────────────────────────────────────────────────
	.get(
		"/events",
		async ({ headers, query, request, set }) => {
			let caller: ChatCaller;
			let hello: Awaited<ReturnType<typeof snapshot>>;
			try {
				const resolved = await resolveCaller(headers);
				caller = resolved.caller;
				enforceReadLimit(caller);
				hello = await snapshot(caller, query.open ?? "");
			} catch (error) {
				if (error instanceof ChatError) {
					set.status = error.status;
					return { success: false, error: error.message };
				}
				throw error;
			}

			const { readable, writable } = new TransformStream<
				Uint8Array,
				Uint8Array
			>();
			const writer = writable.getWriter();
			const stream = openChatStream(caller, writer);
			writer
				.write(
					encoder.encode(
						`retry: 3000\ndata: ${JSON.stringify({ t: "hello", ...hello })}\n\n`,
					),
				)
				.catch(() => closeChatStreamFromRoute(stream));

			request.signal.addEventListener(
				"abort",
				() => closeChatStreamFromRoute(stream),
				{ once: true },
			);

			return new Response(readable, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Headers": "Authorization, Content-Type",
				},
			});
		},
		{
			query: t.Object({ open: t.Optional(t.String()) }),
		},
	);
