import { db, eq, systemStates } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_DIBS_CONFIG,
	type DibsClaimant,
	type DibsRecord,
	type SubversiveDibsConfig,
} from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";
import { notifyBotAction } from "./bot-ipc";
import type {
	CurrentWarInfo,
	RankedWarOpponent,
} from "./subversive-target-cache";

const logger = new Logger("API", "SubversiveDibsManager");
const DIBS_CONFIG_ID = "subversive:dibs_config";

class SubversiveDibsManager {
	private config: SubversiveDibsConfig = { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG };
	private configLoaded = false;
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
	 */
	setConfigForTesting(config?: Partial<SubversiveDibsConfig>): void {
		this.config = { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG, ...config };
		this.configLoaded = true;
	}

	/**
	 * Retrieves the current Dibs configuration, loading from systemStates on first run.
	 */
	async getConfig(): Promise<SubversiveDibsConfig> {
		if (this.configLoaded) {
			return this.config;
		}

		try {
			const [entry] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, DIBS_CONFIG_ID));

			if (entry?.data) {
				this.config = {
					...DEFAULT_SUBVERSIVE_DIBS_CONFIG,
					...(entry.data as Partial<SubversiveDibsConfig>),
				};
			} else {
				this.config = { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG };
			}
			this.configLoaded = true;
		} catch (err) {
			logger.warn("Failed to load dibs config from database:", err);
			this.config = { ...DEFAULT_SUBVERSIVE_DIBS_CONFIG };
			this.configLoaded = true;
		}

		return this.config;
	}

	/**
	 * Updates the Dibs configuration in the database and updates RAM cache.
	 */
	async updateConfig(
		patch: Partial<SubversiveDibsConfig>,
		updatedBy = "admin",
	): Promise<SubversiveDibsConfig> {
		const current = await this.getConfig();
		const updated: SubversiveDibsConfig = {
			...current,
			...patch,
			updatedAt: new Date().toISOString(),
			updatedBy,
		};

		await db
			.insert(systemStates)
			.values({
				id: DIBS_CONFIG_ID,
				init: true,
				data: updated as unknown as Record<string, unknown>,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					data: updated as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				},
			});

		this.config = updated;
		this.configLoaded = true;
		logger.info("Updated Subversive Dibs configuration successfully.");
		return this.config;
	}

	/**
	 * Returns all currently active Dibs records.
	 */
	getActiveDibs(): DibsRecord[] {
		return Array.from(this.activeDibs.values());
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
		}
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
	): Promise<void> {
		const config = await this.getConfig();
		if (
			!config.enabled ||
			(war.state !== "active" && war.state !== "scheduled")
		) {
			if (this.activeDibs.size > 0) {
				this.activeDibs.clear();
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
						targetName: opp.name,
						targetLevel: opp.level,
						estimatedBs: opp.estimatedBs,
						fairFight: opp.fairFight,
						hospitalUntil: until,
						status: "open",
						createdAt: Date.now(),
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

				// Check if > postHospTimeoutSeconds has passed
				const elapsed = nowMs - dibs.exitHospAt;
				if (elapsed >= timeoutMs) {
					if (dibs.status === "claimed") {
						// 20s lock expired! Release claim
						dibs.status = "open";
						dibs.claimedBy = undefined;
						dibs.claimedAt = undefined;
						dibs.exitHospAt = undefined;
						stateChanged = true;

						if (dibs.discordChannelId && dibs.discordMessageId) {
							void notifyBotAction("edit_dibs_alert", {
								channelId: dibs.discordChannelId,
								messageId: dibs.discordMessageId,
								status: "open",
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
	): Promise<{ success: boolean; reason?: string; dibs?: DibsRecord }> {
		const config = await this.getConfig();
		if (!config.enabled) {
			return { success: false, reason: "War dibs is currently disabled." };
		}

		const dibs = this.activeDibs.get(targetId);
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

		// Check claimant's active dibs count
		let userActiveClaims = 0;
		for (const d of this.activeDibs.values()) {
			if (d.status === "claimed") {
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
	): Promise<{ success: boolean; reason?: string }> {
		const dibs = this.activeDibs.get(targetId);
		if (!dibs) {
			return { success: false, reason: "Dibs target not found." };
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
