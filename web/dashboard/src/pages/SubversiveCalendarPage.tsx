import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
	PRIMARY_SUBVERSIVE_FACTION_ID,
	SUBVERSIVE_FAMILY_FACTIONS,
} from "../lib/subversive-factions";
import { cn } from "../lib/utils";
import { useRouter } from "../router";

export interface CalendarEvent {
	id: string;
	title: string;
	description: string;
	category: string;
	source: "torn" | "faction";
	startTime: string; // ISO
	endTime: string; // ISO
	startTimestamp: number; // Unix seconds
	endTimestamp: number; // Unix seconds
	isAllDay: boolean;
	color?: string | null;
	badge?: string | null;
	/** Display label for `category`, which is also the event's title. */
	categoryLabel?: string;
	/** Battlestats a Steadfast Change asks members to hold. */
	primaryStat?: string | null;
	secondaryStat?: string | null;
	factionId?: number;
	createdById?: string | null;
	createdByName?: string | null;
	/**
	 * Only stored faction events can be changed. Ranked-war entries mirrored from
	 * the war ledger have no calendar row behind them, so the API marks them
	 * `false` and the UI hides edit/delete for them.
	 */
	editable?: boolean;
}

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

type CalendarFilter = "all" | "faction" | "competitions" | "events";

const FILTER_LABELS: Record<CalendarFilter, string> = {
	all: "All events",
	faction: "Faction events",
	competitions: "Torn competitions",
	events: "Torn events",
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

/** Torn opens Ranked War Enlistment on Tuesday at 12:00 TCT and it runs an hour. */
const ENLISTMENT_WEEKDAY_UTC = 2; // Tuesday
const ENLISTMENT_HOUR_UTC = 12;
const ENLISTMENT_WINDOW_HOURS = 1;
const ENLISTMENT_OPTION_COUNT = 16;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

const DEFAULT_EVENT_COLOR = "#228be6";

/** How strongly the day wash sits over the cell. Text stays legible above it. */
const DAY_WASH_OPACITY = 0.3;
/** Bands drawn in a day cell before the rest are left to the tooltip. */
const MAX_WASH_BANDS = 3;

/**
 * The wash a day cell paints: one accent for a single event, split into equal
 * bands when a day carries several, so the count is readable too.
 */
function dayWash(events: CalendarEvent[]): string {
	const colors = events
		.slice(0, MAX_WASH_BANDS)
		.map((event) => event.color || DEFAULT_EVENT_COLOR);

	if (colors.length <= 1) return colors[0] ?? DEFAULT_EVENT_COLOR;

	const stops: string[] = [];
	colors.forEach((color, index) => {
		const from = (index / colors.length) * 100;
		const to = ((index + 1) / colors.length) * 100;
		stops.push(`${color} ${from}%`, `${color} ${to}%`);
	});

	return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** `HH:MM` in Torn City Time (UTC). */
function formatClockTime(iso: string): string {
	return new Date(iso).toLocaleTimeString("en-US", {
		timeZone: "UTC",
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatEventTime(ev: CalendarEvent): string {
	if (ev.isAllDay) return "All day (TCT)";
	return `${formatClockTime(ev.startTime)} - ${formatClockTime(ev.endTime)} TCT`;
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

function formatTuesday(dateValue: string): string {
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

export function SubversiveCalendarPage({
	isPublic = false,
}: SubversiveCalendarPageProps) {
	const { navigate } = useRouter();
	const { authenticated } = useAuth();

	// The calendar only ever shows Torn's running year; a year picker would offer
	// windows Torn's own calendar response does not describe.
	const today = useMemo(() => {
		const now = new Date();
		return {
			year: now.getUTCFullYear(),
			month: now.getUTCMonth(),
			day: now.getUTCDate(),
		};
	}, []);
	const year = today.year;

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

	// Day details modal
	const [selectedDate, setSelectedDate] = useState<{
		year: number;
		month: number;
		day: number;
	} | null>(null);

	// Add/Edit event modal
	const [eventModalOpen, setEventModalOpen] = useState(false);
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
	 * The Tuesdays a Ranked War Enlistment can be pinned to, plus whatever date an
	 * event being edited already sits on so an old enlistment stays selectable.
	 */
	const enlistmentDates = useMemo(() => {
		const dates: string[] = [];
		const cursor = new Date(
			Date.UTC(today.year, today.month, today.day, ENLISTMENT_HOUR_UTC),
		);

		while (cursor.getUTCDay() !== ENLISTMENT_WEEKDAY_UTC) {
			cursor.setUTCDate(cursor.getUTCDate() + 1);
		}

		for (let i = 0; i < ENLISTMENT_OPTION_COUNT; i++) {
			dates.push(toDateValue(cursor));
			cursor.setUTCDate(cursor.getUTCDate() + 7);
		}

		return dates;
	}, [today]);

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
	// A Steadfast Change runs in whole days, so it is all-day whether or not the
	// switch is on screen.
	const isSteadfast = formCategory === "steadfast_change";
	const isAllDayEvent = isSteadfast || formIsAllDay;

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
	const filteredEvents = useMemo(() => {
		let list: CalendarEvent[] = [];

		if (activeFilter === "all") {
			list = [...factionEvents, ...tornEvents];
		} else if (activeFilter === "faction") {
			list = factionEvents;
		} else if (activeFilter === "competitions") {
			list = tornEvents.filter((e) => e.category === "torn_competition");
		} else if (activeFilter === "events") {
			list = tornEvents.filter((e) => e.category === "torn_event");
		}

		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase().trim();
			list = list.filter(
				(e) =>
					e.title.toLowerCase().includes(q) ||
					e.description.toLowerCase().includes(q),
			);
		}

		return list;
	}, [factionEvents, tornEvents, activeFilter, searchQuery]);

	// Filter counts
	const counts = useMemo(
		() => ({
			all: factionEvents.length + tornEvents.length,
			faction: factionEvents.length,
			competitions: tornEvents.filter((e) => e.category === "torn_competition")
				.length,
			events: tornEvents.filter((e) => e.category === "torn_event").length,
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

	// Open Day Modal
	const handleDayClick = (mIndex: number, dayNumber: number) => {
		setSelectedDate({ year, month: mIndex, day: dayNumber });
	};

	// Get events active on a specific day
	const getEventsForDay = useCallback(
		(mIndex: number, dayNumber: number) => {
			const startSec = Math.floor(
				Date.UTC(year, mIndex, dayNumber, 0, 0, 0) / 1000,
			);
			const endSec = Math.floor(
				Date.UTC(year, mIndex, dayNumber, 23, 59, 59) / 1000,
			);

			return filteredEvents.filter(
				(e) => e.startTimestamp <= endSec && e.endTimestamp >= startSec,
			);
		},
		[filteredEvents, year],
	);

	// Open Add Event modal prefilled with day
	const handleOpenAddEvent = (mIndex?: number, dayNumber?: number) => {
		setEditingEventId(null);
		setFormDescription("");
		setFormCategory(factionCategories[0]?.value ?? "war");
		setFormIsAllDay(false);
		setFormPrimaryStat("speed");
		setFormSecondaryStat("defense");
		setFormFactionId(PRIMARY_SUBVERSIVE_FACTION_ID);

		const clickedDay =
			mIndex !== undefined && dayNumber !== undefined
				? toDateValue(new Date(Date.UTC(year, mIndex, dayNumber)))
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

	// Save Event
	const handleSaveEvent = async () => {
		if (!formCategory) {
			toast.error("Please choose a category.");
			return;
		}

		if (!formStartDate || !formEndDate) {
			toast.error("Please specify start and end dates.");
			return;
		}

		if (isSteadfast && formPrimaryStat === formSecondaryStat) {
			toast.error("Primary and secondary battlestats must be different.");
			return;
		}

		const sTime = isAllDayEvent ? "00:00:00" : `${formStartTime}:00`;
		const eTime = isAllDayEvent ? "23:59:59" : `${formEndTime}:00`;

		// Enlistment runs in a fixed Tuesday window, so the date is all the form
		// collects and the API pins the times.
		const startIso = isEnlistment
			? new Date(
					`${formStartDate}T${String(ENLISTMENT_HOUR_UTC).padStart(2, "0")}:00:00Z`,
				).toISOString()
			: new Date(`${formStartDate}T${sTime}Z`).toISOString();
		const endIso = isEnlistment
			? new Date(
					new Date(startIso).getTime() +
						ENLISTMENT_WINDOW_HOURS * 60 * 60 * 1000,
				).toISOString()
			: new Date(`${formEndDate}T${eTime}Z`).toISOString();

		if (new Date(endIso) < new Date(startIso)) {
			toast.error("End date/time must be after start date/time.");
			return;
		}

		const payload = {
			description: formDescription,
			category: formCategory,
			startTime: startIso,
			endTime: endIso,
			isAllDay: isEnlistment ? false : isAllDayEvent,
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
					toast.error("Failed to update event.");
				}
			} else {
				const res = await api.v2.subversive.calendar.events.post(payload);

				if (res.data && "success" in res.data && res.data.success) {
					toast.success("Faction event created!");
					setEventModalOpen(false);
					await fetchCalendar(true);
				} else {
					toast.error("Failed to create event.");
				}
			}
		} catch (_err) {
			toast.error("Error saving event.");
		} finally {
			setSubmitting(false);
		}
	};

	// Delete Event
	const handleDeleteEvent = async (id: string) => {
		if (!confirm("Are you sure you want to delete this faction event?")) return;

		try {
			const res = await api.v2.subversive.calendar.events({ id }).delete();
			if (res.data && "success" in res.data && res.data.success) {
				toast.success("Event removed from calendar.");
				await fetchCalendar(true);
				if (selectedDate) {
					setSelectedDate({ ...selectedDate });
				}
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

			const dayEvents = getEventsForDay(mIndex, d);

			const cell = (
				<Button
					key={`day-${d}`}
					type="button"
					variant="ghost"
					size="xs"
					onClick={() => handleDayClick(mIndex, d)}
					aria-label={
						dayEvents.length > 0
							? `${d} ${MONTH_NAMES[mIndex]} ${year}, ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`
							: `${d} ${MONTH_NAMES[mIndex]} ${year}, no events`
					}
					className={cn(
						"relative h-9 w-full flex-col px-0 text-xs font-medium tabular-nums sm:h-8",
						// Today sits outside the wash so it cannot be swallowed by it.
						isToday && "font-semibold text-primary ring-1 ring-primary/50",
					)}
				>
					{/* A translucent wash across the whole cell, one band per event, so a
					    day with something on it reads at a glance from across the grid. */}
					{dayEvents.length > 0 ? (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 rounded-md"
							style={{
								// `background`, not `background-image`: a single event is a
								// colour, and a bare colour is not a valid background-image.
								background: dayWash(dayEvents),
								opacity: DAY_WASH_OPACITY,
							}}
						/>
					) : null}
					<span className="relative leading-none">{d}</span>
				</Button>
			);

			// Hovering an event day answers "what is on this day" without a click;
			// the click still opens the full day view.
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
											{formatEventTime(ev)}
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

	// Events active on selected date modal
	const selectedDateEvents = useMemo(() => {
		if (!selectedDate) return [];
		return getEventsForDay(selectedDate.month, selectedDate.day);
	}, [selectedDate, getEventsForDay]);

	const isTodaySelected =
		selectedDate !== null &&
		today.year === selectedDate.year &&
		today.month === selectedDate.month &&
		today.day === selectedDate.day;

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
								Sentinel
							</span>
							<StatusBadge tone="primary" size="sm">
								Subversive Alliance
							</StatusBadge>
						</div>
						<span className="text-xs text-muted-foreground">
							Events Calendar
						</span>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<TctClock />

						<Button variant="outline" size="sm" onClick={handleCopyPublicLink}>
							Share
						</Button>

						<ThemeToggle />

						{authenticated ? (
							canEdit ? (
								<Button size="sm" onClick={() => handleOpenAddEvent()}>
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
										<Button size="sm" onClick={() => handleOpenAddEvent()}>
											New faction event
										</Button>
									) : null}
								</>
							}
						/>
					) : null}

					{toolbar}

					{accentLegend}

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

			{/* ── Day Details Modal ──────────────────────────────────────────────── */}
			<Dialog
				open={Boolean(selectedDate)}
				onOpenChange={(open) => !open && setSelectedDate(null)}
			>
				<DialogContent className="max-w-md sm:max-w-lg">
					{selectedDate ? (
						<>
							<DialogHeader>
								<div className="flex items-baseline gap-2">
									<DialogTitle className="text-base sm:text-lg">
										{selectedDate.day} {MONTH_NAMES[selectedDate.month]}{" "}
										{selectedDate.year}
									</DialogTitle>
									{isTodaySelected ? (
										<span className="text-xs text-muted-foreground">Today</span>
									) : null}
								</div>
								<DialogDescription>
									Events scheduled for this date in Torn City Time (TCT / UTC).
								</DialogDescription>
							</DialogHeader>

							<div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
								{selectedDateEvents.length === 0 ? (
									<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/80 p-6 text-center">
										<p className="text-sm text-muted-foreground">
											No events scheduled on this day.
										</p>
										{canEdit ? (
											<Button
												variant="outline"
												size="sm"
												onClick={() => {
													const m = selectedDate.month;
													const d = selectedDate.day;
													setSelectedDate(null);
													handleOpenAddEvent(m, d);
												}}
											>
												Schedule faction event
											</Button>
										) : null}
									</div>
								) : (
									selectedDateEvents.map((ev) => (
										<Card
											key={ev.id}
											className="gap-0 border-border/80 bg-card p-3 shadow-none"
										>
											<div className="flex items-start justify-between gap-3">
												<div className="flex min-w-0 flex-col gap-1">
													<div className="flex min-w-0 items-center gap-2">
														<span
															className="size-2 shrink-0 rounded-full"
															style={{
																backgroundColor:
																	ev.color || DEFAULT_EVENT_COLOR,
															}}
														/>
														<span className="text-sm font-semibold break-anywhere">
															{ev.title}
														</span>
													</div>

													<span className="font-mono text-xs text-muted-foreground">
														{formatEventTime(ev)}
													</span>

													{formatStats(ev) ? (
														<span className="text-xs text-muted-foreground">
															{`Stats: ${formatStats(ev)}`}
														</span>
													) : null}

													{ev.description ? (
														<p className="text-xs text-muted-foreground sm:text-sm">
															{ev.description}
														</p>
													) : null}
												</div>

												{/* Only stored events have a row to change; ranked-war
												    mirrors are read-only. */}
												{canEdit && ev.editable ? (
													<div className="flex shrink-0 items-center gap-1">
														<Button
															variant="ghost"
															size="xs"
															onClick={() => {
																setSelectedDate(null);
																handleOpenEditEvent(ev);
															}}
														>
															Edit
														</Button>
														<Button
															variant="ghost"
															size="xs"
															onClick={() => handleDeleteEvent(ev.id)}
															className="text-destructive hover:text-destructive"
														>
															Delete
														</Button>
													</div>
												) : null}
											</div>
										</Card>
									))
								)}
							</div>

							<DialogFooter className="flex flex-row items-center justify-between sm:justify-between">
								{canEdit && selectedDateEvents.length > 0 ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											const m = selectedDate.month;
											const d = selectedDate.day;
											setSelectedDate(null);
											handleOpenAddEvent(m, d);
										}}
									>
										Add another event
									</Button>
								) : (
									<div />
								)}

								<Button
									variant="secondary"
									size="sm"
									onClick={() => setSelectedDate(null)}
								>
									Close
								</Button>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>

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

						{/* Enlistment is a Tuesday 12:00 TCT ritual, so the date is the
						    only thing to choose. */}
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
												{formatTuesday(dateValue)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">
									Runs 12:00 - 13:00 TCT, the Tuesday enlistment window.
								</p>
							</div>
						) : (
							<>
								{/* All day toggle — a Steadfast Change is always all day, so the
								    switch would only be a lie. */}
								{isSteadfast ? (
									<p className="text-xs text-muted-foreground">
										Steadfast Change always runs whole days.
									</p>
								) : (
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
								)}

								{/* Battlestats a Steadfast Change asks members to hold */}
								{isSteadfast ? (
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
											<Label htmlFor="secondary-stat">
												Secondary Battlestat
											</Label>
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
								) : null}
							</>
						)}

						{/* Dates & Times — the enlistment picker above owns its own date */}
						{!isEnlistment ? (
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
						) : null}

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

					<DialogFooter>
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
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export default SubversiveCalendarPage;
