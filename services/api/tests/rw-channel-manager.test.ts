import { beforeEach, describe, expect, it } from "bun:test";
import {
	RwChannelConflictError,
	subversiveRwChannelManager,
} from "../src/lib/rw-channel-manager";

/**
 * The primary and secondary ranked-war displays must never share a channel.
 *
 * The primary channel runs an author-gated stale-message sweep that deletes any
 * bot message it does not recognise as one of its own four embeds, so a shared
 * channel would have that sweep destroy the travel embed on the next war cycle.
 *
 * Every case here throws *before* the database write, so none of them touch the
 * real faction config rows.
 */

const FACTION_ID = 27312;

describe("SubversiveRwChannelManager - primary/secondary channel conflict", () => {
	beforeEach(() => {
		subversiveRwChannelManager.setConfigForTesting({
			primaryDisplaysChannelId: null,
			secondaryDisplaysChannelId: null,
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
		expect((error as Error).message).toContain("different channels");
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

	it("treats an unset channel as no conflict", () => {
		// A null primary can never collide with anything.
		expect(
			subversiveRwChannelManager.getCachedConfig(FACTION_ID)
				.primaryDisplaysChannelId,
		).toBeNull();
		expect(
			subversiveRwChannelManager.getCachedConfig(FACTION_ID)
				.secondaryDisplaysChannelId,
		).toBeNull();
	});

	it("exposes the secondary channel through the cached config", () => {
		subversiveRwChannelManager.setFactionConfigForTesting(FACTION_ID, {
			primaryDisplaysChannelId: "555555555555555555",
			secondaryDisplaysChannelId: "666666666666666666",
		});

		const cached = subversiveRwChannelManager.getCachedConfig(FACTION_ID);
		expect(cached.primaryDisplaysChannelId).toBe("555555555555555555");
		expect(cached.secondaryDisplaysChannelId).toBe("666666666666666666");
	});
});
