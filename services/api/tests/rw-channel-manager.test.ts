import { beforeEach, describe, expect, it } from "bun:test";
import {
	RwChannelConflictError,
	subversiveRwChannelManager,
} from "../src/lib/rw-channel-manager";

/**
 * No two ranked-war displays may share a channel.
 *
 * Each display channel is swept by its own renderer, which deletes any bot
 * message it does not recognise as one of its own — the primary's four embeds,
 * the travel board, the friendly revive board. A shared channel therefore has
 * one display destroy another's embeds on the next war cycle.
 *
 * Every case here throws *before* the database write, so none of them touch the
 * real faction config rows.
 */

const FACTION_ID = 27312;

describe("SubversiveRwChannelManager - display channel conflicts", () => {
	beforeEach(() => {
		subversiveRwChannelManager.setConfigForTesting({
			primaryDisplaysChannelId: null,
			secondaryDisplaysChannelId: null,
			friendlyDisplaysChannelId: null,
		});
	});

	it("rejects a secondary selection that repeats the primary channel", async () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: "111111111111111111",
			secondaryDisplaysChannelId: null,
		});

		expect(
			subversiveRwChannelManager.updateConfig(
				{ secondaryDisplaysChannelId: "111111111111111111" },
				"tester",
				FACTION_ID,
			),
		).rejects.toBeInstanceOf(RwChannelConflictError);
	});

	it("rejects a primary selection that repeats the secondary channel", async () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: null,
			secondaryDisplaysChannelId: "222222222222222222",
		});

		expect(
			subversiveRwChannelManager.updateConfig(
				{ primaryDisplaysChannelId: "222222222222222222" },
				"tester",
				FACTION_ID,
			),
		).rejects.toBeInstanceOf(RwChannelConflictError);
	});

	it("rejects setting both to the same channel in one patch", async () => {
		expect(
			subversiveRwChannelManager.updateConfig(
				{
					primaryDisplaysChannelId: "333333333333333333",
					secondaryDisplaysChannelId: "333333333333333333",
				},
				"tester",
				FACTION_ID,
			),
		).rejects.toBeInstanceOf(RwChannelConflictError);
	});

	it("rejects a friendly selection that repeats the primary channel", async () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: "777777777777777777",
			friendlyDisplaysChannelId: null,
		});

		expect(
			subversiveRwChannelManager.updateConfig(
				{ friendlyDisplaysChannelId: "777777777777777777" },
				"tester",
				FACTION_ID,
			),
		).rejects.toBeInstanceOf(RwChannelConflictError);
	});

	it("rejects a friendly selection that repeats the secondary channel", async () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			secondaryDisplaysChannelId: "888888888888888888",
			friendlyDisplaysChannelId: null,
		});

		expect(
			subversiveRwChannelManager.updateConfig(
				{ friendlyDisplaysChannelId: "888888888888888888" },
				"tester",
				FACTION_ID,
			),
		).rejects.toBeInstanceOf(RwChannelConflictError);
	});

	it("rejects a primary selection that repeats the friendly channel", async () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: null,
			friendlyDisplaysChannelId: "999999999999999999",
		});

		expect(
			subversiveRwChannelManager.updateConfig(
				{ primaryDisplaysChannelId: "999999999999999999" },
				"tester",
				FACTION_ID,
			),
		).rejects.toBeInstanceOf(RwChannelConflictError);
	});

	it("carries a message the dashboard can surface", async () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: "444444444444444444",
			secondaryDisplaysChannelId: null,
		});

		const error = await subversiveRwChannelManager
			.updateConfig(
				{ secondaryDisplaysChannelId: "444444444444444444" },
				"tester",
				FACTION_ID,
			)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RwChannelConflictError);
		expect((error as Error).message).toContain("different channel");
	});

	/**
	 * A specific error type, not a bare Error, so the route answers 400 for
	 * this client mistake without also reporting genuine database failures as
	 * bad requests.
	 */
	it("is distinguishable from an unexpected failure", () => {
		expect(new RwChannelConflictError()).not.toBeInstanceOf(TypeError);
		expect(new RwChannelConflictError().name).toBe("RwChannelConflictError");
	});

	it("treats unset channels as no conflict", () => {
		// A null selection can never collide with anything.
		const cached = subversiveRwChannelManager.getCachedConfig(FACTION_ID);
		expect(cached.primaryDisplaysChannelId).toBeNull();
		expect(cached.secondaryDisplaysChannelId).toBeNull();
		expect(cached.friendlyDisplaysChannelId).toBeNull();
	});

	it("exposes every channel through the cached config", () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: "555555555555555555",
			secondaryDisplaysChannelId: "666666666666666666",
			friendlyDisplaysChannelId: "777777777777777777",
		});

		const cached = subversiveRwChannelManager.getCachedConfig(FACTION_ID);
		expect(cached.primaryDisplaysChannelId).toBe("555555555555555555");
		expect(cached.secondaryDisplaysChannelId).toBe("666666666666666666");
		expect(cached.friendlyDisplaysChannelId).toBe("777777777777777777");
	});
});
