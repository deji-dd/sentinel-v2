import {
	fetchBounties,
	initBounties,
	renderBountyReadyTargets,
} from "./bounties/bounties";
import { SYNC_CONFIG } from "./constants";
import { checkAttackPageOutcome, initAttackPageHud } from "./hud/attack-hud";
import { state } from "./state";
import { initLauncher } from "./ui/launcher";
import {
	closePanel,
	initPanel,
	openPanel,
	positionPanel,
	setBountiesStatus,
	setStatus,
	switchTab,
	switchWarSubTab,
	updateTravelLock,
	updateUserBadge,
} from "./ui/panel";
import { initSettings } from "./ui/settings";
import { getPanelHtml } from "./ui/template";
import { initHospitalElements } from "./war/hospital";
import { initRosterElements, renderAvailableTargets } from "./war/roster";
import { initWarBannerElements, renderWarBanner } from "./war/war-banner";
import {
	evaluateSyncRate,
	executeGetTarget,
	fetchNextTarget,
	initWarService,
} from "./war/war-service";

let isInitialized = false;

function start(): void {
	if (
		!document.body ||
		document.getElementById("subversive-target-finder-host")
	) {
		return;
	}

	const host = document.createElement("div");
	host.id = "subversive-target-finder-host";
	document.body.appendChild(host);
	const root = host.attachShadow({ mode: "open" });
	root.innerHTML = getPanelHtml();

	// Initialize UI Modules
	initPanel(root);
	initWarBannerElements(root);
	renderWarBanner(null); // show empty state until first API response
	initRosterElements(root);
	initHospitalElements(root, setStatus);
	initBounties(root, setBountiesStatus);
	initLauncher(root);

	const btnGetTarget = root.getElementById(
		"satf-btn-get-target",
	) as HTMLButtonElement | null;
	initWarService({
		setStatus,
		updateTravelLock,
		switchTab,
		fetchBounties,
		btnGetTarget,
	});

	initSettings(root);

	// Event wiring
	root.getElementById("satf-btn-close")?.addEventListener("click", closePanel);

	root.querySelectorAll<HTMLElement>(".satf-tab-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			const tab = btn.dataset.tab;
			if (tab) switchTab(tab);
		});
	});

	root
		.getElementById("satf-war-subtab-targets")
		?.addEventListener("click", () => {
			switchWarSubTab("targets");
		});
	root.getElementById("satf-war-subtab-hosp")?.addEventListener("click", () => {
		switchWarSubTab("hosp");
	});

	btnGetTarget?.addEventListener("click", () => {
		executeGetTarget();
	});

	root.getElementById("satf-btn-modal-next")?.addEventListener("click", () => {
		fetchNextTarget({ directLaunch: state.directAttack });
	});

	// Populate initial state
	updateUserBadge();
	updateTravelLock();
	renderAvailableTargets();
	renderBountyReadyTargets(state.bountiesReady);
	switchWarSubTab(state.warSubTab || "targets");

	// Auto-open if remember open window is enabled AND panel was open on last page
	if (state.persistOpen && state.panelOpen) {
		openPanel();
		requestAnimationFrame(positionPanel);
		setTimeout(positionPanel, 50);
		setTimeout(positionPanel, 200);
		setTimeout(positionPanel, 600);
	}

	window.addEventListener("resize", () => {
		if (state.panelOpen) {
			positionPanel();
		}
	});

	if (state.token) {
		setStatus("Connected", "ok");
		evaluateSyncRate(true);
	} else {
		setStatus("Not connected. Enter key in Settings.", "error");
	}

	window.addEventListener("storage", (e) => {
		if (e.key === SYNC_CONFIG.STORAGE_HUD_CYCLE) {
			evaluateSyncRate();
		}
	});

	isInitialized = true;
}

let lastObservedUrl = window.location.href;

function handleAttackPageTick(): void {
	if (window.location.href !== lastObservedUrl) {
		lastObservedUrl = window.location.href;
	}
	initAttackPageHud();
	checkAttackPageOutcome();
}

function boot(): void {
	if (!document.body) {
		window.addEventListener("DOMContentLoaded", boot, { once: true });
		return;
	}
	if (!isInitialized) {
		start();
	}
	handleAttackPageTick();

	const pageObserver = new MutationObserver(() => {
		checkAttackPageOutcome();
	});
	pageObserver.observe(document.body, { childList: true, subtree: true });
}

if (typeof document !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}

	window.addEventListener("popstate", handleAttackPageTick);
	window.addEventListener("hashchange", handleAttackPageTick);
	setInterval(handleAttackPageTick, 800);
}
