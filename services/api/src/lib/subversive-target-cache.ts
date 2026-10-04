import {
	and,
	db,
	eq,
	gt,
	subversiveTargetFinderTargets,
	subversiveTargetFinderUsers,
} from "@sentinel/database";
import { getPlayerStats } from "@sentinel/torn-api";
import {
	getSubversiveFactionName,
	Logger,
	PRIMARY_SUBVERSIVE_FACTION_ID,
	resolveSubversiveFactionId,
} from "@sentinel/utils";

const logger = new Logger("SubversiveTargetCache");

/**
 * Grace period before an unrefreshed retal set is discarded. The scheduler
 * broadcasts every 10s, so this is generous: its only job is to stop badges
 * sticking forever if the tracker dies mid-war.
 */
const RETAL_TTL_MS = 45_000;

export function createEmptyWarInfo(): CurrentWarInfo {
	return {
		state: "no_war",
		warId: null,
		start: null,
		target: null,
		winner: null,
		opponent: null,
		subversive: null,
		lastUpdated: 0,
	};
}

export interface CachedTarget {
	targetId: number;
	name: string;
	level: number;
	factionId: number | null;
	factionName: string | null;
	daysOld: number;
	lastAction: number | null;
	isInactive: boolean;
	isFactionless: boolean;
	inHospital: boolean;
	hospitalUntil?: number | null;
	estimatedBs: number;
	estimatedScore: number;
}

export interface CachedUserSession {
	tornId: number;
	tornName: string;
	/** Family faction the session belongs to (2013 / 27312). */
	factionId?: number;
	factionName?: string | null;
	bsScore: number;
	token: string;
	isActive: boolean;
	expiresAt: number;
	statsCachedAt: number;
	apiKeyEncrypted?: string;
}

export interface TargetQueryOptions {
	attackerScore: number;
	minFF: number;
	maxFF: number;
	factionlessOnly?: boolean;
	inactiveOnly?: boolean;
	excludeIds?: Set<number>;
}

export interface MatchedTargetResult {
	id: number;
	name: string;
	level: number;
	factionId: number | null;
	factionName: string | null;
	isFactionless: boolean;
	isInactive: boolean;
	estimatedBs: number;
	fairFight: number;
	attackUrl: string;
}

export type WarState = "no_war" | "scheduled" | "active";

export interface RankedWarOpponent {
	id: number;
	name: string;
	level: number;
	daysInFaction: number;
	position: string;
	isOnWall: boolean;
	isInOc: boolean;
	hasEarlyDischarge: boolean;
	lastAction: {
		status: string;
		timestamp: number;
		relative: string;
	};
	status: {
		description: string;
		details: string | null;
		state: string;
		color: string;
		until: number | null;
		planeImageType?: string;
	};
	estimatedBs: number;
	estimatedScore: number;
}

export interface CurrentWarInfo {
	state: WarState;
	warId: number | null;
	start: number | null;
	target: number | null;
	winner: number | null;
	opponent: {
		id: number;
		name: string;
		score: number;
		chain: number;
	} | null;
	subversive: {
		id: number;
		name: string;
		score: number;
		chain: number;
	} | null;
	lastUpdated: number;
}

/**
 * Ranked war context for a single family faction.
 */
export interface FactionWarSnapshot {
	war: CurrentWarInfo;
	opponents: RankedWarOpponent[];
}

class SubversiveTargetCache {
	private targets: CachedTarget[] = [];
	private targetMap: Map<number, CachedTarget> = new Map();
	private userSessions: Map<number, CachedUserSession> = new Map();
	private tokenToUserId: Map<string, number> = new Map();
	private reservedTargets: Map<number, number> = new Map();

	/** Ranked war state per family faction id (2013 / 27312). */
	private warByFaction: Map<number, CurrentWarInfo> = new Map();
	/** Opponent roster per family faction id. */
	private opponentsByFaction: Map<number, Map<number, RankedWarOpponent>> =
		new Map();
	/** Retal badge sets pushed by the scheduler, per family faction id. */
	private retalByFaction: Map<
		number,
		{ ids: Set<number>; updatedAtMs: number }
	> = new Map();
	/** Per-member ranked war hit counts, per family faction id. */
	private hitCountsByFaction: Map<
		number,
		{ warId: number; counts: Record<string, number> }
	> = new Map();

	/**
	 * Initializes the RAM target cache from the database (only non-hospitalized targets with known score).
	 */
	async initialize(): Promise<void> {
		try {
			await this.syncReadyPoolFromDb();

			// Pre-load active users into RAM
			const users = await db
				.select()
				.from(subversiveTargetFinderUsers)
				.where(eq(subversiveTargetFinderUsers.isActive, true));

			for (const u of users) {
				this.setUserSession({
					tornId: u.tornId,
					tornName: u.tornName,
					factionId: resolveSubversiveFactionId(u.factionId),
					factionName: u.factionName ?? getSubversiveFactionName(u.factionId),
					bsScore: u.bsScore,
					token: "", // Assigned on login
					isActive: u.isActive,
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
					statsCachedAt: u.statsCachedAt.getTime(),
				});
			}

			logger.info(
				`Subversive Target Cache initialized with ${this.targets.length} ready targets and ${this.userSessions.size} users.`,
			);
		} catch (error) {
			logger.error("Failed to initialize Subversive Target Cache:", error);
		}
	}

	/**
	 * Syncs the in-memory ready pool from the database.
	 * Only loads targets that are NOT in hospital and have an estimatedScore > 0.
	 */
	async syncReadyPoolFromDb(): Promise<number> {
		const rows = await db
			.select()
			.from(subversiveTargetFinderTargets)
			.where(
				and(
					eq(subversiveTargetFinderTargets.inHospital, false),
					gt(subversiveTargetFinderTargets.estimatedScore, 0),
				),
			);

		const newTargets: CachedTarget[] = rows.map((r) => ({
			targetId: r.targetId,
			name: r.name,
			level: r.level,
			factionId: r.factionId ?? null,
			factionName: r.factionName ?? null,
			daysOld: r.daysOld,
			lastAction: r.lastAction ? r.lastAction.getTime() : null,
			isInactive: r.isInactive,
			isFactionless: r.isFactionless,
			inHospital: false,
			hospitalUntil: r.hospitalUntil ? r.hospitalUntil.getTime() : null,
			estimatedBs: r.estimatedBs,
			estimatedScore: r.estimatedScore,
		}));

		this.loadTargets(newTargets);
		return newTargets.length;
	}

	/**
	 * Loads and sorts targets in ascending order of estimatedScore.
	 */
	loadTargets(newTargets: CachedTarget[]): void {
		newTargets.sort((a, b) => a.estimatedScore - b.estimatedScore);
		this.targets = newTargets;
		this.targetMap.clear();
		for (const t of newTargets) {
			this.targetMap.set(t.targetId, t);
		}
	}

	/**
	 * Evicts a target immediately from the RAM ready pool.
	 */
	evict(targetId: number): boolean {
		const had = this.targetMap.delete(targetId);
		if (had) {
			const idx = this.targets.findIndex((t) => t.targetId === targetId);
			if (idx !== -1) {
				this.targets.splice(idx, 1);
			}
			return true;
		}
		return false;
	}

	/**
	 * Adds or updates a target in the ready pool.
	 * If in hospital or score <= 0, ensures evicted.
	 */
	addOrUpdate(target: CachedTarget): void {
		if (target.inHospital || target.estimatedScore <= 0) {
			this.evict(target.targetId);
			return;
		}
		this.evict(target.targetId);
		this.targetMap.set(target.targetId, target);
		this.insertSorted(target);
	}

	/**
	 * Marks a target as in hospital with an expiration timestamp and evicts from ready pool.
	 */
	markHospital(targetId: number, hospitalUntilMs: number): void {
		const existing = this.targetMap.get(targetId);
		if (existing) {
			existing.inHospital = true;
			existing.hospitalUntil = hospitalUntilMs;
		}
		this.evict(targetId);
	}

	/**
	 * Legacy/compat hospital status updater.
	 */
	setHospitalStatus(targetId: number, inHospital: boolean): void {
		if (inHospital) {
			this.evict(targetId);
		} else {
			const existing = this.targetMap.get(targetId);
			if (existing) {
				existing.inHospital = false;
				existing.hospitalUntil = null;
				this.addOrUpdate(existing);
			}
		}
	}

	/**
	 * Reserves a target for a duration in ms (default: 60,000 ms / 60 seconds).
	 */
	reserveTarget(targetId: number, durationMs = 60_000): void {
		this.reservedTargets.set(targetId, Date.now() + durationMs);
	}

	/**
	 * Checks if a target is currently reserved.
	 */
	isTargetReserved(targetId: number): boolean {
		const expiresAt = this.reservedTargets.get(targetId);
		if (!expiresAt) return false;
		if (Date.now() > expiresAt) {
			this.reservedTargets.delete(targetId);
			return false;
		}
		return true;
	}

	/**
	 * Releases a target reservation immediately.
	 */
	releaseReservation(targetId: number): void {
		this.reservedTargets.delete(targetId);
	}

	/**
	 * Retrieves candidate targets matching the requested FF range for on-demand verification bursts.
	 */
	getCandidatesForVerification(options: {
		attackerScore: number;
		minFF: number;
		maxFF: number;
		ignoreIds?: Set<number>;
		limit?: number;
	}): CachedTarget[] {
		const {
			attackerScore,
			minFF,
			maxFF,
			ignoreIds = new Set(),
			limit = 30,
		} = options;

		if (attackerScore <= 0 || this.targets.length === 0) {
			return [];
		}

		const clampedMinFF = Math.max(1.0, minFF);
		const clampedMaxFF = Math.min(3.0, maxFF);

		const minScore =
			clampedMinFF <= 1.0
				? 0
				: (((clampedMinFF - 1.0) * 3) / 8) * attackerScore;

		const maxScore =
			clampedMaxFF >= 3.0
				? Number.POSITIVE_INFINITY
				: (((clampedMaxFF - 1.0) * 3) / 8) * attackerScore;

		const startIndex = this.findLowerBound(minScore);
		const candidates: CachedTarget[] = [];
		const nowMs = Date.now();

		// Primary pass: exclude hospitalized, ignored, and temporarily reserved targets
		for (let i = startIndex; i < this.targets.length; i++) {
			const t = this.targets[i];
			if (!t) break;
			if (
				maxScore !== Number.POSITIVE_INFINITY &&
				t.estimatedScore > maxScore
			) {
				break;
			}
			if (t.inHospital || (t.hospitalUntil && t.hospitalUntil > nowMs)) {
				continue;
			}
			if (this.isTargetReserved(t.targetId)) {
				continue;
			}
			if (ignoreIds.has(t.targetId)) {
				continue;
			}
			candidates.push(t);
			if (candidates.length >= limit * 2) {
				break;
			}
		}

		// Fallback pass: if all matching targets in this bracket were reserved, allow soft-reserved
		if (candidates.length === 0) {
			for (let i = startIndex; i < this.targets.length; i++) {
				const t = this.targets[i];
				if (!t) break;
				if (
					maxScore !== Number.POSITIVE_INFINITY &&
					t.estimatedScore > maxScore
				) {
					break;
				}
				if (t.inHospital || (t.hospitalUntil && t.hospitalUntil > nowMs)) {
					continue;
				}
				if (ignoreIds.has(t.targetId)) {
					continue;
				}
				candidates.push(t);
				if (candidates.length >= limit * 2) {
					break;
				}
			}
		}

		// Shuffle candidates to distribute verification across different targets
		for (let i = candidates.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const temp = candidates[i];
			const randItem = candidates[j];
			if (temp && randItem) {
				candidates[i] = randItem;
				candidates[j] = temp;
			}
		}

		return candidates.slice(0, limit);
	}

	/**
	 * Inserts a target in sorted order by estimatedScore.
	 */
	insertSorted(target: CachedTarget): void {
		let low = 0;
		let high = this.targets.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			const midItem = this.targets[mid];
			if (midItem && midItem.estimatedScore < target.estimatedScore) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}
		this.targets.splice(low, 0, target);
	}

	/**
	 * Binary search to find the lower bound index for a target score.
	 */
	private findLowerBound(score: number): number {
		let low = 0;
		let high = this.targets.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			const midItem = this.targets[mid];
			if (midItem && midItem.estimatedScore < score) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}
		return low;
	}

	/**
	 * Finds the next suitable target matching the requested FF range and filters.
	 */
	findNextTarget(options: TargetQueryOptions): MatchedTargetResult | null {
		const {
			attackerScore,
			minFF,
			maxFF,
			factionlessOnly = false,
			inactiveOnly = false,
			excludeIds = new Set(),
		} = options;

		if (attackerScore <= 0 || this.targets.length === 0) {
			return null;
		}

		// Calculate the required target score bounds based on JTS formula:
		// FF = 1 + (8/3) * (Score_def / Score_att)
		// Score_def = ((FF - 1) * 3 / 8) * Score_att
		const clampedMinFF = Math.max(1.0, minFF);
		const clampedMaxFF = Math.min(3.0, maxFF);

		const minScore =
			clampedMinFF <= 1.0
				? 0
				: (((clampedMinFF - 1.0) * 3) / 8) * attackerScore;

		const maxScore =
			clampedMaxFF >= 3.0
				? Number.POSITIVE_INFINITY
				: (((clampedMaxFF - 1.0) * 3) / 8) * attackerScore;

		// Binary search to find the start index in RAM
		const startIndex = this.findLowerBound(minScore);
		const candidates: CachedTarget[] = [];

		for (let i = startIndex; i < this.targets.length; i += 1) {
			const t = this.targets[i];
			if (!t) break;

			// If we passed the upper score bound (and maxFF < 3.0), we can stop
			if (
				maxScore !== Number.POSITIVE_INFINITY &&
				t.estimatedScore > maxScore
			) {
				break;
			}

			// If target is in hospital, skip
			if (t.inHospital) continue;

			// If target was recently excluded/skipped, skip
			if (excludeIds.has(t.targetId)) continue;

			// Apply optional filters
			if (factionlessOnly && !t.isFactionless) continue;
			if (inactiveOnly && !t.isInactive) continue;

			candidates.push(t);
			if (candidates.length >= 50) {
				break; // Ample sample pool to randomize from
			}
		}

		if (candidates.length === 0) {
			return null;
		}

		// Random selection from the matching candidates pool to distribute attacks
		const randomIndex = Math.floor(Math.random() * candidates.length);
		const picked = candidates[randomIndex];
		if (!picked) return null;

		// Instant eviction from ready pool upon dispatch
		this.evict(picked.targetId);

		// Calculate exact FF for this target relative to this attacker (unclamped)
		const rawFF = 1 + (8 / 3) * (picked.estimatedScore / attackerScore);
		const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));

		return {
			id: picked.targetId,
			name: picked.name,
			level: picked.level,
			factionId: picked.factionId,
			factionName: picked.factionName,
			isFactionless: picked.isFactionless,
			isInactive: picked.isInactive,
			estimatedBs: picked.estimatedBs,
			fairFight: calculatedFF,
			attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${picked.targetId}`,
		};
	}

	// ─── User Session Cache ──────────────────────────────────────────────────

	setUserSession(session: CachedUserSession): void {
		this.userSessions.set(session.tornId, session);
		if (session.token) {
			this.tokenToUserId.set(session.token, session.tornId);
		}
	}

	getUserSession(tornId: number): CachedUserSession | undefined {
		return this.userSessions.get(tornId);
	}

	getUserByToken(token: string): CachedUserSession | undefined {
		const tornId = this.tokenToUserId.get(token);
		if (!tornId) return undefined;
		return this.userSessions.get(tornId);
	}

	revokeUser(tornId: number): void {
		const session = this.userSessions.get(tornId);
		if (session) {
			if (session.token) {
				this.tokenToUserId.delete(session.token);
			}
			session.isActive = false;
		}
	}

	getTotalTargetsCount(): number {
		return this.targets.length;
	}

	// ─── Ranked War Methods (per family faction) ──────────────────────────────

	private normalizeFaction(factionId?: number | null): number {
		return resolveSubversiveFactionId(factionId);
	}

	private warFor(factionId?: number | null): CurrentWarInfo {
		return (
			this.warByFaction.get(this.normalizeFaction(factionId)) ??
			createEmptyWarInfo()
		);
	}

	private opponentsFor(
		factionId?: number | null,
	): Map<number, RankedWarOpponent> {
		const key = this.normalizeFaction(factionId);
		let map = this.opponentsByFaction.get(key);
		if (!map) {
			map = new Map();
			this.opponentsByFaction.set(key, map);
		}
		return map;
	}

	private isWarEngaged(factionId?: number | null): boolean {
		const war = this.warFor(factionId);
		return war.state === "active" || war.state === "scheduled";
	}

	/**
	 * Applies a payload of per-faction war snapshots broadcast by the scheduler.
	 * Accepts either the new `wars` map (keyed by faction id) or the legacy
	 * single-war payload (treated as the primary faction).
	 */
	applyWarUpdate(payload: {
		wars?: Record<string, FactionWarSnapshot>;
		war?: CurrentWarInfo;
		opponents?: RankedWarOpponent[];
	}): void {
		if (payload.wars && typeof payload.wars === "object") {
			for (const [rawFactionId, snapshot] of Object.entries(payload.wars)) {
				const factionId = this.normalizeFaction(Number(rawFactionId));
				if (!snapshot) continue;
				this.setWarState(snapshot.war ?? createEmptyWarInfo(), factionId);
				this.setWarOpponents(snapshot.opponents ?? [], factionId);
			}
			return;
		}

		if (payload.war) {
			this.setWarState(payload.war, PRIMARY_SUBVERSIVE_FACTION_ID);
			this.setWarOpponents(
				payload.opponents ?? [],
				PRIMARY_SUBVERSIVE_FACTION_ID,
			);
		}
	}

	setWarState(info: CurrentWarInfo, factionId?: number): void {
		const key = this.normalizeFaction(factionId ?? info.subversive?.id);
		this.warByFaction.set(key, info);
		if (info.state === "no_war") {
			this.opponentsByFaction.set(key, new Map());
			// Retal and hit counts are meaningless outside a war; drop them so
			// stale state cannot survive into the next engagement.
			this.retalByFaction.delete(key);
			this.hitCountsByFaction.delete(key);
		}
	}

	// ─── Retal (retaliation) Tracking ───────────────────────────────────────

	/**
	 * Applies a retal set pushed by the scheduler. An empty set is meaningful:
	 * it clears the badges the previous broadcast applied.
	 */
	applyRetalUpdate(
		factionId: number,
		retalIds: number[],
		updatedAtMs?: number,
	): void {
		const key = this.normalizeFaction(factionId);
		this.retalByFaction.set(key, {
			ids: new Set(retalIds),
			updatedAtMs: updatedAtMs ?? Date.now(),
		});
	}

	/**
	 * Returns the currently badged opponent ids for a faction.
	 *
	 * Entries expire lazily on read: if the scheduler stops broadcasting (crash,
	 * disabled worker) the badges fade on their own instead of sticking forever.
	 */
	getRetalIds(factionId?: number, ttlMs: number = RETAL_TTL_MS): number[] {
		const key = this.normalizeFaction(factionId);
		const entry = this.retalByFaction.get(key);
		if (!entry) return [];

		if (Date.now() - entry.updatedAtMs > ttlMs) {
			this.retalByFaction.delete(key);
			return [];
		}

		return Array.from(entry.ids);
	}

	isRetalTarget(targetId: number, factionId?: number): boolean {
		const key = this.normalizeFaction(factionId);
		const entry = this.retalByFaction.get(key);
		if (!entry) return false;
		if (Date.now() - entry.updatedAtMs > RETAL_TTL_MS) {
			this.retalByFaction.delete(key);
			return false;
		}
		return entry.ids.has(targetId);
	}

	// ─── Ranked War Hit Counts ───────────────────────────────────────────────

	/**
	 * Applies per-member ranked war hit counts pushed by the scheduler. Counts
	 * are cumulative for one war, so there is no TTL: they are replaced wholesale
	 * on each push and cleared when the war ends.
	 */
	applyHitCounts(
		factionId: number,
		warId: number | null,
		counts: Record<string, number>,
	): void {
		const key = this.normalizeFaction(factionId);
		if (warId === null) {
			this.hitCountsByFaction.delete(key);
			return;
		}
		this.hitCountsByFaction.set(key, { warId, counts });
	}

	/**
	 * Resolves how many landed ranked war hits a member has made this war.
	 * Returns 0 when the faction has no engaged war or the member has not hit.
	 */
	getUserHitCount(tornId?: number, factionId?: number): number {
		if (typeof tornId !== "number" || tornId <= 0) return 0;
		const key = this.normalizeFaction(factionId);
		const entry = this.hitCountsByFaction.get(key);
		if (!entry) return 0;
		return entry.counts[String(tornId)] ?? 0;
	}

	/**
	 * Diagnostics: whether any hit counts have been received for a faction at all.
	 * Distinguishes "the scheduler never pushed" from "pushed, but this member is
	 * genuinely at zero".
	 */
	hasHitCounts(factionId?: number): boolean {
		return this.hitCountsByFaction.has(this.normalizeFaction(factionId));
	}

	getWarState(factionId?: number): CurrentWarInfo {
		return this.warFor(factionId);
	}

	setWarOpponents(opponents: RankedWarOpponent[], factionId?: number): void {
		const key = this.normalizeFaction(factionId);
		const map = new Map<number, RankedWarOpponent>();
		for (const opp of opponents) {
			map.set(opp.id, opp);
		}
		this.opponentsByFaction.set(key, map);
	}

	getWarOpponents(factionId?: number): RankedWarOpponent[] {
		return Array.from(this.opponentsFor(factionId).values());
	}

	getWarOpponent(
		targetId: number,
		factionId?: number,
	): RankedWarOpponent | undefined {
		if (!this.isWarEngaged(factionId)) return undefined;
		return this.opponentsFor(factionId).get(targetId);
	}

	isWarOpponent(targetId: number, factionId?: number): boolean {
		return (
			this.isWarEngaged(factionId) && this.opponentsFor(factionId).has(targetId)
		);
	}

	getWarOpponentIds(factionId?: number): number[] {
		if (!this.isWarEngaged(factionId)) return [];
		return Array.from(this.opponentsFor(factionId).keys());
	}

	getNextWarTarget(options: {
		attackerBsScore: number;
		factionId?: number;
		excludeIds?: Set<number>;
		minFF?: number;
		maxFF?: number;
		maxOnlineFF?: number;
		maxBS?: number;
	}):
		| (RankedWarOpponent & {
				fairFight: number;
				attackUrl: string;
				statusCategory: "ready" | "early_discharge" | "hosp_exit";
				isHighFF: boolean;
				isOnline: boolean;
				warning?: string;
		  })
		| null {
		const {
			attackerBsScore,
			excludeIds = new Set(),
			minFF = 2.5,
			maxFF = 3.0,
			maxOnlineFF = Math.max(3.5, (options.maxFF ?? 3.0) + 0.5),
			maxBS,
		} = options;

		if (!this.isWarEngaged(options.factionId)) {
			return null;
		}

		const nowSec = Math.floor(Date.now() / 1000);
		const opponents = Array.from(this.opponentsFor(options.factionId).values());

		// Unattackable states: Traveling, Abroad, Federal, Fallen, Jail
		const attackable = opponents.filter((opp) => {
			if (excludeIds.has(opp.id)) return false;
			if (maxBS !== undefined && opp.estimatedBs > maxBS) return false;
			const state = opp.status.state?.toLowerCase() ?? "";
			if (
				state === "traveling" ||
				state === "abroad" ||
				state === "federal" ||
				state === "fallen" ||
				state === "jail"
			) {
				return false;
			}
			return true;
		});

		// Calculate FF and online status for each attackable opponent
		const scored = attackable.map((opp) => {
			const rawFF =
				attackerBsScore > 0 && opp.estimatedScore > 0
					? 1 + (8 / 3) * (opp.estimatedScore / attackerBsScore)
					: 1.0;
			const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
			const isOnline = opp.lastAction.status?.toLowerCase() === "online";
			return {
				...opp,
				fairFight: calculatedFF,
				isOnline,
			};
		});

		// Helper to pick best candidate from a list according to priorities:
		// 1. Online (within acceptable maxOnlineFF limit)
		// 2. High FF sweet-spot [minFF, maxFF]
		// 3. Lower FF (< minFF), sorted highest to lowest
		// 4. High FF / Outmatched (> maxFF), sorted lowest to highest with warning
		const pickCandidate = (
			pool: typeof scored,
		): {
			candidate: (typeof scored)[number];
			isHighFF: boolean;
			warning?: string;
		} | null => {
			if (pool.length === 0) return null;

			// 1. Online with reasonable FF limit
			const onlineCandidates = pool.filter(
				(c) => c.isOnline && c.fairFight <= maxOnlineFF,
			);
			if (onlineCandidates.length > 0) {
				onlineCandidates.sort((a, b) => b.fairFight - a.fairFight);
				const picked = onlineCandidates[0];
				if (picked) {
					return { candidate: picked, isHighFF: false };
				}
			}

			// 2. Preferred FF range [minFF, maxFF]
			const sweetSpot = pool.filter(
				(c) => c.fairFight >= minFF && c.fairFight <= maxFF,
			);
			if (sweetSpot.length > 0) {
				sweetSpot.sort((a, b) => b.fairFight - a.fairFight);
				const picked = sweetSpot[0];
				if (picked) {
					return { candidate: picked, isHighFF: false };
				}
			}

			// 3. Lower safe FF (< minFF), sorted descending (prefer 2.4x over 1.07x)
			const lowerSafe = pool.filter((c) => c.fairFight < minFF);
			if (lowerSafe.length > 0) {
				lowerSafe.sort((a, b) => b.fairFight - a.fairFight);
				const picked = lowerSafe[0];
				if (picked) {
					return { candidate: picked, isHighFF: false };
				}
			}

			// 4. High FF outmatched (> maxFF)
			const highFF = pool.filter((c) => c.fairFight > maxFF);
			if (highFF.length > 0) {
				highFF.sort((a, b) => a.fairFight - b.fairFight);
				const picked = highFF[0];
				if (picked) {
					return {
						candidate: picked,
						isHighFF: true,
						warning: `High FF Warning: Target is significantly stronger (${picked.fairFight.toFixed(2)}x FF). No closer targets available.`,
					};
				}
			}

			const fallback = pool[0];
			return fallback
				? { candidate: fallback, isHighFF: fallback.fairFight > maxFF }
				: null;
		};

		// 1. Ready right now: status.state === "Okay"
		const readyList = scored.filter((opp) => {
			const state = opp.status.state?.toLowerCase() ?? "";
			return state === "okay";
		});

		// 2. Hospital exiting in <= 30 seconds
		const hospExitSoonList = scored
			.filter((opp) => {
				const state = opp.status.state?.toLowerCase() ?? "";
				if (state !== "hospital") return false;
				const until = opp.status.until;
				if (!until) return false;
				const remaining = until - nowSec;
				return remaining > 0 && remaining <= 30;
			})
			.sort((a, b) => (a.status.until ?? 0) - (b.status.until ?? 0));

		let selectedResult: ReturnType<typeof pickCandidate> = null;
		let statusCategory: "ready" | "early_discharge" | "hosp_exit" = "ready";

		if (readyList.length > 0) {
			selectedResult = pickCandidate(readyList);
			statusCategory = "ready";
		} else if (hospExitSoonList.length > 0) {
			selectedResult = pickCandidate(hospExitSoonList);
			statusCategory = "hosp_exit";
		}

		if (!selectedResult) return null;
		const { candidate, isHighFF, warning } = selectedResult;

		return {
			...candidate,
			fairFight: candidate.fairFight,
			isHighFF,
			isOnline: candidate.isOnline,
			warning,
			attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${candidate.id}`,
			statusCategory,
		};
	}

	getHospitalQueue(
		options:
			| number
			| { limit?: number; attackerBsScore?: number; factionId?: number } = 15,
	): (RankedWarOpponent & {
		secondsRemaining: number;
		fairFight: number;
		hasRetal: boolean;
	})[] {
		const factionId =
			typeof options === "object"
				? (options.factionId ?? undefined)
				: undefined;

		if (!this.isWarEngaged(factionId)) {
			return [];
		}

		const limit = typeof options === "number" ? options : (options.limit ?? 15);
		const attackerBsScore =
			typeof options === "object" ? (options.attackerBsScore ?? 0) : 0;
		const nowSec = Math.floor(Date.now() / 1000);
		const retalIds = new Set(this.getRetalIds(factionId));
		return Array.from(this.opponentsFor(factionId).values())
			.filter((opp) => {
				const state = opp.status.state?.toLowerCase() ?? "";
				return (
					state === "hospital" &&
					((opp.status.until !== null && opp.status.until > nowSec) ||
						opp.hasEarlyDischarge)
				);
			})
			.map((opp) => {
				const rawFF =
					attackerBsScore > 0 && opp.estimatedScore > 0
						? 1 + (8 / 3) * (opp.estimatedScore / attackerBsScore)
						: 1.0;
				const fairFight = Math.max(1.0, Number(rawFF.toFixed(2)));
				return {
					...opp,
					secondsRemaining: Math.max(0, (opp.status.until ?? nowSec) - nowSec),
					fairFight,
					hasRetal: retalIds.has(opp.id),
				};
			})
			.sort((a, b) => a.secondsRemaining - b.secondsRemaining)
			.slice(0, limit);
	}

	getAvailableWarTargets(options: {
		attackerBsScore: number;
		factionId?: number;
		excludeIds?: Set<number>;
	}): Array<
		RankedWarOpponent & {
			fairFight: number;
			isOnline: boolean;
			isHighFF: boolean;
			statusCategory: "ready" | "early_discharge";
			hasRetal: boolean;
			attackUrl: string;
		}
	> {
		if (!this.isWarEngaged(options.factionId)) {
			return [];
		}

		const { attackerBsScore, excludeIds = new Set() } = options;
		const opponents = Array.from(this.opponentsFor(options.factionId).values());
		const retalIds = new Set(this.getRetalIds(options.factionId));

		const attackable = opponents.filter((opp) => {
			if (excludeIds.has(opp.id)) return false;
			const state = opp.status.state?.toLowerCase() ?? "";
			if (
				state === "traveling" ||
				state === "abroad" ||
				state === "federal" ||
				state === "fallen" ||
				state === "jail"
			) {
				return false;
			}
			return state === "okay";
		});

		return attackable.map((opp) => {
			const rawFF =
				attackerBsScore > 0 && opp.estimatedScore > 0
					? 1 + (8 / 3) * (opp.estimatedScore / attackerBsScore)
					: 1.0;
			const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
			const isOnline = opp.lastAction.status?.toLowerCase() === "online";
			const statusCategory: "ready" | "early_discharge" = "ready";

			return {
				...opp,
				fairFight: calculatedFF,
				isOnline,
				isHighFF: calculatedFF > 3.0,
				statusCategory,
				hasRetal: retalIds.has(opp.id),
				attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${opp.id}`,
			};
		});
	}

	getReadyTargets(options: {
		attackerBsScore: number;
		excludeIds?: Set<number>;
		limit?: number;
	}): Array<
		RankedWarOpponent & {
			fairFight: number;
			isOnline: boolean;
			isHighFF: boolean;
			statusCategory: "ready" | "early_discharge";
			attackUrl: string;
		}
	> {
		const { attackerBsScore, excludeIds = new Set(), limit = 30 } = options;
		return this.targets
			.filter((t) => !excludeIds.has(t.targetId) && !t.inHospital)
			.slice(0, limit)
			.map((t) => {
				const rawFF =
					attackerBsScore > 0 && t.estimatedScore > 0
						? 1 + (8 / 3) * (t.estimatedScore / attackerBsScore)
						: 1.0;
				const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
				return {
					id: t.targetId,
					name: t.name,
					level: t.level,
					daysInFaction: 0,
					position: "Member",
					isOnWall: false,
					isInOc: false,
					hasEarlyDischarge: false,
					lastAction: {
						status: t.isInactive ? "Offline" : "Online",
						timestamp: t.lastAction ?? 0,
						relative: "",
					},
					status: {
						description: "Okay",
						details: null,
						state: "okay",
						color: "green",
						until: null,
					},
					estimatedBs: t.estimatedBs,
					estimatedScore: t.estimatedScore,
					fairFight: calculatedFF,
					isOnline: !t.isInactive,
					isHighFF: calculatedFF > 3.0,
					statusCategory: "ready" as const,
					attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${t.targetId}`,
				};
			});
	}

	async getTargetOrOpponentDetails(
		targetId: number,
		attackerBsScore: number,
		factionId?: number,
	): Promise<{
		id: number;
		name: string;
		level: number;
		estimatedBs: number;
		fairFight: number;
		isHighFF: boolean;
		isOnline: boolean;
		status: {
			state: string;
			description: string;
			details: string | null;
			color: string;
			until: number | null;
		};
		attackUrl: string;
		isWarTarget: boolean;
	}> {
		const isWarActive = this.isWarEngaged(factionId);
		const opp = isWarActive
			? this.opponentsFor(factionId).get(targetId)
			: undefined;
		if (opp) {
			const rawFF =
				attackerBsScore > 0 && opp.estimatedScore > 0
					? 1 + (8 / 3) * (opp.estimatedScore / attackerBsScore)
					: 1.0;
			const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
			return {
				id: opp.id,
				name: opp.name,
				level: opp.level,
				estimatedBs: opp.estimatedBs,
				fairFight: calculatedFF,
				isHighFF: calculatedFF > 3.0,
				isOnline: opp.lastAction.status?.toLowerCase() === "online",
				status: opp.status,
				attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${opp.id}`,
				isWarTarget: true,
			};
		}

		const cached = this.targetMap.get(targetId);
		if (cached) {
			const rawFF =
				attackerBsScore > 0 && cached.estimatedScore > 0
					? 1 + (8 / 3) * (cached.estimatedScore / attackerBsScore)
					: 1.0;
			const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
			return {
				id: cached.targetId,
				name: cached.name,
				level: cached.level,
				estimatedBs: cached.estimatedBs,
				fairFight: calculatedFF,
				isHighFF: calculatedFF > 3.0,
				isOnline: !cached.isInactive,
				status: {
					state: "okay",
					description: "Okay",
					details: null,
					color: "green",
					until: null,
				},
				attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${cached.targetId}`,
				isWarTarget: false,
			};
		}

		try {
			const [dbRow] = await db
				.select()
				.from(subversiveTargetFinderTargets)
				.where(eq(subversiveTargetFinderTargets.targetId, targetId));

			if (dbRow && dbRow.estimatedScore > 0) {
				const rawFF =
					attackerBsScore > 0
						? 1 + (8 / 3) * (dbRow.estimatedScore / attackerBsScore)
						: 1.0;
				const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
				return {
					id: dbRow.targetId,
					name: dbRow.name,
					level: dbRow.level,
					estimatedBs: dbRow.estimatedBs,
					fairFight: calculatedFF,
					isHighFF: calculatedFF > 3.0,
					isOnline: !dbRow.isInactive,
					status: {
						state: dbRow.status,
						description: dbRow.status,
						details: null,
						color: "green",
						until: null,
					},
					attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${dbRow.targetId}`,
					isWarTarget: false,
				};
			}
		} catch {}

		try {
			const [ff] = await getPlayerStats([targetId]);
			if (ff?.bs_estimate && ff.bs_estimate > 0) {
				const score = 2 * Math.sqrt(ff.bs_estimate);
				const rawFF =
					attackerBsScore > 0 ? 1 + (8 / 3) * (score / attackerBsScore) : 1.0;
				const calculatedFF = Math.max(1.0, Number(rawFF.toFixed(2)));
				return {
					id: targetId,
					name: `Player ${targetId}`,
					level: 1,
					estimatedBs: ff.bs_estimate,
					fairFight: calculatedFF,
					isHighFF: calculatedFF > 3.0,
					isOnline: false,
					status: {
						state: "okay",
						description: "Okay",
						details: null,
						color: "green",
						until: null,
					},
					attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`,
					isWarTarget: false,
				};
			}
		} catch {}

		const approxBs = 50_000;
		const approxScore = 2 * Math.sqrt(approxBs);
		const rawFF =
			attackerBsScore > 0 ? 1 + (8 / 3) * (approxScore / attackerBsScore) : 1.0;
		return {
			id: targetId,
			name: `Player ${targetId}`,
			level: 1,
			estimatedBs: approxBs,
			fairFight: Math.max(1.0, Number(rawFF.toFixed(2))),
			isHighFF: false,
			isOnline: false,
			status: {
				state: "okay",
				description: "Okay",
				details: null,
				color: "green",
				until: null,
			},
			attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`,
			isWarTarget: false,
		};
	}
}

export const subversiveTargetCache = new SubversiveTargetCache();
