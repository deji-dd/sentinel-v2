import type { ChartConfiguration } from "chart.js";

import { renderChartPng } from "./chart-render";

/**
 * Horizontal bar chart for the YABA top-10 embeds.
 *
 * Chart.js owns the scales, ranked labels and bar layout; this module only
 * decides which rows to draw and how to label them. Kept pure (apart from the
 * final PNG render) so the config can be asserted without the native canvas.
 */

const WIDTH = 1200;
const HEIGHT = 620;
const TOP_ROWS = 10;
const MAX_NAME_LENGTH = 28;

function truncateName(name: string): string {
	return name.length > MAX_NAME_LENGTH
		? `${name.slice(0, MAX_NAME_LENGTH - 1)}…`
		: name;
}

export function buildYabaTopTenChartConfig(
	rows: Array<{ name: string; score: number }>,
	title: string,
): ChartConfiguration<"bar", number[], string> {
	const topRows = rows.slice(0, TOP_ROWS);
	const labels = topRows.map(
		(row, index) => `#${index + 1} ${truncateName(row.name)}`,
	);
	const scores = topRows.map((row) => row.score);

	return {
		type: "bar",
		data: {
			labels,
			datasets: [
				{
					label: "Score",
					data: scores,
					backgroundColor: "rgba(59, 130, 246, 0.75)",
					borderColor: "#60a5fa",
					borderWidth: 1,
					borderRadius: 4,
					barPercentage: 0.72,
				},
			],
		},
		options: {
			responsive: false,
			animation: false,
			indexAxis: "y",
			layout: { padding: { top: 10, right: 24, bottom: 8 } },
			plugins: {
				title: {
					display: title.length > 0,
					text: title,
					color: "#e2e8f0",
					align: "start",
					font: { size: 20, weight: "bold" },
					padding: { bottom: 14 },
				},
				legend: { display: false },
			},
			scales: {
				x: {
					beginAtZero: true,
					ticks: {
						color: "#94a3b8",
						maxTicksLimit: 7,
						callback: (value) => Number(value).toLocaleString("en-US"),
					},
					grid: { color: "rgba(51, 65, 85, 0.5)" },
				},
				y: {
					ticks: { color: "#e2e8f0", font: { size: 13 } },
					grid: { display: false },
				},
			},
		},
	};
}

/** Renders the top-10 PNG attached to a YABA chart embed. */
export function renderYabaTopTenChartPng(
	rows: Array<{ name: string; score: number }>,
	title: string,
): Buffer {
	return renderChartPng(buildYabaTopTenChartConfig(rows, title), WIDTH, HEIGHT);
}
