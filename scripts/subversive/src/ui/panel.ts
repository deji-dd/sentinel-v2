import { detectAttackerFlightState } from "../api/client";
import { fetchBounties, renderBountyReadyTargets } from "../bounties/bounties";
import { STORAGE } from "../constants";
import { state } from "../state";
import { fetchHospitalQueue, stopHospTimer } from "../war/hospital";
import { renderAvailableTargets } from "../war/roster";
import { evaluateSyncRate } from "../war/war-service";

let rootElement: ShadowRoot | Document | null = null;
let panelElem: HTMLElement | null = null;
let launcherElem: HTMLElement | null = null;
let statusTextElem: HTMLElement | null = null;
let userBadgeElem: HTMLElement | null = null;
let travelLockElem: HTMLElement | null = null;

const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 720;
const DEFAULT_PANEL_WIDTH = 380;
const MIN_PANEL_HEIGHT = 420;
const DEFAULT_PANEL_HEIGHT = 680;
/** Gap kept between the panel and the window edge. */
const PANEL_MARGIN = 10;
/** Below this the panel is full-width and the resize handles are hidden. */
const RESIZE_MIN_VIEWPORT_PX = 700;

/** User-dragged size in pixels; 0 means "use the default". */
let panelWidth = 0;
let panelHeight = 0;

function clampPanelWidth(width: number, viewportWidth: number): number {
	const max = Math.max(
		MIN_PANEL_WIDTH,
		Math.min(MAX_PANEL_WIDTH, viewportWidth - PANEL_MARGIN * 2),
	);
	const desired =
		Number.isFinite(width) && width > 0 ? width : DEFAULT_PANEL_WIDTH;
	return Math.round(Math.min(Math.max(desired, MIN_PANEL_WIDTH), max));
}

function clampPanelHeight(height: number, viewportHeight: number): number {
	const max = Math.max(MIN_PANEL_HEIGHT, viewportHeight - PANEL_MARGIN * 2);
	const desired =
		Number.isFinite(height) && height > 0 ? height : DEFAULT_PANEL_HEIGHT;
	return Math.round(Math.min(Math.max(desired, MIN_PANEL_HEIGHT), max));
}

export function initPanel(root: ShadowRoot | Document): void {
	rootElement = root;
	panelElem = root.getElementById("satf-panel");
	launcherElem = root.getElementById("satf-launcher");
	statusTextElem = root.getElementById("satf-status-text");
	userBadgeElem = root.getElementById("satf-user-badge");
	travelLockElem = root.getElementById("satf-travel-lock");

	panelWidth = GM_getValue<number>(STORAGE.panelWidth, 0);
	panelHeight = GM_getValue<number>(STORAGE.panelHeight, 0);
	bindPanelResize();
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
		const factionTag = state.user?.factionName
			? ` • ${state.user.factionName}`
			: "";
		userBadgeElem.textContent = `${displayName} [${state.user?.tornId}]${factionTag}`;
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
		panelElem.style.height = "calc(100vh - 24px)";
		return;
	}
	panelElem.style.right = "";

	const width = clampPanelWidth(panelWidth, window.innerWidth);
	const height = clampPanelHeight(panelHeight, window.innerHeight);
	panelElem.style.width = `${width}px`;
	panelElem.style.height = `${height}px`;

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

	let left = launcherX - width - PANEL_MARGIN;
	if (left < PANEL_MARGIN) {
		left = (rect.right > 0 ? rect.right : launcherX + 48) + PANEL_MARGIN;
	}
	left = Math.max(
		PANEL_MARGIN,
		Math.min(left, window.innerWidth - width - PANEL_MARGIN),
	);

	// Keep the top near the launcher, but pull it up rather than let a taller
	// panel hang off the bottom of the window.
	let top = launcherY;
	top = Math.max(
		PANEL_MARGIN,
		Math.min(top, window.innerHeight - height - PANEL_MARGIN),
	);

	panelElem.style.left = `${left}px`;
	panelElem.style.top = `${top}px`;
}

/**
 * Wires the left and bottom edges as resize handles.
 *
 * Width is tracked as a delta against the drag start, so the panel's
 * launcher-relative left edge can be re-clamped mid-drag without the width
 * running away. Sizes are persisted only on pointerup, and double-clicking
 * either handle restores the defaults.
 */
function bindPanelResize(): void {
	if (!panelElem) return;

	const attach = (
		handle: HTMLElement | null,
		axis: "width" | "height",
	): void => {
		if (!handle) return;

		let dragging = false;
		let startX = 0;
		let startY = 0;
		let startWidth = 0;
		let startHeight = 0;

		const onMove = (event: PointerEvent): void => {
			if (!dragging) return;
			event.preventDefault();
			if (axis === "width") {
				panelWidth = clampPanelWidth(
					startWidth + (startX - event.clientX),
					window.innerWidth,
				);
			} else {
				panelHeight = clampPanelHeight(
					startHeight + (event.clientY - startY),
					window.innerHeight,
				);
			}
			positionPanel();
		};

		const end = (): void => {
			if (!dragging) return;
			dragging = false;
			panelElem?.classList.remove("resizing");
			document.body.style.removeProperty("cursor");
			document.body.style.removeProperty("user-select");
			GM_setValue(STORAGE.panelWidth, panelWidth);
			GM_setValue(STORAGE.panelHeight, panelHeight);
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
		};

		handle.addEventListener("pointerdown", (event: PointerEvent) => {
			if (event.button !== 0) return;
			if (window.innerWidth < RESIZE_MIN_VIEWPORT_PX) return;
			const rect = panelElem?.getBoundingClientRect();
			if (!rect) return;

			event.preventDefault();
			dragging = true;
			startX = event.clientX;
			startY = event.clientY;
			startWidth = rect.width;
			startHeight = rect.height;

			panelElem?.classList.add("resizing");
			// Text selection fights the drag, and the cursor has to stay a resize
			// cursor even when the pointer outruns the 6px handle.
			document.body.style.cursor =
				axis === "width" ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			handle.setPointerCapture(event.pointerId);
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		});

		handle.addEventListener("dblclick", () => {
			panelWidth = 0;
			panelHeight = 0;
			GM_setValue(STORAGE.panelWidth, 0);
			GM_setValue(STORAGE.panelHeight, 0);
			positionPanel();
		});
	};

	attach(panelElem.querySelector<HTMLElement>("#satf-resize-x"), "width");
	attach(panelElem.querySelector<HTMLElement>("#satf-resize-y"), "height");
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
	switchTab(state.activeTab || "bounties");
	evaluateSyncRate(true);
}

export function closePanel(): void {
	if (!panelElem) return;
	state.panelOpen = false;
	panelElem.classList.remove("open");
	GM_setValue(STORAGE.panelOpen, false);
	stopHospTimer();
	evaluateSyncRate();
}
