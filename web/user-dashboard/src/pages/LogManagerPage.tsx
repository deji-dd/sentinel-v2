import { formatDuration } from "@sentinel/utils";
import { format } from "date-fns";
import {
	AlertCircle,
	AlertTriangle,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Copy,
	History,
	Loader2,
	Pause,
	Play,
	RefreshCw,
	RotateCcw,
	Search,
	Tag,
	Terminal,
	X,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useGlobalLoading } from "@/contexts/LoadingContext";
import { useRouter } from "@/router";

const activityChartConfig = {
	count: {
		label: "Logs Recorded",
		color: "#38bdf8",
	},
} satisfies ChartConfig;

export interface LogManagerState {
	status: "idle" | "running" | "paused" | "completed" | "error";
	backfillStatus: "idle" | "in_progress" | "paused" | "completed" | "error";
	forwardStatus: "idle" | "polling" | "error";
	totalLogsRecorded: number;
	backfillLogsCount: number;
	forwardLogsCount: number;
	oldestTimestampReached: number | null;
	newestTimestampReached: number | null;
	lastForwardCheckedAt: number | null;
	lastBackfillCheckedAt: number | null;
	lastError: string | null;
	lastSyncDurationMs: number | null;
	updatedAt: string;
	totalInDb?: number;
	dbOldestDate?: string | null;
	dbNewestDate?: string | null;
}

export interface PersonalLogItem {
	id: string;
	log: number;
	title: string | null;
	timestamp: string | number;
	category: string | null;
	data: Record<string, unknown> | string;
	createdAt: string | number;
	updatedAt: string | number;
}

export interface CategoryCount {
	category: string | null;
	count: number;
}

export interface DailyActivityItem {
	date: string;
	count: number;
}

function formatRelativeTime(
	dateInput: string | number | null | undefined,
): string {
	if (!dateInput) return "Never";
	const timestamp =
		typeof dateInput === "number"
			? dateInput > 1e11
				? dateInput
				: dateInput * 1000
			: new Date(dateInput).getTime();
	if (Number.isNaN(timestamp)) return "Invalid Date";

	const diffSeconds = Math.floor((Date.now() - timestamp) / 1000);
	if (diffSeconds < 5) return "Just now";
	if (diffSeconds < 60) return `${diffSeconds}s ago`;
	if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
	if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
	return `${Math.floor(diffSeconds / 86400)}d ago`;
}

function formatDate(dateInput: string | number | null | undefined): string {
	if (!dateInput) return "N/A";
	const timestamp =
		typeof dateInput === "number"
			? dateInput > 1e11
				? dateInput
				: dateInput * 1000
			: new Date(dateInput).getTime();
	if (Number.isNaN(timestamp)) return "N/A";

	return new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZone: "UTC",
		timeZoneName: "short",
	}).format(new Date(timestamp));
}

function formatDayLabel(dateStr: string): string {
	if (!dateStr) return "";
	const parts = dateStr.split("-").map(Number);
	const year = parts[0];
	const month = parts[1];
	const day = parts[2];
	if (!year || !month || !day) return dateStr;
	const d = new Date(Date.UTC(year, month - 1, day));
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(d);
}

function formatDayFull(dateStr: string): string {
	if (!dateStr) return "";
	const parts = dateStr.split("-").map(Number);
	const year = parts[0];
	const month = parts[1];
	const day = parts[2];
	if (!year || !month || !day) return dateStr;
	const d = new Date(Date.UTC(year, month - 1, day));
	return new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(d);
}

export function LogManagerPage() {
	const { path } = useRouter();
	const { setPageReady } = useGlobalLoading();
	const [state, setState] = useState<LogManagerState | null>(null);
	const [logs, setLogs] = useState<PersonalLogItem[]>([]);
	const [categories, setCategories] = useState<CategoryCount[]>([]);
	const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
	const [searchQuery, setSearchQuery] = useState<string>("");
	const [page, setPage] = useState<number>(1);
	const [totalPages, setTotalPages] = useState<number>(1);
	const [totalLogsCount, setTotalLogsCount] = useState<number>(0);
	const [_isLoadingState, setIsLoadingState] = useState<boolean>(true);
	const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(false);
	const [isTogglingPause, setIsTogglingPause] = useState<boolean>(false);
	const [inspectLog, setInspectLog] = useState<PersonalLogItem | null>(null);
	const [showManualResync, setShowManualResync] = useState<boolean>(false);
	const [resyncFrom, setResyncFrom] = useState<string>("");
	const [resyncTo, setResyncTo] = useState<string>("");
	const [isResyncing, setIsResyncing] = useState<boolean>(false);
	const [copyFeedback, setCopyFeedback] = useState<boolean>(false);
	const [showResetModal, setShowResetModal] = useState<boolean>(false);
	const [isResetting, setIsResetting] = useState<boolean>(false);
	const [resetError, setResetError] = useState<string | null>(null);

	// Daily Activity Spectrum States
	const [activityDays, setActivityDays] = useState<DailyActivityItem[]>([]);
	const [activityRange, setActivityRange] = useState<string>("30");
	const [customRange, setCustomRange] = useState<{
		from: string;
		to: string;
	} | null>(null);
	const [dateRangePickerOpen, setDateRangePickerOpen] =
		useState<boolean>(false);
	const [calendarRange, setCalendarRange] = useState<DateRange | undefined>(
		undefined,
	);
	const [selectedDate, setSelectedDate] = useState<string | null>(null);
	const [isLoadingActivity, setIsLoadingActivity] = useState<boolean>(false);

	const activityRangeRef = useRef(activityRange);
	activityRangeRef.current = activityRange;

	const customRangeRef = useRef(customRange);
	customRangeRef.current = customRange;

	const selectedCategoryRef = useRef(selectedCategory);
	selectedCategoryRef.current = selectedCategory;

	const selectedDateRef = useRef(selectedDate);
	selectedDateRef.current = selectedDate;

	const searchQueryRef = useRef(searchQuery);
	searchQueryRef.current = searchQuery;

	const pageRef = useRef(page);
	pageRef.current = page;

	// Fetch Log Manager State
	const fetchState = async () => {
		try {
			const res = await fetch("/api/v1/system/log-manager/state");
			if (!res.ok) {
				throw new Error(
					`HTTP ${res.status}: Failed to fetch log manager state`,
				);
			}
			const data = await res.json();
			if (data.state) {
				setState(data.state);
			}
		} catch (error) {
			console.error("Failed to fetch log manager state:", error);
			toast.error("Failed to fetch log manager state", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsLoadingState(false);
		}
	};

	// Fetch Categories
	const fetchCategories = async (
		range = activityRange,
		date = selectedDate,
	) => {
		try {
			const params = new URLSearchParams();
			if (date) {
				params.set("date", date);
			} else if (range === "custom" && customRangeRef.current) {
				params.set("from", customRangeRef.current.from);
				params.set("to", customRangeRef.current.to);
			} else if (range && range !== "all") {
				params.set("days", range);
			}

			const res = await fetch(
				`/api/v1/system/log-manager/categories?${params.toString()}`,
			);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch categories`);
			}
			const data = await res.json();
			setCategories(data.categories || []);
		} catch (error) {
			console.error("Failed to fetch categories:", error);
			toast.error("Failed to fetch log categories", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	// Fetch Daily Activity Spectrum
	const fetchActivity = async (
		range = activityRange,
		category = selectedCategory,
		silent = false,
	) => {
		if (!silent) setIsLoadingActivity(true);
		try {
			const params = new URLSearchParams();
			if (range === "custom" && customRangeRef.current) {
				params.set("from", customRangeRef.current.from);
				params.set("to", customRangeRef.current.to);
			} else if (range !== "all") params.set("days", range);
			if (category && category !== "ALL") params.set("category", category);

			const res = await fetch(
				`/api/v1/system/log-manager/activity?${params.toString()}`,
			);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch activity`);
			}
			const data = await res.json();
			setActivityDays(data.days || []);
		} catch (error) {
			console.error("Failed to fetch log activity:", error);
			if (!silent) {
				toast.error("Failed to fetch log activity", {
					description: error instanceof Error ? error.message : "Unknown error",
				});
			}
		} finally {
			if (!silent) setIsLoadingActivity(false);
		}
	};

	// Fetch Paginated Logs
	const fetchLogs = async (
		currentPage = page,
		category = selectedCategory,
		search = searchQuery,
		date = selectedDate,
		range = activityRange,
		silent = false,
	) => {
		if (!silent) setIsLogsLoading(true);
		try {
			const params = new URLSearchParams();
			params.set("page", String(currentPage));
			params.set("limit", "25");
			if (category && category !== "ALL") {
				params.set("category", category);
			}
			if (search.trim()) {
				params.set("search", search.trim());
			}
			if (date) {
				params.set("date", date);
			} else if (range === "custom" && customRangeRef.current) {
				params.set("from", customRangeRef.current.from);
				params.set("to", customRangeRef.current.to);
			} else if (range && range !== "all") {
				params.set("days", range);
			}

			const res = await fetch(
				`/api/v1/system/log-manager/logs?${params.toString()}`,
			);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch logs`);
			}
			const data = await res.json();
			setLogs(data.logs || []);
			setTotalLogsCount(data.total || 0);
			setTotalPages(data.totalPages || 1);
		} catch (error) {
			console.error("Failed to fetch logs:", error);
			if (!silent) {
				toast.error("Failed to fetch logs", {
					description: error instanceof Error ? error.message : "Unknown error",
				});
			}
		} finally {
			if (!silent) setIsLogsLoading(false);
		}
	};

	function setIsLogsLoading(loading: boolean) {
		setIsLoadingLogs(loading);
	}

	// Automatically update activity graph and categories whenever live state changes
	const isFirstMount = useRef(true);
	useEffect(() => {
		if (isFirstMount.current) {
			isFirstMount.current = false;
			return;
		}

		if (!state) return;

		// Silently refresh activity chart and categories without flickering the loading spinner
		fetchActivity(activityRangeRef.current, selectedCategoryRef.current, true);
		fetchCategories(activityRangeRef.current, selectedDateRef.current);

		// If on page 1 and not actively filtering by search, also refresh logs table silently
		if (pageRef.current === 1 && !searchQueryRef.current) {
			fetchLogs(
				1,
				selectedCategoryRef.current,
				"",
				selectedDateRef.current,
				activityRangeRef.current,
				true,
			);
		}
	}, [
		state?.totalInDb,
		state?.totalLogsRecorded,
		state?.oldestTimestampReached,
		state?.newestTimestampReached,
		state?.backfillLogsCount,
		state?.forwardLogsCount,
		state?.status,
		state?.backfillStatus,
		state?.updatedAt,
	]);

	// WebSocket Real-time Live Stream Connection
	useEffect(() => {
		Promise.allSettled([
			fetchCategories("30", null),
			fetchActivity("30", "ALL"),
			fetchLogs(1, "ALL", "", null, "30"),
			fetchState(),
		]).finally(() => {
			setPageReady(path);
		});

		let ws: WebSocket | null = null;
		let pingInterval: ReturnType<typeof setInterval> | null = null;
		let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

		function connect() {
			try {
				const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
				const wsUrl = `${protocol}//${window.location.host}/api/ws/log-manager`;
				ws = new WebSocket(wsUrl);

				ws.onopen = () => {
					// Request live refresh snapshots over WS every 3 seconds
					pingInterval = setInterval(() => {
						if (ws?.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ type: "refresh" }));
						}
					}, 3000);
				};

				ws.onmessage = (event) => {
					try {
						const data = JSON.parse(event.data);
						if (data.type === "state_snapshot" && data.state) {
							setState(data.state);
							setIsLoadingState(false);
						}
					} catch (err) {
						console.error("Failed to parse WS message:", err);
					}
				};

				ws.onerror = () => {
					fetchState();
				};

				ws.onclose = () => {
					if (pingInterval) clearInterval(pingInterval);
					reconnectTimeout = setTimeout(connect, 3000);
				};
			} catch {
				fetchState();
			}
		}

		connect();

		return () => {
			if (pingInterval) clearInterval(pingInterval);
			if (reconnectTimeout) clearTimeout(reconnectTimeout);
			if (ws) ws.close();
		};
	}, []);

	// Handle Category Filter Change
	const handleSelectCategory = (cat: string) => {
		setSelectedCategory(cat);
		setPage(1);
		fetchLogs(1, cat, searchQuery, selectedDate, activityRange);
		fetchActivity(activityRange, cat);
	};

	// Handle Range Selection Change
	const handleRangeChange = (newRange: string) => {
		setActivityRange(newRange);
		setCustomRange(null);
		customRangeRef.current = null;
		setCalendarRange(undefined);
		setDateRangePickerOpen(false);
		fetchActivity(newRange, selectedCategory);
		fetchCategories(newRange, selectedDate);
		fetchLogs(1, selectedCategory, searchQuery, selectedDate, newRange);
	};

	// Handle Custom Range Popover Open/Close
	const handleOpenCustomPicker = (open: boolean) => {
		setDateRangePickerOpen(open);
		if (open) {
			if (customRange) {
				setCalendarRange({
					from: new Date(`${customRange.from}T00:00:00`),
					to: new Date(`${customRange.to}T00:00:00`),
				});
			} else {
				setCalendarRange(undefined);
			}
		}
	};

	// Handle Custom Range Apply (from the shadcn date range calendar)
	const handleApplyCustomRange = () => {
		if (!calendarRange?.from) return;
		const fromStr = format(calendarRange.from, "yyyy-MM-dd");
		const toStr = calendarRange.to
			? format(calendarRange.to, "yyyy-MM-dd")
			: fromStr;
		const range = { from: fromStr, to: toStr };
		setCustomRange(range);
		customRangeRef.current = range;
		setActivityRange("custom");
		setDateRangePickerOpen(false);
		fetchActivity("custom", selectedCategory);
		fetchCategories("custom", selectedDate);
		fetchLogs(1, selectedCategory, searchQuery, selectedDate, "custom");
	};

	// Handle Date Bar Click
	const handleSelectDate = (dateStr: string) => {
		if (selectedDate === dateStr) {
			setSelectedDate(null);
			setPage(1);
			fetchLogs(1, selectedCategory, searchQuery, null, activityRange);
			fetchCategories(activityRange, null);
		} else {
			setSelectedDate(dateStr);
			setPage(1);
			fetchLogs(1, selectedCategory, searchQuery, dateStr, activityRange);
			fetchCategories(activityRange, dateStr);
		}
	};

	// Clear Selected Date Filter
	const handleClearDateFilter = () => {
		setSelectedDate(null);
		setPage(1);
		fetchLogs(1, selectedCategory, searchQuery, null, activityRange);
		fetchCategories(activityRange, null);
	};

	// Handle Search Input Change
	const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value;
		setSearchQuery(val);
		setPage(1);
		fetchLogs(1, selectedCategory, val, selectedDate, activityRange);
	};

	// Toggle Pause / Resume Backfill
	const handleTogglePause = async () => {
		if (!state) return;
		setIsTogglingPause(true);
		try {
			const shouldPause = state.backfillStatus !== "paused";
			const res = await fetch("/api/v1/system/log-manager/pause", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ paused: shouldPause }),
			});
			if (res.ok) {
				toast.success(shouldPause ? "Backfill paused" : "Backfill resumed");
				await fetchState();
			} else {
				throw new Error(`HTTP ${res.status}: Failed to toggle pause state`);
			}
		} catch (error) {
			console.error("Failed to toggle pause state:", error);
			toast.error("Failed to toggle pause state", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsTogglingPause(false);
		}
	};

	// Execute Manual Range Resync
	const handleExecuteResync = async () => {
		if (!resyncFrom || !resyncTo) return;
		setIsResyncing(true);
		try {
			const fromTs = Math.floor(new Date(resyncFrom).getTime() / 1000);
			const toTs = Math.floor(new Date(resyncTo).getTime() / 1000);

			if (Number.isNaN(fromTs) || Number.isNaN(toTs) || fromTs >= toTs) {
				toast.error("Invalid date range", {
					description: "Ensure 'From' date is earlier than 'To' date.",
				});
				setIsResyncing(false);
				return;
			}

			const res = await fetch("/api/v1/system/log-manager/resync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ from: fromTs, to: toTs }),
			});

			if (res.ok) {
				toast.success("Manual resync triggered successfully");
				setShowManualResync(false);
				setResyncFrom("");
				setResyncTo("");
				await fetchState();
				await fetchLogs(1);
			} else {
				throw new Error(`HTTP ${res.status}: Failed to execute manual resync`);
			}
		} catch (error) {
			console.error("Failed to execute manual resync:", error);
			toast.error("Failed to execute manual resync", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsResyncing(false);
		}
	};

	// Reset Log Manager State
	const handleResetState = async () => {
		setIsResetting(true);
		setResetError(null);
		try {
			const res = await fetch("/api/v1/system/log-manager/reset", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirm: true }),
			});
			const data = (await res.json()) as {
				success?: boolean;
				error?: string;
				state?: LogManagerState;
			};
			if (res.ok && data.success) {
				toast.success("Log manager state successfully reset");
				setShowResetModal(false);
				if (data.state) {
					setState(data.state);
				} else {
					await fetchState();
				}
				await fetchLogs(1);
				await fetchActivity();
				await fetchCategories();
			} else {
				const errMsg =
					data.error ?? "Failed to reset log manager state. Please try again.";
				setResetError(errMsg);
				toast.error("Reset failed", { description: errMsg });
			}
		} catch (error) {
			console.error("Failed to reset log manager state:", error);
			const errMsg =
				error instanceof Error
					? error.message
					: "Failed to reset log manager state.";
			setResetError(errMsg);
			toast.error("Reset error", { description: errMsg });
		} finally {
			setIsResetting(false);
		}
	};

	// Copy Raw JSON to Clipboard
	const handleCopyJson = (raw: unknown) => {
		const jsonStr =
			typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
		navigator.clipboard.writeText(jsonStr);
		setCopyFeedback(true);
		toast.success("Copied to clipboard");
		setTimeout(() => setCopyFeedback(false), 2000);
	};

	const isBackfillPaused = state?.backfillStatus === "paused";
	const isBackfillComplete = state?.backfillStatus === "completed";

	// Chart statistics
	const totalActivityLogs = activityDays.reduce((acc, d) => acc + d.count, 0);
	const avgLogsPerDay =
		activityDays.length > 0
			? Math.round(totalActivityLogs / activityDays.length)
			: 0;
	const peakDay =
		activityDays.length > 0
			? [...activityDays].sort((a, b) => b.count - a.count)[0]
			: null;

	return (
		<div className="space-y-8 animate-in fade-in duration-300">
			{/* Top Header Deck */}
			<div className="flex flex-col md:flex-row md:items-center justify-end gap-4 pb-2 border-b border-border/40">
				{/* Control Deck Action Buttons */}
				<div className="flex items-center gap-2">
					<Button
						variant={isBackfillPaused ? "default" : "outline"}
						size="sm"
						onClick={handleTogglePause}
						disabled={isTogglingPause || isBackfillComplete}
						className="rounded-xl text-xs cursor-pointer shadow-xs gap-1.5 h-8"
					>
						{isTogglingPause ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : isBackfillPaused ? (
							<>
								<Play className="size-3.5 fill-current" /> Resume Backfill
							</>
						) : (
							<>
								<Pause className="size-3.5 fill-current" /> Pause Backfill
							</>
						)}
					</Button>

					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowManualResync(true)}
						className="rounded-xl text-xs cursor-pointer gap-1.5 h-8 border-border/80 hover:border-primary/40"
					>
						<History className="size-3.5 text-primary" /> Range Resync
					</Button>

					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setResetError(null);
							setShowResetModal(true);
						}}
						className="rounded-xl text-xs cursor-pointer gap-1.5 h-8 border-border/80 hover:border-destructive/40 hover:text-destructive text-muted-foreground"
						title="Reset log manager state"
					>
						<RotateCcw className="size-3.5" /> Reset State
					</Button>

					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							fetchState();
							fetchLogs(page);
						}}
						className="rounded-xl size-8 p-0 cursor-pointer text-muted-foreground hover:text-foreground"
						title="Refresh data"
					>
						<RefreshCw className="size-3.5" />
					</Button>
				</div>
			</div>

			{/* Antigravity Spatial Status Card */}
			<Card className="relative overflow-hidden border-primary/20 bg-linear-to-br from-card/90 via-card/70 to-primary/5 shadow-[0_20px_50px_rgba(0,0,0,0.12)]">
				<div className="absolute top-0 right-0 -mr-16 -mt-16 size-64 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
				<div className="absolute bottom-0 left-0 -ml-16 -mb-16 size-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

				<CardContent className="space-y-4">
					{/* Dual Stream Progress Visualizer */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{/* Backward Backfill Stream */}
						<div className="p-4 rounded-xl bg-background/40 border border-border/60 backdrop-blur-md space-y-2">
							<div className="flex items-center justify-between text-xs">
								<span className="font-medium text-foreground flex items-center gap-1.5">
									Backfill
								</span>
							</div>

							<div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground pt-1 border-t border-border/40">
								<span>Oldest reached:</span>
								<span className="text-foreground font-semibold">
									{state?.oldestTimestampReached
										? formatDate(state.oldestTimestampReached)
										: "Scanning..."}
								</span>
							</div>
						</div>

						{/* Forward Real-Time Stream */}
						<div className="p-4 rounded-xl bg-background/40 border border-border/60 backdrop-blur-md space-y-2">
							<div className="flex items-center justify-between text-xs">
								<span className="font-medium text-foreground flex items-center gap-1.5">
									Forward Stream
								</span>
							</div>

							<div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground pt-1 border-t border-border/40">
								<span>Newest reached:</span>
								<span className="text-foreground font-semibold">
									{state?.newestTimestampReached
										? formatDate(state.newestTimestampReached)
										: "Scanning..."}
								</span>
							</div>
						</div>
					</div>

					{/* Live Progress Bar */}
					<div className="space-y-1.5 pt-1">
						<div className="flex justify-between text-[11px] font-mono text-muted-foreground">
							<span className="flex items-center gap-1.5">
								Total Records:{" "}
								<strong className="text-foreground font-semibold">
									{(state?.totalInDb ?? totalLogsCount).toLocaleString()} logs
								</strong>
							</span>
							<span>
								Last Cycle: {formatDuration(state?.lastSyncDurationMs ?? 0)}
							</span>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Daily Activity Spectrum Visualizer Card */}
			<Card className="border-border/60 bg-card/70 backdrop-blur-2xl shadow-xl space-y-0 overflow-hidden">
				<CardHeader className="p-5 sm:p-6 border-b border-border/40 space-y-3">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
						<div className="space-y-0.5">
							<CardTitle className="text-base font-semibold flex items-center gap-2">
								Daily Activity
							</CardTitle>
						</div>

						{/* Range Selector Controls */}
						<div className="flex items-center gap-1 bg-background/50 border border-border/70 p-1 rounded-xl">
							{[
								{ label: "1D", value: "1" },
								{ label: "1W", value: "7" },
								{ label: "1M", value: "30" },
								{ label: "All", value: "all" },
							].map((r) => (
								<Button
									key={r.value}
									variant={
										activityRange === r.value && !selectedDate
											? "default"
											: "ghost"
									}
									size="xs"
									onClick={() => handleRangeChange(r.value)}
									className={`h-7 px-2.5 text-xs font-mono rounded-lg transition-all cursor-pointer ${
										activityRange === r.value && !selectedDate
											? "font-semibold shadow-xs"
											: "text-muted-foreground hover:text-foreground hover:bg-accent/40"
									}`}
								>
									{r.label}
								</Button>
							))}

							<div className="w-px self-stretch my-1 bg-border/70" />

							{/* Custom Range Picker */}
							<Popover
								open={dateRangePickerOpen}
								onOpenChange={handleOpenCustomPicker}
							>
								<PopoverTrigger asChild>
									<Button
										variant={
											activityRange === "custom" && !selectedDate
												? "default"
												: "ghost"
										}
										size="xs"
										className={`h-7 flex items-center gap-1.5 px-2.5 text-xs font-mono rounded-lg transition-all cursor-pointer ${
											activityRange === "custom" && !selectedDate
												? "font-semibold shadow-xs"
												: "text-muted-foreground hover:text-foreground hover:bg-accent/40"
										}`}
									>
										<CalendarDays className="size-3" />
										{activityRange === "custom" && customRange
											? `${customRange.from.slice(5)} → ${customRange.to.slice(5)}`
											: "Custom"}
									</Button>
								</PopoverTrigger>
								<PopoverContent align="end" className="w-auto p-3">
									<div className="flex flex-col gap-3">
										<div className="flex items-center justify-between px-1 gap-4">
											<p className="text-xs font-semibold uppercase tracking-wide font-mono text-muted-foreground">
												Custom Range
											</p>
											{calendarRange?.from && (
												<span className="text-[11px] font-mono text-foreground/80">
													{format(calendarRange.from, "yyyy-MM-dd")}
													{calendarRange.to
														? ` → ${format(calendarRange.to, "yyyy-MM-dd")}`
														: ""}
												</span>
											)}
										</div>
										<Calendar
											mode="range"
											defaultMonth={calendarRange?.from || new Date()}
											selected={calendarRange}
											onSelect={setCalendarRange}
											numberOfMonths={2}
											className="rounded-md border border-border/40 p-2"
										/>
										<div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
											<Button
												variant="ghost"
												size="sm"
												className="h-7 px-2 text-xs font-mono cursor-pointer"
												onClick={() => {
													handleRangeChange("30");
													setDateRangePickerOpen(false);
												}}
											>
												Reset (1M)
											</Button>
											<div className="flex items-center gap-2">
												<Button
													variant="outline"
													size="sm"
													className="h-7 px-2.5 text-xs font-mono cursor-pointer"
													onClick={() => setDateRangePickerOpen(false)}
												>
													Cancel
												</Button>
												<Button
													size="sm"
													className="h-7 px-3 text-xs font-mono cursor-pointer"
													disabled={!calendarRange?.from}
													onClick={handleApplyCustomRange}
												>
													Apply
												</Button>
											</div>
										</div>
									</div>
								</PopoverContent>
							</Popover>
						</div>
					</div>

					{/* Metric Strip & Active Filter Badge */}
					<div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40 text-xs text-muted-foreground font-mono">
						<div className="flex flex-wrap items-center gap-2 sm:gap-3">
							<span>
								Total Records in Range:{" "}
								<strong className="text-foreground font-semibold">
									{totalActivityLogs.toLocaleString()} logs
								</strong>
							</span>
							<span>•</span>
							<span>
								Avg:{" "}
								<strong className="text-foreground font-semibold">
									{avgLogsPerDay}/day
								</strong>
							</span>
							{peakDay && (
								<>
									<span>•</span>
									<span>
										Peak:{" "}
										<strong className="text-cyan-400 font-semibold">
											{peakDay.count} logs ({formatDayLabel(peakDay.date)})
										</strong>
									</span>
								</>
							)}
						</div>

						{selectedDate && (
							<div className="flex items-center gap-2">
								<Badge
									variant="outline"
									className="border-primary/50 text-primary bg-primary/10 gap-1.5 py-0.5 px-2 font-mono text-xs animate-pulse"
								>
									<CalendarDays className="size-3" />
									Filtered: {formatDayFull(selectedDate)}
								</Badge>
								<Button
									variant="ghost"
									size="sm"
									onClick={handleClearDateFilter}
									className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
								>
									<X className="size-3 mr-1" />
									Show All Days
								</Button>
							</div>
						)}
					</div>
				</CardHeader>

				<CardContent className="p-5 sm:p-6">
					{isLoadingActivity ? (
						<div className="h-44 flex flex-col items-center justify-center space-y-2 text-muted-foreground">
							<Loader2 className="size-6 animate-spin text-primary" />
							<p className="text-xs font-mono">Loading activity spectrum...</p>
						</div>
					) : activityDays.length === 0 ? (
						<div className="h-44 flex flex-col items-center justify-center text-muted-foreground space-y-1">
							<AlertCircle className="size-6 text-muted-foreground/60" />
							<p className="text-xs font-medium">
								No activity recorded for this period
							</p>
						</div>
					) : (
						<ChartContainer
							config={activityChartConfig}
							className="h-52 w-full aspect-auto"
						>
							<AreaChart
								data={activityDays}
								margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
								onClick={(e: unknown) => {
									const chartEvent = e as {
										activePayload?: Array<{ payload?: { date?: string } }>;
										activeLabel?: string;
									} | null;
									const date =
										chartEvent?.activePayload?.[0]?.payload?.date ??
										chartEvent?.activeLabel;
									if (date) {
										handleSelectDate(date);
									}
								}}
								className="cursor-pointer"
							>
								<defs>
									<linearGradient
										id="activityGlowGradient"
										x1="0"
										y1="0"
										x2="0"
										y2="1"
									>
										<stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
										<stop offset="60%" stopColor="#0284c7" stopOpacity={0.1} />
										<stop offset="100%" stopColor="#0284c7" stopOpacity={0} />
									</linearGradient>
									<linearGradient
										id="activityLineGradient"
										x1="0"
										y1="0"
										x2="1"
										y2="0"
									>
										<stop offset="0%" stopColor="#06b6d4" />
										<stop offset="50%" stopColor="#38bdf8" />
										<stop offset="100%" stopColor="#34d399" />
									</linearGradient>
								</defs>
								<CartesianGrid
									strokeDasharray="3 3"
									vertical={false}
									className="stroke-border/40"
								/>
								<XAxis
									dataKey="date"
									tickLine={false}
									axisLine={false}
									tickMargin={8}
									minTickGap={24}
									className="text-[10px] font-mono fill-muted-foreground"
									tickFormatter={(value: string) => formatDayLabel(value)}
								/>
								<YAxis
									tickLine={false}
									axisLine={false}
									tickMargin={6}
									className="text-[10px] font-mono fill-muted-foreground"
									tickFormatter={(val: number) => {
										if (val >= 1_000_000)
											return `${(val / 1_000_000).toFixed(1)}M`;
										if (val >= 1_000) return `${(val / 1_000).toFixed(0)}k`;
										return `${val}`;
									}}
								/>
								<ChartTooltip
									cursor={{
										stroke: "rgba(56, 189, 248, 0.5)",
										strokeWidth: 1.5,
										strokeDasharray: "3 3",
									}}
									content={
										<ChartTooltipContent
											className="min-w-44 p-3 bg-background/95 border-border/90 backdrop-blur-xl shadow-xl"
											labelFormatter={(_, payload) => {
												const item = payload?.[0]?.payload as unknown as
													| DailyActivityItem
													| undefined;
												return (
													<div className="font-mono font-semibold text-primary flex items-center justify-between gap-3 pb-1 border-b border-border/60">
														<span>{item ? formatDayFull(item.date) : ""}</span>
														<CalendarDays className="size-3.5 text-muted-foreground" />
													</div>
												);
											}}
											formatter={(value) => (
												<div className="flex items-center justify-between gap-4 w-full text-xs font-mono">
													<span className="text-muted-foreground">
														Recorded Logs:
													</span>
													<span className="font-semibold text-foreground">
														{typeof value === "number"
															? value.toLocaleString()
															: value}
													</span>
												</div>
											)}
										/>
									}
								/>
								{selectedDate && (
									<ReferenceLine
										x={selectedDate}
										stroke="#22d3ee"
										strokeWidth={1.5}
										strokeDasharray="3 3"
									/>
								)}
								<Area
									type="monotone"
									dataKey="count"
									stroke="url(#activityLineGradient)"
									strokeWidth={2.5}
									fill="url(#activityGlowGradient)"
									activeDot={{
										r: 5,
										fill: "#38bdf8",
										stroke: "#ffffff",
										strokeWidth: 2,
									}}
								/>
							</AreaChart>
						</ChartContainer>
					)}
				</CardContent>
			</Card>

			{/* Interactive Log Explorer Deck */}
			<Card className="border-border/60 bg-card/70 backdrop-blur-2xl shadow-xl space-y-0 overflow-hidden">
				<CardHeader className="p-5 sm:p-6 border-b border-border/40 space-y-4">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
						<div className="space-y-0.5">
							<CardTitle className="text-base font-semibold flex items-center gap-2">
								Logs Explorer
								{selectedDate && (
									<Badge
										variant="outline"
										className="ml-2 font-mono text-[10px] bg-primary/10 text-primary border-primary/40 gap-1 py-0.5"
									>
										<CalendarDays className="size-3" />
										{formatDayLabel(selectedDate)} (
										{totalLogsCount.toLocaleString()} logs)
									</Badge>
								)}
							</CardTitle>
						</div>

						<div className="flex flex-col sm:flex-row items-center gap-2.5">
							{/* Category Dropdown */}
							<div className="relative w-full">
								<Tag className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none z-10" />
								<Select
									value={selectedCategory}
									onValueChange={handleSelectCategory}
								>
									<SelectTrigger
										id="category-dropdown"
										aria-label="Filter logs by category"
										className="w-full h-8 ps-9 pr-8 text-xs font-mono rounded-xl bg-background/50 border-border/80 text-foreground hover:border-primary/40 focus:border-primary cursor-pointer"
									>
										<SelectValue placeholder="All Categories" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="ALL">
											All Categories (
											{categories
												.reduce((acc, c) => acc + c.count, 0)
												.toLocaleString()}
											)
										</SelectItem>
										{categories.map((cat) => {
											const catName = cat.category || "Uncategorized";
											return (
												<SelectItem key={catName} value={catName}>
													{catName} ({cat.count.toLocaleString()})
												</SelectItem>
											);
										})}
									</SelectContent>
								</Select>
							</div>

							{/* Search Bar */}
							<div className="relative w-full">
								<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
								<Input
									placeholder="Search title, category, ID..."
									value={searchQuery}
									onChange={handleSearchChange}
									className="h-8 pl-8 text-xs rounded-xl bg-background/50 border-border/80"
								/>
							</div>
						</div>
					</div>
				</CardHeader>

				{/* Table Body */}
				<CardContent className="p-0">
					{isLoadingLogs ? (
						<div className="py-20 flex flex-col items-center justify-center space-y-3 text-muted-foreground">
							<Loader2 className="size-6 animate-spin text-primary" />
							<p className="text-xs font-mono">
								Querying SQLite personal logs...
							</p>
						</div>
					) : logs.length === 0 ? (
						<div className="py-16 text-center space-y-2 text-muted-foreground">
							<AlertCircle className="size-7 mx-auto text-muted-foreground/60" />
							<p className="text-sm font-semibold text-foreground">
								No logs found
							</p>
							<p className="text-xs max-w-sm mx-auto">
								{searchQuery
									? `No logs match "${searchQuery}" in ${selectedCategory}.`
									: "Log backfill has not recorded entries matching the filter."}
							</p>
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow className="border-b border-border/80 bg-muted/30 text-muted-foreground font-mono uppercase text-[10px] tracking-wider">
									<TableHead className="py-3 px-4 font-semibold">
										Timestamp (UTC)
									</TableHead>
									<TableHead className="py-3 px-4 font-semibold">
										Category
									</TableHead>
									<TableHead className="py-3 px-4 font-semibold">
										Log Event / Title
									</TableHead>
									<TableHead className="py-3 px-4 font-semibold text-right">
										Inspect
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody className="divide-y divide-border/40">
								{logs.map((logItem) => {
									const rawJson =
										typeof logItem.data === "string"
											? JSON.parse(logItem.data)
											: logItem.data;
									const details = (
										rawJson as { details?: Record<string, unknown> }
									)?.details;

									return (
										<TableRow
											key={logItem.id}
											className="hover:bg-accent/30 transition-colors group cursor-default"
										>
											{/* Timestamp */}
											<TableCell className="py-3 px-4 font-mono text-[11px] whitespace-nowrap">
												<span className="font-semibold text-foreground">
													{formatRelativeTime(logItem.timestamp)}
												</span>
												<span className="text-[10px] text-muted-foreground block">
													{formatDate(logItem.timestamp)}
												</span>
											</TableCell>

											{/* Category */}
											<TableCell className="py-3 px-4 whitespace-nowrap">
												<Badge
													variant="secondary"
													className="text-[9px] px-2 py-0.5"
												>
													{logItem.category || "General"}
												</Badge>
											</TableCell>

											{/* Title / Action */}
											<TableCell className="py-3 px-4 max-w-md font-medium text-foreground">
												<div className="font-semibold text-xs text-foreground group-hover:text-primary transition-colors truncate">
													{logItem.title ||
														(details?.title as string) ||
														`Log #${logItem.log}`}
												</div>
												<span className="font-mono text-[10px] text-muted-foreground block">
													ID: {logItem.id} • Type Code: #{logItem.log}
												</span>
											</TableCell>

											{/* Actions */}
											<TableCell className="py-3 px-4 text-right whitespace-nowrap">
												<Button
													variant="outline"
													size="sm"
													onClick={() => setInspectLog(logItem)}
													className="rounded-xl text-[11px] h-7 px-2.5 cursor-pointer border-border/60 hover:border-primary/40 hover:text-primary gap-1"
												>
													<Terminal className="size-3" /> Inspect JSON
												</Button>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>

				{/* Pagination Footer */}
				<div className="p-4 border-t border-border/40 flex items-center justify-between text-xs font-mono text-muted-foreground bg-card/40">
					<div>
						Page <strong className="text-foreground">{page}</strong> of{" "}
						<strong className="text-foreground">{totalPages}</strong> (
						{totalLogsCount.toLocaleString()} total entries)
					</div>
					<div className="flex items-center gap-1.5">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								const next = Math.max(1, page - 1);
								setPage(next);
								fetchLogs(next);
							}}
							disabled={page <= 1 || isLoadingLogs}
							className="rounded-xl size-7 p-0 cursor-pointer"
						>
							<ChevronLeft className="size-3.5" />
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								const next = Math.min(totalPages, page + 1);
								setPage(next);
								fetchLogs(next);
							}}
							disabled={page >= totalPages || isLoadingLogs}
							className="rounded-xl size-7 p-0 cursor-pointer"
						>
							<ChevronRight className="size-3.5" />
						</Button>
					</div>
				</div>
			</Card>

			{/* Inspect JSON Modal */}
			<Dialog
				open={inspectLog !== null}
				onOpenChange={(open) => {
					if (!open) setInspectLog(null);
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="max-w-2xl sm:max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border-primary/30 shadow-2xl bg-card/95 backdrop-blur-2xl p-0 gap-0"
				>
					<CardHeader className="p-4 sm:p-5 border-b border-border/60 flex flex-row items-center justify-between shrink-0">
						<div className="space-y-0.5">
							<DialogTitle className="text-sm font-bold flex items-center gap-2">
								<Terminal className="size-4 text-primary" />
								Log Entry Inspector
							</DialogTitle>
							<DialogDescription className="text-xs font-mono">
								{inspectLog?.title || `Log ID ${inspectLog?.id}`} •{" "}
								{inspectLog?.category}
							</DialogDescription>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setInspectLog(null)}
							className="size-7 p-0 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<X className="size-4" />
						</Button>
					</CardHeader>

					<CardContent className="p-4 overflow-y-auto flex-1 font-mono text-xs space-y-3">
						<div className="grid grid-cols-2 gap-2 text-[11px] p-3 rounded-xl bg-background/50 border border-border/60">
							<div>
								<span className="text-muted-foreground">Log ID:</span>{" "}
								<span className="text-foreground font-bold">
									{inspectLog?.id}
								</span>
							</div>
							<div>
								<span className="text-muted-foreground">Type Code:</span>{" "}
								<span className="text-foreground font-bold">
									{inspectLog?.log}
								</span>
							</div>
							<div>
								<span className="text-muted-foreground">Timestamp:</span>{" "}
								<span className="text-foreground">
									{inspectLog && formatDate(inspectLog.timestamp)}
								</span>
							</div>
							<div>
								<span className="text-muted-foreground">Category:</span>{" "}
								<span className="text-foreground font-bold">
									{inspectLog?.category || "General"}
								</span>
							</div>
						</div>

						<div className="space-y-1">
							<div className="flex items-center justify-between text-[11px] text-muted-foreground">
								<span>Raw Payload Data:</span>
								<Button
									variant="ghost"
									size="xs"
									onClick={() => inspectLog && handleCopyJson(inspectLog.data)}
									className="h-6 px-2 text-[11px] text-primary hover:text-primary/80 cursor-pointer flex items-center gap-1"
								>
									<Copy className="size-3" />
									{copyFeedback ? "Copied!" : "Copy JSON"}
								</Button>
							</div>
							<pre className="p-3 rounded-xl bg-black/60 border border-border/60 text-emerald-400 overflow-x-auto text-[11px] leading-relaxed max-h-75">
								{inspectLog &&
									(typeof inspectLog.data === "string"
										? JSON.stringify(JSON.parse(inspectLog.data), null, 2)
										: JSON.stringify(inspectLog.data, null, 2))}
							</pre>
						</div>
					</CardContent>

					<div className="p-4 border-t border-border/60 flex justify-end shrink-0">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setInspectLog(null)}
							className="rounded-xl text-xs cursor-pointer"
						>
							Close Inspector
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* Range Resync Modal */}
			<Dialog open={showManualResync} onOpenChange={setShowManualResync}>
				<DialogContent
					showCloseButton={false}
					className="max-w-md sm:max-w-md rounded-2xl border-primary/30 shadow-2xl bg-card/95 backdrop-blur-2xl p-0 gap-0"
				>
					<CardHeader className="p-5 border-b border-border/60 flex flex-row items-center justify-between">
						<div className="space-y-1">
							<DialogTitle className="text-sm font-bold flex items-center gap-2">
								<History className="size-4 text-primary" />
								Manual Date Range Resync
							</DialogTitle>
							<DialogDescription className="text-xs">
								Fetch missing or repair historical personal logs in a specific
								slice
							</DialogDescription>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowManualResync(false)}
							className="size-7 p-0 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<X className="size-4" />
						</Button>
					</CardHeader>

					<CardContent className="p-5 space-y-4 text-xs font-mono">
						<div className="space-y-1.5">
							<label
								htmlFor="resync-from"
								className="text-[11px] font-medium text-foreground"
							>
								From Date (UTC):
							</label>
							<Input
								id="resync-from"
								type="datetime-local"
								value={resyncFrom}
								onChange={(e) => setResyncFrom(e.target.value)}
								className="rounded-xl bg-background/50 border-border/80"
							/>
						</div>

						<div className="space-y-1.5">
							<label
								htmlFor="resync-to"
								className="text-[11px] font-medium text-foreground"
							>
								To Date (UTC):
							</label>
							<Input
								id="resync-to"
								type="datetime-local"
								value={resyncTo}
								onChange={(e) => setResyncTo(e.target.value)}
								className="rounded-xl bg-background/50 border-border/80"
							/>
						</div>

						<p className="text-[11px] text-muted-foreground leading-relaxed">
							This triggers an on-demand pagination cycle using your personal
							Torn API key and writes logs to SQLite.
						</p>
					</CardContent>

					<DialogFooter className="p-4 border-t border-border/60 flex-row items-center justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowManualResync(false)}
							className="rounded-xl text-xs cursor-pointer"
						>
							Cancel
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={handleExecuteResync}
							disabled={isResyncing || !resyncFrom || !resyncTo}
							className="rounded-xl text-xs cursor-pointer gap-1.5"
						>
							{isResyncing ? (
								<>
									<Loader2 className="size-3.5 animate-spin" /> Syncing...
								</>
							) : (
								<>
									<Zap className="size-3.5" /> Start Resync
								</>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Reset State Confirmation Modal */}
			<Dialog
				open={showResetModal}
				onOpenChange={(open) => {
					if (!open) {
						setShowResetModal(false);
						setResetError(null);
					}
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="max-w-md sm:max-w-md rounded-2xl border-destructive/30 shadow-2xl bg-card/95 backdrop-blur-2xl p-0 gap-0"
				>
					<CardHeader className="p-5 border-b border-border/60 flex flex-row items-center justify-between">
						<div className="space-y-1">
							<DialogTitle className="text-sm font-bold flex items-center gap-2 text-destructive">
								<RotateCcw className="size-4" />
								Reset Log Manager State
							</DialogTitle>
							<DialogDescription className="text-xs">
								Restart backfill scan from now and re-parse log history
							</DialogDescription>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setShowResetModal(false);
								setResetError(null);
							}}
							className="size-7 p-0 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<X className="size-4" />
						</Button>
					</CardHeader>

					<CardContent className="p-5 space-y-3 text-xs leading-relaxed">
						<div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-foreground space-y-1.5">
							<div className="font-semibold flex items-center gap-1.5 text-destructive">
								<AlertTriangle className="size-4 shrink-0" />
								Confirm Backfill Reset
							</div>
							<p className="text-muted-foreground text-[11px]">
								This action flips the backfill status back to{" "}
								<strong className="text-foreground">in_progress</strong> and
								sets the backfill cursor to{" "}
								<strong className="text-foreground">now</strong>. The scheduler
								will paginate backward from the present across all history to
								re-scan and insert any missed log entries.
							</p>
						</div>

						<p className="text-muted-foreground text-[11px]">
							Existing log records in your database will{" "}
							<strong className="text-foreground">not</strong> be deleted.
						</p>

						{resetError && (
							<div className="p-3 rounded-xl bg-destructive/15 border border-destructive/30 text-destructive text-xs flex items-start gap-2">
								<AlertCircle className="size-4 shrink-0 mt-0.5" />
								<span>{resetError}</span>
							</div>
						)}
					</CardContent>

					<DialogFooter className="p-4 border-t border-border/60 flex-row items-center justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setShowResetModal(false);
								setResetError(null);
							}}
							disabled={isResetting}
							className="rounded-xl text-xs cursor-pointer"
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={handleResetState}
							disabled={isResetting}
							className="rounded-xl text-xs cursor-pointer gap-1.5"
						>
							{isResetting ? (
								<>
									<Loader2 className="size-3.5 animate-spin" /> Resetting...
								</>
							) : (
								<>
									<RotateCcw className="size-3.5" /> Confirm Reset
								</>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
