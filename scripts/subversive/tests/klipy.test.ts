import { describe, expect, it } from "bun:test";

import {
	buildKlipyUrl,
	isKlipyMediaUrl,
	mapKlipyResponse,
} from "../src/chat/klipy";

const sample = {
	result: true,
	data: {
		data: [
			{
				id: 8041071659142944,
				slug: "hello-hi-662",
				title: "Hello",
				file: {
					hd: {
						gif: {
							url: "https://static.klipy.com/ii/abc/hello.gif",
							width: 498,
							height: 320,
						},
					},
					md: {
						gif: {
							url: "https://static.klipy.com/ii/abc/hello-md.gif",
							width: 320,
							height: 205,
						},
					},
					sm: {
						gif: {
							url: "https://static.klipy.com/ii/abc/hello-sm.gif",
							width: 160,
							height: 103,
						},
					},
					xs: {
						gif: {
							url: "https://static.klipy.com/ii/abc/hello-xs.gif",
							width: 80,
							height: 51,
						},
					},
				},
			},
			{
				// Content-only/ad item: no file.
				id: 1,
				title: "Ad",
				content: "https://example.com/ad",
			},
			{
				id: 2,
				title: "Other host",
				file: {
					hd: {
						gif: {
							url: "https://evil.example/a.gif",
							width: 100,
							height: 100,
						},
					},
				},
			},
		],
	},
};

describe("KLIPY URL", () => {
	it("builds the search endpoint with the app key in the path", () => {
		const url = buildKlipyUrl({
			apiKey: "test-key",
			query: "cat",
			customerId: 1934909,
		});
		expect(url).not.toBeNull();
		const parsed = new URL(url!);
		expect(parsed.hostname).toBe("api.klipy.com");
		expect(parsed.pathname).toBe("/api/v1/test-key/gifs/search");
		expect(parsed.searchParams.get("q")).toBe("cat");
		expect(parsed.searchParams.get("page")).toBe("1");
		expect(parsed.searchParams.get("per_page")).toBe("24");
		expect(parsed.searchParams.get("customer_id")).toBe("1934909");
		expect(parsed.searchParams.get("content_filter")).toBe("high");
	});

	it("uses trending for an empty query", () => {
		const parsed = new URL(
			buildKlipyUrl({ apiKey: "k", query: "  ", customerId: 1 })!,
		);
		expect(parsed.pathname.endsWith("/gifs/trending")).toBe(true);
		expect(parsed.searchParams.get("q")).toBeNull();
	});

	it("returns null without a key", () => {
		expect(
			buildKlipyUrl({ apiKey: "", query: "cat", customerId: 1 }),
		).toBeNull();
	});
});

describe("KLIPY response mapping", () => {
	it("maps the full-size and preview variants", () => {
		const results = mapKlipyResponse(sample);
		expect(results).toEqual([
			{
				id: "8041071659142944",
				url: "https://static.klipy.com/ii/abc/hello.gif",
				previewUrl: "https://static.klipy.com/ii/abc/hello-sm.gif",
				width: 498,
				height: 320,
				title: "Hello",
			},
		]);
	});

	it("skips content-only and non-KLIPY media", () => {
		expect(mapKlipyResponse(sample).length).toBe(1);
	});

	it("accepts KLIPY media hosts only", () => {
		expect(isKlipyMediaUrl("https://static.klipy.com/a.gif")).toBe(true);
		expect(isKlipyMediaUrl("https://static1.klipy.com/a.gif")).toBe(true);
		expect(isKlipyMediaUrl("https://klipy.com/a.gif")).toBe(true);
		expect(isKlipyMediaUrl("https://evil.example/a.gif")).toBe(false);
		expect(isKlipyMediaUrl("http://static.klipy.com/a.gif")).toBe(false);
		expect(isKlipyMediaUrl("javascript:alert(1)")).toBe(false);
	});
});
