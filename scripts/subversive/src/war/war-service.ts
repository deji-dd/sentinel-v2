import { apiRequest, detectAttackerFlightState } from "../api/client";
import { STORAGE, SYNC_CONFIG } from "../constants";
import {
	isHudCyclingActive,
	registerHudActivityListener,
} from "../hud/attack-hud";
import { isWarEngaged, state } from "../state";
import type { CurrentWarInfo, WarTarget } from "../types";
import { formatStats } from "../utils/formatters";
import { fetchHospitalQueue, renderHospitalQueue } from "./hospital";
import {
	fetchAvailableTargets,
	getNextTargetCandidate,
	renderAvailableTargets,
} from "./roster";
import {
	renderWarBanner,
	stopCountdownTimer,
	updateWarCountdown,
} from "./war-banner";

let setStatusFn: ((msg: string, type: "ok" | "error") => void) | null = null;
let updateTravelLockFn: (() => void) | null = null;
let switchTabFn: ((tab: string) => void) | null = null;
let fetchBountiesFn: (() => Promise<void>) | null = null;
let btnGetTargetElem: HTMLButtonElement | null = null;

export function initWarService(params: {
	setStatus: (msg: string, type: "ok" | "error") => void;
	updateTravelLock: () => void;
	switchTab: (tab: string) => void;
	fetchBounties: () => Promise<void>;
	btnGetTarget?: HTMLButtonElement | null;
}): void {
	setStatusFn = params.setStatus;
	updateTravelLockFn = params.updateTravelLock;
	switchTabFn = params.switchTab;
	fetchBountiesFn = params.fetchBounties;
	btnGetTargetElem = params.btnGetTarget ?? null;
	registerHudActivityListener(() => evaluateSyncRate(true));
}

export async function fetchWarStatus(): Promise<void> {
	if (!state.token) return;
	try {
		const res = await apiRequest<{
			war?: CurrentWarInfo;
			opponentIds?: number[];
		}>("/api/v1/target-finder/war/status");
		if (res?.war) {
			state.war = res.war;
			state.warState = res.war.state;
			try {
				GM_setValue(STORAGE.warState, res.war.state);
			} catch {}
			renderWarBanner(res.war);
		}
		if (Array.isArray(res?.opponentIds)) {
			state.warOpponentIds = res.opponentIds;
			try {
				GM_setValue(STORAGE.warOpponentIds, res.opponentIds);
			} catch {}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.debug("[Subversive Alliance] Failed to fetch war status:", msg);
	}
}

export async function fetchNextTarget(
	options = { directLaunch: false },
): Promise<void> {
	if (!state.token) {
		if (switchTabFn) switchTabFn("settings");
		if (setStatusFn)
			setStatusFn("Enter Torn API Key in Settings to connect.", "error");
		return;
	}

	const flightState = detectAttackerFlightState();
	if (flightState !== "okay") {
		if (updateTravelLockFn) updateTravelLockFn();
		if (setStatusFn)
			setStatusFn("Target dispatch locked while traveling or abroad.", "error");
		return;
	}

	if (!isWarEngaged()) {
		if (setStatusFn) setStatusFn("No active or scheduled ranked war.", "error");
		return;
	}

	if (setStatusFn) setStatusFn("Acquiring optimal war target...", "ok");

	const candidate = getNextTargetCandidate();
	if (candidate) {
		state.currentTarget = candidate;
		GM_setValue(STORAGE.currentTarget, candidate);
		state.excludeIds.push(candidate.id);
		renderAvailableTargets();
		if (setStatusFn) {
			setStatusFn(
				`Target acquired · ${candidate.name} [${candidate.id}] · FF: ${candidate.fairFight.toFixed(2)}`,
				"ok",
			);
		}
		if (options.directLaunch || state.directAttack) {
			if (candidate.attackUrl) window.location.href = candidate.attackUrl;
		} else {
			window.open(
				`https://www.torn.com/profiles.php?XID=${candidate.id}`,
				"_blank",
			);
		}
		return;
	}

	try {
		const combinedExcludes = Array.from(
			new Set([...state.excludeIds.slice(-20), ...state.ignoredTargets]),
		);

		const params = new URLSearchParams({
			exclude: combinedExcludes.join(","),
			attackerState: flightState,
			maxFF: state.hideHighFF ? String(state.maxFFThreshold) : "10.0",
		});
		if (state.hideHighBS) {
			params.set("maxBS", String(state.maxBSThreshold));
		}

		const res = await apiRequest<{
			war?: CurrentWarInfo;
			target?: WarTarget;
			message?: string;
			reason?: string;
		}>(`/api/v1/target-finder/war/targets/next?${params.toString()}`);

		if (res.war) {
			state.war = res.war;
			renderWarBanner(res.war);
		}

		if (res.target) {
			if (state.hideHighFF && res.target.fairFight > state.maxFFThreshold) {
				if (setStatusFn)
					setStatusFn(
						`No opponents available within FF <= ${state.maxFFThreshold.toFixed(1)}`,
						"error",
					);
				return;
			}
			if (state.hideHighBS && res.target.estimatedBs > state.maxBSThreshold) {
				if (setStatusFn)
					setStatusFn(
						`No opponents available within BS <= ${formatStats(state.maxBSThreshold)}`,
						"error",
					);
				return;
			}
			state.currentTarget = res.target;
			GM_setValue(STORAGE.currentTarget, res.target);
			state.excludeIds.push(res.target.id);
			renderAvailableTargets();
			if (setStatusFn) {
				setStatusFn(
					`Target acquired · ${res.target.name} [${res.target.id}] · FF: ${res.target.fairFight.toFixed(2)}`,
					"ok",
				);
			}

			if (options.directLaunch || state.directAttack) {
				if (res.target.attackUrl) window.location.href = res.target.attackUrl;
			} else {
				window.open(
					`https://www.torn.com/profiles.php?XID=${res.target.id}`,
					"_blank",
				);
			}
		} else {
			if (setStatusFn)
				setStatusFn(
					res.message || res.reason || "No targets available.",
					"error",
				);
		}
	} catch (err: unknown) {
		const errorObj = err as {
			message?: string;
			data?: { war?: CurrentWarInfo };
		};
		if (errorObj?.data?.war) {
			state.war = errorObj.data.war;
			renderWarBanner(errorObj.data.war);
		}
		if (setStatusFn)
			setStatusFn(errorObj.message || "Failed to fetch target.", "error");
	} finally {
		if (updateTravelLockFn) updateTravelLockFn();
	}
}

export async function executeGetTarget(): Promise<void> {
	if (state.isTargetScouting) return;

	const flightState = detectAttackerFlightState();
	if (flightState !== "okay") {
		if (updateTravelLockFn) updateTravelLockFn();
		if (setStatusFn)
			setStatusFn("Target dispatch locked while traveling or abroad.", "error");
		return;
	}

	if (!state.token) {
		if (setStatusFn)
			setStatusFn("Please connect API key first in Settings.", "error");
		if (switchTabFn) switchTabFn("settings");
		return;
	}

	state.isTargetScouting = true;
	if (btnGetTargetElem) {
		btnGetTargetElem.textContent = "Scouting...";
		btnGetTargetElem.disabled = true;
	}
	if (setStatusFn)
		setStatusFn("Scouting target via on-demand profile verification...", "ok");

	try {
		const params = new URLSearchParams({
			minFF: state.minFFThreshold.toFixed(1),
			maxFF: state.maxFFThreshold.toFixed(1),
			ignore: state.ignoredTargets.join(","),
		});

		const res = await apiRequest<{
			target?: WarTarget;
			retryAfter?: number;
			message?: string;
		}>(`/api/v1/target-finder/targets/next?${params.toString()}`);

		if (res.target?.attackUrl) {
			state.currentTarget = res.target;
			GM_setValue(STORAGE.currentTarget, res.target);
			if (setStatusFn) {
				setStatusFn(
					`Target acquired · ${res.target.name} [${res.target.id}] · FF: ${res.target.fairFight.toFixed(2)}x`,
					"ok",
				);
			}
			if (btnGetTargetElem) {
				btnGetTargetElem.textContent = "Get Chain Target";
				btnGetTargetElem.disabled = false;
			}
			state.isTargetScouting = false;

			if (state.directAttack) {
				window.location.href = res.target.attackUrl;
			} else {
				window.open(res.target.attackUrl, "_blank");
			}
			return;
		}

		if (res.retryAfter) {
			let countdown = res.retryAfter || 5;
			if (setStatusFn)
				setStatusFn(
					`No targets currently available out of hospital. Resting ${countdown}s...`,
					"ok",
				);
			if (btnGetTargetElem) {
				btnGetTargetElem.textContent = `Rest ${countdown}s`;
				btnGetTargetElem.disabled = true;
			}
			if (state.scoutCooldownTimer) clearInterval(state.scoutCooldownTimer);
			state.scoutCooldownTimer = setInterval(() => {
				countdown--;
				if (countdown > 0) {
					if (btnGetTargetElem)
						btnGetTargetElem.textContent = `Rest ${countdown}s`;
					if (setStatusFn)
						setStatusFn(
							`No targets currently available out of hospital. Resting ${countdown}s...`,
							"ok",
						);
				} else {
					if (state.scoutCooldownTimer) clearInterval(state.scoutCooldownTimer);
					state.scoutCooldownTimer = null;
					state.isTargetScouting = false;
					if (btnGetTargetElem) {
						btnGetTargetElem.textContent = "Get Chain Target";
						btnGetTargetElem.disabled = false;
					}
					if (setStatusFn) setStatusFn("Ready", "ok");
				}
			}, 1000);
			return;
		}

		if (setStatusFn)
			setStatusFn(
				res.message || "No targets found matching criteria.",
				"error",
			);
		if (btnGetTargetElem) {
			btnGetTargetElem.textContent = "Get Chain Target";
			btnGetTargetElem.disabled = false;
		}
		state.isTargetScouting = false;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (setStatusFn) setStatusFn(`Failed to acquire target: ${msg}`, "error");
		if (btnGetTargetElem) {
			btnGetTargetElem.textContent = "Get Chain Target";
			btnGetTargetElem.disabled = false;
		}
		state.isTargetScouting = false;
	}
}

let isRampedUpActive = false;
let isSyncing = false;

export function shouldSyncFast(): boolean {
	return Boolean(state.panelOpen || isHudCyclingActive());
}

export async function executeSyncTick(isFastTick = false): Promise<void> {
	if (!state.token || isSyncing) return;
	isSyncing = true;
	try {
		// If long-polling is active and healthy, it pushes war status, targets, hospital queue, and dibs.
		// Only run full REST war polling as a fallback if long-polling is not active or on idle ticks.
		if (!isFastTick || !isLongPolling) {
			await fetchWarStatus();
			if (state.panelOpen) {
				if (state.activeTab === "war") {
					if (state.warSubTab === "hosp") {
						await fetchHospitalQueue();
					} else {
						await fetchAvailableTargets();
					}
				}
			} else if (isHudCyclingActive()) {
				// Modal is closed, but user is cycling through targets with the HUD!
				if (isWarEngaged()) {
					await Promise.allSettled([
						fetchAvailableTargets(),
						fetchHospitalQueue(),
					]);
				}
			}
		}

		if (state.activeTab === "bounties" && fetchBountiesFn) {
			await fetchBountiesFn();
		} else if (!isFastTick) {
			// Ramped-down idle tick
			if (fetchBountiesFn) {
				await fetchBountiesFn();
			}
		}
	} finally {
		isSyncing = false;
	}
}

let lastSeenWarVersion = 0;
let isLongPolling = false;

export async function runLongPollLoop(): Promise<void> {
	if (isLongPolling || !state.token) return;
	isLongPolling = true;

	while (shouldSyncFast() && state.token) {
		try {
			const params = new URLSearchParams({
				sinceVersion: String(lastSeenWarVersion),
				maxFF: state.hideHighFF ? String(state.maxFFThreshold) : "10.0",
			});
			if (state.hideHighBS) {
				params.set("maxBS", String(state.maxBSThreshold));
			}

			const res = await apiRequest<{
				success: boolean;
				modified: boolean;
				version: number;
				war?: CurrentWarInfo;
				targets?: WarTarget[];
				hospitalQueue?: WarTarget[];
				dibs?: Array<{ targetId: number; [key: string]: unknown }>;
				dibsLeadTimeSeconds?: number;
			}>(`/api/v1/target-finder/war/events?${params.toString()}`);

			if (res?.version) {
				lastSeenWarVersion = res.version;
			}

			if (res?.modified) {
				if (
					typeof res.dibsLeadTimeSeconds === "number" &&
					res.dibsLeadTimeSeconds > 0
				) {
					state.dibsLeadTimeSeconds = res.dibsLeadTimeSeconds;
				}
				if (res.war) {
					state.war = res.war;
					state.warState = res.war.state;
					try {
						GM_setValue(STORAGE.warState, res.war.state);
					} catch {}
					renderWarBanner(res.war);
				}
				if (Array.isArray(res.targets)) {
					renderAvailableTargets(res.targets);
				}
				if (Array.isArray(res.hospitalQueue)) {
					renderHospitalQueue(res.hospitalQueue);
				}
				if (Array.isArray(res.dibs)) {
					for (const d of res.dibs) {
						if (typeof d.targetId === "number") {
							state.dibs.set(d.targetId, d as never);
						}
					}
				}
			}
		} catch {
			// If reverse-polling network fails or times out, pause briefly before retrying
			await new Promise((r) => setTimeout(r, 1500));
		}
	}
	isLongPolling = false;
}

export function evaluateSyncRate(forceImmediate = false): void {
	const fast = shouldSyncFast();
	if (fast) {
		runLongPollLoop().catch(() => {});
		if (!isRampedUpActive || forceImmediate) {
			isRampedUpActive = true;
			stopAutoSync();
			executeSyncTick(true);
			state.syncTimer = setInterval(() => {
				if (!shouldSyncFast()) {
					evaluateSyncRate();
					return;
				}
				executeSyncTick(true);
			}, SYNC_CONFIG.FAST_INTERVAL_MS);
		}
	} else {
		if (isRampedUpActive || !state.syncTimer || forceImmediate) {
			isRampedUpActive = false;
			stopAutoSync();
			state.syncTimer = setInterval(() => {
				if (shouldSyncFast()) {
					evaluateSyncRate(true);
					return;
				}
				executeSyncTick(false);
			}, SYNC_CONFIG.SLOW_INTERVAL_MS);
		}
	}

	if (state.panelOpen && !state.countdownTimer) {
		state.countdownTimer = setInterval(() => {
			if (!state.panelOpen) return;
			updateWarCountdown();
		}, 1000);
	} else if (!state.panelOpen && state.countdownTimer) {
		stopCountdownTimer();
	}
}

export function startAutoSync(): void {
	evaluateSyncRate(true);
}

export function stopAutoSync(): void {
	if (state.syncTimer) {
		clearInterval(state.syncTimer);
		state.syncTimer = null;
	}
	stopCountdownTimer();
}
