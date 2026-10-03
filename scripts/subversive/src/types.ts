declare global {
	function GM_getValue<T>(key: string, defaultValue?: T): T;
	function GM_setValue<T>(key: string, value: T): void;
	function GM_xmlhttpRequest(details: {
		method?: string;
		url: string;
		headers?: Record<string, string>;
		data?: string;
		timeout?: number;
		onload?: (response: { status: number; responseText: string }) => void;
		onerror?: (error: unknown) => void;
		ontimeout?: () => void;
	}): void;
	function GM_openInTab(url: string, active?: boolean): void;
	function GM_registerMenuCommand(caption: string, onClick: () => void): void;
}

export interface UserSessionData {
	tornId: number;
	name: string;
	tornName?: string;
	/** Family faction the session belongs to (2013 / 27312). */
	factionId?: number;
	factionName?: string;
	bsScore?: number;
	role?: string;
}

export interface TargetStatus {
	state: string;
	description?: string;
	details?: string | null;
	color?: string;
	until?: number | null;
}

export interface WarTarget {
	id: number;
	name: string;
	level: number;
	fairFight: number;
	estimatedBs: number;
	isOnline: boolean;
	statusCategory?: string;
	hasEarlyDischarge?: boolean;
	status?: TargetStatus;
	attackUrl?: string;
	isWarTarget?: boolean;
	isInactive?: boolean;
	/** Opponent struck a family member within the last 5 minutes. */
	hasRetal?: boolean;
}

export interface BountyTarget {
	id: number;
	name: string;
	level?: number;
	reward: number;
	fairFight?: number;
	estimatedBs?: number;
	attackUrl?: string;
	status?: TargetStatus;
}

export interface DibsItem {
	targetId: number;
	userId: number;
	userName: string;
	claimedAt: number;
	expiresAt: number;
}

export interface WarFactionInfo {
	id: number;
	name: string;
	score: number;
	chain: number;
}

export interface CurrentWarInfo {
	warId?: number;
	state: "active" | "scheduled" | "no_war" | "ended" | string;
	/** Family faction this war belongs to (2013 / 27312). */
	factionId?: number;
	factionName?: string;
	start?: number;
	target?: number;
	winner?: number | null;
	lead?: number;
	opponent?: WarFactionInfo | null;
	subversive?: WarFactionInfo | null;
	/** The viewing member's own landed ranked war hits this war. */
	userHitCount?: number;
	lastUpdated?: number;
}

export interface AppState {
	apiUrl: string;
	token: string;
	user: UserSessionData | null;
	panelOpen: boolean;
	persistOpen: boolean;
	minFFThreshold: number;
	maxFFThreshold: number;
	maxBSThreshold: number;
	directAttack: boolean;
	disableHud: boolean;
	hideHighFF: boolean;
	hideHighBS: boolean;
	ignoredTargets: number[];
	war: CurrentWarInfo | null;
	warState: string;
	warOpponentIds: number[];
	currentTarget: WarTarget | null;
	isTargetScouting: boolean;
	scoutCooldownTimer: ReturnType<typeof setTimeout> | null;
	allTargets: WarTarget[];
	availableTargets: WarTarget[];
	targetSortBy: string;
	targetSortOrder: string;
	hospitalQueue: WarTarget[];
	hospLastSynced: number | null;
	hospTimer: ReturnType<typeof setInterval> | null;
	syncTimer: ReturnType<typeof setInterval> | null;
	countdownTimer: ReturnType<typeof setInterval> | null;
	dibs: Map<number, DibsItem>;
	dibsLeadTimeSeconds: number;
	loading: boolean;
	statusText: string;
	statusType: string;
	activeTab: string;
	warSubTab: string;
	excludeIds: number[];
	bountiesReady: BountyTarget[];
	bountyMinReward: number;
	bountyMaxReward: number;
}
