import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { TornApiClient } from "@sentinel/torn-api";
import { setActiveIpcServer } from "../src/lib/ipc/server";
import { runRankedWarTrackingCycle } from "../src/workers/subversive/ranked-war-worker";
import * as keyPoolModule from "../src/workers/subversive/subversive-key-pool";

interface CapturedBroadcast {
	action: string;
	data: {
		wars: Record<
			string,
			{ war: { warId: number | null; state: string }; opponents: unknown[] }
		>;
	};
}

describe("SubversiveRankedWarWorker - multi-faction war tracking", () => {
	afterEach(() => {
		setActiveIpcServer(null);
	});

	/**
	 * Declared first on purpose: the worker's per-faction war cache is module
	 * state, so this is the only test that still sees it cold.
	 *
	 * A cold cache holds a `no_war` placeholder. When the first war poll fails,
	 * publishing that placeholder tells every subscriber the war just ended —
	 * which clears the faction's live dibs.
	 */
	it("publishes nothing for a faction Torn has not answered for yet", async () => {
		const broadcasts: CapturedBroadcast[] = [];

		setActiveIpcServer({
			broadcast: ((msg: CapturedBroadcast) => {
				if (msg.action === "subversive_war_updated") broadcasts.push(msg);
			}) as never,
		} as never);

		const keySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(
			async () =>
				({
					apiKey: "abcdefgh12345678",
					userId: 111,
					keyType: "custom",
				}) as never,
		);

		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			async () => {
				throw new Error("Torn is unavailable");
			},
		);

		try {
			await runRankedWarTrackingCycle();

			const snapshots = broadcasts.flatMap((b) =>
				Object.values(b.data.wars ?? {}),
			);
			expect(snapshots.filter((s) => s.war.state === "no_war")).toHaveLength(0);
		} finally {
			keySpy.mockRestore();
			clientSpy.mockRestore();
		}
	});

	it("polls and broadcasts a ranked war snapshot for each family faction", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const broadcasts: CapturedBroadcast[] = [];

		setActiveIpcServer({
			broadcast: ((msg: CapturedBroadcast) => {
				if (msg.action === "subversive_war_updated") broadcasts.push(msg);
			}) as never,
		} as never);

		const keySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(
			async () =>
				({
					apiKey: "abcdefgh12345678",
					userId: 111,
					keyType: "custom",
				}) as never,
		);

		const successSpy = spyOn(
			keyPoolModule,
			"recordSubversiveKeySuccess",
		).mockImplementation(() => undefined);

		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			async function (
				this: TornApiClient,
				path: string,
				options: { pathParams?: Record<string, number> },
			) {
				const id = options.pathParams?.id ?? 0;

				if (path === "/faction/{id}/wars") {
					const factionName =
						id === 2013 ? "Subversive Alliance" : "SA Succession";
					const opponentId = id === 2013 ? 7001 : 8001;
					const opponentName = id === 2013 ? "Alpha Wolves" : "Beta Order";
					return {
						wars: {
							ranked: {
								war_id: id === 2013 ? 9001 : 9002,
								start: nowSec - 3600,
								end: null,
								target: 150,
								winner: null,
								factions: [
									{ id, name: factionName, score: 20, chain: 2 },
									{ id: opponentId, name: opponentName, score: 10, chain: 1 },
								],
							},
						},
					};
				}

				if (path === "/faction/{id}/members") {
					return {
						members: [
							{
								id: id === 7001 ? 5001 : 6001,
								name: id === 7001 ? "AlphaOne" : "BetaOne",
								level: 70,
								days_in_faction: 30,
								position: "Member",
								is_revivable: false,
								is_on_wall: false,
								is_in_oc: false,
								has_early_discharge: false,
								last_action: {
									status: "Online",
									timestamp: nowSec,
									relative: "",
								},
								status: {
									description: "Okay",
									details: null,
									state: "Okay",
									color: "green",
									until: null,
								},
							},
						],
					};
				}

				return {};
			} as never,
		);

		const statsSpy = spyOn(
			await import("@sentinel/torn-api"),
			"getPlayerStats",
		).mockImplementation(async () => [] as never);

		try {
			const nextRunAt = await runRankedWarTrackingCycle();

			// Both factions were polled
			const polledFactionIds = clientSpy.mock.calls
				.map(
					(call) =>
						(call[1] as { pathParams?: { id?: number } })?.pathParams?.id,
				)
				.filter((id): id is number => typeof id === "number");
			expect(polledFactionIds).toContain(2013);
			expect(polledFactionIds).toContain(27312);

			// One broadcast carrying both wars with their own opponent rosters
			expect(broadcasts.length).toBe(1);
			const wars = broadcasts[0]?.data.wars ?? {};
			expect(Object.keys(wars).sort()).toEqual(["2013", "27312"]);
			const primary = wars["2013"];
			const succession = wars["27312"];
			if (!primary || !succession) throw new Error("missing war snapshots");
			expect(primary.war.warId).toBe(9001);
			expect(succession.war.warId).toBe(9002);
			expect(
				(primary.opponents as Array<{ id: number }>).map((o) => o.id),
			).toEqual([5001]);
			expect(
				(succession.opponents as Array<{ id: number }>).map((o) => o.id),
			).toEqual([6001]);

			// Both wars are active so the worker schedules the fast cadence
			expect(nextRunAt - Date.now()).toBeLessThanOrEqual(1_000);
		} finally {
			keySpy.mockRestore();
			successSpy.mockRestore();
			clientSpy.mockRestore();
			statsSpy.mockRestore();
		}
	});

	/**
	 * The API derives each faction's hospital queue from this roster, and reads
	 * "not in the queue" as "left hospital": broadcasting a failed poll as `[]`
	 * unclaimed every live dibs on the next cycle (and blanked the war board).
	 */
	it("carries the last known roster forward when the roster poll fails", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const broadcasts: CapturedBroadcast[] = [];
		let failMembers = false;

		setActiveIpcServer({
			broadcast: ((msg: CapturedBroadcast) => {
				if (msg.action === "subversive_war_updated") broadcasts.push(msg);
			}) as never,
		} as never);

		const keySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(
			async () =>
				({
					apiKey: "abcdefgh12345678",
					userId: 111,
					keyType: "custom",
				}) as never,
		);

		const successSpy = spyOn(
			keyPoolModule,
			"recordSubversiveKeySuccess",
		).mockImplementation(() => undefined);

		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			async function (
				this: TornApiClient,
				path: string,
				options: { pathParams?: Record<string, number> },
			) {
				const id = options.pathParams?.id ?? 0;

				if (path === "/faction/{id}/wars") {
					return {
						wars: {
							ranked: {
								war_id: id === 2013 ? 9001 : 9002,
								start: nowSec - 3600,
								end: null,
								target: 150,
								winner: null,
								factions: [
									{ id, name: `Faction${id}`, score: 20, chain: 2 },
									{
										id: id === 2013 ? 7001 : 8001,
										name: "Enemy",
										score: 10,
										chain: 1,
									},
								],
							},
						},
					};
				}

				if (path === "/faction/{id}/members") {
					if (failMembers) throw new Error("Torn rate limit exceeded");
					return {
						members: [
							{
								id: id === 7001 ? 5001 : 6001,
								name: id === 7001 ? "AlphaOne" : "BetaOne",
								level: 70,
								days_in_faction: 30,
								position: "Member",
								is_revivable: false,
								is_on_wall: false,
								is_in_oc: false,
								has_early_discharge: false,
								last_action: {
									status: "Online",
									timestamp: nowSec,
									relative: "",
								},
								status: {
									description: "In hospital for 2 mins",
									details: null,
									state: "Hospital",
									color: "red",
									until: nowSec + 120,
								},
							},
						],
					};
				}

				return {};
			} as never,
		);

		const statsSpy = spyOn(
			await import("@sentinel/torn-api"),
			"getPlayerStats",
		).mockImplementation(async () => [] as never);

		try {
			await runRankedWarTrackingCycle();
			expect(broadcasts.length).toBe(1);

			// Every roster read fails from here on.
			failMembers = true;
			await runRankedWarTrackingCycle();

			for (const broadcast of broadcasts) {
				const primary = broadcast.data.wars?.["2013"];
				if (!primary) continue;
				expect(primary.opponents.length).toBeGreaterThan(0);
			}
		} finally {
			keySpy.mockRestore();
			successSpy.mockRestore();
			clientSpy.mockRestore();
			statsSpy.mockRestore();
		}
	});
});
