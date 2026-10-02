import { apiRequest } from "../api/client";
import { STORAGE, SYNC_CONFIG } from "../constants";
import { getFilteredBountyList, isWarEngaged, state } from "../state";
import type { BountyTarget, WarTarget } from "../types";
import { formatMoney, getBountyFF, getFFColor } from "../utils/formatters";

export const sessionBountyTargets = new Map<number, BountyTarget>();
export const sessionWarTargets = new Set<number>();
let warTargetVerifiedId = 0;
let warTargetVerificationInProgress = false;
let lastHandledOutcomeId = 0;
let lastHudActivityTime = 0;
const hudActivityListeners = new Set<() => void>();

export function registerHudActivityListener(fn: () => void): () => void {
	hudActivityListeners.add(fn);
	return () => {
		hudActivityListeners.delete(fn);
	};
}

export function recordHudActivity(): void {
	lastHudActivityTime = Date.now();
	try {
		localStorage.setItem(
			SYNC_CONFIG.STORAGE_HUD_CYCLE,
			String(lastHudActivityTime),
		);
		GM_setValue(STORAGE.lastHudActivity, lastHudActivityTime);
	} catch {}
	hudActivityListeners.forEach((fn) => {
		try {
			fn();
		} catch {}
	});
}

export function isHudCyclingActive(): boolean {
	const now = Date.now();
	if (now - lastHudActivityTime < SYNC_CONFIG.HUD_ACTIVITY_TIMEOUT_MS) {
		return true;
	}
	try {
		const stored = Number(
			localStorage.getItem(SYNC_CONFIG.STORAGE_HUD_CYCLE) || 0,
		);
		if (now - stored < SYNC_CONFIG.HUD_ACTIVITY_TIMEOUT_MS) {
			lastHudActivityTime = stored;
			return true;
		}
	} catch {}
	const href = window.location.href;
	const isAttackPage =
		/sid=(attack|getInAttack)/i.test(href) ||
		/page=attack/i.test(href) ||
		href.includes("loader.php?sid=attack") ||
		href.includes("loader2.php?sid=attack") ||
		href.includes("page.php?sid=attack");
	if (
		isAttackPage &&
		typeof document !== "undefined" &&
		document.getElementById("satf-attack-hud-host")
	) {
		return true;
	}
	return false;
}

export async function loadNextTargetDirectly(
	hudRoot: ShadowRoot | Document | null,
): Promise<void> {
	recordHudActivity();
	const btnHudNext = (hudRoot?.getElementById("satf-hud-next") ||
		hudRoot?.getElementById(
			"satf-hud-outcome-next",
		)) as HTMLButtonElement | null;
	if (btnHudNext) {
		btnHudNext.textContent = "Scouting...";
		btnHudNext.disabled = true;
	}
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
		}>(`/v2/target-finder/targets/next?${params.toString()}`);
		if (res.target?.attackUrl) {
			state.currentTarget = res.target;
			GM_setValue(STORAGE.currentTarget, res.target);
			if (state.directAttack) {
				window.location.href = res.target.attackUrl;
			} else {
				window.open(res.target.attackUrl, "_blank");
				if (btnHudNext) {
					btnHudNext.textContent = "Next";
					btnHudNext.disabled = false;
				}
			}
			return;
		}

		if (res.retryAfter) {
			let countdown = res.retryAfter || 5;
			if (btnHudNext) btnHudNext.textContent = `Rest ${countdown}s`;
			const timer = setInterval(() => {
				countdown--;
				if (countdown > 0) {
					if (btnHudNext) btnHudNext.textContent = `Rest ${countdown}s`;
				} else {
					clearInterval(timer);
					if (btnHudNext) {
						btnHudNext.textContent = "Next";
						btnHudNext.disabled = false;
					}
				}
			}, 1000);
			return;
		}

		alert(res.message || "No targets available.");
		if (btnHudNext) {
			btnHudNext.textContent = "Next";
			btnHudNext.disabled = false;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		alert(`Failed to acquire next target: ${msg}`);
		if (btnHudNext) {
			btnHudNext.textContent = "Next";
			btnHudNext.disabled = false;
		}
	}
}

export function createHudHost(targetId: number): HTMLElement {
	let host = document.getElementById("satf-attack-hud-host");
	if (!host) {
		host = document.createElement("div");
		host.id = "satf-attack-hud-host";
		host.style.position = "fixed";
		host.style.top = "0";
		host.style.left = "0";
		host.style.width = "100%";
		host.style.height = "0";
		host.style.zIndex = "2147483647";
		host.style.pointerEvents = "none";
		(document.body || document.documentElement).appendChild(host);
	}
	host.dataset.targetId = String(targetId);
	return host;
}

export function mountBountyHud(bt: BountyTarget, idx: number): HTMLElement {
	const host = createHudHost(bt.id);
	sessionBountyTargets.set(bt.id, bt);

	if (
		host.dataset.targetId === String(bt.id) &&
		host.shadowRoot?.getElementById("satf-attack-bar")
	) {
		return host;
	}

	const hudRoot = host.shadowRoot || host.attachShadow({ mode: "open" });
	const ffVal = getBountyFF(bt);
	const ffColor = getFFColor(ffVal);
	const ffText =
		ffVal !== null && ffVal !== undefined ? ffVal.toFixed(2) : "Unknown";
	const readyList = getFilteredBountyList(state.bountiesReady || []);
	const totalReady = readyList.length;
	const isReadyTarget = idx >= 0 && idx < totalReady;
	const nextTarget =
		totalReady > 0
			? isReadyTarget
				? (readyList[(idx + 1) % totalReady] ?? null)
				: (readyList[0] ?? null)
			: null;
	const canCycle = totalReady > (isReadyTarget ? 1 : 0);

	hudRoot.innerHTML = `
	<style>
		:host {
			all: initial;
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 0;
			z-index: 2147483647 !important;
			pointer-events: none;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		}
		#satf-attack-bar {
			position: fixed;
			top: 10px;
			left: 50%;
			transform: translateX(-50%);
			z-index: 2147483647 !important;
			background: rgba(15, 15, 18, 0.96);
			backdrop-filter: blur(14px);
			border: 1px solid #27272a;
			border-radius: 12px;
			padding: 6px 14px;
			display: flex;
			align-items: center;
			justify-content: center;
			flex-wrap: wrap;
			gap: 8px 12px;
			max-width: calc(100vw - 20px);
			color: #f4f4f5;
			box-shadow: 0 8px 30px rgba(0,0,0,0.8);
			font-size: 12px;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			pointer-events: auto;
		}
		.satf-hud-badge {
			font-weight: 800;
			color: #10b981;
			font-size: 11px;
			letter-spacing: 0.5px;
		}
		.satf-hud-stat {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.satf-hud-val {
			font-weight: 800;
			color: #fff;
		}
		.satf-hud-btn {
			background: #27272a;
			border: 1px solid #3f3f46;
			color: #fff;
			border-radius: 6px;
			padding: 4px 8px;
			font-size: 11px;
			font-weight: 700;
			cursor: pointer;
			transition: all 0.15s;
		}
		.satf-hud-btn:hover:not(:disabled) {
			background: #3f3f46;
			border-color: #10b981;
		}
		.satf-hud-btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}
	</style>
	<div id="satf-attack-bar">
		<span class="satf-hud-badge">[BOUNTY]</span>
		<div class="satf-hud-stat">
			<span style="color:#a1a1aa;">Reward:</span>
			<span class="satf-hud-val" style="color:#34d399;">${formatMoney(bt.reward)}</span>
		</div>
		<div class="satf-hud-stat">
			<span style="color:#a1a1aa;">FF:</span>
			<span class="satf-hud-val" style="color:${ffColor};">${ffText}</span>
		</div>
		<button id="satf-bounty-cycle-next" class="satf-hud-btn" ${!canCycle ? "disabled" : ""}>Next &gt;</button>
	</div>
	`;

	hudRoot
		.getElementById("satf-bounty-cycle-next")
		?.addEventListener("click", () => {
			recordHudActivity();
			if (nextTarget?.attackUrl) {
				if (state.directAttack) {
					window.location.href = nextTarget.attackUrl;
				} else {
					window.open(nextTarget.attackUrl, "_blank");
				}
			}
		});

	return host;
}

export function handleBountyTargetDefeated(
	targetId: number,
	outcomeText: string,
	isDefeat = true,
): void {
	recordHudActivity();
	const targetIdx = state.bountiesReady.findIndex((t) => t.id === targetId);
	if (targetIdx !== -1) {
		state.bountiesReady.splice(targetIdx, 1);
	}

	try {
		GM_setValue(
			STORAGE.cachedBounties,
			JSON.stringify({
				readyTargets: state.bountiesReady,
			}),
		);
	} catch {}

	const host = document.getElementById("satf-attack-hud-host");
	if (host?.shadowRoot) {
		const bar = host.shadowRoot.getElementById("satf-attack-bar");
		const nextBounty = state.bountiesReady[0];
		if (bar) {
			bar.innerHTML = `
				<span class="satf-hud-badge" style="color:${isDefeat ? "#10b981" : "#ef4444"};">[${isDefeat ? "DEFEATED" : "HOSPITAL"}]</span>
				<span class="satf-hud-val">${outcomeText}</span>
				${
					state.bountiesReady.length > 0 && nextBounty
						? '<button id="satf-bounty-hud-next" class="satf-hud-btn" style="margin-left:8px;">Next Bounty &gt;</button>'
						: '<span style="font-size:11px;color:var(--muted);margin-left:8px;">No more ready bounties</span>'
				}
			`;
			if (nextBounty?.attackUrl) {
				const attackUrl = nextBounty.attackUrl;
				host.shadowRoot
					.getElementById("satf-bounty-hud-next")
					?.addEventListener("click", () => {
						recordHudActivity();
						if (state.directAttack) {
							window.location.href = attackUrl;
						} else {
							window.open(attackUrl, "_blank");
						}
					});
			}
		}
	}

	apiRequest("/v2/personal/bounties/defeat", {
		method: "POST",
		body: { targetId, outcome: outcomeText },
	}).catch(() => {});
}

export function handleWarTargetOutcome(
	targetId: number,
	outcomeText: string,
	isHospital: boolean,
	isVictory: boolean,
	isUserHosp: boolean,
): void {
	recordHudActivity();
	const host = document.getElementById("satf-attack-hud-host");
	if (host?.shadowRoot) {
		const bar = host.shadowRoot.getElementById("satf-attack-bar");
		if (bar) {
			const badgeText = isUserHosp
				? "[YOU IN HOSPITAL]"
				: isVictory
					? "[DEFEATED]"
					: "[HOSPITAL]";
			const badgeColor = isVictory ? "#10b981" : "#ef4444";
			bar.innerHTML = `
				<span class="satf-hud-badge" style="color:${badgeColor};">${badgeText}</span>
				<span class="satf-hud-val" style="margin-left:4px;">${outcomeText.slice(0, 80)}</span>
				<button id="satf-hud-outcome-next" class="satf-hud-btn" style="margin-left:8px;">Next Target &gt;</button>
			`;
			host.shadowRoot
				.getElementById("satf-hud-outcome-next")
				?.addEventListener("click", () => {
					recordHudActivity();
					loadNextTargetDirectly(host.shadowRoot);
				});
		}
	}

	if (isVictory || isHospital) {
		apiRequest(`/v2/target-finder/targets/${targetId}/hit`, {
			method: "POST",
		}).catch(() => {});
	}
}

/** Extract dialog message text with button/link labels stripped out. */
function extractDialogText(el: Element): string {
	const clone = el.cloneNode(true) as Element;
	for (const node of clone.querySelectorAll("button, a, [role='button']")) {
		node.remove();
	}
	return clone.textContent?.replace(/\s+/g, " ").trim() || "";
}

export function checkAttackPageOutcome(): void {
	const urlParams = new URLSearchParams(window.location.search);
	if (urlParams.get("sid") !== "attack") return;

	const currentTargetId =
		Number(urlParams.get("user2ID")) || Number(urlParams.get("ID"));
	if (!currentTargetId || !Number.isInteger(currentTargetId)) return;
	if (lastHandledOutcomeId === currentTargetId) return;

	const isBountyTarget =
		state.bountiesReady.some((t) => t.id === currentTargetId) ||
		sessionBountyTargets.has(currentTargetId);

	const dialogEls = document.querySelectorAll(
		'[class*="dialogWrapper"], [class*="dialog"], [class*="custom-dialog"], [class*="popup"], [class*="modal"], [class*="confirmDialog"], [class*="alert"], .dialogWrapper___rzZgc, [class*="title___"], [class*="message___"]',
	);

	for (const el of dialogEls) {
		const text = extractDialogText(el);
		if (!text) continue;

		const isUserInHospitalOrLost =
			/\b(?:you\s+can'?t\s+attack\s+(?:someone\s+)?while|you\s+cannot\s+attack\s+(?:someone\s+)?while|while\s+(?:you\s+are\s+)?in\s+(?:the\s+)?hospital|you\s+are\s+(?:currently\s+)?in\s+(?:the\s+)?hospital|you\s+were\s+(?:hospitalized|mugged|left|defeated)|you\s+lost\b|stalemate)/i.test(
				text,
			);

		const isVictory =
			!isUserInHospitalOrLost &&
			/\b(?:hospitalized|mugged|left|defeated)\b/i.test(text) &&
			/(?:^|\b)You\s+(?:hospitalized|mugged|left|defeated)\b/i.test(text);

		const isAlreadyHospitalized =
			!isUserInHospitalOrLost &&
			/\b(?:is\s+(?:currently\s+)?in\s+(?:the\s+)?hospital|cannot\s+be\s+attacked|someone\s+else\s+is\s+(?:currently\s+)?attacking|cannot\s+attack\s+this\s+(?:player|person)|they\s+are\s+(?:currently\s+)?in\s+(?:the\s+)?hospital)\b/i.test(
				text,
			);

		if (isVictory || isUserInHospitalOrLost || isAlreadyHospitalized) {
			lastHandledOutcomeId = currentTargetId;
			if (isBountyTarget) {
				if (isVictory) {
					handleBountyTargetDefeated(currentTargetId, text, true);
				} else if (isUserInHospitalOrLost) {
					const host = document.getElementById("satf-attack-hud-host");
					if (host?.shadowRoot) {
						const bar = host.shadowRoot.getElementById("satf-attack-bar");
						if (bar) {
							bar.innerHTML = `
								<span class="satf-hud-badge" style="color:#ef4444;">[YOU IN HOSPITAL]</span>
								<span class="satf-hud-val">${text.slice(0, 80)}</span>
							`;
						}
					}
				} else if (isAlreadyHospitalized) {
					handleBountyTargetDefeated(currentTargetId, text, false);
				}
			} else {
				handleWarTargetOutcome(
					currentTargetId,
					text,
					isAlreadyHospitalized,
					isVictory,
					isUserInHospitalOrLost,
				);
			}
			return;
		}
	}
}

export function resetAttackPageOutcome(targetId = 0): void {
	lastHandledOutcomeId = targetId;
	warTargetVerifiedId = 0;
	warTargetVerificationInProgress = false;
}

function applyHudDetails(
	hudRoot: ShadowRoot | Document | null,
	t: WarTarget,
): void {
	if (!t || !hudRoot) return;
	const hudFf = hudRoot.getElementById("satf-hud-ff");
	if (hudFf && typeof t.fairFight === "number") {
		hudFf.textContent = `${t.fairFight.toFixed(2)}x`;
		hudFf.className = "satf-hud-ff";
		if (t.fairFight <= 1.5) hudFf.classList.add("ff-green");
		else if (t.fairFight <= 2.2) hudFf.classList.add("ff-blue");
		else if (t.fairFight <= 2.8) hudFf.classList.add("ff-yellow");
		else hudFf.classList.add("ff-red");
	}
}

function mountHud(user2Id: number, initialData: WarTarget | null): HTMLElement {
	let host = document.getElementById("satf-attack-hud-host");
	if (host) {
		if (host.dataset.targetId === String(user2Id)) {
			if (initialData && host.shadowRoot) {
				applyHudDetails(host.shadowRoot, initialData);
			}
			return host;
		}
		host.remove();
	}

	host = createHudHost(user2Id);
	const hudRoot = host.shadowRoot || host.attachShadow({ mode: "open" });

	hudRoot.innerHTML = `
	<style>
		:host {
			all: initial;
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 0;
			z-index: 2147483647 !important;
			pointer-events: none;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		}
		#satf-attack-bar {
			position: fixed;
			top: 10px;
			left: 50%;
			transform: translateX(-50%);
			z-index: 2147483647 !important;
			background: rgba(15, 15, 18, 0.96);
			backdrop-filter: blur(14px);
			border: 1px solid #27272a;
			border-radius: 8px;
			padding: 6px 12px;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 10px;
			max-width: calc(100vw - 20px);
			color: #f4f4f5;
			box-shadow: 0 8px 30px rgba(0,0,0,0.8);
			font-size: 12px;
			pointer-events: auto;
		}
		.satf-hud-stat {
			display: flex;
			align-items: center;
			gap: 4px;
		}
		.satf-hud-ff {
			font-weight: 800;
			font-family: monospace;
			font-size: 13px;
			color: #f4f4f5;
		}
		.ff-white { color: #f4f4f5 !important; }
		.ff-green { color: #10b981 !important; }
		.ff-blue { color: #3b82f6 !important; }
		.ff-yellow { color: #eab308 !important; }
		.ff-red { color: #ef4444 !important; }
		.satf-hud-btn {
			background: #27272a;
			border: 1px solid #3f3f46;
			color: #fff;
			border-radius: 6px;
			padding: 4px 10px;
			font-size: 11px;
			font-weight: 700;
			cursor: pointer;
			transition: all 0.15s;
		}
		.satf-hud-btn:hover:not(:disabled) {
			background: #3f3f46;
			border-color: #10b981;
		}
		.satf-hud-btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}
		.satf-hud-btn-danger:hover:not(:disabled) {
			border-color: #ef4444;
			color: #f87171;
		}
	</style>
	<div id="satf-attack-bar">
		<div class="satf-hud-stat">
			<span style="color:#a1a1aa; font-weight: 700; font-size: 11px;">FF:</span>
			<span id="satf-hud-ff" class="satf-hud-ff">--</span>
		</div>
		<button id="satf-hud-next" class="satf-hud-btn" type="button">Next</button>
		<button id="satf-hud-ignore" class="satf-hud-btn satf-hud-btn-danger" type="button" title="Ignore target and get next">Ignore</button>
	</div>
	`;

	const btnHudIgnore = hudRoot.getElementById("satf-hud-ignore");
	const btnHudNext = hudRoot.getElementById("satf-hud-next");

	btnHudIgnore?.addEventListener("click", () => {
		recordHudActivity();
		if (!state.ignoredTargets.includes(user2Id)) {
			state.ignoredTargets.push(user2Id);
			GM_setValue(STORAGE.ignoredTargets, state.ignoredTargets);
		}
		loadNextTargetDirectly(hudRoot);
	});

	btnHudNext?.addEventListener("click", () => {
		recordHudActivity();
		loadNextTargetDirectly(hudRoot);
	});

	if (initialData) {
		applyHudDetails(hudRoot, initialData);
	}
	return host;
}

export function initAttackPageHud(): void {
	const existingHost = document.getElementById("satf-attack-hud-host");

	if (state.disableHud) {
		if (existingHost) existingHost.remove();
		return;
	}

	const href = window.location.href;
	const isAttackPage =
		/sid=(attack|getInAttack)/i.test(href) ||
		/page=attack/i.test(href) ||
		href.includes("loader.php?sid=attack") ||
		href.includes("loader2.php?sid=attack") ||
		href.includes("page.php?sid=attack");

	if (!isAttackPage) {
		if (existingHost) existingHost.remove();
		sessionBountyTargets.clear();
		sessionWarTargets.clear();
		warTargetVerifiedId = 0;
		lastHandledOutcomeId = 0;
		return;
	}

	const match = href.match(/[?&#]user2id=(\d+)/i);
	const user2Id = match ? Number.parseInt(match[1] ?? "", 10) : 0;
	const token = state.token || GM_getValue(STORAGE.token, "");

	if (!user2Id || !token) {
		if (existingHost) existingHost.remove();
		sessionBountyTargets.clear();
		sessionWarTargets.clear();
		warTargetVerifiedId = 0;
		lastHandledOutcomeId = 0;
		return;
	}

	recordHudActivity();

	if (existingHost && existingHost.dataset.targetId !== String(user2Id)) {
		existingHost.remove();
		sessionBountyTargets.clear();
		sessionWarTargets.clear();
		warTargetVerifiedId = 0;
		lastHandledOutcomeId = 0;
	}

	const isAlreadyMountedForCurrent =
		existingHost && existingHost.dataset.targetId === String(user2Id);

	const readyFiltered = getFilteredBountyList(state.bountiesReady);
	const bountyReadyIdx = readyFiltered.findIndex((t) => t.id === user2Id);
	let bountyTarget =
		bountyReadyIdx !== -1 ? (readyFiltered[bountyReadyIdx] ?? null) : null;

	if (bountyTarget) {
		sessionBountyTargets.set(user2Id, bountyTarget);
	} else if (sessionBountyTargets.has(user2Id)) {
		bountyTarget = sessionBountyTargets.get(user2Id) ?? null;
	}

	if (bountyTarget) {
		mountBountyHud(bountyTarget, bountyReadyIdx);
		return;
	}

	const isChainTarget =
		(state.currentTarget && state.currentTarget.id === user2Id) ||
		GM_getValue<WarTarget | null>(STORAGE.currentTarget, null)?.id === user2Id;

	if (!isWarEngaged() && !isChainTarget && !sessionWarTargets.has(user2Id)) {
		if (!isAlreadyMountedForCurrent) {
			const host = document.getElementById("satf-attack-hud-host");
			if (host) host.remove();
		}
		return;
	}

	function isKnownWarTarget(id: number): boolean {
		if (sessionWarTargets.has(id)) return true;
		if (!isWarEngaged()) return false;

		if (
			Array.isArray(state.warOpponentIds) &&
			state.warOpponentIds.includes(id)
		) {
			sessionWarTargets.add(id);
			return true;
		}

		const curTarget =
			(state.currentTarget && state.currentTarget.id === id
				? state.currentTarget
				: null) || GM_getValue<WarTarget | null>(STORAGE.currentTarget, null);
		if (curTarget && curTarget.id === id && curTarget.isWarTarget !== false) {
			sessionWarTargets.add(id);
			return true;
		}

		const inAvailable = (state.availableTargets || []).some(
			(t) => t.id === id && t.isWarTarget !== false,
		);
		const inHosp = (state.hospitalQueue || []).some((t) => t.id === id);
		if (inAvailable || inHosp) {
			sessionWarTargets.add(id);
			return true;
		}

		const inAll = (state.allTargets || []).some(
			(t) => t.id === id && t.isWarTarget !== false,
		);
		if (inAll) {
			sessionWarTargets.add(id);
			return true;
		}

		if (state.war?.opponent?.id) {
			const oppFacId = String(state.war.opponent.id);
			const factionLink = document.querySelector(
				`a[href*="factions.php?step=profile&ID=${oppFacId}"], a[href*="factions.php?step=profile&id=${oppFacId}"]`,
			);
			if (factionLink) {
				sessionWarTargets.add(id);
				return true;
			}
		}

		return false;
	}

	const savedCurrent = GM_getValue<WarTarget | null>(
		STORAGE.currentTarget,
		null,
	);
	const currentTarget =
		(state.currentTarget && state.currentTarget.id === user2Id
			? state.currentTarget
			: null) ||
		(savedCurrent && savedCurrent.id === user2Id ? savedCurrent : null) ||
		(state.availableTargets || []).find((t) => t.id === user2Id) ||
		(state.hospitalQueue || []).find((t) => t.id === user2Id) ||
		(state.allTargets || []).find((t) => t.id === user2Id) ||
		null;

	const isKnown = isKnownWarTarget(user2Id);
	if (currentTarget && currentTarget.id === user2Id) {
		sessionWarTargets.add(user2Id);
		mountHud(user2Id, currentTarget);
	} else if (isKnown) {
		sessionWarTargets.add(user2Id);
		mountHud(user2Id, null);
	}

	if (
		isWarEngaged() &&
		warTargetVerifiedId !== user2Id &&
		!warTargetVerificationInProgress
	) {
		warTargetVerificationInProgress = true;
		apiRequest<{ isWarTarget?: boolean; target?: WarTarget }>(
			`/v2/target-finder/war/targets/${user2Id}`,
		)
			.then((res) => {
				warTargetVerificationInProgress = false;
				warTargetVerifiedId = user2Id;
				const isWarTarget =
					res?.isWarTarget === true || res?.target?.isWarTarget === true;

				if (isWarTarget) {
					sessionWarTargets.add(user2Id);
					if (!state.warOpponentIds.includes(user2Id)) {
						state.warOpponentIds.push(user2Id);
						try {
							GM_setValue(STORAGE.warOpponentIds, state.warOpponentIds);
						} catch {}
					}

					const host = mountHud(user2Id, res.target ?? null);
					if (res.target) {
						state.currentTarget = res.target;
						GM_setValue(STORAGE.currentTarget, res.target);
						if (host?.shadowRoot) {
							applyHudDetails(host.shadowRoot, res.target);
						}
					}
				} else if (
					!isChainTarget &&
					!sessionWarTargets.has(user2Id) &&
					(!currentTarget || currentTarget.id !== user2Id)
				) {
					const host = document.getElementById("satf-attack-hud-host");
					if (host && host.dataset.targetId === String(user2Id)) {
						host.remove();
					}
				}
			})
			.catch(() => {
				warTargetVerificationInProgress = false;
			});
	}
}
