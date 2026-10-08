import { describe, expect, test } from "bun:test";
import {
	matchesQuery,
	nextSortState,
	type SortState,
	sortRows,
} from "../src/ui/table-sort";

/**
 * Coverage for the table sorting the Crimes and Company ledgers now use.
 *
 * The cases worth pinning are the ones a hand-rolled comparator gets wrong: a
 * column with no value for some rows, strings that contain numbers, and the
 * direction flip when the same header is activated twice.
 */

interface Row {
	name: string;
	value: number | null;
	notes: string;
}

const ROWS: Row[] = [
	{ name: "Arson & Robbery", value: 1_200, notes: "1200" },
	{ name: "Bootlegging", value: null, notes: "unknown" },
	{ name: "Cracking", value: 400, notes: "400" },
];

type Key = "name" | "value";

const ACCESSORS = {
	name: (row: Row) => row.name,
	value: (row: Row) => row.value ?? Number.NEGATIVE_INFINITY,
};

describe("nextSortState", () => {
	test("flips direction when the same header is activated twice", () => {
		const first = nextSortState<Key>(
			{ key: "name", direction: "asc" },
			"value",
			"desc",
		);
		expect(first).toEqual({ key: "value", direction: "desc" });

		const flipped = nextSortState(first, "value", "desc");
		expect(flipped).toEqual({ key: "value", direction: "asc" });
	});

	test("uses the column's own initial direction for a new column", () => {
		expect(
			nextSortState<Key>({ key: "value", direction: "desc" }, "name", "asc"),
		).toEqual({ key: "name", direction: "asc" });
	});
});

describe("sortRows", () => {
	test("orders numbers descending and ascending", () => {
		const desc = sortRows(ROWS, { key: "value", direction: "desc" }, ACCESSORS);
		expect(desc.map((row) => row.name)).toEqual([
			"Arson & Robbery",
			"Cracking",
			"Bootlegging",
		]);

		const asc = sortRows(ROWS, { key: "value", direction: "asc" }, ACCESSORS);
		expect(asc[0]?.name).toBe("Cracking");
	});

	test("leaves the input array untouched", () => {
		const original = [...ROWS];
		sortRows(ROWS, { key: "name", direction: "asc" }, ACCESSORS);
		expect(ROWS).toEqual(original);
	});

	test("sorts names case-insensitively and naturally", () => {
		const rows: Row[] = [
			{ name: "bootlegging", value: 1, notes: "" },
			{ name: "Arson", value: 2, notes: "" },
			{ name: "card skimming 10", value: 3, notes: "" },
			{ name: "card skimming 2", value: 4, notes: "" },
		];
		const sorted = sortRows(rows, { key: "name", direction: "asc" }, ACCESSORS);
		expect(sorted.map((row) => row.name)).toEqual([
			"Arson",
			"bootlegging",
			"card skimming 2",
			"card skimming 10",
		]);
	});

	test("keeps rows with no value at the bottom whichever way the column points", () => {
		const rows: Row[] = [
			{ name: "a", value: null, notes: "" },
			{ name: "b", value: 5, notes: "" },
			{ name: "c", value: 9, notes: "" },
		];
		const accessors = {
			name: (row: Row) => row.name,
			value: (row: Row) => (row.value === null ? Number.NaN : row.value),
		};

		for (const direction of ["asc", "desc"] as const) {
			const sorted = sortRows(rows, { key: "value", direction }, accessors);
			expect(sorted[sorted.length - 1]?.name).toBe("a");
		}
	});

	test("falls back to the input order for an unknown column", () => {
		// A persisted sort from an older build can name a column this one no longer
		// has; that must leave the table alone rather than throw or blank it.
		const state = { key: "missing" } as unknown as SortState<Key>;
		const accessors = ACCESSORS as unknown as Parameters<
			typeof sortRows<Row, Key>
		>[2];
		expect(sortRows(ROWS, state, accessors).map((r) => r.name)).toEqual(
			ROWS.map((r) => r.name),
		);
	});
});

describe("matchesQuery", () => {
	test("matches case-insensitively on a substring", () => {
		expect(matchesQuery("Card Skimming", "skim")).toBe(true);
		expect(matchesQuery("Card Skimming", "SKIMMING")).toBe(true);
		expect(matchesQuery("Card Skimming", "arson")).toBe(false);
	});

	test("treats an empty or blank query as no filter", () => {
		expect(matchesQuery("Anything", "")).toBe(true);
		expect(matchesQuery("Anything", "   ")).toBe(true);
	});
});
