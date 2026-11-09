// Client state: who we are, our rooms, loaded messages, which panels are open.
import { api, type ConnState, pageUserId } from "./api";
import {
	CHAT_LIMITS,
	type ChatGif,
	type ChatGifConfig,
	type ChatMe,
	type ChatMessageView,
	type ChatReactionsUpdate,
	type ChatReactionView,
	type ChatRoomView,
	type ChatServerEvent,
	type ChatTypingUser,
} from "./protocol";

export type DirectoryTab = "rooms" | "invites" | "browse" | "settings";

/** Panel key of the Rooms (directory) panel; room panels use their room id. */
export const DIRECTORY = "directory";

const STORAGE_PREFIX = "satf_chat_";

function stored<T>(key: string, fallback: T): T {
	try {
		return GM_getValue<T>(`${STORAGE_PREFIX}${key}`, fallback);
	} catch {
		return fallback;
	}
}

function persistValue<T>(key: string, value: T): void {
	try {
		GM_setValue(`${STORAGE_PREFIX}${key}`, value);
	} catch {
		// Storage failing must not break the chat.
	}
}

export const state = {
	me: null as ChatMe | null,
	gif: { enabled: false, provider: null } as ChatGifConfig,
	rooms: new Map<string, ChatRoomView>(),
	messages: new Map<string, ChatMessageView[]>(),
	/** older history may exist */
	more: new Map<string, boolean>(),
	/** rooms with a button in the chat bar, in bar order */
	open: stored<string[]>("open", []),
	/** open rooms whose panel is expanded */
	expanded: new Set(stored<string[]>("expanded", [])),
	directory: stored<boolean>("directory", false),
	/** panel keys, rightmost first; a newly opened panel goes to the front, like Torn's */
	order: stored<string[]>("order", []),
	directoryTab: "rooms" as DirectoryTab,
	conn: "connecting" as ConnState,
	/** the first hello event arrived */
	ready: false,
	error: null as string | null,
	/** sent messages the server has not confirmed yet, in send order */
	pending: [] as PendingMessage[],
	/** Torn's message styling (its chat settings: Bubbles, Avatars), followed by our rooms */
	chatStyle: { bubbles: true, avatars: true },
	/** who else is typing, by room, until when */
	typing: new Map<string, { userId: number; name: string; until: number }[]>(),
};

type Listener = () => void;
const listeners = new Set<Listener>();
const messageListeners = new Set<
	(roomId: string, msg: ChatMessageView | null) => void
>();
const reactionListeners = new Set<(roomId: string, id: number) => void>();

export function subscribe(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Room panels listen here to append or remove single messages without re-rendering. */
export function onRoomMessage(
	fn: (roomId: string, msg: ChatMessageView | null) => void,
): () => void {
	messageListeners.add(fn);
	return () => messageListeners.delete(fn);
}

/** Room panels redraw one message's reactions from here. */
export function onReactions(
	fn: (roomId: string, id: number) => void,
): () => void {
	reactionListeners.add(fn);
	return () => reactionListeners.delete(fn);
}

let scheduled = false;
export function changed(): void {
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		for (const fn of listeners) fn();
	});
}

function persist(): void {
	persistValue("order", state.order);
	persistValue("open", state.open);
	persistValue("expanded", [...state.expanded]);
	persistValue("directory", state.directory);
}

/** After a consent change: show or hide our own picture on messages already loaded. */
export function setOwnAvatar(show: boolean): void {
	const me = state.me;
	if (!me) return;
	me.showAvatar = show;
	const avatar = show ? me.avatar : null;
	for (const [roomId, list] of state.messages) {
		let touched = false;
		for (const message of list) {
			if (message.userId === me.id) {
				message.avatar = avatar;
				touched = true;
			}
		}
		if (touched) for (const fn of messageListeners) fn(roomId, null);
	}
	changed();
}

export function setError(message: string | null): void {
	state.error = message;
	changed();
}

/** Called with a fresh /me response so the client knows its own identity and GIF availability. */
export function applyMe(me: ChatMe, gif?: ChatGifConfig): void {
	state.me = me;
	if (gif) state.gif = gif;
	changed();
}

// ---------------------------------------------------------------- rooms

export async function refreshRooms(): Promise<void> {
	const { rooms } = await api<{ rooms: ChatRoomView[] }>(
		"GET",
		"/v2/chat/rooms",
	);
	setRooms(rooms);
}

function setRooms(rooms: ChatRoomView[]): void {
	// Mentions seen here stay seen while the server has not heard about it yet.
	for (const room of rooms) {
		room.mentions = (room.mentions ?? []).filter((id) => !seenMentions.has(id));
	}
	state.rooms = new Map(rooms.map((room) => [room.id, room]));
	// Drop bar buttons for rooms we lost access to.
	const before = state.open.length;
	state.open = state.open.filter((id) => state.rooms.get(id)?.joined);
	for (const id of state.expanded) {
		if (!state.open.includes(id)) state.expanded.delete(id);
	}
	if (state.open.length !== before) persist();
	changed();
}

export function joinedRooms(): ChatRoomView[] {
	return [...state.rooms.values()]
		.filter((room) => room.joined)
		.sort((a, b) => (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0));
}

export function invites(): ChatRoomView[] {
	return [...state.rooms.values()].filter((room) => !room.joined);
}

function toFront(key: string): void {
	state.order = [key, ...state.order.filter((k) => k !== key)];
}

/** Keys of the visible panels, rightmost first. */
export function visiblePanels(): string[] {
	const keys = [
		...(state.directory ? [DIRECTORY] : []),
		...state.open.filter((id) => state.expanded.has(id) && state.rooms.has(id)),
	];
	// Keys missing from the saved order (state from before ordering existed) go to the left end.
	const rank = (key: string) => {
		const index = state.order.indexOf(key);
		return index < 0 ? Number.MAX_SAFE_INTEGER : index;
	};
	return keys.sort((a, b) => rank(a) - rank(b));
}

function arrayMove<T>(list: T[], item: T, target: T): T[] {
	const from = list.indexOf(item);
	const to = list.indexOf(target);
	if (from < 0 || to < 0 || from === to) return list;
	const next = [...list];
	next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}

/** Panels that no longer fit on screen: rooms go back to their bar button, the Rooms panel closes. */
export function minimizePanels(keys: string[]): void {
	for (const key of keys) {
		if (key === DIRECTORY) state.directory = false;
		else state.expanded.delete(key);
	}
	persist();
	changed();
}

/** Drop a dragged panel onto another panel's slot. */
export function movePanel(key: string, target: string): void {
	const visible = arrayMove(visiblePanels(), key, target);
	state.order = [
		...visible,
		...state.order.filter((k) => !visible.includes(k)),
	];
	persist();
	changed();
}

/** Drop a dragged chat-bar button onto another button's slot. */
export function moveBarButton(id: string, target: string): void {
	state.open = arrayMove(state.open, id, target);
	persist();
	changed();
}

export function openRoom(id: string): void {
	if (!state.open.includes(id)) state.open.push(id);
	if (!state.expanded.has(id)) toFront(id);
	state.expanded.add(id);
	persist();
	changed();
}

export function toggleRoom(id: string): void {
	if (state.expanded.has(id)) state.expanded.delete(id);
	else {
		state.expanded.add(id);
		toFront(id);
	}
	persist();
	changed();
}

export function closeRoom(id: string): void {
	state.open = state.open.filter((x) => x !== id);
	state.expanded.delete(id);
	persist();
	changed();
}

export function toggleDirectory(open = !state.directory): void {
	if (open && !state.directory) toFront(DIRECTORY);
	state.directory = open;
	persist();
	changed();
}

export function setDirectoryTab(tab: DirectoryTab): void {
	state.directoryTab = tab;
	changed();
}

export async function join(id: string): Promise<void> {
	const { room } = await api<{ room: ChatRoomView }>(
		"POST",
		`/v2/chat/rooms/${id}/join`,
	);
	state.rooms.set(id, room);
	openRoom(id);
}

export async function leave(id: string): Promise<void> {
	await api("POST", `/v2/chat/rooms/${id}/leave`);
	closeRoom(id);
	state.rooms.delete(id);
	state.messages.delete(id);
	changed();
}

export async function deleteRoom(id: string): Promise<void> {
	await api("DELETE", `/v2/chat/rooms/${id}`);
	closeRoom(id);
	state.rooms.delete(id);
	changed();
}

// ---------------------------------------------------------------- messages

export async function loadHistory(id: string, older = false): Promise<void> {
	const list = state.messages.get(id) ?? [];
	const before = older && list.length ? (list[0]?.id ?? 0) : 0;
	const { messages } = await api<{ messages: ChatMessageView[] }>(
		"GET",
		`/v2/chat/rooms/${id}/messages${before ? `?before=${before}` : ""}`,
	);
	const merged = new Map(
		(older ? [...messages, ...list] : [...list, ...messages]).map((m) => [
			m.id,
			m,
		]),
	);
	state.messages.set(
		id,
		[...merged.values()].sort((a, b) => a.id - b.id),
	);
	state.more.set(id, messages.length === CHAT_LIMITS.historyPage);
	changed();
}

/** A message shown right away, before the server confirms it, as in Torn's chat. */
export interface PendingMessage {
	reqId: number;
	roomId: string;
	text: string;
	gif: ChatGif | null;
	ts: number;
	failed: boolean;
}

let reqSeq = 0;
export function send(
	roomId: string,
	text: string,
	gif: ChatGif | null = null,
): Promise<void> {
	const pending: PendingMessage = {
		reqId: ++reqSeq,
		roomId,
		text,
		gif,
		ts: Date.now(),
		failed: false,
	};
	state.pending.push(pending);
	changed();
	return post(pending);
}

/** Sends a "Not sent" message again, in its place. */
export function retry(pending: PendingMessage): Promise<void> {
	pending.failed = false;
	pending.ts = Date.now();
	changed();
	return post(pending);
}

export function discard(pending: PendingMessage): void {
	state.pending = state.pending.filter((x) => x !== pending);
	changed();
}

async function post(pending: PendingMessage): Promise<void> {
	const fail = () => {
		if (!state.pending.includes(pending)) return;
		pending.failed = true;
		changed();
	};
	// As Torn: no answer within 15 seconds counts as not sent (it still lands if the answer comes later).
	const timer = setTimeout(fail, 15_000);
	try {
		const { message } = await api<{ message: ChatMessageView }>(
			"POST",
			`/v2/chat/rooms/${pending.roomId}/messages`,
			{
				text: pending.text,
				gif: pending.gif,
			},
		);
		addMessage(message);
		discard(pending); // already gone when the stream delivered it first
		markRead(pending.roomId);
	} catch (error) {
		fail();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function applyReactions(update: ChatReactionsUpdate): void {
	const message = state.messages
		.get(update.roomId)
		?.find((m) => m.id === update.id);
	if (!message) return;
	message.reactions = update.reactions;
	for (const fn of reactionListeners) fn(update.roomId, update.id);
}

/** Adds our reaction, or takes it back when it is already there: shown at once, settled by the server's answer. */
export async function react(
	roomId: string,
	id: number,
	emoji: string,
): Promise<void> {
	const me = state.me;
	const message = state.messages.get(roomId)?.find((m) => m.id === id);
	if (!me || !message) return;
	const before = message.reactions ?? [];
	const on = !before.some(
		(reaction) =>
			reaction.emoji === emoji &&
			reaction.users.some((user) => user.id === me.id),
	);
	const next = before
		.map((reaction) =>
			reaction.emoji !== emoji
				? reaction
				: {
						...reaction,
						users: on
							? [...reaction.users, { id: me.id, name: me.name }]
							: reaction.users.filter((user) => user.id !== me.id),
					},
		)
		.filter((reaction) => reaction.users.length);
	if (on && !before.some((reaction) => reaction.emoji === emoji)) {
		next.push({ emoji, users: [{ id: me.id, name: me.name }] });
	}
	applyReactions({ roomId, id, reactions: next });
	try {
		applyReactions(
			await api<ChatReactionsUpdate>(
				"POST",
				`/v2/chat/rooms/${roomId}/messages/${id}/reactions`,
				{ emoji, on },
			),
		);
	} catch (error) {
		applyReactions({ roomId, id, reactions: before });
		throw error;
	}
}

/** The sender as shown in a room: `[TAG] Name` when the room shows faction tags. */
export function senderName(
	room: ChatRoomView | undefined,
	message: ChatMessageView,
): string {
	return room?.showFactionTags && message.factionTag
		? `[${message.factionTag}] ${message.name}`
		: message.name;
}

/**
 * Re-reads the player's Torn chat settings (Bubbles, Avatars) from the data
 * Torn's chat saves in this browser. Only how our rooms look depends on it;
 * nothing is sent anywhere.
 */
export function syncChatStyle(): void {
	let bubbles = true;
	let avatars = true;
	try {
		const keys = Object.keys(localStorage).filter((key) =>
			key.startsWith("tchat_query_cache:"),
		);
		const key =
			keys.find((candidate) => candidate.endsWith(`:${pageUserId()}`)) ??
			keys[0];
		const cache = JSON.parse(localStorage.getItem(key ?? "") ?? "null") as {
			clientState?: {
				queries?: {
					queryKey: unknown[];
					state?: { data?: Record<string, unknown> };
				}[];
			};
		} | null;
		const settings = cache?.clientState?.queries?.find(
			(query) =>
				query.queryKey[0] === "user" && query.queryKey[1] === "settings",
		)?.state?.data;
		if (settings?.showBubbles === false) bubbles = false;
		if (settings?.showAvatars === false) avatars = false;
	} catch {
		// Torn's defaults: bubbles and avatars
	}
	if (
		bubbles === state.chatStyle.bubbles &&
		avatars === state.chatStyle.avatars
	) {
		return;
	}
	state.chatStyle = { bubbles, avatars };
	changed();
}

let typingTimer: ReturnType<typeof setTimeout> | undefined;
function setTyping(roomId: string, users: ChatTypingUser[]): void {
	const now = Date.now();
	state.typing.set(
		roomId,
		users
			.filter((user) => user.userId !== state.me?.id)
			.map((user) => ({
				userId: user.userId,
				name: user.name,
				until: now + user.ms,
			})),
	);
	pruneTyping();
}

/** Drops typers whose last ping ran out, and comes back when the next one does. */
function pruneTyping(): void {
	const now = Date.now();
	let next = Number.POSITIVE_INFINITY;
	for (const [id, users] of state.typing) {
		const live = users.filter((user) => user.until > now);
		if (live.length) state.typing.set(id, live);
		else state.typing.delete(id);
		for (const user of live) next = Math.min(next, user.until);
	}
	clearTimeout(typingTimer);
	if (next < Number.POSITIVE_INFINITY) {
		typingTimer = setTimeout(pruneTyping, next - now + 20);
	}
	changed();
}

/** Mentions of us we saw, by message id (ids are global): never shown as unseen again in this tab. */
const seenMentions = new Set<number>();
const seenQueue = new Map<string, Set<number>>();
let seenTimer: ReturnType<typeof setTimeout> | undefined;

/** We saw these messages tagging us: off the room's @ button now, told to the server shortly after (batched). */
export function seeMentions(roomId: string, ids: number[]): void {
	const room = state.rooms.get(roomId);
	const fresh = ids.filter((id) => !seenMentions.has(id));
	if (!fresh.length) return;
	for (const id of fresh) seenMentions.add(id);
	if (room)
		room.mentions = (room.mentions ?? []).filter((id) => !seenMentions.has(id));
	changed();
	let queue = seenQueue.get(roomId);
	if (!queue) seenQueue.set(roomId, (queue = new Set()));
	for (const id of fresh) queue.add(id);
	clearTimeout(seenTimer);
	seenTimer = setTimeout(() => {
		for (const [id, set] of seenQueue) {
			api("POST", `/v2/chat/rooms/${id}/mentions/seen`, {
				ids: [...set],
			}).catch(() => {});
		}
		seenQueue.clear();
	}, 300);
}

/** Does the message tag us? */
export function tagsMe(message: ChatMessageView): boolean {
	return (
		!!state.me &&
		message.userId !== state.me.id &&
		(message.mentions ?? []).some((mention) => mention.id === state.me?.id)
	);
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Marks everything loaded in the room as read (debounced). */
export function markRead(id: string): void {
	const room = state.rooms.get(id);
	const last = room?.lastMessage?.id ?? 0;
	if (!room || !room.joined || (room.unread === 0 && room.lastReadId >= last)) {
		return;
	}
	room.unread = 0;
	room.lastReadId = last;
	changed();
	clearTimeout(readTimers.get(id));
	readTimers.set(
		id,
		setTimeout(
			() =>
				api("POST", `/v2/chat/rooms/${id}/read`, { id: last }).catch(() => {}),
			500,
		),
	);
}

function addMessage(message: ChatMessageView): void {
	// Our own message confirmed: it replaces its pending copy (the oldest with the same text).
	if (message.userId === state.me?.id) {
		const index = state.pending.findIndex(
			(pending) =>
				pending.roomId === message.roomId &&
				pending.text === message.text &&
				(pending.gif?.url ?? null) === (message.gif?.url ?? null),
		);
		if (index >= 0) state.pending.splice(index, 1);
	}
	const list = state.messages.get(message.roomId);
	if (list && !list.some((existing) => existing.id === message.id)) {
		list.push(message);
		for (const fn of messageListeners) fn(message.roomId, message);
	}
	const room = state.rooms.get(message.roomId);
	if (
		room &&
		tagsMe(message) &&
		!seenMentions.has(message.id) &&
		!(room.mentions ?? []).includes(message.id)
	) {
		room.mentions = [...(room.mentions ?? []), message.id].sort(
			(a, b) => a - b,
		);
	}
	if (room && (!room.lastMessage || room.lastMessage.id < message.id)) {
		room.lastMessage = message;
		if (message.userId !== state.me?.id) room.unread += 1;
		else room.lastReadId = message.id;
	}
	changed();
}

export function handleEvent(event: ChatServerEvent): void {
	if (event.t === "hello") {
		state.me = event.me;
		// The app key is only sent on /me; hello/poll carry the config without it.
		state.gif = { ...event.gif, apiKey: event.gif.apiKey ?? state.gif.apiKey };
		for (const [id, messages] of Object.entries(event.history)) {
			state.messages.set(id, messages);
			state.more.set(id, messages.length === CHAT_LIMITS.historyPage);
			for (const fn of messageListeners) fn(id, null);
		}
		state.ready = true;
		setRooms(event.rooms);
	} else if (event.t === "msg") {
		addMessage(event.msg);
		// Sending ends typing.
		const typers = state.typing.get(event.msg.roomId);
		if (typers) {
			state.typing.set(
				event.msg.roomId,
				typers.filter((user) => user.userId !== event.msg.userId),
			);
		}
		// A message in a room we have joined but not opened in this tab: show its button, like Torn does.
		if (
			!state.open.includes(event.msg.roomId) &&
			state.rooms.get(event.msg.roomId)?.joined
		) {
			state.open.push(event.msg.roomId);
			persist();
		}
	} else if (event.t === "msg_deleted") {
		const list = state.messages.get(event.roomId);
		if (list) {
			state.messages.set(
				event.roomId,
				list.filter((message) => message.id !== event.id),
			);
		}
		const room = state.rooms.get(event.roomId);
		if (room?.mentions?.includes(event.id)) {
			room.mentions = room.mentions.filter((id) => id !== event.id);
		}
		for (const fn of messageListeners) fn(event.roomId, null);
		changed();
		refreshRooms().catch(() => {});
	} else if (event.t === "reactions") {
		applyReactions(event);
	} else if (event.t === "typing") {
		setTyping(event.roomId, event.users);
	} else if (event.t === "mentions_seen") {
		for (const id of event.ids) seenMentions.add(id);
		const room = state.rooms.get(event.roomId);
		if (room) {
			room.mentions = (room.mentions ?? []).filter(
				(id) => !seenMentions.has(id),
			);
		}
		changed();
	} else if (event.t === "rooms_changed") {
		refreshRooms().catch(() => {});
	}
}

/** Our own identity, for panels opened before the first hello. */
export function selfId(): number | null {
	return state.me?.id ?? null;
}

/** Placeholder used by pending rows so they follow Torn's bubble style. */
export function messageReactionsOf(
	message: ChatMessageView,
): ChatReactionView[] {
	return message.reactions ?? [];
}
