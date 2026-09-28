import { detectAttackerFlightState } from "../api/client";
import { fetchBounties, renderBountyReadyTargets } from "../bounties/bounties";
import { STORAGE } from "../constants";
import { state } from "../state";
import { fetchHospitalQueue, stopHospTimer } from "../war/hospital";
import { renderAvailableTargets } from "../war/roster";
import {
	fetchWarStatus,
	startAutoSync,
	stopAutoSync,
} from "../war/war-service";

let rootElement: ShadowRoot | Document | null = null;
let panelElem: HTMLElement | null = null;
let launcherElem: HTMLElement | null = null;
let statusTextElem: HTMLElement | null = null;
let userBadgeElem: HTMLElement | null = null;
let travelLockElem: HTMLElement | null = null;

export function initPanel(root: ShadowRoot | Document): void {
	rootElement = root;
	panelElem = root.getElementById("satf-panel");
	launcherElem = root.getElementById("satf-launcher");
	statusTextElem = root.getElementById("satf-status-text");
	userBadgeElem = root.getElementById("satf-user-badge");
	travelLockElem = root.getElementById("satf-travel-lock");
}

export function setStatus(msg: string, type: "ok" | "error" = "ok"): void {
	state.statusText = msg;
	state.statusType = type;
	if (statusTextElem) {
		statusTextElem.textContent = msg;
		statusTextElem.style.color =
			type === "error" ? "var(--danger)" : "var(--muted)";
	}
}

export function setBountiesStatus(
	msg: string,
	type: "ok" | "error" = "ok",
): void {
	if (!rootElement) return;
	const dot = rootElement.getElementById("satf-bounties-status-dot");
	const txt = rootElement.getElementById("satf-bounties-status-text");
	if (txt) {
		txt.textContent = msg;
		txt.style.color =
			type === "error"
				? "var(--danger)"
				: type === "ok"
					? "#34d399"
					: "var(--muted)";
	}
	if (dot) {
		dot.style.background =
			type === "error"
				? "var(--danger)"
				: type === "ok"
					? "var(--accent)"
					: "var(--muted)";
	}
}

export function updateUserBadge(): void {
	if (!userBadgeElem) return;
	const displayName = state.user?.name || state.user?.tornName;
	if (displayName) {
		const bsStr = state.user?.bsScore
			? ` · BS: ${Math.round(state.user.bsScore).toLocaleString()}`
			: "";
		userBadgeElem.textContent = `${displayName} [${state.user?.tornId}]${bsStr}`;
		userBadgeElem.style.color = "var(--accent)";
	} else {
		userBadgeElem.textContent = "Guest (Not connected)";
		userBadgeElem.style.color = "var(--muted)";
	}
}

export function updateTravelLock(): void {
	if (!travelLockElem) return;
	const flightState = detectAttackerFlightState();
	if (flightState === "traveling" || flightState === "abroad") {
		travelLockElem.style.display = "block";
		travelLockElem.textContent =
			flightState === "traveling"
				? "✈ Currently Traveling · Dispatch Locked"
				: "🌍 Currently Abroad · Dispatch Locked";
	} else {
		travelLockElem.style.display = "none";
	}
}

export function positionPanel(): void {
	if (!panelElem || !launcherElem) return;
	const isMobile = window.innerWidth <= 480;
	if (isMobile) {
		panelElem.style.left = "12px";
		panelElem.style.right = "12px";
		panelElem.style.width = "calc(100vw - 24px)";
		panelElem.style.top = "12px";
		return;
	}
	panelElem.style.right = "";
	panelElem.style.width = "430px";
	const rect = launcherElem.getBoundingClientRect();
	let launcherX = rect.left;
	let launcherY = rect.top;
	if ((!launcherX && !launcherY) || (launcherX === 0 && launcherY === 0)) {
		const saved = GM_getValue<{ x?: number; y?: number } | null>(
			STORAGE.position,
			null,
		);
		if (saved && typeof saved.x === "number") {
			launcherX = saved.x;
			launcherY = saved.y ?? 0;
		} else {
			launcherX = Math.max(10, window.innerWidth - 64);
			launcherY = Math.max(10, window.innerHeight - 84);
		}
	}
	let left = launcherX - 440;
	let top = launcherY;
	if (left < 10) left = (rect.right > 0 ? rect.right : launcherX + 48) + 10;
	if (left + 440 > window.innerWidth)
		left = Math.max(10, window.innerWidth - 442);
	if (top + 500 > window.innerHeight)
		top = Math.max(10, window.innerHeight - 510);
	if (top < 10) top = 10;
	panelElem.style.left = `${left}px`;
	panelElem.style.top = `${top}px`;
}

export function switchWarSubTab(subtab: string): void {
	if (!rootElement) return;
	const safe = subtab === "targets" || subtab === "hosp" ? subtab : "targets";
	state.warSubTab = safe;
	GM_setValue(STORAGE.warSubTab, safe);

	const btnTargets = rootElement.getElementById("satf-war-subtab-targets");
	const btnHosp = rootElement.getElementById("satf-war-subtab-hosp");
	const paneTargets = rootElement.getElementById("satf-war-pane-targets");
	const paneHosp = rootElement.getElementById("satf-war-pane-hosp");

	if (btnTargets) btnTargets.classList.toggle("active", safe === "targets");
	if (btnHosp) btnHosp.classList.toggle("active", safe === "hosp");
	if (paneTargets)
		paneTargets.style.display = safe === "targets" ? "block" : "none";
	if (paneHosp) paneHosp.style.display = safe === "hosp" ? "block" : "none";

	if (safe === "targets") {
		renderAvailableTargets();
		stopHospTimer();
	} else if (safe === "hosp") {
		fetchHospitalQueue();
	}
}

export function switchTab(tab: string): void {
	if (!rootElement) return;
	const safeTab = tab === "target" || tab === "hosp" ? "war" : tab;
	state.activeTab = safeTab;
	GM_setValue(STORAGE.activeTab, safeTab);

	rootElement.querySelectorAll(".satf-tab-btn").forEach((btn) => {
		btn.classList.toggle(
			"active",
			(btn as HTMLElement).dataset.tab === safeTab,
		);
	});

	const viewWar = rootElement.getElementById("satf-view-war");
	const viewBounties = rootElement.getElementById("satf-view-bounties");
	const viewSettings = rootElement.getElementById("satf-view-settings");

	if (viewWar) viewWar.style.display = safeTab === "war" ? "block" : "none";
	if (viewBounties)
		viewBounties.style.display = safeTab === "bounties" ? "block" : "none";
	if (viewSettings)
		viewSettings.style.display = safeTab === "settings" ? "block" : "none";

	if (safeTab === "war") {
		switchWarSubTab(state.warSubTab || "targets");
	} else if (safeTab === "bounties") {
		renderBountyReadyTargets(state.bountiesReady);
		fetchBounties();
		stopHospTimer();
	} else {
		stopHospTimer();
	}
}

export function openPanel(): void {
	if (!panelElem) return;
	state.panelOpen = true;
	panelElem.classList.add("open");
	if (state.persistOpen) {
		GM_setValue(STORAGE.panelOpen, true);
	} else {
		GM_setValue(STORAGE.panelOpen, false);
	}
	positionPanel();
	updateTravelLock();
	fetchWarStatus();
	switchTab(state.activeTab || "bounties");
	startAutoSync();
}

export function closePanel(): void {
	if (!panelElem) return;
	state.panelOpen = false;
	panelElem.classList.remove("open");
	GM_setValue(STORAGE.panelOpen, false);
	stopHospTimer();
	stopAutoSync();
}
