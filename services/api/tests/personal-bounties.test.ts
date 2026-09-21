import { describe, expect, it } from "bun:test";
import { app } from "../src/app";
import {
	type PersonalBountyState,
	setBountyStateObject,
} from "../src/routes/v1/personal-bounties";

describe("Personal Bounty Target Finder API", () => {
	it("GET /api/v1/personal/bounties/script.user.js serves userscript without emojis", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/personal/bounties/script.user.js"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/javascript");
		const content = await response.text();
		expect(content).toContain("Bounty Target Finder");
		expect(content).toContain("pbtf-panel");

		// Strict zero-emoji compliance check
		const emojiRegex =
			/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
		expect(emojiRegex.test(content)).toBe(false);
	});

	it("GET /api/v1/personal/bounties/script.user.js?env=dev serves dev userscript", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/personal/bounties/script.user.js?env=dev",
			),
		);

		expect(response.status).toBe(200);
		const content = await response.text();
		expect(content).toContain("Bounty Target Finder (DEV)");
		expect(content).toContain("http://localhost:3000");
	});

	it("GET /api/v1/personal/bounties rejects unauthorized requests", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/personal/bounties"),
		);

		expect(response.status).toBe(401);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("Unauthorized");
	});

	it("GET /api/v1/personal/bounties returns filtered targets with valid personal key", async () => {
		// Mock personal key in environment if not present
		const testApiKey = process.env.TORN_API_KEY || "test_personal_api_key_123";
		process.env.TORN_API_KEY = testApiKey;

		// Seed mock state in systemStates
		const mockState = {
			readyTargets: [
				{
					id: 1001,
					name: "RichTarget",
					level: 50,
					reward: 1_000_000,
					fairFight: 2.2,
					estimatedBs: 50_000,
					age: 300,
					status: { state: "Okay" },
					attackUrl: "https://www.torn.com/page.php?sid=attack&user2ID=1001",
					lastCheckedAt: Math.floor(Date.now() / 1000),
				},
				{
					id: 1002,
					name: "SmallTarget",
					level: 12,
					reward: 150_000,
					fairFight: 1.5,
					estimatedBs: 10_000,
					age: 40,
					status: { state: "Okay" },
					attackUrl: "https://www.torn.com/page.php?sid=attack&user2ID=1002",
					lastCheckedAt: Math.floor(Date.now() / 1000),
				},
				{
					id: 1003,
					name: "HighFFTarget",
					level: 80,
					reward: 2_000_000,
					fairFight: 3.5, // Exceeds max FF
					estimatedBs: 500_000,
					age: 500,
					status: { state: "Okay" },
					attackUrl: "https://www.torn.com/page.php?sid=attack&user2ID=1003",
					lastCheckedAt: Math.floor(Date.now() / 1000),
				},
			],
			hospitalQueue: [
				{
					id: 2001,
					name: "HospitalizedTarget",
					level: 30,
					reward: 500_000,
					fairFight: 1.8,
					estimatedBs: 25_000,
					age: 100,
					status: {
						state: "Hospital",
						until: Math.floor(Date.now() / 1000) + 120,
					},
					attackUrl: "https://www.torn.com/page.php?sid=attack&user2ID=2001",
					lastCheckedAt: Math.floor(Date.now() / 1000),
					secondsRemaining: 120,
				},
			],
			lastSyncTimestamp: Math.floor(Date.now() / 1000),
			targetCount: 4,
		};

		setBountyStateObject(mockState);

		// Query with minBounty = 250k and maxFF = 3.0
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/personal/bounties?minBounty=250000&maxFF=3.0",
				{
					headers: {
						"x-api-key": testApiKey,
					},
				},
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			readyTargets: Array<{ id: number; reward: number }>;
			hospitalQueue: Array<{ id: number; reward: number }>;
			totalCount: number;
		};

		// Target 1001 has reward 1M and FF 2.2 -> included
		// Target 1002 has reward 150k < 250k -> excluded
		// Target 1003 has FF 3.5 > 3.0 -> excluded
		expect(data.readyTargets.length).toBe(1);
		expect(data.readyTargets[0]?.id).toBe(1001);

		// Target 2001 has reward 500k and FF 1.8 -> included in hospitalQueue
		expect(data.hospitalQueue.length).toBe(1);
		expect(data.hospitalQueue[0]?.id).toBe(2001);
	});

	it("POST /api/v1/personal/bounties/recheck validates targetId", async () => {
		const testApiKey = process.env.TORN_API_KEY || "test_personal_api_key_123";
		const response = await app.handle(
			new Request("http://localhost/api/v1/personal/bounties/recheck", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": testApiKey,
				},
				body: JSON.stringify({ targetId: 0 }),
			}),
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("Invalid targetId");
	});

	it("POST /api/v1/personal/bounties/defeat marks target as defeated and moves to hospitalQueue", async () => {
		const testApiKey = process.env.TORN_API_KEY || "test_personal_api_key_123";
		const mockState: PersonalBountyState = {
			readyTargets: [
				{
					id: 5001,
					name: "TargetToDefeat",
					level: 25,
					reward: 800_000,
					fairFight: 2.0,
					estimatedBs: 100_000,
					age: 300,
					status: { state: "Okay" },
					attackUrl: "https://www.torn.com/page.php?sid=attack&user2ID=5001",
					lastCheckedAt: Math.floor(Date.now() / 1000),
				},
			],
			hospitalQueue: [],
			lastSyncTimestamp: Math.floor(Date.now() / 1000),
			targetCount: 1,
		};

		setBountyStateObject(mockState);

		const response = await app.handle(
			new Request("http://localhost/api/v1/personal/bounties/defeat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": testApiKey,
				},
				body: JSON.stringify({
					targetId: 5001,
					outcome: "You hospitalized TargetToDefeat",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			targetId: number;
		};
		expect(body.success).toBe(true);
		expect(body.targetId).toBe(5001);
	});
});
