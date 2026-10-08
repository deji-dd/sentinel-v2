import { describe, expect, it } from "bun:test";
import type { RwFriendlyLine } from "@sentinel/schemas";
import {
	buildFriendlyPayload,
	resetRwFriendlyDisplaysState,
} from "../src/lib/rw-friendly-displays";

/**
 * The friendly revive board's exact title and row strings are the feature's
 * contract — the same convention the primary and travel displays are tested
 * with — so they are asserted directly rather than through a live channel.
 */

const FACTION = "Subversive Alliance";
const FACTION_ID = 2013;

function line(
	overrides: Partial<RwFriendlyLine> & { id: number },
): RwFriendlyLine {
	return {
		name: `Member${overrides.id}`,
		lastSeenAt: 1_800_000_000,
		hospitalUntil: null,
		...overrides,
	};
}

function firstEmbedJson(payload: ReturnType<typeof buildFriendlyPayload>) {
	const embed = payload.embeds[0];
	if (!embed) throw new Error("expected at least one embed");
	return embed.toJSON();
}

function firstRowJson(payload: ReturnType<typeof buildFriendlyPayload>) {
	const row = payload.components[0];
	if (!row) throw new Error("expected a pagination row");
	return row.toJSON() as {
		components: Array<{
			custom_id: string;
			disabled?: boolean;
			label?: string;
		}>;
	};
}

describe("buildFriendlyPayload", () => {
	it("renders the downed member row with its hospital timer", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, [
			line({
				id: 42,
				name: "Dejis",
				hospitalUntil: 1_800_003_600,
			}),
		]);
		const json = firstEmbedJson(payload);

		expect(json.title).toBe(`${FACTION} • 1 revivable member`);
		expect(json.description).toBe(
			"[Dejis [42]](https://www.torn.com/profiles.php?XID=42) • In hospital • Out <t:1800003600:R>",
		);
	});

	it("renders the up member row with last seen", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, [
			line({ id: 7, name: "Idle", lastSeenAt: 1_799_000_000 }),
		]);
		const json = firstEmbedJson(payload);

		expect(json.description).toBe(
			"[Idle [7]](https://www.torn.com/profiles.php?XID=7) • Last seen <t:1799000000:R>",
		);
	});

	it("says so when Torn reported no last-seen timestamp", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, [
			line({ id: 8, name: "Ghost", lastSeenAt: 0 }),
		]);

		expect(firstEmbedJson(payload).description).toBe(
			"[Ghost [8]](https://www.torn.com/profiles.php?XID=8) • Last seen unknown",
		);
	});

	it("keeps no attack link on our own members", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, [
			line({ id: 9 }),
		]);

		expect(firstEmbedJson(payload).description).not.toContain("Attack");
	});

	it("builds an empty state that names the rule, not just the count", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, []);
		const json = firstEmbedJson(payload);

		expect(json.title).toBe(`${FACTION} • 0 revivable members`);
		expect(json.description).toBe(
			"No faction members currently allow revives.",
		);
	});

	it("pluralises the title", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, [
			line({ id: 1 }),
			line({ id: 2 }),
		]);

		expect(firstEmbedJson(payload).title).toBe(
			`${FACTION} • 2 revivable members`,
		);
	});

	it("omits pagination when everything fits on one page", () => {
		const payload = buildFriendlyPayload(FACTION_ID, FACTION, [
			line({ id: 1 }),
		]);

		expect(payload.components).toHaveLength(0);
	});

	it("paginates and marks the ends of the range", () => {
		const members = Array.from({ length: 20 }, (_, i) => line({ id: i + 1 }));

		const first = firstRowJson(
			buildFriendlyPayload(FACTION_ID, FACTION, members, 1),
		);
		expect(first.components[0]?.custom_id).toBe(
			`rw_friendly_page:${FACTION_ID}:0`,
		);
		expect(first.components[0]?.disabled).toBe(true);
		expect(first.components[1]?.label).toBe("1 / 2");
		expect(first.components[2]?.custom_id).toBe(
			`rw_friendly_page:${FACTION_ID}:2`,
		);
		expect(first.components[2]?.disabled).toBe(false);

		const second = firstRowJson(
			buildFriendlyPayload(FACTION_ID, FACTION, members, 2),
		);
		expect(second.components[0]?.disabled).toBe(false);
		expect(second.components[2]?.disabled).toBe(true);
	});

	it("clamps a page request past the end instead of rendering nothing", () => {
		const members = Array.from({ length: 20 }, (_, i) => line({ id: i + 1 }));
		const json = firstEmbedJson(
			buildFriendlyPayload(FACTION_ID, FACTION, members, 99),
		);

		expect(json.description).toContain("Member20");
		expect(json.footer?.text).toContain("Page 2 of 2");
	});

	it("reports the roster total in the footer, not the page size", () => {
		const members = Array.from({ length: 20 }, (_, i) => line({ id: i + 1 }));
		const json = firstEmbedJson(
			buildFriendlyPayload(FACTION_ID, FACTION, members, 1),
		);

		expect(json.footer?.text).toBe("Sentinel • Page 1 of 2 • Total: 20");
	});

	it("exposes a test seam that clears render state", () => {
		expect(() => resetRwFriendlyDisplaysState()).not.toThrow();
	});
});
