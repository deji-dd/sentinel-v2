import { format } from "date-fns";
import {
	AlertCircle,
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	BarChart3,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Coins,
	Copy,
	Eye,
	Loader2,
	RefreshCw,
	Search,
	Sparkles,
	TrendingUp,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
} from "@/components/ui/chart";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
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

export interface CrimeLedgerState {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedCrimes: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totalInDb: number;
	totalNerveSpent: number;
	totalLootValue: number;
	distinctCrimesCount: number;
	totalPersonalLogsCrimes: number;
	dbOldestDate: string | null;
	dbNewestDate: string | null;
	topProfitCategory?: CrimeCategoryAnalytics | null;
	topEfficientCategory?: CrimeCategoryAnalytics | null;
	allTimeCategories?: CrimeCategoryAnalytics[];
}

export interface CrimeLogItem {
	id: string;
	crimeId: number;
	crimeName: string;
	action: string;
	nerve: number;
	value: number;
	timestamp: string | number;
	createdAt: string | number;
}

export interface CrimeCategoryAnalytics {
	crimeId: number;
	crimeName: string;
	count: number;
	nerve: number;
	value: number;
	efficiency: number;
	percentage: number;
}

export interface DailyCrimeTimeline {
	date: string;
	count: number;
	nerve: number;
	value: number;
	efficiency: number;
}

export interface HourlyDistribution {
	hour: number;
	count: number;
	nerve: number;
}

export interface TopLootEvent {
	id: string;
	action: string;
	crimeId: number;
	crimeName: string;
	nerve: number;
	value: number;
	timestamp: string | number;
}

export interface CrimeDefinition {
	id: number;
	name: string;
	data?: Record<string, unknown>;
}

const timelineChartConfig = {
	count: {
		label: "Volume",
		color: "#38bdf8",
	},
	nerve: {
		label: "Nerve",
		color: "#f59e0b",
	},
	value: {
		label: "Value",
		color: "#10b981",
	},
	efficiency: {
		label: "$/Nerve",
		color: "#a855f7",
	},
} satisfies ChartConfig;

function formatCurrency(amount: number): string {
	if (Math.abs(amount) >= 1_000_000_000) {
		return `$${(amount / 1_000_000_000).toFixed(2)}B`;
	}
	if (Math.abs(amount) >= 1_000_000) {
		return `$${(amount / 1_000_000).toFixed(2)}M`;
	}
	if (Math.abs(amount) >= 1_000) {
		return `$${(amount / 1_000).toFixed(1)}k`;
	}
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(amount);
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

export function CrimeLedgerPage() {
	const { path } = useRouter();
	const { setPageReady } = useGlobalLoading();
	// State
	const [state, setState] = useState<CrimeLedgerState | null>(null);
	const [allTimeCategories, setAllTimeCategories] = useState<
		CrimeCategoryAnalytics[]
	>([]);
	const [isReconciling, setIsReconciling] = useState(false);

	// Filters
	const [selectedRange, setSelectedRange] = useState<string>("30");
	const [customRange, setCustomRange] = useState<{
		from: string;
		to: string;
	} | null>(null);
	const [openPickerId, setOpenPickerId] = useState<string | null>(null);
	const [calendarRange, setCalendarRange] = useState<DateRange | undefined>(
		undefined,
	);
	const [selectedDate, setSelectedDate] = useState<string>("");
	const [selectedCrimeId, setSelectedCrimeId] = useState<string>("ALL");
	const [searchQuery, setSearchQuery] = useState<string>("");
	const [debouncedSearch, setDebouncedSearch] = useState<string>("");
	const [sortBy, setSortBy] = useState<string>("timestamp");
	const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

	// Pagination
	const [page, setPage] = useState<number>(1);
	const [limit, setLimit] = useState<number>(50);
	const [totalLogs, setTotalLogs] = useState<number>(0);
	const [totalPages, setTotalPages] = useState<number>(1);
	const [logs, setLogs] = useState<CrimeLogItem[]>([]);
	const [isLogsLoading, setIsLogsLoading] = useState(false);

	// Analytics
	const [analyticsLoading, setAnalyticsLoading] = useState(false);
	const [timeline, setTimeline] = useState<DailyCrimeTimeline[]>([]);
	const [topLootEvents, setTopLootEvents] = useState<TopLootEvent[]>([]);
	const [kpis, setKpis] = useState<{
		totalCrimes: number;
		totalNerve: number;
		totalValue: number;
		distinctCrimes: number;
		avgValuePerCrime: number;
		avgNervePerCrime: number;
		avgValuePerNerve: number;
	}>({
		totalCrimes: 0,
		totalNerve: 0,
		totalValue: 0,
		distinctCrimes: 0,
		avgValuePerCrime: 0,
		avgNervePerCrime: 0,
		avgValuePerNerve: 0,
	});

	// Definitions
	const [definitions, setDefinitions] = useState<CrimeDefinition[]>([]);

	// Category leader card mode: 'profit' | 'efficiency'
	const [leaderMetric, setLeaderMetric] = useState<"profit" | "efficiency">(
		"profit",
	);

	// Category matrix sort: 'id' | 'name' | 'volume' | 'profit' | 'efficiency' | 'nerve'
	const [categorySortBy, setCategorySortBy] = useState<
		"id" | "name" | "volume" | "profit" | "efficiency" | "nerve"
	>("volume");
	const [categorySortOrder, setCategorySortOrder] = useState<"asc" | "desc">(
		"desc",
	);

	const handleToggleCategorySort = (
		column: "id" | "name" | "volume" | "profit" | "efficiency" | "nerve",
	) => {
		if (categorySortBy === column) {
			setCategorySortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
		} else {
			setCategorySortBy(column);
			setCategorySortOrder(
				column === "name" || column === "id" ? "asc" : "desc",
			);
		}
	};

	const handleToggleLogSort = (column: string) => {
		if (sortBy === column) {
			setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(column);
			setSortOrder(
				column === "timestamp" || column === "value" || column === "nerve"
					? "desc"
					: "asc",
			);
		}
		setPage(1);
	};

	// Chart group mode: 'activity' (Volume & Nerve) | 'financials' (Value & ROI)
	const [chartGroup, setChartGroup] = useState<"activity" | "financials">(
		"activity",
	);

	// Log Inspector Modal
	const [selectedLogForDetail, setSelectedLogForDetail] =
		useState<CrimeLogItem | null>(null);
	const [copiedLogId, setCopiedLogId] = useState<string | null>(null);

	// Category Actions Inspector Modal
	const [inspectingCategory, setInspectingCategory] =
		useState<CrimeCategoryAnalytics | null>(null);
	const [categoryActions, setCategoryActions] = useState<
		{
			action: string;
			count: number;
			nerve: number;
			value: number;
			efficiency: number;
			percentage: number;
			lastTimestamp: number | null;
		}[]
	>([]);
	const [isLoadingActions, setIsLoadingActions] = useState(false);
	const [actionSearchQuery, setActionSearchQuery] = useState("");

	const handleInspectCategory = async (cat: CrimeCategoryAnalytics) => {
		setInspectingCategory(cat);
		setActionSearchQuery("");
		setIsLoadingActions(true);
		try {
			const res = await fetch(
				`/api/v1/system/crime-ledger/categories/${cat.crimeId}/actions`,
			);
			if (!res.ok) throw new Error("Failed to fetch actions");
			const data = (await res.json()) as {
				actions: {
					action: string;
					count: number;
					nerve: number;
					value: number;
					efficiency: number;
					percentage: number;
					lastTimestamp: number | null;
				}[];
			};
			setCategoryActions(data.actions ?? []);
		} catch (err) {
			console.error(err);
			toast.error("Failed to load classified actions for category");
		} finally {
			setIsLoadingActions(false);
		}
	};

	const filteredCategoryActions = useMemo(() => {
		if (!actionSearchQuery.trim()) return categoryActions;
		const q = actionSearchQuery.toLowerCase();
		return categoryActions.filter((a) => a.action.toLowerCase().includes(q));
	}, [categoryActions, actionSearchQuery]);

	// Handlers for Date Range
	const handleRangeChange = (range: string) => {
		setSelectedRange(range);
		setSelectedDate("");
		setCustomRange(null);
		setPage(1);
	};

	const handleDayClick = (dateStr?: string) => {
		if (!dateStr) return;
		setSelectedDate((prev) => (prev === dateStr ? "" : dateStr));
		setPage(1);
	};

	const handleOpenCustomPicker = (open: boolean, id: string) => {
		setOpenPickerId(open ? id : null);
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

	const handleApplyCustomRange = () => {
		if (!calendarRange?.from) return;
		const fromStr = format(calendarRange.from, "yyyy-MM-dd");
		const toStr = calendarRange.to
			? format(calendarRange.to, "yyyy-MM-dd")
			: fromStr;
		const range = { from: fromStr, to: toStr };
		setCustomRange(range);
		setSelectedRange("custom");
		setSelectedDate("");
		setOpenPickerId(null);
		setPage(1);
	};

	const renderDateRangeSelector = (id = "chart") => (
		<div className="flex items-center gap-1 bg-background/50 border border-border/70 p-1 rounded-xl">
			{[
				{ label: "1D", value: "1" },
				{ label: "1W", value: "7" },
				{ label: "1M", value: "30" },
				{ label: "All Time", value: "all" },
			].map((r) => (
				<Button
					key={r.value}
					variant={
						selectedRange === r.value && !selectedDate ? "default" : "ghost"
					}
					size="xs"
					onClick={() => handleRangeChange(r.value)}
					className={`h-7 px-2.5 text-xs font-mono rounded-lg transition-all cursor-pointer ${
						selectedRange === r.value && !selectedDate
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
				open={openPickerId === id}
				onOpenChange={(open) => handleOpenCustomPicker(open, id)}
			>
				<PopoverTrigger asChild>
					<Button
						variant={
							selectedRange === "custom" && !selectedDate ? "default" : "ghost"
						}
						size="xs"
						className={`h-7 flex items-center gap-1.5 px-2.5 text-xs font-mono rounded-lg transition-all cursor-pointer ${
							selectedRange === "custom" && !selectedDate
								? "font-semibold shadow-xs"
								: "text-muted-foreground hover:text-foreground hover:bg-accent/40"
						}`}
					>
						<CalendarDays className="size-3" />
						{selectedRange === "custom" && customRange
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
									setOpenPickerId(null);
								}}
							>
								Reset (1M)
							</Button>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									className="h-7 px-2.5 text-xs font-mono cursor-pointer"
									onClick={() => setOpenPickerId(null)}
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
	);

	// Debounce search input
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearch(searchQuery);
			setPage(1);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Fetch State
	const fetchState = useCallback(async () => {
		try {
			const res = await fetch("/api/v1/system/crime-ledger/state");
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch state`);
			}
			const data = (await res.json()) as CrimeLedgerState;
			setState(data);
			if (data.allTimeCategories?.length) {
				setAllTimeCategories(data.allTimeCategories);
			}
		} catch (error) {
			console.error("Failed to fetch crime ledger state:", error);
			toast.error("Failed to fetch crime ledger state", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}, []);

	// Fetch Definitions
	const fetchDefinitions = useCallback(async () => {
		try {
			const res = await fetch("/api/v1/system/crime-ledger/definitions");
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch definitions`);
			}
			const data = (await res.json()) as { definitions: CrimeDefinition[] };
			setDefinitions(data.definitions ?? []);
		} catch (error) {
			console.error("Failed to fetch definitions:", error);
			toast.error("Failed to fetch crime definitions", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}, []);

	// Fetch Analytics (always reflects current graph range)
	const fetchAnalytics = useCallback(async () => {
		setAnalyticsLoading(true);
		try {
			const params = new URLSearchParams();
			if (selectedRange === "custom" && customRange) {
				params.set("from", customRange.from);
				params.set("to", customRange.to);
			} else if (selectedRange !== "all") {
				params.set("days", selectedRange);
			}
			const res = await fetch(
				`/api/v1/system/crime-ledger/analytics?${params.toString()}`,
			);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch analytics`);
			}
			const data = (await res.json()) as {
				kpis: typeof kpis;
				timeline: DailyCrimeTimeline[];
				categories: CrimeCategoryAnalytics[];
				topLootEvents: TopLootEvent[];
			};
			setKpis(data.kpis);
			setTimeline(data.timeline ?? []);
			setTopLootEvents(data.topLootEvents ?? []);
		} catch (error) {
			console.error("Failed to fetch analytics:", error);
			toast.error("Failed to fetch crime analytics", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setAnalyticsLoading(false);
		}
	}, [selectedRange, customRange]);

	// Fetch Logs Table
	const fetchLogs = useCallback(async () => {
		setIsLogsLoading(true);
		try {
			const params = new URLSearchParams();
			params.set("page", String(page));
			params.set("limit", String(limit));
			if (selectedDate) {
				params.set("date", selectedDate);
			} else if (selectedRange === "custom" && customRange) {
				params.set("from", customRange.from);
				params.set("to", customRange.to);
			} else if (selectedRange !== "all") {
				params.set("days", selectedRange);
			}
			if (selectedCrimeId !== "ALL") {
				params.set("crimeId", selectedCrimeId);
			}
			if (debouncedSearch) {
				params.set("search", debouncedSearch);
			}
			params.set("sortBy", sortBy);
			params.set("sortOrder", sortOrder);

			const res = await fetch(
				`/api/v1/system/crime-ledger/logs?${params.toString()}`,
			);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: Failed to fetch logs`);
			}
			const data = (await res.json()) as {
				logs: CrimeLogItem[];
				total: number;
				totalPages: number;
			};
			setLogs(data.logs ?? []);
			setTotalLogs(data.total ?? 0);
			setTotalPages(data.totalPages ?? 1);
		} catch (error) {
			console.error("Failed to fetch crime logs:", error);
			toast.error("Failed to fetch crime logs", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsLogsLoading(false);
		}
	}, [
		page,
		limit,
		selectedDate,
		selectedRange,
		customRange,
		selectedCrimeId,
		debouncedSearch,
		sortBy,
		sortOrder,
	]);

	// Trigger analytics fetch when analytics filters change
	useEffect(() => {
		fetchAnalytics();
	}, [fetchAnalytics]);

	// Trigger logs fetch when log table filters change
	useEffect(() => {
		fetchLogs();
	}, [fetchLogs]);

	// Stabilize fetch refs for WebSocket callbacks
	const fetchStateRef = useRef(fetchState);
	fetchStateRef.current = fetchState;
	const fetchAnalyticsRef = useRef(fetchAnalytics);
	fetchAnalyticsRef.current = fetchAnalytics;
	const fetchLogsRef = useRef(fetchLogs);
	fetchLogsRef.current = fetchLogs;

	// Initial metadata fetch & WebSocket connection for live telemetry
	useEffect(() => {
		Promise.allSettled([
			fetchState(),
			fetchDefinitions(),
			fetchAnalytics(),
			fetchLogs(),
		]).finally(() => {
			setPageReady(path);
		});

		let ws: WebSocket | null = null;
		let pingInterval: ReturnType<typeof setInterval> | null = null;
		let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
		let isUnmounted = false;

		function cleanupWs() {
			if (pingInterval) {
				clearInterval(pingInterval);
				pingInterval = null;
			}
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = null;
			}
			if (ws) {
				ws.onopen = null;
				ws.onmessage = null;
				ws.onerror = null;
				ws.onclose = null;
				if (
					ws.readyState === WebSocket.OPEN ||
					ws.readyState === WebSocket.CONNECTING
				) {
					ws.close();
				}
				ws = null;
			}
		}

		function connect() {
			if (isUnmounted) return;
			cleanupWs();

			try {
				const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
				const wsUrl = `${protocol}//${window.location.host}/api/ws/crime-ledger`;
				ws = new WebSocket(wsUrl);

				ws.onopen = () => {
					pingInterval = setInterval(() => {
						if (ws?.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ type: "ping" }));
						}
					}, 30000);
				};

				ws.onmessage = (evt) => {
					try {
						const data = JSON.parse(evt.data);
						if (
							(data.type === "state_update" ||
								data.type === "state_snapshot") &&
							data.state
						) {
							const newState = data.state as Partial<CrimeLedgerState>;
							if (newState.allTimeCategories?.length) {
								setAllTimeCategories(newState.allTimeCategories);
							}
							setState((prev) => {
								const merged: CrimeLedgerState = {
									status: newState.status ?? prev?.status ?? "idle",
									totalIndexedCrimes:
										newState.totalIndexedCrimes ??
										prev?.totalIndexedCrimes ??
										0,
									lastProcessedTimestamp:
										newState.lastProcessedTimestamp ??
										prev?.lastProcessedTimestamp ??
										null,
									lastError: newState.lastError ?? prev?.lastError ?? null,
									updatedAt:
										newState.updatedAt ??
										prev?.updatedAt ??
										new Date().toISOString(),
									totalInDb: newState.totalInDb ?? prev?.totalInDb ?? 0,
									totalNerveSpent:
										newState.totalNerveSpent ?? prev?.totalNerveSpent ?? 0,
									totalLootValue:
										newState.totalLootValue ?? prev?.totalLootValue ?? 0,
									distinctCrimesCount:
										newState.distinctCrimesCount ??
										prev?.distinctCrimesCount ??
										0,
									totalPersonalLogsCrimes:
										newState.totalPersonalLogsCrimes ??
										prev?.totalPersonalLogsCrimes ??
										0,
									dbOldestDate:
										newState.dbOldestDate ?? prev?.dbOldestDate ?? null,
									dbNewestDate:
										newState.dbNewestDate ?? prev?.dbNewestDate ?? null,
									topProfitCategory:
										newState.topProfitCategory ??
										prev?.topProfitCategory ??
										null,
									topEfficientCategory:
										newState.topEfficientCategory ??
										prev?.topEfficientCategory ??
										null,
									allTimeCategories:
										newState.allTimeCategories ?? prev?.allTimeCategories ?? [],
								};

								if (
									prev?.status === "running" &&
									newState.status === "completed"
								) {
									toast.success("Ledger re-initialization complete", {
										description: `Successfully indexed ${merged.totalIndexedCrimes.toLocaleString()} crime events.`,
									});
									fetchStateRef.current();
									fetchAnalyticsRef.current();
									fetchLogsRef.current();
									setIsReconciling(false);
								} else if (
									prev?.status === "running" &&
									newState.status === "error"
								) {
									toast.error("Ledger re-initialization failed", {
										description:
											newState.lastError ??
											"An unexpected error occurred during processing.",
									});
									setIsReconciling(false);
								}
								return merged;
							});
						}
					} catch (err) {
						console.error("Failed to parse crime ledger WS message:", err);
					}
				};

				ws.onerror = () => {
					// Silent error handler; onclose will schedule reconnect
				};

				ws.onclose = () => {
					if (pingInterval) {
						clearInterval(pingInterval);
						pingInterval = null;
					}
					if (!isUnmounted) {
						reconnectTimeout = setTimeout(connect, 5000);
					}
				};
			} catch {
				if (!isUnmounted) {
					reconnectTimeout = setTimeout(connect, 5000);
				}
			}
		}

		connect();

		return () => {
			isUnmounted = true;
			cleanupWs();
		};
	}, [fetchState, fetchDefinitions]);

	// Handle manual re-initialization trigger
	const handleReconcile = async () => {
		setIsReconciling(true);
		try {
			const res = await fetch("/api/v1/system/crime-ledger/reconcile", {
				method: "POST",
			});
			if (res.ok) {
				toast.success("Ledger re-initialization initiated", {
					description:
						"The scheduler worker is wiping crime logs and regenerating the ledger in the background.",
				});
				await fetchState();
				await fetchAnalytics();
				await fetchLogs();
			} else {
				const errMsg = "Re-initialization failed. Please inspect server logs.";
				toast.error("Re-initialization failed", { description: errMsg });
			}
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			toast.error("Re-initialization error", { description: errMsg });
		} finally {
			setIsReconciling(false);
		}
	};

	const handleCopy = (text: string, id: string) => {
		navigator.clipboard.writeText(text);
		setCopiedLogId(id);
		toast.success("Copied to clipboard");
		setTimeout(() => setCopiedLogId(null), 2000);
	};

	// All-time Most Profitable Category (Highest Gross Dollar Return)
	const topProfitCategory = useMemo(() => {
		if (state?.topProfitCategory) return state.topProfitCategory;
		if (allTimeCategories.length) {
			return (
				[...allTimeCategories].sort((a, b) => b.value - a.value)[0] ?? null
			);
		}
		return null;
	}, [state?.topProfitCategory, allTimeCategories]);

	// All-time Most Efficient Category (Highest $/Nerve ROI)
	const topEfficientCategory = useMemo(() => {
		if (state?.topEfficientCategory) return state.topEfficientCategory;
		if (allTimeCategories.length) {
			const valid = allTimeCategories.filter(
				(c) => c.nerve > 0 && c.efficiency > 0,
			);
			return (
				[...(valid.length > 0 ? valid : allTimeCategories)].sort(
					(a, b) => b.efficiency - a.efficiency,
				)[0] ?? null
			);
		}
		return null;
	}, [state?.topEfficientCategory, allTimeCategories]);

	// Active category displayed in leadership card
	const activeLeaderCategory =
		leaderMetric === "profit" ? topProfitCategory : topEfficientCategory;

	// Sorted categories for the Category Yield Matrix (Always All-Time Statistics)
	const sortedCategories = useMemo(() => {
		return [...allTimeCategories].sort((a, b) => {
			let cmp = 0;
			if (categorySortBy === "id") cmp = a.crimeId - b.crimeId;
			else if (categorySortBy === "name")
				cmp = a.crimeName.localeCompare(b.crimeName);
			else if (categorySortBy === "profit") cmp = a.value - b.value;
			else if (categorySortBy === "efficiency")
				cmp = a.efficiency - b.efficiency;
			else if (categorySortBy === "nerve") cmp = a.nerve - b.nerve;
			else cmp = a.count - b.count; // default "volume"

			return categorySortOrder === "asc" ? cmp : -cmp;
		});
	}, [allTimeCategories, categorySortBy, categorySortOrder]);

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6 lg:p-8 max-w-7xl mx-auto w-full text-foreground">
			{/* 1. Header & Live Telemetry Controls */}
			<div className="flex flex-col md:flex-row items-start md:items-center justify-end gap-4 border-b border-border/70 pb-5">
				<div className="flex flex-wrap items-center gap-2.5 self-stretch md:self-auto">
					{/* Re-initialize / Sync Button */}
					<Button
						variant="outline"
						size="sm"
						onClick={handleReconcile}
						disabled={isReconciling || state?.status === "running"}
						className="rounded-xl text-xs gap-1.5 border-border/80 bg-card/60 hover:bg-accent cursor-pointer shadow-xs"
					>
						<RefreshCw
							className={`size-3.5 ${isReconciling || state?.status === "running" ? "animate-spin text-primary" : "text-muted-foreground"}`}
						/>
						<span>
							{isReconciling || state?.status === "running"
								? "Re-initializing..."
								: "Re-initialize Ledger"}
						</span>
					</Button>
				</div>
			</div>

			{/* 2. KPI Metric Cards (All-Time Ledger Telemetry) */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				{/* Total Nerve Expended */}
				<Card className="transition-all duration-300 relative overflow-hidden group">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
						<Zap className="size-16 text-amber-400" />
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
							<span>Nerve Expended</span>
							<Zap className="size-3.5 text-amber-400" />
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-amber-400">
							{(state?.totalNerveSpent ?? 0).toLocaleString()}
						</CardTitle>
					</CardHeader>
					<CardContent className="pt-0 text-[11px] text-muted-foreground flex items-center gap-1.5">
						<span>Avg</span>
						<span className="font-mono font-semibold text-foreground">
							{state && state.totalInDb > 0
								? (state.totalNerveSpent / state.totalInDb).toFixed(2)
								: "0.00"}{" "}
							N / crime
						</span>
					</CardContent>
				</Card>

				{/* Total Loot Value ($) */}
				<Card className="transition-all duration-300 relative overflow-hidden group">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
						<Coins className="size-16 text-emerald-400" />
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
							<span>Total Value</span>
							<TrendingUp className="size-3.5 text-emerald-400" />
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-emerald-400">
							{formatCurrency(state?.totalLootValue ?? 0)}
						</CardTitle>
					</CardHeader>
					<CardContent className="pt-0 text-[11px] text-muted-foreground flex items-center gap-1.5">
						<span>Avg</span>
						<span className="font-mono font-semibold text-foreground">
							{formatCurrency(
								state && state.totalInDb > 0
									? state.totalLootValue / state.totalInDb
									: 0,
							)}{" "}
							/ crime
						</span>
					</CardContent>
				</Card>

				{/* Nerve ROI ($/Nerve) */}
				<Card className="transition-all duration-300 relative overflow-hidden group border-primary/30 shadow-[0_0_20px_rgba(56,189,248,0.1)]">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
						<BarChart3 className="size-16 text-primary" />
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="font-mono text-[11px] uppercase tracking-wider text-primary flex items-center justify-between">
							<span>Efficiency</span>
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-primary">
							{formatCurrency(
								state && state.totalNerveSpent > 0
									? state.totalLootValue / state.totalNerveSpent
									: 0,
							)}
							<span className="text-xs font-normal text-muted-foreground ml-1">
								/ N
							</span>
						</CardTitle>
					</CardHeader>
				</Card>

				{/* All-Time Sector Leader (Toggleable: Top Profit vs Top ROI) */}
				<Card className="transition-all duration-300 relative overflow-hidden group">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity pointer-events-none">
						<Sparkles
							className={`size-16 ${
								leaderMetric === "profit"
									? "text-emerald-400"
									: "text-violet-400"
							}`}
						/>
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
							<span>{leaderMetric === "profit" ? "Top Gross" : "Top ROI"}</span>
							{/* Metric Toggle Buttons */}
							<div className="flex items-center gap-1 bg-muted/60 p-0.5 rounded-lg border border-border/50">
								<Button
									variant="ghost"
									size="xs"
									onClick={() => setLeaderMetric("profit")}
									className={`h-5 px-1.5 text-[10px] rounded-md font-mono transition-colors cursor-pointer ${
										leaderMetric === "profit"
											? "bg-emerald-500 text-white font-semibold shadow-xs hover:bg-emerald-600 hover:text-white"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									Profit
								</Button>
								<Button
									variant="ghost"
									size="xs"
									onClick={() => setLeaderMetric("efficiency")}
									className={`h-5 px-1.5 text-[10px] rounded-md font-mono transition-colors cursor-pointer ${
										leaderMetric === "efficiency"
											? "bg-violet-500 text-white font-semibold shadow-xs hover:bg-violet-600 hover:text-white"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									ROI
								</Button>
							</div>
						</CardDescription>

						<CardTitle
							className="text-lg font-bold font-display tracking-tight text-foreground truncate"
							title={activeLeaderCategory?.crimeName ?? "None"}
						>
							{activeLeaderCategory?.crimeName ?? "None"}
						</CardTitle>
					</CardHeader>

					<CardContent className="pt-0 text-[11px] text-muted-foreground flex flex-col gap-1.5">
						<div className="flex items-center justify-between">
							<span
								className={`font-mono font-medium ${
									leaderMetric === "profit"
										? "text-emerald-400"
										: "text-violet-400"
								}`}
							>
								{activeLeaderCategory
									? leaderMetric === "profit"
										? formatCurrency(activeLeaderCategory.value)
										: `${formatCurrency(activeLeaderCategory.efficiency)}/N`
									: "$0"}
							</span>
							<span className="font-mono text-[10px] text-muted-foreground">
								{activeLeaderCategory?.count.toLocaleString() ?? 0} runs
							</span>
						</div>

						{/* Quick Swap Hint */}
						{leaderMetric === "profit" && topEfficientCategory && (
							<Button
								variant="ghost"
								onClick={() => setLeaderMetric("efficiency")}
								className="h-auto p-0 pt-1 w-full text-[10px] text-muted-foreground hover:text-violet-400 font-mono flex items-center justify-between border-t border-border/40 transition-colors cursor-pointer text-left rounded-none hover:bg-transparent"
								title="Switch to Most Efficient view"
							>
								<span className="truncate">
									ROI: {topEfficientCategory.crimeName}
								</span>
								<span className="font-semibold text-violet-400 shrink-0 ml-1">
									{formatCurrency(topEfficientCategory.efficiency)}/N
								</span>
							</Button>
						)}
						{leaderMetric === "efficiency" && topProfitCategory && (
							<Button
								variant="ghost"
								onClick={() => setLeaderMetric("profit")}
								className="h-auto p-0 pt-1 w-full text-[10px] text-muted-foreground hover:text-emerald-400 font-mono flex items-center justify-between border-t border-border/40 transition-colors cursor-pointer text-left rounded-none hover:bg-transparent"
								title="Switch to Top Gross Profit view"
							>
								<span className="truncate">
									Gross: {topProfitCategory.crimeName}
								</span>
								<span className="font-semibold text-emerald-400 shrink-0 ml-1">
									{formatCurrency(topProfitCategory.value)}
								</span>
							</Button>
						)}
					</CardContent>
				</Card>
			</div>

			{/* 3. Category Breakdown & Yield ROI Matrix (All-Time Telemetry) */}
			<Card>
				<CardHeader className="pb-3 border-b border-border/60 flex flex-row items-center justify-between">
					<CardTitle className="text-base font-semibold font-display flex items-center gap-2">
						<span>Crime Yield Matrix</span>
					</CardTitle>
				</CardHeader>

				<CardContent className="p-0">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent border-b border-border/40">
								<TableHead className="w-[80px] pl-4">
									<button
										type="button"
										onClick={() => handleToggleCategorySort("id")}
										className={`flex items-center gap-1 font-mono text-xs cursor-pointer select-none transition-colors hover:text-foreground ${
											categorySortBy === "id"
												? "text-foreground font-bold"
												: "text-muted-foreground"
										}`}
									>
										<span>ID</span>
										{categorySortBy === "id" ? (
											categorySortOrder === "asc" ? (
												<ArrowUp className="size-3 text-primary" />
											) : (
												<ArrowDown className="size-3 text-primary" />
											)
										) : (
											<ArrowUpDown className="size-3 opacity-30" />
										)}
									</button>
								</TableHead>
								<TableHead>
									<button
										type="button"
										onClick={() => handleToggleCategorySort("name")}
										className={`flex items-center gap-1 font-mono text-xs cursor-pointer select-none transition-colors hover:text-foreground ${
											categorySortBy === "name"
												? "text-foreground font-bold"
												: "text-muted-foreground"
										}`}
									>
										<span>Category</span>
										{categorySortBy === "name" ? (
											categorySortOrder === "asc" ? (
												<ArrowUp className="size-3 text-primary" />
											) : (
												<ArrowDown className="size-3 text-primary" />
											)
										) : (
											<ArrowUpDown className="size-3 opacity-30" />
										)}
									</button>
								</TableHead>
								<TableHead className="text-right">
									<button
										type="button"
										onClick={() => handleToggleCategorySort("volume")}
										className={`ml-auto flex items-center gap-1 font-mono text-xs cursor-pointer select-none transition-colors hover:text-foreground ${
											categorySortBy === "volume"
												? "text-foreground font-bold"
												: "text-muted-foreground"
										}`}
									>
										<span>Crimes</span>
										{categorySortBy === "volume" ? (
											categorySortOrder === "asc" ? (
												<ArrowUp className="size-3 text-primary" />
											) : (
												<ArrowDown className="size-3 text-primary" />
											)
										) : (
											<ArrowUpDown className="size-3 opacity-30" />
										)}
									</button>
								</TableHead>
								<TableHead className="text-right font-mono text-xs text-muted-foreground">
									Share
								</TableHead>
								<TableHead className="text-right">
									<button
										type="button"
										onClick={() => handleToggleCategorySort("nerve")}
										className={`ml-auto flex items-center gap-1 font-mono text-xs cursor-pointer select-none transition-colors hover:text-foreground ${
											categorySortBy === "nerve"
												? "text-foreground font-bold"
												: "text-muted-foreground"
										}`}
									>
										<span>Nerve</span>
										{categorySortBy === "nerve" ? (
											categorySortOrder === "asc" ? (
												<ArrowUp className="size-3 text-primary" />
											) : (
												<ArrowDown className="size-3 text-primary" />
											)
										) : (
											<ArrowUpDown className="size-3 opacity-30" />
										)}
									</button>
								</TableHead>
								<TableHead className="text-right">
									<button
										type="button"
										onClick={() => handleToggleCategorySort("profit")}
										className={`ml-auto flex items-center gap-1 font-mono text-xs cursor-pointer select-none transition-colors hover:text-foreground ${
											categorySortBy === "profit"
												? "text-foreground font-bold"
												: "text-muted-foreground"
										}`}
									>
										<span>Gross Value ($)</span>
										{categorySortBy === "profit" ? (
											categorySortOrder === "asc" ? (
												<ArrowUp className="size-3 text-primary" />
											) : (
												<ArrowDown className="size-3 text-primary" />
											)
										) : (
											<ArrowUpDown className="size-3 opacity-30" />
										)}
									</button>
								</TableHead>
								<TableHead className="text-right">
									<button
										type="button"
										onClick={() => handleToggleCategorySort("efficiency")}
										className={`ml-auto flex items-center gap-1 font-mono text-xs cursor-pointer select-none transition-colors hover:text-foreground ${
											categorySortBy === "efficiency"
												? "text-foreground font-bold"
												: "text-muted-foreground"
										}`}
									>
										<span>ROI ($/N)</span>
										{categorySortBy === "efficiency" ? (
											categorySortOrder === "asc" ? (
												<ArrowUp className="size-3 text-primary" />
											) : (
												<ArrowDown className="size-3 text-primary" />
											)
										) : (
											<ArrowUpDown className="size-3 opacity-30" />
										)}
									</button>
								</TableHead>
								<TableHead className="w-[100px] text-right font-mono text-xs pr-4 text-muted-foreground">
									Actions
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{sortedCategories.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={8}
										className="h-24 text-center text-muted-foreground text-xs font-mono"
									>
										No crime categories available in all-time database index.
									</TableCell>
								</TableRow>
							) : (
								sortedCategories.map((cat) => (
									<TableRow
										key={cat.crimeId}
										onClick={() => handleInspectCategory(cat)}
										className="cursor-pointer hover:bg-accent/40 transition-colors group"
									>
										<TableCell className="font-mono text-xs py-3 pl-4 text-muted-foreground">
											#{cat.crimeId}
										</TableCell>
										<TableCell className="font-semibold text-xs py-3 text-foreground group-hover:text-primary transition-colors">
											{cat.crimeName}
										</TableCell>
										<TableCell className="text-right font-mono font-medium text-xs py-3">
											{cat.count.toLocaleString()}
										</TableCell>
										<TableCell className="text-right font-mono text-xs text-muted-foreground py-3">
											{cat.percentage}%
										</TableCell>
										<TableCell className="text-right font-mono text-amber-400 text-xs py-3">
											{cat.nerve.toLocaleString()} N
										</TableCell>
										<TableCell className="text-right font-mono font-bold text-emerald-400 text-xs py-3">
											{formatCurrency(cat.value)}
										</TableCell>
										<TableCell className="text-right font-mono font-medium text-violet-400 text-xs py-3">
											{formatCurrency(cat.efficiency)}/N
										</TableCell>
										<TableCell className="text-right py-3 pr-4">
											<Button
												variant="outline"
												size="xs"
												onClick={(e) => {
													e.stopPropagation();
													handleInspectCategory(cat);
												}}
												className="h-7 px-2.5 text-[11px] font-mono rounded-lg gap-1 border-border/70 group-hover:border-primary/50 group-hover:bg-primary/10 transition-all cursor-pointer shadow-2xs"
											>
												<Eye className="size-3 text-muted-foreground group-hover:text-primary" />
												<span>Inspect</span>
											</Button>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			{/* 4. Main Analytics & Visual Intelligence Panels */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Left 2 Cols: Interactive Multi-Metric Yield Timeline */}
				<Card className="lg:col-span-2 flex flex-col justify-between">
					<CardHeader className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 pb-3 border-b border-border/60">
						<div>
							<CardTitle className="text-base font-semibold font-display flex items-center gap-2">
								<span>Yield Spectrum</span>
							</CardTitle>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							{/* Active Day Filter Badge */}
							{selectedDate && (
								<Badge
									variant="cyan"
									className="h-7 gap-1.5 px-2.5 text-xs font-mono rounded-lg cursor-pointer hover:bg-cyan-500/20 shadow-xs"
									onClick={() => {
										setSelectedDate("");
										setPage(1);
									}}
									title="Click to reset day filter"
								>
									<span>Day: {selectedDate}</span>
									<X className="size-3" />
								</Badge>
							)}

							{/* Date Range Selector for Graph */}
							{renderDateRangeSelector("chart")}

							{/* Metric Group Mode Switcher */}
							<div className="flex items-center gap-1 bg-muted/40 p-1 rounded-xl border border-border/60">
								<Button
									variant={chartGroup === "activity" ? "default" : "ghost"}
									size="xs"
									onClick={() => setChartGroup("activity")}
									className={`h-7 px-3 text-xs rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
										chartGroup === "activity"
											? "font-semibold shadow-xs"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									<span>Volume & Nerve</span>
								</Button>
								<Button
									variant={chartGroup === "financials" ? "default" : "ghost"}
									size="xs"
									onClick={() => setChartGroup("financials")}
									className={`h-7 px-3 text-xs rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
										chartGroup === "financials"
											? "font-semibold shadow-xs"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									<span>Value & ROI</span>
								</Button>
							</div>
						</div>
					</CardHeader>

					<CardContent className="pt-6">
						{analyticsLoading ? (
							<div className="h-64 flex items-center justify-center">
								<Loader2 className="size-6 animate-spin text-primary" />
							</div>
						) : timeline.length === 0 ? (
							<div className="h-64 flex flex-col items-center justify-center text-muted-foreground text-xs gap-2">
								<AlertCircle className="size-8 text-muted-foreground/50" />
								<span>No crime events recorded in selected time window.</span>
								<Button
									variant="outline"
									size="sm"
									onClick={handleReconcile}
									className="rounded-xl text-xs mt-2"
								>
									Re-initialize Crime Ledger
								</Button>
							</div>
						) : (
							<ChartContainer
								config={timelineChartConfig}
								className="h-64 w-full aspect-auto"
							>
								<AreaChart
									data={timeline}
									margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
									onClick={(state: unknown) => {
										const s = state as
											| {
													activePayload?: Array<{
														payload?: DailyCrimeTimeline;
													}>;
													activeLabel?: string;
											  }
											| null
											| undefined;
										const item = s?.activePayload?.[0]?.payload;
										if (item?.date) {
											handleDayClick(item.date);
										} else if (typeof s?.activeLabel === "string") {
											handleDayClick(s.activeLabel);
										}
									}}
									className="cursor-pointer"
								>
									<defs>
										<linearGradient id="gradVolume" x1="0" y1="0" x2="0" y2="1">
											<stop offset="5%" stopColor="#38bdf8" stopOpacity={0.4} />
											<stop
												offset="95%"
												stopColor="#38bdf8"
												stopOpacity={0.0}
											/>
										</linearGradient>
										<linearGradient id="gradNerve" x1="0" y1="0" x2="0" y2="1">
											<stop
												offset="5%"
												stopColor="#f59e0b"
												stopOpacity={0.35}
											/>
											<stop
												offset="95%"
												stopColor="#f59e0b"
												stopOpacity={0.0}
											/>
										</linearGradient>
										<linearGradient id="gradValue" x1="0" y1="0" x2="0" y2="1">
											<stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
											<stop
												offset="95%"
												stopColor="#10b981"
												stopOpacity={0.0}
											/>
										</linearGradient>
										<linearGradient
											id="gradEfficiency"
											x1="0"
											y1="0"
											x2="0"
											y2="1"
										>
											<stop
												offset="5%"
												stopColor="#a855f7"
												stopOpacity={0.35}
											/>
											<stop
												offset="95%"
												stopColor="#a855f7"
												stopOpacity={0.0}
											/>
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
										tickFormatter={(value: string) => {
											return value.length > 5 ? value.slice(5) : value;
										}}
									/>

									{/* Left Y Axis */}
									<YAxis
										yAxisId="left"
										tickLine={false}
										axisLine={false}
										tickMargin={6}
										className="text-[10px] font-mono fill-muted-foreground"
										tickFormatter={(val: number) => {
											if (chartGroup === "financials") {
												if (val >= 1_000_000)
													return `$${(val / 1_000_000).toFixed(1)}M`;
												if (val >= 1_000)
													return `$${(val / 1_000).toFixed(0)}k`;
												return `$${val}`;
											}
											if (val >= 1_000) return `${(val / 1_000).toFixed(0)}k`;
											return `${val}`;
										}}
									/>

									{/* Right Y Axis */}
									<YAxis
										yAxisId="right"
										orientation="right"
										tickLine={false}
										axisLine={false}
										tickMargin={6}
										className="text-[10px] font-mono fill-muted-foreground"
										tickFormatter={(val: number) => {
											if (chartGroup === "financials") {
												if (val >= 1_000)
													return `$${(val / 1_000).toFixed(0)}k/N`;
												return `$${val}/N`;
											}
											if (val >= 1_000) return `${(val / 1_000).toFixed(0)}k N`;
											return `${val}N`;
										}}
									/>

									<ChartTooltip
										cursor={{
											stroke: "rgba(255, 255, 255, 0.2)",
											strokeDasharray: "3 3",
											strokeWidth: 1.5,
										}}
										content={({ active, payload }) => {
											if (!active || !payload?.length) return null;
											const point = payload[0]?.payload as
												| DailyCrimeTimeline
												| undefined;
											if (!point) return null;
											return (
												<div className="min-w-48 p-3 rounded-xl bg-background/95 border border-border/90 backdrop-blur-xl shadow-lg flex flex-col gap-2 text-xs">
													<div className="font-mono font-semibold text-primary flex items-center justify-between gap-3 pb-1 border-b border-border/60">
														<span>{point.date}</span>
														<CalendarDays className="size-3.5 text-muted-foreground" />
													</div>
													<div className="flex flex-col gap-1 w-full text-xs">
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#38bdf8]" />
																<span>Volume:</span>
															</span>
															<span className="font-mono font-semibold text-sky-400">
																{point.count.toLocaleString()}
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#f59e0b]" />
																<span>Nerve:</span>
															</span>
															<span className="font-mono font-semibold text-amber-400">
																{point.nerve.toLocaleString()} N
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground pt-1 border-t border-border/30">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#10b981]" />
																<span>Gross Value:</span>
															</span>
															<span className="font-mono font-semibold text-emerald-400">
																{formatCurrency(point.value)}
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#a855f7]" />
																<span>ROI ($/N):</span>
															</span>
															<span className="font-mono font-semibold text-violet-400">
																{formatCurrency(point.efficiency)} / N
															</span>
														</div>
														<div className="text-[10px] text-muted-foreground/80 italic pt-1 border-t border-border/30 text-center">
															{selectedDate === point.date
																? "Click to unfilter day"
																: "Click to filter table by this day"}
														</div>
													</div>
												</div>
											);
										}}
									/>

									{chartGroup === "activity" ? (
										<>
											<Area
												yAxisId="left"
												type="monotone"
												dataKey="count"
												name="Volume"
												stroke="#38bdf8"
												strokeWidth={2}
												fill="url(#gradVolume)"
												activeDot={{
													r: 5,
													fill: "#38bdf8",
													stroke: "var(--background)",
													strokeWidth: 2,
												}}
												dot={(dotProps) => {
													const { cx, cy, payload } = dotProps as {
														cx?: number;
														cy?: number;
														payload?: DailyCrimeTimeline;
													};
													if (!cx || !cy || selectedDate !== payload?.date)
														return <g key={`dot-v-${payload?.date}`} />;
													return (
														<circle
															key={`dot-v-${payload?.date}`}
															cx={cx}
															cy={cy}
															r={6}
															fill="#38bdf8"
															stroke="#ffffff"
															strokeWidth={2}
														/>
													);
												}}
											/>
											<Area
												yAxisId="right"
												type="monotone"
												dataKey="nerve"
												name="Nerve"
												stroke="#f59e0b"
												strokeWidth={2}
												fill="url(#gradNerve)"
												activeDot={{
													r: 5,
													fill: "#f59e0b",
													stroke: "var(--background)",
													strokeWidth: 2,
												}}
												dot={(dotProps) => {
													const { cx, cy, payload } = dotProps as {
														cx?: number;
														cy?: number;
														payload?: DailyCrimeTimeline;
													};
													if (!cx || !cy || selectedDate !== payload?.date)
														return <g key={`dot-n-${payload?.date}`} />;
													return (
														<circle
															key={`dot-n-${payload?.date}`}
															cx={cx}
															cy={cy}
															r={6}
															fill="#f59e0b"
															stroke="#ffffff"
															strokeWidth={2}
														/>
													);
												}}
											/>
										</>
									) : (
										<>
											<Area
												yAxisId="left"
												type="monotone"
												dataKey="value"
												name="Gross Value"
												stroke="#10b981"
												strokeWidth={2}
												fill="url(#gradValue)"
												activeDot={{
													r: 5,
													fill: "#10b981",
													stroke: "var(--background)",
													strokeWidth: 2,
												}}
												dot={(dotProps) => {
													const { cx, cy, payload } = dotProps as {
														cx?: number;
														cy?: number;
														payload?: DailyCrimeTimeline;
													};
													if (!cx || !cy || selectedDate !== payload?.date)
														return <g key={`dot-val-${payload?.date}`} />;
													return (
														<circle
															key={`dot-val-${payload?.date}`}
															cx={cx}
															cy={cy}
															r={6}
															fill="#10b981"
															stroke="#ffffff"
															strokeWidth={2}
														/>
													);
												}}
											/>
											<Area
												yAxisId="right"
												type="monotone"
												dataKey="efficiency"
												name="ROI ($/N)"
												stroke="#a855f7"
												strokeWidth={2}
												fill="url(#gradEfficiency)"
												activeDot={{
													r: 5,
													fill: "#a855f7",
													stroke: "var(--background)",
													strokeWidth: 2,
												}}
												dot={(dotProps) => {
													const { cx, cy, payload } = dotProps as {
														cx?: number;
														cy?: number;
														payload?: DailyCrimeTimeline;
													};
													if (!cx || !cy || selectedDate !== payload?.date)
														return <g key={`dot-eff-${payload?.date}`} />;
													return (
														<circle
															key={`dot-eff-${payload?.date}`}
															cx={cx}
															cy={cy}
															r={6}
															fill="#a855f7"
															stroke="#ffffff"
															strokeWidth={2}
														/>
													);
												}}
											/>
										</>
									)}
								</AreaChart>
							</ChartContainer>
						)}
					</CardContent>
				</Card>

				{/* Right 1 Col: Recent High-Yield Heists */}
				<Card className="flex flex-col justify-between">
					<CardHeader className="pb-3 border-b border-border/60">
						<CardTitle className="text-base font-semibold font-display flex items-center justify-between">
							<div className="flex items-center gap-2">
								<span>Recent High-Yield Crimes</span>
							</div>
						</CardTitle>
					</CardHeader>

					<CardContent className="flex flex-col gap-2 flex-1">
						<div className="flex flex-col gap-2 overflow-y-auto max-h-[300px] pr-1">
							{topLootEvents.length === 0 ? (
								<div className="text-xs text-muted-foreground py-10 text-center flex flex-col items-center justify-center gap-2">
									<Sparkles className="size-6 text-muted-foreground/40" />
									<span>No high-value loot events recorded.</span>
								</div>
							) : (
								topLootEvents.map((evt) => (
									<div
										key={evt.id}
										className="flex items-center justify-between p-2.5 rounded-xl bg-card/60 border border-border/60 hover:bg-accent/40 transition-colors text-xs"
									>
										<div className="flex flex-col min-w-0 pr-2">
											<span className="font-medium text-foreground truncate text-xs">
												{evt.action || evt.crimeName}
											</span>
											<span className="text-[10px] text-muted-foreground font-mono">
												{formatRelativeTime(evt.timestamp)} • {evt.nerve}N
											</span>
										</div>
										<span className="font-mono font-bold text-emerald-400 text-xs shrink-0">
											+{formatCurrency(evt.value)}
										</span>
									</div>
								))
							)}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* 5. Crime Log Records Data Table */}
			<div className="w-full space-y-4">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<h2 className="text-base font-semibold font-display">
							Crime Ledger Logs
						</h2>
						<Badge variant="secondary" className="ml-1 text-[10px] font-mono">
							{totalLogs.toLocaleString()}
						</Badge>
					</div>
				</div>

				<Card>
					{/* Table Filter & Search Toolbar */}
					<CardHeader className="p-4 border-b border-border/60">
						<div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
							<div className="flex flex-wrap items-center gap-2.5 flex-1">
								{/* Search input */}
								<div className="relative flex-1 min-w-[200px] max-w-sm">
									<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
									<Input
										placeholder="Search crime action, log ID..."
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
										className="pl-8 text-xs h-9 rounded-xl bg-card/60 border-border/80"
									/>
								</div>

								{/* Category Select Filter */}
								<Select
									value={selectedCrimeId}
									onValueChange={(val) => {
										setSelectedCrimeId(val);
										setPage(1);
									}}
								>
									<SelectTrigger className="w-[180px] h-9 text-xs rounded-xl bg-card/60 border-border/80">
										<SelectValue placeholder="All Categories" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="ALL">All Categories</SelectItem>
										{definitions.map((d) => (
											<SelectItem key={d.id} value={String(d.id)}>
												#{d.id} {d.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{/* Page Limit Selector */}
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<span>Rows:</span>
								<Select
									value={String(limit)}
									onValueChange={(val) => {
										setLimit(Number(val));
										setPage(1);
									}}
								>
									<SelectTrigger className="w-16 h-8 text-xs rounded-lg bg-card/60 border-border/80">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="25">25</SelectItem>
										<SelectItem value="50">50</SelectItem>
										<SelectItem value="100">100</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					</CardHeader>

					<CardContent className="p-0">
						{isLogsLoading ? (
							<div className="p-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
								<Loader2 className="size-6 animate-spin text-primary" />
								<span className="text-xs">Loading crime records...</span>
							</div>
						) : logs.length === 0 ? (
							<div className="p-12 flex flex-col items-center justify-center gap-2 text-muted-foreground text-center">
								<AlertCircle className="size-8 text-muted-foreground/50" />
								<p className="text-sm font-semibold text-foreground">
									No crime records found
								</p>
								<p className="text-xs max-w-sm">
									Try broadening your search query, switching categories, or
									triggering historical reconciliation.
								</p>
							</div>
						) : (
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent border-b border-border/40">
										<TableHead className="w-[170px] pl-4">
											<button
												type="button"
												onClick={() => handleToggleLogSort("timestamp")}
												className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-foreground ${
													sortBy === "timestamp"
														? "text-foreground font-bold"
														: "text-muted-foreground"
												}`}
											>
												<span>Timestamp (UTC)</span>
												{sortBy === "timestamp" ? (
													sortOrder === "asc" ? (
														<ArrowUp className="size-3 text-primary" />
													) : (
														<ArrowDown className="size-3 text-primary" />
													)
												) : (
													<ArrowUpDown className="size-3 opacity-30" />
												)}
											</button>
										</TableHead>
										<TableHead className="w-[180px]">
											<button
												type="button"
												onClick={() => handleToggleLogSort("crimeId")}
												className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-foreground ${
													sortBy === "crimeId"
														? "text-foreground font-bold"
														: "text-muted-foreground"
												}`}
											>
												<span>Category</span>
												{sortBy === "crimeId" ? (
													sortOrder === "asc" ? (
														<ArrowUp className="size-3 text-primary" />
													) : (
														<ArrowDown className="size-3 text-primary" />
													)
												) : (
													<ArrowUpDown className="size-3 opacity-30" />
												)}
											</button>
										</TableHead>
										<TableHead>
											<button
												type="button"
												onClick={() => handleToggleLogSort("action")}
												className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-foreground ${
													sortBy === "action"
														? "text-foreground font-bold"
														: "text-muted-foreground"
												}`}
											>
												<span>Action Performed</span>
												{sortBy === "action" ? (
													sortOrder === "asc" ? (
														<ArrowUp className="size-3 text-primary" />
													) : (
														<ArrowDown className="size-3 text-primary" />
													)
												) : (
													<ArrowUpDown className="size-3 opacity-30" />
												)}
											</button>
										</TableHead>
										<TableHead className="w-[90px] text-center">
											<button
												type="button"
												onClick={() => handleToggleLogSort("nerve")}
												className={`mx-auto flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-foreground ${
													sortBy === "nerve"
														? "text-foreground font-bold"
														: "text-muted-foreground"
												}`}
											>
												<span>Nerve</span>
												{sortBy === "nerve" ? (
													sortOrder === "asc" ? (
														<ArrowUp className="size-3 text-primary" />
													) : (
														<ArrowDown className="size-3 text-primary" />
													)
												) : (
													<ArrowUpDown className="size-3 opacity-30" />
												)}
											</button>
										</TableHead>
										<TableHead className="w-[120px] text-right">
											<button
												type="button"
												onClick={() => handleToggleLogSort("value")}
												className={`ml-auto flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-foreground ${
													sortBy === "value"
														? "text-foreground font-bold"
														: "text-muted-foreground"
												}`}
											>
												<span>Value ($)</span>
												{sortBy === "value" ? (
													sortOrder === "asc" ? (
														<ArrowUp className="size-3 text-primary" />
													) : (
														<ArrowDown className="size-3 text-primary" />
													)
												) : (
													<ArrowUpDown className="size-3 opacity-30" />
												)}
											</button>
										</TableHead>
										<TableHead className="w-[70px] text-right pr-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
											Inspect
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{logs.map((log) => (
										<TableRow
											key={log.id}
											className="hover:bg-accent/30 transition-colors group cursor-default"
										>
											{/* Timestamp */}
											<TableCell className="pl-4 font-mono text-[11px] whitespace-nowrap">
												<span className="font-semibold text-foreground">
													{formatRelativeTime(log.timestamp)}
												</span>
												<span className="text-[10px] text-muted-foreground block">
													{formatDate(log.timestamp)}
												</span>
											</TableCell>

											{/* Category */}
											<TableCell className="whitespace-nowrap">
												<Badge
													variant="secondary"
													className="text-[10px] font-mono gap-1"
												>
													<span>#{log.crimeId}</span>
													<span>{log.crimeName}</span>
												</Badge>
											</TableCell>

											{/* Action */}
											<TableCell className="max-w-md font-medium text-foreground">
												<div className="truncate" title={log.action}>
													{log.action}
												</div>
												<span className="font-mono text-[10px] text-muted-foreground/80">
													Log #{log.id}
												</span>
											</TableCell>

											{/* Nerve */}
											<TableCell className="text-center whitespace-nowrap font-mono">
												<span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 font-semibold text-[11px]">
													{log.nerve} N
												</span>
											</TableCell>

											{/* Value */}
											<TableCell className="text-right whitespace-nowrap font-mono font-bold">
												<span
													className={
														log.value > 0
															? "text-emerald-400"
															: log.value < 0
																? "text-destructive"
																: "text-muted-foreground"
													}
												>
													{log.value > 0
														? `+${formatCurrency(log.value)}`
														: formatCurrency(log.value)}
												</span>
											</TableCell>

											{/* Inspect button */}
											<TableCell className="text-right pr-4 whitespace-nowrap">
												<Button
													variant="ghost"
													size="icon-sm"
													onClick={() => setSelectedLogForDetail(log)}
													className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
													title="Inspect Crime Payload"
												>
													<Eye className="size-3.5" />
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}

						{/* Pagination Controls */}
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-t border-border/60 text-xs text-muted-foreground">
							<div>
								Showing{" "}
								<span className="font-semibold text-foreground font-mono">
									{totalLogs === 0 ? 0 : (page - 1) * limit + 1}
								</span>{" "}
								to{" "}
								<span className="font-semibold text-foreground font-mono">
									{Math.min(page * limit, totalLogs)}
								</span>{" "}
								of{" "}
								<span className="font-semibold text-foreground font-mono">
									{totalLogs.toLocaleString()}
								</span>{" "}
								entries
							</div>

							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="icon-sm"
									onClick={() => setPage((p) => Math.max(p - 1, 1))}
									disabled={page <= 1}
									className="h-8 w-8 rounded-lg cursor-pointer"
								>
									<ChevronLeft className="size-3.5" />
								</Button>
								<span className="px-2 font-mono text-[11px] font-semibold text-foreground">
									Page {page} of {totalPages || 1}
								</span>
								<Button
									variant="outline"
									size="icon-sm"
									onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
									disabled={page >= totalPages}
									className="h-8 w-8 rounded-lg cursor-pointer"
								>
									<ChevronRight className="size-3.5" />
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>

			{/* 6. Raw Log Inspector Dialog */}
			<Dialog
				open={selectedLogForDetail !== null}
				onOpenChange={(open) => {
					if (!open) setSelectedLogForDetail(null);
				}}
			>
				<DialogContent className="sm:max-w-lg rounded-2xl bg-card/95 border-border/80 backdrop-blur-2xl">
					<DialogHeader>
						<DialogTitle className="text-base font-display flex items-center gap-2">
							<Eye className="size-4 text-primary" />
							<span>Crime Log Event #{selectedLogForDetail?.id}</span>
						</DialogTitle>
						<DialogDescription className="text-xs text-muted-foreground">
							Detailed breakdown and raw payload data for this crime record
						</DialogDescription>
					</DialogHeader>

					{selectedLogForDetail && (
						<div className="flex flex-col gap-4 py-2 text-xs">
							<div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-muted/40 border border-border/60">
								<div>
									<span className="text-[10px] text-muted-foreground uppercase font-mono block">
										Category
									</span>
									<span className="font-semibold text-foreground font-mono">
										#{selectedLogForDetail.crimeId}{" "}
										{selectedLogForDetail.crimeName}
									</span>
								</div>
								<div>
									<span className="text-[10px] text-muted-foreground uppercase font-mono block">
										Nerve Cost
									</span>
									<span className="font-semibold text-amber-400 font-mono">
										{selectedLogForDetail.nerve} Nerve
									</span>
								</div>
								<div>
									<span className="text-[10px] text-muted-foreground uppercase font-mono block">
										Loot Realized
									</span>
									<span className="font-semibold text-emerald-400 font-mono">
										{formatCurrency(selectedLogForDetail.value)}
									</span>
								</div>
								<div>
									<span className="text-[10px] text-muted-foreground uppercase font-mono block">
										Recorded Time
									</span>
									<span className="font-medium text-foreground font-mono text-[11px]">
										{formatDate(selectedLogForDetail.timestamp)}
									</span>
								</div>
							</div>

							<div className="flex flex-col gap-1.5">
								<span className="text-[11px] font-semibold text-foreground">
									Action Text
								</span>
								<div className="p-2.5 rounded-xl bg-background/80 border border-border/60 font-mono text-xs text-foreground select-all">
									{selectedLogForDetail.action}
								</div>
							</div>

							<div className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between">
									<span className="text-[11px] font-semibold text-foreground">
										JSON Record
									</span>
									<Button
										variant="ghost"
										size="xs"
										onClick={() =>
											handleCopy(
												JSON.stringify(selectedLogForDetail, null, 2),
												selectedLogForDetail.id,
											)
										}
										className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
									>
										<Copy className="size-3" />
										<span>
											{copiedLogId === selectedLogForDetail.id
												? "Copied!"
												: "Copy JSON"}
										</span>
									</Button>
								</div>
								<pre className="p-3 rounded-xl bg-background/90 border border-border/80 font-mono text-[11px] text-muted-foreground overflow-x-auto max-h-48">
									{JSON.stringify(selectedLogForDetail, null, 2)}
								</pre>
							</div>
						</div>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setSelectedLogForDetail(null)}
							className="rounded-xl text-xs cursor-pointer"
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 7. Category Classified Actions Inspector Dialog */}
			<Dialog
				open={inspectingCategory !== null}
				onOpenChange={(open) => {
					if (!open) {
						setInspectingCategory(null);
						setCategoryActions([]);
					}
				}}
			>
				<DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-card/95 border-border/80 backdrop-blur-2xl">
					<DialogHeader className="pb-3 border-b border-border/60">
						<div className="flex items-center justify-between gap-3 pr-6">
							<DialogTitle className="text-base font-display flex items-center gap-2">
								{inspectingCategory && (
									<>
										<span>{inspectingCategory.crimeName}</span>
										<span className="font-mono text-xs text-muted-foreground font-normal">
											#{inspectingCategory.crimeId}
										</span>
									</>
								)}
							</DialogTitle>
						</div>
						<DialogDescription className="text-xs text-muted-foreground">
							All distinct crime actions classified under this category in the
							database
						</DialogDescription>
					</DialogHeader>

					{/* Category Summary KPIs */}
					{inspectingCategory && (
						<div className="grid grid-cols-4 gap-2 py-1 text-xs">
							<div className="p-2 rounded-xl bg-muted/40 border border-border/50">
								<span className="text-[9px] text-muted-foreground uppercase font-mono block">
									Total Crimes
								</span>
								<span className="font-bold text-foreground font-mono text-sm">
									{inspectingCategory.count.toLocaleString()}
								</span>
							</div>
							<div className="p-2 rounded-xl bg-muted/40 border border-border/50">
								<span className="text-[9px] text-muted-foreground uppercase font-mono block">
									Nerve Spent
								</span>
								<span className="font-bold text-amber-400 font-mono text-sm">
									{inspectingCategory.nerve.toLocaleString()} N
								</span>
							</div>
							<div className="p-2 rounded-xl bg-muted/40 border border-border/50">
								<span className="text-[9px] text-muted-foreground uppercase font-mono block">
									Gross Value
								</span>
								<span className="font-bold text-emerald-400 font-mono text-sm">
									{formatCurrency(inspectingCategory.value)}
								</span>
							</div>
							<div className="p-2 rounded-xl bg-muted/40 border border-border/50">
								<span className="text-[9px] text-muted-foreground uppercase font-mono block">
									Efficiency
								</span>
								<span className="font-bold text-violet-400 font-mono text-sm">
									{formatCurrency(inspectingCategory.efficiency)}/N
								</span>
							</div>
						</div>
					)}

					{/* Actions Search Filter */}
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
						<Input
							placeholder="Search classified action strings..."
							value={actionSearchQuery}
							onChange={(e) => setActionSearchQuery(e.target.value)}
							className="pl-8 text-xs h-8 rounded-xl bg-card/60 border-border/80"
						/>
					</div>

					{/* Action List Table / Scroll Area */}
					<div className="flex-1 overflow-y-auto max-h-[340px] pr-1 flex flex-col gap-2">
						{isLoadingActions ? (
							<div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground text-xs">
								<Loader2 className="size-5 animate-spin text-primary" />
								<span>Loading classified actions...</span>
							</div>
						) : filteredCategoryActions.length === 0 ? (
							<div className="py-10 text-center text-xs text-muted-foreground flex flex-col items-center justify-center gap-2">
								<AlertCircle className="size-6 text-muted-foreground/50" />
								<span>
									{actionSearchQuery
										? "No matching actions found."
										: "No classified action records found for this category."}
								</span>
							</div>
						) : (
							filteredCategoryActions.map((act) => (
								<div
									key={act.action}
									className="flex items-center justify-between p-2.5 rounded-xl bg-card/60 border border-border/60 hover:bg-accent/40 transition-colors text-xs"
								>
									<div className="flex flex-col min-w-0 pr-3">
										<span className="font-medium text-foreground text-xs truncate">
											{act.action}
										</span>
										<div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono mt-0.5">
											<span>
												{act.count.toLocaleString()} runs ({act.percentage}%)
											</span>
											<span>•</span>
											<span className="text-amber-400/90">
												{act.nerve.toLocaleString()} N
											</span>
										</div>
									</div>
									<div className="flex flex-col items-end shrink-0 font-mono">
										<span className="font-bold text-emerald-400 text-xs">
											{formatCurrency(act.value)}
										</span>
										<span className="text-[10px] text-violet-400 font-medium">
											{formatCurrency(act.efficiency)}/N
										</span>
									</div>
								</div>
							))
						)}
					</div>

					<DialogFooter className="pt-2 border-t border-border/60 flex justify-between items-center">
						<span className="text-[10px] font-mono text-muted-foreground">
							{filteredCategoryActions.length} distinct action types recorded
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setInspectingCategory(null)}
							className="rounded-xl text-xs cursor-pointer h-7"
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
