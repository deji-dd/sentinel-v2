import { describe, expect, it } from "bun:test";
import { TORN_TRAVEL_DESTINATIONS } from "@sentinel/schemas";
import {
	buildTravelingSignature,
	classifyTravelingOpponents,
	parseAbroadDestination,
	parseOverseasHospitalDestination,
	parseTravelDestination,
} from "../src/lib/rw-traveling-buckets";
import type { RankedWarOpponent } from "../src/workers/subversive/ranked-war-worker";

function opponent(
	overrides: Partial<RankedWarOpponent> & { id: number; name: string },
): RankedWarOpponent {
	return {
		level: 75,
		daysInFaction: 100,
		position: "Member",
		isOnWall: false,
		isInOc: false,
		hasEarlyDischarge: false,
		isRevivable: false,
		reviveSetting: "Unknown",
		lastAction: { status: "Offline", timestamp: 1_800_000_000, relative: "" },
		status: {
			description: "",
			details: null,
			state: "Okay",
			color: "green",
			until: null,
		},
		estimatedBs: 1_000_000,
		estimatedScore: 2000,
		...overrides,
	};
}

const flyingTo = (
	id: number,
	name: string,
	destination: string,
	bs = 1_000_000,
) =>
	opponent({
		id,
		name,
		estimatedBs: bs,
		status: {
			description: `Traveling from X to ${destination}`,
			details: null,
			state: "Traveling",
			color: "blue",
			until: null,
			planeImageType: "light_aircraft",
		},
	});

const abroadIn = (id: number, name: string, country: string, bs = 1_000_000) =>
	opponent({
		id,
		name,
		estimatedBs: bs,
		status: {
			description: `In ${country}`,
			details: null,
			state: "Abroad",
			color: "blue",
			until: null,
		},
	});

const downedIn = (
	id: number,
	name: string,
	nationality: string,
	until: number | null = 1_800_003_600,
	bs = 1_000_000,
) =>
	opponent({
		id,
		name,
		estimatedBs: bs,
		status: {
			description: `In a ${nationality} hospital for 24 mins`,
			details: null,
			state: "Hospital",
			color: "red",
			until,
		},
	});

describe("parseTravelDestination", () => {
	/**
	 * Both strings below were returned by the live Torn API for real players,
	 * which is why they are the fixtures rather than invented examples.
	 */
	it("reads a returning flight as a Torn destination", () => {
		expect(parseTravelDestination("Traveling from Switzerland to Torn")).toBe(
			"Torn",
		);
		expect(parseTravelDestination("Traveling from UAE to Torn")).toBe("Torn");
	});

	it("reads an outbound flight", () => {
		expect(parseTravelDestination("Traveling from Torn to Japan")).toBe(
			"Japan",
		);
		expect(
			parseTravelDestination("Traveling from Switzerland to Cayman Islands"),
		).toBe("Cayman Islands");
	});

	it("accepts UAE, which is how Torn spells United Arab Emirates", () => {
		expect(parseTravelDestination("Traveling from Torn to UAE")).toBe("UAE");
		// The long form is never a real API value; matching it would drop UAE.
		expect(
			parseTravelDestination("Traveling from Torn to United Arab Emirates"),
		).toBeNull();
	});

	it("accepts every destination Torn can report", () => {
		// Driven by the exported constant so this cannot drift from it.
		expect(TORN_TRAVEL_DESTINATIONS).toHaveLength(12);

		for (const destination of TORN_TRAVEL_DESTINATIONS) {
			expect(
				parseTravelDestination(`Traveling from Torn to ${destination}`),
			).toBe(destination);
			expect(
				parseTravelDestination(`Traveling from ${destination} to Torn`),
			).toBe("Torn");
		}
	});

	it("rejects an unknown destination rather than rendering it", () => {
		expect(
			parseTravelDestination("Traveling from Torn to Atlantis"),
		).toBeNull();
	});

	it("rejects descriptions from other states", () => {
		expect(parseTravelDestination("In hospital for 25 mins")).toBeNull();
		expect(parseTravelDestination("")).toBeNull();
		expect(parseTravelDestination(null)).toBeNull();
		expect(parseTravelDestination(undefined)).toBeNull();
	});

	it("rejects malformed routes without a usable destination", () => {
		expect(parseTravelDestination("Traveling from Torn to")).toBeNull();
		expect(parseTravelDestination("Traveling to Japan")).toBeNull();
	});

	it("uses the trailing clause when the sentence has several separators", () => {
		expect(
			parseTravelDestination("Traveling from Torn to Mexico to recall"),
		).toBeNull();
		expect(
			parseTravelDestination("Traveling from somewhere to South Africa"),
		).toBe("South Africa");
	});
});

describe("parseAbroadDestination", () => {
	it("reads the country Torn names for a landed player", () => {
		expect(parseAbroadDestination("In Japan")).toBe("Japan");
		expect(parseAbroadDestination("In Cayman Islands")).toBe("Cayman Islands");
	});

	it("tolerates a missing 'In ' prefix without accepting stray text", () => {
		// Torn writes "In Japan"; the country still has to match the list exactly,
		// so a reworded sentence can never be rendered as a country.
		expect(parseAbroadDestination("Japan")).toBe("Japan");
		expect(parseAbroadDestination("Currently in Japan")).toBeNull();
	});

	it("rejects a domestic hospital stay, which shares the 'In ' prefix", () => {
		expect(parseAbroadDestination("In hospital for 25 mins")).toBeNull();
		expect(
			parseAbroadDestination("In a Japanese hospital for 24 mins"),
		).toBeNull();
	});

	it("rejects unknown countries and other states", () => {
		expect(parseAbroadDestination("In Atlantis")).toBeNull();
		expect(parseAbroadDestination("Traveling from Torn to Japan")).toBeNull();
		expect(parseAbroadDestination("")).toBeNull();
		expect(parseAbroadDestination(null)).toBeNull();
		expect(parseAbroadDestination(undefined)).toBeNull();
	});

	it("accepts every country Torn can report", () => {
		for (const destination of TORN_TRAVEL_DESTINATIONS) {
			// "Torn" is the city, not a country a player can be landed in.
			const expected = destination === "Torn" ? null : destination;
			expect(parseAbroadDestination(`In ${destination}`)).toBe(expected);
		}
	});
});

describe("parseOverseasHospitalDestination", () => {
	it("maps the nationality Torn puts in the description", () => {
		// The first three are the wordings observed live (see torn-status.ts).
		expect(
			parseOverseasHospitalDestination("In a Japanese hospital for 24 mins"),
		).toBe("Japan");
		expect(
			parseOverseasHospitalDestination("In an Emirati hospital for 34 mins"),
		).toBe("UAE");
		expect(
			parseOverseasHospitalDestination("In a Swiss hospital for 41 mins"),
		).toBe("Switzerland");
		expect(
			parseOverseasHospitalDestination("In a Canadian hospital for 5 mins"),
		).toBe("Canada");
	});

	it("handles an adjective that carries the country name as a prefix", () => {
		expect(
			parseOverseasHospitalDestination(
				"In a South African hospital for 5 mins",
			),
		).toBe("South Africa");
	});

	it("rejects a hospital inside Torn, which names no nation", () => {
		expect(
			parseOverseasHospitalDestination("In hospital for 3 hrs 12 mins"),
		).toBeNull();
	});

	it("rejects an adjective it cannot place rather than guessing", () => {
		expect(
			parseOverseasHospitalDestination("In a Martian hospital for 5 mins"),
		).toBeNull();
		expect(parseOverseasHospitalDestination("")).toBeNull();
		expect(parseOverseasHospitalDestination(null)).toBeNull();
	});
});

describe("classifyTravelingOpponents", () => {
	it("groups players by destination", () => {
		const buckets = classifyTravelingOpponents([
			flyingTo(1, "A", "Japan"),
			flyingTo(2, "B", "Japan"),
			flyingTo(3, "C", "Torn"),
		]);

		expect(buckets.map((b) => b.destination)).toEqual(["Japan", "Torn"]);
		expect(buckets[0]?.players).toHaveLength(2);
		expect(buckets[0]?.players.map((p) => p.id)).toEqual([1, 2]);
	});

	it("ignores opponents who are not traveling", () => {
		const buckets = classifyTravelingOpponents([
			opponent({ id: 1, name: "Okay" }),
			opponent({
				id: 2,
				name: "Hosp",
				status: {
					description: "In hospital for 5 mins",
					details: null,
					state: "Hospital",
					color: "red",
					until: 1_800_003_600,
				},
			}),
			flyingTo(3, "Flyer", "Canada"),
		]);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.players.map((p) => p.id)).toEqual([3]);
	});

	it("omits a traveler whose destination Torn changed on us", () => {
		const buckets = classifyTravelingOpponents([
			flyingTo(1, "Known", "Japan"),
			// Deliberately not a valid TravelDestination.
			flyingTo(2, "Unknown", "Atlantis"),
		]);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.players.map((p) => p.id)).toEqual([1]);
	});

	it("boards an opponent who has already landed, tagged as abroad", () => {
		const buckets = classifyTravelingOpponents([
			abroadIn(1, "Landed", "Japan", 5_000_000),
		]);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.destination).toBe("Japan");
		expect(buckets[0]?.players[0]?.kind).toBe("abroad");
		// Only a hospital stay carries a timer; a landed player has none.
		expect(buckets[0]?.players[0]?.hospitalUntil).toBeNull();
	});

	it("merges inbound and landed opponents under one destination", () => {
		const buckets = classifyTravelingOpponents([
			flyingTo(1, "Inbound", "Japan", 1_000),
			abroadIn(2, "Landed", "Japan", 9_000_000),
		]);

		expect(buckets).toHaveLength(1);
		// One board per country, largest target first regardless of kind.
		expect(buckets[0]?.players.map((p) => [p.id, p.kind])).toEqual([
			[2, "abroad"],
			[1, "traveling"],
		]);
	});

	it("boards an opponent downed in a hospital abroad, with the timer", () => {
		const buckets = classifyTravelingOpponents([
			downedIn(1, "DownedAbroad", "Japanese", 1_800_007_200),
		]);

		expect(buckets[0]?.destination).toBe("Japan");
		expect(buckets[0]?.players[0]?.kind).toBe("hospitalAbroad");
		// Torn does clock an overseas stay, and the timer is the actionable half.
		expect(buckets[0]?.players[0]?.hospitalUntil).toBe(1_800_007_200);
	});

	it("keeps an opponent downed inside Torn off the board", () => {
		const buckets = classifyTravelingOpponents([
			opponent({
				id: 1,
				name: "DomesticHospital",
				status: {
					description: "In hospital for 5 mins",
					details: null,
					state: "Hospital",
					color: "red",
					until: 1_800_003_600,
				},
			}),
		]);

		// The primary "leaving hospital" bucket owns that player, not this board.
		expect(buckets).toEqual([]);
	});

	it("omits an away player whose country cannot be resolved", () => {
		const buckets = classifyTravelingOpponents([
			abroadIn(1, "Known", "Japan"),
			abroadIn(2, "Unknown", "Atlantis"),
			downedIn(3, "Unplaceable", "Martian"),
		]);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.players.map((p) => p.id)).toEqual([1]);
	});

	it("orders destinations by player count descending", () => {
		const buckets = classifyTravelingOpponents([
			flyingTo(1, "A", "Mexico"),
			flyingTo(2, "B", "Mexico"),
			flyingTo(3, "C", "Mexico"),
			flyingTo(4, "D", "China"),
			flyingTo(5, "E", "China"),
			flyingTo(6, "F", "Japan"),
		]);

		expect(buckets.map((b) => b.destination)).toEqual([
			"Mexico",
			"China",
			"Japan",
		]);
	});

	it("breaks count ties alphabetically", () => {
		const buckets = classifyTravelingOpponents([
			flyingTo(1, "A", "Japan"),
			flyingTo(2, "B", "Argentina"),
		]);

		expect(buckets.map((b) => b.destination)).toEqual(["Argentina", "Japan"]);
	});

	it("orders players within a destination by battle stat descending", () => {
		const buckets = classifyTravelingOpponents([
			flyingTo(1, "Small", "Japan", 5_000),
			flyingTo(2, "Huge", "Japan", 9_000_000_000),
			flyingTo(3, "Mid", "Japan", 1_000_000),
		]);

		expect(buckets[0]?.players.map((p) => p.id)).toEqual([2, 3, 1]);
	});

	it("never puts a traveler in a hospital bucket shape", () => {
		const buckets = classifyTravelingOpponents([flyingTo(1, "A", "Japan")]);

		// hospitalUntil stays null: travel and hospital are mutually exclusive.
		expect(buckets[0]?.players[0]?.hospitalUntil).toBeNull();
	});

	it("returns an empty list when nobody is away", () => {
		expect(classifyTravelingOpponents([])).toEqual([]);
		expect(
			classifyTravelingOpponents([opponent({ id: 1, name: "Okay" })]),
		).toEqual([]);
	});

	it("never mutates the input array", () => {
		const input = [flyingTo(1, "A", "Japan"), flyingTo(2, "B", "Japan")];
		const snapshot = input.map((o) => o.id);
		classifyTravelingOpponents(input);
		expect(input.map((o) => o.id)).toEqual(snapshot);
	});
});

describe("buildTravelingSignature", () => {
	it("is stable for the same roster", () => {
		const a = classifyTravelingOpponents([
			flyingTo(1, "A", "Japan"),
			flyingTo(2, "B", "Torn"),
		]);
		const b = classifyTravelingOpponents([
			flyingTo(2, "B", "Torn"),
			flyingTo(1, "A", "Japan"),
		]);
		expect(buildTravelingSignature(a)).toBe(buildTravelingSignature(b));
	});

	it("changes when a player departs", () => {
		const a = classifyTravelingOpponents([flyingTo(1, "A", "Japan")]);
		const b = classifyTravelingOpponents([
			flyingTo(1, "A", "Japan"),
			flyingTo(2, "B", "Japan"),
		]);
		expect(buildTravelingSignature(a)).not.toBe(buildTravelingSignature(b));
	});

	it("changes when a destination changes", () => {
		const a = classifyTravelingOpponents([flyingTo(1, "A", "Japan")]);
		const b = classifyTravelingOpponents([flyingTo(1, "A", "Torn")]);
		expect(buildTravelingSignature(a)).not.toBe(buildTravelingSignature(b));
	});

	it("changes when a player's battle stat estimate changes", () => {
		const a = classifyTravelingOpponents([flyingTo(1, "A", "Japan", 1_000)]);
		const b = classifyTravelingOpponents([flyingTo(1, "A", "Japan", 2_000)]);
		expect(buildTravelingSignature(a)).not.toBe(buildTravelingSignature(b));
	});

	it("distinguishes destinations holding the same number of players", () => {
		const a = classifyTravelingOpponents([flyingTo(1, "A", "Japan")]);
		const b = classifyTravelingOpponents([flyingTo(2, "B", "Japan")]);
		expect(buildTravelingSignature(a)).not.toBe(buildTravelingSignature(b));
	});

	it("changes when a player lands, which no other field would show", () => {
		const airborne = classifyTravelingOpponents([flyingTo(1, "A", "Japan")]);
		const landed = classifyTravelingOpponents([abroadIn(1, "A", "Japan")]);

		// Same player, same country, same stats — only the kind differs, so a
		// signature without it would suppress the repaint that shows the landing.
		expect(buildTravelingSignature(airborne)).not.toBe(
			buildTravelingSignature(landed),
		);
	});

	it("changes when an overseas hospital stay is extended", () => {
		const a = classifyTravelingOpponents([
			downedIn(1, "A", "Japanese", 1_800_003_600),
		]);
		const b = classifyTravelingOpponents([
			downedIn(1, "A", "Japanese", 1_800_007_200),
		]);
		expect(buildTravelingSignature(a)).not.toBe(buildTravelingSignature(b));
	});
});
