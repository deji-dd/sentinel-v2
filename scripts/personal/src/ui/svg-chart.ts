import {
	formatCompactNumber,
	formatMoney,
	formatNumber,
	parseDateOnly,
} from "../config";
import type {
	CompanyHistoryEntry,
	DailyBattlestatsTimeline,
	DailyCrimeTimeline,
} from "../types";
import { type ChartSeries, renderLineChart } from "./chart-core";

/**
 * The three dashboards' charts, expressed as options for one renderer.
 *
 * Everything that used to be duplicated — scales, grid, axis labels, path
 * assembly, the scrubber and its mouse/touch handling — lives in `chart-core`.
 * What stays here is only what genuinely differs per dashboard: which series are
 * drawn, how values are formatted, and what the readout says.
 */

export interface ChartRenderOptions {
	data: DailyCrimeTimeline[];
	metricMode: "financials" | "activity";
	width?: number;
	height?: number;
	onScrub?: (item: DailyCrimeTimeline | null) => void;
}

/** `2026-10-08` as "Oct 8", falling back to the raw string. */
function shortDate(value: string): string {
	const parsed = parseDateOnly(value);
	if (Number.isNaN(parsed.getTime())) return value;
	return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `2026-10-08` as "10/08", as the battlestats axis has always printed it. */
function numericDate(value: string): string {
	const parts = value.split("-");
	return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : value;
}

export function renderSvgChart(
	container: HTMLElement,
	options: ChartRenderOptions,
): void {
	const { data, metricMode, width, height = 220, onScrub } = options;
	const isFinancial = metricMode === "financials";

	const series: ChartSeries[] = isFinancial
		? [
				{
					key: "value",
					label: "Loot value",
					color: "#38bdf8",
					values: data.map((d) => d.value),
					area: true,
				},
				{
					key: "efficiency",
					label: "ROI per nerve",
					color: "#34d399",
					values: data.map((d) => d.efficiency),
					dashed: true,
				},
			]
		: [
				{
					key: "count",
					label: "Attempts",
					color: "#38bdf8",
					values: data.map((d) => d.count),
					area: true,
				},
				{
					key: "nerve",
					label: "Nerve spent",
					color: "#fbbf24",
					values: data.map((d) => d.nerve),
					dashed: true,
				},
			];

	renderLineChart(container, {
		series,
		labels: data.map((d) => shortDate(d.date)),
		ariaLabel: isFinancial
			? `Daily crime loot value and ROI per nerve over ${data.length} days`
			: `Daily crime attempts and nerve spent over ${data.length} days`,
		emptyMessage: "No timeline data recorded for this timeframe.",
		width,
		height,
		formatPrimary: isFinancial ? formatMoney : formatNumber,
		stretch: true,
		onScrub: (index) => {
			onScrub?.(index === null ? null : (data[index] ?? null));
		},
	});
}

export interface BattlestatsChartRenderOptions {
	data: DailyBattlestatsTimeline[];
	mode: "stats" | "energy";
	width?: number;
	height?: number;
	onScrub?: (item: DailyBattlestatsTimeline | null) => void;
}

export function renderBattlestatsSvgChart(
	container: HTMLElement,
	options: BattlestatsChartRenderOptions,
): void {
	const { data, mode, width, height = 220, onScrub } = options;

	const series: ChartSeries[] =
		mode === "stats"
			? [
					{
						key: "strength",
						label: "Strength",
						color: "#f97316",
						values: data.map((d) => d.strength),
					},
					{
						key: "defense",
						label: "Defence",
						color: "#06b6d4",
						values: data.map((d) => d.defense),
					},
					{
						key: "speed",
						label: "Speed",
						color: "#10b981",
						values: data.map((d) => d.speed),
					},
					{
						key: "dexterity",
						label: "Dexterity",
						color: "#a855f7",
						values: data.map((d) => d.dexterity),
					},
				]
			: [
					{
						key: "totalGained",
						label: "Stat gained",
						color: "#38bdf8",
						values: data.map((d) => d.totalGained),
						area: true,
					},
					{
						key: "energyUsed",
						label: "Energy used",
						color: "#f59e0b",
						values: data.map((d) => d.energyUsed),
						axis: "secondary",
						dashed: true,
						dot: false,
					},
				];

	renderLineChart(container, {
		series,
		labels: data.map((d) => numericDate(d.date)),
		ariaLabel:
			mode === "stats"
				? `Daily stat gains per attribute over ${data.length} days`
				: `Daily stat gained and energy used over ${data.length} days`,
		emptyMessage:
			"No battlestats training timeline recorded for this timeframe.",
		width,
		height,
		formatPrimary: formatNumber,
		formatSecondary: (value) => `${Math.round(value)}E`,
		onScrub: (index) => {
			onScrub?.(index === null ? null : (data[index] ?? null));
		},
	});
}

export interface CompanyChartRenderOptions {
	data: CompanyHistoryEntry[];
	mode: "financials" | "production";
	width?: number;
	height?: number;
	onScrub?: (item: CompanyHistoryEntry | null) => void;
}

export function renderCompanySvgChart(
	container: HTMLElement,
	options: CompanyChartRenderOptions,
): void {
	const { data, mode, width, height = 220, onScrub } = options;
	const isFinancial = mode === "financials";

	const series: ChartSeries[] = isFinancial
		? [
				{
					key: "income",
					label: "Revenue",
					color: "#10b981",
					values: data.map((d) => d.income),
				},
				{
					key: "expenses",
					label: "Expenses",
					color: "#f43f5e",
					values: data.map((d) => d.expenses),
					dashed: true,
				},
				{
					key: "profit",
					label: "Net profit",
					color: "#38bdf8",
					values: data.map((d) => d.profit),
					area: true,
				},
			]
		: [
				{
					key: "stock",
					label: "Barrels in stock",
					color: "#a855f7",
					values: data.map((d) => d.stock),
				},
				{
					key: "sold",
					label: "Barrels sold",
					color: "#f59e0b",
					values: data.map((d) => d.sold),
				},
				{
					key: "produced",
					label: "Barrels produced",
					color: "#38bdf8",
					values: data.map((d) => d.produced),
				},
			];

	renderLineChart(container, {
		series,
		labels: data.map((d) => shortDate(d.isoDate)),
		ariaLabel: isFinancial
			? `Daily company revenue, expenses and net profit over ${data.length} days`
			: `Daily barrels in stock, sold and produced over ${data.length} days`,
		emptyMessage: "No historical company snapshots recorded yet.",
		width,
		height,
		// Profit can be negative, and the axis has to show that rather than clip it.
		allowNegative: isFinancial,
		zeroLine: isFinancial,
		formatPrimary: isFinancial
			? formatMoney
			: (value) => formatCompactNumber(value, 0),
		stretch: true,
		onScrub: (index) => {
			onScrub?.(index === null ? null : (data[index] ?? null));
		},
	});
}
