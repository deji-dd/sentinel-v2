import {
	and,
	db,
	eq,
	gt,
	subversiveTargetFinderTargets,
	subversiveTargetFinderUsers,
} from "@sentinel/database";
import {
	type FFScouterGetTargetsOptions,
	getFFScouterTargets,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import { computeScoreFromEstimate } from "./target-utils";

const logger = new Logger("FFScouterTargetCrawler");

const CRAWL_PRESETS: FFScouterGetTargetsOptions[] = [
	{ preset: "respect", limit: 30, priority: "low" },
	{ preset: "level", limit: 30, priority: "low" },
	{ factionless: 1, limit: 30, inactiveonly: 1, priority: "low" },
	{ minlevel: 15, maxlevel: 50, inactiveonly: 1, limit: 30, priority: "low" },
	{ minlevel: 51, maxlevel: 100, inactiveonly: 1, limit: 30, priority: "low" },
];

let presetIndex = 0;
let lastIdleCrawlTimestamp = 0;
const IDLE_CADENCE_MS = 60_000; // 60s cadence when idle

/**
 * Crawls targets continuously from FFScouter get-targets endpoint.
 * - Always populates targets for future use (independent of enrolled user keys).
 * - Adapts cadence: runs every 15s when members are actively using Target Finder,
 *   or relaxes to every 60s during idle periods to preserve API calls.
 */
export async function crawlFFScouterTargets(): Promise<number> {
	if (!process.env.FF_SCOUTER_KEY) {
		logger.warn("FF_SCOUTER_KEY is not set. Crawler paused.");
		return 0;
	}

	const nowMs = Date.now();
	const fifteenMinutesAgo = new Date(nowMs - 15 * 60 * 1000);

	// Check if any member has interacted with the script in the last 15 minutes
	const [recentActiveUser] = await db
		.select({ tornId: subversiveTargetFinderUsers.tornId })
		.from(subversiveTargetFinderUsers)
		.where(
			and(
				eq(subversiveTargetFinderUsers.isActive, true),
				gt(subversiveTargetFinderUsers.lastSeenAt, fifteenMinutesAgo),
			),
		)
		.limit(1);

	const isUserActivelyUsing = !!recentActiveUser;

	// When idle, throttle crawl executions to once every 60s
	if (
		!isUserActivelyUsing &&
		nowMs - lastIdleCrawlTimestamp < IDLE_CADENCE_MS
	) {
		return 0;
	}
	lastIdleCrawlTimestamp = nowMs;

	const query = CRAWL_PRESETS[presetIndex % CRAWL_PRESETS.length] ?? {
		preset: "respect",
	};
	presetIndex = (presetIndex + 1) % CRAWL_PRESETS.length;

	try {
		const targets = await getFFScouterTargets(query);
		if (targets.length === 0) return 0;

		let insertedCount = 0;
		const now = new Date();

		for (const t of targets) {
			if (!t.player_id || t.player_id <= 0) continue;

			const estimatedScore = computeScoreFromEstimate(
				t.bs_estimate ?? null,
				t.distribution,
			);

			const isFactionless = !t.faction_id || t.faction_id === 0;
			const isInactive =
				query.inactiveonly === 1 ||
				query.preset === "respect" ||
				(t.last_action !== undefined && t.last_action !== null
					? Date.now() - new Date(t.last_action).getTime() > 14 * 86400000
					: false);

			await db
				.insert(subversiveTargetFinderTargets)
				.values({
					targetId: t.player_id,
					name: t.name ?? `Player ${t.player_id}`,
					level: t.level ?? 1,
					factionId: t.faction_id ?? null,
					factionName: t.faction_name ?? null,
					daysOld: 30, // Targets in FFScouter are established accounts
					isInactive,
					isFactionless,
					inHospital: false,
					hospitalUntil: null,
					estimatedBs: t.bs_estimate ?? 0,
					estimatedScore,
					status: "okay",
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: subversiveTargetFinderTargets.targetId,
					set: {
						name: t.name ? t.name : undefined,
						level: t.level ? t.level : undefined,
						factionId: t.faction_id ?? null,
						factionName: t.faction_name ?? null,
						estimatedBs: t.bs_estimate ?? 0,
						estimatedScore,
						isInactive,
						isFactionless,
						updatedAt: now,
					},
				});

			insertedCount++;
		}

		logger.info(
			`FFScouter crawler processed ${insertedCount} targets (preset: ${query.preset ?? "custom"}).`,
		);
		return insertedCount;
	} catch (error) {
		logger.error("FFScouter crawler error:", error);
		return 0;
	}
}

export const startSubversiveFFScouterCrawlerWorker: WorkerStarter = (options?: {
	initialDelayMs?: number;
}) => {
	startEventDrivenRunner({
		worker: "subversive:ffscouter_crawler_worker",
		defaultCadenceSeconds: 15, // 15s active loop, throttles to 60s when idle
		initialDelayMs: Math.max(options?.initialDelayMs ?? 0, 5000),
		handler: async () => {
			return await crawlFFScouterTargets();
		},
	});
};
