import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { MercContract } from "@sentinel/database";
import type { FactionMember } from "@sentinel/schemas";
import * as tornApiModule from "@sentinel/torn-api";
import {
	MercTargetManager,
	OFFLINE_JITTER_SECONDS,
} from "../src/workers/merc/merc-contract-worker";

const mockContract: MercContract = {
	id: "contract-100",
	guildId: "guild-1",
	factionId: 27312,
	factionName: "SA Succession",
	startTime: new Date(Date.now() - 10_000).toISOString(),
	endTime: new Date(Date.now() + 3600_000).toISOString(),
	endOnWarEnd: false,
	status: "active",
	warStatusAtCreation: "active",
	hitPrice: 3_000_000,
	strickenHitPrice: 4_000_000,
	warStartHitPrice: null,
	warStartStrickenHitPrice: null,
	terms: {
		levelRange: [20, 100],
		statuses: {
			online: true,
			idle: true,
			offline: false,
		},
		idleDurationMinutes: 15,
		offlineDurationMinutes: null,
		strickenHits: true,
	},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

function createMockMember(overrides?: Partial<FactionMember>): FactionMember {
	return {
		id: 1001,
		name: "TargetAlpha",
		level: 50,
		days_in_faction: 100,
		position: "Member",
		is_revivable: false,
		is_on_wall: false,
		is_in_oc: false,
		has_early_discharge: false,
		revive_setting: "Everyone",
		last_action: {
			status: "Online",
			timestamp: Math.floor(Date.now() / 1000),
			relative: "1 minute ago",
		},
		status: {
			description: "In hospital for 30 secs",
			details: null,
			state: "Okay",
			color: "green",
			until: null,
		},
		...overrides,
	};
}

let fetchSpy: ReturnType<typeof spyOn>;
let getPlayerStatsSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch);

	getPlayerStatsSpy = spyOn(tornApiModule, "getPlayerStats").mockImplementation(
		async (ids) =>
			ids.map((id) => ({
				player_id: id,
				bs_estimate: 150_000,
				fair_fight: 2.5,
			})) as unknown as tornApiModule.FFScouterTargetResult[],
	);
});

afterEach(() => {
	fetchSpy?.mockRestore();
	getPlayerStatsSpy?.mockRestore();
});

describe("MercTargetManager - Qualifications and Alert Lifecycle", () => {
	it("qualifies target within level range and permitted activity status", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const member = createMockMember({
			level: 50,
			last_action: { status: "Online", timestamp: nowSec, relative: "now" },
			status: {
				description: "Okay",
				details: null,
				state: "Okay",
				color: "green",
				until: null,
			},
		});

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		const alert = manager.getAlert(mockContract.id, member.id);
		expect(alert).toBeDefined();
		expect(alert?.targetName).toBe("TargetAlpha");
		expect(alert?.status).toBe("open");
		expect(alert?.isStrickenEligible).toBe(true);
	});

	it("disqualifies member whose level is outside contract level range", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const lowLevelMember = createMockMember({ id: 1002, level: 15 });
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			lowLevelMember,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 1002)).toBeUndefined();
	});

	it("includes a level-100 member when the contract range tops out at 100", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		// Both endpoints are inclusive, so 100 must qualify when the upper bound
		// is 100. Level 100 sits exactly on the bound, which is where an
		// exclusive comparison would silently drop the highest-level targets.
		for (const [id, level] of [
			[11001, 1],
			[11002, 99],
			[11003, 100],
		] as const) {
			await manager.processMember(
				{
					...mockContract,
					id: `contract-level-${level}`,
					terms: { ...mockContract.terms, levelRange: [1, 100] },
				},
				"guild-1",
				"targets",
				"role-merc-123",
				createMockMember({ id, level }),
				nowSec,
				nowMs,
			);
			expect(manager.getAlert(`contract-level-${level}`, id)).toBeDefined();
		}

		// Level 101 is genuinely out of range and must still be rejected.
		await manager.processMember(
			{
				...mockContract,
				id: "contract-level-101",
				terms: { ...mockContract.terms, levelRange: [1, 100] },
			},
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({ id: 11004, level: 101 }),
			nowSec,
			nowMs,
		);
		expect(manager.getAlert("contract-level-101", 11004)).toBeUndefined();
	});

	it("includes a level-100 member on war-start terms capped at 100", async () => {
		const manager = new MercTargetManager();
		const warStartSec = 1_700_000_000;
		const nowSec = warStartSec + 300;
		const nowMs = nowSec * 1000;

		const contract: MercContract = {
			...mockContract,
			id: "contract-level-war-start",
			warStatusAtCreation: "upcoming",
			warStart: warStartSec,
			warEnd: warStartSec + 3600,
			changeTermsOnWarStart: true,
			terms: {
				...mockContract.terms,
				levelRange: [1, 50],
				statuses: { online: false, idle: false, offline: true },
				offlineDurationMinutes: null,
			},
			warStartTerms: {
				...mockContract.terms,
				levelRange: [1, 100],
				statuses: { online: false, idle: false, offline: true },
				offlineDurationMinutes: 10,
			},
		};

		const member = createMockMember({
			id: 12001,
			level: 100,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 30 * 60,
				relative: "30 minutes ago",
			},
		});

		await manager.processMember(
			contract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		// The base terms cap at 50, so a pass here proves the war-start range is
		// the one being applied and that its 100 bound is inclusive.
		expect(manager.getAlert(contract.id, 12001)).toBeDefined();
	});

	it("disqualifies member whose is_revivable is true and deletes any existing alert", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const revivableMember = createMockMember({
			id: 1004,
			is_revivable: true,
		});

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			revivableMember,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 1004)).toBeUndefined();

		// Also verify that if an alert previously existed, it is removed when member becomes revivable
		const validMember = createMockMember({
			id: 1005,
			is_revivable: false,
		});

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			validMember,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(mockContract.id, 1005)).toBeDefined();

		// Now member becomes revivable
		const nowRevivable = createMockMember({
			id: 1005,
			is_revivable: true,
		});
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			nowRevivable,
			nowSec + 1,
			nowMs + 1000,
		);
		expect(manager.getAlert(mockContract.id, 1005)).toBeUndefined();
	});

	it("disqualifies member whose status is Offline when offline is disabled", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const offlineMember = createMockMember({
			id: 1003,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 7200,
				relative: "2 hours ago",
			},
		});
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			offlineMember,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 1003)).toBeUndefined();
	});

	it("disqualifies member whose Idle duration is below contract min idleDurationMinutes and qualifies when meeting min", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		// 5 minutes idle vs 15 minutes minimum required -> disqualified
		const underIdleMember = createMockMember({
			id: 1004,
			last_action: {
				status: "Idle",
				timestamp: nowSec - 300,
				relative: "5 minutes ago",
			},
		});
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			underIdleMember,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 1004)).toBeUndefined();

		// 20 minutes idle vs 15 minutes minimum required -> qualifies
		const validIdleMember = createMockMember({
			id: 1004,
			last_action: {
				status: "Idle",
				timestamp: nowSec - 1200,
				relative: "20 minutes ago",
			},
		});
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			validIdleMember,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 1004)).toBeDefined();
	});

	it("includes member in hospital with <= 60 seconds remaining as hospital lead", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const leadMember = createMockMember({
			id: 1005,
			status: {
				description: "In hospital for 45 seconds",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 45,
			},
		});

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			leadMember,
			nowSec,
			nowMs,
		);

		const alert = manager.getAlert(mockContract.id, 1005);
		expect(alert).toBeDefined();
		expect(alert?.hospitalUntil).toBe(nowSec + 45);
	});

	it("never raises a hospital-exit alert for a stay outside Torn", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		// Inside the 60-second lead on Torn's clock, but the bed is in Japan: Torn
		// reports the same Hospital state, and a mercenary cannot reach the target
		// without flying, so no alert may be posted.
		const overseasMember = createMockMember({
			id: 1007,
			status: {
				description: "In a Japanese hospital for 45 seconds",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 45,
			},
		});

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			overseasMember,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 1007)).toBeUndefined();
	});

	it("invalidates member if hospital duration is greater than 60 seconds", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		// Member initially Okay
		const member = createMockMember({ id: 1006 });
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(mockContract.id, 1006)).toBeDefined();

		// Member now in hospital for 2 hours (e.g. attacked)
		const downedMember = createMockMember({
			id: 1006,
			status: {
				description: "In hospital for 2 hours",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 7200,
			},
		});

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			downedMember,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(mockContract.id, 1006)).toBeUndefined();
	});

	it("tracks 60s RW immunity cooldown when target exits hospital in active war", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		// 1. Target in hospital lead (30s left)
		const hospMember = createMockMember({
			id: 1007,
			status: {
				description: "Hospital 30s",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 30,
			},
		});
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			hospMember,
			nowSec,
			nowMs,
		);
		const alert1 = manager.getAlert(mockContract.id, 1007);
		expect(alert1?.wasInHospital).toBe(true);

		// 2. Target now exits hospital (becomes Okay)
		const exitMember = createMockMember({
			id: 1007,
			status: {
				description: "Okay",
				details: null,
				state: "Okay",
				color: "green",
				until: null,
			},
		});
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			exitMember,
			nowSec,
			nowMs + 1000,
		);

		const alert2 = manager.getAlert(mockContract.id, 1007);
		expect(alert2?.rwCooldownUntil).toBe(nowSec + 60);
	});
});

describe("MercTargetManager - Claims, 20s Expiration & Reposting", () => {
	it("allows a mercenary to claim an open target and prevents double claiming", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const member = createMockMember({ id: 2001 });
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		const claimRes = await manager.claimTarget(mockContract.id, 2001, {
			discordId: "user-1",
			discordTag: "Merc#0001",
			tornId: 99999,
			tornName: "SuperMerc",
		});

		expect(claimRes.success).toBe(true);
		expect(claimRes.alert?.status).toBe("claimed");
		expect(claimRes.alert?.claimedBy?.tornName).toBe("SuperMerc");

		// Double claim attempt by another player
		const dupRes = await manager.claimTarget(mockContract.id, 2001, {
			discordId: "user-2",
			discordTag: "OtherMerc#0002",
		});

		expect(dupRes.success).toBe(false);
		expect(dupRes.reason).toContain("already claimed");
	});

	it("prevents a mercenary from claiming multiple dibs when they already hold an active claim", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const memberA = createMockMember({ id: 2101, name: "TargetAlpha" });
		const memberB = createMockMember({ id: 2102, name: "TargetBeta" });

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberA,
			nowSec,
			nowMs,
		);
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberB,
			nowSec,
			nowMs,
		);

		// Mercenary claims Target Alpha
		const claimResA = await manager.claimTarget(mockContract.id, 2101, {
			discordId: "user-1",
			discordTag: "Merc#0001",
			tornId: 99999,
			tornName: "SuperMerc",
		});
		expect(claimResA.success).toBe(true);

		// Same mercenary attempts to claim Target Beta via discordId
		const claimResB = await manager.claimTarget(mockContract.id, 2102, {
			discordId: "user-1",
			discordTag: "Merc#0001",
		});
		expect(claimResB.success).toBe(false);
		expect(claimResB.reason).toContain("already have an active claim");
		expect(claimResB.reason).toContain("TargetAlpha [2101]");

		// Same mercenary attempts to claim Target Beta via tornId match
		const claimResBTorn = await manager.claimTarget(mockContract.id, 2102, {
			discordId: "user-different-session",
			discordTag: "Merc#9999",
			tornId: 99999,
		});
		expect(claimResBTorn.success).toBe(false);
		expect(claimResBTorn.reason).toContain("already have an active claim");

		// Another mercenary CAN claim Target Beta
		const claimResOther = await manager.claimTarget(mockContract.id, 2102, {
			discordId: "user-2",
			discordTag: "OtherMerc#0002",
			tornId: 88888,
		});
		expect(claimResOther.success).toBe(true);
	});

	it("allows claiming another target after releasing active claim", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const memberA = createMockMember({ id: 2103, name: "TargetAlpha" });
		const memberB = createMockMember({ id: 2104, name: "TargetBeta" });

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberA,
			nowSec,
			nowMs,
		);
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberB,
			nowSec,
			nowMs,
		);

		await manager.claimTarget(mockContract.id, 2103, {
			discordId: "user-1",
			discordTag: "Merc#0001",
		});

		// Release claim on Target Alpha
		const releaseRes = await manager.releaseTarget(
			mockContract.id,
			2103,
			"user-1",
		);
		expect(releaseRes.success).toBe(true);

		// Merc can now claim Target Beta
		const claimResB = await manager.claimTarget(mockContract.id, 2104, {
			discordId: "user-1",
			discordTag: "Merc#0001",
		});
		expect(claimResB.success).toBe(true);
	});

	it("expires claim after 20 seconds without attack and resets to open", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const member = createMockMember({ id: 2002 });
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		await manager.claimTarget(mockContract.id, 2002, {
			discordId: "user-1",
			discordTag: "Merc#0001",
		});

		const alertAfterClaim = manager.getAlert(mockContract.id, 2002);
		expect(alertAfterClaim?.status).toBe("claimed");

		// 21 seconds later -> claim expires
		const futureMs = nowMs + 21_000;
		const futureSec = nowSec + 21;

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			futureSec,
			futureMs,
		);

		const alertAfterExpire = manager.getAlert(mockContract.id, 2002);
		expect(alertAfterExpire?.status).toBe("open");
		expect(alertAfterExpire?.claimedBy).toBeUndefined();
	});

	it("does not expire 20s lock while target is in hospital or in RW hit cooldown, starting 20s count only after cooldown ends", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const activeWarContract: MercContract = {
			...mockContract,
			id: "contract-war-1",
			warStatusAtCreation: "active",
		};

		// 1. Target in hospital with 30s remaining
		const hospMember = createMockMember({
			id: 2005,
			status: {
				description: "In hospital for 30s",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 30,
			},
		});

		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			hospMember,
			nowSec,
			nowMs,
		);

		// Mercenary claims the hospital lead target
		const claimRes = await manager.claimTarget(activeWarContract.id, 2005, {
			discordId: "user-1",
			discordTag: "Merc#0001",
		});
		expect(claimRes.success).toBe(true);
		expect(claimRes.alert?.lockStartedAt).toBeUndefined();

		// 2. 25 seconds later (target still has 5s in hospital):
		// Previous bug would have expired the claim here at 20s!
		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({
				id: 2005,
				status: {
					description: "In hospital for 5s",
					details: null,
					state: "Hospital",
					color: "red",
					until: nowSec + 30,
				},
			}),
			nowSec + 25,
			nowMs + 25_000,
		);

		const alertInHosp = manager.getAlert(activeWarContract.id, 2005);
		expect(alertInHosp?.status).toBe("claimed");
		expect(alertInHosp?.lockStartedAt).toBeUndefined();

		// 3. Target exits hospital at nowSec + 30, entering 60s RW hit cooldown (until nowSec + 90)
		const exitSec = nowSec + 30;
		const exitMs = nowMs + 30_000;
		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({
				id: 2005,
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
			}),
			exitSec,
			exitMs,
		);

		const alertInRwCooldown = manager.getAlert(activeWarContract.id, 2005);
		expect(alertInRwCooldown?.status).toBe("claimed");
		expect(alertInRwCooldown?.rwCooldownUntil).toBe(exitSec + 60);
		expect(alertInRwCooldown?.lockStartedAt).toBeUndefined();

		// 4. 40 seconds into RW hit cooldown (exitSec + 40, nowSec + 70):
		// Target is still in RW cooldown, so 20s lock must NOT have started or expired!
		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({
				id: 2005,
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
			}),
			exitSec + 40,
			exitMs + 40_000,
		);

		const alertStillInRw = manager.getAlert(activeWarContract.id, 2005);
		expect(alertStillInRw?.status).toBe("claimed");
		expect(alertStillInRw?.lockStartedAt).toBeUndefined();

		// 5. RW cooldown ends at exitSec + 60 (nowSec + 90). Target is now attackable!
		const cooldownEndSec = exitSec + 60;
		const cooldownEndMs = exitMs + 60_000;
		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({
				id: 2005,
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
			}),
			cooldownEndSec,
			cooldownEndMs,
		);

		const alertAttackable = manager.getAlert(activeWarContract.id, 2005);
		expect(alertAttackable?.status).toBe("claimed");
		expect(alertAttackable?.lockStartedAt).toBe(cooldownEndMs);

		// 6. 15 seconds after RW cooldown ends (cooldownEndMs + 15_000):
		// Still within the 20s lock window!
		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({
				id: 2005,
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
			}),
			cooldownEndSec + 15,
			cooldownEndMs + 15_000,
		);

		const alertWithin20s = manager.getAlert(activeWarContract.id, 2005);
		expect(alertWithin20s?.status).toBe("claimed");

		// 7. 21 seconds after RW cooldown ends (cooldownEndMs + 21_000):
		// 20s lock expired! Reset to open and reposted!
		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			createMockMember({
				id: 2005,
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
			}),
			cooldownEndSec + 21,
			cooldownEndMs + 21_000,
		);

		const alertExpired = manager.getAlert(activeWarContract.id, 2005);
		expect(alertExpired?.status).toBe("open");
		expect(alertExpired?.claimedBy).toBeUndefined();
		expect(alertExpired?.lockStartedAt).toBeUndefined();
	});

	it("reposts stale target after 60 seconds of inactivity", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const member = createMockMember({ id: 2003 });
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		manager.recordMessageId(mockContract.id, 2003, "msg-old-123", "targets");
		const alertInitial = manager.getAlert(mockContract.id, 2003);
		expect(alertInitial?.messageId).toBe("msg-old-123");

		// 65 seconds later -> stale repost triggered
		const futureMs = nowMs + 65_000;
		const futureSec = nowSec + 65;

		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			futureSec,
			futureMs,
		);

		const alertReposted = manager.getAlert(mockContract.id, 2003);
		expect(alertReposted?.lastAlertAt).toBe(futureMs);
		// Old message ID was deleted and cleared pending new bot messageId record
		expect(alertReposted?.messageId).toBeUndefined();
	});

	it("downs and removes target when attack validator confirms hit", async () => {
		const manager = new MercTargetManager();
		const nowSec = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();

		const member = createMockMember({ id: 2004 });
		await manager.processMember(
			mockContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		expect(manager.getAlert(mockContract.id, 2004)).toBeDefined();

		await manager.downTarget(mockContract.id, 2004);

		expect(manager.getAlert(mockContract.id, 2004)).toBeUndefined();
	});

	it("qualifies all offline targets when offline status is enabled", async () => {
		const manager = new MercTargetManager();
		const nowSec = 1_700_000_000;
		const nowMs = nowSec * 1000;

		const offlineContract: MercContract = {
			...mockContract,
			id: "contract-offline-test",
			terms: {
				...mockContract.terms,
				statuses: {
					online: false,
					idle: false,
					offline: true,
				},
			},
		};

		// Member offline for 10 minutes -> QUALIFIES (no duration filter)
		const memberA = createMockMember({
			id: 3001,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 10 * 60,
				relative: "10 minutes ago",
			},
		});

		await manager.processMember(
			offlineContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberA,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(offlineContract.id, 3001)).toBeDefined();

		// Member offline for 60 minutes -> also QUALIFIES (no duration limit)
		const memberB = createMockMember({
			id: 3002,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 60 * 60,
				relative: "60 minutes ago",
			},
		});

		await manager.processMember(
			offlineContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberB,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(offlineContract.id, 3002)).toBeDefined();
	});

	it("enforces a minimum offline duration when one is set and ignores it when unset", async () => {
		const manager = new MercTargetManager();
		const nowSec = 1_700_000_000;
		const nowMs = nowSec * 1000;

		const minOfflineContract: MercContract = {
			...mockContract,
			id: "contract-offline-min-30",
			terms: {
				...mockContract.terms,
				statuses: {
					online: false,
					idle: false,
					offline: true,
				},
				offlineDurationMinutes: 30,
			},
		};

		const recentlyOffline = createMockMember({
			id: 3101,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 10 * 60,
				relative: "10 minutes ago",
			},
		});

		const longOffline = createMockMember({
			id: 3102,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 45 * 60,
				relative: "45 minutes ago",
			},
		});

		// 10 minutes offline < 30 minute floor -> disqualified
		await manager.processMember(
			minOfflineContract,
			"guild-1",
			"targets",
			"role-merc-123",
			recentlyOffline,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(minOfflineContract.id, 3101)).toBeUndefined();

		// 45 minutes offline >= 30 minute floor -> qualifies
		await manager.processMember(
			minOfflineContract,
			"guild-1",
			"targets",
			"role-merc-123",
			longOffline,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(minOfflineContract.id, 3102)).toBeDefined();

		// Unset (the default) keeps the 10-minute-offline target eligible.
		const noMinimumContract: MercContract = {
			...minOfflineContract,
			id: "contract-offline-no-min",
			terms: {
				...minOfflineContract.terms,
				offlineDurationMinutes: null,
			},
		};
		const freshManager = new MercTargetManager();
		await freshManager.processMember(
			noMinimumContract,
			"guild-1",
			"targets",
			"role-merc-123",
			recentlyOffline,
			nowSec,
			nowMs,
		);
		expect(freshManager.getAlert(noMinimumContract.id, 3101)).toBeDefined();
	});

	it("tears down a posted offline alert once the minimum is raised past the target's offline time", async () => {
		const manager = new MercTargetManager();
		const nowSec = 1_700_000_500;
		const nowMs = nowSec * 1000;

		const noMinimumContract: MercContract = {
			...mockContract,
			id: "contract-offline-raise-min",
			terms: {
				...mockContract.terms,
				statuses: {
					online: false,
					idle: false,
					offline: true,
				},
				offlineDurationMinutes: null,
			},
		};

		const member = createMockMember({
			id: 3201,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 5 * 60,
				relative: "5 minutes ago",
			},
		});

		await manager.processMember(
			noMinimumContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(noMinimumContract.id, 3201)).toBeDefined();

		// Operator edits the live contract terms: a 30 minute floor now applies.
		const editedContract: MercContract = {
			...noMinimumContract,
			terms: {
				...noMinimumContract.terms,
				offlineDurationMinutes: 30,
			},
		};

		await manager.processMember(
			editedContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec + 1,
			(nowSec + 1) * 1000,
		);
		expect(manager.getAlert(editedContract.id, 3201)).toBeUndefined();
	});

	it("uses the war-start minimum offline duration once the war has begun", async () => {
		const manager = new MercTargetManager();
		const warStartSec = 1_700_000_000;
		const nowSec = warStartSec + 300; // war started 5 minutes ago
		const nowMs = nowSec * 1000;

		const contract: MercContract = {
			...mockContract,
			id: "contract-offline-war-start",
			warStatusAtCreation: "upcoming",
			warStart: warStartSec,
			warEnd: warStartSec + 3600,
			changeTermsOnWarStart: true,
			terms: {
				...mockContract.terms,
				statuses: {
					online: false,
					idle: false,
					offline: true,
				},
				offlineDurationMinutes: null,
			},
			warStartTerms: {
				...mockContract.terms,
				statuses: {
					online: false,
					idle: false,
					offline: true,
				},
				offlineDurationMinutes: 60,
			},
		};

		// 20 minutes offline < 60 minute war-start floor -> disqualified
		const member = createMockMember({
			id: 3301,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 20 * 60,
				relative: "20 minutes ago",
			},
		});
		await manager.processMember(
			contract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(contract.id, 3301)).toBeUndefined();

		// 90 minutes offline >= 60 minute war-start floor -> qualifies
		const longerOffline = createMockMember({
			id: 3302,
			last_action: {
				status: "Offline",
				timestamp: nowSec - 90 * 60,
				relative: "90 minutes ago",
			},
		});
		await manager.processMember(
			contract,
			"guild-1",
			"targets",
			"role-merc-123",
			longerOffline,
			nowSec,
			nowMs,
		);
		expect(manager.getAlert(contract.id, 3302)).toBeDefined();
	});

	it("applies 60s RW cooldown when contract was created as upcoming but war is now active", async () => {
		const manager = new MercTargetManager();
		const nowSec = 1700000000;
		const nowMs = nowSec * 1000;

		const upcomingContract: MercContract = {
			...mockContract,
			id: "contract-upcoming-to-active",
			warStatusAtCreation: "upcoming",
			warStart: nowSec - 300, // war started 5 minutes ago!
			warEnd: nowSec + 3600,
		};

		// 1. Target in hospital with 30s remaining
		const member = createMockMember({
			id: 4001,
			status: {
				description: "In hospital for 30 secs",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 30,
			},
		});

		await manager.processMember(
			upcomingContract,
			"guild-1",
			"targets",
			"role-merc-123",
			member,
			nowSec,
			nowMs,
		);

		const alert1 = manager.getAlert(upcomingContract.id, 4001);
		expect(alert1).toBeDefined();
		expect(alert1?.hospitalUntil).toBe(nowSec + 30);

		// 2. Target exits hospital (status -> Okay) at nowSec + 31
		const exitSec = nowSec + 31;
		const exitMs = exitSec * 1000;
		const memberExited = createMockMember({
			id: 4001,
			status: {
				description: "Okay",
				details: null,
				state: "Okay",
				color: "green",
				until: null,
			},
		});

		await manager.processMember(
			upcomingContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberExited,
			exitSec,
			exitMs,
		);

		const alert2 = manager.getAlert(upcomingContract.id, 4001);
		expect(alert2).toBeDefined();
		// RW cooldown MUST be applied even though warStatusAtCreation was 'upcoming'
		expect(alert2?.rwCooldownUntil).toBe(nowSec + 30 + 60);
	});

	it("applies 60s RW cooldown when target medded out after being in hospital for > 60s", async () => {
		const manager = new MercTargetManager();
		const nowSec = 1700000000;
		const nowMs = nowSec * 1000;

		const activeWarContract: MercContract = {
			...mockContract,
			id: "contract-medout-test",
			warStatusAtCreation: "active",
		};

		// 1. Target in hospital for 15 minutes (900 seconds) -> invalid for active alert (> 60s)
		const memberInHosp = createMockMember({
			id: 5001,
			status: {
				description: "In hospital for 15 mins",
				details: null,
				state: "Hospital",
				color: "red",
				until: nowSec + 900,
			},
		});

		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberInHosp,
			nowSec,
			nowMs,
		);

		// Alert should NOT be posted yet because hospital > 60s
		expect(manager.getAlert(activeWarContract.id, 5001)).toBeUndefined();

		// 2. Target meds out early 10 seconds later! (status -> Okay)
		const medOutSec = nowSec + 10;
		const medOutMs = medOutSec * 1000;
		const memberMeddedOut = createMockMember({
			id: 5001,
			status: {
				description: "Okay",
				details: null,
				state: "Okay",
				color: "green",
				until: null,
			},
		});

		await manager.processMember(
			activeWarContract,
			"guild-1",
			"targets",
			"role-merc-123",
			memberMeddedOut,
			medOutSec,
			medOutMs,
		);

		// Now alert is created, AND rwCooldownUntil must be set to medOutSec + 60!
		const alert = manager.getAlert(activeWarContract.id, 5001);
		expect(alert).toBeDefined();
		expect(alert?.rwCooldownUntil).toBe(medOutSec + 60);

		// 3. Merc claims target while under RW cooldown
		const claimRes = await manager.claimTarget(
			activeWarContract.id,
			5001,
			{
				discordId: "merc-user-1",
				discordTag: "Merc#0001",
			},
			medOutMs,
		);
		expect(claimRes.success).toBe(true);
		// 20s lock timer must NOT start while under RW cooldown
		expect(claimRes.alert?.lockStartedAt).toBeUndefined();
	});

	describe("Offline Jitter Buffer", () => {
		const offlineOnlyContract: MercContract = {
			...mockContract,
			id: "contract-offline-only",
			terms: {
				...mockContract.terms,
				statuses: {
					online: false,
					idle: false,
					offline: true,
				},
			},
		};

		it("suppresses target alert when member status flickers to Offline for 1-3 seconds", async () => {
			const manager = new MercTargetManager();
			const startSec = 1700000000;

			// Step 1: Member was active 2 seconds ago, flickered to Offline
			const flickeringMember = createMockMember({
				id: 6001,
				last_action: {
					status: "Offline",
					timestamp: startSec - 2, // 2s ago
					relative: "now",
				},
			});

			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				flickeringMember,
				startSec,
				startSec * 1000,
			);

			// Alert should NOT be posted due to jitter buffer
			expect(manager.getAlert(offlineOnlyContract.id, 6001)).toBeUndefined();

			// Step 2: 3 seconds later, still Offline (only 5s total since active)
			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				flickeringMember,
				startSec + 3,
				(startSec + 3) * 1000,
			);
			expect(manager.getAlert(offlineOnlyContract.id, 6001)).toBeUndefined();

			// Step 3: Member flickers back Online
			const backOnlineMember = createMockMember({
				id: 6001,
				last_action: {
					status: "Online",
					timestamp: startSec + 4,
					relative: "now",
				},
			});
			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				backOnlineMember,
				startSec + 4,
				(startSec + 4) * 1000,
			);
			expect(manager.getAlert(offlineOnlyContract.id, 6001)).toBeUndefined();
		});

		it("posts target alert once member has been continuously offline for >= 10 seconds", async () => {
			const manager = new MercTargetManager();
			const startSec = 1700000000;

			const offlineMember = createMockMember({
				id: 6002,
				last_action: {
					status: "Offline",
					timestamp: startSec,
					relative: "now",
				},
			});

			// First seen offline at startSec (0 seconds elapsed)
			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				offlineMember,
				startSec,
				startSec * 1000,
			);
			expect(manager.getAlert(offlineOnlyContract.id, 6002)).toBeUndefined();

			// 9 seconds elapsed -> still within jitter window
			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				offlineMember,
				startSec + 9,
				(startSec + 9) * 1000,
			);
			expect(manager.getAlert(offlineOnlyContract.id, 6002)).toBeUndefined();

			// 10 seconds elapsed -> jitter window satisfied!
			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				offlineMember,
				startSec + OFFLINE_JITTER_SECONDS,
				(startSec + OFFLINE_JITTER_SECONDS) * 1000,
			);
			expect(manager.getAlert(offlineOnlyContract.id, 6002)).toBeDefined();
		});

		it("immediately qualifies members who were already offline for >= 10 seconds prior to scanning", async () => {
			const manager = new MercTargetManager();
			const startSec = 1700000000;

			const alreadyOfflineMember = createMockMember({
				id: 6003,
				last_action: {
					status: "Offline",
					timestamp: startSec - 120, // 2 minutes ago
					relative: "2 minutes ago",
				},
			});

			await manager.processMember(
				offlineOnlyContract,
				"guild-1",
				"targets",
				"role-merc-123",
				alreadyOfflineMember,
				startSec,
				startSec * 1000,
			);

			// Should be posted immediately without an extra 10s wait
			expect(manager.getAlert(offlineOnlyContract.id, 6003)).toBeDefined();
		});
	});
});

describe("MercTargetManager - Batched BS estimate pre-warm", () => {
	it("resolves a whole roster in a single upstream call, then serves cache hits", async () => {
		const manager = new MercTargetManager();
		getPlayerStatsSpy.mockClear();

		const members = [
			createMockMember({ id: 7001, level: 50 }),
			createMockMember({ id: 7002, level: 60 }),
			createMockMember({ id: 7003, level: 70 }),
		];

		const result = await manager.prewarmEstimatedBs(members);

		// One batched call for all three members, not three single-ID calls.
		expect(getPlayerStatsSpy).toHaveBeenCalledTimes(1);
		expect(getPlayerStatsSpy.mock.calls[0]?.[0]).toEqual([7001, 7002, 7003]);
		expect(result.requested).toBe(3);
		expect(result.resolved).toBe(3);

		// Per-member lookups are now pure cache hits: no further upstream calls.
		for (const m of members) {
			expect(await manager.resolveEstimatedBs(m.id, m.level)).toBe(150_000);
		}
		expect(getPlayerStatsSpy).toHaveBeenCalledTimes(1);
	});

	it("only requests uncached members on subsequent pre-warms", async () => {
		const manager = new MercTargetManager();
		const members = [
			createMockMember({ id: 7101, level: 50 }),
			createMockMember({ id: 7102, level: 60 }),
		];

		await manager.prewarmEstimatedBs(members);
		getPlayerStatsSpy.mockClear();

		// Roster gained one new member; only that one should hit upstream.
		const grown = [...members, createMockMember({ id: 7103, level: 80 })];
		const result = await manager.prewarmEstimatedBs(grown);

		expect(getPlayerStatsSpy).toHaveBeenCalledTimes(1);
		expect(getPlayerStatsSpy.mock.calls[0]?.[0]).toEqual([7103]);
		expect(result.requested).toBe(1);
	});

	it("skips the upstream fetch entirely when already aborted", async () => {
		const manager = new MercTargetManager();
		getPlayerStatsSpy.mockClear();

		const controller = new AbortController();
		controller.abort();

		const result = await manager.prewarmEstimatedBs(
			[createMockMember({ id: 7201, level: 50 })],
			controller.signal,
		);

		expect(getPlayerStatsSpy).toHaveBeenCalledTimes(0);
		expect(result.resolved).toBe(0);
	});

	it("falls back to the level-based estimate when a member is missing upstream", async () => {
		const manager = new MercTargetManager();
		getPlayerStatsSpy.mockImplementation(
			async () => [] as unknown as tornApiModule.FFScouterTargetResult[],
		);

		const result = await manager.prewarmEstimatedBs([
			createMockMember({ id: 7301, level: 50 }),
		]);

		expect(result.requested).toBe(1);
		expect(result.resolved).toBe(0);
		// Preserved original fallback: max(10_000, level * 50_000)
		expect(await manager.resolveEstimatedBs(7301, 50)).toBe(2_500_000);
	});
});
