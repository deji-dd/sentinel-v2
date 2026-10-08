import { describe, expect, test } from "bun:test";
import type {
	CompanyHistoryEntry,
	DailyBattlestatsTimeline,
	DailyCrimeTimeline,
} from "../src/types";
import { renderLineChart } from "../src/ui/chart-core";
import {
	renderBattlestatsSvgChart,
	renderCompanySvgChart,
	renderSvgChart,
} from "../src/ui/svg-chart";

/**
 * Markup-level coverage for the unified chart renderer.
 *
 * Three near-identical renderers became one, and the thing that regresses silently
 * is the markup: a missing axis, an area that never closes, an inaccessible chart,
 * or the compact-width label thinning quietly disappearing. The interactive half
 * needs a real DOM, but everything up to `querySelector` is deterministic string
 * assembly, and that is what these pin.
 */

/** Enough of an element for the renderer's pre-interaction path. */
function stubContainer(clientWidth = 540): HTMLElement {
	return {
		clientWidth,
		innerHTML: "",
		querySelector: () => null,
		querySelectorAll: () => [],
	} as unknown as HTMLElement;
}

function crimesData(days: number): DailyCrimeTimeline[] {
	return Array.from({ length: days }, (_, index) => ({
		date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
		count: 10 + index,
		nerve: 100 + index * 3,
		value: 1_000_000 + index * 50_000,
		efficiency: 5_000 + index,
	}));
}

function battlestatsData(days: number): DailyBattlestatsTimeline[] {
	return Array.from({ length: days }, (_, index) => ({
		date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
		strength: 1_000 + index,
		defense: 900 + index,
		speed: 800 + index,
		dexterity: 700 + index,
		totalGained: 5_000 + index * 10,
		trains: 3,
		energyUsed: 250 + index,
		count: 3,
	}));
}

function companyData(days: number): CompanyHistoryEntry[] {
	return Array.from({ length: days }, (_, index) => ({
		isoDate: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
		timestamp: 1_700_000_000 + index * 86_400,
		income: 10_000_000 + index * 100_000,
		wages: 2_000_000,
		adBudget: 500_000,
		expenses: 2_500_000,
		// One negative day, so the zero line and the negative-capable axis matter.
		profit: index === 2 ? -1_500_000 : 7_500_000 + index * 100_000,
		sold: 1_000 + index,
		produced: 1_100 + index,
		producedEstimated: false,
		stock: 20_000 + index,
		fillPct: 40,
		barrelPrice: 1_200,
	}));
}

describe("renderLineChart", () => {
	test("draws an accessible, focusable chart with a grid and axis labels", () => {
		const container = stubContainer();
		renderLineChart(container, {
			series: [
				{
					key: "a",
					label: "Alpha",
					color: "#38bdf8",
					values: [1, 2, 3],
					area: true,
				},
			],
			labels: ["Sep 1", "Sep 2", "Sep 3"],
			ariaLabel: "Alpha over three days",
			emptyMessage: "nothing here",
			formatPrimary: (value) => `$${Math.round(value)}`,
		});

		const html = container.innerHTML;
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-label="Alpha over three days"');
		expect(html).toContain('tabindex="0"');
		// Five grid lines (0..4) and their labels.
		expect((html.match(/stroke-dasharray="3,3"/g) ?? []).length).toBe(5);
		expect(html).toContain(">Sep 2<");
		expect(html).toContain("$3");
		// An area fill closes back to the baseline.
		expect(html).toContain('Z"');
		expect(html).not.toContain("undefined");
	});

	test("shows the empty state instead of an empty chart", () => {
		const container = stubContainer();
		renderLineChart(container, {
			series: [{ key: "a", label: "Alpha", color: "#fff", values: [] }],
			labels: [],
			ariaLabel: "nothing",
			emptyMessage: "No data recorded yet.",
		});

		expect(container.innerHTML).toContain("No data recorded yet.");
		expect(container.innerHTML).not.toContain("<svg");
	});

	test("thins axis labels in a narrow chart and keeps more in a wide one", () => {
		const narrow = stubContainer(320);
		renderLineChart(narrow, {
			series: [
				{ key: "a", label: "Alpha", color: "#fff", values: Array(30).fill(1) },
			],
			labels: Array.from({ length: 30 }, (_, i) => `d${i}`),
			ariaLabel: "narrow",
			emptyMessage: "none",
			width: 320,
		});
		const wide = stubContainer(900);
		renderLineChart(wide, {
			series: [
				{ key: "a", label: "Alpha", color: "#fff", values: Array(30).fill(1) },
			],
			labels: Array.from({ length: 30 }, (_, i) => `d${i}`),
			ariaLabel: "wide",
			emptyMessage: "none",
			width: 900,
		});

		const countLabels = (html: string) => (html.match(/>d\d+</g) ?? []).length;
		expect(countLabels(narrow.innerHTML)).toBeLessThan(
			countLabels(wide.innerHTML),
		);
	});

	test("gives a secondary axis its own labels on the right", () => {
		const container = stubContainer();
		renderLineChart(container, {
			series: [
				{ key: "g", label: "Gain", color: "#38bdf8", values: [10, 20, 30] },
				{
					key: "e",
					label: "Energy",
					color: "#f59e0b",
					values: [100, 200, 300],
					axis: "secondary",
				},
			],
			labels: ["a", "b", "c"],
			ariaLabel: "dual axis",
			emptyMessage: "none",
			formatSecondary: (value) => `${Math.round(value)}E`,
		});

		expect(container.innerHTML).toContain("300E");
		// Five right-axis labels, matching the five grid lines.
		expect((container.innerHTML.match(/E</g) ?? []).length).toBe(5);
	});

	test("draws a zero line when the series goes negative", () => {
		const container = stubContainer();
		renderLineChart(container, {
			series: [
				{
					key: "p",
					label: "Profit",
					color: "#38bdf8",
					values: [5, -5, 3],
					area: true,
				},
			],
			labels: ["a", "b", "c"],
			ariaLabel: "profit",
			emptyMessage: "none",
			allowNegative: true,
			zeroLine: true,
		});

		// The solid zero line is the only stroke without a dash pattern at that width.
		expect(container.innerHTML).toContain(
			'stroke="#475569" stroke-width="1.5"',
		);
		expect(container.innerHTML).not.toContain("NaN");
	});
});

describe("chart adapters", () => {
	test("crimes financials and activity modes both render series", () => {
		for (const metricMode of ["financials", "activity"] as const) {
			const container = stubContainer();
			renderSvgChart(container, {
				data: crimesData(14),
				metricMode,
				width: 540,
			});
			expect(container.innerHTML).toContain("<svg");
			expect(container.innerHTML).toContain('role="img"');
			expect(container.innerHTML).toContain("chart-scrub-dot");
			expect(container.innerHTML).not.toContain("undefined");
		}
	});

	test("battlestats stats mode draws four attribute lines", () => {
		const container = stubContainer();
		renderBattlestatsSvgChart(container, {
			data: battlestatsData(21),
			mode: "stats",
			width: 540,
		});

		const html = container.innerHTML;
		for (const color of ["#f97316", "#06b6d4", "#10b981", "#a855f7"]) {
			expect(html).toContain(color);
		}
		// Four dots, one per attribute, and no area fill in this mode.
		expect((html.match(/chart-scrub-dot/g) ?? []).length).toBe(4);
	});

	test("battlestats energy mode keeps its energy labels and drops the energy dot", () => {
		const container = stubContainer();
		renderBattlestatsSvgChart(container, {
			data: battlestatsData(21),
			mode: "energy",
			width: 540,
		});

		const html = container.innerHTML;
		expect(html).toContain("E<");
		// The energy series is on the secondary axis and needs no dot of its own.
		expect((html.match(/chart-scrub-dot/g) ?? []).length).toBe(1);
	});

	test("company financials mode shows a negative day and production mode three series", () => {
		const financial = stubContainer();
		renderCompanySvgChart(financial, {
			data: companyData(30),
			mode: "financials",
			width: 540,
		});
		expect(financial.innerHTML).toContain(
			'stroke="#475569" stroke-width="1.5"',
		);

		const production = stubContainer();
		renderCompanySvgChart(production, {
			data: companyData(30),
			mode: "production",
			width: 540,
		});
		expect((production.innerHTML.match(/chart-scrub-dot/g) ?? []).length).toBe(
			3,
		);
	});

	test("every adapter renders the empty state for an empty payload", () => {
		const crimes = stubContainer();
		renderSvgChart(crimes, { data: [], metricMode: "financials" });
		expect(crimes.innerHTML).toContain("No timeline data recorded");

		const battlestats = stubContainer();
		renderBattlestatsSvgChart(battlestats, { data: [], mode: "stats" });
		expect(battlestats.innerHTML).toContain("No battlestats training timeline");

		const company = stubContainer();
		renderCompanySvgChart(company, { data: [], mode: "financials" });
		expect(company.innerHTML).toContain("No historical company snapshots");

		for (const container of [crimes, battlestats, company]) {
			expect(container.innerHTML).not.toContain("<svg");
		}
	});
});
