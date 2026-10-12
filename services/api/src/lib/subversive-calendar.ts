import {
	and,
	db,
	desc,
	eq,
	gte,
	isNull,
	lte,
	or,
	subversiveCalendarEvents,
	subversiveRankedWars,
	tornCalendarActivities,
} from "@sentinel/database";
import { Logger, PRIMARY_SUBVERSIVE_FACTION_ID } from "@sentinel/utils";

const logger = new Logger("SubversiveCalendar");

export interface CalendarEventPayload {
	id: string;
	title: string;
	description: string;
	category: string;
	source: "torn" | "faction";
	startTime: string; // ISO string
	endTime: string; // ISO string
	startTimestamp: number; // Unix seconds
	endTimestamp: number; // Unix seconds
	isAllDay: boolean;
	color?: string | null;
	badge?: string | null;
	/** Display label for `category`; the category is also the event's title. */
	categoryLabel?: string;
	/**
	 * Battlestats members hold during a 'steadfast_change', as
	 * 'strength' | 'speed' | 'dexterity' | 'defense'. Null for other categories.
	 */
	primaryStat?: string | null;
	secondaryStat?: string | null;
	factionId?: number;
	createdById?: string | null;
	createdByName?: string | null;
	/**
	 * True only for rows backed by `subversive_calendar_events`. Derived entries
	 * (ranked wars mirrored from `subversive_ranked_wars`) cannot be edited or
	 * deleted through the calendar API, so the UI must not offer it.
	 */
	editable: boolean;
}

/**
 * A faction calendar category.
 *
 * The label *is* the event title — no category asks the creator to type one —
 * and the accent is fixed per category rather than chosen per event, so the
 * calendar's colours mean something.
 */
export interface FactionCategoryMeta {
	value: string;
	label: string;
	/** Fixed accent, as a hex colour the UI paints inline. */
	color: string;
}

/** The categories the dashboard offers, in display order. */
export const FACTION_CALENDAR_CATEGORIES: readonly FactionCategoryMeta[] = [
	{ value: "war", label: "Ranked War Enlistment", color: "#e03131" },
	{ value: "chain", label: "Chain", color: "#228be6" },
	{ value: "competition", label: "Competition", color: "#7950f2" },
	{ value: "steadfast_change", label: "Steadfast Change", color: "#f59f00" },
] as const;

/** Battlestats a Steadfast Change can ask for. */
export const STEADFAST_STATS = [
	"strength",
	"speed",
	"dexterity",
	"defense",
] as const;

/**
 * Every official Torn activity shares this one accent, deliberately distinct
 * from every faction category, so a glance at a day dot says "Torn" or
 * "faction" before it says anything else.
 */
export const TORN_CALENDAR_ACCENT = "#4dabf7";

/**
 * Categories the form no longer offers. Events created before the change are
 * left readable, with the accent they were stored under.
 */
const RETIRED_CATEGORY_COLORS: Record<string, string> = {
	training: "#20c997",
	meeting: "#be4bdb",
	giveaway: "#f59f00",
	oc: "#fd7e14",
	general: "#12b886",
};

const FACTION_CATEGORY_BY_VALUE = new Map(
	FACTION_CALENDAR_CATEGORIES.map((category) => [category.value, category]),
);

/** True when `category` is one the dashboard can create. */
export function isFactionCalendarCategory(
	category: string,
): category is FactionCategoryMeta["value"] {
	return FACTION_CATEGORY_BY_VALUE.has(category);
}

/** The title a category carries — categories are titles, not labels on one. */
export function categoryTitle(category: string): string {
	return (
		FACTION_CATEGORY_BY_VALUE.get(category)?.label ??
		formatCategoryLabel(category)
	);
}

/** The fixed accent for a category, retired ones included. */
export function categoryAccent(category: string): string {
	return (
		FACTION_CATEGORY_BY_VALUE.get(category)?.color ??
		RETIRED_CATEGORY_COLORS[category] ??
		"#12b886"
	);
}

interface TornOfficialEventMeta {
	title: string;
	description: string;
	badge?: string;
	isCompetition?: boolean;
}

// Official Torn visual metadata mapping by event title
const TORN_EVENT_METADATA: Record<string, TornOfficialEventMeta> = {
	"Awareness Awareness Week": {
		title: "Awareness Awareness Week",
		description: "Increased awareness for one week",
		badge: "Awareness",
	},
	"Weekend Road Trip": {
		title: "Weekend Road Trip",
		description: "Double racing points & racing skill",
		badge: "Racing",
	},
	"Valentine's Day": {
		title: "Valentine's Day",
		description: "Love Juice reduces the energy cost of attacking & reviving",
		badge: "Love Juice",
	},
	"Employee Appreciation Day": {
		title: "Employee Appreciation Day",
		description: "Job points received tripled & training effects tripled",
		badge: "Work/Train",
	},
	"St Patrick's Day": {
		title: "St Patrick's Day",
		description: "Alcohol effects are doubled & Green Stout appears in city",
		badge: "Alcohol x2",
	},
	"420 Day": {
		title: "420 Day",
		description: "Cannabis effects are tripled",
		badge: "Cannabis x3",
	},
	"Museum Day": {
		title: "Museum Day",
		description: "10% bonus to museum point rewards",
		badge: "+10% Points",
	},
	"World Blood Donor Day": {
		title: "World Blood Donor Day",
		description: "Life and cooldown penalties for drawing blood are halved",
		badge: "Blood Bag",
	},
	"World Population Day": {
		title: "World Population Day",
		description: "Level and weapon EXP gained while attacking is doubled",
		badge: "EXP x2",
	},
	"World Tiger Day": {
		title: "World Tiger Day",
		description: "Hunting experience is increased by x5",
		badge: "Hunting x5",
	},
	"International Beer Day": {
		title: "International Beer Day",
		description: "Beer items are five times more effective",
		badge: "Beer x5",
	},
	"Tourism Day": {
		title: "Tourism Day",
		description: "Travel capacity doubled during this event",
		badge: "Carry x2",
	},
	CaffeineCon: {
		title: "CaffeineCon",
		description: "Energy drink effects are doubled",
		badge: "Cans x2",
	},
	"Trick or Treat": {
		title: "Trick or Treat",
		description: "Dress up and attack others to fill your basket with treats",
		badge: "Halloween",
	},
	"World Diabetes Day": {
		title: "World Diabetes Day",
		description: "Candy effects are tripled",
		badge: "Candy x3",
	},
	"Black Friday": {
		title: "Black Friday",
		description:
			"Torn's yearly dollar sale sees many bazaars listing goods for $1",
		badge: "$1 Sale",
	},
	"Slash Wednesday": {
		title: "Slash Wednesday",
		description: "Hospital times reduced by 75%",
		badge: "Hosp -75%",
	},
	"Torn Anniversary": {
		title: "Torn Anniversary",
		description: "Torn's anniversary celebration",
		badge: "Anniversary",
	},
	"Easter Egg Hunt": {
		title: "Easter Egg Hunt",
		description:
			"Easter eggs appear at random throughout Torn. Pick them up to add them to your inventory.",
		badge: "Easter Eggs",
		isCompetition: true,
	},
	"Christmas town": {
		title: "Christmas town",
		description:
			"Torn's very own festive theme park opens its doors to the public with maps, treasure, and traps!",
		badge: "Christmas Town",
	},
	Elimination: {
		title: "Elimination",
		description:
			"Twelve teams enter. One team survives. Fight in this daily battle for survival until a victor is crowned.",
		badge: "Tournament",
		isCompetition: true,
	},
	"Dog Tags": {
		title: "Dog Tags",
		description:
			"Battle for dog tags across the city in Torn's annual dog tags competition.",
		badge: "Competition",
		isCompetition: true,
	},
	"Mr & Ms Torn": {
		title: "Mr & Ms Torn",
		description: "Annual community beauty pageant and talent competition.",
		badge: "Pageant",
		isCompetition: true,
	},
};

function findMatchingMeta(title: string): TornOfficialEventMeta | undefined {
	for (const [key, meta] of Object.entries(TORN_EVENT_METADATA)) {
		if (title.toLowerCase().includes(key.toLowerCase())) {
			return meta;
		}
	}
	return undefined;
}

export function formatTornEventItem(
	item: {
		title: string;
		description: string;
		start: number;
		end: number;
	},
	isCompetition = false,
): CalendarEventPayload {
	const meta = findMatchingMeta(item.title);
	const startIso = new Date(item.start * 1000).toISOString();
	const endIso = new Date(item.end * 1000).toISOString();

	return {
		id: `torn_${isCompetition ? "comp" : "ev"}_${item.start}_${encodeURIComponent(item.title)}`,
		title: item.title,
		description: item.description || meta?.description || "",
		category: isCompetition ? "torn_competition" : "torn_event",
		source: "torn",
		startTime: startIso,
		endTime: endIso,
		startTimestamp: item.start,
		endTimestamp: item.end,
		isAllDay: false,
		color: TORN_CALENDAR_ACCENT,
		badge: meta?.badge ?? (isCompetition ? "Competition" : "Torn Event"),
		categoryLabel: isCompetition ? "Torn Competition" : "Torn Event",
		editable: false,
	};
}

/** Where the official Torn events came from, so the UI can be honest about gaps. */
export type TornCalendarSource = "database" | "unavailable";

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Repairs Torn's rolled-over recurring activities.
 *
 * Torn's calendar sometimes returns an annually recurring activity with its
 * `start` already rolled into the *next* year while `end` still belongs to the
 * running one, so `start > end`. The pair is then unusable: no day satisfies
 * `start <= day <= end`, the year filter drops the activity entirely, and the
 * running year silently loses events — including its Elimination competition.
 *
 * Every other row in the table describes the running year, and `end` is the half
 * of the pair that stays put, so pulling `start` back one year restores the
 * occurrence `end` describes. The observed rows confirm the reading: the shift
 * turns `Weekend Road Trip` into Sat 12:00 → Mon 12:00, `Employee Appreciation
 * Day` into a window centred on the first Friday of March, and `Elimination`
 * into Sat 12:00 → Fri 12:00, all exact whole-day durations, whereas keeping the
 * raw pair puts every one of them on a weekday the event never uses.
 *
 * A pair that one year cannot repair is returned untouched — inventing an
 * interval is worse than leaving it out, and the year filter will exclude it.
 */
export function repairRolledActivity(item: { start: number; end: number }): {
	start: number;
	end: number;
} {
	if (item.start <= item.end) return item;

	const rolledStart = item.start - SECONDS_PER_YEAR;

	return rolledStart <= item.end ? { start: rolledStart, end: item.end } : item;
}

export interface TornCalendarResult {
	events: CalendarEventPayload[];
	source: TornCalendarSource;
}

/** Cached snapshot of every official Torn activity, unfiltered by year. */
let cachedTornCalendar: TornCalendarResult | null = null;
let cachedTornCalendarAt = 0;

/** The scheduler rewrites the table once a day, so a populated snapshot ages slowly. */
const TORN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL

/**
 * How long an *empty* answer is trusted.
 *
 * An empty table is a state, not a fact: the API service routinely boots before
 * the scheduler's 00:15 reference sync has ever run (every fresh environment, and
 * every dev session where the API wins the race), and a table read failure is
 * equally transient. Holding that "unavailable" verdict for the full day is what
 * kept the dashboard telling members that official Torn events "are not available
 * yet" long after the table had been populated. The retry is deliberately short —
 * one query a minute at worst — so the warning clears itself instead of needing a
 * restart, while still shielding the database from a request flood.
 */
const TORN_UNAVAILABLE_RETRY_MS = 60 * 1000; // 60 seconds

/** A negative snapshot is re-verified quickly; a populated one is kept all day. */
export function tornCacheTtlMs(result: TornCalendarResult): number {
	return result.source === "database"
		? TORN_CACHE_TTL_MS
		: TORN_UNAVAILABLE_RETRY_MS;
}

/** Drops the in-process snapshot. Exported for tests. */
export function resetTornCalendarCache(): void {
	cachedTornCalendar = null;
	cachedTornCalendarAt = 0;
}

/**
 * Reads the official Torn events for a calendar year.
 *
 * `torn_calendar_activities` is owned by the scheduler (`torn:references`,
 * daily 00:15) because the API service never talks to Torn directly. When the
 * table is empty — migration applied but the sync has not run yet, or the table
 * is unreachable — this reports `source: "unavailable"` and an empty list rather
 * than inventing dates. Because the sync may simply not have run yet, that
 * negative answer is only trusted for {@link TORN_UNAVAILABLE_RETRY_MS} and then
 * re-read, so it clears itself once the scheduler populates the table.
 * `year` is optional; events overlapping the year are
 * returned, so a multi-day event spanning New Year appears in both years.
 */
export async function getTornCalendarEvents(options?: {
	year?: number;
	forceFresh?: boolean;
}): Promise<TornCalendarResult> {
	const now = Date.now();
	const cached =
		!options?.forceFresh &&
		cachedTornCalendar &&
		now - cachedTornCalendarAt < tornCacheTtlMs(cachedTornCalendar)
			? cachedTornCalendar
			: null;

	if (cached) {
		return {
			events: filterEventsByYear(cached.events, options?.year),
			source: cached.source,
		};
	}

	try {
		const rows = await db
			.select()
			.from(tornCalendarActivities)
			.orderBy(tornCalendarActivities.start);

		const events = rows.map((row) =>
			formatTornEventItem(
				{
					title: row.title,
					description: row.description,
					...repairRolledActivity({ start: row.start, end: row.end }),
				},
				row.type === "competition",
			),
		);

		cachedTornCalendar = {
			events,
			source: events.length > 0 ? "database" : "unavailable",
		};
		cachedTornCalendarAt = now;

		return {
			events: filterEventsByYear(events, options?.year),
			source: cachedTornCalendar.source,
		};
	} catch (err) {
		logger.warn(
			`Failed to load torn_calendar_activities from database: ${err instanceof Error ? err.message : String(err)}`,
		);

		// Cache the failure too, otherwise a broken/missing table turns every
		// calendar request into another failing query. `tornCacheTtlMs` keeps this
		// to a short retry rather than a day-long outage.
		cachedTornCalendar = { events: [], source: "unavailable" };
		cachedTornCalendarAt = now;

		return { events: [], source: "unavailable" };
	}
}

/** Keeps events overlapping the requested year (inclusive of both edges). */
function filterEventsByYear(
	events: CalendarEventPayload[],
	year?: number,
): CalendarEventPayload[] {
	if (!year) return events;

	const startOfYear = Math.floor(Date.UTC(year, 0, 1, 0, 0, 0) / 1000);
	const endOfYear = Math.floor(Date.UTC(year, 11, 31, 23, 59, 59) / 1000);

	return events.filter(
		(e) => e.startTimestamp <= endOfYear && e.endTimestamp >= startOfYear,
	);
}

/**
 * Retrieves faction calendar events for a given year.
 *
 * `includeRankedWars` mirrors the rows in `subversive_ranked_wars`. Those carry
 * the war's target score, so callers must opt in — the public (unauthenticated)
 * calendar leaves them out.
 */
export async function getFactionCalendarEvents(options?: {
	year?: number;
	factionId?: number;
	includeRankedWars?: boolean;
}): Promise<CalendarEventPayload[]> {
	const year = options?.year ?? new Date().getUTCFullYear();
	const startOfYear = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
	const endOfYear = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

	const conditions = [
		lte(subversiveCalendarEvents.startTime, endOfYear),
		gte(subversiveCalendarEvents.endTime, startOfYear),
	];

	if (options?.factionId) {
		conditions.push(eq(subversiveCalendarEvents.factionId, options.factionId));
	}

	const rows = await db
		.select()
		.from(subversiveCalendarEvents)
		.where(and(...conditions))
		.orderBy(subversiveCalendarEvents.startTime);

	const factionEvents: CalendarEventPayload[] = rows.map((r) => {
		const startMs = r.startTime.getTime();
		const endMs = r.endTime.getTime();
		return {
			id: r.id,
			title: r.title,
			description: r.description,
			category: r.category,
			source: "faction",
			startTime: r.startTime.toISOString(),
			endTime: r.endTime.toISOString(),
			startTimestamp: Math.floor(startMs / 1000),
			endTimestamp: Math.floor(endMs / 1000),
			isAllDay: r.isAllDay,
			// Accents are fixed per category, so a stored per-event colour is no
			// longer consulted — the colour on screen is the category's.
			color: categoryAccent(r.category),
			badge: categoryTitle(r.category),
			categoryLabel: categoryTitle(r.category),
			primaryStat: r.primaryStat,
			secondaryStat: r.secondaryStat,
			factionId: r.factionId,
			createdById: r.createdById,
			createdByName: r.createdByName,
			editable: true,
		};
	});

	if (!options?.includeRankedWars) {
		return factionEvents.sort((a, b) => a.startTimestamp - b.startTimestamp);
	}

	// Ranked wars mirror `subversive_ranked_wars`. A running war has `end IS NULL`
	// (the recruitment worker stores 0/null until Torn reports an end), so the
	// NULL branch is what surfaces the war that is live right now.
	try {
		const warRows = await db
			.select()
			.from(subversiveRankedWars)
			.where(
				and(
					lte(subversiveRankedWars.start, endOfYear),
					or(
						gte(subversiveRankedWars.end, startOfYear),
						isNull(subversiveRankedWars.end),
					),
				),
			)
			.orderBy(desc(subversiveRankedWars.start))
			.limit(20);

		for (const w of warRows) {
			if (!w.start) continue;
			const end =
				w.end ?? new Date(w.start.getTime() + 3 * 24 * 60 * 60 * 1000);
			const startSec = Math.floor(w.start.getTime() / 1000);
			const endSec = Math.floor(end.getTime() / 1000);

			// A hand-written war event for the same war means the mirror is redundant.
			const alreadyExists = factionEvents.some(
				(fe) =>
					fe.id === `rw_${w.id}` ||
					(fe.category === "war" &&
						Math.abs(fe.startTimestamp - startSec) < 3600),
			);

			if (!alreadyExists) {
				factionEvents.push({
					id: `rw_${w.id}`,
					title: `Ranked War #${w.id}`,
					description: `Target: ${w.target.toLocaleString()} score. Status: ${w.status}`,
					category: "war",
					source: "faction",
					startTime: w.start.toISOString(),
					endTime: end.toISOString(),
					startTimestamp: startSec,
					endTimestamp: endSec,
					isAllDay: false,
					color: categoryAccent("war"),
					badge: "Ranked War",
					categoryLabel: categoryTitle("war"),
					factionId: PRIMARY_SUBVERSIVE_FACTION_ID,
					// Mirrored from the war ledger — there is no calendar row to edit.
					editable: false,
				});
			}
		}
	} catch (warErr) {
		logger.debug(
			`Ranked war calendar inclusion skipped: ${warErr instanceof Error ? warErr.message : String(warErr)}`,
		);
	}

	return factionEvents.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

/**
 * Label for the categories the dashboard no longer offers, and for anything
 * unrecognised. Current categories resolve through {@link categoryTitle}.
 */
function formatCategoryLabel(category: string): string {
	switch (category) {
		case "training":
			return "Training";
		case "meeting":
			return "Meeting";
		case "giveaway":
			return "Giveaway";
		case "oc":
			return "Organized Crime";
		default:
			return "Faction Event";
	}
}
