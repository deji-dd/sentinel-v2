import { describe, expect, it } from "bun:test";
import type {
	RwOpponentLine,
	RwTravelingBuckets,
	TravelDestination,
} from "@sentinel/schemas";
import {
	buildTravelingDestinationEmbed,
	buildTravelingEmbed,
	buildTravelingSelectRow,
} from "../src/lib/rw-traveling-displays";

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

function bucket(
	destination: TravelDestination,
	ids: number[],
): RwTravelingBuckets[number] {
	return {
		destination,
		players: ids.map((id) => line({ id })),
	};
}

describe("buildTravelingEmbed", () => {
	it("titles the embed and lists one bold field per destination", () => {
		const embed = buildTravelingEmbed(OPPONENT, [
			bucket("Japan", [1, 2]),
			bucket("Torn", [3]),
		]);
		const json = embed.toJSON();

		expect(json.title).toBe(`${OPPONENT} • Players traveling`);
		expect(json.fields).toEqual([
			{
				name: "**Japan**",
				value: "2 people flying here",
				inline: true,
			},
			{
				name: "**Returning to Torn**",
				value: "1 person flying here",
				inline: true,
			},
		]);
	});

	it("spells out a flight home rather than listing it as a country", () => {
		const json = buildTravelingEmbed(OPPONENT, [bucket("Torn", [1])]).toJSON();

		// "Torn" alone reads as a country next to Japan and Mexico.
		expect(json.fields?.[0]?.name).toBe("**Returning to Torn**");
		expect(json.fields?.[0]?.name).not.toBe("**Torn**");
	});

	it("says so plainly when nobody is airborne", () => {
		const json = buildTravelingEmbed(OPPONENT, []).toJSON();

		expect(json.title).toBe(`${OPPONENT} • Players traveling`);
		expect(json.description).toBe("Nobody is currently flying");
		expect(json.fields ?? []).toHaveLength(0);
	});

	it("keeps the title when nobody is airborne", () => {
		// A titled empty state reads better than an embed that silently loses
		// its fields in a channel dedicated to this.
		expect(buildTravelingEmbed(OPPONENT, []).toJSON().title).toContain(
			"Players traveling",
		);
	});

	it("stays under Discord's 25-field limit even at full destination count", () => {
		const all: RwTravelingBuckets = [
			bucket("Mexico", [1]),
			bucket("Hawaii", [1]),
			bucket("South Africa", [1]),
			bucket("Japan", [1]),
			bucket("China", [1]),
			bucket("Argentina", [1]),
			bucket("Switzerland", [1]),
			bucket("Canada", [1]),
			bucket("United Kingdom", [1]),
			bucket("UAE", [1]),
			bucket("Cayman Islands", [1]),
			bucket("Torn", [1]),
		];
		expect(all).toHaveLength(12);

		const json = buildTravelingEmbed(OPPONENT, all).toJSON();
		expect(json.fields).toHaveLength(12);
		expect(json.fields?.length ?? 0).toBeLessThanOrEqual(25);
	});

	it("enforces the zero-emoji rule on title, description and fields", () => {
		const json = buildTravelingEmbed(OPPONENT, [
			bucket("Japan", [1]),
			bucket("UAE", [2]),
		]).toJSON();

		const haystack = [
			json.title,
			json.description ?? "",
			...(json.fields ?? []).map((f) => `${f.name} ${f.value}`),
		].join("\n");
		expect(haystack).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
	});
});

describe("buildTravelingSelectRow", () => {
	it("offers one option per active destination", () => {
		const row = buildTravelingSelectRow(FACTION_ID, [
			bucket("Japan", [1, 2]),
			bucket("Torn", [3]),
		]);

		const json = row?.toJSON() as {
			components: Array<{
				placeholder: string;
				options: Array<{ label: string; value: string; description: string }>;
			}>;
		};
		expect(json.components).toHaveLength(1);
		expect(json.components[0]?.options).toEqual([
			{
				label: "Japan",
				value: "Japan",
				description: "2 flying",
			},
			{
				label: "Returning to Torn",
				value: "Torn",
				description: "1 flying",
			},
		]);
	});

	it("labels the Torn option consistently with the embed field", () => {
		const row = buildTravelingSelectRow(FACTION_ID, [bucket("Torn", [1])]);
		const json = row?.toJSON() as {
			components: Array<{ options: Array<{ label: string; value: string }> }>;
		};

		expect(json.components[0]?.options[0]?.label).toBe("Returning to Torn");
		// The value stays the raw destination so the handler can key the cache.
		expect(json.components[0]?.options[0]?.value).toBe("Torn");
	});

	it("omits destinations nobody is flying to", () => {
		const row = buildTravelingSelectRow(FACTION_ID, [bucket("Japan", [1])]);
		const json = row?.toJSON() as {
			components: Array<{ options: Array<{ value: string }> }>;
		};
		const values = json.components[0]?.options.map((o) => o.value);
		expect(values).toEqual(["Japan"]);
		expect(values).not.toContain("Mexico");
	});

	it("renders no row when nobody is airborne, since an empty select is illegal", () => {
		expect(buildTravelingSelectRow(FACTION_ID, [])).toBeNull();
	});

	it("stays under Discord's 25-option limit at full destination count", () => {
		const all: RwTravelingBuckets = [
			bucket("Mexico", [1]),
			bucket("Hawaii", [1]),
			bucket("South Africa", [1]),
			bucket("Japan", [1]),
			bucket("China", [1]),
			bucket("Argentina", [1]),
			bucket("Switzerland", [1]),
			bucket("Canada", [1]),
			bucket("United Kingdom", [1]),
			bucket("UAE", [1]),
			bucket("Cayman Islands", [1]),
			bucket("Torn", [1]),
		];
		const json = buildTravelingSelectRow(FACTION_ID, all)?.toJSON() as {
			components: Array<{ options: unknown[] }>;
		};
		expect(json.components[0]?.options.length).toBeLessThanOrEqual(25);
	});
});

describe("buildTravelingDestinationEmbed", () => {
	it("titles the detail and lists each player with a profile link", () => {
		const embed = buildTravelingDestinationEmbed(OPPONENT, "Japan", [
			line({ id: 42, name: "SPQRobur", estimatedBs: 2_400_000_000 }),
			line({ id: 7, name: "HumperDink", estimatedBs: 15_200 }),
		]);
		const json = embed?.toJSON();

		expect(json?.title).toBe(`${OPPONENT} • Traveling to Japan`);
		expect(json?.description).toBe(
			"[SPQRobur [42]](https://www.torn.com/profiles.php?XID=42) • 2.40B\n" +
				"[HumperDink [7]](https://www.torn.com/profiles.php?XID=7) • 15.2k",
		);
	});

	it("uses the raw destination in the title, not the display label", () => {
		// The label disambiguates Torn inside a list of countries, but
		// interpolated into a sentence it reads "Traveling to Returning to Torn".
		expect(
			buildTravelingDestinationEmbed(OPPONENT, "Torn", [
				line({ id: 1 }),
			])?.toJSON().title,
		).toBe(`${OPPONENT} • Traveling to Torn`);
	});

	it("returns null for an empty roster rather than a contentless embed", () => {
		expect(buildTravelingDestinationEmbed(OPPONENT, "Japan", [])).toBeNull();
	});

	it("enforces the zero-emoji rule", () => {
		const json = buildTravelingDestinationEmbed(OPPONENT, "UAE", [
			line({ id: 1 }),
		])?.toJSON();
		expect(`${json?.title} ${json?.description}`).not.toMatch(
			/[\u{1F300}-\u{1F9FF}]/u,
		);
	});
});
