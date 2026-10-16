import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { PageShell } from "@/components/PageShell";
import { StatusBadge } from "@/components/StatusBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "../contexts/AuthContext";
import { api } from "../lib/api";
import {
	type CalendarEvent,
	formatEventWindow,
	wholeDayWindow,
} from "../lib/calendar-events";
import { DEFAULT_EVENT_COLOR, dayWashBackground } from "../lib/calendar-wash";
import {
	getSubversiveFactionName,
	PRIMARY_SUBVERSIVE_FACTION_ID,
	SUBVERSIVE_FAMILY_FACTIONS,
} from "../lib/subversive-factions";
import { cn } from "../lib/utils";
import { useRouter } from "../router";

/** A faction category: its label is the event title and its accent is fixed. */
interface FactionCategory {
	value: string;
	label: string;
	color: string;
}

/** What the calendar's colours mean, as served by the API. */
interface CalendarAccentKey {
	torn: { label: string; color: string };
	faction: FactionCategory[];
}

/** Where the official Torn events came from. */
type TornEventsSource = "database" | "unavailable";

/**
 * The toolbar's filter.
 *
 * Torn's competitions are the one part of Torn's calendar worth isolating — a
 * competition is something members opt into, an ordinary Torn event is not —
 * and the rest of Torn's activities are one list with the faction's own.
 */
type CalendarFilter = "all" | "faction" | "competitions";

const FILTER_LABELS: Record<CalendarFilter, string> = {
	all: "All events",
	faction: "Faction events",
	competitions: "Torn competitions",
};

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Battlestats a Steadfast Change can ask for, in the order the API lists them. */
const STEADFAST_STAT_OPTIONS = [
	{ value: "strength", label: "Strength" },
	{ value: "speed", label: "Speed" },
	{ value: "dexterity", label: "Dexterity" },
	{ value: "defense", label: "Defense" },
] as const;

const STEADFAST_STAT_LABELS = new Map<string, string>(
	STEADFAST_STAT_OPTIONS.map((stat) => [stat.value, stat.label]),
);

/** Ranked War Enlistment is a whole Tuesday: the picker chooses the day, nothing else. */
const ENLISTMENT_WEEKDAY_UTC = 2; // Tuesday
const ENLISTMENT_OPTION_COUNT = 16;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether an event survives the toolbar's filter and search.
 *
 * Shared by the grid and the upcoming list so the two can never disagree about
 * what the page is currently showing.
 */
function matchesFilters(
	ev: CalendarEvent,
	filter: CalendarFilter,
	query: string,
): boolean {
	if (filter === "faction" && ev.source !== "faction") return false;
	if (filter === "competitions" && ev.category !== "torn_competition") {
		return false;
	}

	const q = query.trim().toLowerCase();
	if (!q) return true;

	return (
		ev.title.toLowerCase().includes(q) ||
		ev.description.toLowerCase().includes(q)
	);
}

/**
 * End-date shortcuts, measured in *whole days the event covers* — "1 day" ends
 * the same day it starts, "1 week" ends six days later. "1 month" is a calendar
 * month instead, so a 31st never spills into the month after next.
 */
const DURATION_OPTIONS = [
	{ value: "1d", label: "1 day", days: 1 },
	{ value: "2d", label: "2 days", days: 2 },
	{ value: "3d", label: "3 days", days: 3 },
	{ value: "1w", label: "1 week", days: 7 },
	{ value: "2w", label: "2 weeks", days: 14 },
	{ value: "1m", label: "1 month", days: null },
	{ value: "custom", label: "Custom", days: null },
] as const;

type DurationValue = (typeof DURATION_OPTIONS)[number]["value"];

/** How strongly the day wash sits over the cell. Text stays legible above it. */
const DAY_WASH_OPACITY = 0.3;

/**
 * The API's own explanation for a rejected write, when it gave one.
 *
 * Eden hands a non-2xx body back under `error.value`, and the calendar's refusals
 * ("endTime is in the past…", "Ranked War Enlistment must be on a Tuesday.") are
 * the useful half of the answer — a flat "Failed to create event." throws away
 * exactly what the admin needs in order to fix the form.
 */
function writeErrorMessage(error: unknown, fallback: string): string {
	if (!error || typeof error !== "object" || !("value" in error))
		return fallback;

	const value = (error as { value: unknown }).value;

	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "error" in value) {
		const message = (value as { error: unknown }).error;
		if (typeof message === "string") return message;
	}

	return fallback;
}

/** Which family faction an event belongs to, or whose Torn activity it is. */
function formatUpcomingSource(ev: CalendarEvent): string {
	if (ev.source === "faction") return getSubversiveFactionName(ev.factionId);
	return ev.categoryLabel ?? "Official Torn";
}

/**
 * How soon an upcoming event is, counted in whole Torn days rather than hours —
 * something at 09:00 tomorrow is "tomorrow", not "in 11 hours".
 */
function upcomingCountdown(
	ev: CalendarEvent,
	nowSec: number,
): { label: string; tone: "success" | "primary" | "neutral" } {
	if (ev.startTimestamp <= nowSec) {
		return { label: "Live now", tone: "success" };
	}

	const midnightOf = (date: Date) =>
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

	const daysAway = Math.round(
		(midnightOf(new Date(ev.startTimestamp * 1000)) -
			midnightOf(new Date(nowSec * 1000))) /
			MS_PER_DAY,
	);

	if (daysAway <= 0) return { label: "Today", tone: "primary" };
	if (daysAway === 1) return { label: "Tomorrow", tone: "primary" };
	return { label: `in ${daysAway} days`, tone: "neutral" };
}

/** The battlestats a Steadfast Change asks for, e.g. `Speed / Defense`. */
function formatStats(ev: CalendarEvent): string {
	const primary = ev.primaryStat
		? (STEADFAST_STAT_LABELS.get(ev.primaryStat) ?? ev.primaryStat)
		: null;
	const secondary = ev.secondaryStat
		? (STEADFAST_STAT_LABELS.get(ev.secondaryStat) ?? ev.secondaryStat)
		: null;

	return [primary, secondary].filter(Boolean).join(" / ");
}

/** `YYYY-MM-DD` for a UTC date. */
function toDateValue(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** `Tue 13 Oct 2026` for a `YYYY-MM-DD` value, read at noon so no zone can shift it. */
function formatDateLabel(dateValue: string): string {
	return new Date(`${dateValue}T12:00:00Z`).toLocaleDateString("en-GB", {
		timeZone: "UTC",
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** The end date a duration shortcut implies for a given start date. */
function endDateForDuration(
	startValue: string,
	duration: DurationValue,
): string {
	const start = new Date(`${startValue}T00:00:00Z`);

	if (duration === "1m") {
		const dayOfMonth = start.getUTCDate();
		const target = new Date(
			Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
		);
		// Clamp: 31 January + 1 month is the end of February, not 3 March.
		const lastDay = new Date(
			Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
		).getUTCDate();

		target.setUTCDate(Math.min(dayOfMonth, lastDay));
		return toDateValue(target);
	}

	const days = DURATION_OPTIONS.find((o) => o.value === duration)?.days ?? 1;
	return toDateValue(new Date(start.getTime() + (days - 1) * MS_PER_DAY));
}

/** Which shortcut, if any, an existing start/end pair corresponds to. */
function durationForDates(startValue: string, endValue: string): DurationValue {
	for (const option of DURATION_OPTIONS) {
		if (option.value === "custom") continue;
		if (endDateForDuration(startValue, option.value) === endValue) {
			return option.value;
		}
	}
	return "custom";
}

/**
 * Live Torn City Time clock.
 *
 * Kept in its own component so the once-a-second tick re-renders one span
 * instead of the whole year of day cells.
 */
function TctClock({ className }: { className?: string }) {
	const [time, setTime] = useState("");

	useEffect(() => {
		const update = () => {
			const now = new Date();
			setTime(
				`${String(now.getUTCHours()).padStart(2, "0")}:${String(
					now.getUTCMinutes(),
				).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")}`,
			);
		};
		update();
		const interval = setInterval(update, 1000);
		return () => clearInterval(interval);
	}, []);

	return (
		<span
			className={cn(
				"font-mono text-xs text-muted-foreground tabular-nums",
				className,
			)}
		>
			{time ? `${time} TCT` : "TCT"}
		</span>
	);
}

interface SubversiveCalendarPageProps {
	isPublic?: boolean;
}

interface UpcomingEventsPanelProps {
	events: CalendarEvent[];
	/** The window the API answered with, in days. */
	windowDays: number;
	/** True when the toolbar's search or filter is hiding some of the window. */
	narrowed: boolean;
	/** Whether this viewer can open an event's form at all. */
	canEdit: boolean;
	/**
	 * Opens the event's form. Clicking an event is an editing gesture, so this
	 * goes straight to the form rather than through the day's event list — that
	 * list is what a bare day click in the grid opens.
	 */
	onEditEvent: (ev: CalendarEvent) => void;
}

/**
 * What is next, in one list.
 *
 * The grid answers "what is on in October", which stops being useful the moment
 * the running month is nearly over — and it cannot answer December's question at
 * all, because the next few weeks are in a year the grid is not drawing. This
 * panel reads the API's own `upcoming` window (from now, across the year
 * boundary) and keeps the toolbar's search and filter, so it never contradicts
 * the grid beside it.
 */
function UpcomingEventsPanel({
	events,
	windowDays,
	narrowed,
	canEdit,
	onEditEvent,
}: UpcomingEventsPanelProps) {
	// One tick every half minute is enough to move an event from "in 2 days" to
	// "Tomorrow" without re-rendering the year of day cells with it.
	const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

	useEffect(() => {
		const interval = setInterval(
			() => setNowSec(Math.floor(Date.now() / 1000)),
			30_000,
		);
		return () => clearInterval(interval);
	}, []);

	return (
		<Card className="gap-0 overflow-hidden border-border/80 bg-card/90 py-0 shadow-sm">
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
				<div className="flex min-w-0 flex-col">
					<span className="text-sm font-semibold tracking-tight">Upcoming</span>
				</div>
			</div>

			{events.length === 0 ? (
				<p className="px-3 py-6 text-center text-sm text-muted-foreground">
					{narrowed
						? "No upcoming events match the current search or filter."
						: `Nothing scheduled in the next ${windowDays} days.`}
				</p>
			) : (
				<ul className="flex max-h-80 flex-col divide-y divide-border/50 overflow-y-auto">
					{events.map((ev) => {
						const start = new Date(ev.startTime);
						const countdown = upcomingCountdown(ev, nowSec);
						// Only a stored event can be opened in a form, and only by
						// someone who may write to it — anything else stays a plain row
						// rather than a button that does nothing.
						const openable = canEdit && ev.editable;

						const row = (
							<>
								{/* The date reads as a calendar chip: weekday, day, month. */}
								<span className="flex w-14 shrink-0 flex-col items-center rounded-md border border-border/70 py-1">
									<span className="text-[10px] text-muted-foreground uppercase">
										{start.toLocaleDateString("en-GB", {
											timeZone: "UTC",
											weekday: "short",
										})}
									</span>
									<span className="text-sm leading-none font-semibold tabular-nums">
										{start.getUTCDate()}
									</span>
									<span className="text-[10px] text-muted-foreground uppercase">
										{start.toLocaleDateString("en-GB", {
											timeZone: "UTC",
											month: "short",
										})}
									</span>
								</span>

								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex min-w-0 items-center gap-2">
										<span
											className="size-2 shrink-0 rounded-full"
											style={{
												backgroundColor: ev.color || DEFAULT_EVENT_COLOR,
											}}
										/>
										<span className="truncate text-sm font-medium">
											{ev.title}
										</span>
									</span>

									<span className="font-mono text-[11px] text-muted-foreground">
										{formatEventWindow(ev)}
									</span>

									<span className="text-[11px] text-muted-foreground">
										{formatUpcomingSource(ev)}
										{formatStats(ev) ? ` · ${formatStats(ev)}` : ""}
									</span>

									{ev.description ? (
										<span className="line-clamp-2 text-xs text-muted-foreground">
											{ev.description}
										</span>
									) : null}
								</span>

								<StatusBadge
									tone={countdown.tone}
									size="sm"
									dot={countdown.tone === "success"}
									pulse={countdown.tone === "success"}
								>
									{countdown.label}
								</StatusBadge>
							</>
						);

						return (
							<li key={ev.id}>
								{openable ? (
									<button
										type="button"
										onClick={() => onEditEvent(ev)}
										title="Edit this event"
										className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
									>
										{row}
									</button>
								) : (
									<div className="flex items-start gap-3 px-3 py-2">{row}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</Card>
	);
}

/** The day whose events the grid is currently managing. */
interface OpenDay {
	year: number;
	month: number;
	day: number;
}

interface DayEventsPanelProps {
	/** The day being managed, or null when the panel is closed. */
	day: OpenDay | null;
	events: CalendarEvent[];
	/** Whether this day can still take a new event, so the panel can offer one. */
	canAdd: boolean;
	onClose: () => void;
	onAddEvent: () => void;
	onEditEvent: (ev: CalendarEvent) => void;
	onDeleteEvent: (ev: CalendarEvent) => void;
}

/**
 * What is on one day, and what can be done with it.
 *
 * A bare day in the grid is an "add" gesture, but only while the day is empty: a
 * day that already holds events answers with them instead, because the useful
 * thing to do with a day that is already spoken for is change it or clear it
 * rather than pile another event on top. Torn's own activities are listed
 * read-only — they are not the family's to edit or delete — so a day holding
 * only those still offers the add that its events took away.
 */
function DayEventsPanel({
	day,
	events,
	canAdd,
	onClose,
	onAddEvent,
	onEditEvent,
	onDeleteEvent,
}: DayEventsPanelProps) {
	return (
		<Dialog
			open={day !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-md sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{day
							? `${day.day} ${MONTH_NAMES[day.month]} ${day.year}`
							: "Events on this day"}
					</DialogTitle>
					<DialogDescription>
						{events.length === 0
							? "Nothing is scheduled on this day. Times are in Torn City Time (TCT / UTC)."
							: `${events.length} event${events.length === 1 ? "" : "s"} on this day. Times are in Torn City Time (TCT / UTC).`}
					</DialogDescription>
				</DialogHeader>

				{events.length === 0 ? (
					<p className="py-4 text-center text-sm text-muted-foreground">
						Nothing on this day any more.
					</p>
				) : (
					<ul className="flex max-h-80 flex-col divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/70">
						{events.map((ev) => (
							<li
								key={ev.id}
								/* Phones get the actions under the event rather than beside it,
								   so a title never has to share the width with two buttons. */
								className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
							>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex min-w-0 items-center gap-2">
										<span
											className="size-2 shrink-0 rounded-full"
											style={{
												backgroundColor: ev.color || DEFAULT_EVENT_COLOR,
											}}
										/>
										<span className="truncate text-sm font-medium">
											{ev.title}
										</span>
									</span>

									<span className="font-mono text-[11px] text-muted-foreground">
										{formatEventWindow(ev)}
									</span>

									<span className="text-[11px] text-muted-foreground">
										{formatUpcomingSource(ev)}
										{formatStats(ev) ? ` · ${formatStats(ev)}` : ""}
									</span>

									{ev.description ? (
										<span className="line-clamp-2 text-xs text-muted-foreground">
											{ev.description}
										</span>
									) : null}
								</span>

								{/* Torn's activities carry no actions: they are read from Torn's
								    own table and there is nothing here to change. */}
								{ev.editable ? (
									<span className="flex shrink-0 items-center gap-1">
										<Button
											variant="outline"
											size="sm"
											onClick={() => onEditEvent(ev)}
										>
											Edit
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => onDeleteEvent(ev)}
											className="text-destructive hover:text-destructive"
										>
											Delete
										</Button>
									</span>
								) : null}
							</li>
						))}
					</ul>
				)}

				{/* The shared footer stacks on phones, so the two actions become full
				    width there rather than a cramped row. */}
				<DialogFooter className="sm:items-center sm:justify-between">
					{canAdd ? (
						<Button variant="outline" onClick={onAddEvent}>
							Add event on this day
						</Button>
					) : (
						<div className="hidden sm:block" />
					)}
					<Button onClick={onClose}>Close</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SubversiveCalendarPage({
	isPublic = false,
}: SubversiveCalendarPageProps) {
	const { navigate } = useRouter();
	const { authenticated } = useAuth();

	// Today in Torn City Time. The grid draws one year at a time and `year` is the
	// one on screen; `today` stays the real date either way, so it still decides
	// which cell is "today" and which Tuesdays the enlistment picker offers.
	const today = useMemo(() => {
		const now = new Date();
		return {
			year: now.getUTCFullYear(),
			month: now.getUTCMonth(),
			day: now.getUTCDate(),
		};
	}, []);

	/**
	 * The year being drawn.
	 *
	 * Everyone starts on the running year and viewers stay there — Torn publishes
	 * nothing but the running year, so there is nothing else for them to look at.
	 * Admins can ask for another one, which is what makes scheduling next year's
	 * enlistments possible before January.
	 */
	const [year, setYear] = useState(today.year);

	const [activeFilter, setActiveFilter] = useState<CalendarFilter>("all");
	const [searchQuery, setSearchQuery] = useState("");

	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [canEdit, setCanEdit] = useState(false);
	const [tornEvents, setTornEvents] = useState<CalendarEvent[]>([]);
	const [tornEventsSource, setTornEventsSource] =
		useState<TornEventsSource | null>(null);
	const [accentKey, setAccentKey] = useState<CalendarAccentKey | null>(null);
	const [factionEvents, setFactionEvents] = useState<CalendarEvent[]>([]);
	// The API's own forward-looking window. Kept apart from `factionEvents` and
	// `tornEvents`, which describe the requested year and nothing past it.
	const [upcoming, setUpcoming] = useState<{
		windowDays: number;
		events: CalendarEvent[];
	} | null>(null);

	// Add/Edit event modal
	const [eventModalOpen, setEventModalOpen] = useState(false);
	// The day whose events are being managed, opened by clicking a day that has
	// some. Kept as the day rather than a copy of its events, so a delete leaves
	// the list telling the truth.
	const [openDay, setOpenDay] = useState<OpenDay | null>(null);
	// The event a delete has been asked for but not yet confirmed, so both ways
	// into a delete go through the same prompt.
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const [editingEventId, setEditingEventId] = useState<string | null>(null);
	const [formCategory, setFormCategory] = useState("");
	const [formDescription, setFormDescription] = useState("");
	const [formStartDate, setFormStartDate] = useState("");
	const [formStartTime, setFormStartTime] = useState("12:00");
	const [formEndDate, setFormEndDate] = useState("");
	const [formEndTime, setFormEndTime] = useState("12:00");
	const [formIsAllDay, setFormIsAllDay] = useState(false);
	const [formDuration, setFormDuration] = useState<DurationValue>("1d");
	const [formPrimaryStat, setFormPrimaryStat] = useState("speed");
	const [formSecondaryStat, setFormSecondaryStat] = useState("defense");
	const [formFactionId, setFormFactionId] = useState<number>(
		PRIMARY_SUBVERSIVE_FACTION_ID,
	);
	const [submitting, setSubmitting] = useState(false);

	const factionCategories = accentKey?.faction ?? [];

	/**
	 * The years the picker offers an admin.
	 *
	 * A few back cover the history the family has actually scheduled; a couple
	 * forward cover planning a December enlistment for January. Further out is
	 * noise: Torn only ever publishes the running year, so a future year is a
	 * planning surface, not a forecast.
	 */
	const yearOptions = useMemo(() => {
		const years: number[] = [];
		for (let y = today.year - 3; y <= today.year + 2; y++) years.push(y);
		return years;
	}, [today]);

	/**
	 * Whether an event can still be placed on a day.
	 *
	 * The API refuses a window that has already closed, so the controls that open
	 * the event form are disabled for days it would reject — a button that leads
	 * straight to an error is worse than one that says why it is off.
	 */
	const isSchedulable = (y: number, mIndex: number, dayNumber: number) =>
		Date.UTC(y, mIndex, dayNumber, 23, 59, 59, 999) >= Date.now();

	const viewYearSchedulable = isSchedulable(year, 11, 31);

	/**
	 * The Tuesdays a Ranked War Enlistment can be pinned to, plus whatever date an
	 * event being edited already sits on so an old enlistment stays selectable.
	 *
	 * Anchored at the later of today and the start of the year on screen, so
	 * browsing 2027 in March offers 2027 enlistments rather than the next sixteen
	 * Tuesdays of the year being left behind.
	 */
	const enlistmentDates = useMemo(() => {
		const dates: string[] = [];
		const cursor = new Date(
			Math.max(
				Date.UTC(today.year, today.month, today.day),
				Date.UTC(year, 0, 1),
			),
		);

		while (cursor.getUTCDay() !== ENLISTMENT_WEEKDAY_UTC) {
			cursor.setUTCDate(cursor.getUTCDate() + 1);
		}

		for (let i = 0; i < ENLISTMENT_OPTION_COUNT; i++) {
			dates.push(toDateValue(cursor));
			cursor.setUTCDate(cursor.getUTCDate() + 7);
		}

		return dates;
	}, [today, year]);

	// Legacy categories are no longer offered, but an event still sitting in one
	// has to stay selectable or editing it would silently re-categorise it.
	const categoryOptions = useMemo(() => {
		const options = [...factionCategories];
		if (
			formCategory &&
			!options.some((category) => category.value === formCategory)
		) {
			options.push({
				value: formCategory,
				label: `${formCategory} (retired)`,
				color: DEFAULT_EVENT_COLOR,
			});
		}
		return options;
	}, [factionCategories, formCategory]);

	const enlistmentOptions = useMemo(() => {
		const options = [...enlistmentDates];
		if (formStartDate && !options.includes(formStartDate)) {
			options.push(formStartDate);
			options.sort();
		}
		return options;
	}, [enlistmentDates, formStartDate]);

	const isEnlistment = formCategory === "war";
	// A Steadfast Change is one whole day, so it is all-day without a switch on
	// screen that could claim otherwise.
	const isSteadfast = formCategory === "steadfast_change";
	/**
	 * Categories that are one whole day on a single date.
	 *
	 * Both are dated, never ranged: the form shows one date, the payload sends
	 * one date, and the API pins the day boundaries itself — so there is no end
	 * date on screen that could disagree with the start.
	 */
	const isSingleDayEvent = isEnlistment || isSteadfast;
	const isAllDayEvent = isSteadfast || formIsAllDay;

	/**
	 * A warning for a Steadfast Change that still covers several days.
	 *
	 * Events written before a Steadfast Change became one whole day are still on
	 * the calendar with a range on them, and this form has nowhere to put the days
	 * past the start: saving would shorten the event without saying so. The form
	 * says so instead.
	 */
	const steadfastCollapseWarning =
		isSteadfast && formStartDate && formEndDate && formEndDate !== formStartDate
			? `A Steadfast Change is one whole day. This event still ends ${formatDateLabel(formEndDate)} — saving keeps ${formatDateLabel(formStartDate)} only.`
			: null;

	/** Moving the start date carries the chosen span along with it. */
	const handleStartDateChange = (value: string) => {
		setFormStartDate(value);
		if (formDuration !== "custom" && value) {
			setFormEndDate(endDateForDuration(value, formDuration));
		}
	};

	const handleDurationChange = (value: DurationValue) => {
		setFormDuration(value);
		if (value !== "custom" && formStartDate) {
			setFormEndDate(endDateForDuration(formStartDate, value));
		}
	};

	// Fetch calendar events
	const fetchCalendar = useCallback(
		async (fresh = false) => {
			if (fresh) setRefreshing(true);
			else setLoading(true);

			try {
				const res = await api.v2.subversive.calendar.get({
					query: {
						year,
						refresh: fresh ? "1" : "0",
					},
				});

				if (res.data && "success" in res.data && res.data.success) {
					const data = res.data;
					setCanEdit(Boolean(data.canEdit));
					setTornEvents((data.tornEvents as CalendarEvent[]) ?? []);
					setTornEventsSource(
						(data.tornEventsSource as TornEventsSource) ?? null,
					);
					setAccentKey((data.accentKey as CalendarAccentKey) ?? null);
					setFactionEvents((data.factionEvents as CalendarEvent[]) ?? []);

					const window = data.upcoming as
						| { windowDays: number; events: CalendarEvent[] }
						| undefined;
					setUpcoming(
						window
							? {
									windowDays: window.windowDays,
									events: window.events ?? [],
								}
							: null,
					);
				} else {
					toast.error("Failed to load calendar events.");
				}
			} catch (_err) {
				toast.error("Failed to connect to calendar service.");
			} finally {
				setLoading(false);
				setRefreshing(false);
			}
		},
		[year],
	);

	useEffect(() => {
		fetchCalendar();
	}, [fetchCalendar]);

	// Combined filtered events
	const filteredEvents = useMemo(
		() =>
			[...factionEvents, ...tornEvents].filter((ev) =>
				matchesFilters(ev, activeFilter, searchQuery),
			),
		[factionEvents, tornEvents, activeFilter, searchQuery],
	);

	// The same filter and search, over the forward-looking window instead.
	const filteredUpcoming = useMemo(
		() =>
			(upcoming?.events ?? []).filter((ev) =>
				matchesFilters(ev, activeFilter, searchQuery),
			),
		[upcoming, activeFilter, searchQuery],
	);

	// Filter counts
	const counts = useMemo(
		() => ({
			all: factionEvents.length + tornEvents.length,
			faction: factionEvents.length,
			competitions: tornEvents.filter((e) => e.category === "torn_competition")
				.length,
		}),
		[factionEvents, tornEvents],
	);

	// Copy public URL
	const handleCopyPublicLink = () => {
		const base = window.location.origin;
		const url = `${base}/#/subversive/calendar`;
		navigator.clipboard.writeText(url);
		toast.success("Public Calendar link copied to clipboard!");
	};

	/**
	 * The events that fall on a day of the year on screen.
	 *
	 * Only the viewed year is consulted: the upcoming window is a separate list
	 * with its own dates, and mixing it in here would wash a day of this year for
	 * something happening in the next one.
	 */
	const getEventsForDay = useCallback(
		(y: number, mIndex: number, dayNumber: number) => {
			const startSec = Math.floor(
				Date.UTC(y, mIndex, dayNumber, 0, 0, 0) / 1000,
			);
			const endSec = Math.floor(
				Date.UTC(y, mIndex, dayNumber, 23, 59, 59) / 1000,
			);

			return filteredEvents.filter(
				(e) => e.startTimestamp <= endSec && e.endTimestamp >= startSec,
			);
		},
		[filteredEvents],
	);

	/** What is on the day the panel is open for, read fresh after every write. */
	const openDayEvents = openDay
		? getEventsForDay(openDay.year, openDay.month, openDay.day)
		: [];

	/** Whether that day can still take an event, so the panel may offer one. */
	const openDaySchedulable = openDay
		? canEdit && isSchedulable(openDay.year, openDay.month, openDay.day)
		: false;

	// Open Add Event modal prefilled with day. The year is passed in so a day in
	// another year — or an event being added to a year the admin picked — prefill
	// the date it was asked for rather than the running year.
	const handleOpenAddEvent = (
		mIndex?: number,
		dayNumber?: number,
		atYear: number = year,
	) => {
		setEditingEventId(null);
		setFormDescription("");
		setFormCategory(factionCategories[0]?.value ?? "war");
		setFormIsAllDay(false);
		setFormPrimaryStat("speed");
		setFormSecondaryStat("defense");
		setFormFactionId(PRIMARY_SUBVERSIVE_FACTION_ID);

		const clickedDay =
			mIndex !== undefined && dayNumber !== undefined
				? toDateValue(new Date(Date.UTC(atYear, mIndex, dayNumber)))
				: null;

		// A Ranked War Enlistment ignores a clicked day unless it is a Tuesday; the
		// picker owns that rule, so fall back to the next available Tuesday.
		setFormStartDate(clickedDay ?? enlistmentDates[0] ?? "");
		setFormEndDate(clickedDay ?? enlistmentDates[0] ?? "");
		setFormDuration("1d");
		setFormStartTime("12:00");
		setFormEndTime("14:00");
		setEventModalOpen(true);
	};

	// Open Edit modal
	const handleOpenEditEvent = (ev: CalendarEvent) => {
		setEditingEventId(ev.id);
		setFormDescription(ev.description);
		setFormCategory(ev.category);
		setFormIsAllDay(ev.isAllDay);
		setFormPrimaryStat(ev.primaryStat ?? "speed");
		setFormSecondaryStat(ev.secondaryStat ?? "defense");
		setFormFactionId(ev.factionId || PRIMARY_SUBVERSIVE_FACTION_ID);

		const s = new Date(ev.startTime);
		const e = new Date(ev.endTime);

		setFormStartDate(toDateValue(s));
		setFormStartTime(
			`${String(s.getUTCHours()).padStart(2, "0")}:${String(s.getUTCMinutes()).padStart(2, "0")}`,
		);

		setFormEndDate(toDateValue(e));
		setFormEndTime(
			`${String(e.getUTCHours()).padStart(2, "0")}:${String(e.getUTCMinutes()).padStart(2, "0")}`,
		);
		// Recognise an event that already spans a shortcut, so the picker shows the
		// truth instead of resetting to "Custom".
		setFormDuration(durationForDates(toDateValue(s), toDateValue(e)));

		setEventModalOpen(true);
	};

	/**
	 * What a click on a day cell does.
	 *
	 * An empty day is a way into the form; a day that already has events is a way
	 * into them, which is where one of them can be removed. A day holding only
	 * Torn's own activities opens the panel too, because a click there should
	 * still say what is on it — the panel offers the add it would otherwise have
	 * been.
	 */
	const handleDayClick = (
		mIndex: number,
		dayNumber: number,
		dayEvents: CalendarEvent[],
	) => {
		if (dayEvents.length > 0) {
			setOpenDay({ year, month: mIndex, day: dayNumber });
			return;
		}

		handleOpenAddEvent(mIndex, dayNumber, year);
	};

	/** Carries the panel's day into the form, so the two never disagree. */
	const handleAddFromOpenDay = () => {
		if (!openDay) return;

		const { year: atYear, month, day } = openDay;
		setOpenDay(null);
		handleOpenAddEvent(month, day, atYear);
	};

	/** Editing hands the event to the form, and the panel gets out of its way. */
	const handleEditFromOpenDay = (ev: CalendarEvent) => {
		setOpenDay(null);
		handleOpenEditEvent(ev);
	};

	// Save Event
	const handleSaveEvent = async () => {
		if (!formCategory) {
			toast.error("Please choose a category.");
			return;
		}

		if (!formStartDate) {
			toast.error("Please specify a start date.");
			return;
		}

		// Only a ranged category has an end date to get wrong; the one-day
		// categories send the start date twice, at the day's two boundaries.
		if (!isSingleDayEvent && !formEndDate) {
			toast.error("Please specify an end date.");
			return;
		}

		if (isSteadfast && formPrimaryStat === formSecondaryStat) {
			toast.error("Primary and secondary battlestats must be different.");
			return;
		}

		const sTime = isAllDayEvent ? "00:00:00" : `${formStartTime}:00`;
		const eTime = isAllDayEvent ? "23:59:59" : `${formEndTime}:00`;

		// A one-day category covers the whole of its date: midnight to the last
		// second of that same day, which is the shape every whole-day event on this
		// calendar has. A ranged one is built from the start and the end it was
		// given, exactly as the form displays them.
		const day = wholeDayWindow(formStartDate);
		const startIso = isSingleDayEvent
			? day.startTime
			: new Date(`${formStartDate}T${sTime}Z`).toISOString();
		const endIso = isSingleDayEvent
			? day.endTime
			: new Date(`${formEndDate}T${eTime}Z`).toISOString();

		if (new Date(endIso) < new Date(startIso)) {
			toast.error("End date/time must be after start date/time.");
			return;
		}

		// The calendar is a plan, not a log, so a window that has already closed is
		// refused — here to save the round trip, and by the API, which is where the
		// rule lives. Only a create is checked: an event that already ended is
		// history, and its notes still need correcting.
		if (!editingEventId && new Date(endIso).getTime() < Date.now()) {
			toast.error(
				"That window has already passed — pick a date and time still to come.",
			);
			return;
		}

		const payload = {
			description: formDescription,
			category: formCategory,
			startTime: startIso,
			endTime: endIso,
			isAllDay: isSingleDayEvent ? true : isAllDayEvent,
			primaryStat: isSteadfast ? formPrimaryStat : null,
			secondaryStat: isSteadfast ? formSecondaryStat : null,
			factionId: formFactionId,
		};

		setSubmitting(true);
		try {
			if (editingEventId) {
				const res = await api.v2.subversive.calendar
					.events({ id: editingEventId })
					.put(payload);

				if (res.data && "success" in res.data && res.data.success) {
					toast.success("Event updated successfully!");
					setEventModalOpen(false);
					await fetchCalendar(true);
				} else {
					toast.error(writeErrorMessage(res.error, "Failed to update event."));
				}
			} else {
				const res = await api.v2.subversive.calendar.events.post(payload);

				if (res.data && "success" in res.data && res.data.success) {
					toast.success("Faction event created!");
					setEventModalOpen(false);
					await fetchCalendar(true);
				} else {
					toast.error(writeErrorMessage(res.error, "Failed to create event."));
				}
			}
		} catch (_err) {
			toast.error("Error saving event.");
		} finally {
			setSubmitting(false);
		}
	};

	// Delete Event. Reached from the form or from the day panel, so both close with
	// the event they were showing. The prompt is the dashboard's own rather than
	// the browser's, so it reads the same as every other destructive action.
	const handleConfirmDelete = async () => {
		const id = pendingDeleteId;
		setPendingDeleteId(null);
		if (!id) return;

		try {
			const res = await api.v2.subversive.calendar.events({ id }).delete();
			if (res.data && "success" in res.data && res.data.success) {
				toast.success("Event removed from calendar.");
				setEventModalOpen(false);
				setOpenDay(null);
				await fetchCalendar(true);
			} else {
				toast.error("Failed to delete event.");
			}
		} catch (_err) {
			toast.error("Error deleting event.");
		}
	};

	/** How many of the filtered events are live during a month. */
	const countEventsInMonth = (mIndex: number): number => {
		const monthStart = Math.floor(Date.UTC(year, mIndex, 1, 0, 0, 0) / 1000);
		const monthEnd = Math.floor(
			Date.UTC(year, mIndex + 1, 0, 23, 59, 59) / 1000,
		);

		return filteredEvents.filter(
			(e) => e.startTimestamp <= monthEnd && e.endTimestamp >= monthStart,
		).length;
	};

	// Render day cells in a month
	const renderDayCells = (mIndex: number) => {
		const firstDayWeekday =
			(new Date(Date.UTC(year, mIndex, 1)).getUTCDay() + 6) % 7;
		const daysInMonth = new Date(Date.UTC(year, mIndex + 1, 0)).getUTCDate();
		const daysInPrevMonth = new Date(Date.UTC(year, mIndex, 0)).getUTCDate();

		const cells = [];

		// Leading empty / prev-month cells
		for (let i = 0; i < firstDayWeekday; i++) {
			const prevDayNum = daysInPrevMonth - firstDayWeekday + i + 1;
			cells.push(
				<span
					key={`prev-${i}`}
					className="flex h-9 items-center justify-center text-xs text-muted-foreground/40 select-none sm:h-8"
				>
					{prevDayNum}
				</span>,
			);
		}

		// Current month active cells
		for (let d = 1; d <= daysInMonth; d++) {
			const isToday =
				today.year === year && today.month === mIndex && today.day === d;

			const dayStartSec = Math.floor(Date.UTC(year, mIndex, d, 0, 0, 0) / 1000);
			const dayEvents = getEventsForDay(year, mIndex, d);
			// An empty day the calendar can still be written to is a way into the
			// form. A day that already holds events is a way into them instead —
			// including a past one, where the useful action is removing something
			// that never happened. A viewer's day is just a cell to read.
			const interactive =
				canEdit && (dayEvents.length > 0 || isSchedulable(year, mIndex, d));

			const wash =
				dayEvents.length > 0 ? (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 rounded-md"
						style={{
							// The cell is a timeline: each event washes the stretch of the day
							// it covers, so a noon start leaves the morning clear.
							background: dayWashBackground(dayEvents, dayStartSec),
							opacity: DAY_WASH_OPACITY,
						}}
					/>
				) : null;

			const label =
				dayEvents.length > 0
					? `${d} ${MONTH_NAMES[mIndex]} ${year}, ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`
					: `${d} ${MONTH_NAMES[mIndex]} ${year}, no events`;

			const cellClass = cn(
				"relative h-9 w-full flex-col px-0 text-xs font-medium tabular-nums sm:h-8",
				// Today sits outside the wash so it cannot be swallowed by it.
				isToday && "font-semibold text-primary ring-1 ring-primary/50",
			);

			const cell = interactive ? (
				<Button
					key={`day-${d}`}
					type="button"
					variant="ghost"
					size="xs"
					onClick={() => handleDayClick(mIndex, d, dayEvents)}
					title={
						dayEvents.length > 0
							? `Manage the ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"} on ${d} ${MONTH_NAMES[mIndex]} ${year}`
							: `Add an event on ${d} ${MONTH_NAMES[mIndex]} ${year}`
					}
					aria-label={`${label}. ${dayEvents.length > 0 ? "Manage events" : "Add an event"}`}
					className={cellClass}
				>
					{wash}
					<span className="relative leading-none">{d}</span>
				</Button>
			) : (
				<span
					key={`day-${d}`}
					className={cn("flex items-center justify-center", cellClass)}
				>
					{wash}
					<span className="relative leading-none">{d}</span>
					{/* A plain cell cannot carry a label, so the count is spelled out for
					    anyone who cannot see the wash. */}
					{dayEvents.length > 0 ? (
						<span className="sr-only">
							{`${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}
						</span>
					) : null}
				</span>
			);

			// Hovering a day answers "what is on this day" without a click — the only
			// reading a viewer gets, and the quickest one an admin gets.
			cells.push(
				dayEvents.length > 0 ? (
					<Tooltip key={`day-${d}`}>
						<TooltipTrigger asChild>{cell}</TooltipTrigger>
						<TooltipContent
							side="top"
							className="max-w-72 flex-col items-start gap-1 px-2.5 py-2 text-left"
						>
							<span className="font-semibold">
								{d} {MONTH_NAMES[mIndex]} {year}
							</span>
							<span className="flex flex-col gap-1">
								{dayEvents.map((ev) => (
									<span key={ev.id} className="flex flex-col">
										<span className="font-medium break-anywhere">
											{ev.title}
										</span>
										<span className="font-mono text-[11px] opacity-80">
											{formatEventWindow(ev)}
										</span>
										{formatStats(ev) ? (
											<span className="text-[11px] opacity-80">
												{formatStats(ev)}
											</span>
										) : null}
									</span>
								))}
							</span>
						</TooltipContent>
					</Tooltip>
				) : (
					cell
				),
			);
		}

		// Trailing empty / next-month cells to complete grid
		const totalSoFar = firstDayWeekday + daysInMonth;
		const totalRows = totalSoFar > 35 ? 42 : 35;
		const trailingDays = totalRows - totalSoFar;

		for (let i = 1; i <= trailingDays; i++) {
			cells.push(
				<span
					key={`next-${i}`}
					className="flex h-9 items-center justify-center text-xs text-muted-foreground/40 select-none sm:h-8"
				>
					{i}
				</span>,
			);
		}

		return cells;
	};

	/** What the day wash means: one accent per faction category, one for Torn. */
	const accentLegend = accentKey ? (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
			{accentKey.faction.map((category) => (
				<span
					key={category.value}
					className="flex items-center gap-1.5 text-xs text-muted-foreground"
				>
					<span
						className="size-2 shrink-0 rounded-full"
						style={{ backgroundColor: category.color }}
					/>
					{category.label}
				</span>
			))}
			<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span
					className="size-2 shrink-0 rounded-full"
					style={{ backgroundColor: accentKey.torn.color }}
				/>
				{accentKey.torn.label}
			</span>
		</div>
	) : null;

	const toolbar = (
		<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
			<Input
				type="search"
				placeholder="Search events"
				value={searchQuery}
				onChange={(e) => setSearchQuery(e.target.value)}
				className="h-9 w-full sm:max-w-xs"
				aria-label="Search events"
			/>

			<Select
				value={activeFilter}
				onValueChange={(val) => setActiveFilter(val as CalendarFilter)}
			>
				<SelectTrigger
					className="h-9 w-full sm:w-52"
					aria-label="Filter events"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(Object.keys(FILTER_LABELS) as CalendarFilter[]).map((key) => (
						<SelectItem key={key} value={key}>
							{`${FILTER_LABELS[key]} (${counts[key]})`}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{/* Only admins get to leave the running year: they are the only ones who
			    can put anything in another one, and Torn publishes one year's
			    official activities. */}
			{canEdit ? (
				<Select
					value={String(year)}
					onValueChange={(val) => setYear(Number(val))}
				>
					<SelectTrigger
						className="h-9 w-full sm:w-40"
						aria-label="Calendar year"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{yearOptions.map((option) => (
							<SelectItem key={option} value={String(option)}>
								{option === today.year
									? `${option} · this year`
									: String(option)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}

			{searchQuery ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setSearchQuery("")}
					className="self-start sm:self-auto"
				>
					Clear search
				</Button>
			) : null}

			<Button
				variant="outline"
				size="sm"
				onClick={() => fetchCalendar(true)}
				disabled={refreshing}
				className="self-start sm:ml-auto sm:self-auto"
			>
				{refreshing ? "Refreshing..." : "Refresh"}
			</Button>
		</div>
	);

	return (
		<div
			className={cn(
				"relative flex min-h-dvh w-full flex-col font-sans transition-colors",
				isPublic ? "bg-background text-foreground" : "bg-transparent",
			)}
		>
			{/* Public Top Navbar if viewing directly */}
			{isPublic ? (
				<header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-background/85 px-4 py-2 backdrop-blur-xl sm:px-6">
					<div className="flex min-w-0 flex-col">
						<div className="flex min-w-0 items-center gap-2">
							<span className="text-sm font-semibold tracking-tight">
								Subversive Alliance
							</span>
						</div>
						<span className="text-xs text-muted-foreground">Calendar</span>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<TctClock />

						<Button variant="outline" size="sm" onClick={handleCopyPublicLink}>
							Share
						</Button>

						<ThemeToggle />

						{authenticated ? (
							canEdit ? (
								<Button
									size="sm"
									onClick={() => handleOpenAddEvent()}
									disabled={!viewYearSchedulable}
									title={
										viewYearSchedulable
											? undefined
											: `${year} has already passed — an event cannot be scheduled into it.`
									}
								>
									Add event
								</Button>
							) : null
						) : (
							<Button size="sm" onClick={() => navigate("/login")}>
								Login
							</Button>
						)}
					</div>
				</header>
			) : null}

			<main className="flex-1 px-3 py-4 sm:px-6 sm:py-6">
				<PageShell>
					{/* Non-public Page Header */}
					{!isPublic ? (
						<PageHeader
							title="Faction Calendar"
							description="Official Torn events plus everything scheduled across the Subversive family: wars, chains, training, meetings and giveaways."
							badge={
								<StatusBadge tone="primary" size="sm">
									Subversive Alliance
								</StatusBadge>
							}
							actions={
								<>
									<TctClock className="px-1" />

									<Button
										variant="outline"
										size="sm"
										onClick={handleCopyPublicLink}
									>
										Shareable link
									</Button>

									{canEdit ? (
										<Button
											size="sm"
											onClick={() => handleOpenAddEvent()}
											disabled={!viewYearSchedulable}
											title={
												viewYearSchedulable
													? undefined
													: `${year} has already passed — an event cannot be scheduled into it.`
											}
										>
											New faction event
										</Button>
									) : null}
								</>
							}
						/>
					) : null}

					{toolbar}

					{accentLegend}

					{/* The two click gestures are worth stating: on a busy month the grid is
					    mostly days that do something else than an empty one. */}
					{canEdit ? (
						<p className="text-xs text-muted-foreground">
							Click an empty day to add an event; click a day that has one to
							edit or delete it.
						</p>
					) : null}

					{/* Torn publishes only the running year, so any other year genuinely has
					    no official activities to show. Say so rather than look broken. */}
					{!loading && year !== today.year ? (
						<div className="rounded-lg border border-info/30 bg-info/10 px-3 py-2.5 text-xs text-info">
							<p className="font-semibold">Showing {year}.</p>
							<p className="mt-0.5">
								Torn only publishes the running year ({today.year}), so official
								Torn competitions and events appear there and not here. Faction
								events are shown for whichever year is selected.
							</p>
						</div>
					) : null}

					{/* Official Torn events come from the scheduler's daily sync. When that
					    has not populated yet, say so instead of showing an empty year. */}
					{!loading && tornEventsSource === "unavailable" ? (
						<div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
							<p className="font-semibold">
								Official Torn events are not available yet.
							</p>
							<p className="mt-0.5">
								The scheduler syncs Torn's calendar once a day. Faction events
								below are unaffected.
							</p>
						</div>
					) : null}

					{/* What is next, ahead of the year grid: the grid is a reference, this
					    is the plan. Clicking an event opens its form. */}
					{!loading && upcoming ? (
						<UpcomingEventsPanel
							events={filteredUpcoming}
							windowDays={upcoming.windowDays}
							narrowed={activeFilter !== "all" || searchQuery.trim() !== ""}
							canEdit={canEdit}
							onEditEvent={handleOpenEditEvent}
						/>
					) : null}

					{/* Loading State Skeleton */}
					{loading ? (
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{Array.from({ length: 12 }).map((_, idx) => (
								<Card key={`skeleton-${idx}`} className="gap-3 p-3">
									<Skeleton className="h-4 w-24" />
									<Skeleton className="h-40 w-full" />
								</Card>
							))}
						</div>
					) : (
						<TooltipProvider delayDuration={150}>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{MONTH_NAMES.map((monthName, mIndex) => {
									const monthCount = countEventsInMonth(mIndex);

									return (
										<Card
											key={monthName}
											className="gap-0 overflow-hidden border-border/80 bg-card/90 py-0 shadow-sm"
										>
											<div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
												<span className="text-sm font-semibold tracking-tight">
													{monthName}
												</span>
												<span className="font-mono text-xs text-muted-foreground tabular-nums">
													{monthCount > 0
														? `${monthCount} event${monthCount === 1 ? "" : "s"}`
														: ""}
												</span>
											</div>

											<div className="p-2">
												<div className="mb-1 grid grid-cols-7 gap-0.5 border-b border-border/40 pb-1 text-center">
													{WEEKDAYS.map((w) => (
														<span
															key={w}
															className="text-[10px] font-medium text-muted-foreground select-none"
														>
															{w}
														</span>
													))}
												</div>

												<div className="grid grid-cols-7 gap-0.5">
													{renderDayCells(mIndex)}
												</div>
											</div>
										</Card>
									);
								})}
							</div>
						</TooltipProvider>
					)}
				</PageShell>
			</main>

			{/* ── Add / Edit Event Modal ─────────────────────────────────────────── */}
			<Dialog open={eventModalOpen} onOpenChange={setEventModalOpen}>
				<DialogContent className="max-w-md sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{editingEventId
								? "Edit Faction Event"
								: "New Faction Calendar Event"}
						</DialogTitle>
						<DialogDescription>
							Schedule an event for Subversive Alliance members. Times are in
							Torn City Time (TCT / UTC).
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-4 py-2">
						{/* Category — it titles the event and fixes its accent */}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-category">Category</Label>
							<Select value={formCategory} onValueChange={setFormCategory}>
								<SelectTrigger id="event-category">
									<SelectValue placeholder="Select Category" />
								</SelectTrigger>
								<SelectContent>
									{categoryOptions.map((cat) => (
										<SelectItem key={cat.value} value={cat.value}>
											<span className="flex items-center gap-2">
												<span
													className="size-2 shrink-0 rounded-full"
													style={{ backgroundColor: cat.color }}
												/>
												{cat.label}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Faction selector */}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-faction">Faction</Label>
							<Select
								value={String(formFactionId)}
								onValueChange={(val) => setFormFactionId(Number(val))}
							>
								<SelectTrigger id="event-faction">
									<SelectValue placeholder="Select Faction" />
								</SelectTrigger>
								<SelectContent>
									{SUBVERSIVE_FAMILY_FACTIONS.map((f) => (
										<SelectItem key={f.id} value={String(f.id)}>
											{f.name} ({f.id})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* How the event is dated depends on the category, and the two
						    one-day categories never show a range: an enlistment is a whole
						    Tuesday and a Steadfast Change a whole day, so both are asked
						    for one date and the API pins the day's own boundaries. */}
						{isEnlistment ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="enlistment-date">Enlistment Tuesday</Label>
								<Select
									value={formStartDate}
									onValueChange={(val) => {
										setFormStartDate(val);
										setFormEndDate(val);
									}}
								>
									<SelectTrigger id="enlistment-date">
										<SelectValue placeholder="Select a Tuesday" />
									</SelectTrigger>
									<SelectContent>
										{enlistmentOptions.map((dateValue) => (
											<SelectItem key={dateValue} value={dateValue}>
												{formatDateLabel(dateValue)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">
									Runs the whole of Tuesday, TCT.
								</p>
							</div>
						) : isSteadfast ? (
							<>
								{/* One whole day, so the date is the entire request — there is no
								    end date on screen to disagree with it, and no time either. */}
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="steadfast-date">Date (TCT)</Label>
									<Input
										id="steadfast-date"
										type="date"
										value={formStartDate}
										onChange={(e) => setFormStartDate(e.target.value)}
									/>
									<p className="text-xs text-muted-foreground">
										Runs the whole of that day, TCT.
									</p>
									{steadfastCollapseWarning ? (
										<p className="text-xs text-warning">
											{steadfastCollapseWarning}
										</p>
									) : null}
								</div>

								{/* Battlestats a Steadfast Change asks members to hold */}
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="primary-stat">Primary Battlestat</Label>
										<Select
											value={formPrimaryStat}
											onValueChange={setFormPrimaryStat}
										>
											<SelectTrigger id="primary-stat">
												<SelectValue placeholder="Select stat" />
											</SelectTrigger>
											<SelectContent>
												{STEADFAST_STAT_OPTIONS.map((stat) => (
													<SelectItem key={stat.value} value={stat.value}>
														{stat.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									<div className="flex flex-col gap-1.5">
										<Label htmlFor="secondary-stat">Secondary Battlestat</Label>
										<Select
											value={formSecondaryStat}
											onValueChange={setFormSecondaryStat}
										>
											<SelectTrigger id="secondary-stat">
												<SelectValue placeholder="Select stat" />
											</SelectTrigger>
											<SelectContent>
												{STEADFAST_STAT_OPTIONS.map((stat) => (
													<SelectItem key={stat.value} value={stat.value}>
														{stat.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								</div>
							</>
						) : (
							<>
								{/* All day toggle — a day-long window is a range with no clock
								    on it, which is all the switch decides. */}
								<div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
									<div className="flex min-w-0 flex-col">
										<Label htmlFor="all-day" className="cursor-pointer">
											All Day Event
										</Label>
										<p className="text-xs text-muted-foreground">
											Runs full 24 hours across specified dates
										</p>
									</div>
									<Switch
										id="all-day"
										checked={formIsAllDay}
										onCheckedChange={setFormIsAllDay}
									/>
								</div>

								{/* Dates & Times */}
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="start-date">Start Date (TCT)</Label>
										<Input
											id="start-date"
											type="date"
											value={formStartDate}
											onChange={(e) => handleStartDateChange(e.target.value)}
										/>
										{!isAllDayEvent ? (
											<Input
												type="time"
												aria-label="Start time (TCT)"
												value={formStartTime}
												onChange={(e) => setFormStartTime(e.target.value)}
											/>
										) : null}
									</div>

									{/* How long the event runs, counted from the start date. */}
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="event-duration">Duration</Label>
										<Select
											value={formDuration}
											onValueChange={(val) =>
												handleDurationChange(val as DurationValue)
											}
										>
											<SelectTrigger id="event-duration">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{DURATION_OPTIONS.map((option) => (
													<SelectItem key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									<div className="flex flex-col gap-1.5">
										<Label htmlFor="end-date">End Date (TCT)</Label>
										<Input
											id="end-date"
											type="date"
											value={formEndDate}
											onChange={(e) => {
												setFormEndDate(e.target.value);
												// Hand-editing the end date is what "Custom" means.
												setFormDuration("custom");
											}}
										/>
										{!isAllDayEvent ? (
											<Input
												type="time"
												aria-label="End time (TCT)"
												value={formEndTime}
												onChange={(e) => setFormEndTime(e.target.value)}
											/>
										) : null}
									</div>
								</div>
							</>
						)}

						{/* Description */}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-desc">Description / Notes</Label>
							<Textarea
								id="event-desc"
								placeholder="Event details, targets, rules, or requirements..."
								rows={3}
								value={formDescription}
								onChange={(e) => setFormDescription(e.target.value)}
							/>
						</div>
					</div>

					{/* Deleting lives here, with the event open, rather than in a list of
					    them: the form is the only place an event is shown in detail. */}
					<DialogFooter className="flex-row items-center justify-between sm:justify-between">
						{editingEventId ? (
							<Button
								variant="ghost"
								onClick={() => setPendingDeleteId(editingEventId)}
								disabled={submitting}
								className="text-destructive hover:text-destructive"
							>
								Delete event
							</Button>
						) : (
							<div />
						)}

						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								onClick={() => setEventModalOpen(false)}
								disabled={submitting}
							>
								Cancel
							</Button>
							<Button onClick={handleSaveEvent} disabled={submitting}>
								{submitting
									? "Saving..."
									: editingEventId
										? "Update Event"
										: "Create Event"}
							</Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* ── Day panel: what is on a day, and how to change it ──────────────── */}
			<DayEventsPanel
				day={openDay}
				events={openDayEvents}
				canAdd={openDaySchedulable}
				onClose={() => setOpenDay(null)}
				onAddEvent={handleAddFromOpenDay}
				onEditEvent={handleEditFromOpenDay}
				onDeleteEvent={(ev) => setPendingDeleteId(ev.id)}
			/>

			{/* One prompt for both ways into a delete: the form's footer button and
			    a row in the day panel. */}
			<ConfirmDialog
				open={pendingDeleteId !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDeleteId(null);
				}}
				title="Delete this faction event?"
				description="It is taken off the calendar for everyone. This cannot be undone."
				confirmLabel="Delete event"
				onConfirm={handleConfirmDelete}
			/>
		</div>
	);
}

export default SubversiveCalendarPage;
