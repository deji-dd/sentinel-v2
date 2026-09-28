import { apiRequest } from "../api/client";
import { STORAGE } from "../constants";
import { getFilteredBountyList, state } from "../state";
import type { BountyTarget } from "../types";
import { formatMoney, getBountyFF, getFFColor } from "../utils/formatters";

let rootElement: ShadowRoot | Document | null = null;
let setBountiesStatusFn: ((msg: string, type: "ok" | "error") => void) | null =
	null;

export function initBounties(
	root: ShadowRoot | Document,
	setBountiesStatus: (msg: string, type: "ok" | "error") => void,
): void {
	rootElement = root;
	setBountiesStatusFn = setBountiesStatus;
}

export function updateBountyBadges(): void {
	if (!rootElement) return;
	const readyFiltered = getFilteredBountyList(state.bountiesReady);

	const tabBadge = rootElement.getElementById("satf-bounties-tab-count");
	if (tabBadge) {
		tabBadge.textContent = String(readyFiltered.length);
	}
	const countReady = rootElement.getElementById("satf-bounty-ready-count");
	if (countReady) {
		countReady.textContent = String(readyFiltered.length);
	}
}

export function renderBountyReadyTargets(targets?: BountyTarget[]): void {
	if (!rootElement) return;
	const pane = rootElement.getElementById("satf-bounties-pane-ready");
	if (!pane) return;
	const rawList = Array.isArray(targets) ? targets : state.bountiesReady;
	const list = getFilteredBountyList(rawList);
	if (!list || list.length === 0) {
		pane.innerHTML = `
			<div class="satf-bounty-empty">
				No bounty targets currently available${state.bountyMinReward > 0 || state.bountyMaxReward > 0 ? " matching reward filter" : ""}.
			</div>
		`;
		return;
	}

	pane.innerHTML = list
		.map((t) => {
			const ffVal = getBountyFF(t);
			const ffText =
				ffVal !== null && ffVal !== undefined
					? `FF: ${ffVal.toFixed(2)}`
					: "FF: ?";
			const ffColor = getFFColor(ffVal);

			return `
				<div class="satf-bounty-row" data-id="${t.id}">
					<div class="satf-bounty-left">
						<div class="satf-bounty-name-row">
							<a href="https://www.torn.com/profiles.php?XID=${t.id}" target="_blank" style="color:inherit;text-decoration:none;font-weight:700;">${t.name}</a>
							<span class="satf-bounty-id">[${t.id}]</span>
						</div>
						<div class="satf-bounty-sub">
							<span style="font-weight: 700; font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid ${ffColor}50; background: ${ffColor}18; color: ${ffColor};">${ffText}</span>
						</div>
					</div>
					<div class="satf-bounty-right">
						<span class="satf-bounty-reward">${formatMoney(t.reward)}</span>
						<a class="satf-bounty-hit-btn" href="${t.attackUrl}" target="${state.directAttack ? "_self" : "_blank"}" rel="noopener">Hit</a>
					</div>
				</div>
			`;
		})
		.join("");

	pane.querySelectorAll<HTMLElement>(".satf-bounty-row").forEach((row) => {
		row.addEventListener("click", (e) => {
			if ((e.target as HTMLElement | null)?.closest("a, button")) return;
			const id = Number.parseInt(row.getAttribute("data-id") || "", 10);
			if (!id) return;
			const profileUrl = `https://www.torn.com/profiles.php?XID=${id}`;
			if (state.directAttack) {
				window.location.href = profileUrl;
			} else {
				window.open(profileUrl, "_blank");
			}
		});
	});
}

export function applyBountyData(
	res: { readyTargets?: BountyTarget[] } | null,
): void {
	if (!res) return;
	state.bountiesReady = Array.isArray(res.readyTargets) ? res.readyTargets : [];
	try {
		GM_setValue(
			STORAGE.cachedBounties,
			JSON.stringify({
				readyTargets: state.bountiesReady,
			}),
		);
	} catch {}

	updateBountyBadges();
	renderBountyReadyTargets(state.bountiesReady);

	if (setBountiesStatusFn) setBountiesStatusFn("Ready", "ok");
}

export async function fetchBounties(): Promise<void> {
	if (!state.token) return;
	try {
		const res = await apiRequest<{ readyTargets?: BountyTarget[] }>(
			"/api/v1/personal/bounties",
		);
		applyBountyData(res);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (setBountiesStatusFn) {
			setBountiesStatusFn(msg, "error");
		}
	}
}
