import type { CapitalAlertChartContext } from "@sentinel/schemas";
import type { ChartConfiguration } from "chart.js";
import type { AnnotationOptions } from "chartjs-plugin-annotation";

import { renderChartPng } from "./chart-render";

/**
 * Unit-price chart for book insight alerts.
 *
 * Chart.js handles the scale, ticks and label placement; this module only
 * decides what to draw: the unit-price line, an optional reference level (the
 * previous extreme or par) and a marker at the alert's event time. Kept pure so
 * the configuration can be asserted without rendering a PNG.
 */

const WIDTH = 1200;
const HEIGHT = 520;

function fmtTime(iso: string): string {
	const date = new Date(iso);
	return Number.isFinite(date.getTime())
		? date.toISOString().slice(0, 16).replace("T", " ")
		: "";
}

export function buildCapitalNavChartConfig(
	input: CapitalAlertChartContext,
): ChartConfiguration<"line", number[], string> | null {
	const points = [...input.points].sort(
		(a, b) => Date.parse(a.capturedAtIso) - Date.parse(b.capturedAtIso),
	);
	if (points.length < 3) return null;

	const labels = points.map((point) => fmtTime(point.capturedAtIso));
	const values = points.map((point) => point.navPerUnit);

	let eventIndex = -1;
	if (input.eventAtIso) {
		const eventTime = Date.parse(input.eventAtIso);
		if (Number.isFinite(eventTime)) {
			let best = Number.POSITIVE_INFINITY;
			for (let index = 0; index < points.length; index++) {
				const distance = Math.abs(
					Date.parse(points[index]?.capturedAtIso ?? "") - eventTime,
				);
				if (distance < best) {
					best = distance;
					eventIndex = index;
				}
			}
		}
	}

	const annotations: Record<string, AnnotationOptions> = {};
	if (input.reference && Number.isFinite(input.reference.value)) {
		annotations.reference = {
			type: "line",
			scaleID: "y",
			value: input.reference.value,
			borderColor: "#f59e0b",
			borderDash: [7, 5],
			borderWidth: 1.5,
			label: {
				display: true,
				content: input.reference.label,
				position: "start",
				color: "#f59e0b",
				backgroundColor: "transparent",
			},
		};
	}
	const eventLabel = labels[eventIndex];
	if (eventLabel) {
		annotations.event = {
			type: "line",
			xMin: eventLabel,
			xMax: eventLabel,
			borderColor: "#475569",
			borderDash: [4, 4],
			borderWidth: 1,
			label: {
				display: true,
				content: "NOW",
				position: "end",
				color: "#22c55e",
				backgroundColor: "transparent",
			},
		};
	}

	const titles = [input.title, input.subtitle].filter(
		(value): value is string => Boolean(value),
	);

	return {
		type: "line",
		data: {
			labels,
			datasets: [
				{
					label: "Unit price (NAV per unit)",
					data: values,
					borderColor: "#60a5fa",
					backgroundColor: "rgba(59, 130, 246, 0.22)",
					borderWidth: 2.5,
					fill: "origin",
					tension: 0.18,
					pointRadius: (context) => (context.dataIndex === eventIndex ? 6 : 0),
					pointBackgroundColor: "#22c55e",
					pointBorderColor: "#0b1220",
					pointBorderWidth: 2,
				},
			],
		},
		options: {
			responsive: false,
			animation: false,
			layout: { padding: { top: 10, right: 12 } },
			plugins: {
				title: {
					display: titles.length > 0,
					text: titles,
					color: "#e2e8f0",
					align: "start",
					font: { size: 20, weight: "bold" },
					padding: { bottom: 14 },
				},
				legend: { display: false },
				annotation: { annotations },
			},
			scales: {
				x: {
					ticks: { color: "#94a3b8", maxTicksLimit: 6, maxRotation: 0 },
					grid: { color: "rgba(51, 65, 85, 0.5)" },
				},
				y: {
					ticks: {
						color: "#94a3b8",
						callback: (value) => Number(value).toFixed(4),
					},
					grid: { color: "rgba(51, 65, 85, 0.5)" },
				},
			},
		},
	};
}

export async function generateCapitalNavChartPng(
	input: CapitalAlertChartContext,
): Promise<Buffer | null> {
	const config = buildCapitalNavChartConfig(input);
	if (!config) return null;
	return renderChartPng(config, WIDTH, HEIGHT);
}
