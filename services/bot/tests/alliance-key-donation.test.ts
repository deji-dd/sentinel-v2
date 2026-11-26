import { describe, expect, it } from "bun:test";

import {
	type ButtonInteraction,
	ButtonStyle,
	type ModalBuilder,
} from "discord.js";

import {
	buildAllianceKeyDonationEmbed,
	handleAllianceKeyDonationButton,
} from "../src/lib/alliance-key-donation";

describe("Alliance key donation module", () => {
	it("builds the donation embed with public-key guidance", () => {
		const { embed, row } = buildAllianceKeyDonationEmbed();
		const json = embed.toJSON();

		expect(json.title).toBe("API Key Donation");
		expect(json.description).toContain("Help power Alliance features");
		expect(json.description).toContain(
			"Public Only access — any other level is rejected",
		);
		expect(json.description).toContain(
			"Encrypted, never published, and stored until you revoke it on Torn",
		);
		expect(json.fields).toBeUndefined();
		expect(json.footer?.text).toBe("Sentinel");

		const button = row.components[0]?.toJSON() as
			{ custom_id: string; label: string; style: ButtonStyle } | undefined;
		expect(button?.custom_id).toBe("alliance_donate_key_button");
		expect(button?.label).toBe("Donate API Key");
		expect(button?.style).toBe(ButtonStyle.Primary);
	});

	it("opens a private 16-character key modal", async () => {
		let shownModal: ModalBuilder | null = null;
		const interaction = {
			showModal: async (modal: ModalBuilder) => {
				shownModal = modal;
			},
			isRepliable: () => false,
		} as unknown as ButtonInteraction;

		await handleAllianceKeyDonationButton(interaction);

		expect(shownModal).not.toBeNull();
		const modalJson = (shownModal as unknown as ModalBuilder).toJSON();
		expect(modalJson.custom_id).toBe("alliance_donate_key_modal");
		expect(modalJson.title).toBe("Donate Public Torn API Key");
		const comp = modalJson.components?.[0] as
			Record<string, unknown> | undefined;
		const textInput = (comp?.component ??
			(comp?.components as unknown[] | undefined)?.[0]) as
			Record<string, unknown> | undefined;
		expect(textInput?.custom_id).toBe("torn_api_key");
		expect(textInput?.min_length).toBe(16);
		expect(textInput?.max_length).toBe(16);
	});
});
