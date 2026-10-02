import { apiRequest } from "../api/client";
import { isWarEngaged, state } from "../state";
import type { DibsItem, WarTarget } from "../types";
import {
	formatSeconds,
	formatStats,
	getFFColor,
	getFFTier,
} from "../utils/formatters";

let hospContainer: HTMLElement | null = null;
let tabHospCount: HTMLElement | null = null;
let setStatusFn: ((msg: string, type: "ok" | "error") => void) | null = null;

export function initHospitalElements(
	root: ShadowRoot | Document,
	setStatus: (msg: string, type: "ok" | "error") => void,
): void {
	hospContainer = (root.getElementById("satf-hosp-container") ||
		root.getElementById("satf-hosp-queue")) as HTMLElement | null;
	tabHospCount = root.getElementById(
		"satf-war-hosp-count",
	) as HTMLElement | null;
	setStatusFn = setStatus;
}

export function updateHospCountdowns(): void {
	if (!hospContainer) return;
	const nowSec = Math.floor(Date.now() / 1000);
	const leadTimeSec = state.dibsLeadTimeSeconds || 300;
	const rows = hospContainer.querySelectorAll<HTMLElement>(".satf-queue-row");

	rows.forEach((row) => {
		const until = Number.parseInt(row.getAttribute("data-until") ?? "", 10);
		const timeElem = row.querySelector<HTMLElement>(".satf-queue-time");
		if (!timeElem || Number.isNaN(until)) return;

		const remaining = Math.max(0, until - nowSec);
		if (remaining > 0) {
			timeElem.textContent = formatSeconds(remaining);
			timeElem.classList.remove("ready");
		} else {
			timeElem.textContent = "READY";
			timeElem.classList.add("ready");
		}

		const id = Number(row.getAttribute("data-id"));
		const rightContainer = row.querySelector<HTMLElement>(".satf-queue-right");
		if (!rightContainer) return;

		const countdownElem = rightContainer.querySelector<HTMLElement>(
			".satf-dibs-countdown",
		);
		const claimBtn =
			rightContainer.querySelector<HTMLElement>(".satf-dibs-claim");
		const claimedLabel = rightContainer.querySelector<HTMLElement>(
			".satf-dibs-claimed-label",
		);
		const attackBtn =
			rightContainer.querySelector<HTMLElement>(".satf-dibs-attack");

		if (remaining > leadTimeSec) {
			const dibsIn = remaining - leadTimeSec;
			if (countdownElem) {
				countdownElem.textContent = `Dibs in ${formatSeconds(dibsIn)}`;
			} else if (!claimBtn && !claimedLabel) {
				const span = document.createElement("span");
				span.className = "satf-dibs-countdown";
				span.textContent = `Dibs in ${formatSeconds(dibsIn)}`;
				rightContainer.appendChild(span);
			}
		} else if (remaining <= leadTimeSec && remaining > 0) {
			if (countdownElem) countdownElem.remove();
			if (!claimBtn && !claimedLabel && !attackBtn) {
				const btn = document.createElement("button");
				btn.className = "satf-dibs-btn satf-dibs-claim";
				btn.setAttribute("data-id", String(id));
				btn.textContent = "Dibs";
				btn.addEventListener("click", async (e) => {
					e.stopPropagation();
					btn.disabled = true;
					btn.textContent = "...";
					try {
						const res = await apiRequest<{ dibs?: DibsItem }>(
							"/v2/subversive/dibs/claim",
							{
								method: "POST",
								body: { targetId: id },
							},
						);
						if (res.dibs) {
							state.dibs.set(id, res.dibs);
							renderHospitalQueue(state.hospitalQueue);
						}
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						if (setStatusFn) setStatusFn(msg, "error");
						btn.disabled = false;
						btn.textContent = "Dibs";
					}
				});
				rightContainer.appendChild(btn);
			}
		} else if (remaining === 0) {
			if (countdownElem) countdownElem.remove();
			const currentTornId = state.user?.tornId;
			const dibsRecord = state.dibs.get(id);
			const isYou =
				currentTornId &&
				(dibsRecord as unknown as { claimedBy?: { tornId?: number } })
					?.claimedBy?.tornId === currentTornId;
			if (isYou && !attackBtn) {
				const releaseBtn =
					rightContainer.querySelector<HTMLElement>(".satf-dibs-release");
				if (releaseBtn) releaseBtn.remove();
				const newAttackBtn = document.createElement("button");
				newAttackBtn.className = "satf-dibs-btn satf-dibs-attack";
				newAttackBtn.setAttribute("data-id", String(id));
				newAttackBtn.textContent = "Attack";
				newAttackBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					window.open(
						`https://www.torn.com/page.php?sid=attack&user2ID=${id}`,
						"_blank",
					);
				});
				rightContainer.appendChild(newAttackBtn);
			}
		}
	});
}

export function startHospTimer(): void {
	stopHospTimer();
	state.hospTimer = setInterval(updateHospCountdowns, 1000);
}

export function stopHospTimer(): void {
	if (state.hospTimer) {
		clearInterval(state.hospTimer);
		state.hospTimer = null;
	}
}

export function renderHospitalQueue(queue: WarTarget[] = []): void {
	if (!hospContainer) return;
	if (!isWarEngaged()) {
		state.hospitalQueue = [];
		if (tabHospCount) tabHospCount.textContent = "0";
		hospContainer.innerHTML = `
			<div style="text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px;">
				No active or scheduled ranked war. Hospital queue on standby.
			</div>
		`;
		stopHospTimer();
		return;
	}

	const nowSec = Math.floor(Date.now() / 1000);
	state.hospitalQueue = queue.map((item) => {
		const ff =
			typeof item.fairFight === "number" && !Number.isNaN(item.fairFight)
				? item.fairFight
				: 1.0;
		return {
			...item,
			fairFight: ff,
			status: {
				state: item.status?.state ?? "hospital",
				until:
					item.status?.until ||
					nowSec +
						Math.max(
							0,
							(item as unknown as { secondsRemaining?: number })
								.secondsRemaining || 0,
						),
			},
		};
	});

	if (tabHospCount)
		tabHospCount.textContent = String(state.hospitalQueue.length);

	if (state.hospitalQueue.length === 0) {
		hospContainer.innerHTML = `
			<div style="text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px;">
				No opponents currently in hospital.
			</div>
		`;
		stopHospTimer();
		return;
	}

	const currentTornId = state.user?.tornId;
	const leadTimeSec = state.dibsLeadTimeSeconds || 300;

	hospContainer.innerHTML = state.hospitalQueue
		.map((item) => {
			const dischargePill = item.hasEarlyDischarge
				? '<span class="satf-badge-pill status-discharge">[DISCHARGE]</span>'
				: "";
			const until = item.status?.until ?? nowSec;
			const remaining = Math.max(0, until - nowSec);
			const dibsRecord = state.dibs.get(item.id) as unknown as
				| {
						status?: string;
						claimedBy?: {
							tornId?: number;
							tornName?: string;
							discordTag?: string;
						};
				  }
				| undefined;

			let dibsHtml = "";
			if (dibsRecord && dibsRecord.status === "claimed") {
				const isYou =
					currentTornId && dibsRecord.claimedBy?.tornId === currentTornId;
				if (isYou) {
					dibsHtml = `
						<span class="satf-dibs-claimed-label you">Claimed (You)</span>
						<button class="satf-dibs-btn satf-dibs-release" data-id="${item.id}" title="Release Dibs">Release</button>
					`;
				} else {
					const hasTorn =
						dibsRecord.claimedBy?.tornName && dibsRecord.claimedBy?.tornId;
					const displayName = hasTorn
						? `${dibsRecord.claimedBy?.tornName} [${dibsRecord.claimedBy?.tornId}]`
						: dibsRecord.claimedBy?.tornName ||
							dibsRecord.claimedBy?.discordTag ||
							"Teammate";
					const profileLink = dibsRecord.claimedBy?.tornId
						? `<a href="/profiles.php?XID=${dibsRecord.claimedBy.tornId}" target="_blank" style="color:inherit; text-decoration:underline;">${displayName}</a>`
						: displayName;
					dibsHtml = `<span class="satf-dibs-claimed-label" title="Claimed by ${displayName}">Claimed: ${profileLink}</span>`;
				}
			} else if (remaining <= leadTimeSec && remaining > 0) {
				dibsHtml = `<button class="satf-dibs-btn satf-dibs-claim" data-id="${item.id}">Dibs</button>`;
			} else if (remaining > leadTimeSec) {
				const dibsIn = remaining - leadTimeSec;
				dibsHtml = `<span class="satf-dibs-countdown" data-id="${item.id}">Dibs in ${formatSeconds(dibsIn)}</span>`;
			} else if (remaining === 0) {
				const isYou =
					currentTornId && dibsRecord?.claimedBy?.tornId === currentTornId;
				if (isYou) {
					dibsHtml = `<button class="satf-dibs-btn satf-dibs-attack" data-id="${item.id}">Attack</button>`;
				}
			}

			return `
				<div class="satf-queue-row" data-id="${item.id}" data-until="${until}">
					<div class="satf-roster-left">
						<div class="satf-roster-name">
							<span style="font-weight:700;">${item.name}</span>
							<span style="color:var(--muted); font-size:11px;">[${item.id}] Lvl ${item.level}</span>
							${dischargePill}
						</div>
						<div class="satf-roster-sub">
							BS ${formatStats(item.estimatedBs)} · <span class="ff-${getFFTier(item.fairFight)}" style="font-weight:700; color:${getFFColor(item.fairFight)};">FF: ${item.fairFight.toFixed(2)}</span>
						</div>
					</div>
					<div class="satf-queue-right">
						<div class="satf-queue-time ${remaining === 0 ? "ready" : ""}">${remaining === 0 ? "READY" : formatSeconds(remaining)}</div>
						${dibsHtml}
					</div>
				</div>
			`;
		})
		.join("");

	hospContainer
		.querySelectorAll<HTMLElement>(".satf-queue-row")
		.forEach((row) => {
			row.addEventListener("click", () => {
				const id = row.getAttribute("data-id");
				if (id) {
					window.open(`https://www.torn.com/profiles.php?XID=${id}`, "_blank");
				}
			});
		});

	hospContainer
		.querySelectorAll<HTMLButtonElement>(".satf-dibs-claim")
		.forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const id = Number(btn.getAttribute("data-id"));
				if (!id) return;
				btn.disabled = true;
				btn.textContent = "...";
				try {
					const res = await apiRequest<{ dibs?: DibsItem }>(
						"/v2/subversive/dibs/claim",
						{
							method: "POST",
							body: { targetId: id },
						},
					);
					if (res.dibs) {
						state.dibs.set(id, res.dibs);
						renderHospitalQueue(state.hospitalQueue);
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					if (setStatusFn) setStatusFn(msg, "error");
					btn.disabled = false;
					btn.textContent = "Dibs";
				}
			});
		});

	hospContainer
		.querySelectorAll<HTMLButtonElement>(".satf-dibs-release")
		.forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const id = Number(btn.getAttribute("data-id"));
				if (!id) return;
				btn.disabled = true;
				btn.textContent = "...";
				try {
					await apiRequest("/v2/subversive/dibs/release", {
						method: "POST",
						body: { targetId: id },
					});
					state.dibs.delete(id);
					renderHospitalQueue(state.hospitalQueue);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					if (setStatusFn) setStatusFn(msg, "error");
					btn.disabled = false;
					btn.textContent = "Release";
				}
			});
		});

	hospContainer
		.querySelectorAll<HTMLButtonElement>(".satf-dibs-attack")
		.forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const id = btn.getAttribute("data-id");
				if (id) {
					window.open(
						`https://www.torn.com/page.php?sid=attack&user2ID=${id}`,
						"_blank",
					);
				}
			});
		});

	startHospTimer();
}

export async function fetchHospitalQueue(): Promise<void> {
	if (!state.token) return;

	if (!isWarEngaged()) {
		renderHospitalQueue([]);
		return;
	}

	try {
		const res = await apiRequest<{ queue?: WarTarget[] }>(
			"/v2/target-finder/war/hospital-queue?limit=25",
		);
		renderHospitalQueue(res.queue || []);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.debug("[Subversive Alliance] Failed to fetch hospital queue:", msg);
	}
}
