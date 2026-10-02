import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { MercContract } from "@sentinel/database";
import type { FactionMember } from "@sentinel/schemas";
import * as tornApiModule from "@sentinel/torn-api";
import { MercTargetManager } from "../src/workers/merc/merc-contract-worker";

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
		is_revivable: true,
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
});
