import { describe, expect, it } from "bun:test";

import { parseOilDmCommand } from "../src/lib/oil-dm-commands";

describe("Oil rig DM triggers", () => {
	it("accepts the normalised brief trigger", () => {
		expect(parseOilDmCommand("brief")).toBe("brief");
		expect(parseOilDmCommand("  BRIEF  ")).toBe("brief");
		expect(parseOilDmCommand("!brief")).toBe("brief");
	});

	it("accepts the employee positioning trigger", () => {
		expect(parseOilDmCommand("positions")).toBe("positions");
		expect(parseOilDmCommand("!positions")).toBe("positions");
	});

	it("no longer accepts the old oil/briefing aliases", () => {
		expect(parseOilDmCommand("oil")).toBeNull();
		expect(parseOilDmCommand("!oil")).toBeNull();
		expect(parseOilDmCommand("briefing")).toBeNull();
		expect(parseOilDmCommand("!briefing")).toBeNull();
	});

	it("ignores ordinary chat", () => {
		expect(parseOilDmCommand("what are my positions?")).toBeNull();
	});
});
