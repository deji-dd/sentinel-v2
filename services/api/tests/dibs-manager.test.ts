import { beforeAll, describe, expect, it } from "bun:test";
import { subversiveDibsManager } from "../src/lib/dibs-manager";
import { dibsMessageStore } from "../src/lib/dibs-message-store";
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

	it("associates Discord channel and message IDs via recordDiscordMessage", () => {
		const dibs = subversiveDibsManager.getDibsByTargetId(3001);
		expect(dibs).toBeDefined();

		subversiveDibsManager.recordDiscordMessage(3001, "chan_123", "msg_456");

		const updated = subversiveDibsManager.getDibsByTargetId(3001);
		expect(updated?.discordChannelId).toBe("chan_123");
		expect(updated?.discordMessageId).toBe("msg_456");
	});

	it("scopes dibs records and claims per family faction", async () => {
		const nowSec = Math.floor(Date.now() / 1000);

		const successionWar: CurrentWarInfo = {
			...mockWar,
			warId: 54321,
			opponent: {
				id: 8888,
				name: "Succession Foe",
				score: 5,
				chain: 1,
			},
			subversive: {
				id: 27312,
				name: "SA Succession",
				score: 9,
				chain: 2,
			},
		};

		const hospitalEntry = (id: number, name: string) => ({
			id,
			name,
			level: 80,
			daysInFaction: 40,
			position: "Member",
			isOnWall: false,
			isInOc: false,
			hasEarlyDischarge: false,
			lastAction: { status: "Online", timestamp: nowSec, relative: "" },
			status: {
				description: "In hospital",
				details: null,
				state: "hospital",
				color: "red",
				until: nowSec + 120,
			},
			estimatedBs: 500_000_000,
			estimatedScore: 40_000,
			secondsRemaining: 120,
			fairFight: 2.5,
		});

		await subversiveDibsManager.processWarHospitalQueue(
			[hospitalEntry(4001, "SuccessionHospOne")],
			successionWar,
			27312,
		);

		// Record is tagged and visible only through the 27312 scope
		const successionDibs = subversiveDibsManager.getActiveDibs(27312);
		expect(successionDibs.map((d) => d.targetId)).toContain(4001);
		expect(successionDibs.find((d) => d.targetId === 4001)?.factionId).toBe(
			27312,
		);
		expect(
			subversiveDibsManager.getActiveDibs(2013).map((d) => d.targetId),
		).not.toContain(4001);

		// A 2013 member cannot claim a 27312 war target
		const wrongFaction = await subversiveDibsManager.claimDibs(
			4001,
			{ tornId: 91111, tornName: "WrongFaction", platform: "script" },
			2013,
		);
		expect(wrongFaction.success).toBe(false);
		expect(wrongFaction.reason).toContain("another faction");

		// The rightful faction can claim it
		const rightFaction = await subversiveDibsManager.claimDibs(
			4001,
			{ tornId: 92222, tornName: "RightFaction", platform: "script" },
			27312,
		);
		expect(rightFaction.success).toBe(true);

		// Ending the 27312 war only clears dibs for that faction
		await subversiveDibsManager.processWarHospitalQueue(
			[],
			{ ...successionWar, state: "no_war", opponent: null },
			27312,
		);
		expect(
			subversiveDibsManager.getActiveDibs(27312).map((d) => d.targetId),
		).not.toContain(4001);
		expect(
			subversiveDibsManager.getActiveDibs(2013).map((d) => d.targetId),
		).toContain(1001);
	});

	describe("per-faction configuration", () => {
		it("keeps separate configs for Subversive Alliance and SA Succession", () => {
			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				maxDibsPerPerson: 1,
				channelId: "channel-primary",
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: true,
				claimLeadTime: 2,
				maxDibsPerPerson: 3,
				channelId: "channel-succession",
			});

			const primary = subversiveDibsManager.getCachedConfig(2013);
			const succession = subversiveDibsManager.getCachedConfig(27312);

			expect(primary.claimLeadTime).toBe(5);
			expect(primary.maxDibsPerPerson).toBe(1);
			expect(primary.channelId).toBe("channel-primary");

			expect(succession.claimLeadTime).toBe(2);
			expect(succession.maxDibsPerPerson).toBe(3);
			expect(succession.channelId).toBe("channel-succession");
		});

		it("defaults to the primary faction for unknown or missing ids", () => {
			subversiveDibsManager.setFactionConfigForTesting(2013, {
				claimLeadTime: 7,
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				claimLeadTime: 1,
			});

			expect(subversiveDibsManager.getCachedConfig().claimLeadTime).toBe(7);
			expect(subversiveDibsManager.getCachedConfig(null).claimLeadTime).toBe(7);
			expect(subversiveDibsManager.getCachedConfig(9999).claimLeadTime).toBe(7);
		});

		it("uses the owning faction's lead time when evaluating its hospital queue", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: true,
				claimLeadTime: 1,
			});

			// 4 minutes remaining: outside the 27312 lead time (1 min) but inside
			// the 2013 lead time (5 min).
			const hospitalEntry = (id: number, name: string) => ({
				id,
				name,
				level: 80,
				daysInFaction: 40,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Online", timestamp: nowSec, relative: "" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 240,
				},
				estimatedBs: 500_000_000,
				estimatedScore: 40_000,
				secondsRemaining: 240,
				fairFight: 2.5,
			});

			await subversiveDibsManager.processWarHospitalQueue(
				[hospitalEntry(7101, "LeadTimeA")],
				mockWar,
				2013,
			);
			await subversiveDibsManager.processWarHospitalQueue(
				[hospitalEntry(7102, "LeadTimeB")],
				{
					...mockWar,
					warId: 54322,
					subversive: { id: 27312, name: "SA Succession", score: 9, chain: 2 },
				},
				27312,
			);

			expect(
				subversiveDibsManager.getActiveDibs(2013).map((d) => d.targetId),
			).toContain(7101);
			expect(
				subversiveDibsManager.getActiveDibs(27312).map((d) => d.targetId),
			).not.toContain(7102);
		});

		it("blocks claims only for the faction that has dibs disabled", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: false,
				claimLeadTime: 5,
			});

			const successionWar: CurrentWarInfo = {
				...mockWar,
				warId: 54323,
				subversive: { id: 27312, name: "SA Succession", score: 9, chain: 2 },
			};

			const hospitalEntry = (id: number, name: string) => ({
				id,
				name,
				level: 80,
				daysInFaction: 40,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Online", timestamp: nowSec, relative: "" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + 120,
				},
				estimatedBs: 500_000_000,
				estimatedScore: 40_000,
				secondsRemaining: 120,
				fairFight: 2.5,
			});

			await subversiveDibsManager.processWarHospitalQueue(
				[hospitalEntry(7201, "DisabledFaction")],
				successionWar,
				27312,
			);

			// Disabled for 27312, so no record is ever created for that faction
			expect(
				subversiveDibsManager.getActiveDibs(27312).map((d) => d.targetId),
			).not.toContain(7201);

			// Disabling one faction leaves the other fully functional
			await subversiveDibsManager.processWarHospitalQueue(
				[hospitalEntry(7202, "PrimaryStillWorks")],
				mockWar,
				2013,
			);

			const res = await subversiveDibsManager.claimDibs(
				7202,
				{ tornId: 70101, tornName: "PrimaryMember", platform: "script" },
				2013,
			);
			expect(res.success).toBe(true);
		});

		it("enforces max dibs per person using the claimant faction's limit", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				maxDibsPerPerson: 1,
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: true,
				claimLeadTime: 5,
				maxDibsPerPerson: 2,
			});

			const successionWar: CurrentWarInfo = {
				...mockWar,
				warId: 54324,
				subversive: { id: 27312, name: "SA Succession", score: 9, chain: 2 },
			};

			const hospitalEntry = (
				id: number,
				name: string,
				secondsRemaining: number,
			) => ({
				id,
				name,
				level: 80,
				daysInFaction: 40,
				position: "Member",
				isOnWall: false,
				isInOc: false,
				hasEarlyDischarge: false,
				lastAction: { status: "Online", timestamp: nowSec, relative: "" },
				status: {
					description: "In hospital",
					details: null,
					state: "hospital",
					color: "red",
					until: nowSec + secondsRemaining,
				},
				estimatedBs: 500_000_000,
				estimatedScore: 40_000,
				secondsRemaining,
				fairFight: 2.5,
			});

			await subversiveDibsManager.processWarHospitalQueue(
				[
					hospitalEntry(7301, "SeqOne", 200),
					hospitalEntry(7302, "SeqTwo", 180),
					hospitalEntry(7303, "SeqThree", 160),
				],
				successionWar,
				27312,
			);

			// Two fresh primary-faction targets so the 2013 cap can be checked
			await subversiveDibsManager.processWarHospitalQueue(
				[
					hospitalEntry(7304, "PrimaryOne", 200),
					hospitalEntry(7305, "PrimaryTwo", 180),
				],
				mockWar,
				2013,
			);

			const member = {
				tornId: 70202,
				tornName: "SuccessionMember",
				platform: "script" as const,
			};

			// 27312 allows two concurrent claims
			expect(
				(await subversiveDibsManager.claimDibs(7301, member, 27312)).success,
			).toBe(true);
			expect(
				(await subversiveDibsManager.claimDibs(7302, member, 27312)).success,
			).toBe(true);

			// The third exceeds the 27312 limit
			const third = await subversiveDibsManager.claimDibs(7303, member, 27312);
			expect(third.success).toBe(false);
			expect(third.reason).toContain("Maximum claim limit of 2");

			// 2013 caps at one regardless of the 27312 allowance
			const primaryMember = {
				tornId: 70203,
				tornName: "PrimaryMember",
				platform: "script" as const,
			};
			expect(
				(await subversiveDibsManager.claimDibs(7304, primaryMember, 2013))
					.success,
			).toBe(true);
			const primarySecond = await subversiveDibsManager.claimDibs(
				7305,
				primaryMember,
				2013,
			);
			expect(primarySecond.success).toBe(false);
			expect(primarySecond.reason).toContain("Maximum claim limit of 1");
		});

		it("routes each faction's dibs to its own Discord channel", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				channelId: null,
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: true,
				claimLeadTime: 5,
				channelId: "channel-succession",
			});

			const successionWar: CurrentWarInfo = {
				...mockWar,
				warId: 54325,
				subversive: { id: 27312, name: "SA Succession", score: 9, chain: 2 },
			};

			await subversiveDibsManager.processWarHospitalQueue(
				[
					{
						id: 7401,
						name: "ChannelScoped",
						level: 80,
						daysInFaction: 40,
						position: "Member",
						isOnWall: false,
						isInOc: false,
						hasEarlyDischarge: false,
						lastAction: { status: "Online", timestamp: nowSec, relative: "" },
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
						fairFight: 2.5,
					},
				],
				successionWar,
				27312,
			);

			const record = subversiveDibsManager
				.getActiveDibs(27312)
				.find((d) => d.targetId === 7401);

			expect(record?.discordChannelId).toBe("channel-succession");
			expect(record?.factionId).toBe(27312);
		});
	});
	describe("channel maintenance", () => {
		const maintenanceWar = (
			overrides: Partial<CurrentWarInfo> = {},
		): CurrentWarInfo => ({
			...mockWar,
			warId: 60001,
			subversive: {
				id: 2013,
				name: "Subversive Alliance",
				score: 60,
				chain: 15,
			},
			...overrides,
		});

		const maintenanceEntry = (
			id: number,
			name: string,
			secondsRemaining: number,
			nowSec: number,
		) => ({
			id,
			name,
			level: 80,
			daysInFaction: 40,
			position: "Member",
			isOnWall: false,
			isInOc: false,
			hasEarlyDischarge: false,
			lastAction: { status: "Online", timestamp: nowSec, relative: "" },
			status: {
				description: "In hospital",
				details: null,
				state: "hospital",
				color: "red",
				until: nowSec + secondsRemaining,
			},
			estimatedBs: 500_000_000,
			estimatedScore: 40_000,
			secondsRemaining,
			fairFight: 2.5,
		});

		it("deletes tracked Discord messages when a war is termed", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				channelId: "channel-primary",
			});

			await subversiveDibsManager.processWarHospitalQueue(
				[maintenanceEntry(8101, "TeremedOne", 120, nowSec)],
				maintenanceWar(),
				2013,
			);

			const record = subversiveDibsManager
				.getActiveDibs(2013)
				.find((d) => d.targetId === 8101);
			expect(record).toBeDefined();

			// Simulate the bot having posted and reported its message id back.
			await subversiveDibsManager.recordDiscordMessage(
				8101,
				"channel-primary",
				"msg-8101",
			);

			// War is termed -> clearDibsForFaction must delete the message.
			await subversiveDibsManager.processWarHospitalQueue(
				[],
				maintenanceWar({ state: "no_war", opponent: null }),
				2013,
			);

			expect(
				subversiveDibsManager.getActiveDibs(2013).map((d) => d.targetId),
			).not.toContain(8101);

			// The message id must also be cleared so a later sweep does not
			// try to delete a message that is already gone.
			await dibsMessageStore.flush();
			const tracked = await dibsMessageStore.list(2013);
			expect(tracked.map((ref) => ref.messageId)).not.toContain("msg-8101");
		});

		it("keeps other factions' messages when one faction's war is termed", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				channelId: "channel-primary",
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: true,
				claimLeadTime: 5,
				channelId: "channel-succession",
			});

			await subversiveDibsManager.processWarHospitalQueue(
				[maintenanceEntry(8201, "PrimaryKeeps", 120, nowSec)],
				maintenanceWar(),
				2013,
			);
			await subversiveDibsManager.processWarHospitalQueue(
				[maintenanceEntry(8202, "SuccessionTermed", 120, nowSec)],
				maintenanceWar({
					warId: 60002,
					subversive: { id: 27312, name: "SA Succession", score: 9, chain: 2 },
				}),
				27312,
			);

			await subversiveDibsManager.recordDiscordMessage(
				8201,
				"channel-primary",
				"msg-8201",
			);
			await subversiveDibsManager.recordDiscordMessage(
				8202,
				"channel-succession",
				"msg-8202",
			);

			// Term only the succession war.
			await subversiveDibsManager.processWarHospitalQueue(
				[],
				maintenanceWar({
					state: "no_war",
					opponent: null,
					warId: 60002,
					subversive: { id: 27312, name: "SA Succession", score: 9, chain: 2 },
				}),
				27312,
			);

			await dibsMessageStore.flush();
			const successionTracked = await dibsMessageStore.list(27312);
			expect(successionTracked.map((ref) => ref.messageId)).not.toContain(
				"msg-8202",
			);

			// The 2013 message must survive untouched.
			const primaryTracked = await dibsMessageStore.list(2013);
			expect(primaryTracked.map((ref) => ref.messageId)).toContain("msg-8201");
			expect(
				subversiveDibsManager.getActiveDibs(2013).map((d) => d.targetId),
			).toContain(8201);
		});

		it("skips the sweep when no dibs channel is configured", async () => {
			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				channelId: null,
			});

			const result = await subversiveDibsManager.sweepDibsChannel(2013);
			expect(result).toBeNull();
		});

		it("reports tracked and live counts independently per faction", async () => {
			const nowSec = Math.floor(Date.now() / 1000);

			subversiveDibsManager.setFactionConfigForTesting(2013, {
				enabled: true,
				claimLeadTime: 5,
				channelId: "channel-primary",
			});
			subversiveDibsManager.setFactionConfigForTesting(27312, {
				enabled: true,
				claimLeadTime: 5,
				channelId: "channel-succession",
			});

			await subversiveDibsManager.processWarHospitalQueue(
				[maintenanceEntry(8301, "LiveTarget", 120, nowSec)],
				maintenanceWar(),
				2013,
			);
			await subversiveDibsManager.recordDiscordMessage(
				8301,
				"channel-primary",
				"msg-8301",
			);

			const primaryTracked = await dibsMessageStore.list(2013);
			await dibsMessageStore.flush();
			const successionTracked = await dibsMessageStore.list(27312);

			expect(primaryTracked.map((ref) => ref.messageId)).toContain("msg-8301");
			expect(successionTracked.map((ref) => ref.messageId)).not.toContain(
				"msg-8301",
			);
		});
	});
});
