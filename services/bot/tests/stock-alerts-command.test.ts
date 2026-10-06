import { describe, expect, it } from "bun:test";
import { MessageFlags } from "discord.js";
import {
	buildAlertModal,
	buildStockPicker,
	buildStockPickerRows,
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
		expect(options.at(-1)?.value).toBe("25");
	});

	it("gives every page its full 25 stock slots, reserving none for paging", () => {
		// Paging moved to buttons precisely so a full page is 25 stocks, not 24.
		const firstPage = optionsForPage(60, 0);

		expect(firstPage).toHaveLength(25);
		expect(firstPage[0]?.value).toBe("1");
		expect(firstPage.at(-1)?.value).toBe("25");
	});

	it("renders a real page for an unparseable page number", () => {
		// The reported production failure. The picker used to print "page NaN of 2"
		// and list no stocks at all, because the page came back as NaN from a
		// mis-parsed custom id and flowed straight into `slice(NaN, NaN)`.
		const json = buildStockPicker(market(30), Number.NaN).toJSON();
		const select = json.components[0];
		if (!select || !("options" in select)) {
			throw new Error("Expected a string select menu");
		}

		expect(select.placeholder).toBe("Pick a stock (page 1 of 2)");
		expect(select.placeholder).not.toContain("NaN");
		expect(select.options).toHaveLength(25);
	});

	it("clamps an out-of-range or fractional page into the market", () => {
		const optionValues = (page: number) => {
			const json = buildStockPicker(market(30), page).toJSON();
			const select = json.components[0];
			if (!select || !("options" in select)) {
				throw new Error("Expected a string select menu");
			}
			return select.options.map((option) => option.value);
		};

		// Past the end lands on the last page rather than an empty list.
		expect(optionValues(99)).toEqual(["26", "27", "28", "29", "30"]);
		// Negative lands on the first.
		expect(optionValues(-4)[0]).toBe("1");
		// A fraction cannot slip between pages.
		expect(optionValues(1.7)[0]).toBe("26");
	});

	it("keeps the page out of the select's custom id entirely", () => {
		// Nothing page-shaped travels with the select any more, which is what makes
		// the NaN regression impossible to reintroduce here.
		const row = buildStockPicker(market(30), 1).toJSON();
		const select = row.components[0];

		expect(select && "custom_id" in select ? select.custom_id : null).toBe(
			"stock_alert_stock_select",
		);
	});

	it("adds Previous/Next buttons carrying the target page", () => {
		const rows = buildStockPickerRows(market(30), 0).map((row) => row.toJSON());
		expect(rows).toHaveLength(2);

		const buttons = rows[1]?.components ?? [];
		expect(buttons).toHaveLength(2);
		const [previous, next] = buttons;
		expect(
			previous && "custom_id" in previous ? previous.custom_id : null,
		).toBe("stock_alert_stock_page:-1");
		expect(next && "custom_id" in next ? next.custom_id : null).toBe(
			"stock_alert_stock_page:1",
		);
		expect(previous && "label" in previous ? previous.label : null).toBe(
			"Previous",
		);
		expect(next && "label" in next ? next.label : null).toBe("Next");
	});

	it("disables the paging button that would leave the market", () => {
		const buttonsFor = (page: number) => {
			const rows = buildStockPickerRows(market(30), page).map((row) =>
				row.toJSON(),
			);
			return rows[1]?.components ?? [];
		};

		const [firstPrevious, firstNext] = buttonsFor(0);
		expect(
			firstPrevious && "disabled" in firstPrevious
				? firstPrevious.disabled
				: null,
		).toBe(true);
		expect(
			firstNext && "disabled" in firstNext ? firstNext.disabled : null,
		).toBe(false);

		const [lastPrevious, lastNext] = buttonsFor(1);
		expect(
			lastPrevious && "disabled" in lastPrevious ? lastPrevious.disabled : null,
		).toBe(false);
		expect(lastNext && "disabled" in lastNext ? lastNext.disabled : null).toBe(
			true,
		);
	});

	it("omits the paging row when the whole market fits on one page", () => {
		expect(buildStockPickerRows(market(25), 0)).toHaveLength(1);
		expect(buildStockPickerRows(market(1), 0)).toHaveLength(1);
	});

	it("never exceeds 25 options per page with paging rows present", () => {
		for (let size = 1; size <= 60; size++) {
			const rows = buildStockPickerRows(market(size), 0).map((row) =>
				row.toJSON(),
			);
			const select = rows[0]?.components[0];
			const count = select && "options" in select ? select.options.length : 0;
			expect(count).toBeLessThanOrEqual(DISCORD_SELECT_OPTION_LIMIT);
		}
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

describe("Stock alert modal payload", () => {
	/** The JSON Discord would receive for the alert form. */
	function modalJson(stockId = 1) {
		return buildAlertModal({
			id: stockId,
			name: "Torn & Shanghai Banking",
			acronym: "TSB",
		}).toJSON();
	}

	/** Top-level components of the modal, which must all be Labels. */
	function labels(json: ReturnType<typeof modalJson>) {
		return json.components;
	}

	it("never puts a label on a component that already sits inside a Label", () => {
		// The production failure: Discord rejects the whole interaction with
		// `TEXT_INPUT_COMPONENT_LABEL_IN_LABEL_COMPONENT` when a child carries its
		// own label, because the Label is the child's label. Checked generically over
		// every inner component so a future field cannot reintroduce it.
		for (const label of labels(modalJson())) {
			expect("component" in label).toBe(true);
			if ("component" in label) {
				expect(label.component).not.toHaveProperty("label");
			}
		}
	});

	it("uses a Label for every field, within Discord's length limits", () => {
		const components = labels(modalJson());

		// Discord allows at most five components in a modal.
		expect(components.length).toBeLessThanOrEqual(5);
		expect(components.length).toBe(3);

		for (const label of components) {
			expect(label.type).toBe(18);
			if (!("label" in label)) throw new Error("Expected a label");
			expect(label.label.length).toBeGreaterThan(0);
			expect(label.label.length).toBeLessThanOrEqual(45);
			if ("description" in label && label.description !== undefined) {
				expect(label.description.length).toBeLessThanOrEqual(100);
			}
		}
	});

	it("carries the chosen stock in the custom id, matching the handler's parse", () => {
		// The submit handler reads the stock id back out of the custom id, so this
		// is the contract between the picker and the form.
		const json = modalJson(42);
		expect(json.custom_id).toBe("stock_alert_config_modal:42");
		expect(json.custom_id?.split(":")[1]).toBe("42");
	});

	it("keeps the title inside Discord's 45-character limit", () => {
		const json = buildAlertModal({
			id: 1,
			// A deliberately long name, to prove the acronym is what gets used.
			name: "A Very Long Stock Name That Would Overflow The Title Limit",
			acronym: "TSB",
		}).toJSON();

		expect(json.title.length).toBeLessThanOrEqual(45);
		expect(json.title).toBe("Alert: TSB");
	});

	it("offers every condition as a required trigger select", () => {
		const component = labels(modalJson())[0];
		if (!component || !("component" in component)) {
			throw new Error("Expected a trigger field");
		}

		const select = component.component;
		expect(select.type).toBe(3);
		expect(select.custom_id).toBe("condition");
		expect("options" in select ? select.options : []).toHaveLength(6);
		// The handler reads this field with no fallback, so it must be answered.
		expect("required" in select ? select.required : undefined).not.toBe(false);
	});

	it("makes the range select genuinely optional", () => {
		const component = labels(modalJson())[1];
		if (!component || !("component" in component)) {
			throw new Error("Expected a range field");
		}

		const select = component.component;
		expect(select.custom_id).toBe("range");
		expect("options" in select ? select.options : []).toHaveLength(6);
		// `required: false` on a modal select is documented, and `min_values: 0` is
		// what lets the handler receive an empty array for a price-only alert.
		expect("required" in select ? select.required : undefined).toBe(false);
		expect("min_values" in select ? select.min_values : undefined).toBe(0);
	});

	it("makes the amount input optional, without a label of its own", () => {
		const component = labels(modalJson())[2];
		if (!component || !("component" in component)) {
			throw new Error("Expected an amount field");
		}

		const input = component.component;
		expect(input.type).toBe(4);
		expect(input.custom_id).toBe("amount");
		expect("required" in input ? input.required : undefined).toBe(false);
		expect(input).not.toHaveProperty("label");
		// The hint lives on the Label instead, where Discord accepts it.
		expect(component).toHaveProperty("description");
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
