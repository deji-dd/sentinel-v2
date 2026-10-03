import { db, eq, systemStates } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_DIBS_CONFIG,
	type DibsClaimant,
	type DibsRecord,
	type SubversiveDibsConfig,
} from "@sentinel/schemas";
import {
	Logger,
	PRIMARY_SUBVERSIVE_FACTION_ID,
	resolveSubversiveFactionId,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";
import { notifyBotAction } from "./bot-ipc";
import {
	type CurrentWarInfo,
	type RankedWarOpponent,
	subversiveTargetCache,
} from "./subversive-target-cache";

const logger = new Logger("API", "SubversiveDibsManager");

/**
 * Legacy (pre per-faction) systemStates row id. Kept only so existing
 * Subversive Alliance settings survive the upgrade to faction-scoped rows.
 */
const LEGACY_DIBS_CONFIG_ID = "subversive:dibs_config";

/**
 * Dibs settings are stored per family faction so Subversive Alliance (2013)
 * and SA Succession (27312) can run the script with independent rules.
 */
function getDibsConfigKey(factionId: number): string {
	return `${LEGACY_DIBS_CONFIG_ID}:${factionId}`;
}

class SubversiveDibsManager {
	/** Per-faction config cache keyed by resolved faction id. */
	private configs = new Map<number, SubversiveDibsConfig>();
	private activeDibs = new Map<number, DibsRecord>();
	private broadcastCallback: ((dibs: DibsRecord[]) => void) | null = null;

	/**
	 * Sets the callback invoked whenever dibs records change so WebSockets can broadcast live.
	 */
	setBroadcastCallback(fn: (dibs: DibsRecord[]) => void): void {
		this.broadcastCallback = fn;
	}

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

	/**
	 * Starts background interval timer evaluating hospital queue countdowns.
	 */
	startEvaluationLoop(intervalMs = 1000): void {
		if (this.loopTimer) return;
		this.loopTimer = setInterval(() => {
			if (this.hasAnyEngagedWar()) {
				void this.evaluateHospitalQueue();
			} else if (this.activeDibs.size > 0) {
				this.activeDibs.clear();
				this.notifyBroadcast();
			}
		}, intervalMs);
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
	 * Persists a config row under the given systemStates id.
	 */
	private async persistConfigRow(
		rowId: string,
		config: SubversiveDibsConfig,
	): Promise<void> {
		await db
			.insert(systemStates)
			.values({
				id: rowId,
				init: true,
				data: config as unknown as Record<string, unknown>,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					data: config as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				},
			});
	}

	/**
	 * Reads one raw config row, returning null when absent.
	 */
	private async readConfigRow(
		rowId: string,
	): Promise<SubversiveDibsConfig | null> {
		const [entry] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, rowId));

		if (!entry?.data) return null;
		return {
			...DEFAULT_SUBVERSIVE_DIBS_CONFIG,
			...(entry.data as Partial<SubversiveDibsConfig>),
		};
	}

	/**
	 * Retrieves the Dibs configuration for one family faction, loading it from
	 * systemStates on first run and caching it thereafter.
	 *
	 * Migration: the pre-faction-scoped `subversive:dibs_config` row is treated as
	 * the Subversive Alliance (2013) config. When the keyed row is missing, the
	 * legacy row is read once and lazily re-persisted under the new key so the
	 * upgrade never loses existing settings.
	 */
	async getConfig(factionId?: number | null): Promise<SubversiveDibsConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const cached = this.configs.get(resolved);
		if (cached) return cached;

		let config: SubversiveDibsConfig = { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG };
		try {
			const keyed = await this.readConfigRow(getDibsConfigKey(resolved));
			if (keyed) {
				config = keyed;
			} else if (resolved === PRIMARY_SUBVERSIVE_FACTION_ID) {
				// Legacy single-faction row predating per-faction settings.
				const legacy = await this.readConfigRow(LEGACY_DIBS_CONFIG_ID);
				if (legacy) {
					config = legacy;
					await this.persistConfigRow(getDibsConfigKey(resolved), config);
					logger.info(
						"Migrated legacy Subversive dibs config to faction-scoped row.",
					);
				}
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
		const updated: SubversiveDibsConfig = {
			...current,
			...patch,
			updatedAt: new Date().toISOString(),
			updatedBy,
		};

		await this.persistConfigRow(getDibsConfigKey(resolved), updated);

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
	 * Associates a Discord message ID and channel ID with an active Dibs record.
	 */
	recordDiscordMessage(
		targetId: number,
		channelId: string,
		messageId: string,
	): void {
		const dibs = this.activeDibs.get(targetId);
		if (dibs) {
			dibs.discordChannelId = channelId;
			dibs.discordMessageId = messageId;

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
	}

	/**
	 * Clears all dibs belonging to a single faction. Returns true when something was removed.
	 */
	private clearDibsForFaction(factionId: number): boolean {
		let removed = false;
		for (const [targetId, dibs] of this.activeDibs.entries()) {
			if (dibs.factionId === undefined || dibs.factionId === factionId) {
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
		if (
			!config.enabled ||
			(war.state !== "active" && war.state !== "scheduled")
		) {
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
		const timeoutMs = config.postHospTimeoutSeconds * 1000;
		const nowMs = Date.now();

		for (const [targetId, dibs] of this.activeDibs.entries()) {
			if ((dibs.factionId ?? scopedFactionId) !== scopedFactionId) continue;
			const currentOpp = queueMap.get(targetId);

			if (currentOpp) {
				// Target is still in hospital
				if (dibs.exitHospAt !== undefined) {
					// Target was previously out of hospital and is now BACK in hospital -> DOWNED!
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
			} else {
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
				if (opp) {
					const nowSec = Math.floor(Date.now() / 1000);
					const state = opp.status.state?.toLowerCase() ?? "";
					if (state === "hospital") {
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

	private notifyBroadcast(): void {
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
}
