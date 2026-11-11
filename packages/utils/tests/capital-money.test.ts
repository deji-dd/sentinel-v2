import { describe, expect, test } from "bun:test";

import {
	addMoney,
	formatMoney,
	formatUnits,
	moneyFromPriceShares,
	mulBps,
	navFromValueUnits,
	parseMoney,
	parseUnits,
	unitsForAmount,
	valueOfUnits,
} from "../src/capital-money";

describe("capital money", () => {
	test("parses and formats decimal strings without float drift", () => {
		expect(formatMoney(parseMoney("1.2300"))).toBe("1.23");
		expect(formatMoney(parseMoney("0.1"))).toBe("0.1");
		expect(formatMoney(parseMoney("-12.5"))).toBe("-12.5");
		expect(formatUnits(parseUnits("123.456789"))).toBe("123.456789");
	});

	test("rounds half-up on the last retained digit", () => {
		expect(formatMoney(parseMoney("1.23455"))).toBe("1.2346");
		expect(formatMoney(parseMoney("-1.23455"))).toBe("-1.2346");
	});

	test("supports fund-scale values", () => {
		const aum = parseMoney("150000000000");
		expect(formatMoney(aum)).toBe("150000000000");
		expect(formatMoney(addMoney(aum, parseMoney("0.5")))).toBe(
			"150000000000.5",
		);
	});

	test("values a share notional and a unit balance", () => {
		const notional = moneyFromPriceShares("1167.56", 3);
		expect(formatMoney(notional)).toBe("3502.68");

		const oneDollar = parseMoney("1");
		const units = unitsForAmount(oneDollar, oneDollar);
		expect(units).toBe(1_000_000n);
		expect(formatMoney(valueOfUnits(oneDollar, units))).toBe("1");
	});

	test("derives NAV per unit", () => {
		const nav = navFromValueUnits(parseMoney("150.1"), 1_000_000n);
		expect(formatMoney(nav)).toBe("150.1");
	});

	test("applies basis points", () => {
		expect(formatMoney(mulBps(parseMoney("100"), 2500))).toBe("25");
		expect(formatMoney(mulBps(parseMoney("100"), 500))).toBe("5");
	});
});
