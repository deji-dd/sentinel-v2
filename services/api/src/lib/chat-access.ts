/**
 * Who can see, post in and manage a chat room. Pure functions over a loaded
 * room context, ported from Torn Rooms' access rules.
 */
import type { ChatRole } from "./chat-protocol";

export interface ChatViewer {
	id: number;
	factionId: number | null;
	superadmin: boolean;
}

export interface ChatRoomContext {
	id: string;
	visibility: "public" | "private";
	postPolicy: "everyone" | "admins";
	ownerId: number;
	admins: Set<number>;
	players: Set<number>;
	factions: Set<number>;
	bans: Set<number>;
	/** membership state per user: "joined" or "left" */
	membership: Map<number, "joined" | "left">;
}

export function canSee(room: ChatRoomContext, viewer: ChatViewer): boolean {
	if (room.bans.has(viewer.id)) return false;
	if (room.visibility === "public") return true;
	return (
		room.ownerId === viewer.id ||
		room.admins.has(viewer.id) ||
		room.players.has(viewer.id) ||
		(viewer.factionId !== null && room.factions.has(viewer.factionId))
	);
}

export function roleOf(room: ChatRoomContext, viewer: ChatViewer): ChatRole {
	if (room.ownerId === viewer.id) return "owner";
	if (room.admins.has(viewer.id)) return "admin";
	// Superadmins moderate public rooms; private rooms stay private.
	if (viewer.superadmin && room.visibility === "public") return "admin";
	return "member";
}

export function isJoined(room: ChatRoomContext, viewer: ChatViewer): boolean {
	return room.membership.get(viewer.id) === "joined";
}

/** In the viewer's list: joined rooms they can see, plus private rooms shared with them they have not left. */
export function isListed(room: ChatRoomContext, viewer: ChatViewer): boolean {
	if (!canSee(room, viewer)) return false;
	const state = room.membership.get(viewer.id);
	if (state === "joined") return true;
	return room.visibility === "private" && state === undefined;
}

export function canManage(room: ChatRoomContext, viewer: ChatViewer): boolean {
	return canSee(room, viewer) && roleOf(room, viewer) !== "member";
}

export function canPost(room: ChatRoomContext, viewer: ChatViewer): boolean {
	if (!canSee(room, viewer) || !isJoined(room, viewer)) return false;
	return room.postPolicy === "everyone" || roleOf(room, viewer) !== "member";
}

/** Should this viewer receive live messages of the room. */
export function receives(room: ChatRoomContext, viewer: ChatViewer): boolean {
	return canSee(room, viewer) && isJoined(room, viewer);
}
