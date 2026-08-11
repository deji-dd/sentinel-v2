import { Resvg } from "@resvg/resvg-js";
import { TORN_TERRITORY_MAP_SVG } from "../assets/torn-territory-map.js";

const DEFAULT_NEUTRAL_FILL = "#2c2c2c";
const DEFAULT_NEUTRAL_STROKE = "#444444";
const DEFAULT_NEUTRAL_OPACITY = "0.8";
const DEFAULT_FILLED_OPACITY = "0.84";

function darkenHex(hex: string, factor: number): string {
	const clean = hex.replace("#", "");
	if (clean.length !== 6) {
		return DEFAULT_NEUTRAL_STROKE;
	}

	const r = Math.max(
		0,
		Math.min(255, Math.floor(parseInt(clean.slice(0, 2), 16) * factor)),
	);
	const g = Math.max(
		0,
		Math.min(255, Math.floor(parseInt(clean.slice(2, 4), 16) * factor)),
	);
	const b = Math.max(
		0,
		Math.min(255, Math.floor(parseInt(clean.slice(4, 6), 16) * factor)),
	);

	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function generateAllianceMapSvg(
	territoryFillById: Map<string, string>,
): Buffer {
	let svg = TORN_TERRITORY_MAP_SVG;

	if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
		svg = svg.replace(/^<svg\s+/, '<svg xmlns="http://www.w3.org/2000/svg" ');
	}

	if (!svg.includes("xmlns:xlink")) {
		svg = svg.replace(
			/^<svg\s+/,
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink" ',
		);
	}

	svg = svg.replace(
		/(<svg[^>]*>)/,
		'$1<rect width="100%" height="100%" fill="#0a0a0a"/>',
	);

	svg = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "<defs></defs>");

	svg = svg.replace(/<path[^>]*>/g, (pathMatch) => {
		const isTerritory = pathMatch.includes('class="shape territory');

		if (!isTerritory) {
			let updated = pathMatch.replace(/fill="[^"]*"/, 'fill="none"');
			updated = updated.replace(/stroke="[^"]*"/, 'stroke="none"');
			updated = updated.replace(/fill-opacity="[^"]*"/, 'fill-opacity="0"');
			return updated;
		}

		const labelMatch = pathMatch.match(/aria-label="([^"]+)"/);
		const territoryCode = labelMatch?.[1] ?? "";
		const fillColor =
			territoryFillById.get(territoryCode) ?? DEFAULT_NEUTRAL_FILL;
		const hasAllianceColor = territoryFillById.has(territoryCode);
		const strokeColor = hasAllianceColor
			? darkenHex(fillColor, 0.78)
			: DEFAULT_NEUTRAL_STROKE;
		const opacity = hasAllianceColor
			? DEFAULT_FILLED_OPACITY
			: DEFAULT_NEUTRAL_OPACITY;

		let updated = pathMatch.replace(/fill="[^"]*"/, `fill="${fillColor}"`);
		updated = updated.replace(/stroke="[^"]*"/, `stroke="${strokeColor}"`);
		updated = updated.replace(
			/fill-opacity="[^"]*"/,
			`fill-opacity="${opacity}"`,
		);

		return updated;
	});

	return Buffer.from(svg, "utf-8");
}

export async function generateAllianceMapPng(
	territoryFillById: Map<string, string>,
): Promise<Buffer> {
	const svgBuffer = generateAllianceMapSvg(territoryFillById);

	try {
		const resvg = new Resvg(svgBuffer, { dpi: 150 });
		const rendered = resvg.render();
		return Buffer.from(rendered.asPng());
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to convert alliance SVG to PNG: ${errorMsg}`);
	}
}
