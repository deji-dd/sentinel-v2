import { Resvg } from "@resvg/resvg-js";
import type { CapitalAlertChartContext } from "@sentinel/schemas";

/**
 * Unit-price chart for book insight alerts. Uses the same standalone SVG → PNG
 * path as the trade chart, so no new dependency or chart service is involved.
 * Kept pure (buildCapitalNavChartSvg) so the geometry can be tested without a
 * renderer.
 */

const WIDTH = 1200;
const HEIGHT = 520;
const LEFT = 82;
const RIGHT = 28;
const TOP = 118;
const BOTTOM = 450;

interface Point {
	x: number;
	y: number;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function text(
	x: number,
	y: number,
	value: string,
	color = "#94a3b8",
	size = 13,
	anchor: "start" | "middle" | "end" = "start",
	weight = "normal",
): string {
	return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${color}" font-family="Inter, Arial, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function fmtNav(value: number): string {
	return value.toFixed(4);
}

function fmtTime(iso: string): string {
	return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

export function buildCapitalNavChartSvg(
	input: CapitalAlertChartContext,
): string | null {
	const pointsInput = [...input.points].sort(
		(a, b) => Date.parse(a.capturedAtIso) - Date.parse(b.capturedAtIso),
	);
	if (pointsInput.length < 3) return null;

	const values = pointsInput.map((point) => point.navPerUnit);
	const levels = [...values];
	if (input.reference && Number.isFinite(input.reference.value)) {
		levels.push(input.reference.value);
	}
	let lower = Math.min(...levels);
	let upper = Math.max(...levels);
	if (!(upper > lower)) {
		lower -= 0.001;
		upper += 0.001;
	}
	const pad = (upper - lower) * 0.12;
	lower -= pad;
	upper += pad;

	const times = pointsInput.map((point) => Date.parse(point.capturedAtIso));
	const first = times[0] ?? 0;
	const last = times[times.length - 1] ?? first;
	const plotWidth = WIDTH - LEFT - RIGHT;
	const xAt = (index: number): number =>
		LEFT + (index / Math.max(1, pointsInput.length - 1)) * plotWidth;
	const yAt = (value: number): number =>
		BOTTOM - ((value - lower) / (upper - lower)) * (BOTTOM - TOP);

	const coords: Point[] = pointsInput.map((point, index) => ({
		x: xAt(index),
		y: yAt(point.navPerUnit),
	}));
	const linePoints = coords
		.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
		.join(" ");
	const areaPoints = `${LEFT},${BOTTOM} ${linePoints} ${(WIDTH - RIGHT).toFixed(1)},${BOTTOM}`;

	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
		`<rect width="100%" height="100%" fill="#0b1220"/>`,
		`<rect x="0" y="0" width="${WIDTH}" height="88" fill="#111c30"/>`,
		text(LEFT, 38, input.title, "#e2e8f0", 22, "start", "bold"),
	];
	if (input.subtitle) {
		parts.push(text(LEFT, 68, input.subtitle, "#94a3b8", 15));
	}
	parts.push(
		`<defs><linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>`,
	);

	for (let i = 0; i <= 4; i++) {
		const value = lower + ((upper - lower) * i) / 4;
		const y = yAt(value);
		parts.push(
			`<line x1="${LEFT}" y1="${y.toFixed(1)}" x2="${WIDTH - RIGHT}" y2="${y.toFixed(1)}" stroke="#334155" stroke-width="1" stroke-opacity="0.5"/>`,
			text(LEFT - 12, y + 4, fmtNav(value), "#64748b", 12, "end"),
		);
	}

	parts.push(
		`<polygon points="${areaPoints}" fill="url(#navFill)"/>`,
		`<polyline points="${linePoints}" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
	);

	if (input.reference && Number.isFinite(input.reference.value)) {
		const y = yAt(input.reference.value);
		parts.push(
			`<line x1="${LEFT}" y1="${y.toFixed(1)}" x2="${WIDTH - RIGHT}" y2="${y.toFixed(1)}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="7 5"/>`,
			text(
				WIDTH - RIGHT - 6,
				y - 8,
				input.reference.label,
				"#f59e0b",
				12,
				"end",
				"bold",
			),
		);
	}

	if (input.eventAtIso) {
		const eventTime = Date.parse(input.eventAtIso);
		if (Number.isFinite(eventTime) && last > first) {
			let closest = 0;
			let best = Number.POSITIVE_INFINITY;
			for (let i = 0; i < times.length; i++) {
				const distance = Math.abs((times[i] ?? 0) - eventTime);
				if (distance < best) {
					best = distance;
					closest = i;
				}
			}
			const point = coords[closest];
			if (point) {
				parts.push(
					`<line x1="${point.x.toFixed(1)}" y1="${TOP}" x2="${point.x.toFixed(1)}" y2="${BOTTOM}" stroke="#475569" stroke-width="1" stroke-dasharray="4 4"/>`,
					`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="7" fill="#22c55e" stroke="#0b1220" stroke-width="2"/>`,
					text(point.x, TOP - 10, "NOW", "#22c55e", 12, "middle", "bold"),
				);
			}
		}
	}

	parts.push(
		text(
			LEFT,
			HEIGHT - 32,
			fmtTime(input.points[0]?.capturedAtIso ?? ""),
			"#64748b",
			12,
		),
		text(
			WIDTH - RIGHT,
			HEIGHT - 32,
			fmtTime(input.points[input.points.length - 1]?.capturedAtIso ?? ""),
			"#64748b",
			12,
			"end",
		),
		text(
			WIDTH / 2,
			HEIGHT - 10,
			"—— Unit price (NAV per unit)    - - Reference    ● Current",
			"#475569",
			11,
			"middle",
		),
		"</svg>",
	);
	return parts.join("");
}

export async function generateCapitalNavChartPng(
	input: CapitalAlertChartContext,
): Promise<Buffer | null> {
	const svg = buildCapitalNavChartSvg(input);
	if (!svg) return null;
	return Buffer.from(
		new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng(),
	);
}
