import { describe, expect, it } from "bun:test";
import { app } from "../src/app";
import { subversiveTargetCache } from "../src/lib/subversive-target-cache";

describe("Subversive Alliance - Target Finder API & RAM Engine", () => {
	it("GET /api/v1/target-finder/script serves production userscript by default", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/target-finder/script"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/javascript");
		const text = await response.text();
		expect(text).toContain("Subversive Alliance");
		expect(text).toContain("https://subversive.blasted-labs.tech");
		expect(text).toContain("satf_auth_token");
	});

	it("GET /api/v1/target-finder/script.user.js serves production userscript directly for Tampermonkey", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/target-finder/script.user.js"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/javascript");
		const text = await response.text();
		expect(text).toContain("Subversive Alliance");
	});

	it("GET /api/v1/target-finder/script?env=dev serves dev userscript configured for localhost", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/target-finder/script?env=dev"),
		);

		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("Subversive Alliance (DEV)");
		expect(text).toContain("http://localhost:3000");
	});

	it("POST /api/v1/target-finder/auth rejects invalid key formats", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/target-finder/auth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: "invalid_short_key" }),
			}),
		);

		expect(response.status).toBe(400);
		const data = (await response.json()) as { success: boolean; error: string };
		expect(data.success).toBe(false);
		expect(data.error).toContain("16-character");
	});

	it("GET /api/v1/target-finder/targets/next requires Bearer token (also works on /subversive/ alias)", async () => {
		const responseDirect = await app.handle(
			new Request("http://localhost/api/v1/target-finder/targets/next"),
		);
		expect(responseDirect.status).toBe(401);

		const responseAlias = await app.handle(
			new Request(
				"http://localhost/api/v1/subversive/target-finder/targets/next",
			),
		);
		expect(responseAlias.status).toBe(401);
	});

	it("In-Memory Target Cache accurately calculates personalized Fair Fight and evicts on dispatch", () => {
		// Mock load targets into RAM cache
		// Attacker has BS Score = 1000
		const attackerScore = 1000;

		subversiveTargetCache.loadTargets([
			{
				targetId: 101,
				name: "EasyTarget",
				level: 25,
				factionId: null,
				factionName: null,
				daysOld: 100,
				lastAction: Date.now() - 20 * 24 * 60 * 60 * 1000,
				isInactive: true,
				isFactionless: true,
				inHospital: false,
				estimatedBs: 40000,
				estimatedScore: 400, // FF = 1 + (8/3)*(400/1000) = 1 + 1.066 = 2.07x
			},
			{
				targetId: 102,
				name: "HospTarget",
				level: 30,
				factionId: 555,
				factionName: "Enemy Faction",
				daysOld: 200,
				lastAction: Date.now(),
				isInactive: false,
				isFactionless: false,
				inHospital: true, // Should be excluded!
				estimatedBs: 40000,
				estimatedScore: 400,
			},
			{
				targetId: 103,
				name: "HardTarget",
				level: 80,
				factionId: 999,
				factionName: "Big Faction",
				daysOld: 1500,
				lastAction: Date.now(),
				isInactive: false,
				isFactionless: false,
				inHospital: false,
				estimatedBs: 900000,
				estimatedScore: 1900, // FF = 3.0x clamped
			},
		]);

		// 1. Search for FF 1.8 to 2.2 -> should match EasyTarget (FF 2.07x) and NOT HospTarget
		const match = subversiveTargetCache.findNextTarget({
			attackerScore,
			minFF: 1.8,
			maxFF: 2.2,
		});

		expect(match).not.toBeNull();
		expect(match?.id).toBe(101);
		expect(match?.fairFight).toBeGreaterThanOrEqual(1.8);
		expect(match?.fairFight).toBeLessThanOrEqual(2.2);
		expect(match?.isFactionless).toBe(true);
		expect(match?.isInactive).toBe(true);

		// 2. Instant eviction on dispatch: calling findNextTarget again returns null (101 already evicted)
		const immediateRetry = subversiveTargetCache.findNextTarget({
			attackerScore,
			minFF: 1.8,
			maxFF: 2.2,
		});
		expect(immediateRetry).toBeNull();

		// 3. Re-insert target 101 via addOrUpdate (e.g. after hospital clears)
		subversiveTargetCache.addOrUpdate({
			targetId: 101,
			name: "EasyTarget",
			level: 25,
			factionId: null,
			factionName: null,
			daysOld: 100,
			lastAction: Date.now() - 20 * 24 * 60 * 60 * 1000,
			isInactive: true,
			isFactionless: true,
			inHospital: false,
			estimatedBs: 40000,
			estimatedScore: 400,
		});

		const restored = subversiveTargetCache.findNextTarget({
			attackerScore,
			minFF: 1.8,
			maxFF: 2.2,
			factionlessOnly: true,
		});
		expect(restored?.id).toBe(101);
	});

	it("Ranked War: tracks war states and enforces travel flight lock", async () => {
		// 1. Setup session in cache
		const testToken = "test_war_token_123";
		subversiveTargetCache.setUserSession({
			tornId: 99999,
			tornName: "SubversiveFighter",
			bsScore: 2500,
			token: testToken,
			isActive: true,
			expiresAt: Date.now() + 3600_000,
			statsCachedAt: Date.now(),
		});

		// 2. Set war state to scheduled
		subversiveTargetCache.setWarState({
			state: "scheduled",
			warId: 1010,
			start: Math.floor(Date.now() / 1000) + 3600,
			target: 2500,
			winner: null,
			opponent: {
				id: 9999,
				name: "Enemy Faction",
				score: 0,
				chain: 0,
			},
			subversive: {
				id: 2013,
				name: "Subversive Alliance",
				score: 0,
				chain: 0,
			},
			lastUpdated: Date.now(),
		});

		// 3. Test GET /war/status
		const statusRes = await app.handle(
			new Request("http://localhost/api/v1/target-finder/war/status", {
				headers: { Authorization: `Bearer ${testToken}` },
			}),
		);
		expect(statusRes.status).toBe(200);
		const statusData = (await statusRes.json()) as {
			success: boolean;
			war: { state: string; target: number; opponent: { name: string } };
		};
		expect(statusData.success).toBe(true);
		expect(statusData.war.state).toBe("scheduled");
		expect(statusData.war.opponent.name).toBe("Enemy Faction");

		// 4. Test Flight / Travel Lock: when traveling, returns locked reason
		const travelLockRes = await app.handle(
			new Request("http://localhost/api/v1/target-finder/war/targets/next", {
				headers: {
					Authorization: `Bearer ${testToken}`,
					"X-Attacker-State": "traveling",
				},
			}),
		);
		expect(travelLockRes.status).toBe(200);
		const travelLockData = (await travelLockRes.json()) as {
			success: boolean;
			allowed: boolean;
			reason: string;
		};
		expect(travelLockData.allowed).toBe(false);
		expect(travelLockData.reason).toContain("traveling");

		// 5. Populate war opponents in cache and activate war
		const nowSec = Math.floor(Date.now() / 1000);
		subversiveTargetCache.setWarState({
			state: "active",
			warId: 1010,
			start: nowSec - 100,
			target: 2500,
			winner: null,
			opponent: {
				id: 9999,
				name: "Enemy Faction",
				score: 800,
				chain: 10,
			},
			subversive: {
				id: 2013,
				name: "Subversive Alliance",
				score: 1100,
				chain: 15,
			},
			lastUpdated: Date.now(),
		});

		subversiveTargetCache.setWarOpponents([
			{
				id: 501,
				name: "EnemyAbroad",
				level: 50,
				daysInFaction: 100,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Online", timestamp: nowSec, relative: "1m" },
				status: {
					description: "In Mexico",
					details: null,
					state: "Abroad",
					color: "blue",
					until: null,
				},
				estimatedBs: 1000000,
				estimatedScore: 2000,
			},
			{
				id: 502,
				name: "EnemyInHospLong",
				level: 60,
				daysInFaction: 200,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: nowSec, relative: "10m" },
				status: {
					description: "In Hospital",
					details: null,
					state: "Hospital",
					color: "red",
					until: nowSec + 1200, // 20 mins remaining
				},
				estimatedBs: 1500000,
				estimatedScore: 2400,
			},
			{
				id: 503,
				name: "EnemyEarlyDischarge",
				level: 45,
				daysInFaction: 50,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: true, // Should be selected if no "Okay" targets!
				lastAction: { status: "Online", timestamp: nowSec, relative: "2m" },
				status: {
					description: "In Hospital",
					details: null,
					state: "Hospital",
					color: "red",
					until: nowSec + 600,
				},
				estimatedBs: 800000,
				estimatedScore: 1800,
			},
			{
				id: 504,
				name: "EnemyReady",
				level: 40,
				daysInFaction: 30,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: {
					status: "Online",
					timestamp: nowSec,
					relative: "Just now",
				},
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
				estimatedBs: 600000,
				estimatedScore: 1550,
			},
		]);

		// 6. Request next target: should prioritize EnemyReady (504) over 503 or 502/501
		const targetRes = await app.handle(
			new Request("http://localhost/api/v1/target-finder/war/targets/next", {
				headers: { Authorization: `Bearer ${testToken}` },
			}),
		);
		expect(targetRes.status).toBe(200);
		const targetData = (await targetRes.json()) as {
			success: boolean;
			target: {
				id: number;
				name: string;
				statusCategory: string;
				attackUrl: string;
				isOnline: boolean;
				fairFight: number;
				isHighFF: boolean;
			};
		};
		expect(targetData.success).toBe(true);
		expect(targetData.target.id).toBe(504);
		expect(targetData.target.statusCategory).toBe("ready");
		expect(targetData.target.attackUrl).toBe(
			"https://www.torn.com/page.php?sid=attack&user2ID=504",
		);
		expect(targetData.target.isOnline).toBe(true);
		expect(targetData.target.isHighFF).toBe(false);

		// 7. Test outmatched / high-FF target warning when only strong target exists
		subversiveTargetCache.setWarOpponents([
			{
				id: 509,
				name: "MassiveEnemy",
				level: 100,
				daysInFaction: 500,
				position: "Leader",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: nowSec, relative: "1h" },
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
				estimatedBs: 50_000_000,
				estimatedScore: 14142, // Much higher than attacker's 2500 -> FF > 3.0 (unclamped)
			},
		]);

		const highFFRes = await app.handle(
			new Request("http://localhost/api/v1/target-finder/war/targets/next", {
				headers: { Authorization: `Bearer ${testToken}` },
			}),
		);
		const highFFData = (await highFFRes.json()) as {
			success: boolean;
			target: {
				id: number;
				fairFight: number;
				isHighFF: boolean;
				warning?: string;
			};
		};
		expect(highFFData.success).toBe(true);
		expect(highFFData.target.id).toBe(509);
		expect(highFFData.target.fairFight).toBeGreaterThan(3.0); // Verifies unclamped FF > 3.0!
		expect(highFFData.target.isHighFF).toBe(true);
		expect(highFFData.target.warning).toContain("High FF Warning");

		// 8. Test Hospital Queue: should include opponents currently in hospital sorted by secondsRemaining
		subversiveTargetCache.setWarOpponents([
			{
				id: 502,
				name: "EnemyInHospLong",
				level: 60,
				daysInFaction: 200,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: nowSec, relative: "10m" },
				status: {
					description: "In Hospital",
					details: null,
					state: "Hospital",
					color: "red",
					until: nowSec + 1200,
				},
				estimatedBs: 1500000,
				estimatedScore: 2400,
			},
			{
				id: 503,
				name: "EnemyEarlyDischarge",
				level: 45,
				daysInFaction: 50,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: true,
				lastAction: { status: "Online", timestamp: nowSec, relative: "2m" },
				status: {
					description: "In Hospital",
					details: null,
					state: "Hospital",
					color: "red",
					until: nowSec + 600,
				},
				estimatedBs: 800000,
				estimatedScore: 1800,
			},
		]);

		const hospRes = await app.handle(
			new Request("http://localhost/api/v1/target-finder/war/hospital-queue", {
				headers: { Authorization: `Bearer ${testToken}` },
			}),
		);
		expect(hospRes.status).toBe(200);
		const hospData = (await hospRes.json()) as {
			success: boolean;
			queue: Array<{ id: number; secondsRemaining: number }>;
		};
		expect(hospData.success).toBe(true);
		expect(hospData.queue.length).toBeGreaterThanOrEqual(2);
		expect(hospData.queue[0]?.id).toBe(503); // 600s vs 1200s

		// 9. Test Available War Targets list
		const availRes = await app.handle(
			new Request(
				"http://localhost/api/v1/target-finder/war/targets/available",
				{
					headers: { Authorization: `Bearer ${testToken}` },
				},
			),
		);
		expect(availRes.status).toBe(200);
		const availData = (await availRes.json()) as {
			success: boolean;
			targets: Array<{ id: number; statusCategory: string }>;
			total: number;
		};
		expect(availData.success).toBe(true);
		expect(availData.total).toBeGreaterThanOrEqual(1);
		expect(availData.targets[0]?.id).toBe(503); // 503 has early discharge, 502 is in hosp

		// Test GET /war/targets/:id
		const detailRes = await app.handle(
			new Request("http://localhost/api/v1/target-finder/war/targets/503", {
				headers: { Authorization: `Bearer ${testToken}` },
			}),
		);
		const detailData = (await detailRes.json()) as {
			success: boolean;
			target: { id: number; name: string; fairFight: number };
		};
		expect(detailData.success).toBe(true);
		expect(detailData.target.id).toBe(503);
		expect(detailData.target.name).toBe("EnemyEarlyDischarge");
		expect(detailData.target.fairFight).toBeGreaterThanOrEqual(1.0);
	});
});
