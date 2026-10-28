import { describe, expect, it } from "bun:test";

import { SHOPLIFTING_SHOPS } from "@sentinel/schemas";

import {
	buildConditionSelect,
	buildShopSelect,
	conditionSelectId,
	parseConditionSelectId,
	shopliftingAlertsCommand,
} from "../src/commands/shoplifting-alerts";

/** Discord's string-select cap. */
const DISCORD_SELECT_OPTION_LIMIT = 25;

function optionValues(
	row:
		| ReturnType<typeof buildConditionSelect>
		| ReturnType<typeof buildShopSelect>,
): string[] {
	const select = row.toJSON().components[0];
	if (!select || !("options" in select)) {
		throw new Error("Expected a string select menu");
	}
	return select.options.map((option) => option.value);
}

describe("Shoplifting alert command", () => {
	it("keeps the shop picker inside Discord's option cap", () => {
		const values = optionValues(buildShopSelect());

		expect(values).toHaveLength(SHOPLIFTING_SHOPS.length);
		expect(values.length).toBeLessThanOrEqual(DISCORD_SELECT_OPTION_LIMIT);
		expect(values).toContain("24");
	});

	it("offers all three triggers for a shop with cameras and a guard", () => {
		expect(optionValues(buildConditionSelect(24))).toEqual([
			"cameras_down",
			"guards_down",
			"all_down",
		]);
	});

	it("omits guards for a shop that has none", () => {
		expect(optionValues(buildConditionSelect(19))).toEqual(["cameras_down"]);
	});

	it("round-trips the shop id through the condition select's custom id", () => {
		const customId = conditionSelectId(24);
		expect(customId).toBe("shoplifting_alert_condition_select:24");
		expect(parseConditionSelectId(customId)).toBe(24);
	});

	it("rejects a malformed condition select id", () => {
		expect(parseConditionSelectId("shoplifting_alert_condition_select:x")).toBe(
			null,
		);
		expect(parseConditionSelectId("shoplifting_alert_condition_select")).toBe(
			null,
		);
	});

	it("registers the four subcommands at faction scope", () => {
		expect(shopliftingAlertsCommand.data.name).toBe("shoplifting-alerts");
		expect(shopliftingAlertsCommand.scope).toBe("faction");
		expect(
			shopliftingAlertsCommand.data
				.toJSON()
				.options?.map((option) => option.name),
		).toEqual(["add", "list", "remove", "clear"]);
	});
});
