import { describe, expect, it } from "bun:test";

import type { UserShopliftingAlertEvent } from "@sentinel/schemas";

import {
	buildShopliftingAlertEmbed,
	SHOPLIFTING_URL,
} from "../src/lib/shoplifting-alert-distributor";

function event(
	patch: Partial<UserShopliftingAlertEvent> = {},
): UserShopliftingAlertEvent {
	return {
		subscriptionId: "sub-1",
		discordUserId: "555555555555555555",
		condition: "guards_down",
		transition: "down",
		description: "Guards on break at Jewelry Store.",
		shopId: 24,
		shopName: "Jewelry Store",
		statuses: [
			{ title: "Three cameras", disabled: false },
			{ title: "One guard", disabled: true },
		],
		...patch,
	};
}

describe("Shoplifting alert embeds", () => {
	it("renders the shop, trigger and full security state", () => {
		const embed = buildShopliftingAlertEmbed(event()).toJSON();
		const fields = embed.fields ?? [];

		expect(embed.title).toBe("Your Shoplifting Alert — Guards On Break");
		expect(embed.color).toBe(0x10b981);
		expect(fields.find((field) => field.name === "Shop")?.value).toBe(
			`[Jewelry Store](${SHOPLIFTING_URL})`,
		);
		expect(fields.find((field) => field.name === "Trigger")?.value).toBe(
			"Guards on break",
		);

		const security = fields.find((field) => field.name === "Security")?.value;
		expect(security).toContain("Active — Three cameras");
		expect(security).toContain("**Disabled** — One guard");
	});

	it("titles an all-down alert distinctly", () => {
		const embed = buildShopliftingAlertEmbed(
			event({
				condition: "all_down",
				shopId: 21,
				shopName: "TC Clothing",
				statuses: [
					{ title: "One camera", disabled: true },
					{ title: "Checkpoint", disabled: true },
				],
			}),
		).toJSON();

		expect(embed.title).toBe("Your Shoplifting Alert — All Security Disabled");
	});

	it("marks a recovery as amber and reports the measure back online", () => {
		const embed = buildShopliftingAlertEmbed(
			event({
				transition: "up",
				description: "Guards back at Jewelry Store.",
				statuses: [
					{ title: "Three cameras", disabled: false },
					{ title: "One guard", disabled: false },
				],
			}),
		).toJSON();

		const fields = embed.fields ?? [];
		expect(embed.title).toBe("Your Shoplifting Alert — Guards Back On Duty");
		expect(embed.color).toBe(0xf59e0b);
		expect(embed.description).toBe("Guards back at Jewelry Store.");

		const security = fields.find((field) => field.name === "Security")?.value;
		expect(security).toContain("Back online — Three cameras");
		expect(security).toContain("Back online — One guard");
	});

	it("titles a full recovery as security restored", () => {
		const embed = buildShopliftingAlertEmbed(
			event({
				condition: "all_down",
				transition: "up",
				shopId: 21,
				shopName: "TC Clothing",
				description: "All security restored at TC Clothing.",
			}),
		).toJSON();

		expect(embed.title).toBe("Your Shoplifting Alert — Security Restored");
	});
});
