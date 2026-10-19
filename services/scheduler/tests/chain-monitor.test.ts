import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { db, inArray, subversiveTargetFinderTargets } from "@sentinel/database";
import { DEFAULT_SUBVERSIVE_CHAIN_CONFIG } from "@sentinel/schemas";
import { TornApiClient, TornError } from "@sentinel/torn-api";
import * as chainConfigModule from "../src/lib/chain-config";
import { setActiveIpcServer } from "../src/lib/ipc/server";
import {
	ACTIVE_CADENCE_MS,
	type ChainMonitorState,
	type ChainSnapshot,
	evaluateChainWarning,
	idleCadenceMsFor,
	MAX_IDLE_CADENCE_MS,
	MIN_IDLE_CADENCE_MS,
	parseChainSnapshot,
	resetChainMonitorStateForTesting,
	runChainMonitorCycle,
	selectLowStatOkayTargets,
} from "../src/workers/subversive/chain-monitor";
import * as keyPoolModule from "../src/workers/subversive/subversive-key-pool";

const NOW_MS = 1_800_000_000_000;
const FIXTURE_IDS = [
	99_800_001, 99_800_002, 99_800_003, 99_800_004, 99_800_005, 99_800_006,
];

const CONFIG = {
	...DEFAULT_SUBVERSIVE_CHAIN_CONFIG,
	enabled: true,
	channelId: "111111111111111111",
	warningRoleId: "222222222222222222",
	minimumChainStart: 10,
	chainTimeWarningSeconds: 60,
	subsequentWarningIntervalSeconds: 10,
};

function snapshot(patch: Partial<ChainSnapshot> = {}): ChainSnapshot {
	return {
		current: 25,
		max: 100,
		timeoutSeconds: 60,
		cooldown: 0,
		start: 1_700_000_000,
		modifier: 1.2,
		fetchedAtMs: NOW_MS,
		...patch,
	};
}

interface CapturedBroadcast {
	action: string;
	data: Record<string, unknown>;
}

function captureBroadcasts(): CapturedBroadcast[] {
	const broadcasts: CapturedBroadcast[] = [];
	setActiveIpcServer({
		broadcast: (message: CapturedBroadcast) => {
			broadcasts.push(message);
		},
	} as never);
	return broadcasts;
}

describe("chain snapshot parsing", () => {
	it("parses a normal Torn chain response", () => {
		expect(
			parseChainSnapshot(
				{
					chain: {
						current: 25,
						max: 100,
						timeout: 13,
						cooldown: 0,
						start: 1_700_000_000,
						modifier: 1.25,
					},
				},
				NOW_MS,
			),
		).toEqual({
			current: 25,
			max: 100,
			timeoutSeconds: 13,
			cooldown: 0,
			start: 1_700_000_000,
			modifier: 1.25,
			fetchedAtMs: NOW_MS,
		});
	});

	it("treats an explicit null chain as no chain", () => {
		expect(parseChainSnapshot({ chain: null }, NOW_MS)).toMatchObject({
			current: 0,
			timeoutSeconds: 0,
		});
	});

	it("rejects a missing or malformed chain instead of assuming zero", () => {
		expect(parseChainSnapshot({}, NOW_MS)).toBeNull();
		expect(parseChainSnapshot({ chain: "down" }, NOW_MS)).toBeNull();
		expect(
			parseChainSnapshot({ chain: { current: "lots", timeout: 10 } }, NOW_MS),
		).toBeNull();
	});
});

describe("chain warning state machine", () => {
	it("does not warn below the configured minimum", () => {
		const decision = evaluateChainWarning(
			undefined,
			snapshot({ current: 9, timeoutSeconds: 5 }),
			CONFIG,
			NOW_MS,
		);

		expect(decision.send).toBe(false);
		expect(decision.state.active).toBe(false);
	});

	it("does not warn while the timer is above the threshold", () => {
		const decision = evaluateChainWarning(
			undefined,
			snapshot({ timeoutSeconds: 61 }),
			CONFIG,
			NOW_MS,
		);

		expect(decision.send).toBe(false);
		expect(decision.state.active).toBe(true);
	});

	it("warns immediately when a qualifying chain is already inside the window", () => {
		const decision = evaluateChainWarning(
			undefined,
			snapshot({ timeoutSeconds: 60 }),
			CONFIG,
			NOW_MS,
		);

		expect(decision.send).toBe(true);
		expect(decision.state.warningCount).toBe(1);
		expect(decision.state.lastWarningAtMs).toBe(NOW_MS);
	});

	it("suppresses repeats until the interval has elapsed", () => {
		const first = evaluateChainWarning(
			undefined,
			snapshot({ timeoutSeconds: 40 }),
			CONFIG,
			NOW_MS,
		);

		const tooSoon = evaluateChainWarning(
			first.state,
			snapshot({ timeoutSeconds: 35 }),
			CONFIG,
			NOW_MS + 5_000,
		);

		expect(tooSoon.send).toBe(false);

		const due = evaluateChainWarning(
			first.state,
			snapshot({ timeoutSeconds: 30 }),
			CONFIG,
			NOW_MS + 10_000,
		);

		expect(due.send).toBe(true);
		expect(due.state.warningCount).toBe(2);
	});

	it("sends only the first warning when the repeat interval is zero", () => {
		const first = evaluateChainWarning(
			undefined,
			snapshot({ timeoutSeconds: 40 }),
			{ ...CONFIG, subsequentWarningIntervalSeconds: 0 },
			NOW_MS,
		);

		const later = evaluateChainWarning(
			first.state,
			snapshot({ timeoutSeconds: 10 }),
			{ ...CONFIG, subsequentWarningIntervalSeconds: 0 },
			NOW_MS + 60_000,
		);

		expect(first.send).toBe(true);
		expect(later.send).toBe(false);
	});

	it("re-arms when the timer rises above the threshold", () => {
		const first = evaluateChainWarning(
			undefined,
			snapshot({ timeoutSeconds: 40 }),
			CONFIG,
			NOW_MS,
		);

		const extended = evaluateChainWarning(
			first.state,
			snapshot({ timeoutSeconds: 120 }),
			CONFIG,
			NOW_MS + 5_000,
		);

		expect(extended.send).toBe(false);
		expect(extended.state.lastWarningAtMs).toBeNull();
		expect(extended.state.warningCount).toBe(0);

		const lowAgain = evaluateChainWarning(
			extended.state,
			snapshot({ timeoutSeconds: 55 }),
			CONFIG,
			NOW_MS + 10_000,
		);

		expect(lowAgain.send).toBe(true);
		expect(lowAgain.state.warningCount).toBe(1);
	});

	it("treats a different chain start as a fresh chain", () => {
		const previous: ChainMonitorState = {
			chainStart: 1_600_000_000,
			lastWarningAtMs: NOW_MS - 5_000,
			warningCount: 4,
			active: true,
		};

		const decision = evaluateChainWarning(
			previous,
			snapshot({ start: 1_700_000_000, timeoutSeconds: 30 }),
			CONFIG,
			NOW_MS,
		);

		expect(decision.send).toBe(true);
		expect(decision.state.chainStart).toBe(1_700_000_000);
		expect(decision.state.warningCount).toBe(1);
	});

	it("suppresses a warning derived from a stale snapshot", () => {
		const decision = evaluateChainWarning(
			undefined,
			snapshot({ timeoutSeconds: 5, fetchedAtMs: NOW_MS - 60_000 }),
			CONFIG,
			NOW_MS,
		);

		expect(decision.send).toBe(false);
		expect(decision.state.active).toBe(false);
	});
});

describe("chain monitor idle cadence", () => {
	it("polls at half the shortest configured warning window", () => {
		expect(idleCadenceMsFor([CONFIG])).toBe(30_000);
	});

	it("clamps to the 10s floor and 60s ceiling", () => {
		expect(idleCadenceMsFor([{ ...CONFIG, chainTimeWarningSeconds: 5 }])).toBe(
			MIN_IDLE_CADENCE_MS,
		);
		expect(
			idleCadenceMsFor([{ ...CONFIG, chainTimeWarningSeconds: 3_600 }]),
		).toBe(MAX_IDLE_CADENCE_MS);
	});

	it("uses the slowest interval when nothing is routed", () => {
		expect(
			idleCadenceMsFor([
				{ ...CONFIG, enabled: false },
				{ ...CONFIG, channelId: null },
			]),
		).toBe(MAX_IDLE_CADENCE_MS);
	});
});

describe("chain warning target selection", () => {
	beforeAll(async () => {
		await db
			.delete(subversiveTargetFinderTargets)
			.where(inArray(subversiveTargetFinderTargets.targetId, FIXTURE_IDS));

		await db.insert(subversiveTargetFinderTargets).values([
			{
				targetId: 99_800_001,
				name: "LowestOkay",
				level: 10,
				factionId: 7001,
				daysOld: 10,
				inHospital: false,
				estimatedBs: 0.0001,
				estimatedScore: 0.0001,
				status: "okay",
			},
			{
				targetId: 99_800_002,
				name: "SecondOkay",
				level: 11,
				factionId: 7002,
				daysOld: 10,
				inHospital: false,
				estimatedBs: 0.0002,
				estimatedScore: 0.0002,
				status: "okay",
			},
			{
				targetId: 99_800_003,
				name: "ThirdOkay",
				level: 12,
				factionId: null,
				daysOld: 10,
				inHospital: false,
				estimatedBs: 0.0003,
				estimatedScore: 0.0003,
				status: "okay",
			},
			{
				targetId: 99_800_004,
				name: "Hospital",
				level: 1,
				factionId: 7004,
				daysOld: 10,
				inHospital: true,
				estimatedBs: 0.00001,
				estimatedScore: 0.00001,
				status: "okay",
			},
			{
				targetId: 99_800_005,
				name: "FamilyMember",
				level: 1,
				factionId: 2013,
				daysOld: 10,
				inHospital: false,
				estimatedBs: 0.00002,
				estimatedScore: 0.00002,
				status: "okay",
			},
			{
				targetId: 99_800_006,
				name: "Traveling",
				level: 1,
				factionId: 7006,
				daysOld: 10,
				inHospital: false,
				estimatedBs: 0.00003,
				estimatedScore: 0.00003,
				status: "traveling",
			},
		]);
	});

	afterAll(async () => {
		await db
			.delete(subversiveTargetFinderTargets)
			.where(inArray(subversiveTargetFinderTargets.targetId, FIXTURE_IDS));
	});

	it("returns only okay, non-hospital, non-family targets in ascending BS order", async () => {
		const targets = await selectLowStatOkayTargets(3);

		expect(targets).toHaveLength(3);
		expect(targets.map((target) => target.id)).toEqual([
			99_800_001, 99_800_002, 99_800_003,
		]);
	});
});

describe("chain monitor cycle", () => {
	afterEach(() => {
		setActiveIpcServer(null);
		resetChainMonitorStateForTesting();
	});

	function baseSpies() {
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

		const disabledSpy = spyOn(
			keyPoolModule,
			"markSubversiveKeyDisabled",
		).mockImplementation(() => 30_000);

		return { keySpy, successSpy, disabledSpy };
	}

	it("broadcasts a warning only after a fresh qualifying snapshot", async () => {
		const broadcasts = captureBroadcasts();
		const { keySpy, successSpy, disabledSpy } = baseSpies();

		const configSpy = spyOn(
			chainConfigModule,
			"resolveChainConfigs",
		).mockImplementation(async (factionIds: number[]) => {
			const map = new Map<number, typeof CONFIG>();
			for (const factionId of factionIds) map.set(factionId, CONFIG);
			return map as never;
		});

		const nowSec = Math.floor(Date.now() / 1000);
		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			async function (this: TornApiClient) {
				return {
					chain: {
						current: 25,
						max: 100,
						timeout: 30,
						cooldown: 0,
						start: nowSec - 300,
						modifier: 1.2,
					},
				};
			} as never,
		);

		try {
			const nextRun = await runChainMonitorCycle();

			const alerts = broadcasts.filter(
				(broadcast) => broadcast.action === "subversive_chain_alert",
			);
			expect(alerts).toHaveLength(2);
			expect(alerts[0]?.data.channelId).toBe(CONFIG.channelId);
			expect(alerts[0]?.data.warningRoleId).toBe(CONFIG.warningRoleId);
			expect(alerts[0]?.data.chainCurrent).toBe(25);
			expect(alerts[0]?.data.timeoutSeconds).toBe(30);
			expect(nextRun).toBeGreaterThan(Date.now() + ACTIVE_CADENCE_MS - 1_000);
			expect(successSpy).toHaveBeenCalled();
		} finally {
			configSpy.mockRestore();
			clientSpy.mockRestore();
			keySpy.mockRestore();
			successSpy.mockRestore();
			disabledSpy.mockRestore();
		}
	});

	it("never broadcasts when Torn is down or the response is malformed", async () => {
		const broadcasts = captureBroadcasts();
		const { keySpy, successSpy, disabledSpy } = baseSpies();

		const configSpy = spyOn(
			chainConfigModule,
			"resolveChainConfigs",
		).mockImplementation(async (factionIds: number[]) => {
			const map = new Map<number, typeof CONFIG>();
			for (const factionId of factionIds) map.set(factionId, CONFIG);
			return map as never;
		});

		let call = 0;
		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			(async () => {
				call += 1;
				if (call === 1) throw new Error("Torn is unavailable");
				return {};
			}) as never,
		);

		try {
			await runChainMonitorCycle();

			expect(
				broadcasts.filter(
					(broadcast) => broadcast.action === "subversive_chain_alert",
				),
			).toHaveLength(0);
		} finally {
			configSpy.mockRestore();
			clientSpy.mockRestore();
			keySpy.mockRestore();
			successSpy.mockRestore();
			disabledSpy.mockRestore();
		}
	});

	it("does not poll when the faction is disabled or has no channel", async () => {
		const broadcasts = captureBroadcasts();
		const { keySpy, successSpy, disabledSpy } = baseSpies();

		const configSpy = spyOn(
			chainConfigModule,
			"resolveChainConfigs",
		).mockImplementation(async (factionIds: number[]) => {
			const map = new Map<number, typeof CONFIG>();
			for (const factionId of factionIds) {
				map.set(factionId, { ...CONFIG, enabled: false });
			}
			return map as never;
		});

		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			(async () => {
				throw new Error("should not be called");
			}) as never,
		);

		try {
			await runChainMonitorCycle();

			expect(clientSpy).not.toHaveBeenCalled();
			expect(
				broadcasts.filter(
					(broadcast) => broadcast.action === "subversive_chain_alert",
				),
			).toHaveLength(0);
		} finally {
			configSpy.mockRestore();
			clientSpy.mockRestore();
			keySpy.mockRestore();
			successSpy.mockRestore();
			disabledSpy.mockRestore();
		}
	});

	it("rotates to the next Subversive key when a key is rejected", async () => {
		const broadcasts = captureBroadcasts();
		const keys = [
			{ apiKey: "aaaaaaaaaaaaaaaa", userId: 111, keyType: "custom" },
			{ apiKey: "bbbbbbbbbbbbbbbb", userId: 222, keyType: "custom" },
		];
		let keyIndex = 0;

		const keySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(async () => (keys[keyIndex++] ?? keys[0]) as never);
		const successSpy = spyOn(
			keyPoolModule,
			"recordSubversiveKeySuccess",
		).mockImplementation(() => undefined);
		const disabledSpy = spyOn(
			keyPoolModule,
			"markSubversiveKeyDisabled",
		).mockImplementation(() => 30_000);

		const configSpy = spyOn(
			chainConfigModule,
			"resolveChainConfigs",
		).mockImplementation(async (factionIds: number[]) => {
			const map = new Map<number, typeof CONFIG>();
			for (const factionId of factionIds) map.set(factionId, CONFIG);
			return map as never;
		});

		let attempt = 0;
		const clientSpy = spyOn(TornApiClient.prototype, "get").mockImplementation(
			(async () => {
				attempt += 1;
				if (attempt === 1) throw new TornError(13, "Key disabled");
				return {
					chain: {
						current: 25,
						max: 100,
						timeout: 120,
						cooldown: 0,
						start: Math.floor(Date.now() / 1000) - 300,
						modifier: 1,
					},
				};
			}) as never,
		);

		try {
			await runChainMonitorCycle();

			expect(disabledSpy).toHaveBeenCalledWith("aaaaaaaaaaaaaaaa");
			expect(
				broadcasts.filter(
					(broadcast) => broadcast.action === "subversive_chain_alert",
				),
			).toHaveLength(0);
		} finally {
			configSpy.mockRestore();
			clientSpy.mockRestore();
			keySpy.mockRestore();
			successSpy.mockRestore();
			disabledSpy.mockRestore();
		}
	});
});
