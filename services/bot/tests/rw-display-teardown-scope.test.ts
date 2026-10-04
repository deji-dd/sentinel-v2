import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	db,
	eq,
	subversiveRwChannelConfigs,
	subversiveRwDisplayMessages,
} from "@sentinel/database";
import {
	RW_DISPLAY_CATEGORIES,
	RW_TRAVELING_CATEGORY,
} from "@sentinel/schemas";
import type { Client } from "discord.js";
import { teardownRwPrimaryDisplays } from "../src/lib/rw-primary-displays";

/**
 * Regression cover for the shared display-message table.
 *
 * `subversive_rw_display_messages` stores the four primary embeds *and* the
 * secondary travel embed for the same faction, keyed by (factionId, category).
 * A teardown that deleted by faction alone would therefore destroy the travel
 * embed every time a war ended — invisible in the primary channel, and only
 * apparent as a travel display that vanishes on the next war.
 */

const FACTION_ID = 999_001;

/**
 * Minimal stand-in. Teardown with a null channel skips every Discord call and
 * only touches the database, so no client behaviour is exercised here.
 */
const fakeClient = {} as Client;

async function seed(): Promise<void> {
	await db
		.insert(subversiveRwChannelConfigs)
		.values({ factionId: FACTION_ID, primaryDisplaysChannelId: "111" })
		.onConflictDoNothing();

	for (const category of RW_DISPLAY_CATEGORIES) {
		await db.insert(subversiveRwDisplayMessages).values({
			factionId: FACTION_ID,
			category,
			messageId: `primary-${category}`,
		});
	}

	await db.insert(subversiveRwDisplayMessages).values({
		factionId: FACTION_ID,
		category: RW_TRAVELING_CATEGORY,
		messageId: "travel-embed",
	});
}

async function survivingCategories(): Promise<string[]> {
	const rows = await db
		.select({ category: subversiveRwDisplayMessages.category })
		.from(subversiveRwDisplayMessages)
		.where(eq(subversiveRwDisplayMessages.factionId, FACTION_ID));
	return rows.map((r) => r.category).sort();
}

async function clear(): Promise<void> {
	await db
		.delete(subversiveRwDisplayMessages)
		.where(eq(subversiveRwDisplayMessages.factionId, FACTION_ID));
	await db
		.delete(subversiveRwChannelConfigs)
		.where(eq(subversiveRwChannelConfigs.factionId, FACTION_ID));
}

describe("primary display teardown scoping", () => {
	beforeEach(clear);
	afterEach(clear);

	it("clears the four primary rows", async () => {
		await seed();
		await teardownRwPrimaryDisplays(fakeClient, FACTION_ID, null);

		const left = await survivingCategories();
		for (const category of RW_DISPLAY_CATEGORIES) {
			expect(left).not.toContain(category);
		}
	});

	it("leaves the secondary travel row untouched", async () => {
		await seed();
		await teardownRwPrimaryDisplays(fakeClient, FACTION_ID, null);

		expect(await survivingCategories()).toEqual([RW_TRAVELING_CATEGORY]);
	});

	it("does not disturb another faction's rows", async () => {
		await seed();

		const otherFactionId = FACTION_ID + 1;
		await db
			.insert(subversiveRwChannelConfigs)
			.values({ factionId: otherFactionId, primaryDisplaysChannelId: "222" })
			.onConflictDoNothing();
		await db.insert(subversiveRwDisplayMessages).values({
			factionId: otherFactionId,
			category: RW_TRAVELING_CATEGORY,
			messageId: "other-travel",
		});

		try {
			await teardownRwPrimaryDisplays(fakeClient, FACTION_ID, null);

			const other = await db
				.select({ messageId: subversiveRwDisplayMessages.messageId })
				.from(subversiveRwDisplayMessages)
				.where(eq(subversiveRwDisplayMessages.factionId, otherFactionId));

			expect(other.map((r) => r.messageId)).toEqual(["other-travel"]);
		} finally {
			await db
				.delete(subversiveRwDisplayMessages)
				.where(eq(subversiveRwDisplayMessages.factionId, otherFactionId));
			await db
				.delete(subversiveRwChannelConfigs)
				.where(eq(subversiveRwChannelConfigs.factionId, otherFactionId));
		}
	});
});
