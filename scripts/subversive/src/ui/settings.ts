import { apiRequest } from "../api/client";
import {
	fetchBounties,
	renderBountyReadyTargets,
	updateBountyBadges,
} from "../bounties/bounties";
import { STORAGE } from "../constants";
import { initAttackPageHud } from "../hud/attack-hud";
import { state } from "../state";
import type { UserSessionData } from "../types";
import {
	formatMoney,
	formatStats,
	parseMoneyInput,
	parseStatsInput,
} from "../utils/formatters";
import { renderAvailableTargets } from "../war/roster";
import { fetchWarStatus } from "../war/war-service";
import { resetLauncherPosition } from "./launcher";
import { setStatus, switchTab, updateUserBadge } from "./panel";

let rootElement: ShadowRoot | Document | null = null;

export function updateSettingsAuthView(): void {
	if (!rootElement) return;
	const authConnectedBox = rootElement.getElementById("satf-auth-connected");
	const authNameId = rootElement.getElementById("satf-auth-name-id");
	const keyInputContainer = rootElement.getElementById(
		"satf-key-input-container",
	);

	if (state.user) {
		const displayName = state.user.name || state.user.tornName || "Member";
		if (authNameId) {
			authNameId.textContent = `${displayName} [${state.user.tornId}]`;
		}
		if (authConnectedBox) {
			authConnectedBox.style.display = "block";
		}
		if (keyInputContainer) {
			keyInputContainer.style.display = "none";
		}
	} else {
		if (authConnectedBox) {
			authConnectedBox.style.display = "none";
		}
		if (keyInputContainer) {
			keyInputContainer.style.display = "block";
		}
	}
}

export async function handleAuth(): Promise<void> {
	if (!rootElement) return;
	const keyInput = rootElement.getElementById(
		"satf-input-key",
	) as HTMLInputElement | null;
	const apiKey = keyInput?.value.trim() ?? "";
	if (!apiKey) {
		setStatus("Please enter a valid API key.", "error");
		return;
	}

	setStatus("Connecting API key...", "ok");
	try {
		const res = await apiRequest<{ token: string; user: UserSessionData }>(
			"/api/v1/target-finder/auth",
			{
				method: "POST",
				body: { apiKey },
			},
		);

		state.token = res.token;
		state.user = res.user;
		GM_setValue(STORAGE.token, state.token);
		GM_setValue(STORAGE.user, state.user);

		if (keyInput) keyInput.value = "";
		updateUserBadge();
		updateSettingsAuthView();
		setStatus("Connected! Ready for Ranked War.", "ok");
		switchTab("war");
		fetchWarStatus();
		renderAvailableTargets();
		fetchBounties();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		setStatus(msg, "error");
	}
}

export function updateSortPillVisuals(): void {
	if (!rootElement) return;
	rootElement
		.querySelectorAll<HTMLElement>(".satf-sort-pill")
		.forEach((pill) => {
			const sortField = pill.dataset.sort;
			if (sortField === state.targetSortBy) {
				pill.classList.add("active");
				const arrow = state.targetSortOrder === "asc" ? " ↑" : " ↓";
				const base =
					sortField === "ff" ? "FF" : sortField === "online" ? "Online" : "BS";
				pill.textContent = `${base}${arrow}`;
			} else {
				pill.classList.remove("active");
				const base =
					sortField === "ff" ? "FF" : sortField === "online" ? "Online" : "BS";
				pill.textContent = base;
			}
		});
}

export function initSettings(root: ShadowRoot | Document): void {
	rootElement = root;

	const keyInputContainer = root.getElementById("satf-key-input-container");
	const btnToggleKeyInput = root.getElementById("satf-btn-toggle-key-input");
	const btnAuth = root.getElementById("satf-btn-auth");
	const chkDirect = root.getElementById(
		"satf-chk-direct",
	) as HTMLInputElement | null;
	const chkAttackNewTab = root.getElementById(
		"satf-chk-attack-new-tab",
	) as HTMLInputElement | null;
	const chkDisableHud = root.getElementById(
		"satf-chk-disable-hud",
	) as HTMLInputElement | null;
	const inputMinFf = root.getElementById(
		"satf-input-min-ff",
	) as HTMLInputElement | null;
	const inputMaxFf = root.getElementById(
		"satf-input-max-ff",
	) as HTMLInputElement | null;
	const inputBountyMin = root.getElementById(
		"satf-input-bounty-min",
	) as HTMLInputElement | null;
	const inputBountyMax = root.getElementById(
		"satf-input-bounty-max",
	) as HTMLInputElement | null;
	const chkHideHighFf = root.getElementById(
		"satf-chk-hide-high-ff",
	) as HTMLInputElement | null;
	const inputHideFf = root.getElementById(
		"satf-input-hide-ff",
	) as HTMLInputElement | null;
	const chkHideHighBs = root.getElementById(
		"satf-chk-hide-high-bs",
	) as HTMLInputElement | null;
	const inputHideBs = root.getElementById(
		"satf-input-hide-bs",
	) as HTMLInputElement | null;
	const chkPersistOpen = root.getElementById(
		"satf-chk-persist-open",
	) as HTMLInputElement | null;
	const ignoredCount = root.getElementById("satf-ignored-count");
	const btnClearIgnored = root.getElementById("satf-btn-clear-ignored");
	const btnResetPos = root.getElementById("satf-btn-reset-pos");
	const btnRefreshStats = root.getElementById("satf-btn-refresh-stats");
	const btnLogout = root.getElementById("satf-btn-logout");

	// Initial checkbox values
	if (chkDirect) chkDirect.checked = state.directAttack;
	if (chkAttackNewTab) chkAttackNewTab.checked = !state.directAttack;
	if (chkDisableHud) chkDisableHud.checked = state.disableHud;
	if (chkHideHighFf) chkHideHighFf.checked = state.hideHighFF;
	if (chkHideHighBs) chkHideHighBs.checked = state.hideHighBS;
	if (chkPersistOpen) chkPersistOpen.checked = state.persistOpen;

	updateSettingsAuthView();
	updateSortPillVisuals();

	// Direct Attack / New Tab toggles
	chkDirect?.addEventListener("change", (e) => {
		state.directAttack = (e.target as HTMLInputElement).checked;
		GM_setValue(STORAGE.directAttack, state.directAttack);
		if (chkAttackNewTab) chkAttackNewTab.checked = !state.directAttack;
		renderAvailableTargets();
		renderBountyReadyTargets();
	});

	chkAttackNewTab?.addEventListener("change", (e) => {
		state.directAttack = !(e.target as HTMLInputElement).checked;
		GM_setValue(STORAGE.directAttack, state.directAttack);
		if (chkDirect) chkDirect.checked = state.directAttack;
		renderAvailableTargets();
		renderBountyReadyTargets();
	});

	// Attack HUD toggle
	chkDisableHud?.addEventListener("change", (e) => {
		state.disableHud = (e.target as HTMLInputElement).checked;
		GM_setValue(STORAGE.disableHud, state.disableHud);
		if (state.disableHud) {
			const host = document.getElementById("satf-attack-hud-host");
			if (host) host.remove();
		} else {
			initAttackPageHud();
		}
	});

	// Min / Max FF inputs
	inputMinFf?.addEventListener("change", (e) => {
		const target = e.target as HTMLInputElement;
		const val = Math.max(
			1.0,
			Math.min(state.maxFFThreshold, Number.parseFloat(target.value) || 1.2),
		);
		state.minFFThreshold = val;
		target.value = val.toFixed(1);
		GM_setValue(STORAGE.minFFThreshold, val);
	});

	inputMaxFf?.addEventListener("change", (e) => {
		const target = e.target as HTMLInputElement;
		const val = Math.max(
			state.minFFThreshold,
			Math.min(3.0, Number.parseFloat(target.value) || 3.0),
		);
		state.maxFFThreshold = val;
		target.value = val.toFixed(1);
		GM_setValue(STORAGE.maxFFThreshold, val);
	});

	// Bounty Min / Max Reward inputs
	function commitBountyMin(elem: HTMLInputElement): void {
		const parsed = parseMoneyInput(elem.value);
		state.bountyMinReward = parsed;
		GM_setValue(STORAGE.bountyMinReward, parsed);
		elem.value = parsed > 0 ? formatMoney(parsed) : "";
		updateBountyBadges();
		renderBountyReadyTargets();
	}

	function commitBountyMax(elem: HTMLInputElement): void {
		const parsed = parseMoneyInput(elem.value);
		state.bountyMaxReward = parsed;
		GM_setValue(STORAGE.bountyMaxReward, parsed);
		elem.value = parsed > 0 ? formatMoney(parsed) : "";
		updateBountyBadges();
		renderBountyReadyTargets();
	}

	inputBountyMin?.addEventListener("change", (e) =>
		commitBountyMin(e.target as HTMLInputElement),
	);
	inputBountyMin?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commitBountyMin(e.target as HTMLInputElement);
			(e.target as HTMLInputElement).blur();
		}
	});

	inputBountyMax?.addEventListener("change", (e) =>
		commitBountyMax(e.target as HTMLInputElement),
	);
	inputBountyMax?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commitBountyMax(e.target as HTMLInputElement);
			(e.target as HTMLInputElement).blur();
		}
	});

	// Roster Hide High FF / BS filters
	chkHideHighFf?.addEventListener("change", (e) => {
		state.hideHighFF = (e.target as HTMLInputElement).checked;
		GM_setValue(STORAGE.hideHighFF, state.hideHighFF);
		renderAvailableTargets();
	});

	inputHideFf?.addEventListener("change", (e) => {
		const val = Number.parseFloat((e.target as HTMLInputElement).value) || 3.0;
		state.maxFFThreshold = Math.max(1.0, val);
		GM_setValue(STORAGE.maxFFThreshold, state.maxFFThreshold);
		renderAvailableTargets();
	});

	chkHideHighBs?.addEventListener("change", (e) => {
		state.hideHighBS = (e.target as HTMLInputElement).checked;
		GM_setValue(STORAGE.hideHighBS, state.hideHighBS);
		renderAvailableTargets();
	});

	function commitBsInput(targetElem: HTMLInputElement): void {
		const parsed = parseStatsInput(targetElem.value);
		if (parsed !== null) {
			state.maxBSThreshold = parsed;
			GM_setValue(STORAGE.maxBSThreshold, state.maxBSThreshold);
			targetElem.value = formatStats(parsed);
			targetElem.title = parsed.toLocaleString();
		} else {
			targetElem.value = formatStats(state.maxBSThreshold);
		}
		renderAvailableTargets();
	}

	inputHideBs?.addEventListener("change", (e) => {
		commitBsInput(e.target as HTMLInputElement);
	});

	inputHideBs?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commitBsInput(e.target as HTMLInputElement);
			(e.target as HTMLInputElement).blur();
		}
	});

	// Persist window open toggle
	chkPersistOpen?.addEventListener("change", (e) => {
		state.persistOpen = (e.target as HTMLInputElement).checked;
		GM_setValue(STORAGE.persistOpen, state.persistOpen);
		if (state.persistOpen) {
			GM_setValue(STORAGE.panelOpen, state.panelOpen);
		} else {
			GM_setValue(STORAGE.panelOpen, false);
		}
	});

	// Reset ignored targets blacklist
	btnClearIgnored?.addEventListener("click", () => {
		state.ignoredTargets = [];
		GM_setValue(STORAGE.ignoredTargets, []);
		if (ignoredCount) ignoredCount.textContent = "0 ignored targets";
		renderAvailableTargets();
		setStatus("Cleared ignored targets blacklist.", "ok");
	});

	// Reset launcher position
	btnResetPos?.addEventListener("click", resetLauncherPosition);

	// Toggle Key input
	btnToggleKeyInput?.addEventListener("click", () => {
		if (!keyInputContainer) return;
		const isVisible = keyInputContainer.style.display !== "none";
		keyInputContainer.style.display = isVisible ? "none" : "block";
		if (!isVisible) {
			const keyInput = root.getElementById(
				"satf-input-key",
			) as HTMLInputElement | null;
			keyInput?.focus();
		}
	});

	// Connect API Key
	btnAuth?.addEventListener("click", handleAuth);

	// Refresh stats
	btnRefreshStats?.addEventListener("click", async () => {
		if (!state.token) return;
		setStatus("Refreshing battle stats...", "ok");
		try {
			const res = await apiRequest<{ bsScore?: number }>(
				"/api/v1/target-finder/refresh-stats",
				{
					method: "POST",
				},
			);
			if (state.user && typeof res.bsScore === "number") {
				state.user.bsScore = res.bsScore;
				GM_setValue(STORAGE.user, state.user);
				updateUserBadge();
			}
			setStatus("Battle stats refreshed.", "ok");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			setStatus(msg, "error");
		}
	});

	// Logout
	btnLogout?.addEventListener("click", () => {
		state.token = "";
		state.user = null;
		state.currentTarget = null;
		GM_setValue(STORAGE.token, "");
		GM_setValue(STORAGE.user, null);
		updateUserBadge();
		updateSettingsAuthView();
		renderAvailableTargets([]);
		state.bountiesReady = [];
		renderBountyReadyTargets([]);
		setStatus("Logged out. Please connect your API key.", "ok");
	});

	// Sort pills click handlers
	root.querySelectorAll<HTMLElement>(".satf-sort-pill").forEach((pill) => {
		pill.addEventListener("click", () => {
			const sortField = pill.dataset.sort || "ff";
			if (state.targetSortBy === sortField) {
				state.targetSortOrder =
					state.targetSortOrder === "asc" ? "desc" : "asc";
			} else {
				state.targetSortBy = sortField;
				state.targetSortOrder = "desc";
			}
			GM_setValue(STORAGE.targetSortBy, state.targetSortBy);
			GM_setValue(STORAGE.targetSortOrder, state.targetSortOrder);
			updateSortPillVisuals();
			renderAvailableTargets();
		});
	});
}
