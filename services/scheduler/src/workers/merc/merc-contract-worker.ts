import {
	and,
	db,
	eq,
	getMercChannelConfig,
	getMercContractSummary,
	getMercContractTotalPayout,
	guildConfigs,
	inArray,
	type MercContract,
	mapRowToMercContract,
	mercContracts,
} from "@sentinel/database";
import type { FactionMember } from "@sentinel/schemas";
import {
	getPlayerStats,
	TornApiClient,
	TornError,
	tornApi,
} from "@sentinel/torn-api";
import { isInTornHospital, Logger } from "@sentinel/utils";
import { notifyBotAction } from "@sentinel/utils/ipc";
import type { MercHospitalRecord } from "../../lib/merc-state-store";
import { mercStateStore } from "../../lib/merc-state-store";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "../subversive/subversive-key-pool";

const logger = new Logger("Scheduler", "MercContractWorker");

export interface MercClaimant {
	discordId: string;
	discordTag: string;
	tornId?: number;
	tornName?: string;
}

export interface MercActiveTargetAlert {
	contractId: string;
	guildId: string;
	channelName: string;
	targetId: number;
	targetName: string;
	targetLevel: number;
	estimatedBs: number;
	status: "open" | "claimed";
	claimedBy?: MercClaimant;
	claimedAt?: number;
	messageId?: string;
	lastAlertAt: number;
	isStrickenEligible: boolean;
	hospitalUntil?: number | null;
	rwCooldownUntil?: number | null;
	wasInHospital?: boolean;
	hospitalExitTime?: number;
	lockStartedAt?: number;
}

export const OFFLINE_JITTER_SECONDS = 10;

/** Upper bound on cached BS estimates, evicted in insertion order. */
const MAX_STATS_CACHE_ENTRIES = 5_000;

/**
 * Explicit execution budget for the contract worker. The 1s cadence default floors
 * the timeout at only 5s, which a cold FFScouter BS-estimate burst or a Torn
 * rate-limit backoff blows through on a full faction roster.
 */
export const MERC_WORKER_TIMEOUT_MS = 25_000;

export class MercTargetManager {
	private alerts = new Map<string, MercActiveTargetAlert>();
	private statsCache = new Map<number, number>();
	private bsCacheMisses = 0;
	private bsFetchMs = 0;
	private hospitalTracker = new Map<string, MercHospitalRecord>();
	private offlineTracker = new Map<string, number>();
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	/** Whether the persisted state has been restored into this process yet. */
	private hydrated = false;

	/** How long state mutations are coalesced before being written. */
	private static readonly PERSIST_DEBOUNCE_MS = 3_000;

	private getAlertKey(contractId: string, targetId: number): string {
		return `${contractId}:${targetId}`;
	}

	getActiveAlerts(): MercActiveTargetAlert[] {
		return Array.from(this.alerts.values());
	}

	getAlert(
		contractId: string,
		targetId: number,
	): MercActiveTargetAlert | undefined {
		return this.alerts.get(this.getAlertKey(contractId, targetId));
	}

	/**
	 * Restores the state persisted by a previous process, once per process.
	 *
	 * Alerts, claims and the hospital-exit baselines the RW immunity is counted
	 * from all live in RAM, so a redeploy used to release every claim, lose the
	 * immunity lock of any target already out of hospital, and post duplicate
	 * alerts beside the orphaned originals.
	 *
	 * @param usableContractIds contracts that are still worth restoring. Alerts
	 * for anything else (completed, paused, deleted while we were down) are
	 * dropped and their Discord messages deleted, which is also the only cleanup
	 * those messages would otherwise never get.
	 * @returns how many alerts were restored
	 */
	async hydrateFromStore(usableContractIds: Set<string>): Promise<number> {
		if (this.hydrated) return this.alerts.size;
		this.hydrated = true;

		const snapshot = await mercStateStore.load();
		if (!snapshot) return 0;

		let restored = 0;
		let dropped = 0;

		for (const alert of snapshot.alerts) {
			if (!alert?.contractId || typeof alert.targetId !== "number") continue;

			if (!usableContractIds.has(alert.contractId)) {
				dropped++;
				if (alert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId: alert.guildId,
						channelName: alert.channelName,
						messageId: alert.messageId,
					});
				}
				continue;
			}

			this.alerts.set(
				this.getAlertKey(alert.contractId, alert.targetId),
				alert,
			);
			restored++;
		}

		for (const [key, record] of snapshot.hospitalTracker) {
			if (!usableContractIds.has(key.split(":")[0] ?? "")) continue;
			this.hospitalTracker.set(key, record);
		}

		for (const [key, seenAt] of snapshot.offlineTracker) {
			if (!usableContractIds.has(key.split(":")[0] ?? "")) continue;
			this.offlineTracker.set(key, seenAt);
		}

		if (restored > 0 || dropped > 0) {
			logger.info(
				`Restored ${restored} merc target alert(s) after restart (${dropped} dropped for contracts no longer running).`,
			);
		}
		// Write the pruned board back so dropped alerts cannot come back. Nothing
		// else changed: restoring is not itself a mutation to persist.
		if (dropped > 0) this.schedulePersist();

		return restored;
	}

	/**
	 * Queues a write of the live state, coalescing bursts.
	 *
	 * The state is written whole, so serialising it per tick would be wasted work;
	 * the store skips the write entirely when the payload is unchanged.
	 */
	schedulePersist(): void {
		if (this.persistTimer) return;

		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void mercStateStore.save({
				alerts: this.getActiveAlerts(),
				hospitalTracker: [...this.hospitalTracker.entries()],
				offlineTracker: [...this.offlineTracker.entries()],
			});
		}, MercTargetManager.PERSIST_DEBOUNCE_MS);

		// Never hold the process open just to flush state.
		(this.persistTimer as unknown as { unref?: () => void }).unref?.();
	}

	/** Awaits any queued write. Used by tests and by graceful shutdown. */
	async flushPersist(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
			await mercStateStore.save({
				alerts: this.getActiveAlerts(),
				hospitalTracker: [...this.hospitalTracker.entries()],
				offlineTracker: [...this.offlineTracker.entries()],
			});
		}
		await mercStateStore.flush();
	}

	recordMessageId(
		contractId: string,
		targetId: number,
		messageId: string,
		channelName: string,
	): void {
		const key = this.getAlertKey(contractId, targetId);
		const alert = this.alerts.get(key);
		if (alert) {
			alert.messageId = messageId;
			alert.channelName = channelName;
			// The message id is what lets the alert be edited or deleted instead of
			// being orphaned when this process goes away.
			this.schedulePersist();
		}
	}

	async claimTarget(
		contractId: string,
		targetId: number,
		claimant: MercClaimant,
		overrideNowMs?: number,
	): Promise<{
		success: boolean;
		reason?: string;
		alert?: MercActiveTargetAlert;
	}> {
		const key = this.getAlertKey(contractId, targetId);
		const alert = this.alerts.get(key);
		if (!alert) {
			return { success: false, reason: "Target alert not found or expired." };
		}

		if (alert.status === "claimed") {
			return {
				success: false,
				reason: `Target is already claimed by ${alert.claimedBy?.tornName ?? alert.claimedBy?.discordTag ?? "another mercenary"}.`,
			};
		}

		// Guard: Mercenaries can only have 1 active dibs at a time across all active targets
		for (const existingAlert of this.alerts.values()) {
			if (
				existingAlert !== alert &&
				existingAlert.status === "claimed" &&
				existingAlert.claimedBy
			) {
				const matchDiscord =
					claimant.discordId !== "" &&
					existingAlert.claimedBy.discordId === claimant.discordId;
				const matchTorn =
					claimant.tornId !== undefined &&
					existingAlert.claimedBy.tornId !== undefined &&
					existingAlert.claimedBy.tornId === claimant.tornId;

				if (matchDiscord || matchTorn) {
					return {
						success: false,
						reason: `You already have an active claim on ${existingAlert.targetName} [${existingAlert.targetId}]. There can only be 1 active dibs per merc.`,
					};
				}
			}
		}

		const nowMs = overrideNowMs ?? Date.now();
		const nowSec = Math.floor(nowMs / 1000);

		alert.status = "claimed";
		alert.claimedBy = claimant;
		alert.claimedAt = nowMs;

		const inHospital = Boolean(
			alert.hospitalUntil && alert.hospitalUntil > nowSec,
		);
		const inRwCooldown = Boolean(
			alert.rwCooldownUntil && alert.rwCooldownUntil > nowSec,
		);

		if (!inHospital && !inRwCooldown) {
			alert.lockStartedAt = nowMs;
		} else {
			alert.lockStartedAt = undefined;
		}

		if (alert.messageId) {
			void notifyBotAction("update_merc_target_alert", {
				guildId: alert.guildId,
				channelName: alert.channelName,
				messageId: alert.messageId,
				contractId: alert.contractId,
				target: {
					targetId: alert.targetId,
					targetName: alert.targetName,
					targetLevel: alert.targetLevel,
					estimatedBs: alert.estimatedBs,
					hospitalUntil: alert.hospitalUntil,
					status: "claimed",
					claimedBy: alert.claimedBy,
					claimedAt: alert.claimedAt,
					isStrickenEligible: alert.isStrickenEligible,
					rwCooldownUntil: alert.rwCooldownUntil,
				},
			});
		}

		this.schedulePersist();
		return { success: true, alert };
	}

	async releaseTarget(
		contractId: string,
		targetId: number,
		claimantDiscordId?: string,
	): Promise<{ success: boolean; reason?: string }> {
		const key = this.getAlertKey(contractId, targetId);
		const alert = this.alerts.get(key);
		if (!alert) {
			return { success: false, reason: "Target alert not found." };
		}

		if (alert.status !== "claimed") {
			return { success: false, reason: "Target is not claimed." };
		}

		if (claimantDiscordId && alert.claimedBy?.discordId !== claimantDiscordId) {
			return {
				success: false,
				reason: "You are not the mercenary who claimed this target.",
			};
		}

		alert.status = "open";
		alert.claimedBy = undefined;
		alert.claimedAt = undefined;
		alert.lockStartedAt = undefined;

		if (alert.messageId) {
			void notifyBotAction("update_merc_target_alert", {
				guildId: alert.guildId,
				channelName: alert.channelName,
				messageId: alert.messageId,
				contractId: alert.contractId,
				target: {
					targetId: alert.targetId,
					targetName: alert.targetName,
					targetLevel: alert.targetLevel,
					estimatedBs: alert.estimatedBs,
					hospitalUntil: alert.hospitalUntil,
					status: "open",
					isStrickenEligible: alert.isStrickenEligible,
					rwCooldownUntil: alert.rwCooldownUntil,
				},
			});
		}

		this.schedulePersist();
		return { success: true };
	}

	async downTarget(contractId: string, targetId: number): Promise<void> {
		const key = this.getAlertKey(contractId, targetId);
		const alert = this.alerts.get(key);
		if (!alert) return;

		if (alert.messageId) {
			void notifyBotAction("delete_merc_target_alert", {
				guildId: alert.guildId,
				channelName: alert.channelName,
				messageId: alert.messageId,
			});
		}

		this.alerts.delete(key);
		this.offlineTracker.delete(key);
		this.schedulePersist();
	}

	cleanContractTargets(contractId: string): void {
		for (const [key, alert] of this.alerts.entries()) {
			if (alert.contractId === contractId) {
				if (alert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId: alert.guildId,
						channelName: alert.channelName,
						messageId: alert.messageId,
					});
				}
				this.alerts.delete(key);
			}
		}
		for (const key of this.hospitalTracker.keys()) {
			if (key.startsWith(`${contractId}:`)) {
				this.hospitalTracker.delete(key);
			}
		}
		for (const key of this.offlineTracker.keys()) {
			if (key.startsWith(`${contractId}:`)) {
				this.offlineTracker.delete(key);
			}
		}

		// Per-contract tracker state that would otherwise be retained forever:
		// revivables signatures are keyed `${guildId}:${contractId}`, and the
		// auto-stop/perf-log stamps are keyed by contract id.
		const contractSuffix = `:${contractId}`;
		for (const key of revivablesUpdateTracker.keys()) {
			if (key.endsWith(contractSuffix)) {
				revivablesUpdateTracker.delete(key);
			}
		}
		autoStopCheckedAt.delete(contractId);
		perfLogAt.delete(contractId);
		this.schedulePersist();
	}

	/**
	 * Records a BS estimate, keeping the cache bounded.
	 *
	 * The cache is keyed by member id and shared across contracts, so it is not
	 * pruned per contract; instead it evicts in insertion order once it exceeds
	 * `MAX_STATS_CACHE_ENTRIES`. Estimates are approximate by nature, so dropping
	 * the oldest entry costs at most one extra batched FFScouter lookup.
	 */
	private setCachedBs(memberId: number, value: number): void {
		if (
			!this.statsCache.has(memberId) &&
			this.statsCache.size >= MAX_STATS_CACHE_ENTRIES
		) {
			const oldest = this.statsCache.keys().next().value;
			if (oldest !== undefined) this.statsCache.delete(oldest);
		}
		this.statsCache.set(memberId, value);
	}

	async resolveEstimatedBs(memberId: number, level: number): Promise<number> {
		const cached = this.statsCache.get(memberId);
		if (cached) return cached;

		this.bsCacheMisses++;
		const fetchStartedAt = Date.now();
		try {
			const [ffResult] = await getPlayerStats([memberId]);
			this.bsFetchMs += Date.now() - fetchStartedAt;
			if (ffResult?.bs_estimate && ffResult.bs_estimate > 0) {
				this.setCachedBs(memberId, ffResult.bs_estimate);
				return ffResult.bs_estimate;
			}
		} catch (err) {
			this.bsFetchMs += Date.now() - fetchStartedAt;
			logger.warn(
				`BS estimate lookup failed for member ${memberId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const approxBs = Math.max(10_000, level * 50_000);
		this.setCachedBs(memberId, approxBs);
		return approxBs;
	}

	/**
	 * Pre-warms the BS estimate cache for a whole roster in one batched upstream
	 * request, instead of each member paying its own sequential lookup inside
	 * `processMember`. Only uncached member IDs are sent upstream.
	 *
	 * @param members - Faction members to pre-warm for.
	 * @param signal - Abort signal to bail out before/while fetching.
	 */
	async prewarmEstimatedBs(
		members: FactionMember[],
		signal?: AbortSignal,
	): Promise<{ requested: number; resolved: number; fetchMs: number }> {
		const pending = Array.from(
			new Set(
				members.filter((m) => !this.statsCache.has(m.id)).map((m) => m.id),
			),
		);

		if (pending.length === 0) {
			return { requested: 0, resolved: 0, fetchMs: 0 };
		}

		if (signal?.aborted) {
			return { requested: pending.length, resolved: 0, fetchMs: 0 };
		}

		this.bsCacheMisses += pending.length;
		const fetchStartedAt = Date.now();

		let results: Awaited<ReturnType<typeof getPlayerStats>> = [];
		try {
			results = await getPlayerStats(pending);
		} catch (err) {
			this.bsFetchMs += Date.now() - fetchStartedAt;
			logger.warn(
				`Batched BS estimate pre-warm failed for ${pending.length} member(s): ${err instanceof Error ? err.message : String(err)}`,
			);
			return {
				requested: pending.length,
				resolved: 0,
				fetchMs: Date.now() - fetchStartedAt,
			};
		}

		this.bsFetchMs += Date.now() - fetchStartedAt;

		let resolved = 0;
		const levelById = new Map<number, number>();
		for (const m of members) {
			if (!levelById.has(m.id)) levelById.set(m.id, m.level);
		}

		for (const r of results) {
			const id = Number(r?.player_id);
			if (!Number.isInteger(id) || id <= 0) continue;
			if (r?.bs_estimate && r.bs_estimate > 0) {
				this.setCachedBs(id, r.bs_estimate);
				resolved++;
			} else {
				// Preserve the existing level-based fallback, cached so the
				// per-member path stays a pure cache hit afterwards.
				const level = levelById.get(id);
				if (level !== undefined) {
					this.setCachedBs(id, Math.max(10_000, level * 50_000));
				}
			}
		}

		return {
			requested: pending.length,
			resolved,
			fetchMs: Date.now() - fetchStartedAt,
		};
	}

	/** Diagnostic counters for the current cycle (BS estimation cache behaviour). */
	resetBsStats(): void {
		this.bsCacheMisses = 0;
		this.bsFetchMs = 0;
	}

	getBsStats(): { misses: number; fetchMs: number } {
		return { misses: this.bsCacheMisses, fetchMs: this.bsFetchMs };
	}

	async processMember(
		contract: MercContract,
		guildId: string,
		channelName: string,
		mercRoleId: string | null | undefined,
		m: FactionMember,
		nowSec: number,
		nowMs: number,
	): Promise<void> {
		const key = this.getAlertKey(contract.id, m.id);
		const existingAlert = this.alerts.get(key);

		// 0. Excluded Members check: completely skip and remove alert if member is excluded
		if (
			contract.excludedMembers &&
			contract.excludedMembers.length > 0 &&
			contract.excludedMembers.includes(m.id)
		) {
			if (existingAlert) {
				if (existingAlert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId,
						channelName,
						messageId: existingAlert.messageId,
					});
				}
				this.alerts.delete(key);
				this.offlineTracker.delete(key);
			}
			return;
		}

		// 0b. Revivable check: completely exclude targets who have is_revivable === true
		if (m.is_revivable) {
			if (existingAlert) {
				if (existingAlert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId,
						channelName,
						messageId: existingAlert.messageId,
					});
				}
				this.alerts.delete(key);
				this.offlineTracker.delete(key);
			}
			return;
		}

		// Determine effective terms (handling dynamic change upon war start)
		const effectiveTerms =
			contract.changeTermsOnWarStart &&
			contract.warStart &&
			nowSec >= contract.warStart &&
			contract.warStartTerms
				? contract.warStartTerms
				: contract.terms;

		// 1. Evaluate terms: level range
		const levelRange = effectiveTerms?.levelRange ?? [1, 100];
		const minLevel = levelRange[0] ?? 1;
		const maxLevel = levelRange[1] ?? 100;
		if (m.level < minLevel || m.level > maxLevel) {
			if (existingAlert) {
				if (existingAlert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId,
						channelName,
						messageId: existingAlert.messageId,
					});
				}
				this.alerts.delete(key);
			}
			return;
		}

		// 2. Evaluate terms: online / idle / offline status
		const statusState = m.last_action?.status ?? "Offline";
		const termsStatuses = effectiveTerms?.statuses ?? {
			online: true,
			idle: true,
			offline: false,
		};
		let isActivityAllowed = false;
		if (statusState === "Online") {
			this.offlineTracker.delete(key);
			if (termsStatuses.online) {
				isActivityAllowed = true;
			}
		} else if (statusState === "Idle") {
			this.offlineTracker.delete(key);
			if (termsStatuses.idle) {
				const idleMinutes = Math.max(
					0,
					Math.floor((nowSec - (m.last_action?.timestamp ?? nowSec)) / 60),
				);
				const minIdle = effectiveTerms?.idleDurationMinutes ?? 15;
				if (idleMinutes >= minIdle) {
					isActivityAllowed = true;
				}
			}
		} else if (statusState === "Offline") {
			if (termsStatuses.offline) {
				// How long the target has been offline. Torn's last_action timestamp is
				// the primary signal; when it is missing or zero we fall back to how
				// long we have continuously observed this member offline ourselves.
				const lastActionSec = m.last_action?.timestamp;
				const secondsSinceLastAction =
					lastActionSec && lastActionSec > 0
						? nowSec - lastActionSec
						: undefined;

				const firstSeenOffline = this.offlineTracker.get(key);
				if (firstSeenOffline === undefined) {
					this.offlineTracker.set(key, nowSec);
				}

				const trackedOfflineSec = nowSec - (firstSeenOffline ?? nowSec);

				const offlineMinutes = Math.floor(
					Math.max(0, secondsSinceLastAction ?? trackedOfflineSec) / 60,
				);

				// Optional contract term: minimum minutes offline. Unset (null) keeps
				// the historical behaviour of qualifying any offline target, so only
				// contracts that opt in are affected.
				const minOfflineMinutes =
					effectiveTerms?.offlineDurationMinutes ?? null;
				const meetsMinOffline =
					minOfflineMinutes === null || offlineMinutes >= minOfflineMinutes;

				if (meetsMinOffline) {
					if (existingAlert) {
						// Once legitimate offline alert is already posted, keep it active
						isActivityAllowed = true;
					} else {
						// Jitter buffer for offline status:
						// Players' status can momentarily flicker to Offline for 1-3 seconds due to socket reconnects or page refreshes.
						// Enforce a 10-second stability window before considering them genuinely offline.

						// If last_action was within the last 10 seconds, they were just active (flicker)
						const isRecentActionFlicker =
							secondsSinceLastAction !== undefined &&
							secondsSinceLastAction < OFFLINE_JITTER_SECONDS;

						const isEstablishedOffline =
							(secondsSinceLastAction !== undefined &&
								secondsSinceLastAction >= OFFLINE_JITTER_SECONDS) ||
							trackedOfflineSec >= OFFLINE_JITTER_SECONDS;

						if (!isRecentActionFlicker && isEstablishedOffline) {
							isActivityAllowed = true;
						}
					}
				}
			}
		}

		if (!isActivityAllowed) {
			if (existingAlert) {
				if (existingAlert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId,
						channelName,
						messageId: existingAlert.messageId,
					});
				}
				this.alerts.delete(key);
			}
			return;
		}

		// 3. Hospital and target state handling
		const targetState = m.status?.state ?? "Okay";
		const hospUntil = m.status?.until ?? null;
		const secondsInHosp =
			hospUntil && hospUntil > nowSec ? hospUntil - nowSec : 0;

		/**
		 * A hospital stay in Torn, i.e. one the mercenary can act on the moment it
		 * ends. Torn reports a member hospitalised abroad with the same Hospital
		 * state ("In a Japanese hospital for 24 mins"), and a contract cannot be
		 * fulfilled by flying out to them, so that stay must not raise a
		 * hospital-exit alert. The tracker below still records it: the RW hit
		 * immunity that follows a hospital exit is what the 60-second cooldown
		 * models, and that applies wherever the bed was.
		 */
		const inTornHospital = isInTornHospital(m.status);

		/**
		 * Torn's member list is a snapshot, so a member who left hospital between the
		 * fetch and this tick still reads `Hospital` with a timer that has already
		 * elapsed. That is a hospital EXIT, not a hospital stay: treating it as an
		 * invalid target deleted the alert and silently dropped the mercenary's
		 * claim, then re-posted the same target as open a second later.
		 */
		const hospitalTimerElapsed =
			targetState === "Hospital" && hospUntil !== null && hospUntil <= nowSec;

		const isHospitalLead =
			inTornHospital && secondsInHosp <= 60 && secondsInHosp > 0;
		const isOkay = targetState === "Okay" || hospitalTimerElapsed;

		// Track hospital state persistently across polling ticks even if alert is unposted/deleted
		const hospRecord = this.hospitalTracker.get(key);
		if (targetState === "Hospital") {
			/**
			 * A recorded exit time means the previous stay has already ended, so a
			 * member seen in hospital again is on a NEW stay whose exit is what the
			 * 60-second RW immunity counts from. Keeping the old exit time made every
			 * stay after the first inherit it, so the cooldown was measured from a
			 * timestamp minutes in the past and dropped the moment the target left
			 * hospital again — while Torn still had them immune.
			 */
			if (hospRecord?.hospitalExitTime !== undefined) {
				hospRecord.hospitalExitTime = undefined;
				if (existingAlert) existingAlert.hospitalExitTime = undefined;
			}

			if (!hospRecord) {
				this.hospitalTracker.set(key, {
					wasInHospital: true,
					hospitalUntil: hospUntil,
					lastSeenHospSec: nowSec,
				});
			} else {
				hospRecord.wasInHospital = true;
				if (hospUntil !== null) {
					hospRecord.hospitalUntil = hospUntil;
				}
				hospRecord.lastSeenHospSec = nowSec;
			}
		}

		// Ranked War 60-second cooldown rule:
		// Dynamic check for active Ranked War (covers contracts created as 'active' OR 'upcoming' that are now active)
		const isWarActive =
			contract.warStatusAtCreation === "active" ||
			(contract.warStart !== null &&
				contract.warStart !== undefined &&
				nowSec >= contract.warStart &&
				(!contract.warEnd || nowSec < contract.warEnd));

		let rwCooldownUntil: number | null = null;
		const wasInHospital = Boolean(
			existingAlert?.wasInHospital || hospRecord?.wasInHospital,
		);

		if (isOkay && isWarActive && wasInHospital) {
			let exitTime =
				hospRecord?.hospitalExitTime ?? existingAlert?.hospitalExitTime;

			if (!exitTime) {
				const scheduledUntil =
					hospRecord?.hospitalUntil ?? existingAlert?.hospitalUntil;
				if (scheduledUntil && scheduledUntil <= nowSec) {
					exitTime = scheduledUntil;
				} else {
					exitTime = nowSec;
				}
				if (hospRecord) hospRecord.hospitalExitTime = exitTime;
				if (existingAlert) existingAlert.hospitalExitTime = exitTime;
			}

			if (nowSec < exitTime + 60) {
				rwCooldownUntil = exitTime + 60;
			} else {
				// Cooldown period expired
				if (hospRecord) {
					this.hospitalTracker.delete(key);
				}
				if (existingAlert) {
					existingAlert.wasInHospital = false;
					existingAlert.hospitalExitTime = undefined;
				}
			}
		}

		// If target is NOT okay and NOT in the 1-minute hospital lead:
		// Target is completely INVALIDATED (e.g. in hospital > 1m, jail, abroad, federal)
		if (!isOkay && !isHospitalLead) {
			if (existingAlert) {
				if (existingAlert.messageId) {
					void notifyBotAction("delete_merc_target_alert", {
						guildId,
						channelName,
						messageId: existingAlert.messageId,
					});
				}
				this.alerts.delete(key);
			}
			return;
		}

		// 4. Target is valid! Check if alert needs to be posted, updated, or reposted
		const isStrickenEligible = Boolean(effectiveTerms?.strickenHits);

		if (!existingAlert) {
			// Only the fresh-alert path needs the BS estimate; every update/repost
			// below reuses `existingAlert.estimatedBs`, so resolving it per member
			// per tick was a wasted await on the hot path.
			const estimatedBs = await this.resolveEstimatedBs(m.id, m.level);

			// Create fresh alert
			const newAlert: MercActiveTargetAlert = {
				contractId: contract.id,
				guildId,
				channelName,
				targetId: m.id,
				targetName: m.name,
				targetLevel: m.level,
				estimatedBs,
				status: "open",
				lastAlertAt: nowMs,
				isStrickenEligible,
				hospitalUntil: isHospitalLead ? hospUntil : null,
				rwCooldownUntil,
				wasInHospital:
					targetState === "Hospital" ||
					Boolean(rwCooldownUntil && nowSec < rwCooldownUntil),
				hospitalExitTime:
					isOkay && rwCooldownUntil
						? (hospRecord?.hospitalExitTime ?? nowSec)
						: undefined,
			};

			this.alerts.set(key, newAlert);

			void notifyBotAction("post_merc_target_alert", {
				guildId,
				channelName,
				contractId: contract.id,
				mercRoleId,
				target: {
					targetId: newAlert.targetId,
					targetName: newAlert.targetName,
					targetLevel: newAlert.targetLevel,
					estimatedBs: newAlert.estimatedBs,
					hospitalUntil: newAlert.hospitalUntil,
					status: newAlert.status,
					isStrickenEligible: newAlert.isStrickenEligible,
					rwCooldownUntil: newAlert.rwCooldownUntil,
				},
			});
			logger.info(
				`Dispatched merc target alert for ${newAlert.targetName} [${newAlert.targetId}] to #${channelName}`,
			);
			return;
		}

		// Update state tracking on existing alert
		const prevHospUntil = existingAlert.hospitalUntil;
		const prevRwCooldown = existingAlert.rwCooldownUntil;

		if (targetState === "Hospital") {
			existingAlert.wasInHospital = true;
		} else if (rwCooldownUntil && nowSec < rwCooldownUntil) {
			existingAlert.wasInHospital = true;
		}
		existingAlert.hospitalUntil = isHospitalLead ? hospUntil : null;

		/**
		 * Never shorten a lock that is still running.
		 *
		 * The cooldown is recomputed from scratch every tick, so any tick that cannot
		 * evaluate it — the member momentarily non-Okay, war fields mid-update — would
		 * write `null` over a live lock and tell mercenaries the target is attackable
		 * while Torn still has them immune. It also cleared the sticky
		 * `wasInHospital` flag, which no later tick could restore, so the immunity was
		 * lost for the rest of that stay. A preserved lock is always bounded by its
		 * own expiry (at most 60s out).
		 */
		const previousLock = existingAlert.rwCooldownUntil ?? null;
		if (previousLock !== null && previousLock > nowSec) {
			rwCooldownUntil =
				rwCooldownUntil === null
					? previousLock
					: Math.max(rwCooldownUntil, previousLock);
		}
		existingAlert.rwCooldownUntil = rwCooldownUntil;

		if (
			existingAlert.messageId &&
			(prevHospUntil !== existingAlert.hospitalUntil ||
				prevRwCooldown !== existingAlert.rwCooldownUntil)
		) {
			void notifyBotAction("update_merc_target_alert", {
				guildId,
				channelName,
				messageId: existingAlert.messageId,
				contractId: contract.id,
				target: {
					targetId: existingAlert.targetId,
					targetName: existingAlert.targetName,
					targetLevel: existingAlert.targetLevel,
					estimatedBs: existingAlert.estimatedBs,
					hospitalUntil: existingAlert.hospitalUntil,
					status: existingAlert.status,
					claimedBy: existingAlert.claimedBy,
					claimedAt: existingAlert.claimedAt,
					isStrickenEligible: existingAlert.isStrickenEligible,
					rwCooldownUntil: existingAlert.rwCooldownUntil,
				},
			});
		}

		// Track whether the target is currently attackable (out of hospital and past any RW cooldown)
		const isTargetAttackable =
			isOkay && (!rwCooldownUntil || nowSec >= rwCooldownUntil);

		if (existingAlert.status === "claimed") {
			if (isTargetAttackable) {
				if (!existingAlert.lockStartedAt) {
					existingAlert.lockStartedAt = nowMs;
					logger.info(
						`Target ${existingAlert.targetName} [${existingAlert.targetId}] is attackable (hosp & RW cooldown cleared). 20s claim lock started counting.`,
					);
				}
			} else {
				// Target is still in hospital or on RW hit cooldown: 20s lock timer must not run
				existingAlert.lockStartedAt = undefined;
			}
		}

		// 5. Unrecorded alert retry: if open alert was dispatched but messageId never recorded after 10s, retry posting
		if (
			existingAlert.status === "open" &&
			!existingAlert.messageId &&
			nowMs >= existingAlert.lastAlertAt + 10_000
		) {
			existingAlert.lastAlertAt = nowMs;
			void notifyBotAction("post_merc_target_alert", {
				guildId,
				channelName,
				contractId: contract.id,
				mercRoleId,
				target: {
					targetId: existingAlert.targetId,
					targetName: existingAlert.targetName,
					targetLevel: existingAlert.targetLevel,
					estimatedBs: existingAlert.estimatedBs,
					hospitalUntil: existingAlert.hospitalUntil,
					status: existingAlert.status,
					isStrickenEligible: existingAlert.isStrickenEligible,
					rwCooldownUntil: existingAlert.rwCooldownUntil,
				},
			});
			logger.info(
				`Retrying unrecorded target alert for ${existingAlert.targetName} [${existingAlert.targetId}] to #${channelName}`,
			);
			return;
		}

		// 6. Stale target check: if open & unhit for 1 minute (60s) -> delete old & repost with role ping
		if (
			existingAlert.status === "open" &&
			nowMs >= existingAlert.lastAlertAt + 60_000
		) {
			if (existingAlert.messageId) {
				void notifyBotAction("delete_merc_target_alert", {
					guildId,
					channelName,
					messageId: existingAlert.messageId,
				});
				existingAlert.messageId = undefined;
			}

			existingAlert.lastAlertAt = nowMs;

			void notifyBotAction("post_merc_target_alert", {
				guildId,
				channelName,
				contractId: contract.id,
				mercRoleId,
				target: {
					targetId: existingAlert.targetId,
					targetName: existingAlert.targetName,
					targetLevel: existingAlert.targetLevel,
					estimatedBs: existingAlert.estimatedBs,
					hospitalUntil: existingAlert.hospitalUntil,
					status: existingAlert.status,
					isStrickenEligible: existingAlert.isStrickenEligible,
					rwCooldownUntil: existingAlert.rwCooldownUntil,
				},
			});
			logger.info(
				`Reposting stale merc target alert for ${existingAlert.targetName} [${existingAlert.targetId}] to #${channelName}`,
			);
			return;
		}

		// 7. Claim expiration check: 20s lock release should only start counting AFTER RW hit cooldown is over and target is out of hospital
		if (
			existingAlert.status === "claimed" &&
			existingAlert.lockStartedAt &&
			nowMs >= existingAlert.lockStartedAt + 20_000
		) {
			if (existingAlert.messageId) {
				void notifyBotAction("delete_merc_target_alert", {
					guildId,
					channelName,
					messageId: existingAlert.messageId,
				});
				existingAlert.messageId = undefined;
			}

			existingAlert.status = "open";
			existingAlert.claimedBy = undefined;
			existingAlert.claimedAt = undefined;
			existingAlert.lockStartedAt = undefined;
			existingAlert.lastAlertAt = nowMs;

			void notifyBotAction("post_merc_target_alert", {
				guildId,
				channelName,
				contractId: contract.id,
				mercRoleId,
				target: {
					targetId: existingAlert.targetId,
					targetName: existingAlert.targetName,
					targetLevel: existingAlert.targetLevel,
					estimatedBs: existingAlert.estimatedBs,
					hospitalUntil: existingAlert.hospitalUntil,
					status: "open",
					isStrickenEligible: existingAlert.isStrickenEligible,
					rwCooldownUntil: existingAlert.rwCooldownUntil,
				},
			});
			logger.info(
				`Claim expired (20s post-cooldown) for ${existingAlert.targetName} [${existingAlert.targetId}], reposting to #${channelName}`,
			);
		}
	}
}

export const mercTargetManager = new MercTargetManager();

interface TornFactionMembersResponse {
	members?: FactionMember[];
}

let lastTrackedSummaryKey = "";
let lastTrackedLogTime = 0;
let lastExpiredTokenCheck = 0;
let lastContractsQueryLogTime = 0;
const revivablesUpdateTracker = new Map<
	string,
	{ signature: string; lastSentAt: number }
>();
/** Last time the per-contract performance diagnostic line was emitted. */
const perfLogAt = new Map<string, number>();
/** Contracts whose targets have already been cleaned for the current pause. */
const cleanedPausedContracts = new Set<string>();

/**
 * Minimum gap between two auto-stop threshold checks per contract.
 *
 * The validator already enforces auto-stop event-driven immediately after each
 * credited hit, so this per-cycle check is only a safety net — recomputing the
 * full payout aggregate every second bought nothing and cost an unbounded read.
 */
const AUTO_STOP_CHECK_INTERVAL_MS = 15_000;
const autoStopCheckedAt = new Map<string, number>();

/**
 * Cached per-guild configuration, keyed by guild id. Guild/channel config
 * changes on human timescales (an admin renaming a channel), so re-reading it
 * on every 1-second cycle was pure overhead.
 */
const GUILD_CONFIG_TTL_MS = 60_000;
const guildConfigCache = new Map<
	string,
	{ value: Awaited<ReturnType<typeof loadGuildConfig>>; cachedAt: number }
>();

async function loadGuildConfig(guildId: string): Promise<{
	mercRoleId: string | null | undefined;
	channelConfig: Awaited<ReturnType<typeof getMercChannelConfig>>;
}> {
	const [guildConfig] = await db
		.select()
		.from(guildConfigs)
		.where(eq(guildConfigs.guildId, guildId));

	return {
		mercRoleId: guildConfig?.mercRoleId,
		channelConfig: await getMercChannelConfig(guildId),
	};
}

async function getCachedGuildConfig(guildId: string) {
	const cached = guildConfigCache.get(guildId);
	const now = Date.now();
	if (cached && now - cached.cachedAt < GUILD_CONFIG_TTL_MS) {
		return cached.value;
	}

	const value = await loadGuildConfig(guildId);
	guildConfigCache.set(guildId, { value, cachedAt: now });
	return value;
}

/**
 * Runs a single cycle of the Mercenary Contract Worker.
 * 1-second cadence when active or imminent contracts exist; 15s when idle.
 */
export async function runMercContractTrackingCycle(
	signal?: AbortSignal,
): Promise<number> {
	const nowMs = Date.now();
	const nowSec = Math.floor(nowMs / 1000);

	// Periodically trigger bot to auto-archive channels for expired contract creation links
	if (nowMs >= lastExpiredTokenCheck + 30_000) {
		lastExpiredTokenCheck = nowMs;
		void notifyBotAction("check_expired_merc_tokens");
	}

	// 1. Fetch active, upcoming, and paused contracts
	const contractsQueryStart = Date.now();
	const rows = await db
		.select()
		.from(mercContracts)
		.where(
			and(inArray(mercContracts.status, ["active", "upcoming", "paused"])),
		);

	// Diagnostics only: throttled to one line per minute instead of one per cycle.
	if (nowMs >= lastContractsQueryLogTime + 60_000) {
		lastContractsQueryLogTime = nowMs;
		logger.info(
			`[perf] contracts query: ${Date.now() - contractsQueryStart}ms (${rows.length} row(s))`,
		);
	}

	if (rows.length === 0) {
		return Date.now() + 15_000;
	}

	if (signal?.aborted) {
		logger.warn("Merc contract cycle aborted before contract evaluation.");
		return Date.now() + 1_000;
	}

	const contracts = rows.map(mapRowToMercContract);
	mercTargetManager.resetBsStats();
	const cycleStartedAt = nowMs;

	// Restore the previous process's state (claims, posted messages, hospital-exit
	// baselines) now that the contract list is known, so alerts belonging to
	// contracts that are no longer running are dropped instead of being re-posted.
	await mercTargetManager.hydrateFromStore(
		new Set(
			contracts
				.filter((c) => c.status === "active" || c.status === "upcoming")
				.map((c) => c.id),
		),
	);

	const relevantContracts: MercContract[] = [];

	for (const contract of contracts) {
		// If contract is paused, ensure any active targets are removed and skip processing
		if (contract.status === "paused") {
			// Clean once per pause transition rather than re-scanning the alert,
			// hospital and offline maps every cycle for the whole pause duration.
			if (!cleanedPausedContracts.has(contract.id)) {
				cleanedPausedContracts.add(contract.id);
				mercTargetManager.cleanContractTargets(contract.id);
			}
			continue;
		}
		cleanedPausedContracts.delete(contract.id);

		const startMs = new Date(contract.startTime).getTime();
		const endMs = contract.endTime
			? new Date(contract.endTime).getTime()
			: null;

		// Check if active contract has reached autoStopPrice. Throttled: the
		// validator enforces auto-stop event-driven right after each credited hit,
		// so this aggregate is a safety net rather than the primary path.
		if (
			contract.status === "active" &&
			contract.autoStopPrice &&
			contract.autoStopPrice > 0 &&
			nowMs >=
				(autoStopCheckedAt.get(contract.id) ?? 0) + AUTO_STOP_CHECK_INTERVAL_MS
		) {
			autoStopCheckedAt.set(contract.id, nowMs);
			const totalPayout = await getMercContractTotalPayout(contract.id);
			if (totalPayout >= contract.autoStopPrice) {
				const summary = await getMercContractSummary(contract.id);
				logger.info(
					`Mercenary contract ${contract.id} (${contract.factionName}) reached auto-stop price ($${contract.autoStopPrice.toLocaleString()} - total payout: $${summary.totalPayout.toLocaleString()}). Concluding contract.`,
				);

				await db
					.update(mercContracts)
					.set({
						status: "completed",
						endTime: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(mercContracts.id, contract.id));

				const channelConfig = await getMercChannelConfig(contract.guildId);
				const logChannel = channelConfig.mercLog || "merc-logs";

				void notifyBotAction("post_merc_contract_end_summary", {
					guildId: contract.guildId,
					channelName: logChannel,
					contract: {
						...contract,
						status: "completed",
						endTime: new Date().toISOString(),
					},
					summary,
				});

				void notifyBotAction("delete_merc_upcoming_announcement", {
					guildId: contract.guildId,
					contractId: contract.id,
					factionId: contract.factionId,
					messageId: contract.upcomingMessageId ?? undefined,
				});

				mercTargetManager.cleanContractTargets(contract.id);
				continue;
			}
		}

		// Check if active contract has reached endTime
		if (
			contract.status === "active" &&
			endMs &&
			nowMs >= endMs &&
			!contract.endOnWarEnd
		) {
			logger.info(
				`Mercenary contract ${contract.id} (${contract.factionName}) reached end time. Concluding contract.`,
			);

			await db
				.update(mercContracts)
				.set({ status: "completed", updatedAt: new Date() })
				.where(eq(mercContracts.id, contract.id));

			const channelConfig = await getMercChannelConfig(contract.guildId);
			const logChannel = channelConfig.mercLog || "merc-logs";

			const summary = await getMercContractSummary(contract.id);
			void notifyBotAction("post_merc_contract_end_summary", {
				guildId: contract.guildId,
				channelName: logChannel,
				contract: { ...contract, status: "completed" },
				summary,
			});

			void notifyBotAction("delete_merc_upcoming_announcement", {
				guildId: contract.guildId,
				contractId: contract.id,
				factionId: contract.factionId,
				messageId: contract.upcomingMessageId ?? undefined,
			});

			mercTargetManager.cleanContractTargets(contract.id);
			continue;
		}

		// Check if upcoming contract should become active
		if (contract.status === "upcoming" && nowMs >= startMs) {
			logger.info(
				`Upcoming contract ${contract.id} (${contract.factionName}) start time reached. Transitioning to active.`,
			);

			await db
				.update(mercContracts)
				.set({ status: "active", updatedAt: new Date() })
				.where(eq(mercContracts.id, contract.id));

			contract.status = "active";
			relevantContracts.push(contract);
			continue;
		}

		// Strictly only populate targets once the contract is active and has started
		if (contract.status === "active" && nowMs >= startMs) {
			relevantContracts.push(contract);
		}
	}

	if (relevantContracts.length === 0) {
		return Date.now() + 15_000;
	}

	const contractSummaryKey = relevantContracts
		.map((c) => `${c.id}:${c.status}`)
		.join(",");
	if (
		contractSummaryKey !== lastTrackedSummaryKey ||
		nowMs >= lastTrackedLogTime + 60_000
	) {
		lastTrackedSummaryKey = contractSummaryKey;
		lastTrackedLogTime = nowMs;
		logger.info(
			`Tracking ${relevantContracts.length} contract(s): ${relevantContracts.map((c) => `${c.factionName} [${c.factionId}] (${c.status})`).join(", ")}`,
		);
	}

	// 2. Process each contract's target faction members
	// Shares the managed client's limiter so this worker's requests are counted
	// against the same per-key budget as every `tornApi.*` call.
	const apiClient = new TornApiClient({
		rateLimitTracker: tornApi.rateLimiter,
	});

	for (const contract of relevantContracts) {
		if (signal?.aborted) {
			logger.warn(
				"Merc contract cycle aborted before processing remaining contracts.",
			);
			return Date.now() + 1_000;
		}

		const { mercRoleId, channelConfig } = await getCachedGuildConfig(
			contract.guildId,
		);
		const targetsChannel = channelConfig.targets || "targets";

		const tornFetchStart = Date.now();
		const keyPoolStart = Date.now();
		const keyObj = await getNextSubversiveUserKey();
		const keyPoolMs = Date.now() - keyPoolStart;
		if (!keyObj) {
			logger.warn(
				"No active script API keys available for merc contract target polling.",
			);
			continue;
		}

		try {
			const membersRes = (await apiClient.get("/faction/{id}/members", {
				apiKey: keyObj.apiKey,
				rateLimitKey: keyObj.userId,
				pathParams: { id: contract.factionId },
			})) as TornFactionMembersResponse;
			const tornFetchMs = Date.now() - tornFetchStart;

			recordSubversiveKeySuccess(keyObj.apiKey);

			const members = membersRes.members ?? [];

			// Batch BS estimates for the whole roster in one upstream request so
			// the per-member loop below is a pure cache hit.
			const prewarm = await mercTargetManager.prewarmEstimatedBs(
				members,
				signal,
			);

			const processStart = Date.now();
			let processed = 0;
			for (const m of members) {
				// Stop early when this cycle has already been abandoned by the
				// scheduler timeout, so it cannot overlap the retry cycle.
				if (signal?.aborted) {
					logger.warn(
						`Merc contract cycle aborted mid-roster for contract ${contract.id} after ${processed}/${members.length} members.`,
					);
					return Date.now() + 1_000;
				}
				await mercTargetManager.processMember(
					contract,
					contract.guildId,
					targetsChannel,
					mercRoleId,
					m,
					nowSec,
					nowMs,
				);
				processed++;
			}
			const processMs = Date.now() - processStart;

			// Diagnostics only: one line per contract per minute, not per second.
			const lastPerfLogAt = perfLogAt.get(contract.id) ?? 0;
			if (nowMs >= lastPerfLogAt + 60_000) {
				perfLogAt.set(contract.id, nowMs);
				logger.info(
					`[perf] contract=${contract.id} faction=${contract.factionId} keyPool=${keyPoolMs}ms tornFetch=${tornFetchMs}ms bsPrewarm=${prewarm.fetchMs}ms (${prewarm.resolved}/${prewarm.requested} resolved) memberProcess=${processMs}ms members=${members.length} bsMisses=${mercTargetManager.getBsStats().misses} bsFetchMs=${mercTargetManager.getBsStats().fetchMs}ms`,
				);
			}

			if (channelConfig.revivables) {
				const revivables = members
					.filter((m) => Boolean(m.is_revivable))
					.map((m) => ({
						id: m.id,
						name: m.name,
						level: m.level,
						statusState: m.status?.state ?? m.last_action?.status ?? "Hospital",
						statusDescription: m.status?.description ?? "",
						statusUntil: m.status?.until ?? null,
						lastActionRelative: m.last_action?.relative ?? null,
					}));

				const sig = revivables.map((r) => `${r.id}:${r.statusState}`).join(",");
				const trackerKey = `${contract.guildId}:${contract.id}`;
				const prev = revivablesUpdateTracker.get(trackerKey);

				const shouldUpdate =
					!prev ||
					(sig !== prev.signature && nowMs - prev.lastSentAt >= 5_000) ||
					nowMs - prev.lastSentAt >= 30_000;

				if (shouldUpdate) {
					revivablesUpdateTracker.set(trackerKey, {
						signature: sig,
						lastSentAt: nowMs,
					});

					void notifyBotAction("update_merc_revivables_list", {
						guildId: contract.guildId,
						contractId: contract.id,
						channelName: channelConfig.revivables,
						factionName: contract.factionName,
						factionId: contract.factionId,
						members: revivables,
					});
				}
			}
		} catch (err) {
			logger.warn(
				`[perf] contract=${contract.id} faction=${contract.factionId} keyPool=${keyPoolMs}ms FAILED after ${Date.now() - tornFetchStart}ms: ${err instanceof Error ? err.message : String(err)}`,
			);
			if (
				(err instanceof TornError &&
					(err.code === 13 || err.code === 10 || err.code === 18)) ||
				String(err).includes("Key temporarily disabled")
			) {
				const cooldownMs = markSubversiveKeyDisabled(keyObj.apiKey);
				logger.warn(
					`Merc key '...${keyObj.apiKey.slice(-4)}' marked disabled for ${Math.round(cooldownMs / 1000)}s: ${err}`,
				);
			} else {
				logger.warn(
					`Failed to fetch members for contract ${contract.id} faction ${contract.factionId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	const cycleMs = Date.now() - cycleStartedAt;
	if (cycleMs > 3_000) {
		logger.warn(
			`[perf] merc cycle took ${cycleMs}ms (timeout budget is ${MERC_WORKER_TIMEOUT_MS}ms); contracts=${relevantContracts.length}`,
		);
	}

	// One call covers every per-member mutation the roster loop just made
	// (hospital timers, lock state, reposts). The store skips unchanged payloads.
	mercTargetManager.schedulePersist();

	// 1-second cadence when active or imminent contracts are running
	return Date.now() + 1_000;
}

/**
 * Starts the Mercenary Contract Worker in the scheduler service.
 */
export const startMercContractWorker: WorkerStarter = (options) => {
	startEventDrivenRunner({
		worker: "merc:contract_worker",
		defaultCadenceSeconds: 1,
		timeoutMs: MERC_WORKER_TIMEOUT_MS,
		initialDelayMs: options?.initialDelayMs ?? 1000,
		handler: runMercContractTrackingCycle,
	});
};
