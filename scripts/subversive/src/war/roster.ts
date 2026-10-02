import { apiRequest } from "../api/client";
import { STORAGE } from "../constants";
import { isWarEngaged, state } from "../state";
import type { WarTarget } from "../types";
import { formatStats, getFFColor, getFFTier } from "../utils/formatters";
import { renderWarBanner } from "./war-banner";

let availList: HTMLElement | null = null;
let availCount: HTMLElement | null = null;
let tabTargetsCount: HTMLElement | null = null;

export function initRosterElements(root: ShadowRoot | Document): void {
	availList = root.getElementById("satf-avail-list") as HTMLElement | null;
	availCount = root.getElementById("satf-avail-count") as HTMLElement | null;
	tabTargetsCount = root.getElementById(
		"satf-war-targets-count",
	) as HTMLElement | null;
}

export function getNextTargetCandidate(excludeId?: number): WarTarget | null {
	if (!isWarEngaged()) return null;

	const excludes = new Set([
		...state.excludeIds.slice(-20),
		...state.ignoredTargets,
		...(excludeId ? [excludeId] : []),
	]);

	const pool = (state.allTargets || []).filter((t) => {
		if (excludes.has(t.id)) return false;
		if (state.hideHighFF && t.fairFight > state.maxFFThreshold) return false;
		if (state.hideHighBS && t.estimatedBs > state.maxBSThreshold) return false;
		if (t.statusCategory === "early_discharge" || t.hasEarlyDischarge)
			return false;
		const st = (t.status?.state || "").toLowerCase();
		if (st === "hospital") return false;
		return true;
	});

	if (pool.length === 0) return null;

	const multiplier = state.targetSortOrder === "asc" ? 1 : -1;
	const sorted = [...pool];
	if (state.targetSortBy === "ff") {
		sorted.sort((a, b) => (a.fairFight - b.fairFight) * multiplier);
	} else if (state.targetSortBy === "online") {
		sorted.sort(
			(a, b) => ((a.isOnline ? 1 : 0) - (b.isOnline ? 1 : 0)) * multiplier,
		);
	} else if (state.targetSortBy === "bs") {
		sorted.sort((a, b) => (a.estimatedBs - b.estimatedBs) * multiplier);
	}
	return sorted[0] || null;
}

export function renderAvailableTargets(targets?: WarTarget[]): void {
	if (!availList || !availCount) return;
	if (Array.isArray(targets)) {
		state.allTargets = targets;
		try {
			GM_setValue(STORAGE.cachedTargets, targets);
		} catch {}
	}

	if (!isWarEngaged()) {
		state.availableTargets = [];
		if (availCount) availCount.textContent = "0";
		if (tabTargetsCount) tabTargetsCount.textContent = "0";
		availList.innerHTML = `
			<div style="text-align: center; padding: 16px 0; color: var(--muted); font-size: 11px;">
				No active or scheduled ranked war. Opponent tracking on standby.
			</div>
		`;
		return;
	}

	const source = state.allTargets || [];
	state.availableTargets = source.filter((t) => {
		if (state.ignoredTargets.includes(t.id)) return false;
		if (state.hideHighFF && t.fairFight > state.maxFFThreshold) return false;
		if (state.hideHighBS && t.estimatedBs > state.maxBSThreshold) return false;
		if (t.statusCategory === "early_discharge" || t.hasEarlyDischarge)
			return false;
		const st = (t.status?.state || "").toLowerCase();
		if (st === "hospital") return false;
		return true;
	});
	const countStr = String(state.availableTargets.length);
	if (availCount) availCount.textContent = countStr;
	if (tabTargetsCount) tabTargetsCount.textContent = countStr;

	if (state.availableTargets.length === 0) {
		const activeFilters: string[] = [];
		if (state.hideHighFF)
			activeFilters.push(`FF <= ${state.maxFFThreshold.toFixed(1)}`);
		if (state.hideHighBS)
			activeFilters.push(`BS <= ${formatStats(state.maxBSThreshold)}`);
		const filterDesc =
			activeFilters.length > 0 ? ` (within ${activeFilters.join(" & ")})` : "";
		availList.innerHTML = `
			<div style="text-align: center; padding: 16px 0; color: var(--muted); font-size: 11px;">
				No opponents currently ready${filterDesc}. Check Hospital Queue.
			</div>
		`;
		return;
	}

	const sorted = [...state.availableTargets];
	const multiplier = state.targetSortOrder === "asc" ? 1 : -1;
	if (state.targetSortBy === "ff") {
		sorted.sort((a, b) => (a.fairFight - b.fairFight) * multiplier);
	} else if (state.targetSortBy === "online") {
		sorted.sort(
			(a, b) => ((a.isOnline ? 1 : 0) - (b.isOnline ? 1 : 0)) * multiplier,
		);
	} else if (state.targetSortBy === "bs") {
		sorted.sort((a, b) => (a.estimatedBs - b.estimatedBs) * multiplier);
	}

	availList.innerHTML = sorted
		.map((t) => {
			const onlineDot = t.isOnline
				? '<span class="satf-dot-online"></span>'
				: "";
			const ff =
				typeof t.fairFight === "number" && !Number.isNaN(t.fairFight)
					? t.fairFight
					: 1.0;
			return `
				<div class="satf-roster-row" data-id="${t.id}" data-url="${t.attackUrl}">
					<div class="satf-roster-left">
						<div class="satf-roster-name">
							${onlineDot}
							<span style="font-weight:700;">${t.name}</span>
							<span style="color:var(--muted); font-size:11px;">[${t.id}] Lvl ${t.level}</span>
						</div>
						<div class="satf-roster-sub">
							BS ${formatStats(t.estimatedBs)} · <span class="ff-${getFFTier(ff)}" style="font-weight:700; color:${getFFColor(ff)};">FF: ${ff.toFixed(2)}</span>
						</div>
					</div>
					<div class="satf-roster-right">
						<a class="satf-btn satf-btn-primary satf-btn-sm" href="${t.attackUrl}" target="${state.directAttack ? "_self" : "_blank"}" style="text-decoration:none;">Hit</a>
					</div>
				</div>
			`;
		})
		.join("");

	availList.querySelectorAll<HTMLElement>(".satf-roster-row").forEach((row) => {
		row.addEventListener("click", (e) => {
			if ((e.target as HTMLElement | null)?.closest("a")) return;
			const id = Number.parseInt(row.getAttribute("data-id") || "", 10);
			const targetObj = state.availableTargets.find((t) => t.id === id);
			if (!targetObj?.attackUrl) return;

			if (state.directAttack) {
				window.location.href = targetObj.attackUrl;
			} else {
				window.open(targetObj.attackUrl, "_blank");
			}
		});
	});
}

export async function fetchAvailableTargets(): Promise<void> {
	if (!state.token) return;
	try {
		const params = new URLSearchParams({
			maxFF: state.hideHighFF ? String(state.maxFFThreshold) : "10.0",
		});
		if (state.hideHighBS) {
			params.set("maxBS", String(state.maxBSThreshold));
		}
		const res = await apiRequest<{
			war?: typeof state.war;
			targets?: WarTarget[];
		}>(`/v2/target-finder/war/targets/available?${params.toString()}`);
		if (res?.war) {
			state.war = res.war;
			state.warState = res.war.state;
			try {
				GM_setValue(STORAGE.warState, res.war.state);
			} catch {}
			renderWarBanner(res.war);
		}
		if (Array.isArray(res?.targets)) {
			renderAvailableTargets(res.targets);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.debug(
			"[Subversive Alliance] Failed to fetch available targets:",
			msg,
		);
	}
}
