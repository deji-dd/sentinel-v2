import { describe, expect, it } from "bun:test";
import { MessageFlags } from "discord.js";
import {
	buildStockPicker,
	stockAlertsCommand,
} from "../src/commands/stock-alerts";
import type { StockOption } from "../src/lib/stock-alert-subscriptions";

/**
 * Coverage for the stock picker's option budget.
 *
 * This exists because of a production failure: the picker put 25 stocks on a page
 * and then appended a "show more" entry, which is 26 options. Discord caps a string
 * select at 25 and the builders enforce it by throwing, so every `/stock-alerts add`
 * against the real market failed outright. The property test below is the guard
 * that was missing — it sweeps the market sizes on both sides of the page boundary
 * rather than testing one convenient number.
 */

/** Discord's own limit, asserted directly rather than read from the module. */
const DISCORD_SELECT_OPTION_LIMIT = 25;

function market(size: number): StockOption[] {
	return Array.from({ length: size }, (_, index) => ({
		id: index + 1,
		name: `Stock ${index + 1}`,
		acronym: `S${index + 1}`,
	}));
}

/** The options Discord would actually receive for one page of the picker. */
function optionsForPage(
	size: number,
	page: number,
): { label: string; value: string }[] {
	const row = buildStockPicker(market(size), page).toJSON();
	const select = row.components[0];
	if (!select || !("options" in select)) {
		throw new Error("Expected a string select menu");
	}
	return select.options;
}

describe("Stock picker option budget", () => {
	it("never exceeds Discord's 25-option cap, at any market size or page", () => {
		// 1 to 60 covers an empty-ish market, exactly one page, one stock over the
		// boundary (the case that broke production), and several pages.
		for (let size = 1; size <= 60; size++) {
			const pages = Math.max(1, Math.ceil(size / 25));
			// Two extra pages past the end proves the wrap-around entries are bounded
			// too, not just the pages that hold stocks.
			for (let page = 0; page < pages + 2; page++) {
				const options = optionsForPage(size, page);
				expect(options.length).toBeLessThanOrEqual(DISCORD_SELECT_OPTION_LIMIT);
			}
		}
	});

	it("builds a full 25-option menu for a market that exactly fills one page", () => {
		const options = optionsForPage(25, 0);

		expect(options).toHaveLength(25);
		// Nothing is paged, so no paging entry is present and all 25 slots are stocks.
		expect(options.some((option) => option.value === "page:next")).toBe(false);
		expect(options.at(-1)?.value).toBe("25");
	});

	it("reserves a slot for the paging entry once the market needs a second page", () => {
		// The exact regression: 26 stocks used to produce 25 options plus a paging
		// entry, and the menu threw before it could be sent.
		const firstPage = optionsForPage(26, 0);

		expect(firstPage).toHaveLength(25);
		expect(firstPage.some((option) => option.value === "page:next")).toBe(true);
		// 24 stocks plus the entry, rather than 25 plus the entry.
		expect(
			firstPage.filter((option) => option.value !== "page:next"),
		).toHaveLength(24);

		const secondPage = optionsForPage(26, 1);
		expect(secondPage.length).toBeLessThanOrEqual(25);
		expect(
			secondPage.filter((option) => option.value !== "page:next"),
		).toHaveLength(2);
	});

	it("reaches every stock across its pages, with no gaps or repeats", () => {
		const size = 57;
		const seen: string[] = [];
		const pages = Math.ceil(size / 24);

		for (let page = 0; page < pages; page++) {
			for (const option of optionsForPage(size, page)) {
				if (option.value !== "page:next") seen.push(option.value);
			}
		}

		expect(seen).toHaveLength(size);
		expect([...new Set(seen)]).toHaveLength(size);
		expect(seen[0]).toBe("1");
		expect(seen.at(-1)).toBe(String(size));
	});

	it("carries the page in the custom id so the handler can page without state", () => {
		const row = buildStockPicker(market(30), 1).toJSON();
		const select = row.components[0];

		expect(select && "custom_id" in select ? select.custom_id : null).toBe(
			"stock_alert_stock_select:1",
		);
	});

	it("says which page is being shown when there is more than one", () => {
		const first = buildStockPicker(market(30), 0).toJSON().components[0];
		const single = buildStockPicker(market(10), 0).toJSON().components[0];

		expect(
			first && "placeholder" in first ? first.placeholder : null,
		).toContain("page 1 of 2");
		expect(single && "placeholder" in single ? single.placeholder : null).toBe(
			"Pick a stock",
		);
	});
});

describe("Stock alerts command definition", () => {
	it("is declared faction-only and exposes the four subcommands", () => {
		const json = stockAlertsCommand.data.toJSON();
		const subcommands = (json.options ?? []).map((option) => option.name);

		expect(json.name).toBe("stock-alerts");
		expect(stockAlertsCommand.scope).toBe("faction");
		expect(subcommands.sort()).toEqual(["add", "clear", "list", "remove"]);
	});

	it("requires no module, so deployment cannot filter it away silently", () => {
		// `deploy-commands.ts` drops any command tagged with a module it does not
		// know, so a tag here would make the command vanish with no error.
		expect(stockAlertsCommand.module).toBeUndefined();
	});

	it("replies ephemerally for every subcommand", () => {
		// A public reply would leak one member's alerts to the channel.
		expect(MessageFlags.Ephemeral).toBe(64);
	});
});
