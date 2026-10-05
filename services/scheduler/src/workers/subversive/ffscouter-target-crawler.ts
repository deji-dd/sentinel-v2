import {
	and,
	db,
	eq,
	gt,
	sql,
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
const ACTIVE_CADENCE_MS = 15_000; // 15s cadence while members are using Target Finder
/** Slack added to the idle reschedule so the internal 60s throttle always opens. */
const IDLE_THROTTLE_MARGIN_MS = 5_000;

/**
 * Whether the most recent cycle saw a member actively using Target Finder.
 * Read by the runner wrapper to pick the next cadence; never part of the
 * crawl's own return value, which callers and tests treat as a row count.
 */
let isCrawlerInActiveMode = false;

/**
 * Crawls targets continuously from FFScouter get-targets endpoint.
 * - Always populates targets for future use (independent of enrolled user keys).
 * - Adapts cadence: runs every 15s when members are actively using Target Finder,
 *   or relaxes to every 60s during idle periods to preserve API calls.
 */
export async function crawlFFScouterTargets(): Promise<number> {
	if (!process.env.FF_SCOUTER_KEY) {
		logger.warn("FF_SCOUTER_KEY is not set. Crawler paused.");
		isCrawlerInActiveMode = false;
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
	isCrawlerInActiveMode = isUserActivelyUsing;

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

		const now = new Date();
		const rows: (typeof subversiveTargetFinderTargets.$inferInsert)[] = [];

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

			rows.push({
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
			});
		}

		const insertedCount = rows.length;

		// Single multi-row upsert instead of one awaited round trip per target.
		if (rows.length > 0) {
			await db
				.insert(subversiveTargetFinderTargets)
				.values(rows)
				.onConflictDoUpdate({
					target: subversiveTargetFinderTargets.targetId,
					set: {
						name: sql`excluded.name`,
						level: sql`excluded.level`,
						factionId: sql`excluded.faction_id`,
						factionName: sql`excluded.faction_name`,
						estimatedBs: sql`excluded.estimated_bs`,
						estimatedScore: sql`excluded.estimated_score`,
						isInactive: sql`excluded.is_inactive`,
						isFactionless: sql`excluded.is_factionless`,
						updatedAt: sql`excluded.updated_at`,
					},
				});
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
		defaultCadenceSeconds: ACTIVE_CADENCE_MS / 1000, // 15s active loop, 60s when idle
		initialDelayMs: Math.max(options?.initialDelayMs ?? 0, 5000),
		// The handler's return value must never be the crawl's row count: the
		// runner treats any numeric result as an absolute epoch-ms next-run time,
		// so returning `insertedCount` (0-30) rescheduled this worker ~immediately
		// and turned it into an unthrottled busy loop. Return an explicit cadence
		// derived from the activity signal the crawler just evaluated.
		handler: async () => {
			await crawlFFScouterTargets();
			// The idle delay runs slightly past the crawler's own idle throttle so
			// the throttle can never suppress the crawl and push it to the cycle
			// after next (which would halve the real idle crawl rate).
			return (
				Date.now() +
				(isCrawlerInActiveMode
					? ACTIVE_CADENCE_MS
					: IDLE_CADENCE_MS + IDLE_THROTTLE_MARGIN_MS)
			);
		},
	});
};
