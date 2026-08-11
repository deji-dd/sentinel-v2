/**
 * Burn map SVG generator
 * Generates a visual map showing territories a faction cannot assault
 */

import { Resvg } from "@resvg/resvg-js";
import { TORN_TERRITORY_MAP_SVG } from "../assets/torn-territory-map.js";

// Neutral colors for reset
const NEUTRAL_FILL = "#2c2c2c"; // Dark gray
const NEUTRAL_STROKE = "#444444"; // Lighter gray
const NEUTRAL_OPACITY = "0.8"; // 80% opacity for visibility

// Burn overlay colors
const BURN_FILL = "#dc2626"; // Red
const BURN_STROKE = "#991b1b"; // Dark red
const BURN_OPACITY = "0.95"; // 95% opacity for visibility

/**
 * Generate a burn map SVG showing territories that cannot be assaulted
 * @param burnedTerritoryIds Array of territory IDs (as strings) that are burned
 * @returns Buffer containing the modified SVG
 */
export function generateBurnMapSvg(burnedTerritoryIds: string[]): Buffer {
	let svg = TORN_TERRITORY_MAP_SVG;

	if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
		svg = svg.replace(/^<svg\s+/, '<svg xmlns="http://www.w3.org/2000/svg" ');
	}

	// Ensure xlink namespace is declared (required for images within the SVG)
	if (!svg.includes("xmlns:xlink")) {
		svg = svg.replace(
			/^<svg\s+/,
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink" ',
		);
	}

	// Add dark background rectangle right after opening SVG tag
	svg = svg.replace(
		/(<svg[^>]*>)/,
		'$1<rect width="100%" height="100%" fill="#0a0a0a"/>',
	);

	// Remove pattern definitions that create colored blocks
	svg = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "<defs></defs>");

	// Create set of burned territory IDs for faster lookup
	const burnedSet = new Set(burnedTerritoryIds);

	// Process all path elements - only modify territory paths to be colored
	svg = svg.replace(/<path[^>]*>/g, (pathMatch) => {
		// Check if it's a territory path with class="shape territory"
		const isTerritory =
			pathMatch.includes('class="shape territory') ||
			(pathMatch.includes("territory") && pathMatch.includes("aria-label"));

		if (!isTerritory) {
			// Non-territory paths: make them invisible (no fill, no stroke)
			let updated = pathMatch.replace(/fill="[^"]*"/, 'fill="none"');
			updated = updated.replace(/stroke="[^"]*"/, 'stroke="none"');
			updated = updated.replace(/fill-opacity="[^"]*"/, 'fill-opacity="0"');
			return updated;
		}

		// Territory path: apply burn or neutral coloring
		// Extract aria-label (3-letter territory code) to check if burned
		const labelMatch = pathMatch.match(/aria-label="([^"]+)"/);
		const territoryCode = labelMatch?.[1];
		const isBurned = territoryCode && burnedSet.has(territoryCode);

		const fillColor = isBurned ? BURN_FILL : NEUTRAL_FILL;
		const strokeColor = isBurned ? BURN_STROKE : NEUTRAL_STROKE;
		const opacity = isBurned ? BURN_OPACITY : NEUTRAL_OPACITY;

		// Replace colors within this path element
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

/**
 * Generate burn map with legend
 * @param burnedTerritoryIds Array of territory IDs that are burned
 * @param factionName Name of faction (for title)
 * @param stats Optional statistics to display
 */
export function generateBurnMapWithLegend(
	burnedTerritoryIds: string[],
	_factionName: string,
	_stats?: {
		totalTerritories: number;
		burnedCount: number;
		availableCount: number;
	},
): Buffer {
	let svg = TORN_TERRITORY_MAP_SVG;

	if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
		svg = svg.replace(/^<svg\s+/, '<svg xmlns="http://www.w3.org/2000/svg" ');
	}

	// Ensure xlink namespace is declared (required for images within the SVG)
	if (!svg.includes("xmlns:xlink")) {
		svg = svg.replace(
			/^<svg\s+/,
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink" ',
		);
	}

	// Add dark background rectangle right after opening SVG tag
	svg = svg.replace(
		/(<svg[^>]*>)/,
		'$1<rect width="100%" height="100%" fill="#0a0a0a"/>',
	);

	// Remove pattern definitions that create colored blocks
	svg = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "<defs></defs>");

	// Create set of burned territory IDs for faster lookup
	const burnedSet = new Set(burnedTerritoryIds);

	// Process all path elements - colorize territories, hide everything else
	svg = svg.replace(/<path[^>]*>/g, (pathMatch) => {
		// Check if this is an actual territory (has class="shape territory")
		const isTerritory = pathMatch.includes('class="shape territory');

		if (!isTerritory) {
			// Non-territory paths (dumps, hospitals, etc.): hide them completely
			let updated = pathMatch.replace(/fill="[^"]*"/, 'fill="none"');
			updated = updated.replace(/stroke="[^"]*"/, 'stroke="none"');
			updated = updated.replace(/fill-opacity="[^"]*"/, 'fill-opacity="0"');
			return updated;
		}

		// Territory path: extract aria-label (3-letter territory code) to check if burned
		const labelMatch = pathMatch.match(/aria-label="([^"]+)"/);
		const territoryCode = labelMatch?.[1];
		const isBurned = territoryCode && burnedSet.has(territoryCode);

		const fillColor = isBurned ? BURN_FILL : NEUTRAL_FILL;
		const strokeColor = isBurned ? BURN_STROKE : NEUTRAL_STROKE;
		const opacity = isBurned ? BURN_OPACITY : NEUTRAL_OPACITY;

		// Replace colors within this path element
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

/**
 * Convert burn map SVG to PNG for Discord embedding
 * @param svgBuffer Buffer containing SVG data
 * @returns Promise<Buffer> containing PNG data
 */
export async function convertSvgToPng(svgBuffer: Buffer): Promise<Buffer> {
	try {
		const resvg = new Resvg(svgBuffer, { dpi: 150 });
		const rendered = resvg.render();
		return Buffer.from(rendered.asPng());
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to convert SVG to PNG: ${errorMsg}`);
	}
}

/**
 * Generate a complete burn map PNG ready for Discord
 * @param burnedTerritoryIds Array of territory IDs that are burned
 * @param factionName Name of faction
 * @param stats Optional statistics
 * @returns Promise<Buffer> containing PNG data
 */
export async function generateBurnMapPng(
	burnedTerritoryIds: string[],
	factionName: string,
	stats?: {
		totalTerritories: number;
		burnedCount: number;
		availableCount: number;
	},
): Promise<Buffer> {
	const svgBuffer = generateBurnMapWithLegend(
		burnedTerritoryIds,
		factionName,
		stats,
	);
	return convertSvgToPng(svgBuffer);
}
