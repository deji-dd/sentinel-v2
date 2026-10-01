import { beforeAll, describe, expect, it } from "bun:test";
import { subversiveDibsManager } from "../src/lib/dibs-manager";
import {
	type CurrentWarInfo,
	type RankedWarOpponent,
	subversiveTargetCache,
} from "../src/lib/subversive-target-cache";

describe("SubversiveDibsManager", () => {
	beforeAll(() => {
		subversiveDibsManager.setConfigForTesting({
			enabled: true,
			claimLeadTime: 5,
			maxDibsPerPerson: 1,
			postHospTimeoutSeconds: 20,
		});
	});

	const mockWar: CurrentWarInfo = {
		state: "active",
		warId: 12345,
		start: Math.floor(Date.now() / 1000) - 3600,
		target: 250,
		winner: null,
		opponent: {
			id: 9999,
			name: "Enemy Faction",
			score: 50,
			chain: 10,
		},
		subversive: {
			id: 2013,
			name: "Subversive Alliance",
			score: 60,
			chain: 15,
		},
		lastUpdated: Date.now(),
	};

	it("processes hospital queue and creates open dibs records for targets under lead time", async () => {
		const nowSec = Math.floor(Date.now() / 1000);

		const hospitalQueue: (RankedWarOpponent & {
			secondsRemaining: number;
			fairFight: number;
		})[] = [
			{
				id: 1001,
				name: "OpponentOne",
				level: 70,
				daysInFaction: 50,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: 0, relative: "10m" },
				status: {
					description: "In hospital for 2 mins",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 120,
				},
				estimatedBs: 500_000_000,
				estimatedScore: 40_000,
				secondsRemaining: 120,
				fairFight: 3.2,
			},
			{
				id: 1002,
				name: "OpponentTwo",
				level: 85,
				daysInFaction: 120,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Online", timestamp: 0, relative: "1m" },
				status: {
					description: "In hospital for 15 mins",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 900,
				},
				estimatedBs: 1_200_000_000,
				estimatedScore: 65_000,
				secondsRemaining: 900,
				fairFight: 2.8,
			},
		];

		await subversiveDibsManager.processWarHospitalQueue(hospitalQueue, mockWar);

		const active = subversiveDibsManager.getActiveDibs();
		// Target 1001 (120s <= 300s) should have a dibs record
		const target1 = active.find((d) => d.targetId === 1001);
		expect(target1).toBeDefined();
		expect(target1?.status).toBe("open");
		expect(target1?.targetName).toBe("OpponentOne");

		// Target 1002 (900s > 300s) should NOT have a dibs record yet
		const target2 = active.find((d) => d.targetId === 1002);
		expect(target2).toBeUndefined();
	});

	it("allows a user to claim an open dibs target atomically", async () => {
		const claimRes = await subversiveDibsManager.claimDibs(1001, {
			tornId: 55555,
			tornName: "Blasted",
			platform: "script",
		});

		expect(claimRes.success).toBe(true);
		expect(claimRes.dibs?.status).toBe("claimed");
		expect(claimRes.dibs?.claimedBy?.tornId).toBe(55555);

		// Second claim should fail with already claimed error
		const duplicateClaim = await subversiveDibsManager.claimDibs(1001, {
			tornId: 66666,
			tornName: "OtherMember",
			platform: "script",
		});
		expect(duplicateClaim.success).toBe(false);
		expect(duplicateClaim.reason).toContain("already claimed");
	});

	it("enforces max dibs limit per person", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		// Add another target under lead time
		const hospitalQueue: (RankedWarOpponent & {
			secondsRemaining: number;
			fairFight: number;
		})[] = [
			{
				id: 1001,
				name: "OpponentOne",
				level: 70,
				daysInFaction: 50,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: 0, relative: "10m" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 100,
				},
				estimatedBs: 500_000_000,
				estimatedScore: 40_000,
				secondsRemaining: 100,
				fairFight: 3.2,
			},
			{
				id: 1003,
				name: "OpponentThree",
				level: 60,
				daysInFaction: 20,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: 0, relative: "20m" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 150,
				},
				estimatedBs: 300_000_000,
				estimatedScore: 30_000,
				secondsRemaining: 150,
				fairFight: 4.0,
			},
		];

		await subversiveDibsManager.processWarHospitalQueue(hospitalQueue, mockWar);

		// Blasted (55555) already holds 1001. Limit is 1. Claiming 1003 should fail.
		const limitRes = await subversiveDibsManager.claimDibs(1003, {
			tornId: 55555,
			tornName: "Blasted",
			platform: "script",
		});
		expect(limitRes.success).toBe(false);
		expect(limitRes.reason).toContain("Maximum claim limit");
	});

	it("allows voluntary release of a claim", async () => {
		const releaseRes = await subversiveDibsManager.releaseDibs(1001, {
			tornId: 55555,
		});
		expect(releaseRes.success).toBe(true);

		const dibs = subversiveDibsManager.getDibsByTargetId(1001);
		expect(dibs?.status).toBe("open");
		expect(dibs?.claimedBy).toBeUndefined();

		// Now another member can claim it
		const otherClaim = await subversiveDibsManager.claimDibs(1001, {
			tornId: 66666,
			tornName: "OtherMember",
			platform: "discord",
		});
		expect(otherClaim.success).toBe(true);
		expect(otherClaim.dibs?.status).toBe("claimed");
	});

	it("evaluates hospital queue directly from subversiveTargetCache without requiring websockets", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		subversiveTargetCache.setWarState(mockWar);
		subversiveTargetCache.setWarOpponents([
			{
				id: 2001,
				name: "CacheOpponentOne",
				level: 80,
				daysInFaction: 30,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: 0, relative: "5m" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 180,
				},
				estimatedBs: 600_000_000,
				estimatedScore: 50_000,
			},
			{
				id: 2002,
				name: "CacheOpponentTwo",
				level: 90,
				daysInFaction: 90,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: 0, relative: "1m" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 800,
				},
				estimatedBs: 900_000_000,
				estimatedScore: 70_000,
			},
		]);

		await subversiveDibsManager.evaluateHospitalQueue();

		const dibs2001 = subversiveDibsManager.getDibsByTargetId(2001);
		expect(dibs2001).toBeDefined();
		expect(dibs2001?.status).toBe("open");
		expect(dibs2001?.targetName).toBe("CacheOpponentOne");

		// 2002 has 800s remaining (> 300s lead time), should NOT be in dibs
		const dibs2002 = subversiveDibsManager.getDibsByTargetId(2002);
		expect(dibs2002).toBeUndefined();
	});

	it("claims target on-demand from cache if not yet pre-evaluated in activeDibs", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		// Add opponent 3001 directly to target cache
		subversiveTargetCache.setWarOpponents([
			...subversiveTargetCache.getWarOpponents(),
			{
				id: 3001,
				name: "OnDemandOpponent",
				level: 75,
				daysInFaction: 40,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Offline", timestamp: 0, relative: "2m" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 150,
				},
				estimatedBs: 400_000_000,
				estimatedScore: 35_000,
			},
		]);

		// Notice: 3001 is NOT yet in activeDibs
		expect(subversiveDibsManager.getDibsByTargetId(3001)).toBeUndefined();

		// Claiming should dynamically detect that 3001 is in hospital within lead time
		const res = await subversiveDibsManager.claimDibs(3001, {
			tornId: 77777,
			tornName: "InstantClaimant",
			platform: "script",
		});

		expect(res.success).toBe(true);
		expect(res.dibs?.targetId).toBe(3001);
		expect(res.dibs?.status).toBe("claimed");
		expect(res.dibs?.claimedBy?.tornId).toBe(77777);
	});

	it("rejects dibs for target not in hospital or not in war", async () => {
		const resNonExistent = await subversiveDibsManager.claimDibs(999999, {
			tornId: 88888,
			platform: "script",
		});
		expect(resNonExistent.success).toBe(false);
		expect(resNonExistent.reason).toBe(
			"Target is not currently available for dibs.",
		);
	});
});
