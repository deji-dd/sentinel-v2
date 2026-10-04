import { describe, expect, it } from "bun:test";
import type { RwOpponentLine } from "@sentinel/schemas";
import {
	buildDisplaysPayload,
	resetRwPrimaryDisplaysState,
} from "../src/lib/rw-primary-displays";

const OPPONENT = "39th Street Killers X";
const FACTION_ID = 2013;

function line(
	overrides: Partial<RwOpponentLine> & { id: number },
): RwOpponentLine {
	return {
		name: `Player${overrides.id}`,
		estimatedBs: 1_000_000,
		lastSeenAt: 1_800_000_000,
		hospitalUntil: null,
		...overrides,
	};
}

function firstRowJson(payload: ReturnType<typeof buildDisplaysPayload>) {
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

function firstEmbedJson(payload: ReturnType<typeof buildDisplaysPayload>) {
	const embed = payload.embeds[0];
	if (!embed) throw new Error("expected at least one embed");
	return embed.toJSON();
}

describe("buildDisplaysPayload", () => {
	it("renders the leaving-hospital title and row format", () => {
		const { embeds, components } = buildDisplaysPayload(
			FACTION_ID,
			OPPONENT,
			"hospital",
			[
				line({
					id: 42,
					name: "SPQRobur",
					estimatedBs: 2_400_000_000,
					hospitalUntil: 1_800_003_600,
				}),
				line({ id: 43, name: "Other", hospitalUntil: 1_800_007_200 }),
			],
		);
		const json = firstEmbedJson({ embeds, components });

		expect(json.title).toBe(`${OPPONENT} • 2 leaving hospital`);
		expect(json.description).toBe(
			"[SPQRobur [42]](https://www.torn.com/profiles.php?XID=42) • 2.40B • Out in <t:1800003600:R>\n" +
				"[Other [43]](https://www.torn.com/profiles.php?XID=43) • 1.00M • Out in <t:1800007200:R>",
		);
		expect(json.footer?.text).toContain("Page 1 of 1");
		expect(json.footer?.text).toContain("Total: 2");
	});

	it("renders the offline & okay row with last-seen and attack links", () => {
		const { embeds, components } = buildDisplaysPayload(
			FACTION_ID,
			OPPONENT,
			"offlineOkay",
			[line({ id: 7, name: "Ghost", lastSeenAt: 1_799_999_000 })],
		);
		const json = firstEmbedJson({ embeds, components });

		expect(json.title).toBe(`${OPPONENT} • 1 offline & okay`);
		expect(json.description).toBe(
			"[Ghost [7]](https://www.torn.com/profiles.php?XID=7) • 1.00M • Last seen <t:1799999000:R> • " +
				"[Attack](https://www.torn.com/page.php?sid=attack&user2ID=7)",
		);
	});

	it("renders the online & okay row without a timestamp", () => {
		const { embeds, components } = buildDisplaysPayload(
			FACTION_ID,
			OPPONENT,
			"onlineOkay",
			[line({ id: 9, name: "Active", estimatedBs: 15_200 })],
		);
		const json = firstEmbedJson({ embeds, components });

		expect(json.title).toBe(`${OPPONENT} • 1 online & okay`);
		expect(json.description).toBe(
			"[Active [9]](https://www.torn.com/profiles.php?XID=9) • 15.2k • " +
				"[Attack](https://www.torn.com/page.php?sid=attack&user2ID=9)",
		);
		expect(json.description).not.toContain("Last seen");
	});

	it("renders the revivable row with last-seen and attack links", () => {
		const { embeds, components } = buildDisplaysPayload(
			FACTION_ID,
			OPPONENT,
			"revivable",
			[line({ id: 11, name: "Down", hospitalUntil: 1_800_000_900 })],
		);
		const json = firstEmbedJson({ embeds, components });

		expect(json.title).toBe(`${OPPONENT} • 1 revivable`);
		expect(json.description).toBe(
			"[Down [11]](https://www.torn.com/profiles.php?XID=11) • 1.00M • Last seen <t:1800000000:R> • " +
				"[Attack](https://www.torn.com/page.php?sid=attack&user2ID=11)",
		);
	});

	it("uses an empty-state description per category when the bucket is empty", () => {
		for (const [category, expected] of [
			["hospital", "No opponent players are leaving hospital."],
			["offlineOkay", "No opponent players are offline and okay."],
			["onlineOkay", "No opponent players are online and okay."],
			["revivable", "No revivable opponent players."],
		] as const) {
			const { embeds, components } = buildDisplaysPayload(
				FACTION_ID,
				OPPONENT,
				category,
				[],
			);
			const json = firstEmbedJson({ embeds, components });
			expect(json.description).toBe(expected);
			expect(json.title).toContain("• 0 ");
		}
	});

	describe("pagination", () => {
		const many = Array.from({ length: 32 }, (_, i) =>
			line({ id: 1000 + i, name: `P${i}` }),
		);

		it("omits buttons entirely for a single page", () => {
			const { components } = buildDisplaysPayload(
				FACTION_ID,
				OPPONENT,
				"onlineOkay",
				many.slice(0, 5),
			);
			expect(components).toHaveLength(0);
		});

		it("splits at 15 per page and renders controls", () => {
			const { embeds, components } = buildDisplaysPayload(
				FACTION_ID,
				OPPONENT,
				"onlineOkay",
				many,
				1,
			);
			const json = firstEmbedJson({ embeds, components });

			expect(json.footer?.text).toContain("Page 1 of 3");
			expect((json.description as string).split("\n")).toHaveLength(15);
			expect(components).toHaveLength(1);

			const row = firstRowJson({ embeds, components });
			expect(row.components).toHaveLength(3);
			// On page 1 Previous targets page 0 and is disabled; this mirrors
			// the existing faction monitoring pagination exactly.
			expect(row.components[0]?.custom_id).toBe(
				`rw_displays_page:${FACTION_ID}:onlineOkay:0`,
			);
			expect(row.components[0]?.disabled).toBe(true);
			expect(row.components[1]?.label).toBe("1 / 3");
			expect(row.components[1]?.disabled).toBe(true);
			expect(row.components[2]?.custom_id).toBe(
				`rw_displays_page:${FACTION_ID}:onlineOkay:2`,
			);
			expect(row.components[2]?.disabled).toBe(false);
		});

		it("disables Next on the final page", () => {
			const { embeds, components } = buildDisplaysPayload(
				FACTION_ID,
				OPPONENT,
				"onlineOkay",
				many,
				3,
			);
			const json = firstEmbedJson({ embeds, components });
			expect(json.footer?.text).toContain("Page 3 of 3");

			const row = firstRowJson({ embeds, components });
			const next = row.components.find((c) =>
				c.custom_id.endsWith(":onlineOkay:4"),
			);
			expect(next?.disabled).toBe(true);
		});

		it("clamps an out-of-range page instead of rendering nothing", () => {
			const { embeds, components } = buildDisplaysPayload(
				FACTION_ID,
				OPPONENT,
				"onlineOkay",
				many,
				99,
			);
			const json = firstEmbedJson({ embeds, components });
			expect(json.footer?.text).toContain("Page 3 of 3");
			expect(json.description).toBeTruthy();
		});
	});

	it("enforces the zero-emoji rule on title and description", () => {
		for (const category of [
			"hospital",
			"offlineOkay",
			"onlineOkay",
			"revivable",
		] as const) {
			const { embeds, components } = buildDisplaysPayload(
				FACTION_ID,
				OPPONENT,
				category,
				[line({ id: 1, hospitalUntil: 1_800_000_900 })],
			);
			const json = firstEmbedJson({ embeds, components });
			expect(json.title).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
			expect(json.description).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
		}
	});
});

describe("resetRwPrimaryDisplaysState", () => {
	it("is callable without throwing between tests", () => {
		expect(() => resetRwPrimaryDisplaysState()).not.toThrow();
	});
});
