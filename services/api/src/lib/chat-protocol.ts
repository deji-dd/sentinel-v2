/**
 * Wire types for the Subversive chat feature.
 *
 * The userscript has a mirror of this file at
 * `scripts/subversive/src/chat/protocol.ts`; the build for the script is
 * standalone, so the two files are kept in sync by hand. Change both whenever a
 * field is added.
 */

export type ChatVisibility = "public" | "private";
export type ChatPostPolicy = "everyone" | "admins";
export type ChatRole = "owner" | "admin" | "member";
export type ChatGrantKind = "player" | "faction";

export interface ChatMe {
	id: number;
	name: string;
	factionId: number | null;
	factionTag: string | null;
	avatar: string | null;
	/** The player agreed to show their Torn profile picture next to their messages. */
	showAvatar: boolean;
	superadmin: boolean;
}

/** A GIF attached to a message; only provider URLs are accepted by the server. */
export interface ChatGif {
	url: string;
	/** Natural size when known; 0 lets the client size it from the image. */
	width: number;
	height: number;
	title: string;
}

export interface ChatMessageView {
	id: number;
	roomId: string;
	userId: number;
	name: string;
	avatar: string | null;
	/** The sender's faction tag when they posted; shown only in rooms with showFactionTags. */
	factionTag: string | null;
	text: string;
	/** Epoch milliseconds. */
	ts: number;
	/** In the order they were first used. */
	reactions: ChatReactionView[];
	/** Players the text tags with `@Name`, resolved by the server among the room's members. */
	mentions: ChatMentionView[];
	gif: ChatGif | null;
}

export interface ChatMentionView {
	id: number;
	name: string;
}

/**
 * `@Name` in a message: Torn names are letters, digits, `_` and `-`. Not after
 * a letter, digit or `@`, so an email address tags nobody. Group 1 is the name.
 */
export const CHAT_MENTION = /(?<![A-Za-z0-9_@])@([A-Za-z0-9_-]{1,32})/g;

/** The reactions a message can get: the picker behind the bubble on a hovered message. */
export const CHAT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;

export interface ChatReactionView {
	emoji: string;
	users: { id: number; name: string }[];
}

export interface ChatReactionsUpdate {
	roomId: string;
	id: number;
	reactions: ChatReactionView[];
}

export interface ChatRoomView {
	id: string;
	name: string;
	description: string;
	topic: string;
	/** Name of one of Torn's room icons; empty for the default chat icon. */
	icon: string;
	/** Header and bar button colour, `#rrggbb`; empty for Torn's default grey. */
	color: string;
	visibility: ChatVisibility;
	postPolicy: ChatPostPolicy;
	/** Senders appear as `[TAG] Name` (set by the room's owner or admins). */
	showFactionTags: boolean;
	ownerId: number;
	role: ChatRole;
	/** false: shared with you (player or faction) but you have not opened it yet. */
	joined: boolean;
	canPost: boolean;
	lastMessage: ChatMessageView | null;
	lastReadId: number;
	/** Messages from others after lastReadId, capped at 100. */
	unread: number;
	/** Messages tagging you that you have not seen yet, oldest first (at most 99). */
	mentions: number[];
}

export interface ChatBrowseRoom {
	id: string;
	name: string;
	description: string;
	topic: string;
	icon: string;
	color: string;
	memberCount: number;
	joined: boolean;
}

export interface ChatGrantView {
	kind: ChatGrantKind;
	id: number;
	label: string;
	addedBy: number;
	addedAt: number;
}

export interface ChatMemberView {
	id: number;
	name: string;
	role: ChatRole;
}

export interface ChatBanView {
	id: number;
	label: string;
	bannedAt: number;
}

export interface ChatAccessView {
	grants: ChatGrantView[];
	members: ChatMemberView[];
	bans: ChatBanView[];
}

/** Someone typing in a room; `ms` is how long to keep showing them unless they ping again. */
export interface ChatTypingUser {
	userId: number;
	name: string;
	ms: number;
}

export interface ChatGifConfig {
	enabled: boolean;
	provider: "klipy" | null;
	/**
	 * The client-side KLIPY app key, sent only on the authenticated `/me`
	 * response. Search requests go directly from the browser to KLIPY.
	 */
	apiKey?: string;
}

export interface ChatGifResult {
	id: string;
	url: string;
	previewUrl: string;
	width: number;
	height: number;
	title: string;
}

export type ChatServerEvent =
	/** First event of every stream: who we are, the room list and the history of open rooms. */
	| {
			t: "hello";
			me: ChatMe;
			gif: ChatGifConfig;
			rooms: ChatRoomView[];
			history: Record<string, ChatMessageView[]>;
	  }
	| { t: "msg"; msg: ChatMessageView }
	| { t: "msg_deleted"; roomId: string; id: number }
	| ({ t: "reactions" } & ChatReactionsUpdate)
	| { t: "typing"; roomId: string; users: ChatTypingUser[] }
	| { t: "mentions_seen"; roomId: string; ids: number[] }
	| { t: "rooms_changed" };

export interface ChatPollResponse {
	me: ChatMe;
	gif: ChatGifConfig;
	rooms: ChatRoomView[];
	history: Record<string, ChatMessageView[]>;
	messages: ChatMessageView[];
	cursor: number;
	/** messages whose reactions changed after `reactionsAfter` (none without it) */
	reactions: ChatReactionsUpdate[];
	reactionCursor: number;
	typing: Record<string, ChatTypingUser[]>;
}

export const CHAT_LIMITS = {
	roomName: 50,
	description: 200,
	topic: 30,
	message: 2000,
	label: 60,
	ownedRooms: 10,
	grantsPerRoom: 200,
	adminsPerRoom: 20,
	historyPage: 50,
	helloRooms: 10,
	keptMessagesPerRoom: 5000,
	/** messages per window per user */
	rateCount: 5,
	rateWindowMs: 5000,
	/** any change (post, invite, join, settings) per user per minute */
	writesPerMinute: 60,
	invitesPerHour: 50,
	mentionsPerMessage: 20,
	mentionsListed: 99,
	/** reads (polls, history, lists) per user per minute; a polling client uses ~15 */
	readsPerMinute: 240,
	/** poll intervals: a room panel open, only the bar or the list (none in the background) */
	pollMs: 4000,
	pollIdleMs: 15000,
	typingPingMs: 3000,
	typingMs: 6000,
	typingPerMinute: 30,
	/** event streams per user: a few Torn tabs */
	streamsPerUser: 5,
	gifUrl: 500,
	gifTitle: 120,
} as const;

const GIF_HOSTS = [
	/(^|\.)tenor\.com$/i,
	/(^|\.)giphy\.com$/i,
	/(^|\.)klipy\.com$/i,
	/(^|\.)imgur\.com$/i,
];

const GIF_PATH = /\.(gif|webp|png|jpe?g)(?:$|[?#])/i;

/**
 * Validates a client-supplied GIF descriptor. Only https image URLs from the
 * providers the picker uses are accepted, so a message can never make every
 * member of a room load a tracking pixel from an arbitrary host.
 */
export function normalizeChatGif(raw: unknown): ChatGif | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	const url = typeof value.url === "string" ? value.url.trim() : "";
	if (!url || url.length > CHAT_LIMITS.gifUrl) return null;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (!GIF_HOSTS.some((host) => host.test(parsed.hostname))) return null;
	if (
		!GIF_PATH.test(parsed.pathname) &&
		!GIF_PATH.test(`${parsed.pathname}${parsed.search}`)
	) {
		return null;
	}

	const dimension = (input: unknown): number => {
		const n = typeof input === "number" ? input : Number(input);
		return Number.isFinite(n) && n > 0 ? Math.min(4096, Math.round(n)) : 0;
	};

	return {
		url,
		width: dimension(value.width),
		height: dimension(value.height),
		title:
			typeof value.title === "string"
				? value.title
						.replace(/[\u0000-\u001f\u007f]/g, "")
						.trim()
						.slice(0, CHAT_LIMITS.gifTitle)
				: "",
	};
}

/** A message that is just a provider image URL becomes a GIF attachment. */
export function chatGifFromText(text: string): ChatGif | null {
	const value = text.trim();
	if (!/^https:\/\//i.test(value) || /\s/.test(value)) return null;
	return normalizeChatGif({ url: value, width: 0, height: 0, title: "" });
}
