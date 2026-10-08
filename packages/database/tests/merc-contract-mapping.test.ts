import { describe, expect, it } from "bun:test";
import { mapRowToMercContract, type mercContracts } from "../index";

/**
 * Row-level mapping tests for the optional "minimum minutes offline" contract
 * term. The column is nullable with no default, so NULL must survive as `null`
 * (meaning "no minimum") rather than being coerced into a duration, otherwise
 * every pre-existing contract would silently start filtering offline targets.
 */
function buildRow(
	overrides: Record<string, unknown> = {},
): typeof mercContracts.$inferSelect {
	const now = new Date();
	return {
		id: "contract-1",
		guildId: "guild-1",
		factionId: 100,
		factionName: "Target Faction",
		warStatusAtCreation: "no_war",
		warId: null,
		warStart: null,
		warEnd: null,
		warTarget: null,
		warOpponentId: null,
		warOpponentName: null,
		startTime: new Date(now.getTime() - 60_000),
		startImmediately: true,
		startMinutesBeforeWar: null,
		endTime: null,
		endOnWarEnd: false,
		allowOnline: true,
		allowIdle: true,
		allowOffline: true,
		maxIdleMinutes: 15,
		minOfflineMinutes: null,
		allowStrickenHits: false,
		minLevel: 1,
		maxLevel: 100,
		hitPrice: 250_000,
		strickenHitPrice: null,
		autoStopPrice: null,
		excludedMembers: [],
		pausedWindows: [],
		changeTermsOnWarStart: false,
		warStartAllowOnline: null,
		warStartAllowIdle: null,
		warStartAllowOffline: null,
		warStartMaxIdleMinutes: null,
		warStartMinOfflineMinutes: null,
		warStartAllowStrickenHits: null,
		warStartMinLevel: null,
		warStartMaxLevel: null,
		warStartHitPrice: null,
		warStartStrickenHitPrice: null,
		status: "active",
		paidAt: null,
		clientChannelId: null,
		clientDiscordId: null,
		upcomingMessageId: null,
		upcomingChannelId: null,
		revivablesMessageId: null,
		createdBy: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	} as unknown as typeof mercContracts.$inferSelect;
}

describe("mapRowToMercContract - minimum offline duration", () => {
	it("maps a NULL minimum to null so offline targets are unfiltered by default", () => {
		const contract = mapRowToMercContract(buildRow());
		expect(contract.terms.statuses.offline).toBe(true);
		expect(contract.terms.offlineDurationMinutes).toBeNull();
	});

	it("maps a stored minimum through to the terms", () => {
		const contract = mapRowToMercContract(buildRow({ minOfflineMinutes: 30 }));
		expect(contract.terms.offlineDurationMinutes).toBe(30);
	});

	it("reports no minimum when offline targets are not allowed", () => {
		const contract = mapRowToMercContract(
			buildRow({ allowOffline: false, minOfflineMinutes: 30 }),
		);
		expect(contract.terms.statuses.offline).toBe(false);
		expect(contract.terms.offlineDurationMinutes).toBeNull();
	});

	it("maps the war-start minimum independently of the primary terms", () => {
		const contract = mapRowToMercContract(
			buildRow({
				changeTermsOnWarStart: true,
				minOfflineMinutes: null,
				warStartAllowOffline: true,
				warStartMinOfflineMinutes: 45,
			}),
		);

		expect(contract.terms.offlineDurationMinutes).toBeNull();
		expect(contract.warStartTerms?.offlineDurationMinutes).toBe(45);
	});

	it("leaves the war-start minimum unset when it was never configured", () => {
		const contract = mapRowToMercContract(
			buildRow({
				changeTermsOnWarStart: true,
				warStartAllowOffline: true,
				warStartMinOfflineMinutes: null,
			}),
		);

		expect(contract.warStartTerms?.offlineDurationMinutes).toBeNull();
	});
});
