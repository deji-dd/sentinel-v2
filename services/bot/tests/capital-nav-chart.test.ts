import { describe, expect, it } from "bun:test";

import { Resvg } from "@resvg/resvg-js";
import type { CapitalAlertChartContext } from "@sentinel/schemas";

import { buildCapitalNavChartSvg } from "../src/lib/capital-nav-chart";

function context(count = 30): CapitalAlertChartContext {
	const start = Date.UTC(2026, 0, 1);
	return {
		title: "Unit price — new high",
		subtitle: "New all-time high $1.0450",
		points: Array.from({ length: count }, (_, index) => ({
			capturedAtIso: new Date(start + index * 3_600_000).toISOString(),
			navPerUnit: 1 + index * 0.0015,
		})),
		eventAtIso: new Date(start + (count - 1) * 3_600_000).toISOString(),
		reference: { value: 1.03, label: "Previous high" },
	};
}

describe("Capital unit-price chart", () => {
	it("draws the series, reference line and current marker", () => {
		const svg = buildCapitalNavChartSvg(context());
		expect(svg).not.toBeNull();
		expect(svg).toContain("Unit price — new high");
		expect(svg).toContain("Previous high");
		expect(svg).toContain("NOW");
		expect(svg).toContain("<polyline");
	});

	it("declines to chart without enough points", () => {
		expect(buildCapitalNavChartSvg(context(2))).toBeNull();
	});

	it("produces a renderable PNG for an alert attachment", () => {
		const svg = buildCapitalNavChartSvg(context());
		expect(svg).not.toBeNull();
		const png = new Resvg(svg ?? "", {
			fitTo: { mode: "width", value: 1200 },
		})
			.render()
			.asPng();
		expect(png.length).toBeGreaterThan(1000);
	}, 30_000);
});
