import { describe, expect, it } from "bun:test";
import type { MercContract, MercContractHitTerms } from "@sentinel/database";

describe("Mercenary Contracts - Data Models & Contract Calculations", () => {
	it("correctly identifies active war vs upcoming war vs no war", () => {
		const nowSec = 1700000000;

		const activeWar = {
			id: 1,
			start: nowSec - 3600, // started 1h ago
			end: null,
			target: 10000,
			winner: null,
			factions: [
				{ id: 27312, name: "Our Faction" },
				{ id: 99999, name: "Opponent Faction" },
			],
		};

		const upcomingWar = {
			id: 2,
			start: nowSec + 7200, // starts in 2h
			end: null,
			target: 10000,
			winner: null,
			factions: [
				{ id: 27312, name: "Our Faction" },
				{ id: 88888, name: "Upcoming Opponent" },
			],
		};

		const pastWar = {
			id: 3,
			start: nowSec - 7200,
			end: nowSec - 1800,
			target: 10000,
			winner: 27312,
			factions: [{ id: 27312, name: "Our Faction" }],
		};

		// Test Active War evaluation
		const isActive =
			activeWar.start <= nowSec &&
			(!activeWar.end || activeWar.end === 0 || activeWar.end > nowSec) &&
			(!activeWar.winner || activeWar.winner === 0);
		expect(isActive).toBe(true);

		// Test Upcoming War evaluation
		const isUpcoming =
			upcomingWar.start > nowSec &&
			(!upcomingWar.winner || upcomingWar.winner === 0);
		expect(isUpcoming).toBe(true);

		// Test Past War evaluation
		const isPastActive =
			pastWar.start <= nowSec &&
			(!pastWar.end || pastWar.end === 0 || pastWar.end > nowSec) &&
			(!pastWar.winner || pastWar.winner === 0);
		expect(isPastActive).toBe(false);
	});

	it("computes relative contract start time for upcoming wars correctly", () => {
		const warStartMs = 1700000000 * 1000;
		const sliderMinutes = 30; // 30 minutes before war

		const computedStartMs = warStartMs - sliderMinutes * 60 * 1000;
		const computedDate = new Date(computedStartMs);

		expect(computedDate.getTime()).toBe(warStartMs - 1800000);
	});

	it("creates a properly shaped contract with primary and secondary terms", () => {
		const terms: MercContractHitTerms = {
			statuses: { online: true, idle: true, offline: true },
			idleDurationMinutes: 15,
			offlineDurationMinutes: null,
			strickenHits: true,
			levelRange: [1, 100],
		};

		const warStartTerms: MercContractHitTerms = {
			statuses: { online: true, idle: false, offline: false },
			idleDurationMinutes: null,
			offlineDurationMinutes: null,
			strickenHits: false,
			levelRange: [10, 80],
		};

		const contract: MercContract = {
			id: "test-uuid-1234",
			guildId: "1234567890",
			factionId: 27312,
			factionName: "Destructive Anomaly",
			warStatusAtCreation: "upcoming",
			warId: 9999,
			warStart: 1700000000,
			warEnd: null,
			warTarget: 10000,
			warOpponent: { id: 55555, name: "Enemy Faction" },
			startTime: new Date(1700000000 * 1000 - 1800000).toISOString(),
			startImmediately: false,
			startMinutesBeforeWar: 30,
			endTime: null,
			endOnWarEnd: true,
			terms,
			hitPrice: 1_000_000,
			changeTermsOnWarStart: true,
			warStartTerms,
			status: "upcoming",
			createdAt: new Date().toISOString(),
		};

		expect(contract.factionId).toBe(27312);
		expect(contract.warOpponent?.name).toBe("Enemy Faction");
		expect(contract.terms.strickenHits).toBe(true);
		expect(contract.changeTermsOnWarStart).toBe(true);
		expect(contract.warStartTerms?.levelRange).toEqual([10, 80]);
	});

	it("correctly identifies stricken hits from finishing_hit_effects", () => {
		const attackWithWarlord = {
			id: 12345,
			finishing_hit_effects: [{ name: "warlord", value: 20 }],
		};

		const attackWithStricken = {
			id: 12346,
			finishing_hit_effects: [{ name: "stricken", value: 10 }],
		};

		const attackStandard = {
			id: 12347,
			finishing_hit_effects: [],
		};

		const attackOther = {
			id: 12348,
			finishing_hit_effects: [{ name: "wind", value: 5 }],
		};

		const isStricken = (effects?: Array<{ name: string; value: number }>) =>
			Boolean(
				effects?.some((e) => {
					return e.name.toLowerCase() === "stricken";
				}),
			);

		expect(isStricken(attackWithWarlord.finishing_hit_effects)).toBe(false);
		expect(isStricken(attackWithStricken.finishing_hit_effects)).toBe(true);
		expect(isStricken(attackStandard.finishing_hit_effects)).toBe(false);
		expect(isStricken(attackOther.finishing_hit_effects)).toBe(false);
	});

	it("computes correct hit payouts based on standard vs stricken terms and hospitalization requirement", () => {
		const contract: Partial<MercContract> = {
			hitPrice: 1_000_000,
			strickenHitPrice: 1_500_000,
		};

		const calcPayout = (isStricken: boolean, result = "Hospitalized") => {
			if (result.toLowerCase() !== "hospitalized") {
				return 0;
			}
			if (isStricken && contract.strickenHitPrice) {
				return contract.strickenHitPrice;
			}
			return contract.hitPrice ?? 0;
		};

		expect(calcPayout(false, "Hospitalized")).toBe(1_000_000);
		expect(calcPayout(true, "Hospitalized")).toBe(1_500_000);
		expect(calcPayout(false, "Attacked")).toBe(0);
		expect(calcPayout(true, "Mugged")).toBe(0);
		expect(calcPayout(false, "Arrested")).toBe(0);
	});

	it("generates correct CSV format for contract conclusion summary", () => {
		const summary = {
			totalHits: 3,
			totalPayout: 4_000_000,
			mercPayouts: [
				{
					attackerId: 999,
					attackerName: "TestMerc",
					totalHits: 3,
					standardHits: 1,
					strickenHits: 2,
					totalPayout: 4_000_000,
				},
			],
			targetBreakdown: [
				{
					defenderId: 888,
					defenderName: "VictimOne",
					totalHits: 2,
					standardHitsReceived: 1,
					strickenHitsReceived: 1,
				},
				{
					defenderId: 777,
					defenderName: "VictimTwo",
					totalHits: 1,
					standardHitsReceived: 0,
					strickenHitsReceived: 1,
				},
			],
		};

		// CSV 1 format (Combined Merc Payouts)
		let csv1 =
			"Mercenary Name,Torn ID,Total Hits,Standard Hits,Stricken Hits,Total Payout ($)\n";
		for (const m of summary.mercPayouts) {
			csv1 += `"${m.attackerName.replace(/"/g, '""')}",${m.attackerId},${m.totalHits},${m.standardHits},${m.strickenHits},${m.totalPayout}\n`;
		}

		// CSV 2 format (Target breakdown)
		let csv2 =
			"Target Name,Torn ID,Total Times Hit,Standard Hits Received,Stricken Hits Received\n";
		for (const t of summary.targetBreakdown) {
			csv2 += `"${t.defenderName.replace(/"/g, '""')}",${t.defenderId},${t.totalHits},${t.standardHitsReceived},${t.strickenHitsReceived}\n`;
		}

		expect(csv1).toContain('"TestMerc",999,3,1,2,4000000');
		expect(csv2).toContain('"VictimOne",888,2,1,1');
		expect(csv2).toContain('"VictimTwo",777,1,0,1');
	});

	it("generates 3 merc receipts when mercenaries belong to 2 different factions (combined + 2 factions)", () => {
		const mercs = [
			{
				attackerId: 101,
				attackerName: "MercAlpha",
				attackerFactionId: 501,
				attackerFactionName: "Subversive",
				totalHits: 4,
				standardHits: 3,
				strickenHits: 1,
				totalPayout: 5_000_000,
			},
			{
				attackerId: 102,
				attackerName: "MercBeta",
				attackerFactionId: 502,
				attackerFactionName: "Subversive II",
				totalHits: 2,
				standardHits: 2,
				strickenHits: 0,
				totalPayout: 2_000_000,
			},
		];

		// 1. Combined receipt
		let combinedCsv =
			"Mercenary Name,Torn ID,Faction,Total Hits,Standard Hits,Stricken Hits,Total Payout ($)\n";
		for (const m of mercs) {
			combinedCsv += `"${m.attackerName}",${m.attackerId},"${m.attackerFactionName}",${m.totalHits},${m.standardHits},${m.strickenHits},${m.totalPayout}\n`;
		}

		// Group by faction
		const factionMap = new Map<number, typeof mercs>();
		for (const m of mercs) {
			const list = factionMap.get(m.attackerFactionId) ?? [];
			list.push(m);
			factionMap.set(m.attackerFactionId, list);
		}

		const factionReceipts: Array<{ factionName: string; csv: string }> = [];
		for (const [factionId, fMercs] of factionMap.entries()) {
			const factionName =
				fMercs[0]?.attackerFactionName ?? `Faction #${factionId}`;
			let fCsv =
				"Mercenary Name,Torn ID,Faction,Total Hits,Standard Hits,Stricken Hits,Total Payout ($)\n";
			for (const m of fMercs) {
				fCsv += `"${m.attackerName}",${m.attackerId},"${m.attackerFactionName}",${m.totalHits},${m.standardHits},${m.strickenHits},${m.totalPayout}\n`;
			}
			factionReceipts.push({ factionName, csv: fCsv });
		}

		// Total merc receipts = 1 combined + 2 factions = 3 receipts
		const allMercReceipts = [
			{ name: "combined", csv: combinedCsv },
			...factionReceipts,
		];

		expect(allMercReceipts.length).toBe(3);
		expect(allMercReceipts[0]?.csv).toContain('"MercAlpha",101,"Subversive"');
		expect(allMercReceipts[0]?.csv).toContain('"MercBeta",102,"Subversive II"');
		expect(allMercReceipts[1]?.csv).toContain('"MercAlpha",101,"Subversive"');
		expect(allMercReceipts[1]?.csv).not.toContain('"MercBeta"');
		expect(allMercReceipts[2]?.csv).toContain('"MercBeta",102,"Subversive II"');
		expect(allMercReceipts[2]?.csv).not.toContain('"MercAlpha"');
	});

	it("blocks new contract creation if an active or upcoming contract already exists for the faction", () => {
		const terms: MercContractHitTerms = {
			statuses: { online: true, idle: false, offline: false },
			idleDurationMinutes: null,
			offlineDurationMinutes: null,
			strickenHits: false,
			levelRange: [10, 80],
		};

		const existingContracts: MercContract[] = [
			{
				id: "contract-active-1",
				guildId: "1234567890",
				factionId: 2013,
				factionName: "Subversive Alliance",
				warStatusAtCreation: "active",
				startTime: new Date().toISOString(),
				endTime: null,
				terms,
				hitPrice: 3000000,
				status: "active",
				createdAt: new Date().toISOString(),
			},
		];

		const canCreate = !existingContracts.some(
			(c) =>
				c.factionId === 2013 &&
				(c.status === "active" || c.status === "upcoming"),
		);

		expect(canCreate).toBe(false);
	});

	it("permits new contract creation when previous contract is completed or cancelled", () => {
		const terms: MercContractHitTerms = {
			statuses: { online: true, idle: false, offline: false },
			idleDurationMinutes: null,
			offlineDurationMinutes: null,
			strickenHits: false,
			levelRange: [10, 80],
		};

		const existingContracts: MercContract[] = [
			{
				id: "contract-old-1",
				guildId: "1234567890",
				factionId: 2013,
				factionName: "Subversive Alliance",
				warStatusAtCreation: "active",
				startTime: new Date(Date.now() - 7200000).toISOString(),
				endTime: new Date(Date.now() - 3600000).toISOString(),
				terms,
				hitPrice: 3000000,
				status: "completed",
				createdAt: new Date(Date.now() - 7200000).toISOString(),
			},
			{
				id: "contract-old-2",
				guildId: "1234567890",
				factionId: 2013,
				factionName: "Subversive Alliance",
				warStatusAtCreation: "no_war",
				startTime: new Date(Date.now() - 3600000).toISOString(),
				endTime: null,
				terms,
				hitPrice: 3000000,
				status: "cancelled",
				createdAt: new Date(Date.now() - 3600000).toISOString(),
			},
		];

		const canCreate = !existingContracts.some(
			(c) =>
				c.factionId === 2013 &&
				(c.status === "active" || c.status === "upcoming"),
		);

		expect(canCreate).toBe(true);
	});

	it("identifies and targets respective upcoming contract embed for auto-deletion when contract ends", () => {
		const contractId = "contract-target-del-1";
		const factionId = 2013;
		const upcomingMessageId = "msg-upcoming-999";

		// 1. Direct message ID matching
		const contract = {
			id: contractId,
			factionId,
			upcomingMessageId,
			upcomingChannelId: "chan-upcoming-1",
			status: "completed" as const,
		};

		const shouldDeleteDirect = Boolean(
			contract.status === "completed" && contract.upcomingMessageId,
		);
		expect(shouldDeleteDirect).toBe(true);

		// 2. Fallback embed scan matcher
		const mockBotMessages = [
			{
				id: "msg-unrelated",
				authorId: "bot-id",
				embeds: [
					{
						title: "[UPCOMING CONTRACT] Other Faction [9999]",
						footer: { text: "Contract ID: contract-other" },
					},
				],
			},
			{
				id: upcomingMessageId,
				authorId: "bot-id",
				embeds: [
					{
						title: "[UPCOMING CONTRACT] Subversive Alliance [2013]",
						description:
							"Contract registered for [Subversive Alliance [2013]](https://www.torn.com/factions.php?step=profile&ID=2013).",
						footer: { text: `Contract ID: ${contractId}` },
					},
				],
			},
		];

		const matched = mockBotMessages.find((msg) =>
			msg.embeds.some(
				(e) =>
					e.title.toUpperCase().includes("[UPCOMING CONTRACT]") &&
					(e.footer.text.includes(contractId) ||
						e.title.includes(`[${factionId}]`)),
			),
		);

		expect(matched).toBeDefined();
		expect(matched?.id).toBe(upcomingMessageId);
	});
});
