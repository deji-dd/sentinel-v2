import { describe, expect, it } from "bun:test";

import type { CapitalAlertChartContext } from "@sentinel/schemas";

import {
	buildCapitalNavChartConfig,
	generateCapitalNavChartPng,
} from "../src/lib/capital-nav-chart";

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

function annotationContent(
	config: NonNullable<ReturnType<typeof buildCapitalNavChartConfig>>,
	key: string,
): string {
	const annotations = config.options?.plugins?.annotation?.annotations as
		Record<string, { label?: { content?: string } }> | undefined;
	const label = annotations?.[key]?.label;
	return typeof label?.content === "string" ? label.content : "";
}

describe("Capital unit-price chart", () => {
	it("draws the series, reference line and current marker", () => {
		const config = buildCapitalNavChartConfig(context());
		expect(config).not.toBeNull();
		const title = config?.options?.plugins?.title?.text;
		expect(JSON.stringify(title)).toContain("Unit price — new high");
		expect(JSON.stringify(title)).toContain("New all-time high $1.0450");
		expect(annotationContent(config!, "reference")).toBe("Previous high");
		expect(annotationContent(config!, "event")).toBe("NOW");
		expect(config?.data.datasets[0]?.data.length).toBe(30);
	});

	it("declines to chart without enough points", () => {
		expect(buildCapitalNavChartConfig(context(2))).toBeNull();
	});

	it("produces a renderable PNG for an alert attachment", async () => {
		const png = await generateCapitalNavChartPng(context());
		expect(png).not.toBeNull();
		expect(png?.length).toBeGreaterThan(1000);
	}, 30_000);
});
