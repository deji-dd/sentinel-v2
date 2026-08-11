import { describe, expect, test } from "bun:test";
import {
	generateAllianceMapPng,
	generateAllianceMapSvg,
} from "../src/lib/alliance-map-generator";
import {
	generateBurnMapPng,
	generateBurnMapSvg,
} from "../src/lib/burn-map-generator";

describe("alliance-map-generator", () => {
	test("generateAllianceMapSvg produces valid SVG string with xmlns", () => {
		const map = new Map<string, string>([["VHB", "#FF0000"]]);
		const svgBuf = generateAllianceMapSvg(map);
		const svgStr = svgBuf.toString("utf-8");

		expect(svgStr).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svgStr).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
	});

	test("generateAllianceMapPng converts SVG to PNG buffer without throwing", async () => {
		const map = new Map<string, string>([["VHB", "#FF0000"]]);
		const pngBuf = await generateAllianceMapPng(map);

		expect(pngBuf).toBeInstanceOf(Buffer);
		expect(pngBuf.length).toBeGreaterThan(0);
	}, 15000);
});

describe("burn-map-generator", () => {
	test("generateBurnMapSvg produces valid SVG string with xmlns", () => {
		const svgBuf = generateBurnMapSvg(["VHB"]);
		const svgStr = svgBuf.toString("utf-8");

		expect(svgStr).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svgStr).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
	});

	test("generateBurnMapPng converts SVG to PNG buffer without throwing", async () => {
		const pngBuf = await generateBurnMapPng(["VHB"], "Test Faction");

		expect(pngBuf).toBeInstanceOf(Buffer);
		expect(pngBuf.length).toBeGreaterThan(0);
	}, 15000);
});
