import { createCanvas } from "@napi-rs/canvas";
import {
	Chart,
	type ChartConfiguration,
	type ChartItem,
	type Plugin,
	registerables,
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";

/**
 * Server-side chart rendering for Discord alert attachments.
 *
 * Chart.js owns scales, axes, legends and label placement; `@napi-rs/canvas`
 * gives it a canvas in Bun without a browser. The annotation plugin draws the
 * reference levels and event markers that used to be hand-positioned SVG —
 * where they regularly collided with axis labels.
 *
 * The font family is explicit because the production image installs a single
 * sans-serif font (DejaVu). Without a font available to the canvas renderer,
 * alert charts come out as lines on a blank background with no text at all.
 */
Chart.register(...registerables, annotationPlugin);
Chart.defaults.font.family = "DejaVu Sans, sans-serif";
Chart.defaults.color = "#94a3b8";

const darkBackground: Plugin = {
	id: "capitalDarkBackground",
	beforeDraw: (chart) => {
		const context = chart.ctx as unknown as {
			fillStyle: string;
			fillRect: (x: number, y: number, w: number, h: number) => void;
		};
		context.fillStyle = "#0b1220";
		context.fillRect(0, 0, chart.width, chart.height);
	},
};
Chart.register(darkBackground);

export function renderChartPng(
	config: ChartConfiguration,
	width: number,
	height: number,
): Buffer {
	const canvas = createCanvas(width, height);
	// Chart.js is typed against the browser canvas API; the server-side canvas
	// has the same drawing surface without DOM globals being in scope here.
	const rawContext = canvas.getContext("2d");
	const chart = new Chart(rawContext as unknown as ChartItem, config);
	chart.draw();
	return canvas.toBuffer("image/png");
}
