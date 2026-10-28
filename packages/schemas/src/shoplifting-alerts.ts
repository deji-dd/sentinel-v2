/**
 * Torn shoplifting security alerts.
 *
 * `/torn/shoplifting` publishes one entry per shop with the state of that shop's
 * security measures:
 *
 * ```json
 * { "id": 217, "status": [
 *   { "title": "Two cameras", "disabled": false },
 *   { "title": "One guard", "disabled": false }
 * ] }
 * ```
 *
 * Each measure is either active or temporarily disabled (cameras break for
 * 30–60 minutes, checkpoints for 8–12 hours, guards for 10–15 minutes), and a
 * clean window is the best time to run the crime. These are **personal**, DM
 * subscriptions created with `/shoplifting-alerts`, mirroring the personal stock
 * alerts created with `/stock-alerts`.
 *
 * Alerts fire on the **transition** into and out of a disabled window, not while
 * it holds, so a guard's entire break produces one "on break" DM and one "back"
 * DM rather than one of each every poll.
 */

/** The three security families Torn publishes, in display order. */
export const SHOPLIFTING_SECURITY_KINDS = [
	"cameras",
	"checkpoint",
	"guards",
] as const;

export type ShopliftingSecurityKind =
	(typeof SHOPLIFTING_SECURITY_KINDS)[number];

/** One shop and the security measures it can carry. */
export interface ShopliftingShop {
	id: number;
	name: string;
	security: ShopliftingSecurityKind[];
}

/**
 * The eight shoplifting shops, keyed by Torn's sub-crime id.
 *
 * Ids and security layouts come from Torn's own crime reference data / the
 * `/torn/shoplifting` response. The list is static because it is the picker's
 * universe — the live response only reports statuses, never names.
 */
export const SHOPLIFTING_SHOPS: readonly ShopliftingShop[] = [
	{ id: 19, name: "Sally's Sweet Shop", security: ["cameras"] },
	{ id: 20, name: "Bits 'n' Bobs", security: ["cameras"] },
	{ id: 21, name: "TC Clothing", security: ["cameras", "checkpoint"] },
	{ id: 22, name: "Super Store", security: ["cameras", "checkpoint"] },
	{ id: 217, name: "Cyber Force", security: ["cameras", "guards"] },
	{ id: 218, name: "Pharmacy", security: ["cameras", "checkpoint"] },
	{ id: 23, name: "Big Al's Gun Shop", security: ["cameras", "guards"] },
	{ id: 24, name: "Jewelry Store", security: ["cameras", "guards"] },
];

export function findShopliftingShop(shopId: number): ShopliftingShop | null {
	return SHOPLIFTING_SHOPS.find((shop) => shop.id === shopId) ?? null;
}

export function isShopliftingShopId(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		SHOPLIFTING_SHOPS.some((shop) => shop.id === value)
	);
}

/** Human-readable names for the security families. */
export const SHOPLIFTING_SECURITY_LABELS: Record<
	ShopliftingSecurityKind,
	string
> = {
	cameras: "Cameras",
	checkpoint: "Checkpoint",
	guards: "Guards",
};

/**
 * What a personal subscription watches.
 *
 * Deliberately small: "cameras", "guards" or both/everything down. Checkpoints
 * are covered by `all_down`, which is the window that matters most when a shop
 * has one.
 */
export const USER_SHOPLIFTING_ALERT_CONDITIONS = [
	"cameras_down",
	"guards_down",
	"all_down",
] as const;

export type UserShopliftingAlertCondition =
	(typeof USER_SHOPLIFTING_ALERT_CONDITIONS)[number];

export const USER_SHOPLIFTING_ALERT_CONDITION_LABELS: Record<
	UserShopliftingAlertCondition,
	string
> = {
	cameras_down: "Cameras disabled",
	guards_down: "Guards on break",
	all_down: "All security disabled",
};

export function isUserShopliftingAlertCondition(
	value: unknown,
): value is UserShopliftingAlertCondition {
	return (
		typeof value === "string" &&
		(USER_SHOPLIFTING_ALERT_CONDITIONS as readonly string[]).includes(value)
	);
}

/**
 * Whether a condition can ever be true for a shop.
 *
 * A guards alert on a shop with no guard would only ever sit silently, so it is
 * rejected when the subscription is created rather than stored and never fired.
 */
export function isUserShopliftingAlertConditionAvailable(
	condition: UserShopliftingAlertCondition,
	shopId: number,
): boolean {
	const shop = findShopliftingShop(shopId);
	if (!shop) return false;

	switch (condition) {
		case "cameras_down":
			return shop.security.includes("cameras");
		case "guards_down":
			return shop.security.includes("guards");
		case "all_down":
			// A single-measure shop would make this identical to watching that one
			// measure, so it is only offered where "all" actually means more than one.
			return shop.security.length > 1;
	}
}

/** The conditions worth offering for a shop, in vocabulary order. */
export function shopliftingAlertConditionsForShop(
	shopId: number,
): UserShopliftingAlertCondition[] {
	return USER_SHOPLIFTING_ALERT_CONDITIONS.filter((condition) =>
		isUserShopliftingAlertConditionAvailable(condition, shopId),
	);
}

/** One security measure as Torn reports it. */
export interface ShopliftingSecurityStatus {
	title: string;
	disabled: boolean;
}

/** The state of one shop for one poll. */
export interface ShopliftingShopSnapshot {
	shopId: number;
	name: string;
	statuses: ShopliftingSecurityStatus[];
}

/** Classifies one Torn status title into a security family. */
export function readShopliftingSecurityKind(
	title: string,
): ShopliftingSecurityKind | null {
	const lower = title.toLowerCase();
	if (lower.includes("camera")) return "cameras";
	if (lower.includes("checkpoint")) return "checkpoint";
	if (lower.includes("guard")) return "guards";
	return null;
}

/** Per-family counts and whether every measure in that family is disabled. */
export interface ShopliftingSecurityReading {
	kind: ShopliftingSecurityKind;
	total: number;
	disabled: number;
}

/** Reads the security families present in a shop's status list. */
export function readShopliftingSecurity(
	statuses: ShopliftingSecurityStatus[],
): ShopliftingSecurityReading[] {
	const readings = new Map<
		ShopliftingSecurityKind,
		ShopliftingSecurityReading
	>();

	for (const status of statuses) {
		const kind = readShopliftingSecurityKind(status.title);
		if (!kind) continue;
		const reading = readings.get(kind) ?? {
			kind,
			total: 0,
			disabled: 0,
		};
		reading.total++;
		if (status.disabled) reading.disabled++;
		readings.set(kind, reading);
	}

	return SHOPLIFTING_SECURITY_KINDS.flatMap((kind) => {
		const reading = readings.get(kind);
		return reading ? [reading] : [];
	});
}

/**
 * Per-subscription memory.
 *
 * `wasTrue` is the edge memory that turns a polled status into an event: the
 * first poll seeds it so subscribing during an outage does not DM immediately,
 * and every later poll only fires when the value crosses from false to true.
 */
export interface UserShopliftingAlertState {
	seeded: boolean;
	wasTrue: boolean | null;
	lastAlertAt: number | null;
}

export function createEmptyUserShopliftingAlertState(): UserShopliftingAlertState {
	return { seeded: false, wasTrue: null, lastAlertAt: null };
}

/** A user's subscription to one security condition at one shop. */
export interface UserShopliftingAlertSubscription {
	id: string;
	/** Discord guild the command was run in; subscriptions never cross servers. */
	guildId: string;
	discordUserId: string;
	shopId: number;
	condition: UserShopliftingAlertCondition;
	/** Canonical signature, unique per user. */
	conditionKey: string;
	enabled: boolean;
	state: UserShopliftingAlertState;
	createdAt?: string;
	updatedAt?: string;
}

/** Which way a monitored security condition just crossed. */
export type UserShopliftingAlertTransition = "down" | "up";

/** One triggered subscription, carried over IPC to the bot for delivery. */
export interface UserShopliftingAlertEvent {
	subscriptionId: string;
	discordUserId: string;
	condition: UserShopliftingAlertCondition;
	/** Whether the watched security just went down or came back. */
	transition: UserShopliftingAlertTransition;
	/** Human-readable trigger, e.g. "Guards on break at Jewelry Store." */
	description: string;
	shopId: number;
	shopName: string;
	/** The full security state at the moment the alert fired. */
	statuses: ShopliftingSecurityStatus[];
}

/** Payload of one batch of personal shoplifting alerts, one DM per user. */
export interface UserShopliftingAlertBatchPayload {
	alerts: UserShopliftingAlertEvent[];
}

/** Longest a single user may keep. */
export const MAX_USER_SHOPLIFTING_ALERTS = 25;

/**
 * Backstop against a status flapping at the API edge.
 *
 * The edge memory already prevents repeats while a window holds; this only
 * stops a down/up/down sequence inside a few minutes from producing a second DM.
 */
export const USER_SHOPLIFTING_ALERT_COOLDOWN_MINUTES = 5;

/** Canonical signature of a subscription, unique per user. */
export function buildUserShopliftingAlertConditionKey(params: {
	shopId: number;
	condition: UserShopliftingAlertCondition;
}): string {
	return `${params.shopId}:${params.condition}`;
}

/** One-line description of a subscription, shared by the list view and the DM. */
export function describeUserShopliftingAlert(subscription: {
	shopId: number;
	condition: UserShopliftingAlertCondition;
}): string {
	const shop = findShopliftingShop(subscription.shopId);
	const label = USER_SHOPLIFTING_ALERT_CONDITION_LABELS[subscription.condition];
	return shop ? `${label} at ${shop.name}` : label;
}
