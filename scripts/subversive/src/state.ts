import { DEFAULTS, STORAGE } from "./constants";
import type { AppState, BountyTarget, WarTarget } from "./types";
import { safeJsonParse } from "./utils/formatters";

const rawCachedBounties = safeJsonParse<{ readyTargets?: BountyTarget[] }>(
	GM_getValue(STORAGE.cachedBounties, "{}"),
	{},
);

function getStoredBool(key: string, fallback: boolean): boolean {
	const val = GM_getValue<unknown>(key, fallback);
	if (typeof val === "boolean") return val;
	if (typeof val === "string") return val === "true";
	return fallback;
}

export const state: AppState = {
	apiUrl: (() => {
		const stored = GM_getValue<string>(STORAGE.apiUrl, "");
		if (stored && !stored.includes("subversive.blasted-labs.tech")) {
			return stored.replace(/\/+$/, "");
		}
		if (stored?.includes("subversive.blasted-labs.tech")) {
			try {
				GM_setValue(STORAGE.apiUrl, DEFAULTS.apiUrl);
			} catch {}
		}
		return DEFAULTS.apiUrl;
	})(),
	token: GM_getValue<string>(STORAGE.token, "") || "",
	user: GM_getValue<AppState["user"]>(STORAGE.user, null),
	panelOpen: getStoredBool(STORAGE.panelOpen, false),
	persistOpen: getStoredBool(STORAGE.persistOpen, DEFAULTS.persistOpen),
	minFFThreshold:
		Number(
			GM_getValue<number>(STORAGE.minFFThreshold, DEFAULTS.minFFThreshold),
		) || 1.2,
	maxFFThreshold:
		Number(
			GM_getValue<number>(STORAGE.maxFFThreshold, DEFAULTS.maxFFThreshold),
		) || 3.0,
	maxBSThreshold:
		Number(
			GM_getValue<number>(STORAGE.maxBSThreshold, DEFAULTS.maxBSThreshold),
		) || 5e9,
	directAttack: getStoredBool(STORAGE.directAttack, DEFAULTS.directAttack),
	disableHud: getStoredBool(STORAGE.disableHud, DEFAULTS.disableHud),
	hideHighFF: Boolean(GM_getValue<boolean>(STORAGE.hideHighFF, false)),
	hideHighBS: Boolean(GM_getValue<boolean>(STORAGE.hideHighBS, false)),
	ignoredTargets: GM_getValue<number[]>(STORAGE.ignoredTargets, []) || [],
	war: null,
	warState: GM_getValue<string>(STORAGE.warState, "no_war"),
	warOpponentIds: GM_getValue<number[]>(STORAGE.warOpponentIds, []) || [],
	currentTarget: null,
	isTargetScouting: false,
	scoutCooldownTimer: null,
	allTargets: GM_getValue<WarTarget[]>(STORAGE.cachedTargets, []) || [],
	availableTargets: [],
	targetSortBy: (() => {
		const val = GM_getValue<string>(STORAGE.targetSortBy, "ff");
		return val === "level" ? "ff" : val;
	})(),
	targetSortOrder: GM_getValue<"asc" | "desc">(STORAGE.targetSortOrder, "desc"),
	hospitalQueue: [],
	hospLastSynced: null,
	hospTimer: null,
	syncTimer: null,
	countdownTimer: null,
	dibs: new Map(),
	dibsLeadTimeSeconds: 300,
	loading: false,
	statusText: "Ready",
	statusType: "ok",
	activeTab:
		(() => {
			const saved = GM_getValue<string>(STORAGE.activeTab, "war");
			return saved === "hosp" || saved === "target" ? "war" : saved;
		})() || "war",
	warSubTab: GM_getValue<string>(STORAGE.warSubTab, "targets") || "targets",
	excludeIds: [],
	bountiesReady: Array.isArray(rawCachedBounties.readyTargets)
		? rawCachedBounties.readyTargets
		: [],
	bountyMinReward: Number(GM_getValue(STORAGE.bountyMinReward, 0)) || 0,
	bountyMaxReward: Number(GM_getValue(STORAGE.bountyMaxReward, 0)) || 0,
};

export function getFilteredBountyList(list: BountyTarget[]): BountyTarget[] {
	if (!Array.isArray(list)) return [];
	return list.filter((t) => {
		const reward = t.reward || 0;
		if (state.bountyMinReward > 0 && reward < state.bountyMinReward)
			return false;
		if (state.bountyMaxReward > 0 && reward > state.bountyMaxReward)
			return false;
		return true;
	});
}

export function isWarEngaged(): boolean {
	const s = state.war ? state.war.state : state.warState;
	return s === "active" || s === "scheduled";
}
