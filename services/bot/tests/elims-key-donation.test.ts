import { describe, expect, it } from "bun:test";
import { db, elimsApiKeys, eq } from "@sentinel/database";
import {
	type ButtonInteraction,
	ButtonStyle,
	type ModalBuilder,
	type ModalSubmitInteraction,
} from "discord.js";
import {
	buildKeyDonationEmbed,
	handleKeyDonationButton,
	handleKeyDonationModalSubmit,
} from "../src/lib/elims-key-donation";

describe("Elims Key Donation Module", () => {
	it("builds the persistent key donation embed with correct metadata and donate button", () => {
		const { embed, row } = buildKeyDonationEmbed();

		const json = embed.toJSON();
		expect(json.title).toBe("Torn API Key Contribution");
		expect(json.description).toContain("Help empower our elimination team!");
		expect(json.description).toContain("Keys are securely encrypted");
		expect(json.footer?.text).toContain("Sentinel");

		const components = row.components;
		expect(components.length).toBe(1);
		const button = components[0]?.toJSON() as
			| { type: number; custom_id: string; label: string; style: ButtonStyle }
			| undefined;
		expect(button?.type).toBe(2); // ComponentType.Button
		expect(button?.custom_id).toBe("elims_donate_key_button");
		expect(button?.label).toBe("Donate API Key");
		expect(button?.style).toBe(ButtonStyle.Primary);
	});

	it("handleKeyDonationButton presents a secure modal with the 16-character Torn API key input", async () => {
		let shownModal: ModalBuilder | null = null;

		const mockInteraction = {
			showModal: async (modal: ModalBuilder) => {
				shownModal = modal;
			},
			isRepliable: () => false,
		} as unknown as ButtonInteraction;

		await handleKeyDonationButton(mockInteraction);

		expect(shownModal).not.toBeNull();
		const modalJson = (shownModal as unknown as ModalBuilder).toJSON();
		expect(modalJson.title).toBe("Donate Torn API Key");
		expect(modalJson.custom_id).toBe("elims_donate_key_modal");

		const comp = modalJson.components?.[0] as
			| Record<string, unknown>
			| undefined;
		const textInput = (comp?.component ??
			(comp?.components as unknown[] | undefined)?.[0]) as
			| Record<string, unknown>
			| undefined;
		expect(textInput?.custom_id).toBe("torn_api_key");
		expect(textInput?.min_length).toBe(16);
		expect(textInput?.max_length).toBe(16);
		expect(textInput?.required).toBe(true);
	});

	it("sendElimsKeyVerificationRequest dispatches IPC request and resolves on valid response", async () => {
		const { sendElimsKeyVerificationRequest } = await import(
			"../src/lib/ipc/server"
		);
		const { workerIpcClient } = await import("../src/lib/ipc/listener");

		let sentMessage: unknown = null;
		const originalSend = workerIpcClient.send.bind(workerIpcClient);
		workerIpcClient.send = ((msg: unknown) => {
			sentMessage = msg;
		}) as unknown as typeof workerIpcClient.send;

		try {
			const promise = sendElimsKeyVerificationRequest("1234567890123456", 2000);

			expect(sentMessage).not.toBeNull();
			const req = sentMessage as {
				action: string;
				requestId: string;
				data: { apiKey: string };
			};
			expect(req.action).toBe("elims_verify_key_request");
			expect(req.data.apiKey).toBe("1234567890123456");

			// Simulate worker responding back over IPC
			// Trigger the listener via workerIpcClient onMessage
			const { pendingElimsVerifyKeyRequests } = await import(
				"../src/lib/ipc/listener"
			);
			const pending = pendingElimsVerifyKeyRequests.get(req.requestId);
			expect(pending).toBeDefined();

			pending?.resolve({ tornId: 999111, tornName: "IpcVerifiedPlayer" });

			const result = await promise;
			expect(result.tornId).toBe(999111);
			expect(result.tornName).toBe("IpcVerifiedPlayer");
		} finally {
			workerIpcClient.send = originalSend;
		}
	});

	it("sendElimsUserResolutionRequest dispatches IPC request and resolves user", async () => {
		const { sendElimsUserResolutionRequest } = await import(
			"../src/lib/ipc/server"
		);
		const { workerIpcClient, pendingElimsResolveUserRequests } = await import(
			"../src/lib/ipc/listener"
		);

		let sentMessage: unknown = null;
		const originalSend = workerIpcClient.send.bind(workerIpcClient);
		workerIpcClient.send = ((msg: unknown) => {
			sentMessage = msg;
		}) as unknown as typeof workerIpcClient.send;

		try {
			const promise = sendElimsUserResolutionRequest(
				"11223344",
				"guild_test_77",
				2000,
			);

			expect(sentMessage).not.toBeNull();
			const req = sentMessage as {
				action: string;
				requestId: string;
				data: { discordId: string; guildId: string };
			};
			expect(req.action).toBe("elims_resolve_user_request");
			expect(req.data.discordId).toBe("11223344");
			expect(req.data.guildId).toBe("guild_test_77");

			const pending = pendingElimsResolveUserRequests.get(req.requestId);
			expect(pending).toBeDefined();

			pending?.resolve({
				tornId: 888222,
				tornName: "IpcResolvedPlayer",
				competition: {
					name: "Elimination",
					score: 10,
					team: "Team A",
					attacks: 5,
				},
				networth: 1000000,
			});

			const result = await promise;
			expect(result).not.toBeNull();
			expect(result?.tornId).toBe(888222);
			expect(result?.tornName).toBe("IpcResolvedPlayer");
			expect(result?.competition?.team).toBe("Team A");
		} finally {
			workerIpcClient.send = originalSend;
		}
	});

	it("handleKeyDonationModalSubmit replaces existing key if user already has a key in DB", async () => {
		const testGuildId = `test_guild_${crypto.randomUUID()}`;
		const testUserId = "user_123456";
		const oldKey = "1111111111111111";
		const newKey = "2222222222222222";
		process.env.ENCRYPTION_KEY =
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		process.env.API_KEY_HASH_PEPPER = "test-pepper";

		// Intercept IPC
		const { workerIpcClient, pendingElimsVerifyKeyRequests } = await import(
			"../src/lib/ipc/listener"
		);
		const originalSend = workerIpcClient.send.bind(workerIpcClient);
		workerIpcClient.send = ((msg: unknown) => {
			const req = msg as {
				action: string;
				requestId: string;
				data: { apiKey: string };
			};
			if (req.action === "elims_verify_key_request") {
				pendingElimsVerifyKeyRequests.get(req.requestId)?.resolve({
					tornId: 777111,
					tornName: "KeyDonatorPlayer",
				});
			}
		}) as unknown as typeof workerIpcClient.send;

		try {
			// Pre-clean
			await db
				.delete(elimsApiKeys)
				.where(eq(elimsApiKeys.guildId, testGuildId));

			// 1. Submit first key
			let replyPayload: unknown = null;
			const mockInteraction1 = {
				guildId: testGuildId,
				user: { id: testUserId, tag: "TestUser#0001", username: "TestUser" },
				fields: {
					getTextInputValue: () => oldKey,
				},
				deferReply: async () => {},
				followUp: async (payload: unknown) => {
					replyPayload = payload;
				},
			} as unknown as ModalSubmitInteraction;

			await handleKeyDonationModalSubmit(mockInteraction1);

			// Verify 1 key was inserted
			const keysAfterFirst = await db
				.select()
				.from(elimsApiKeys)
				.where(eq(elimsApiKeys.guildId, testGuildId));
			expect(keysAfterFirst.length).toBe(1);
			expect(keysAfterFirst[0]?.tornId).toBe(777111);

			// 2. Submit second (new) key for same user
			const mockInteraction2 = {
				guildId: testGuildId,
				user: { id: testUserId, tag: "TestUser#0001", username: "TestUser" },
				fields: {
					getTextInputValue: () => newKey,
				},
				deferReply: async () => {},
				followUp: async (payload: unknown) => {
					replyPayload = payload;
				},
			} as unknown as ModalSubmitInteraction;

			await handleKeyDonationModalSubmit(mockInteraction2);

			// Verify key was updated in-place, and still only 1 key exists for user
			const keysAfterSecond = await db
				.select()
				.from(elimsApiKeys)
				.where(eq(elimsApiKeys.guildId, testGuildId));
			expect(keysAfterSecond.length).toBe(1);
			expect(keysAfterSecond[0]?.id).toBe(keysAfterFirst[0]?.id);
			expect(keysAfterSecond[0]?.tornId).toBe(777111);

			// Check reply confirms update
			const replyObj = replyPayload as {
				embeds: [{ data: { title: string } }];
			};
			expect(replyObj.embeds[0]?.data.title).toBe(
				"API Key Updated Successfully",
			);

			// 3. Different user submits exact same key as another user
			let rejectPayload: unknown = null;
			const mockInteraction3 = {
				guildId: testGuildId,
				user: { id: "another_user_999", tag: "Other#0001", username: "Other" },
				fields: {
					getTextInputValue: () => newKey,
				},
				deferReply: async () => {},
				followUp: async (payload: unknown) => {
					rejectPayload = payload;
				},
			} as unknown as ModalSubmitInteraction;

			await handleKeyDonationModalSubmit(mockInteraction3);

			const rejectObj = rejectPayload as {
				embeds: [{ data: { title: string } }];
			};
			expect(rejectObj.embeds[0]?.data.title).toBe("Already Registered");
		} finally {
			workerIpcClient.send = originalSend;
			await db
				.delete(elimsApiKeys)
				.where(eq(elimsApiKeys.guildId, testGuildId));
		}
	});
});
