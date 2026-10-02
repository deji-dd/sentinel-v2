import {
	and,
	db,
	eq,
	getMercChannelConfig,
	getMercContractSummary,
	guildConfigs,
	inArray,
	type MercContract,
	mapRowToMercContract,
	mercContracts,
} from "@sentinel/database";
import type { FactionMember } from "@sentinel/schemas";
import { getPlayerStats, TornApiClient, TornError } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { notifyBotAction } from "@sentinel/utils/ipc";
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
}

export class MercTargetManager {
	private alerts = new Map<string, MercActiveTargetAlert>();
	private statsCache = new Map<number, number>();

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
		}
	}

	async claimTarget(
		contractId: string,
		targetId: number,
		claimant: MercClaimant,
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

		alert.status = "claimed";
		alert.claimedBy = claimant;
		alert.claimedAt = Date.now();

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
	}

	async resolveEstimatedBs(memberId: number, level: number): Promise<number> {
		const cached = this.statsCache.get(memberId);
		if (cached) return cached;

		try {
			const [ffResult] = await getPlayerStats([memberId]);
			if (ffResult?.bs_estimate && ffResult.bs_estimate > 0) {
				this.statsCache.set(memberId, ffResult.bs_estimate);
				return ffResult.bs_estimate;
			}
		} catch {}

		const approxBs = Math.max(10_000, level * 50_000);
		this.statsCache.set(memberId, approxBs);
		return approxBs;
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
		if (statusState === "Online" && termsStatuses.online) {
			isActivityAllowed = true;
		} else if (statusState === "Idle" && termsStatuses.idle) {
			const idleMinutes = Math.max(
				0,
				Math.floor((nowSec - (m.last_action?.timestamp ?? nowSec)) / 60),
			);
			const maxIdle = effectiveTerms?.idleDurationMinutes ?? 15;
			if (idleMinutes <= maxIdle) {
				isActivityAllowed = true;
			}
		} else if (statusState === "Offline" && termsStatuses.offline) {
			isActivityAllowed = true;
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

		const isHospitalLead =
			targetState === "Hospital" && secondsInHosp <= 60 && secondsInHosp > 0;
		const isOkay = targetState === "Okay";

		// Ranked War 60-second cooldown rule:
		// If target was previously in hospital and now is Okay, and faction is in active Ranked War
		let rwCooldownUntil: number | null = null;
		if (isOkay && contract.warStatusAtCreation === "active") {
			if (existingAlert?.wasInHospital) {
				const exitTime = existingAlert.hospitalExitTime ?? nowSec;
				if (!existingAlert.hospitalExitTime) {
					existingAlert.hospitalExitTime = exitTime;
				}
				if (nowSec < exitTime + 60) {
					rwCooldownUntil = exitTime + 60;
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
		const estimatedBs = await this.resolveEstimatedBs(m.id, m.level);
		const isStrickenEligible = Boolean(effectiveTerms?.strickenHits);

		if (!existingAlert) {
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
				wasInHospital: targetState === "Hospital",
				hospitalExitTime: isOkay ? nowSec : undefined,
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
		if (targetState === "Hospital") {
			existingAlert.wasInHospital = true;
		}
		existingAlert.hospitalUntil = isHospitalLead ? hospUntil : null;
		existingAlert.rwCooldownUntil = rwCooldownUntil;

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

		// 7. Claim expiration check: if claimed for > 20s without attack -> delete old & repost open alert with role ping
		if (
			existingAlert.status === "claimed" &&
			existingAlert.claimedAt &&
			nowMs >= existingAlert.claimedAt + 20_000
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
				`Claim expired (20s) for ${existingAlert.targetName} [${existingAlert.targetId}], reposting to #${channelName}`,
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

/**
 * Runs a single cycle of the Mercenary Contract Worker.
 * 1-second cadence when active or imminent contracts exist; 15s when idle.
 */
export async function runMercContractTrackingCycle(): Promise<number> {
	const nowMs = Date.now();
	const nowSec = Math.floor(nowMs / 1000);
	const imminentThreshold = new Date(nowMs + 5 * 60_000);

	// Periodically trigger bot to auto-archive channels for expired contract creation links
	if (nowMs >= lastExpiredTokenCheck + 30_000) {
		lastExpiredTokenCheck = nowMs;
		void notifyBotAction("check_expired_merc_tokens");
	}

	// 1. Fetch active and upcoming contracts
	const rows = await db
		.select()
		.from(mercContracts)
		.where(and(inArray(mercContracts.status, ["active", "upcoming"])));

	if (rows.length === 0) {
		return Date.now() + 15_000;
	}

	const contracts = rows.map(mapRowToMercContract);

	const relevantContracts: MercContract[] = [];

	for (const contract of contracts) {
		const startMs = new Date(contract.startTime).getTime();
		const endMs = contract.endTime
			? new Date(contract.endTime).getTime()
			: null;

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

		// Check if contract is starting within 5 minutes (lead-in) or active
		if (
			contract.status === "active" ||
			startMs <= imminentThreshold.getTime()
		) {
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
	const apiClient = new TornApiClient();

	for (const contract of relevantContracts) {
		const [guildConfig] = await db
			.select()
			.from(guildConfigs)
			.where(eq(guildConfigs.guildId, contract.guildId));

		const channelConfig = await getMercChannelConfig(contract.guildId);
		const targetsChannel = channelConfig.targets || "targets";
		const mercRoleId = guildConfig?.mercRoleId;

		const keyObj = await getNextSubversiveUserKey();
		if (!keyObj) {
			logger.warn(
				"No active script API keys available for merc contract target polling.",
			);
			continue;
		}

		try {
			const membersRes = (await apiClient.get("/faction/{id}/members", {
				apiKey: keyObj.apiKey,
				pathParams: { id: contract.factionId },
			})) as TornFactionMembersResponse;

			recordSubversiveKeySuccess(keyObj.apiKey);

			const members = membersRes.members ?? [];
			for (const m of members) {
				await mercTargetManager.processMember(
					contract,
					contract.guildId,
					targetsChannel,
					mercRoleId,
					m,
					nowSec,
					nowMs,
				);
			}
		} catch (err) {
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
		initialDelayMs: options?.initialDelayMs ?? 1000,
		handler: runMercContractTrackingCycle,
	});
};
