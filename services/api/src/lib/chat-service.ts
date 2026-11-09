/**
 * Subversive chat service.
 *
 * Owns the Postgres persistence, access checks, live event fan-out and abuse
 * limits for the chat bar embedded by the userscript. The behaviour is ported
 * from Torn Rooms' Durable Object, but every room and message lives in the
 * Sentinel database instead of the original author's Cloudflare account.
 *
 * One API process serves chat (the deployment runs a single `sentinel-api`
 * container). Live streams are therefore held in RAM; polling clients still
 * catch up from their cursors if the process restarts.
 */
import {
	and,
	asc,
	chatMessageMentions,
	chatMessageReactions,
	chatMessages,
	chatRoomAdmins,
	chatRoomBans,
	chatRoomGrants,
	chatRoomMemberships,
	chatRooms,
	chatUserSettings,
	db,
	desc,
	eq,
	factions,
	gt,
	ilike,
	inArray,
	lte,
	ne,
	or,
	sql,
	subversiveTargetFinderUsers,
} from "@sentinel/database";

import {
	canManage,
	canPost,
	canSee,
	type ChatRoomContext,
	type ChatViewer,
	isJoined,
	isListed,
	receives,
	roleOf,
} from "./chat-access";
import {
	CHAT_LIMITS,
	CHAT_MENTION,
	CHAT_REACTIONS,
	type ChatAccessView,
	type ChatBanView,
	type ChatBrowseRoom,
	type ChatGifConfig,
	chatGifFromText,
	type ChatGrantView,
	type ChatMe,
	type ChatMemberView,
	type ChatMessageView,
	type ChatPollResponse,
	type ChatPostPolicy,
	type ChatReactionsUpdate,
	type ChatReactionView,
	type ChatRoomView,
	type ChatServerEvent,
	type ChatTypingUser,
	type ChatVisibility,
	normalizeChatGif,
} from "./chat-protocol";

/** The caller as resolved from a target-finder session plus chat settings. */
export interface ChatCaller extends ChatViewer {
	name: string;
	factionTag: string | null;
	avatar: string | null;
	showAvatar: boolean;
	superadmin: boolean;
}

export class ChatError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502,
		message: string,
	) {
		super(message);
		this.name = "ChatError";
	}
}

type ChatRoomRow = typeof chatRooms.$inferSelect;
type ChatMessageRow = typeof chatMessages.$inferSelect;

const MAX_UNREAD = 100;
const ROOM_ID_LENGTH = 12;

const roomContextCache = new Map<string, ChatRoomContext>();
const factionTagCache = new Map<number, string | null>();

function clean(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
		.trim()
		.slice(0, max);
}

function colorValue(value: unknown): string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
		? value.toLowerCase()
		: "";
}

function iconName(value: unknown): string {
	return typeof value === "string" && /^[a-z0-9_]{1,40}$/i.test(value)
		? value
		: "";
}

function newRoomId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, ROOM_ID_LENGTH);
}

function toVisibility(
	value: unknown,
	fallback: ChatVisibility,
): ChatVisibility {
	return value === "public"
		? "public"
		: value === "private"
			? "private"
			: fallback;
}

function toPostPolicy(
	value: unknown,
	fallback: ChatPostPolicy,
): ChatPostPolicy {
	return value === "admins"
		? "admins"
		: value === "everyone"
			? "everyone"
			: fallback;
}

// ---------------------------------------------------------------- settings

export async function ensureChatUserSettings(
	tornId: number,
): Promise<typeof chatUserSettings.$inferSelect> {
	const [existing] = await db
		.select()
		.from(chatUserSettings)
		.where(eq(chatUserSettings.tornId, tornId));
	if (existing) return existing;

	const [inserted] = await db
		.insert(chatUserSettings)
		.values({ tornId })
		.onConflictDoNothing()
		.returning();
	if (inserted) return inserted;

	const [created] = await db
		.select()
		.from(chatUserSettings)
		.where(eq(chatUserSettings.tornId, tornId));
	if (!created) {
		throw new ChatError(500, "Could not load chat settings");
	}
	return created;
}

export async function getFactionTag(factionId: number): Promise<string | null> {
	if (factionTagCache.has(factionId)) {
		return factionTagCache.get(factionId) ?? null;
	}
	const [row] = await db
		.select({ tag: factions.tag })
		.from(factions)
		.where(eq(factions.id, factionId));
	const tag = row?.tag?.trim() || null;
	factionTagCache.set(factionId, tag);
	return tag;
}

export function buildChatMe(caller: ChatCaller): ChatMe {
	return {
		id: caller.id,
		name: caller.name,
		factionId: caller.factionId,
		factionTag: caller.factionTag,
		avatar: caller.showAvatar ? caller.avatar : null,
		showAvatar: caller.showAvatar,
		superadmin: caller.superadmin,
	};
}

export function getGifConfig(includeKey = false): ChatGifConfig {
	const apiKey = process.env.KLIPY_API_KEY?.trim() ?? "";
	const enabled = Boolean(apiKey);
	return {
		enabled,
		provider: enabled ? "klipy" : null,
		...(includeKey && enabled ? { apiKey } : {}),
	};
}

// ---------------------------------------------------------------- contexts

function buildContext(
	row: ChatRoomRow,
	data: {
		grants: { kind: string; targetId: number }[];
		admins: number[];
		bans: number[];
		membership: { tornId: number; state: string }[];
	},
): ChatRoomContext {
	const players = new Set<number>();
	const factionsSet = new Set<number>();
	for (const grant of data.grants) {
		if (grant.kind === "player") players.add(grant.targetId);
		else if (grant.kind === "faction") factionsSet.add(grant.targetId);
	}
	return {
		id: row.id,
		visibility: row.visibility === "public" ? "public" : "private",
		postPolicy: row.postPolicy === "admins" ? "admins" : "everyone",
		ownerId: row.ownerId,
		admins: new Set(data.admins),
		players,
		factions: factionsSet,
		bans: new Set(data.bans),
		membership: new Map(
			data.membership.map((m) => [
				m.tornId,
				m.state === "left" ? "left" : "joined",
			]),
		),
	};
}

async function loadRoomContext(room: ChatRoomRow): Promise<ChatRoomContext> {
	const [grants, admins, bans, memberships] = await Promise.all([
		db
			.select({ kind: chatRoomGrants.kind, targetId: chatRoomGrants.targetId })
			.from(chatRoomGrants)
			.where(eq(chatRoomGrants.roomId, room.id)),
		db
			.select({ tornId: chatRoomAdmins.tornId })
			.from(chatRoomAdmins)
			.where(eq(chatRoomAdmins.roomId, room.id)),
		db
			.select({ tornId: chatRoomBans.tornId })
			.from(chatRoomBans)
			.where(eq(chatRoomBans.roomId, room.id)),
		db
			.select({
				tornId: chatRoomMemberships.tornId,
				state: chatRoomMemberships.state,
			})
			.from(chatRoomMemberships)
			.where(eq(chatRoomMemberships.roomId, room.id)),
	]);
	return buildContext(room, {
		grants,
		admins: admins.map((a) => a.tornId),
		bans: bans.map((b) => b.tornId),
		membership: memberships,
	});
}

async function getRoomContext(
	roomId: string,
): Promise<ChatRoomContext | undefined> {
	const cached = roomContextCache.get(roomId);
	if (cached) return cached;
	const [room] = await db
		.select()
		.from(chatRooms)
		.where(eq(chatRooms.id, roomId));
	if (!room) return undefined;
	const context = await loadRoomContext(room);
	roomContextCache.set(roomId, context);
	return context;
}

function invalidateRoom(roomId: string): void {
	roomContextCache.delete(roomId);
}

interface BulkAccess {
	grants: Map<string, { kind: string; targetId: number }[]>;
	admins: Map<string, number[]>;
	bans: Map<string, number[]>;
}

async function loadBulkAccess(roomIds: string[]): Promise<BulkAccess> {
	const grants = new Map<string, { kind: string; targetId: number }[]>();
	const admins = new Map<string, number[]>();
	const bans = new Map<string, number[]>();
	if (!roomIds.length) return { grants, admins, bans };

	const [grantRows, adminRows, banRows] = await Promise.all([
		db
			.select({
				roomId: chatRoomGrants.roomId,
				kind: chatRoomGrants.kind,
				targetId: chatRoomGrants.targetId,
			})
			.from(chatRoomGrants)
			.where(inArray(chatRoomGrants.roomId, roomIds)),
		db
			.select({ roomId: chatRoomAdmins.roomId, tornId: chatRoomAdmins.tornId })
			.from(chatRoomAdmins)
			.where(inArray(chatRoomAdmins.roomId, roomIds)),
		db
			.select({ roomId: chatRoomBans.roomId, tornId: chatRoomBans.tornId })
			.from(chatRoomBans)
			.where(inArray(chatRoomBans.roomId, roomIds)),
	]);

	for (const row of grantRows) {
		const list = grants.get(row.roomId) ?? [];
		list.push({ kind: row.kind, targetId: row.targetId });
		grants.set(row.roomId, list);
	}
	for (const row of adminRows) {
		const list = admins.get(row.roomId) ?? [];
		list.push(row.tornId);
		admins.set(row.roomId, list);
	}
	for (const row of banRows) {
		const list = bans.get(row.roomId) ?? [];
		list.push(row.tornId);
		bans.set(row.roomId, list);
	}
	return { grants, admins, bans };
}

// ---------------------------------------------------------------- messages

function messageGif(row: ChatMessageRow) {
	if (!row.gifUrl) return null;
	return {
		url: row.gifUrl,
		width: row.gifWidth ?? 0,
		height: row.gifHeight ?? 0,
		title: row.gifTitle ?? "",
	};
}

function toMessageView(
	row: ChatMessageRow,
	reactions: ChatReactionView[] = [],
	mentions: { id: number; name: string }[] = [],
): ChatMessageView {
	return {
		id: row.id,
		roomId: row.roomId,
		userId: row.userId,
		name: row.name,
		avatar: row.avatarUrl,
		factionTag: row.factionTag,
		text: row.body,
		ts: row.createdAt.getTime(),
		reactions,
		mentions,
		gif: messageGif(row),
	};
}

async function reactionsForMessages(
	messageIds: number[],
): Promise<Map<number, ChatReactionView[]>> {
	const out = new Map<number, ChatReactionView[]>();
	if (!messageIds.length) return out;

	const rows = await db
		.select({
			messageId: chatMessageReactions.messageId,
			emoji: chatMessageReactions.emoji,
			userId: chatMessageReactions.userId,
			name: subversiveTargetFinderUsers.tornName,
		})
		.from(chatMessageReactions)
		.leftJoin(
			subversiveTargetFinderUsers,
			eq(chatMessageReactions.userId, subversiveTargetFinderUsers.tornId),
		)
		.where(inArray(chatMessageReactions.messageId, messageIds))
		.orderBy(
			asc(chatMessageReactions.createdAt),
			asc(chatMessageReactions.userId),
		);

	for (const row of rows) {
		let list = out.get(row.messageId);
		if (!list) {
			list = [];
			out.set(row.messageId, list);
		}
		let view = list.find((v) => v.emoji === row.emoji);
		if (!view) {
			view = { emoji: row.emoji, users: [] };
			list.push(view);
		}
		view.users.push({
			id: row.userId,
			name: row.name ?? `Player #${row.userId}`,
		});
	}
	return out;
}

async function withExtras(rows: ChatMessageRow[]): Promise<ChatMessageView[]> {
	if (!rows.length) return [];
	const ids = rows.map((row) => row.id);
	const [reactions, mentionRows] = await Promise.all([
		reactionsForMessages(ids),
		db
			.select({
				messageId: chatMessageMentions.messageId,
				userId: chatMessageMentions.userId,
				name: chatMessageMentions.name,
			})
			.from(chatMessageMentions)
			.where(inArray(chatMessageMentions.messageId, ids))
			.orderBy(
				asc(chatMessageMentions.createdAt),
				asc(chatMessageMentions.userId),
			),
	]);

	const mentions = new Map<number, { id: number; name: string }[]>();
	for (const row of mentionRows) {
		const list = mentions.get(row.messageId) ?? [];
		list.push({ id: row.userId, name: row.name });
		mentions.set(row.messageId, list);
	}

	return rows.map((row) =>
		toMessageView(row, reactions.get(row.id) ?? [], mentions.get(row.id) ?? []),
	);
}

// ---------------------------------------------------------------- room views

async function lastMessages(
	rooms: ChatRoomRow[],
): Promise<Map<number, ChatMessageRow>> {
	const ids = [
		...new Set(rooms.map((r) => r.lastMessageId).filter((id) => id > 0)),
	];
	const out = new Map<number, ChatMessageRow>();
	if (!ids.length) return out;
	const rows = await db
		.select()
		.from(chatMessages)
		.where(
			and(inArray(chatMessages.id, ids), eq(chatMessages.isDeleted, false)),
		);
	for (const row of rows) out.set(row.id, row);
	return out;
}

async function unreadCounts(
	caller: ChatCaller,
	roomIds: string[],
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (!roomIds.length) return out;
	const rows = await db
		.select({
			roomId: chatMessages.roomId,
			unread: sql<number>`least(count(*), ${MAX_UNREAD})::int`,
		})
		.from(chatMessages)
		.innerJoin(
			chatRoomMemberships,
			and(
				eq(chatRoomMemberships.roomId, chatMessages.roomId),
				eq(chatRoomMemberships.tornId, caller.id),
				eq(chatRoomMemberships.state, "joined"),
			),
		)
		.where(
			and(
				inArray(chatMessages.roomId, roomIds),
				sql`${chatMessages.id} > ${chatRoomMemberships.lastReadId}`,
				ne(chatMessages.userId, caller.id),
				eq(chatMessages.isDeleted, false),
			),
		)
		.groupBy(chatMessages.roomId);
	for (const row of rows) out.set(row.roomId, Number(row.unread));
	return out;
}

async function unseenMentions(
	caller: ChatCaller,
	roomIds: string[],
): Promise<Map<string, number[]>> {
	const out = new Map<string, number[]>();
	if (!roomIds.length) return out;
	const rows = await db
		.select({
			roomId: chatMessageMentions.roomId,
			messageId: chatMessageMentions.messageId,
		})
		.from(chatMessageMentions)
		.where(
			and(
				eq(chatMessageMentions.userId, caller.id),
				eq(chatMessageMentions.seen, false),
				inArray(chatMessageMentions.roomId, roomIds),
			),
		)
		.orderBy(asc(chatMessageMentions.messageId));
	for (const row of rows) {
		const list = out.get(row.roomId) ?? [];
		if (list.length < CHAT_LIMITS.mentionsListed) list.push(row.messageId);
		out.set(row.roomId, list);
	}
	return out;
}

function makeRoomView(
	row: ChatRoomRow,
	context: ChatRoomContext,
	caller: ChatCaller,
	options: {
		last: ChatMessageRow | undefined;
		lastReadId: number;
		unread: number;
		mentions: number[];
	},
): ChatRoomView {
	const joined = isJoined(context, caller);
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		topic: row.topic,
		icon: row.icon,
		color: row.color,
		visibility: context.visibility,
		postPolicy: context.postPolicy,
		showFactionTags: row.showFactionTags,
		ownerId: row.ownerId,
		role: roleOf(context, caller),
		joined,
		canPost: canPost(context, caller),
		lastMessage: options.last ? toMessageView(options.last) : null,
		lastReadId: options.lastReadId,
		unread: joined ? options.unread : 0,
		mentions: joined ? options.mentions : [],
	};
}

// ---------------------------------------------------------------- rooms

export async function listRooms(caller: ChatCaller): Promise<ChatRoomView[]> {
	const [memberships, playerGrants, factionGrants, adminRows, owned] =
		await Promise.all([
			db
				.select({
					roomId: chatRoomMemberships.roomId,
					state: chatRoomMemberships.state,
					lastReadId: chatRoomMemberships.lastReadId,
				})
				.from(chatRoomMemberships)
				.where(eq(chatRoomMemberships.tornId, caller.id)),
			db
				.select({ roomId: chatRoomGrants.roomId })
				.from(chatRoomGrants)
				.where(
					and(
						eq(chatRoomGrants.kind, "player"),
						eq(chatRoomGrants.targetId, caller.id),
					),
				),
			caller.factionId === null
				? Promise.resolve([] as { roomId: string }[])
				: db
						.select({ roomId: chatRoomGrants.roomId })
						.from(chatRoomGrants)
						.where(
							and(
								eq(chatRoomGrants.kind, "faction"),
								eq(chatRoomGrants.targetId, caller.factionId),
							),
						),
			db
				.select({ roomId: chatRoomAdmins.roomId })
				.from(chatRoomAdmins)
				.where(eq(chatRoomAdmins.tornId, caller.id)),
			db
				.select({ id: chatRooms.id })
				.from(chatRooms)
				.where(eq(chatRooms.ownerId, caller.id)),
		]);

	const ids = new Set<string>();
	for (const row of memberships) ids.add(row.roomId);
	for (const row of playerGrants) ids.add(row.roomId);
	for (const row of factionGrants) ids.add(row.roomId);
	for (const row of adminRows) ids.add(row.roomId);
	for (const row of owned) ids.add(row.id);
	if (!ids.size) return [];

	const roomRows = await db
		.select()
		.from(chatRooms)
		.where(inArray(chatRooms.id, [...ids]));
	const access = await loadBulkAccess([...ids]);

	const membershipByRoom = new Map<string, "joined" | "left">();
	const lastReadByRoom = new Map<string, number>();
	for (const row of memberships) {
		membershipByRoom.set(row.roomId, row.state === "left" ? "left" : "joined");
		lastReadByRoom.set(row.roomId, Number(row.lastReadId));
	}

	const listed: ChatRoomRow[] = [];
	const contexts = new Map<string, ChatRoomContext>();
	for (const row of roomRows) {
		const context = buildContext(row, {
			grants: access.grants.get(row.id) ?? [],
			admins: access.admins.get(row.id) ?? [],
			bans: access.bans.get(row.id) ?? [],
			membership: membershipByRoom.has(row.id)
				? [
						{
							tornId: caller.id,
							state: membershipByRoom.get(row.id) ?? "joined",
						},
					]
				: [],
		});
		contexts.set(row.id, context);
		if (isListed(context, caller)) listed.push(row);
	}
	if (!listed.length) return [];

	const listedIds = listed.map((row) => row.id);
	const [lasts, unread, mentions] = await Promise.all([
		lastMessages(listed),
		unreadCounts(caller, listedIds),
		unseenMentions(caller, listedIds),
	]);

	return listed.map((row) =>
		makeRoomView(row, contexts.get(row.id)!, caller, {
			last: lasts.get(row.lastMessageId),
			lastReadId: lastReadByRoom.get(row.id) ?? 0,
			unread: unread.get(row.id) ?? 0,
			mentions: mentions.get(row.id) ?? [],
		}),
	);
}

export async function getMe(caller: ChatCaller): Promise<ChatMe> {
	return buildChatMe(caller);
}

export async function browseRooms(
	caller: ChatCaller,
	query: string,
): Promise<ChatBrowseRoom[]> {
	const q = clean(query, 50).replace(/[%_]/g, "");
	const pattern = `%${q}%`;

	const rows = await db
		.select()
		.from(chatRooms)
		.where(
			and(
				eq(chatRooms.visibility, "public"),
				or(
					ilike(chatRooms.name, pattern),
					ilike(chatRooms.topic, pattern),
					ilike(chatRooms.description, pattern),
				),
			),
		)
		.orderBy(desc(chatRooms.createdAt))
		.limit(100);
	if (!rows.length) return [];

	const ids = rows.map((row) => row.id);
	const [memberRows, membershipRows, banRows] = await Promise.all([
		db
			.select({
				roomId: chatRoomMemberships.roomId,
				n: sql<number>`count(*)::int`,
			})
			.from(chatRoomMemberships)
			.where(
				and(
					inArray(chatRoomMemberships.roomId, ids),
					eq(chatRoomMemberships.state, "joined"),
				),
			)
			.groupBy(chatRoomMemberships.roomId),
		db
			.select({
				roomId: chatRoomMemberships.roomId,
				state: chatRoomMemberships.state,
			})
			.from(chatRoomMemberships)
			.where(
				and(
					inArray(chatRoomMemberships.roomId, ids),
					eq(chatRoomMemberships.tornId, caller.id),
				),
			),
		db
			.select({ roomId: chatRoomBans.roomId })
			.from(chatRoomBans)
			.where(
				and(
					inArray(chatRoomBans.roomId, ids),
					eq(chatRoomBans.tornId, caller.id),
				),
			),
	]);

	const members = new Map(memberRows.map((row) => [row.roomId, Number(row.n)]));
	const joined = new Map(
		membershipRows.map((row) => [row.roomId, row.state === "joined"]),
	);
	const banned = new Set(banRows.map((row) => row.roomId));

	return rows
		.filter((row) => !banned.has(row.id))
		.map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			topic: row.topic,
			icon: row.icon,
			color: row.color,
			memberCount: members.get(row.id) ?? 0,
			joined: joined.get(row.id) ?? false,
		}))
		.sort((a, b) => b.memberCount - a.memberCount);
}

export async function createRoom(
	caller: ChatCaller,
	input: Record<string, unknown>,
): Promise<ChatRoomView> {
	const name = clean(input.name, CHAT_LIMITS.roomName);
	if (!name) throw new ChatError(400, "A room needs a name");

	const visibility = toVisibility(input.visibility, "private");
	if (visibility === "public" && !caller.superadmin) {
		throw new ChatError(403, "Only site admins can create public rooms");
	}

	if (!caller.superadmin) {
		const [owned] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(chatRooms)
			.where(eq(chatRooms.ownerId, caller.id));
		if (Number(owned?.n ?? 0) >= CHAT_LIMITS.ownedRooms) {
			throw new ChatError(
				409,
				`You can own at most ${CHAT_LIMITS.ownedRooms} rooms`,
			);
		}
	}

	const id = newRoomId();
	const now = new Date();
	await db.insert(chatRooms).values({
		id,
		name,
		description: clean(input.description, CHAT_LIMITS.description),
		topic: clean(input.topic, CHAT_LIMITS.topic),
		icon: iconName(input.icon),
		color: colorValue(input.color),
		visibility,
		postPolicy: toPostPolicy(input.postPolicy, "everyone"),
		showFactionTags: input.showFactionTags === true,
		ownerId: caller.id,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(chatRoomMemberships).values({
		roomId: id,
		tornId: caller.id,
		state: "joined",
		joinedAt: now,
		updatedAt: now,
	});
	invalidateRoom(id);
	broadcastRoomsChanged(caller.id);

	const [row] = await db.select().from(chatRooms).where(eq(chatRooms.id, id));
	if (!row) throw new ChatError(404, "Room not found");
	const context = await getRoomContext(id);
	if (!context) throw new ChatError(404, "Room not found");
	return makeRoomView(row, context, caller, {
		last: undefined,
		lastReadId: 0,
		unread: 0,
		mentions: [],
	});
}

export async function updateRoom(
	caller: ChatCaller,
	roomId: string,
	input: Record<string, unknown>,
): Promise<ChatRoomView> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (!canManage(context, caller)) {
		throw new ChatError(403, "Only room admins can change settings");
	}
	const [row] = await db
		.select()
		.from(chatRooms)
		.where(eq(chatRooms.id, roomId));
	if (!row) throw new ChatError(404, "Room not found");

	const name =
		input.name === undefined
			? row.name
			: clean(input.name, CHAT_LIMITS.roomName);
	if (!name) throw new ChatError(400, "A room needs a name");
	const visibility =
		input.visibility === undefined
			? context.visibility
			: toVisibility(input.visibility, context.visibility);
	if (visibility !== context.visibility && !caller.superadmin) {
		throw new ChatError(
			403,
			"Only site admins can make rooms public or private",
		);
	}

	const now = new Date();
	await db
		.update(chatRooms)
		.set({
			name,
			description:
				input.description === undefined
					? row.description
					: clean(input.description, CHAT_LIMITS.description),
			topic:
				input.topic === undefined
					? row.topic
					: clean(input.topic, CHAT_LIMITS.topic),
			icon: input.icon === undefined ? row.icon : iconName(input.icon),
			color: input.color === undefined ? row.color : colorValue(input.color),
			visibility,
			postPolicy:
				input.postPolicy === undefined
					? context.postPolicy
					: toPostPolicy(input.postPolicy, context.postPolicy),
			showFactionTags:
				input.showFactionTags === undefined
					? row.showFactionTags
					: input.showFactionTags === true,
			updatedAt: now,
		})
		.where(eq(chatRooms.id, roomId));
	invalidateRoom(roomId);
	broadcastRoomsChanged();

	const updatedContext = await getRoomContext(roomId);
	const [updated] = await db
		.select()
		.from(chatRooms)
		.where(eq(chatRooms.id, roomId));
	if (!updated || !updatedContext) throw new ChatError(404, "Room not found");
	const last = updated.lastMessageId
		? (
				await db
					.select()
					.from(chatMessages)
					.where(eq(chatMessages.id, updated.lastMessageId))
			)[0]
		: undefined;
	const [membership] = await db
		.select()
		.from(chatRoomMemberships)
		.where(
			and(
				eq(chatRoomMemberships.roomId, roomId),
				eq(chatRoomMemberships.tornId, caller.id),
			),
		);
	return makeRoomView(updated, updatedContext, caller, {
		last,
		lastReadId: Number(membership?.lastReadId ?? 0),
		unread: 0,
		mentions: [],
	});
}

export async function deleteRoom(
	caller: ChatCaller,
	roomId: string,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (
		context.ownerId !== caller.id &&
		!(caller.superadmin && context.visibility === "public")
	) {
		throw new ChatError(403, "Only the owner can delete a room");
	}
	await db.delete(chatRooms).where(eq(chatRooms.id, roomId));
	invalidateRoom(roomId);
	broadcastRoomsChanged();
}

export async function joinRoom(
	caller: ChatCaller,
	roomId: string,
): Promise<ChatRoomView> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	const now = new Date();
	await db
		.insert(chatRoomMemberships)
		.values({
			roomId,
			tornId: caller.id,
			state: "joined",
			joinedAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [chatRoomMemberships.roomId, chatRoomMemberships.tornId],
			set: { state: "joined", updatedAt: now },
		});
	invalidateRoom(roomId);
	broadcastRoomsChanged(caller.id);

	const [row] = await db
		.select()
		.from(chatRooms)
		.where(eq(chatRooms.id, roomId));
	const updatedContext = await getRoomContext(roomId);
	if (!row || !updatedContext) throw new ChatError(404, "Room not found");
	const [membership] = await db
		.select()
		.from(chatRoomMemberships)
		.where(
			and(
				eq(chatRoomMemberships.roomId, roomId),
				eq(chatRoomMemberships.tornId, caller.id),
			),
		);
	const last = row.lastMessageId
		? (
				await db
					.select()
					.from(chatMessages)
					.where(eq(chatMessages.id, row.lastMessageId))
			)[0]
		: undefined;
	return makeRoomView(row, updatedContext, caller, {
		last,
		lastReadId: Number(membership?.lastReadId ?? 0),
		unread: 0,
		mentions: [],
	});
}

export async function leaveRoom(
	caller: ChatCaller,
	roomId: string,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (context.ownerId === caller.id) {
		throw new ChatError(409, "The owner cannot leave; delete the room instead");
	}
	const now = new Date();
	await db
		.insert(chatRoomMemberships)
		.values({
			roomId,
			tornId: caller.id,
			state: "left",
			joinedAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [chatRoomMemberships.roomId, chatRoomMemberships.tornId],
			set: { state: "left", updatedAt: now },
		});
	invalidateRoom(roomId);
	broadcastRoomsChanged(caller.id);
}

export async function markRead(
	caller: ChatCaller,
	roomId: string,
	messageId: number,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !receives(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	await db
		.update(chatRoomMemberships)
		.set({
			lastReadId: sql`greatest(${chatRoomMemberships.lastReadId}, ${Math.max(0, Math.floor(messageId))})`,
		})
		.where(
			and(
				eq(chatRoomMemberships.roomId, roomId),
				eq(chatRoomMemberships.tornId, caller.id),
			),
		);
}

// ---------------------------------------------------------------- access

export async function getAccess(
	caller: ChatCaller,
	roomId: string,
): Promise<ChatAccessView> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}

	const [grants, memberRows, banRows] = await Promise.all([
		db
			.select()
			.from(chatRoomGrants)
			.where(eq(chatRoomGrants.roomId, roomId))
			.orderBy(desc(chatRoomGrants.kind), asc(chatRoomGrants.addedAt)),
		db
			.select({
				id: chatRoomMemberships.tornId,
				name: subversiveTargetFinderUsers.tornName,
				factionId: subversiveTargetFinderUsers.factionId,
			})
			.from(chatRoomMemberships)
			.innerJoin(
				subversiveTargetFinderUsers,
				eq(chatRoomMemberships.tornId, subversiveTargetFinderUsers.tornId),
			)
			.where(
				and(
					eq(chatRoomMemberships.roomId, roomId),
					eq(chatRoomMemberships.state, "joined"),
				),
			)
			.orderBy(asc(subversiveTargetFinderUsers.tornName))
			.limit(500),
		canManage(context, caller)
			? db
					.select()
					.from(chatRoomBans)
					.where(eq(chatRoomBans.roomId, roomId))
					.orderBy(desc(chatRoomBans.bannedAt))
			: Promise.resolve([] as (typeof chatRoomBans.$inferSelect)[]),
	]);

	const grantViews: ChatGrantView[] = grants.map((grant) => ({
		kind: grant.kind === "faction" ? "faction" : "player",
		id: grant.targetId,
		label: grant.label,
		addedBy: grant.addedBy,
		addedAt: grant.addedAt.getTime(),
	}));

	const members: ChatMemberView[] = memberRows
		.filter((member) =>
			canSee(context, {
				id: member.id,
				factionId: member.factionId,
				superadmin: false,
			}),
		)
		.map((member) => ({
			id: member.id,
			name: member.name,
			role: roleOf(context, {
				id: member.id,
				factionId: member.factionId,
				superadmin: false,
			}),
		}));

	const bans: ChatBanView[] = canManage(context, caller)
		? banRows.map((ban) => ({
				id: ban.tornId,
				label: ban.label,
				bannedAt: ban.bannedAt.getTime(),
			}))
		: [];

	return { grants: grantViews, members, bans };
}

export async function addGrant(
	caller: ChatCaller,
	roomId: string,
	kindInput: unknown,
	targetInput: unknown,
	labelInput: unknown,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (!canManage(context, caller)) {
		throw new ChatError(403, "Only room admins can invite");
	}
	const kind =
		kindInput === "faction"
			? "faction"
			: kindInput === "player"
				? "player"
				: null;
	if (!kind) throw new ChatError(400, "Invite a player or a faction");
	const target = Number(targetInput);
	if (!Number.isInteger(target) || target <= 0) {
		throw new ChatError(400, "Invalid ID");
	}

	const [count] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(chatRoomGrants)
		.where(eq(chatRoomGrants.roomId, roomId));
	if (Number(count?.n ?? 0) >= CHAT_LIMITS.grantsPerRoom) {
		throw new ChatError(
			409,
			`A room can have at most ${CHAT_LIMITS.grantsPerRoom} invites`,
		);
	}

	let known = "";
	let knownFaction = "";
	if (kind === "player") {
		const [user] = await db
			.select({ name: subversiveTargetFinderUsers.tornName })
			.from(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.tornId, target));
		known = user?.name ?? "";
	} else {
		const [faction] = await db
			.select({ name: factions.name })
			.from(factions)
			.where(eq(factions.id, target));
		knownFaction = faction?.name ?? "";
	}
	const label =
		clean(labelInput, CHAT_LIMITS.label) ||
		known ||
		knownFaction ||
		`${kind === "player" ? "Player" : "Faction"} #${target}`;

	await db
		.insert(chatRoomGrants)
		.values({
			roomId,
			kind,
			targetId: target,
			label,
			addedBy: caller.id,
		})
		.onConflictDoUpdate({
			target: [
				chatRoomGrants.roomId,
				chatRoomGrants.kind,
				chatRoomGrants.targetId,
			],
			set: { label },
		});

	// A personal invite brings back a player who left, as a fresh invitation.
	if (kind === "player") {
		await db
			.delete(chatRoomMemberships)
			.where(
				and(
					eq(chatRoomMemberships.roomId, roomId),
					eq(chatRoomMemberships.tornId, target),
					eq(chatRoomMemberships.state, "left"),
				),
			);
	}

	invalidateRoom(roomId);
	broadcastRoomsChanged();
}

export async function removeGrant(
	caller: ChatCaller,
	roomId: string,
	kind: string,
	target: number,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (!canManage(context, caller)) {
		throw new ChatError(403, "Only room admins can remove invites");
	}
	await db
		.delete(chatRoomGrants)
		.where(
			and(
				eq(chatRoomGrants.roomId, roomId),
				eq(chatRoomGrants.kind, kind),
				eq(chatRoomGrants.targetId, target),
			),
		);
	invalidateRoom(roomId);
	broadcastRoomsChanged();
}

export async function setAdmin(
	caller: ChatCaller,
	roomId: string,
	userId: number,
	admin: boolean,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (
		context.ownerId !== caller.id &&
		!(caller.superadmin && context.visibility === "public")
	) {
		throw new ChatError(403, "Only the owner can change admins");
	}
	if (userId === context.ownerId) {
		throw new ChatError(400, "The owner is already in charge");
	}
	if (admin) {
		if (context.admins.size >= CHAT_LIMITS.adminsPerRoom) {
			throw new ChatError(
				409,
				`A room can have at most ${CHAT_LIMITS.adminsPerRoom} admins`,
			);
		}
		const [user] = await db
			.select({
				id: subversiveTargetFinderUsers.tornId,
				factionId: subversiveTargetFinderUsers.factionId,
			})
			.from(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.tornId, userId));
		if (
			!user ||
			!canSee(context, {
				id: user.id,
				factionId: user.factionId,
				superadmin: false,
			})
		) {
			throw new ChatError(
				400,
				"Only people with access to the room can be admins",
			);
		}
		await db
			.insert(chatRoomAdmins)
			.values({ roomId, tornId: userId, addedBy: caller.id })
			.onConflictDoNothing();
	} else {
		await db
			.delete(chatRoomAdmins)
			.where(
				and(
					eq(chatRoomAdmins.roomId, roomId),
					eq(chatRoomAdmins.tornId, userId),
				),
			);
	}
	invalidateRoom(roomId);
	broadcastRoomsChanged();
}

export async function setRoomBan(
	caller: ChatCaller,
	roomId: string,
	userId: number,
	banned: boolean,
	labelInput: unknown,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (!canManage(context, caller)) {
		throw new ChatError(403, "Only room admins can ban");
	}
	if (
		userId === context.ownerId ||
		(context.admins.has(userId) && context.ownerId !== caller.id)
	) {
		throw new ChatError(403, "You cannot ban this person");
	}

	if (banned) {
		const [user] = await db
			.select({ name: subversiveTargetFinderUsers.tornName })
			.from(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.tornId, userId));
		await db
			.insert(chatRoomBans)
			.values({
				roomId,
				tornId: userId,
				label:
					clean(labelInput, CHAT_LIMITS.label) ||
					user?.name ||
					`Player #${userId}`,
				bannedBy: caller.id,
			})
			.onConflictDoUpdate({
				target: [chatRoomBans.roomId, chatRoomBans.tornId],
				set: {
					label:
						clean(labelInput, CHAT_LIMITS.label) ||
						user?.name ||
						`Player #${userId}`,
				},
			});
		await db
			.delete(chatRoomAdmins)
			.where(
				and(
					eq(chatRoomAdmins.roomId, roomId),
					eq(chatRoomAdmins.tornId, userId),
				),
			);
	} else {
		await db
			.delete(chatRoomBans)
			.where(
				and(eq(chatRoomBans.roomId, roomId), eq(chatRoomBans.tornId, userId)),
			);
	}
	invalidateRoom(roomId);
	broadcastRoomsChanged();
}

export async function setGlobalBan(
	caller: ChatCaller,
	userId: number,
	banned: boolean,
): Promise<void> {
	if (!caller.superadmin) {
		throw new ChatError(403, "Only site admins can do that");
	}
	await ensureChatUserSettings(userId);
	await db
		.update(chatUserSettings)
		.set({ banned, updatedAt: new Date() })
		.where(eq(chatUserSettings.tornId, userId));
	if (banned) dropUserStreams(userId);
}

// ---------------------------------------------------------------- messages

export async function history(
	caller: ChatCaller,
	roomId: string,
	before: number,
): Promise<ChatMessageView[]> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (context.visibility === "private" && !isJoined(context, caller)) {
		throw new ChatError(403, "Accept the invitation to read this room");
	}
	const rows = await db
		.select()
		.from(chatMessages)
		.where(
			and(
				eq(chatMessages.roomId, roomId),
				eq(chatMessages.isDeleted, false),
				before > 0 ? lte(chatMessages.id, before - 1) : undefined,
			),
		)
		.orderBy(desc(chatMessages.id))
		.limit(CHAT_LIMITS.historyPage);
	return withExtras(rows.reverse());
}

export async function postMessage(
	caller: ChatCaller,
	roomId: string,
	textInput: unknown,
	gifInput: unknown,
): Promise<ChatMessageView> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (!isJoined(context, caller))
		throw new ChatError(403, "Join the room first");
	if (!canPost(context, caller)) {
		throw new ChatError(403, "Only admins can post in this room");
	}

	let body = clean(textInput, CHAT_LIMITS.message);
	const hasGifInput =
		typeof gifInput === "object" &&
		gifInput !== null &&
		!Array.isArray(gifInput);
	let gif = normalizeChatGif(gifInput);
	if (hasGifInput && !gif) {
		throw new ChatError(400, "That GIF link is not supported");
	}
	if (!gif) {
		// Pasting a provider image URL on its own attaches it as a GIF.
		const fromText = chatGifFromText(body);
		if (fromText) {
			gif = fromText;
			body = "";
		}
	}
	if (!body && !gif) throw new ChatError(400, "Empty message");
	if (body.length > CHAT_LIMITS.message) {
		throw new ChatError(
			400,
			`Messages are at most ${CHAT_LIMITS.message} characters`,
		);
	}
	if (
		!rateLimiter.allow(
			`msg:${caller.id}`,
			CHAT_LIMITS.rateCount,
			CHAT_LIMITS.rateWindowMs,
		)
	) {
		throw new ChatError(429, "Slow down");
	}

	const now = new Date();
	const [row] = await db
		.insert(chatMessages)
		.values({
			roomId,
			userId: caller.id,
			name: caller.name,
			avatarUrl: caller.showAvatar ? caller.avatar : null,
			factionTag: caller.factionTag,
			body,
			gifUrl: gif?.url ?? null,
			gifWidth: gif?.width ?? null,
			gifHeight: gif?.height ?? null,
			gifTitle: gif?.title ?? null,
			createdAt: now,
		})
		.returning();
	if (!row) throw new ChatError(502, "Could not save the message");

	await Promise.all([
		db
			.update(chatRooms)
			.set({ lastMessageId: row.id, updatedAt: now })
			.where(eq(chatRooms.id, roomId)),
		db
			.update(chatRoomMemberships)
			.set({ lastReadId: row.id, updatedAt: now })
			.where(
				and(
					eq(chatRoomMemberships.roomId, roomId),
					eq(chatRoomMemberships.tornId, caller.id),
				),
			),
	]);

	const mentions = await tagMentions(context, caller, row.id, body);
	// Retention is a bulk delete; checking every hundredth message keeps the
	// common post path free of the extra count and delete.
	if (row.id % 100 === 0) await pruneRoomHistory(roomId);

	const message = toMessageView(row, [], mentions);
	emit((stream) => receives(context, stream.caller), {
		t: "msg",
		msg: message,
	});
	typing.get(roomId)?.delete(caller.id);
	return message;
}

async function tagMentions(
	context: ChatRoomContext,
	caller: ChatCaller,
	messageId: number,
	text: string,
): Promise<{ id: number; name: string }[]> {
	if (!text) return [];
	const names = [
		...new Set(
			[...text.matchAll(CHAT_MENTION)]
				.map((match) => (match[1] ?? "").toLowerCase())
				.filter(Boolean),
		),
	].slice(0, CHAT_LIMITS.mentionsPerMessage);
	if (!names.length) return [];

	const users = await db
		.select({
			id: subversiveTargetFinderUsers.tornId,
			name: subversiveTargetFinderUsers.tornName,
			factionId: subversiveTargetFinderUsers.factionId,
		})
		.from(subversiveTargetFinderUsers)
		.where(
			and(
				eq(subversiveTargetFinderUsers.isActive, true),
				or(
					...names.map(
						(name) =>
							sql`lower(${subversiveTargetFinderUsers.tornName}) = ${name}`,
					),
				),
			),
		);

	const tagged = users.filter(
		(user) =>
			user.id !== caller.id &&
			receives(context, {
				id: user.id,
				factionId: user.factionId,
				superadmin: false,
			}),
	);

	if (tagged.length) {
		await db
			.insert(chatMessageMentions)
			.values(
				tagged.map((user) => ({
					messageId,
					roomId: context.id,
					userId: user.id,
					name: user.name,
				})),
			)
			.onConflictDoNothing();
	}
	return tagged.map((user) => ({ id: user.id, name: user.name }));
}

async function pruneRoomHistory(roomId: string): Promise<void> {
	const [count] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(chatMessages)
		.where(eq(chatMessages.roomId, roomId));
	if (Number(count?.n ?? 0) <= CHAT_LIMITS.keptMessagesPerRoom) return;

	const cutoffRows = await db
		.select({ id: chatMessages.id })
		.from(chatMessages)
		.where(eq(chatMessages.roomId, roomId))
		.orderBy(desc(chatMessages.id))
		.offset(CHAT_LIMITS.keptMessagesPerRoom)
		.limit(1);
	const cutoff = cutoffRows[0]?.id;
	if (!cutoff) return;
	await db
		.delete(chatMessages)
		.where(and(eq(chatMessages.roomId, roomId), lte(chatMessages.id, cutoff)));
}

export async function seeMentions(
	caller: ChatCaller,
	roomId: string,
	idsInput: unknown,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !receives(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	const ids = Array.isArray(idsInput)
		? [
				...new Set(
					idsInput.filter(
						(value): value is number =>
							typeof value === "number" && Number.isInteger(value) && value > 0,
					),
				),
			].slice(0, CHAT_LIMITS.mentionsListed)
		: [];
	if (!ids.length) throw new ChatError(400, "No messages");

	const updated = await db
		.update(chatMessageMentions)
		.set({ seen: true })
		.where(
			and(
				eq(chatMessageMentions.userId, caller.id),
				eq(chatMessageMentions.roomId, roomId),
				eq(chatMessageMentions.seen, false),
				inArray(chatMessageMentions.messageId, ids),
			),
		)
		.returning({ messageId: chatMessageMentions.messageId });
	if (updated.length) {
		emit((stream) => stream.caller.id === caller.id, {
			t: "mentions_seen",
			roomId,
			ids,
		});
	}
}

export async function deleteMessage(
	caller: ChatCaller,
	roomId: string,
	messageId: number,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !canSee(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	const [message] = await db
		.select()
		.from(chatMessages)
		.where(
			and(
				eq(chatMessages.id, messageId),
				eq(chatMessages.roomId, roomId),
				eq(chatMessages.isDeleted, false),
			),
		);
	if (!message) throw new ChatError(404, "Message not found");
	if (message.userId !== caller.id && !canManage(context, caller)) {
		throw new ChatError(403, "You can only delete your own messages");
	}

	await db
		.update(chatMessages)
		.set({ isDeleted: true })
		.where(eq(chatMessages.id, messageId));
	await Promise.all([
		db
			.delete(chatMessageReactions)
			.where(eq(chatMessageReactions.messageId, messageId)),
		db
			.delete(chatMessageMentions)
			.where(eq(chatMessageMentions.messageId, messageId)),
	]);

	const [latest] = await db
		.select({ id: chatMessages.id })
		.from(chatMessages)
		.where(
			and(eq(chatMessages.roomId, roomId), eq(chatMessages.isDeleted, false)),
		)
		.orderBy(desc(chatMessages.id))
		.limit(1);
	await db
		.update(chatRooms)
		.set({ lastMessageId: latest?.id ?? 0 })
		.where(eq(chatRooms.id, roomId));

	emit((stream) => receives(context, stream.caller), {
		t: "msg_deleted",
		roomId,
		id: messageId,
	});
}

export async function react(
	caller: ChatCaller,
	roomId: string,
	messageId: number,
	emojiInput: unknown,
	on: boolean,
): Promise<ChatReactionsUpdate> {
	const context = await getRoomContext(roomId);
	if (!context || !receives(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	if (
		typeof emojiInput !== "string" ||
		!(CHAT_REACTIONS as readonly string[]).includes(emojiInput)
	) {
		throw new ChatError(400, "Unknown reaction");
	}
	const emoji = emojiInput;
	const [message] = await db
		.select({ id: chatMessages.id })
		.from(chatMessages)
		.where(
			and(
				eq(chatMessages.id, messageId),
				eq(chatMessages.roomId, roomId),
				eq(chatMessages.isDeleted, false),
			),
		);
	if (!message) throw new ChatError(404, "Message not found");

	let changed = false;
	if (on) {
		const inserted = await db
			.insert(chatMessageReactions)
			.values({ messageId, roomId, userId: caller.id, emoji })
			.onConflictDoNothing()
			.returning({ messageId: chatMessageReactions.messageId });
		changed = inserted.length > 0;
	} else {
		const deleted = await db
			.delete(chatMessageReactions)
			.where(
				and(
					eq(chatMessageReactions.messageId, messageId),
					eq(chatMessageReactions.userId, caller.id),
					eq(chatMessageReactions.emoji, emoji),
				),
			)
			.returning({ messageId: chatMessageReactions.messageId });
		changed = deleted.length > 0;
	}

	const update: ChatReactionsUpdate = {
		roomId,
		id: messageId,
		reactions: (await reactionsForMessages([messageId])).get(messageId) ?? [],
	};

	if (changed) {
		await db
			.update(chatMessages)
			.set({ reactionSeq: sql`nextval('chat_reaction_seq')` })
			.where(eq(chatMessages.id, messageId));
		emit((stream) => receives(context, stream.caller), {
			t: "reactions",
			...update,
		});
	}
	return update;
}

// ---------------------------------------------------------------- typing

const typing = new Map<string, Map<number, { name: string; at: number }>>();

function typers(roomId: string): ChatTypingUser[] {
	const users = typing.get(roomId);
	if (!users) return [];
	const now = Date.now();
	const live: ChatTypingUser[] = [];
	for (const [userId, entry] of users) {
		const ms = CHAT_LIMITS.typingMs - (now - entry.at);
		if (ms > 0) live.push({ userId, name: entry.name, ms });
		else users.delete(userId);
	}
	if (!users.size) typing.delete(roomId);
	return live;
}

export async function setTyping(
	caller: ChatCaller,
	roomId: string,
): Promise<void> {
	const context = await getRoomContext(roomId);
	if (!context || !receives(context, caller) || !canPost(context, caller)) {
		throw new ChatError(404, "Room not found");
	}
	let users = typing.get(roomId);
	if (!users) typing.set(roomId, (users = new Map()));
	users.set(caller.id, { name: caller.name, at: Date.now() });
	emit(
		(stream) =>
			stream.caller.id !== caller.id && receives(context, stream.caller),
		{ t: "typing", roomId, users: typers(roomId) },
	);
}

// ---------------------------------------------------------------- snapshot / poll

export async function snapshot(
	caller: ChatCaller,
	open: string,
): Promise<{
	me: ChatMe;
	gif: ChatGifConfig;
	rooms: ChatRoomView[];
	history: Record<string, ChatMessageView[]>;
}> {
	const ids = [
		...new Set(
			open
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean),
		),
	].slice(0, CHAT_LIMITS.helloRooms);

	const [rooms, histories] = await Promise.all([
		listRooms(caller),
		Promise.all(
			ids.map(async (id) => {
				try {
					return [id, await history(caller, id, 0)] as const;
				} catch {
					return null;
				}
			}),
		),
	]);

	const historyMap: Record<string, ChatMessageView[]> = {};
	for (const entry of histories) {
		if (entry) historyMap[entry[0]] = entry[1];
	}
	return {
		me: buildChatMe(caller),
		gif: getGifConfig(),
		rooms,
		history: historyMap,
	};
}

async function messageCursors(): Promise<{
	cursor: number;
	reactionCursor: number;
}> {
	const rows = await db.execute<{
		cursor: string;
		reaction_cursor: string;
	}>(sql`
		SELECT
			COALESCE(MAX(${chatMessages.id}), 0)::text AS cursor,
			COALESCE(MAX(${chatMessages.reactionSeq}), 0)::text AS reaction_cursor
		FROM ${chatMessages}
	`);
	const row = rows[0];
	return {
		cursor: Number(row?.cursor ?? 0),
		reactionCursor: Number(row?.reaction_cursor ?? 0),
	};
}

export async function poll(
	caller: ChatCaller,
	open: string,
	after?: string,
	reactionsAfter?: string,
): Promise<ChatPollResponse> {
	const { cursor, reactionCursor } = await messageCursors();
	const readableCache = new Map<string, boolean>();
	const readable = async (roomId: string): Promise<boolean> => {
		const cached = readableCache.get(roomId);
		if (cached !== undefined) return cached;
		const context = await getRoomContext(roomId);
		const allowed = context ? receives(context, caller) : false;
		readableCache.set(roomId, allowed);
		return allowed;
	};

	const since = Number(after);
	const reactionSince = Number(reactionsAfter);
	const hasAfter = after !== undefined && Number.isInteger(since) && since >= 0;
	const hasReactionAfter =
		reactionsAfter !== undefined &&
		Number.isInteger(reactionSince) &&
		reactionSince >= 0;

	const typingOut: Record<string, ChatTypingUser[]> = {};
	for (const roomId of typing.keys()) {
		const context = await getRoomContext(roomId);
		const users = context
			? typers(roomId).filter(
					(user) => user.userId !== caller.id && receives(context, caller),
				)
			: [];
		if (users.length) typingOut[roomId] = users;
	}

	if (!hasAfter) {
		const snap = await snapshot(caller, open);
		return {
			...snap,
			messages: [],
			cursor,
			reactions: [],
			reactionCursor,
			typing: typingOut,
		};
	}

	const [rooms, messageRows, reactionRows] = await Promise.all([
		listRooms(caller),
		db
			.select()
			.from(chatMessages)
			.where(
				and(
					gt(chatMessages.id, since),
					lte(chatMessages.id, cursor),
					eq(chatMessages.isDeleted, false),
				),
			)
			.orderBy(asc(chatMessages.id))
			.limit(500),
		hasReactionAfter
			? db
					.select()
					.from(chatMessages)
					.where(
						and(
							gt(chatMessages.reactionSeq, reactionSince),
							lte(chatMessages.reactionSeq, reactionCursor),
							eq(chatMessages.isDeleted, false),
						),
					)
					.orderBy(asc(chatMessages.reactionSeq))
					.limit(500)
			: Promise.resolve([] as ChatMessageRow[]),
	]);

	const visible = [];
	for (const row of messageRows) {
		if (await readable(row.roomId)) visible.push(row);
	}
	const reactionViews = await withExtras(
		(
			await Promise.all(
				reactionRows.map(async (row) =>
					(await readable(row.roomId)) ? row : null,
				),
			)
		).filter((row): row is ChatMessageRow => row !== null),
	);

	return {
		me: buildChatMe(caller),
		gif: getGifConfig(),
		rooms,
		history: {},
		messages: await withExtras(visible),
		cursor,
		reactions: reactionViews.map((message) => ({
			roomId: message.roomId,
			id: message.id,
			reactions: message.reactions,
		})),
		reactionCursor,
		typing: typingOut,
	};
}

// ---------------------------------------------------------------- avatar

export async function setAvatarConsent(
	caller: ChatCaller,
	show: boolean,
	avatarUrl: string | null,
): Promise<ChatMe> {
	const url = show ? avatarUrl : null;
	await ensureChatUserSettings(caller.id);
	await db
		.update(chatUserSettings)
		.set({ showAvatar: show, avatarUrl: url, updatedAt: new Date() })
		.where(eq(chatUserSettings.tornId, caller.id));
	await db
		.update(chatMessages)
		.set({ avatarUrl: url })
		.where(eq(chatMessages.userId, caller.id));
	caller.showAvatar = show;
	caller.avatar = url;
	return buildChatMe(caller);
}

// ---------------------------------------------------------------- rate limits

class SlidingWindowLimiter {
	private hits = new Map<string, number[]>();
	private calls = 0;

	allow(key: string, limit: number, windowMs: number): boolean {
		const now = Date.now();
		if (++this.calls % 1000 === 0) {
			for (const [id, timestamps] of this.hits) {
				const last = timestamps[timestamps.length - 1];
				if (last === undefined || now - last > 3_600_000) this.hits.delete(id);
			}
		}
		const recent = (this.hits.get(key) ?? []).filter(
			(at) => now - at < windowMs,
		);
		if (recent.length >= limit) {
			this.hits.set(key, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(key, recent);
		return true;
	}

	check(key: string, limit: number, windowMs: number): void {
		if (!this.allow(key, limit, windowMs))
			throw new ChatError(429, "Slow down");
	}
}

const rateLimiter = new SlidingWindowLimiter();

export function enforceReadLimit(caller: ChatCaller): void {
	rateLimiter.check(`read:${caller.id}`, CHAT_LIMITS.readsPerMinute, 60_000);
}

export function enforceWriteLimit(caller: ChatCaller): void {
	rateLimiter.check(`write:${caller.id}`, CHAT_LIMITS.writesPerMinute, 60_000);
}

export function enforceInviteLimit(caller: ChatCaller): void {
	rateLimiter.check(
		`invite:${caller.id}`,
		CHAT_LIMITS.invitesPerHour,
		3_600_000,
	);
}

export function enforceTypingLimit(caller: ChatCaller): void {
	rateLimiter.check(`typing:${caller.id}`, CHAT_LIMITS.typingPerMinute, 60_000);
}

// ---------------------------------------------------------------- live streams

export interface ChatStream {
	id: string;
	caller: ChatCaller;
	writer: WritableStreamDefaultWriter<Uint8Array>;
}

const encoder = new TextEncoder();
const streams = new Set<ChatStream>();
let heartbeat: ReturnType<typeof setInterval> | null = null;

function writeFrame(stream: ChatStream, frame: string): void {
	stream.writer
		.write(encoder.encode(frame))
		.catch(() => closeChatStream(stream));
}

function closeChatStream(stream: ChatStream, lastFrame?: string): void {
	if (!streams.delete(stream)) return;
	const finish = () => stream.writer.close().catch(() => {});
	if (lastFrame) writeFrame(stream, lastFrame);
	finish();
	if (streams.size === 0 && heartbeat) {
		clearInterval(heartbeat);
		heartbeat = null;
	}
}

function emit(
	filter: (stream: ChatStream) => boolean,
	event: ChatServerEvent | null,
): void {
	const frame = event ? `data: ${JSON.stringify(event)}\n\n` : ": ping\n\n";
	for (const stream of [...streams]) {
		if (!filter(stream)) continue;
		writeFrame(stream, frame);
	}
}

export function openChatStream(
	caller: ChatCaller,
	writer: WritableStreamDefaultWriter<Uint8Array>,
): ChatStream {
	const stream: ChatStream = { id: crypto.randomUUID(), caller, writer };
	const mine = [...streams].filter(
		(candidate) => candidate.caller.id === caller.id,
	);
	for (const old of mine.slice(
		0,
		Math.max(0, mine.length - CHAT_LIMITS.streamsPerUser + 1),
	)) {
		closeChatStream(old, "event: replaced\ndata: {}\n\n");
	}
	streams.add(stream);
	if (!heartbeat) {
		heartbeat = setInterval(() => emit(() => true, null), 20_000);
		heartbeat.unref?.();
	}
	return stream;
}

export function closeChatStreamFromRoute(stream: ChatStream): void {
	closeChatStream(stream);
}

export function dropUserStreams(userId: number): void {
	for (const stream of [...streams]) {
		if (stream.caller.id === userId) {
			closeChatStream(stream, "event: banned\ndata: {}\n\n");
		}
	}
}

export function broadcastRoomsChanged(exceptUserId?: number): void {
	emit((stream) => stream.caller.id !== exceptUserId, { t: "rooms_changed" });
}
