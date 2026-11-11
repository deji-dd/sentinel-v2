import { describe, expect, test } from "bun:test";

import { tornStockUrl } from "../../schemas/src/capital";

describe("capital links", () => {
	test("builds the owned-shares stock URL", () => {
		expect(tornStockUrl(26)).toBe(
			"https://www.torn.com/page.php?sid=stocks&stockID=26&tab=owned",
		);
	});
});
