import { db, eq, subversiveDibsConfigs } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_DIBS_CONFIG,
	type DibsClaimant,
	type DibsRecord,
	type SubversiveDibsConfig,
} from "@sentinel/schemas";
import {
	isInTornHospital,
	Logger,
	PRIMARY_SUBVERSIVE_FACTION_ID,
	resolveSubversiveFactionId,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";
import { notifyBotAction } from "./bot-ipc";
import { dibsMessageStore } from "./dibs-message-store";
import { dibsRecordStore } from "./dibs-record-store";
import {
	type CurrentWarInfo,
	type RankedWarOpponent,
	subversiveTargetCache,
} from "./subversive-target-cache";

const logger = new Logger("API", "SubversiveDibsManager");

/**
 * Dibs settings live in `subversive_dibs_configs`, one row per family faction.
 * Rows written before that table existed were migrated by SQL; see drizzle
 * migration 0041.
 */
class SubversiveDibsManager {
	/** Per-faction config cache keyed by resolved faction id. */
	private configs = new Map<number, SubversiveDibsConfig>();
	private activeDibs = new Map<number, DibsRecord>();
	private broadcastCallback: ((dibs: DibsRecord[]) => void) | null = null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Sets the callback invoked whenever dibs records change so WebSockets can broadcast live.
	 */
	setBroadcastCallback(fn: (dibs: DibsRecord[]) => void): void {
		this.broadcastCallback = fn;
	}

	/**
	 * Restores the board persisted by a previous process, claims included.
	 *
	 * Called once at API startup, before the first war snapshot arrives. Without
	 * it a redeploy silently released every held dibs, and the channel sweep —
	 * whose live set is built from this board — deleted those members' callouts
	 * as orphans. Records that are no longer valid (war ended, target downed or
	 * out of hospital) are cleaned up by the normal lifecycle as soon as the
	 * scheduler's first snapshot lands.
	 *
	 * Deliberately does not broadcast or schedule a write: the row it just read is
	 * already the persisted state, and no subscriber exists yet at boot. The first
	 * evaluation cycle pushes the restored board onward.
	 *
	 * @returns how many records were restored
	 */
	async hydrateFromStore(): Promise<number> {
		const restored = await dibsRecordStore.load();
		let count = 0;

		for (const record of restored) {
			if (typeof record?.targetId !== "number") continue;
			// Never clobber a record the evaluation loop already produced.
			if (this.activeDibs.has(record.targetId)) continue;
			this.activeDibs.set(record.targetId, record);
			count++;
		}

		if (count > 0) {
			logger.info(
				`Restored ${count} dibs record(s) from the database after restart (${this.claimedCount()} still claimed).`,
			);
		}

		return count;
	}

	private claimedCount(): number {
		let claimed = 0;
		for (const dibs of this.activeDibs.values()) {
			if (dibs.status === "claimed") claimed++;
		}
		return claimed;
	}

	/**
	 * Queues a persist of the current board, coalescing bursts.
	 *
	 * The board is written as a whole, so serialising it on every accepted claim
	 * or lock expiry would be wasted work; the debounce also keeps the
	 * per-second hospital-until bookkeeping from reaching the database. The
	 * store skips the write entirely when the payload is unchanged.
	 */
	private schedulePersist(): void {
		if (this.persistTimer) return;

		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void dibsRecordStore.save(this.getActiveDibs());
		}, SubversiveDibsManager.PERSIST_DEBOUNCE_MS);

		// Never hold the process open just to flush the board.
		(this.persistTimer as unknown as { unref?: () => void }).unref?.();
	}

	/**
	 * Awaits any queued board write. Used by tests and by a caller that needs the
	 * board durable before it continues.
	 */
	async flushPersist(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
			await dibsRecordStore.save(this.getActiveDibs());
		}
		await dibsRecordStore.flush();
	}

	/**
	 * Drops the in-memory board and any pending write, leaving the persisted row
	 * untouched. Lets tests simulate a process restart.
	 */
	resetBoardForTesting(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.activeDibs.clear();
	}

	/** How long board mutations are coalesced before being written. */
	private static readonly PERSIST_DEBOUNCE_MS = 3_000;

	/**
	 * Explicitly sets the in-memory configuration (useful for tests or mocking).
	 * Seeds every family faction unless a narrower override map is supplied.
	 */
	setConfigForTesting(config?: Partial<SubversiveDibsConfig>): void {
		this.configs.clear();
		for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
			this.configs.set(factionId, {
				...DEFAULT_SUBVERSIVE_DIBS_CONFIG,
				...config,
			});
		}
	}

	/**
	 * Explicitly overrides the config of a single family faction (useful for tests).
	 */
	setFactionConfigForTesting(
		factionId: number,
		config?: Partial<SubversiveDibsConfig>,
	): void {
		const resolved = resolveSubversiveFactionId(factionId);
		this.configs.set(resolved, {
			...DEFAULT_SUBVERSIVE_DIBS_CONFIG,
			...config,
		});
	}

	/**
	 * Returns the cached in-memory configuration synchronously.
	 * Always returns a value so hot paths (war events, WS pushes) never block on IO.
	 */
	getCachedConfig(factionId?: number | null): SubversiveDibsConfig {
		const resolved = resolveSubversiveFactionId(factionId);
		return this.configs.get(resolved) ?? { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG };
	}

	/**
	 * Evaluates the hospital queues for every family faction directly from
	 * subversiveTargetCache (dibs are per-faction: each faction fights its own war).
	 */
	async evaluateHospitalQueue(): Promise<void> {
		for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
			const war = subversiveTargetCache.getWarState(factionId);
			const hospitalQueue = subversiveTargetCache.getHospitalQueue({
				limit: 1000,
				attackerBsScore: 0,
				factionId,
			});
			await this.processWarHospitalQueue(hospitalQueue, war, factionId);
		}
	}

	private hasAnyEngagedWar(): boolean {
		return SUBVERSIVE_FAMILY_FACTION_IDS.some((factionId) => {
			const war = subversiveTargetCache.getWarState(factionId);
			return war.state === "active" || war.state === "scheduled";
		});
	}

	private loopTimer: ReturnType<typeof setInterval> | null = null;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Starts background interval timer evaluating hospital queue countdowns.
	 */
	startEvaluationLoop(intervalMs = 1000): void {
		if (this.loopTimer) return;
		this.loopTimer = setInterval(() => {
			void this.runEvaluationTick();
		}, intervalMs);
	}

	/**
	 * One evaluation cycle, extracted from the loop so it can be driven directly
	 * (tests) and so the two branches stay readable.
	 */
	async runEvaluationTick(): Promise<void> {
		if (this.hasAnyEngagedWar()) {
			await this.evaluateHospitalQueue();
			return;
		}

		this.clearDibsForKnownEndedWars();
	}

	/**
	 * Clears dibs whose war has ended without the normal teardown running, which
	 * would otherwise leave orphaned callouts in the channel.
	 *
	 * Only factions whose war state Torn actually answered for are touched. A
	 * faction with no war snapshot yet (a fresh API process, before the
	 * scheduler's first push) is unknown, and restoring persisted claims must not
	 * be undone by an interval tick that knows nothing about the war.
	 */
	private clearDibsForKnownEndedWars(): void {
		let changed = false;
		for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
			const war = subversiveTargetCache.getWarState(factionId);
			if (war.lastUpdated <= 0) continue;
			if (war.state === "active" || war.state === "scheduled") continue;
			if (this.clearDibsForFaction(factionId)) changed = true;
		}
		if (changed) this.notifyBroadcast();
	}

	/**
	 * Sends a delete_dibs_alert for a record and clears its ledger entry.
	 */
	private deleteDibsMessage(dibs: DibsRecord): void {
		const channelId = dibs.discordChannelId;
		const messageId = dibs.discordMessageId;
		if (!channelId || !messageId) return;

		void notifyBotAction("delete_dibs_alert", {
			channelId,
			messageId,
			targetId: dibs.targetId,
		});
		void dibsMessageStore.forget(messageId);
		dibs.discordMessageId = undefined;
	}

	/**
	 * Stops background interval timer.
	 */
	stopEvaluationLoop(): void {
		if (this.loopTimer) {
			clearInterval(this.loopTimer);
			this.loopTimer = null;
		}
	}

	/**
	 * Starts the periodic dibs channel maintenance sweep.
	 *
	 * The sweep asks the bot to delete any tracked dibs message that is no longer
	 * live (war termed, target downed, lock expired) plus any older than the
	 * configured max age. This is the safety net for orphans the normal lifecycle
	 * cannot clean: API restarts, failed IPC deliveries, and races at war end.
	 */
	startSweepLoop(fallbackIntervalMinutes = 15): void {
		if (this.sweepTimer) return;

		// Poll every minute and decide from each faction's own configured cadence,
		// so per-faction changes take effect without a restart.
		this.sweepTimer = setInterval(() => {
			void this.runDueSweeps(fallbackIntervalMinutes);
		}, 60_000);
	}

	stopSweepLoop(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}

	/** Last sweep time per faction, so cadence is respected independently. */
	private lastSweepAt = new Map<number, number>();

	private async runDueSweeps(fallbackIntervalMinutes: number): Promise<void> {
		const now = Date.now();
		for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
			const config = await this.getConfig(factionId);
			if (config.channelMaintenanceEnabled === false) continue;

			const intervalMinutes =
				typeof config.sweepIntervalMinutes === "number"
					? config.sweepIntervalMinutes
					: fallbackIntervalMinutes;
			if (intervalMinutes <= 0) continue;

			const last = this.lastSweepAt.get(factionId) ?? 0;
			if (now - last < intervalMinutes * 60_000) continue;

			this.lastSweepAt.set(factionId, now);
			await this.sweepDibsChannel(factionId);
		}
	}

	/**
	 * Reconciles the dibs Discord channel for one faction by asking the bot to
	 * delete every tracked message that is no longer live or is past its max age.
	 *
	 * @param factionId faction to sweep (defaults to primary)
	 * @returns the message ids requested for deletion, or null when skipped
	 */
	async sweepDibsChannel(factionId?: number | null): Promise<string[] | null> {
		const resolved = resolveSubversiveFactionId(factionId);
		const config = await this.getConfig(resolved);
		const channelId = config.channelId;
		if (!channelId) return null;

		// Live = still in activeDibs. Anything else tracked is an orphan.
		const liveMessageIds = new Set<string>();
		for (const dibs of this.activeDibs.values()) {
			if ((dibs.factionId ?? resolved) !== resolved) continue;
			if (dibs.discordMessageId) liveMessageIds.add(dibs.discordMessageId);
		}

		const maxAgeHours =
			typeof config.maxDibsMessageAgeHours === "number"
				? config.maxDibsMessageAgeHours
				: 6;

		// Everything we have on record for this faction's channel, so the bot can
		// delete ids that are still tracked but already dead.
		const tracked = await dibsMessageStore.list(resolved);

		const delivered = await notifyBotAction("sweep_dibs_channel", {
			channelId,
			factionId: resolved,
			liveMessageIds: [...liveMessageIds],
			trackedMessageIds: tracked.map((ref) => ref.messageId),
			maxAgeHours,
		});

		if (!delivered) {
			logger.warn(
				`Dibs channel sweep skipped for faction ${resolved}: bot unreachable.`,
			);
			return null;
		}

		logger.info(
			`Dibs channel sweep dispatched for faction ${resolved} (${liveMessageIds.size} live, ${tracked.length} tracked, maxAge ${maxAgeHours}h).`,
		);
		return [...liveMessageIds];
	}

	/** Maps one table row onto the config shape shared with the HTTP layer. */
	private static toConfig(
		row: typeof subversiveDibsConfigs.$inferSelect,
	): SubversiveDibsConfig {
		return {
			enabled: row.enabled,
			channelId: row.channelId,
			claimLeadTime: row.claimLeadTime,
			maxDibsPerPerson: row.maxDibsPerPerson,
			postHospTimeoutSeconds: row.postHospTimeoutSeconds,
			autoDeleteOnDowned: row.autoDeleteOnDowned,
			channelMaintenanceEnabled: row.channelMaintenanceEnabled,
			maxDibsMessageAgeHours: row.maxDibsMessageAgeHours,
			sweepIntervalMinutes: row.sweepIntervalMinutes,
			updatedAt: row.updatedAt.toISOString(),
			updatedBy: row.updatedBy ?? undefined,
		};
	}

	/**
	 * Retrieves the Dibs configuration for one family faction, reading it from
	 * `subversive_dibs_configs` on first run and caching it thereafter.
	 *
	 * A missing row is not an error: it means the dashboard has never saved
	 * settings for that faction yet, so the factory defaults apply.
	 */
	async getConfig(factionId?: number | null): Promise<SubversiveDibsConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const cached = this.configs.get(resolved);
		if (cached) return cached;

		let config: SubversiveDibsConfig = { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG };
		try {
			const [row] = await db
				.select()
				.from(subversiveDibsConfigs)
				.where(eq(subversiveDibsConfigs.factionId, resolved));

			if (row) {
				config = SubversiveDibsManager.toConfig(row);
			}
		} catch (err) {
			logger.warn(
				`Failed to load dibs config for faction ${resolved} from database:`,
				err,
			);
		}

		this.configs.set(resolved, config);
		return config;
	}

	/**
	 * Updates the Dibs configuration for one family faction in the database and
	 * updates the RAM cache.
	 */
	async updateConfig(
		patch: Partial<SubversiveDibsConfig>,
		updatedBy = "admin",
		factionId?: number | null,
	): Promise<SubversiveDibsConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const current = await this.getConfig(resolved);
		const merged: SubversiveDibsConfig = { ...current, ...patch };

		const [row] = await db
			.insert(subversiveDibsConfigs)
			.values({
				factionId: resolved,
				enabled: merged.enabled,
				channelId: merged.channelId,
				claimLeadTime: merged.claimLeadTime,
				maxDibsPerPerson: merged.maxDibsPerPerson,
				postHospTimeoutSeconds: merged.postHospTimeoutSeconds,
				autoDeleteOnDowned: merged.autoDeleteOnDowned,
				channelMaintenanceEnabled:
					merged.channelMaintenanceEnabled ??
					DEFAULT_SUBVERSIVE_DIBS_CONFIG.channelMaintenanceEnabled ??
					true,
				maxDibsMessageAgeHours:
					merged.maxDibsMessageAgeHours ??
					DEFAULT_SUBVERSIVE_DIBS_CONFIG.maxDibsMessageAgeHours ??
					6,
				sweepIntervalMinutes:
					merged.sweepIntervalMinutes ??
					DEFAULT_SUBVERSIVE_DIBS_CONFIG.sweepIntervalMinutes ??
					15,
				updatedBy,
			})
			.onConflictDoUpdate({
				target: subversiveDibsConfigs.factionId,
				set: {
					enabled: merged.enabled,
					channelId: merged.channelId,
					claimLeadTime: merged.claimLeadTime,
					maxDibsPerPerson: merged.maxDibsPerPerson,
					postHospTimeoutSeconds: merged.postHospTimeoutSeconds,
					autoDeleteOnDowned: merged.autoDeleteOnDowned,
					channelMaintenanceEnabled:
						merged.channelMaintenanceEnabled ??
						DEFAULT_SUBVERSIVE_DIBS_CONFIG.channelMaintenanceEnabled ??
						true,
					maxDibsMessageAgeHours:
						merged.maxDibsMessageAgeHours ??
						DEFAULT_SUBVERSIVE_DIBS_CONFIG.maxDibsMessageAgeHours ??
						6,
					sweepIntervalMinutes:
						merged.sweepIntervalMinutes ??
						DEFAULT_SUBVERSIVE_DIBS_CONFIG.sweepIntervalMinutes ??
						15,
					updatedBy,
					updatedAt: new Date(),
				},
			})
			.returning();

		const updated = row
			? SubversiveDibsManager.toConfig(row)
			: { ...merged, updatedAt: new Date().toISOString(), updatedBy };

		this.configs.set(resolved, updated);
		logger.info(
			`Updated Subversive Dibs configuration for faction ${resolved}.`,
		);
		return updated;
	}

	/**
	 * Returns all currently active Dibs records, optionally scoped to one faction.
	 */
	getActiveDibs(factionId?: number | null): DibsRecord[] {
		const all = Array.from(this.activeDibs.values());
		if (factionId === undefined || factionId === null) return all;
		const scoped = resolveSubversiveFactionId(factionId);
		return all.filter((d) => (d.factionId ?? scoped) === scoped);
	}

	/**
	 * Returns a specific Dibs record by targetId.
	 */
	getDibsByTargetId(targetId: number): DibsRecord | undefined {
		return this.activeDibs.get(targetId);
	}

	/**
	 * Associates a Discord message ID and channel ID with an active Dibs record,
	 * persisting it so the message can still be cleaned up after a restart.
	 */
	recordDiscordMessage(
		targetId: number,
		channelId: string,
		messageId: string,
	): Promise<void> {
		const dibs = this.activeDibs.get(targetId);

		// Track even when the in-memory record is already gone (e.g. the war
		// ended while the embed was being posted) so the sweeper can clean it up.
		const tracked = dibsMessageStore.track({
			targetId,
			factionId: dibs?.factionId,
			channelId,
			messageId,
		});

		if (dibs) {
			dibs.discordChannelId = channelId;
			dibs.discordMessageId = messageId;
			// Persist the message id: after a restart it is what keeps this callout
			// inside the sweep's live set instead of being deleted as an orphan.
			this.schedulePersist();

			// If dibs was already claimed while the message was being posted, update Discord embed immediately
			if (dibs.status === "claimed") {
				void notifyBotAction("edit_dibs_alert", {
					channelId,
					messageId,
					status: "claimed",
					dibs,
				});
			}
		}

		return tracked;
	}

	/**
	 * Clears all dibs belonging to a single faction, deleting any Discord messages
	 * they own. Returns true when something was removed.
	 *
	 * This is the path taken when a war is termed, so it MUST emit delete_dibs_alert
	 * — previously it silently dropped the records and orphaned the messages.
	 */
	private clearDibsForFaction(factionId: number): boolean {
		let removed = false;
		for (const [targetId, dibs] of this.activeDibs.entries()) {
			if (dibs.factionId === undefined || dibs.factionId === factionId) {
				this.deleteDibsMessage(dibs);
				this.activeDibs.delete(targetId);
				removed = true;
			}
		}
		return removed;
	}

	/**
	 * Core evaluation loop called on each 1-second war update cycle.
	 */
	async processWarHospitalQueue(
		hospitalQueue: (RankedWarOpponent & {
			secondsRemaining: number;
			fairFight: number;
		})[],
		war: CurrentWarInfo,
		factionId: number = PRIMARY_SUBVERSIVE_FACTION_ID,
	): Promise<void> {
		const scopedFactionId = resolveSubversiveFactionId(factionId);
		const config = await this.getConfig(scopedFactionId);

		if (!config.enabled) {
			if (this.clearDibsForFaction(scopedFactionId)) {
				this.notifyBroadcast();
			}
			return;
		}

		// `lastUpdated` is only ever stamped by a war snapshot Torn actually
		// answered, so a placeholder (never populated) is not evidence that the
		// war ended. Clearing on it would wipe live dibs for the whole faction.
		if (war.lastUpdated <= 0) return;

		if (war.state !== "active" && war.state !== "scheduled") {
			if (this.clearDibsForFaction(scopedFactionId)) {
				this.notifyBroadcast();
			}
			return;
		}

		const nowSec = Math.floor(Date.now() / 1000);
		const leadTimeSec = config.claimLeadTime * 60;
		let stateChanged = false;

		const currentQueueIds = new Set<number>();
		const queueMap = new Map<
			number,
			RankedWarOpponent & { secondsRemaining: number; fairFight: number }
		>();

		for (const opp of hospitalQueue) {
			currentQueueIds.add(opp.id);
			queueMap.set(opp.id, opp);

			// 1. Check if eligible for Dibs (< leadTimeSec remaining)
			if (opp.secondsRemaining <= leadTimeSec && opp.secondsRemaining > 0) {
				if (!this.activeDibs.has(opp.id)) {
					const until =
						opp.status.until !== null && opp.status.until > 0
							? opp.status.until
							: nowSec + opp.secondsRemaining;

					const record: DibsRecord = {
						targetId: opp.id,
						factionId: scopedFactionId,
						targetName: opp.name,
						targetLevel: opp.level,
						estimatedBs: opp.estimatedBs,
						fairFight: opp.fairFight,
						hospitalUntil: until,
						status: "open",
						createdAt: Date.now(),
						discordChannelId: config.channelId ?? undefined,
					};

					this.activeDibs.set(opp.id, record);
					stateChanged = true;

					// Send alert to Discord Bot if a dibs channel is configured
					if (config.channelId) {
						void notifyBotAction("post_dibs_alert", {
							channelId: config.channelId,
							dibs: record,
						});
					}
				}
			}
		}

		// 2. Lifecycle management for existing active dibs
		//
		// The hospital queue is derived from the faction's opponent roster, so a
		// target missing from it normally means "left hospital". It also means
		// "we have no roster at all": a failed or not-yet-arrived roster poll
		// leaves the cache empty, which is a data gap rather than a fact. Acting
		// on it deletes live claims as if every target had been downed (and, once
		// the roster returns, releases genuinely held locks). Only a populated
		// roster may justify a lifecycle transition.
		const rosterKnown =
			subversiveTargetCache.getWarOpponents(scopedFactionId).length > 0;
		const timeoutMs = config.postHospTimeoutSeconds * 1000;
		const nowMs = Date.now();

		for (const [targetId, dibs] of this.activeDibs.entries()) {
			if ((dibs.factionId ?? scopedFactionId) !== scopedFactionId) continue;
			const currentOpp = queueMap.get(targetId);

			if (currentOpp) {
				// Target is still in hospital
				if (dibs.exitHospAt !== undefined) {
					// Target was previously out of hospital and is now BACK in hospital -> DOWNED!
					logger.info(
						`Dibs for ${dibs.targetName} [${targetId}] (faction ${scopedFactionId}) dropped: target re-entered hospital${
							dibs.status === "claimed" ? " while claimed" : ""
						}.`,
					);
					if (
						config.autoDeleteOnDowned &&
						dibs.discordChannelId &&
						dibs.discordMessageId
					) {
						void notifyBotAction("delete_dibs_alert", {
							channelId: dibs.discordChannelId,
							messageId: dibs.discordMessageId,
							targetId: dibs.targetId,
						});
					}
					this.activeDibs.delete(targetId);
					stateChanged = true;
					continue;
				}

				// Check if hospital timer jumped into the future by > 3 minutes while claimed -> direct down!
				if (
					dibs.status === "claimed" &&
					currentOpp.status.until !== null &&
					currentOpp.status.until > dibs.hospitalUntil + 180
				) {
					if (
						config.autoDeleteOnDowned &&
						dibs.discordChannelId &&
						dibs.discordMessageId
					) {
						void notifyBotAction("delete_dibs_alert", {
							channelId: dibs.discordChannelId,
							messageId: dibs.discordMessageId,
							targetId: dibs.targetId,
						});
					}
					this.activeDibs.delete(targetId);
					stateChanged = true;
					continue;
				}

				// Target remains in hospital: keep until timestamp synchronized
				if (currentOpp.status.until !== null) {
					dibs.hospitalUntil = currentOpp.status.until;
				}
			} else if (rosterKnown) {
				// Target is no longer in the hospital queue (exited hospital or medded out)
				if (dibs.exitHospAt === undefined) {
					dibs.exitHospAt = nowMs;
				}

				// Check if > postHospTimeoutSeconds has passed after hospital exit and any active RW hit cooldown
				const isWarActive =
					war.state === "active" ||
					(war.state === "scheduled" &&
						Boolean(war.start) &&
						Math.floor(nowMs / 1000) >= (war.start ?? 0) &&
						war.winner === null);
				const rwCooldownMs = isWarActive ? 60_000 : 0;
				const elapsed = nowMs - (dibs.exitHospAt + rwCooldownMs);
				if (elapsed >= timeoutMs) {
					if (dibs.status === "claimed") {
						// 20s lock expired! Release claim and repost message
						logger.info(
							`Dibs lock expired for ${dibs.targetName} [${targetId}] (faction ${scopedFactionId}): released from ${
								dibs.claimedBy?.tornName ??
								dibs.claimedBy?.discordTag ??
								"claimant"
							} and reposted as open.`,
						);
						const oldMessageId = dibs.discordMessageId;
						const channelId = dibs.discordChannelId;
						dibs.status = "open";
						dibs.claimedBy = undefined;
						dibs.claimedAt = undefined;
						dibs.exitHospAt = undefined;
						dibs.discordMessageId = undefined;
						stateChanged = true;

						if (channelId && oldMessageId) {
							void notifyBotAction("delete_dibs_alert", {
								channelId,
								messageId: oldMessageId,
								targetId: dibs.targetId,
							});
							void notifyBotAction("post_dibs_alert", {
								channelId,
								dibs,
							});
						}
					} else if (elapsed >= 60_000) {
						// Unclaimed target out of hospital for > 60s: clean up
						if (dibs.discordChannelId && dibs.discordMessageId) {
							void notifyBotAction("delete_dibs_alert", {
								channelId: dibs.discordChannelId,
								messageId: dibs.discordMessageId,
								targetId: dibs.targetId,
							});
						}
						this.activeDibs.delete(targetId);
						stateChanged = true;
					}
				}
			}
		}

		if (stateChanged) {
			this.notifyBroadcast();
		} else {
			// No transition this cycle, but the hospital-until / exit bookkeeping
			// above may have moved. The store drops the write when nothing changed,
			// so this stays free while the board is quiet.
			this.schedulePersist();
		}
	}

	/**
	 * Claims a target atomically.
	 */
	async claimDibs(
		targetId: number,
		claimant: DibsClaimant,
		claimantFactionId?: number | null,
	): Promise<{ success: boolean; reason?: string; dibs?: DibsRecord }> {
		const factionId = resolveSubversiveFactionId(claimantFactionId);
		const config = await this.getConfig(factionId);
		if (!config.enabled) {
			return { success: false, reason: "War dibs is currently disabled." };
		}

		let dibs = this.activeDibs.get(targetId);
		if (dibs && dibs.factionId !== undefined && dibs.factionId !== factionId) {
			return {
				success: false,
				reason:
					"Target belongs to another faction's ranked war and cannot be claimed.",
			};
		}
		if (!dibs) {
			// On-demand evaluation for target if in active/scheduled war hospital queue
			const war = subversiveTargetCache.getWarState(factionId);
			if (war.state === "active" || war.state === "scheduled") {
				const opp = subversiveTargetCache.getWarOpponent(targetId, factionId);
				// Same gate as the hospital queue: a member hospitalised overseas is
				// reported with the Hospital state but cannot be attacked from Torn, so
				// it is not a dibs target however close its timer is.
				if (opp && isInTornHospital(opp.status)) {
					const nowSec = Math.floor(Date.now() / 1000);
					const until =
						opp.status.until !== null && opp.status.until > 0
							? opp.status.until
							: nowSec;
					const secondsRemaining = Math.max(0, until - nowSec);
					const leadTimeSec = config.claimLeadTime * 60;
					if (
						secondsRemaining <= leadTimeSec &&
						(secondsRemaining > 0 || opp.hasEarlyDischarge)
					) {
						const rawFF =
							opp.estimatedScore > 0
								? 1 + (8 / 3) * (opp.estimatedScore / 1)
								: 1.0;
						const fairFight = Math.max(1.0, Number(rawFF.toFixed(2)));
						const createdDibs: DibsRecord = {
							targetId: opp.id,
							factionId,
							targetName: opp.name,
							targetLevel: opp.level,
							estimatedBs: opp.estimatedBs,
							fairFight,
							hospitalUntil: until,
							status: "open",
							createdAt: Date.now(),
							discordChannelId: config.channelId ?? undefined,
						};
						dibs = createdDibs;
						this.activeDibs.set(opp.id, createdDibs);
						// The claim below may still be rejected (already claimed, limit
						// reached), so persist the new record on its own merits.
						this.schedulePersist();

						// Send alert to Discord Bot if a dibs channel is configured
						if (config.channelId) {
							void notifyBotAction("post_dibs_alert", {
								channelId: config.channelId,
								dibs,
							});
						}
					}
				}
			}
		}

		if (!dibs) {
			return {
				success: false,
				reason: "Target is not currently available for dibs.",
			};
		}

		if (dibs.status === "claimed") {
			const byName =
				dibs.claimedBy?.tornName ??
				dibs.claimedBy?.discordTag ??
				"another member";
			return {
				success: false,
				reason: `Target is already claimed by ${byName}.`,
			};
		}

		// Check claimant's active dibs count (scoped to the claimant's own faction)
		let userActiveClaims = 0;
		for (const d of this.activeDibs.values()) {
			if (d.status === "claimed" && (d.factionId ?? factionId) === factionId) {
				const matchTorn =
					claimant.tornId !== undefined &&
					d.claimedBy?.tornId !== undefined &&
					d.claimedBy.tornId === claimant.tornId;
				const matchDiscord =
					claimant.discordId !== undefined &&
					d.claimedBy?.discordId !== undefined &&
					d.claimedBy.discordId === claimant.discordId;

				if (matchTorn || matchDiscord) {
					userActiveClaims++;
				}
			}
		}

		if (userActiveClaims >= config.maxDibsPerPerson) {
			return {
				success: false,
				reason: `Maximum claim limit of ${config.maxDibsPerPerson} reached.`,
			};
		}

		// Atomic claim lock
		dibs.status = "claimed";
		dibs.claimedBy = claimant;
		dibs.claimedAt = Date.now();

		if (dibs.discordChannelId && dibs.discordMessageId) {
			void notifyBotAction("edit_dibs_alert", {
				channelId: dibs.discordChannelId,
				messageId: dibs.discordMessageId,
				status: "claimed",
				dibs,
			});
		}

		this.notifyBroadcast();
		return { success: true, dibs };
	}

	/**
	 * Releases an existing claim if held by the claimant.
	 */
	async releaseDibs(
		targetId: number,
		claimant: { tornId?: number; discordId?: string },
		claimantFactionId?: number | null,
	): Promise<{ success: boolean; reason?: string }> {
		const dibs = this.activeDibs.get(targetId);
		if (!dibs) {
			return { success: false, reason: "Dibs target not found." };
		}

		if (
			dibs.factionId !== undefined &&
			dibs.factionId !== resolveSubversiveFactionId(claimantFactionId)
		) {
			return {
				success: false,
				reason:
					"Target belongs to another faction's ranked war and cannot be released.",
			};
		}

		if (dibs.status !== "claimed") {
			return { success: false, reason: "Target is not currently claimed." };
		}

		const matchTorn =
			claimant.tornId !== undefined &&
			dibs.claimedBy?.tornId !== undefined &&
			dibs.claimedBy.tornId === claimant.tornId;
		const matchDiscord =
			claimant.discordId !== undefined &&
			dibs.claimedBy?.discordId !== undefined &&
			dibs.claimedBy.discordId === claimant.discordId;

		if (!matchTorn && !matchDiscord) {
			return {
				success: false,
				reason: "You do not hold the claim on this target.",
			};
		}

		dibs.status = "open";
		dibs.claimedBy = undefined;
		dibs.claimedAt = undefined;
		dibs.exitHospAt = undefined;

		if (dibs.discordChannelId && dibs.discordMessageId) {
			void notifyBotAction("edit_dibs_alert", {
				channelId: dibs.discordChannelId,
				messageId: dibs.discordMessageId,
				status: "open",
				dibs,
			});
		}

		this.notifyBroadcast();
		return { success: true };
	}

	/**
	 * Pushes the board to WebSocket subscribers and queues it for persistence.
	 *
	 * Every accepted change to the board goes through here, so a claim can never
	 * reach a member without also becoming durable.
	 */
	private notifyBroadcast(): void {
		this.schedulePersist();

		if (this.broadcastCallback) {
			try {
				this.broadcastCallback(this.getActiveDibs());
			} catch (err) {
				logger.warn("Error notifying dibs broadcast:", err);
			}
		}
	}
}

export const subversiveDibsManager = new SubversiveDibsManager();
if (process.env.NODE_ENV !== "test" && !process.env.BUN_TEST) {
	subversiveDibsManager.startEvaluationLoop();
	// Channel maintenance: clears orphaned/expired dibs callouts left behind by
	// termed wars, API restarts, or failed IPC deliveries.
	subversiveDibsManager.startSweepLoop();
}
