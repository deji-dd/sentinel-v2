import { describe, expect, it } from "bun:test";

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
} from "../src/lib/chat-access";
import { chatGifFromText, normalizeChatGif } from "../src/lib/chat-protocol";

function context(overrides: Partial<ChatRoomContext> = {}): ChatRoomContext {
	return {
		id: "room",
		visibility: "private",
		postPolicy: "everyone",
		ownerId: 1,
		admins: new Set(),
		players: new Set(),
		factions: new Set(),
		bans: new Set(),
		membership: new Map(),
		...overrides,
	};
}

function viewer(overrides: Partial<ChatViewer> = {}): ChatViewer {
	return { id: 100, factionId: 2013, superadmin: false, ...overrides };
}

describe("chat access", () => {
	it("lets the owner, admins, invited players and invited factions see a private room", () => {
		const room = context({
			admins: new Set([2]),
			players: new Set([3]),
			factions: new Set([2013]),
		});
		expect(canSee(room, viewer({ id: 1 }))).toBe(true);
		expect(canSee(room, viewer({ id: 2 }))).toBe(true);
		expect(canSee(room, viewer({ id: 3 }))).toBe(true);
		expect(canSee(room, viewer({ id: 4, factionId: 2013 }))).toBe(true);
		expect(canSee(room, viewer({ id: 4, factionId: 27312 }))).toBe(false);
	});

	it("makes public rooms visible to everyone except a banned player", () => {
		const room = context({ visibility: "public" });
		expect(canSee(room, viewer())).toBe(true);
		expect(canSee(room, viewer({ id: 7, superadmin: true }))).toBe(true);
		expect(
			canSee(
				context({ visibility: "public", bans: new Set([7]) }),
				viewer({ id: 7 }),
			),
		).toBe(false);
	});

	it("gives superadmins an admin role only in public rooms", () => {
		expect(
			roleOf(context({ visibility: "public" }), viewer({ superadmin: true })),
		).toBe("admin");
		expect(roleOf(context(), viewer({ superadmin: true }))).toBe("member");
	});

	it("lists a private room shared with you until you leave it", () => {
		const shared = context({ players: new Set([100]) });
		expect(isListed(shared, viewer())).toBe(true);
		expect(
			isListed(
				context({
					players: new Set([100]),
					membership: new Map([[100, "joined"]]),
				}),
				viewer(),
			),
		).toBe(true);
		expect(
			isListed(
				context({
					players: new Set([100]),
					membership: new Map([[100, "left"]]),
				}),
				viewer(),
			),
		).toBe(false);
	});

	it("only lists rooms you are joined to when they are not a pending private invite", () => {
		const publicRoom = context({ visibility: "public" });
		expect(isListed(publicRoom, viewer())).toBe(false);
		expect(
			isListed(
				context({
					visibility: "public",
					membership: new Map([[100, "joined"]]),
				}),
				viewer(),
			),
		).toBe(true);
	});

	it("requires a joined membership to receive and post", () => {
		const room = context({ membership: new Map([[100, "left"]]) });
		expect(isJoined(room, viewer())).toBe(false);
		expect(receives(room, viewer())).toBe(false);
		expect(canPost(room, viewer())).toBe(false);

		const joined = context({
			players: new Set([100]),
			membership: new Map([[100, "joined"]]),
		});
		expect(receives(joined, viewer())).toBe(true);
		expect(canPost(joined, viewer())).toBe(true);
	});

	it("enforces an admins-only post policy", () => {
		const room = context({
			postPolicy: "admins",
			membership: new Map([
				[100, "joined"],
				[1, "joined"],
			]),
		});
		expect(canPost(room, viewer())).toBe(false);
		expect(canManage(room, viewer())).toBe(false);
		expect(canPost(room, viewer({ id: 1 }))).toBe(true);
		expect(canManage(room, viewer({ id: 1 }))).toBe(true);
	});
});

describe("chat GIF validation", () => {
	it("accepts direct image URLs from the supported providers", () => {
		const tenor = normalizeChatGif({
			url: "https://media.tenor.com/abc/tenor.gif",
			width: 220,
			height: 160,
			title: "cat",
		});
		expect(tenor?.width).toBe(220);
		expect(tenor?.height).toBe(160);
		expect(
			normalizeChatGif({ url: "https://media.giphy.com/media/x/giphy.webp" }),
		).not.toBeNull();
		expect(
			normalizeChatGif({ url: "https://i.imgur.com/x.png" }),
		).not.toBeNull();
	});

	it("rejects other hosts, insecure URLs and non-image paths", () => {
		expect(normalizeChatGif({ url: "https://evil.example/a.gif" })).toBeNull();
		expect(
			normalizeChatGif({ url: "http://media.tenor.com/a.gif" }),
		).toBeNull();
		expect(
			normalizeChatGif({ url: "https://media.tenor.com/a/page" }),
		).toBeNull();
		expect(normalizeChatGif({ url: "javascript:alert(1)" })).toBeNull();
		expect(normalizeChatGif(null)).toBeNull();
	});

	it("turns a message that is only a provider image URL into a GIF", () => {
		expect(chatGifFromText("https://media.tenor.com/abc/tenor.gif")?.url).toBe(
			"https://media.tenor.com/abc/tenor.gif",
		);
		expect(chatGifFromText("https://static.klipy.com/a.gif")?.url).toBe(
			"https://static.klipy.com/a.gif",
		);
		expect(
			chatGifFromText("look https://media.tenor.com/abc/tenor.gif"),
		).toBeNull();
	});
});
