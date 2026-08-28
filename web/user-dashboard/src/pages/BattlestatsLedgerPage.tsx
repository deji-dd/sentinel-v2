import { format } from "date-fns";
import {
	Activity,
	AlertCircle,
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	BookOpen,
	Building2,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Copy,
	Dumbbell,
	Eye,
	Layers,
	Loader2,
	Pill,
	RefreshCw,
	Search,
	Shield,
	Sparkles,
	Wind,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Pie,
	PieChart,
	XAxis,
	YAxis,
} from "recharts";
import {
	type EfficiencyDataPayload,
	TrainingEfficiencyTable,
} from "@/components/TrainingEfficiencyTable";
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
import {
	formatDate,
	formatDecimal,
	formatNumber,
	formatRelativeTime,
} from "@/lib/utils";
import { useRouter } from "@/router";

export interface BattlestatsLedgerState {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedLogs: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totals?: {
		totalInDb: number;
		totalStatGained: number;
		totalTrains: number;
		totalEnergyUsed: number;
		avgGainPerTrain: number;
		avgGainPerEnergy: number;
		matchingPersonalLogs: number;
		minTimestamp: number | null;
		maxTimestamp: number | null;
	};
	topStatCategory?: StatCategoryAnalytics | null;
	allTimeStats?: StatCategoryAnalytics[];
	allTimeSources?: SourceCategoryAnalytics[];
}

export interface BattlestatsLogItem {
	id: string;
	timestamp: string | number;
	statType: "strength" | "defense" | "speed" | "dexterity";
	source: "gym" | "item" | "book" | "company";
	trains: number | null;
	energyUsed: number | null;
	statGained: number;
	statBefore: number | null;
	statAfter: number | null;
	gainPerEnergy: number | null;
}

export interface StatCategoryAnalytics {
	statType: string;
	count: number;
	gained: number;
	trains: number;
	energy: number;
	efficiency: number;
	percentage: number;
}

export interface SourceCategoryAnalytics {
	source: string;
	count: number;
	gained: number;
	trains: number;
	energy: number;
	percentage: number;
}

const disciplineChartConfig = {
	strength: {
		label: "Strength",
		color: "#f97316",
	},
	defense: {
		label: "Defense",
		color: "#06b6d4",
	},
	speed: {
		label: "Speed",
		color: "#10b981",
	},
	dexterity: {
		label: "Dexterity",
		color: "#8b5cf6",
	},
} satisfies ChartConfig;

const sourceChartConfig = {
	gym: {
		label: "Gym Train",
		color: "#3b82f6",
	},
	item: {
		label: "Stat Enhancer",
		color: "#f59e0b",
	},
	book: {
		label: "Book Benefit",
		color: "#a855f7",
	},
	company: {
		label: "Company Special",
		color: "#06b6d4",
	},
} satisfies ChartConfig;

const timelineChartConfig = {
	strength: {
		label: "Strength",
		color: "#f97316",
	},
	defense: {
		label: "Defense",
		color: "#06b6d4",
	},
	speed: {
		label: "Speed",
		color: "#10b981",
	},
	dexterity: {
		label: "Dexterity",
		color: "#8b5cf6",
	},
	totalGained: {
		label: "Total Gained",
		color: "#38bdf8",
	},
	energyUsed: {
		label: "Energy Used",
		color: "#f59e0b",
	},
} satisfies ChartConfig;

const hourlyChartConfig = {
	totalGained: {
		label: "Stat Gains",
		color: "#38bdf8",
	},
} satisfies ChartConfig;

export interface DailyBattlestatsTimeline {
	date: string;
	strength: number;
	defense: number;
	speed: number;
	dexterity: number;
	totalGained: number;
	trains: number;
	energyUsed: number;
	count: number;
}

export interface HourlyBattlestatsDistribution {
	hour: number;
	count: number;
	totalGained: number;
}

export interface BattlestatsAnalyticsData {
	summary: {
		totalGained: number;
		totalTrains: number;
		totalEnergyUsed: number;
		totalLogs: number;
		avgGainPerTrain: number;
		avgGainPerEnergy: number;
	};
	statBreakdown: StatCategoryAnalytics[];
	sourceBreakdown: SourceCategoryAnalytics[];
	timeline: DailyBattlestatsTimeline[];
	hourly: HourlyBattlestatsDistribution[];
	topEvents: BattlestatsLogItem[];
}

function getStatBadgeStyle(statType: string) {
	switch (statType?.toLowerCase()) {
		case "strength":
			return {
				bg: "bg-orange-500/10 border-orange-500/30 text-orange-400",
				accent: "text-orange-400",
				barColor: "bg-orange-500",
				icon: Dumbbell,
			};
		case "defense":
			return {
				bg: "bg-cyan-500/10 border-cyan-500/30 text-cyan-400",
				accent: "text-cyan-400",
				barColor: "bg-cyan-500",
				icon: Shield,
			};
		case "speed":
			return {
				bg: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
				accent: "text-emerald-400",
				barColor: "bg-emerald-500",
				icon: Wind,
			};
		case "dexterity":
			return {
				bg: "bg-purple-500/10 border-purple-500/30 text-purple-400",
				accent: "text-purple-400",
				barColor: "bg-purple-500",
				icon: Activity,
			};
		default:
			return {
				bg: "bg-primary/10 border-primary/30 text-primary",
				accent: "text-primary",
				barColor: "bg-primary",
				icon: Sparkles,
			};
	}
}

function getSourceBadgeStyle(source: string) {
	switch (source?.toLowerCase()) {
		case "gym":
			return {
				label: "Gym",
				badge: "bg-blue-500/10 border-blue-500/20 text-blue-400",
				icon: Dumbbell,
			};
		case "item":
			return {
				label: "SE",
				badge: "bg-amber-500/10 border-amber-500/20 text-amber-400",
				icon: Pill,
			};
		case "book":
			return {
				label: "Book",
				badge: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
				icon: BookOpen,
			};
		case "company":
			return {
				label: "Companys",
				badge: "bg-fuchsia-500/10 border-fuchsia-500/20 text-fuchsia-400",
				icon: Building2,
			};
		default:
			return {
				label: source || "Unknown",
				badge: "bg-muted text-muted-foreground",
				icon: Layers,
			};
	}
}

export function BattlestatsLedgerPage() {
	const { path } = useRouter();
	const { setPageReady } = useGlobalLoading();

	// State
	const [state, setState] = useState<BattlestatsLedgerState | null>(null);
	const [analytics, setAnalytics] = useState<BattlestatsAnalyticsData | null>(
		null,
	);
	const [logs, setLogs] = useState<BattlestatsLogItem[]>([]);
	const [totalLogs, setTotalLogs] = useState(0);
	const [totalPages, setTotalPages] = useState(1);
	const [loading, setLoading] = useState(true);
	const [logsLoading, setLogsLoading] = useState(false);
	const [reconciling, setReconciling] = useState(false);

	// Filters
	const [daysFilter, setDaysFilter] = useState<string>("30");
	const [customDateRange, setCustomDateRange] = useState<DateRange | undefined>(
		undefined,
	);
	const [statTypeFilter, setStatTypeFilter] = useState<string>("all");
	const [sourceFilter, setSourceFilter] = useState<string>("all");
	const [searchTerm, setSearchTerm] = useState("");
	const [page, setPage] = useState(1);
	const [pageSize] = useState(25);
	const [sortBy, setSortBy] = useState<string>("timestamp");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

	// Day click drilldown state
	const [selectedDate, setSelectedDate] = useState<string>("");
	const [dayHourly, setDayHourly] = useState<Array<{
		hour: number;
		totalGained: number;
		count: number;
	}> | null>(null);

	const formatDateOnly = useCallback((dateStr?: string) => {
		if (!dateStr) return "";
		try {
			return format(
				new Date(dateStr.includes("T") ? dateStr : `${dateStr}T00:00:00`),
				"MMM dd, yyyy",
			);
		} catch {
			return dateStr;
		}
	}, []);

	// Table column sort toggle
	const handleToggleSort = useCallback((field: string) => {
		setSortBy((prevSortBy) => {
			if (prevSortBy === field) {
				setSortOrder((prevOrder) => (prevOrder === "asc" ? "desc" : "asc"));
				return prevSortBy;
			}
			setSortOrder("desc");
			return field;
		});
		setPage(1);
	}, []);

	// Progression tab toggle: stats vs energy
	const [progressionTab, setProgressionTab] = useState<"stats" | "energy">(
		"stats",
	);

	// Dialog inspection state
	const [inspectLog, setInspectLog] = useState<BattlestatsLogItem | null>(null);
	const [reconcileModalOpen, setReconcileModalOpen] = useState(false);

	// WebSocket ref
	const wsRef = useRef<WebSocket | null>(null);

	// Initial page ready notice
	useEffect(() => {
		setPageReady(path);
	}, [path, setPageReady]);

	// Fetch overall state
	const fetchState = useCallback(async () => {
		try {
			const res = await fetch("/api/v1/system/battlestats-ledger/state");
			if (!res.ok) throw new Error("Failed to fetch battlestats ledger state");
			const data = (await res.json()) as BattlestatsLedgerState;
			setState(data);
		} catch (err) {
			console.error("Error loading battlestats ledger state:", err);
		}
	}, []);

	// Efficiency state
	const [efficiencyData, setEfficiencyData] =
		useState<EfficiencyDataPayload | null>(null);
	const [efficiencyLoading, setEfficiencyLoading] = useState(true);

	const fetchEfficiency = useCallback(async () => {
		setEfficiencyLoading(true);
		try {
			const res = await fetch(
				"/api/v1/system/battlestats-ledger/efficiency-data",
			);
			if (!res.ok) throw new Error("Failed to fetch efficiency data");
			const data = (await res.json()) as EfficiencyDataPayload;
			setEfficiencyData(data);
		} catch (err) {
			console.error("Error loading efficiency data:", err);
		} finally {
			setEfficiencyLoading(false);
		}
	}, []);

	// Fetch analytics
	const fetchAnalytics = useCallback(async () => {
		try {
			const params = new URLSearchParams();
			if (customDateRange?.from && customDateRange?.to) {
				params.set(
					"from",
					format(customDateRange.from, "yyyy-MM-dd'T'00:00:00'Z'"),
				);
				params.set(
					"to",
					format(customDateRange.to, "yyyy-MM-dd'T'23:59:59'Z'"),
				);
			} else if (daysFilter && daysFilter !== "custom") {
				params.set("days", daysFilter);
			}

			if (statTypeFilter && statTypeFilter !== "all") {
				params.set("statType", statTypeFilter);
			}
			if (sourceFilter && sourceFilter !== "all") {
				params.set("source", sourceFilter);
			}

			const res = await fetch(
				`/api/v1/system/battlestats-ledger/analytics?${params.toString()}`,
			);
			if (!res.ok) throw new Error("Failed to fetch battlestats analytics");
			const data = (await res.json()) as BattlestatsAnalyticsData;
			setAnalytics(data);
		} catch (err) {
			console.error("Error loading battlestats analytics:", err);
		}
	}, [daysFilter, customDateRange, statTypeFilter, sourceFilter]);

	// Handle clicking a day in the timeline graph to drilldown
	const handleDayClick = useCallback((dateStr?: string) => {
		if (!dateStr) return;
		setSelectedDate((prev) => (prev === dateStr ? "" : dateStr));
		setPage(1);
	}, []);

	// Fetch day hourly distribution when a specific day is clicked
	useEffect(() => {
		if (!selectedDate) {
			setDayHourly(null);
			return;
		}

		let isMounted = true;
		const loadDayHourly = async () => {
			try {
				const params = new URLSearchParams();
				params.set("from", `${selectedDate}T00:00:00Z`);
				params.set("to", `${selectedDate}T23:59:59Z`);
				if (statTypeFilter && statTypeFilter !== "all") {
					params.set("statType", statTypeFilter);
				}
				if (sourceFilter && sourceFilter !== "all") {
					params.set("source", sourceFilter);
				}

				const res = await fetch(
					`/api/v1/system/battlestats-ledger/analytics?${params.toString()}`,
				);
				if (!res.ok) return;
				const data = (await res.json()) as BattlestatsAnalyticsData;
				if (isMounted) {
					setDayHourly(data.hourly ?? []);
				}
			} catch (err) {
				console.error("Failed to load hourly stats for day:", err);
			}
		};

		loadDayHourly();

		return () => {
			isMounted = false;
		};
	}, [selectedDate, statTypeFilter, sourceFilter]);

	// Fetch paginated logs
	const fetchLogs = useCallback(async () => {
		setLogsLoading(true);
		try {
			const params = new URLSearchParams();
			params.set("page", String(page));
			params.set("pageSize", String(pageSize));
			params.set("sortBy", sortBy);
			params.set("sortOrder", sortOrder);

			if (selectedDate) {
				params.set("from", `${selectedDate}T00:00:00Z`);
				params.set("to", `${selectedDate}T23:59:59Z`);
			} else if (customDateRange?.from && customDateRange?.to) {
				params.set(
					"from",
					format(customDateRange.from, "yyyy-MM-dd'T'00:00:00'Z'"),
				);
				params.set(
					"to",
					format(customDateRange.to, "yyyy-MM-dd'T'23:59:59'Z'"),
				);
			} else if (daysFilter && daysFilter !== "custom") {
				params.set("days", daysFilter);
			}

			if (statTypeFilter && statTypeFilter !== "all") {
				params.set("statType", statTypeFilter);
			}
			if (sourceFilter && sourceFilter !== "all") {
				params.set("source", sourceFilter);
			}
			if (searchTerm.trim()) {
				params.set("search", searchTerm.trim());
			}

			const res = await fetch(
				`/api/v1/system/battlestats-ledger/logs?${params.toString()}`,
			);
			if (!res.ok) throw new Error("Failed to fetch battlestats logs");
			const result = (await res.json()) as {
				items: BattlestatsLogItem[];
				pagination: {
					total: number;
					totalPages: number;
				};
			};
			setLogs(result.items ?? []);
			setTotalLogs(result.pagination?.total ?? 0);
			setTotalPages(result.pagination?.totalPages ?? 1);
		} catch (err) {
			console.error("Error loading battlestats logs:", err);
			toast.error("Failed to load battlestats logs.");
		} finally {
			setLogsLoading(false);
		}
	}, [
		page,
		pageSize,
		sortBy,
		sortOrder,
		selectedDate,
		daysFilter,
		customDateRange,
		statTypeFilter,
		sourceFilter,
		searchTerm,
	]);

	// Initial and combined refresh
	const refreshAll = useCallback(async () => {
		setLoading(true);
		await Promise.all([
			fetchState(),
			fetchAnalytics(),
			fetchLogs(),
			fetchEfficiency(),
		]);
		setLoading(false);
	}, [fetchState, fetchAnalytics, fetchLogs, fetchEfficiency]);

	useEffect(() => {
		refreshAll();
	}, [refreshAll]);

	// WebSocket live state subscription
	useEffect(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}/api/ws/battlestats-ledger`;

		let isCleanedUp = false;
		let reconnectTimer: ReturnType<typeof setTimeout>;

		const connect = () => {
			if (isCleanedUp) return;
			try {
				const ws = new WebSocket(wsUrl);
				wsRef.current = ws;

				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(event.data) as {
							type: string;
							state?: BattlestatsLedgerState;
						};
						if (
							(msg.type === "state_snapshot" || msg.type === "state_update") &&
							msg.state
						) {
							setState(msg.state);
						}
					} catch (e) {
						console.error("Failed to parse battlestats WS message:", e);
					}
				};

				ws.onclose = () => {
					if (!isCleanedUp) {
						reconnectTimer = setTimeout(connect, 4000);
					}
				};

				ws.onerror = () => {
					ws.close();
				};
			} catch (_err) {
				if (!isCleanedUp) {
					reconnectTimer = setTimeout(connect, 4000);
				}
			}
		};

		connect();

		return () => {
			isCleanedUp = true;
			clearTimeout(reconnectTimer);
			if (wsRef.current) {
				wsRef.current.close();
			}
		};
	}, []);

	// Trigger reconciliation
	const handleReconcile = async () => {
		setReconciling(true);
		try {
			const res = await fetch("/api/v1/system/battlestats-ledger/reconcile", {
				method: "POST",
			});
			if (!res.ok) throw new Error("Reconciliation trigger failed");
			const result = (await res.json()) as {
				success: boolean;
				message: string;
			};
			toast.success(
				result.message || "Reconciliation request dispatched successfully.",
			);
			setReconcileModalOpen(false);
			await refreshAll();
		} catch (err) {
			console.error("Failed to trigger reconciliation:", err);
			toast.error("Failed to dispatch reconciliation request.");
		} finally {
			setReconciling(false);
		}
	};

	// Copy log JSON
	const handleCopyLogJson = (item: BattlestatsLogItem) => {
		navigator.clipboard.writeText(JSON.stringify(item, null, 2));
		toast.success("Log record JSON copied to clipboard.");
	};

	// All-Time Fixed KPIs (Always reflect full ledger telemetry)
	const summary = {
		totalGained: state?.totals?.totalStatGained ?? 0,
		totalTrains: state?.totals?.totalTrains ?? 0,
		totalEnergyUsed: state?.totals?.totalEnergyUsed ?? 0,
		totalLogs: state?.totals?.totalInDb ?? 0,
		avgGainPerTrain: state?.totals?.avgGainPerTrain ?? 0,
		avgGainPerEnergy: state?.totals?.avgGainPerEnergy ?? 0,
	};

	// All-Time Fixed Stat Discipline breakdown
	const statCardsList = useMemo(() => {
		const breakdown = state?.allTimeStats ?? [];
		const stats = ["strength", "defense", "speed", "dexterity"] as const;
		return stats.map((st) => {
			const found = breakdown.find(
				(b) => b.statType.toLowerCase() === st.toLowerCase(),
			);
			return {
				statType: st,
				gained: found?.gained ?? 0,
				trains: found?.trains ?? 0,
				energy: found?.energy ?? 0,
				count: found?.count ?? 0,
				efficiency: found?.efficiency ?? 0,
				percentage: found?.percentage ?? 0,
			};
		});
	}, [state?.allTimeStats]);

	const disciplineChartData = useMemo(() => {
		const colors: Record<string, string> = {
			strength: "#f97316",
			defense: "#06b6d4",
			speed: "#10b981",
			dexterity: "#8b5cf6",
		};
		return statCardsList.map((stat) => ({
			name: stat.statType.charAt(0).toUpperCase() + stat.statType.slice(1),
			statType: stat.statType,
			gained: stat.gained,
			trains: stat.trains,
			efficiency: stat.efficiency,
			percentage: stat.percentage,
			color: colors[stat.statType] ?? "#38bdf8",
		}));
	}, [statCardsList]);

	// All-Time Fixed Source Distribution breakdown
	const sourceChartData = useMemo(() => {
		const colors: Record<string, string> = {
			gym: "#3b82f6",
			item: "#f59e0b",
			book: "#a855f7",
			company: "#06b6d4",
		};
		const sources = ["gym", "item", "book", "company"] as const;
		const raw = state?.allTimeSources ?? [];
		return sources.map((src) => {
			const found = raw.find((s) => s.source.toLowerCase() === src);
			const gained = found?.gained ?? 0;
			const count = found?.count ?? 0;
			const percentage = found?.percentage ?? 0;
			const badge = getSourceBadgeStyle(src);
			return {
				name: badge.label,
				source: src,
				gained,
				count,
				percentage,
				color: colors[src] ?? "#38bdf8",
			};
		});
	}, [state?.allTimeSources]);

	return (
		<div className="flex flex-col gap-6 p-4 md:p-8 max-w-7xl mx-auto w-full">
			{/* Top Header & Action Row */}
			<div className="flex flex-col md:flex-row md:items-center justify-end gap-4 border-b border-border/40 pb-5">
				{/* Right Actions & Status */}
				<div className="flex flex-wrap items-center gap-2.5">
					{/* Reconcile button */}
					<Button
						variant="outline"
						size="sm"
						onClick={() => setReconcileModalOpen(true)}
						disabled={reconciling || state?.status === "running"}
						className="rounded-xl text-xs h-9 gap-1.5 border-border/60 hover:border-primary/40 cursor-pointer"
					>
						<RefreshCw
							className={`size-3.5 ${reconciling ? "animate-spin text-primary" : ""}`}
						/>
						<span>Re-Initialize Ledger</span>
					</Button>

					{/* Refresh Button */}
					<Button
						variant="secondary"
						size="sm"
						onClick={refreshAll}
						disabled={loading}
						className="rounded-xl text-xs h-9 gap-1.5 cursor-pointer shadow-sm"
					>
						<RefreshCw
							className={`size-3.5 ${loading ? "animate-spin" : ""}`}
						/>
						<span>Refresh</span>
					</Button>
				</div>
			</div>

			<TrainingEfficiencyTable
				data={efficiencyData}
				isLoading={efficiencyLoading}
			/>

			{/* Summary KPI Overview Cards (All-Time Fixed) */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				{/* Total Stat Gains */}
				<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm relative overflow-hidden group hover:border-primary/40 transition-colors">
					<CardHeader className="p-4 pb-2">
						<CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
							Total Stat Gains
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground">
							{formatNumber(summary.totalGained)}
						</CardTitle>
					</CardHeader>
				</Card>

				{/* Energy Expended */}
				<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm relative overflow-hidden group hover:border-amber-500/40 transition-colors">
					<CardHeader className="p-4 pb-2">
						<CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
							Energy Expended
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground">
							{formatNumber(summary.totalEnergyUsed)} E
						</CardTitle>
					</CardHeader>
				</Card>

				{/* Avg Gain per Train */}
				<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm relative overflow-hidden group hover:border-blue-500/40 transition-colors">
					<CardHeader className="p-4 pb-2">
						<CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
							Avg Gain / Train
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground">
							+{formatDecimal(summary.avgGainPerTrain)}
						</CardTitle>
					</CardHeader>
				</Card>

				{/* Avg Gain per Energy */}
				<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm relative overflow-hidden group hover:border-amber-500/40 transition-colors">
					<CardHeader className="p-4 pb-2">
						<CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
							Avg Gain / Energy
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground">
							+{formatDecimal(summary.avgGainPerEnergy)}
						</CardTitle>
					</CardHeader>
				</Card>
			</div>

			{/* All-Time Fixed Distributions: Stat Distribution & Source Distribution */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				{/* Stat Distribution */}
				<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm">
					<CardHeader className="p-5 pb-2">
						<CardTitle className="text-base font-bold font-display flex items-center gap-2">
							Stat Distribution
						</CardTitle>
					</CardHeader>
					<CardContent className="p-5 pt-3 flex items-center justify-center">
						<ChartContainer
							config={disciplineChartConfig}
							className="h-56 w-56 aspect-square"
						>
							<PieChart>
								<ChartTooltip
									wrapperStyle={{ zIndex: 1000 }}
									content={({ active, payload }) => {
										if (!active || !payload?.length) return null;
										const dataItem = payload[0]?.payload as
											| (typeof disciplineChartData)[number]
											| undefined;
										if (!dataItem) return null;
										return (
											<div className="min-w-44 p-3 rounded-xl bg-background/95 border border-border/90 backdrop-blur-xl shadow-xl flex flex-col gap-2 text-xs relative z-50">
												<div className="font-semibold text-foreground flex items-center justify-between gap-3 pb-1 border-b border-border/60">
													<span className="capitalize">{dataItem.name}</span>
													<span className="font-mono text-muted-foreground">
														{dataItem.percentage}% share
													</span>
												</div>
												<div className="flex flex-col gap-1 w-full text-xs">
													<div className="flex justify-between gap-4 text-muted-foreground">
														<span>Total Gains:</span>
														<span className="font-mono font-semibold text-foreground">
															+{formatNumber(dataItem.gained)}
														</span>
													</div>
													<div className="flex justify-between gap-4 text-muted-foreground">
														<span>Gym Trains:</span>
														<span className="font-mono font-semibold text-foreground">
															{formatNumber(dataItem.trains)}
														</span>
													</div>
													<div className="flex justify-between gap-4 text-muted-foreground pt-1 border-t border-border/30">
														<span>Efficiency:</span>
														<span className="font-mono font-semibold text-primary">
															+{formatDecimal(dataItem.efficiency)} / E
														</span>
													</div>
												</div>
											</div>
										);
									}}
								/>
								<Pie
									data={disciplineChartData}
									dataKey="gained"
									nameKey="name"
									cx="50%"
									cy="50%"
									outerRadius={90}
									stroke="var(--background)"
									strokeWidth={2}
								>
									{disciplineChartData.map((entry) => (
										<Cell key={`pie-${entry.statType}`} fill={entry.color} />
									))}
								</Pie>
							</PieChart>
						</ChartContainer>
					</CardContent>
				</Card>

				{/* Source Distribution */}
				<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm">
					<CardHeader className="p-5 pb-2">
						<CardTitle className="text-base font-bold font-display flex items-center gap-2">
							Source Distribution
						</CardTitle>
					</CardHeader>
					<CardContent className="p-5 pt-3 flex items-center justify-center">
						<ChartContainer
							config={sourceChartConfig}
							className="h-56 w-56 aspect-square"
						>
							<PieChart>
								<ChartTooltip
									wrapperStyle={{ zIndex: 1000 }}
									content={({ active, payload }) => {
										if (!active || !payload?.length) return null;
										const dataItem = payload[0]?.payload as
											| (typeof sourceChartData)[number]
											| undefined;
										if (!dataItem) return null;
										return (
											<div className="min-w-44 p-3 rounded-xl bg-background/95 border border-border/90 backdrop-blur-xl shadow-xl flex flex-col gap-2 text-xs relative z-50">
												<div className="font-semibold text-foreground flex items-center justify-between gap-3 pb-1 border-b border-border/60">
													<span>{dataItem.name}</span>
													<span className="font-mono text-muted-foreground">
														{dataItem.percentage}% share
													</span>
												</div>
												<div className="flex flex-col gap-1 w-full text-xs">
													<div className="flex justify-between gap-4 text-muted-foreground">
														<span>Total Gains:</span>
														<span className="font-mono font-semibold text-foreground">
															+{formatNumber(dataItem.gained)}
														</span>
													</div>
													<div className="flex justify-between gap-4 text-muted-foreground">
														<span>Total Events:</span>
														<span className="font-mono font-semibold text-foreground">
															{formatNumber(dataItem.count)}
														</span>
													</div>
												</div>
											</div>
										);
									}}
								/>
								<Pie
									data={sourceChartData}
									dataKey="gained"
									nameKey="name"
									cx="50%"
									cy="50%"
									outerRadius={90}
									stroke="var(--background)"
									strokeWidth={2}
								>
									{sourceChartData.map((entry) => (
										<Cell key={`pie-${entry.source}`} fill={entry.color} />
									))}
								</Pie>
							</PieChart>
						</ChartContainer>
					</CardContent>
				</Card>
			</div>

			{/* Date Range Selector & Filter Presets (Applies to Graphs & Logs) */}
			<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-card/60 backdrop-blur-md p-3 rounded-2xl border border-border/50 shadow-sm">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground font-medium mr-1.5 flex items-center gap-1">
						Range:
					</span>
					{(
						[
							{ label: "Today", value: "1" },
							{ label: "7 Days", value: "7" },
							{ label: "30 Days", value: "30" },
							{ label: "90 Days", value: "90" },
							{ label: "All Time", value: "all" },
						] as const
					).map((preset) => (
						<Button
							key={preset.value}
							variant={
								daysFilter === preset.value && !customDateRange
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() => {
								setDaysFilter(preset.value);
								setCustomDateRange(undefined);
								setSelectedDate("");
								setPage(1);
							}}
							className="rounded-xl text-xs h-8 px-3 cursor-pointer"
						>
							{preset.label}
						</Button>
					))}

					{/* Custom Range Popover */}
					<Popover>
						<PopoverTrigger asChild>
							<Button
								variant={customDateRange ? "default" : "outline"}
								size="sm"
								className="rounded-xl text-xs h-8 gap-1.5 cursor-pointer"
							>
								<CalendarDays className="size-3.5" />
								<span>
									{customDateRange?.from
										? customDateRange.to
											? `${format(customDateRange.from, "LLL dd")} - ${format(customDateRange.to, "LLL dd")}`
											: format(customDateRange.from, "LLL dd")
										: "Custom Range"}
								</span>
							</Button>
						</PopoverTrigger>
						<PopoverContent className="w-auto p-0 rounded-2xl" align="start">
							<Calendar
								mode="range"
								defaultMonth={customDateRange?.from}
								selected={customDateRange}
								onSelect={(range) => {
									setCustomDateRange(range);
									if (range?.from && range?.to) {
										setDaysFilter("custom");
										setSelectedDate("");
										setPage(1);
									}
								}}
								numberOfMonths={2}
							/>
						</PopoverContent>
					</Popover>

					{/* Clear Custom Filter Button */}
					{(customDateRange || selectedDate) && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setCustomDateRange(undefined);
								setSelectedDate("");
								setDaysFilter("30");
								setPage(1);
							}}
							className="rounded-xl text-xs h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<X className="size-3.5" />
						</Button>
					)}
				</div>
			</div>

			{/* Progression Timeline Chart (Full Width) */}
			<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm w-full">
				<CardHeader className="p-5 pb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 space-y-0">
					<div>
						<CardTitle className="text-base font-bold font-display flex items-center gap-2">
							Stat Progression
						</CardTitle>
					</div>

					{/* 2 Tabs: Stat Split vs Energy Used */}
					<div className="flex items-center gap-1 bg-muted/30 p-1 rounded-xl border border-border/40">
						<Button
							variant={progressionTab === "stats" ? "default" : "ghost"}
							size="sm"
							onClick={() => setProgressionTab("stats")}
							className="rounded-lg text-xs h-7 px-2.5 cursor-pointer"
						>
							Stat Split
						</Button>
						<Button
							variant={progressionTab === "energy" ? "default" : "ghost"}
							size="sm"
							onClick={() => setProgressionTab("energy")}
							className="rounded-lg text-xs h-7 px-2.5 cursor-pointer"
						>
							Energy Used
						</Button>
					</div>
				</CardHeader>
				<CardContent className="p-5 pt-3">
					<div className="h-[280px] w-full">
						{analytics?.timeline && analytics.timeline.length > 0 ? (
							<ChartContainer
								config={timelineChartConfig}
								className="h-[280px] w-full aspect-auto"
							>
								<AreaChart
									data={analytics.timeline}
									margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
									className="cursor-pointer"
									onClick={(state: unknown) => {
										const s = state as
											| {
													activePayload?: Array<{
														payload?: DailyBattlestatsTimeline;
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
								>
									<defs>
										<linearGradient
											id="strengthGrad"
											x1="0"
											y1="0"
											x2="0"
											y2="1"
										>
											<stop offset="5%" stopColor="#f97316" stopOpacity={0.8} />
											<stop offset="95%" stopColor="#f97316" stopOpacity={0} />
										</linearGradient>
										<linearGradient
											id="defenseGrad"
											x1="0"
											y1="0"
											x2="0"
											y2="1"
										>
											<stop offset="5%" stopColor="#06b6d4" stopOpacity={0.8} />
											<stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
										</linearGradient>
										<linearGradient id="speedGrad" x1="0" y1="0" x2="0" y2="1">
											<stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
											<stop offset="95%" stopColor="#10b981" stopOpacity={0} />
										</linearGradient>
										<linearGradient
											id="dexterityGrad"
											x1="0"
											y1="0"
											x2="0"
											y2="1"
										>
											<stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8} />
											<stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
										</linearGradient>
										<linearGradient id="energyGrad" x1="0" y1="0" x2="0" y2="1">
											<stop offset="5%" stopColor="#f59e0b" stopOpacity={0.8} />
											<stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
										</linearGradient>
									</defs>
									<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
									<XAxis
										dataKey="date"
										tickFormatter={(str) => {
											try {
												return format(new Date(str), "MMM dd");
											} catch {
												return str;
											}
										}}
										stroke="var(--muted-foreground)"
										fontSize={11}
									/>

									<YAxis
										tickFormatter={(val) =>
											progressionTab === "energy"
												? `${formatNumber(Number(val))} E`
												: formatNumber(Number(val))
										}
										stroke="var(--muted-foreground)"
										fontSize={10}
									/>

									<ChartTooltip
										content={({ active, payload, label }) => {
											if (!active || !payload?.length) return null;
											const point = payload[0]?.payload as
												| DailyBattlestatsTimeline
												| undefined;
											if (!point) return null;

											if (progressionTab === "energy") {
												return (
													<div className="min-w-44 p-3 rounded-xl bg-background/95 border border-border/90 backdrop-blur-xl shadow-xl flex flex-col gap-2 text-xs">
														<div className="font-mono font-semibold text-amber-500 flex items-center justify-between gap-3 pb-1 border-b border-border/60">
															<span>
																{label ? formatDateOnly(String(label)) : ""}
															</span>
															<CalendarDays className="size-3.5 text-muted-foreground" />
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5 text-amber-500">
																<span className="size-2 rounded-full bg-[#f59e0b]" />
																<span>Energy Used:</span>
															</span>
															<span className="font-mono font-bold text-amber-500">
																{formatNumber(point.energyUsed)} E
															</span>
														</div>
													</div>
												);
											}

											const totalGains =
												(point.strength || 0) +
												(point.defense || 0) +
												(point.speed || 0) +
												(point.dexterity || 0);

											return (
												<div className="min-w-48 p-3 rounded-xl bg-background/95 border border-border/90 backdrop-blur-xl shadow-xl flex flex-col gap-2 text-xs">
													<div className="font-mono font-semibold text-primary flex items-center justify-between gap-3 pb-1 border-b border-border/60">
														<span>
															{label ? formatDateOnly(String(label)) : ""}
														</span>
														<CalendarDays className="size-3.5 text-muted-foreground" />
													</div>
													<div className="flex flex-col gap-1 w-full text-xs">
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#f97316]" />
																<span>Strength:</span>
															</span>
															<span className="font-mono font-semibold text-foreground">
																+{formatNumber(point.strength)}
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#06b6d4]" />
																<span>Defense:</span>
															</span>
															<span className="font-mono font-semibold text-foreground">
																+{formatNumber(point.defense)}
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#10b981]" />
																<span>Speed:</span>
															</span>
															<span className="font-mono font-semibold text-foreground">
																+{formatNumber(point.speed)}
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground">
															<span className="flex items-center gap-1.5">
																<span className="size-2 rounded-full bg-[#8b5cf6]" />
																<span>Dexterity:</span>
															</span>
															<span className="font-mono font-semibold text-foreground">
																+{formatNumber(point.dexterity)}
															</span>
														</div>
														<div className="flex justify-between gap-4 text-muted-foreground pt-1 border-t border-border/40">
															<span className="font-semibold text-foreground">
																Total Gains:
															</span>
															<span className="font-mono font-bold text-primary">
																+{formatNumber(totalGains)}
															</span>
														</div>
													</div>
												</div>
											);
										}}
									/>

									{progressionTab === "stats" ? (
										<>
											<Area
												type="monotone"
												dataKey="strength"
												name="Strength"
												stackId="1"
												stroke="#f97316"
												fillOpacity={1}
												fill="url(#strengthGrad)"
											/>
											<Area
												type="monotone"
												dataKey="defense"
												name="Defense"
												stackId="1"
												stroke="#06b6d4"
												fillOpacity={1}
												fill="url(#defenseGrad)"
											/>
											<Area
												type="monotone"
												dataKey="speed"
												name="Speed"
												stackId="1"
												stroke="#10b981"
												fillOpacity={1}
												fill="url(#speedGrad)"
											/>
											<Area
												type="monotone"
												dataKey="dexterity"
												name="Dexterity"
												stackId="1"
												stroke="#8b5cf6"
												fillOpacity={1}
												fill="url(#dexterityGrad)"
											/>
										</>
									) : (
										<Area
											type="monotone"
											dataKey="energyUsed"
											name="Energy Used"
											stroke="#f59e0b"
											fillOpacity={1}
											fill="url(#energyGrad)"
										/>
									)}
								</AreaChart>
							</ChartContainer>
						) : (
							<div className="h-full flex items-center justify-center text-xs text-muted-foreground">
								No timeline progression data available for this range.
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{/* 24-Hour UTC Activity Distribution (Full Width) */}
			<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm w-full">
				<CardHeader className="p-5 pb-2 flex flex-row items-center justify-between space-y-0">
					<div className="flex items-center gap-3">
						<CardTitle className="text-base font-bold font-display flex items-center gap-2">
							Hourly Distribution (UTC)
						</CardTitle>
						{selectedDate && (
							<Badge
								variant="secondary"
								className="rounded-lg text-xs gap-1.5 bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 cursor-pointer"
								onClick={() => setSelectedDate("")}
								title="Click to clear day filter"
							>
								<span>{formatDateOnly(selectedDate)}</span>
								<X className="size-3" />
							</Badge>
						)}
					</div>
				</CardHeader>
				<CardContent className="p-5 pt-3">
					<div className="h-[280px] w-full">
						{(dayHourly ?? analytics?.hourly)?.length ? (
							<ChartContainer
								config={hourlyChartConfig}
								className="h-[280px] w-full aspect-auto"
							>
								<BarChart
									data={dayHourly ?? analytics?.hourly ?? []}
									margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
								>
									<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
									<XAxis
										dataKey="hour"
										tickFormatter={(h) => `${h}h`}
										stroke="var(--muted-foreground)"
										fontSize={10}
									/>
									<YAxis
										tickFormatter={(val) => formatNumber(Number(val))}
										stroke="var(--muted-foreground)"
										fontSize={10}
									/>
									<ChartTooltip
										content={({ active, payload, label }) => {
											if (!active || !payload?.length) return null;
											const val = payload[0]?.value;
											return (
												<div className="p-2.5 rounded-xl bg-background/95 border border-border/90 backdrop-blur-xl shadow-lg flex flex-col gap-1 text-xs">
													<div className="font-mono font-semibold text-primary pb-1 border-b border-border/60">
														{String(label)}:00 - {String(label)}:59 UTC
													</div>
													<div className="flex justify-between gap-4 text-muted-foreground">
														<span>Stat Gained:</span>
														<span className="font-mono font-semibold text-foreground">
															+{formatNumber(Number(val) || 0)}
														</span>
													</div>
												</div>
											);
										}}
									/>

									<Bar
										dataKey="totalGained"
										name="totalGained"
										fill="#38bdf8"
										radius={[4, 4, 0, 0]}
									/>
								</BarChart>
							</ChartContainer>
						) : (
							<div className="h-full flex items-center justify-center text-xs text-muted-foreground">
								No hourly distribution data available.
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Filterable Training Log Table */}
			<Card className="rounded-2xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm overflow-hidden">
				<CardHeader className="p-5 pb-3">
					<div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
						<div>
							<CardTitle className="text-base font-bold font-display flex items-center gap-2">
								Battlestats Logs
								{selectedDate && (
									<Badge
										variant="secondary"
										className="rounded-lg text-xs gap-1.5 bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 cursor-pointer ml-2"
										onClick={() => setSelectedDate("")}
										title="Click to clear day filter"
									>
										<span>{formatDateOnly(selectedDate)}</span>
										<X className="size-3" />
									</Badge>
								)}
							</CardTitle>
						</div>

						{/* Search & Filters */}
						<div className="flex flex-wrap items-center gap-2.5">
							{/* Stat Type Filter */}
							<Select
								value={statTypeFilter}
								onValueChange={(val) => {
									setStatTypeFilter(val);
									setPage(1);
								}}
							>
								<SelectTrigger className="w-[130px] rounded-xl text-xs h-9">
									<SelectValue placeholder="Stat" />
								</SelectTrigger>
								<SelectContent className="rounded-xl">
									<SelectItem value="all">All Stats</SelectItem>
									<SelectItem value="strength">Strength</SelectItem>
									<SelectItem value="defense">Defense</SelectItem>
									<SelectItem value="speed">Speed</SelectItem>
									<SelectItem value="dexterity">Dexterity</SelectItem>
								</SelectContent>
							</Select>

							{/* Source Filter */}
							<Select
								value={sourceFilter}
								onValueChange={(val) => {
									setSourceFilter(val);
									setPage(1);
								}}
							>
								<SelectTrigger className="w-[140px] rounded-xl text-xs h-9">
									<SelectValue placeholder="Source" />
								</SelectTrigger>
								<SelectContent className="rounded-xl">
									<SelectItem value="all">All Sources</SelectItem>
									<SelectItem value="gym">Gym Trains</SelectItem>
									<SelectItem value="item">Stat Enhancers</SelectItem>
									<SelectItem value="book">Books</SelectItem>
									<SelectItem value="company">Company Specials</SelectItem>
								</SelectContent>
							</Select>

							{/* Search input */}
							<div className="relative">
								<Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
								<Input
									placeholder="Search by ID or type..."
									value={searchTerm}
									onChange={(e) => {
										setSearchTerm(e.target.value);
										setPage(1);
									}}
									className="rounded-xl text-xs h-9 pl-8 w-[170px] sm:w-[200px]"
								/>
							</div>
						</div>
					</div>
				</CardHeader>
				<CardContent className="p-0">
					<div className="overflow-x-auto">
						<Table>
							<TableHeader className="bg-muted/20">
								<TableRow className="border-b border-border/40 hover:bg-transparent">
									<TableHead className="text-xs font-semibold">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleToggleSort("timestamp")}
											className="-ml-3 h-8 data-[state=open]:bg-accent font-mono text-[10px] uppercase tracking-wider gap-1 hover:bg-muted/50 text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<span
												className={
													sortBy === "timestamp"
														? "text-foreground font-bold"
														: ""
												}
											>
												Timestamp
											</span>
											{sortBy === "timestamp" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3 text-primary" />
												) : (
													<ArrowDown className="size-3 text-primary" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</Button>
									</TableHead>
									<TableHead className="text-xs font-semibold">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleToggleSort("statType")}
											className="-ml-3 h-8 data-[state=open]:bg-accent font-mono text-[10px] uppercase tracking-wider gap-1 hover:bg-muted/50 text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<span
												className={
													sortBy === "statType"
														? "text-foreground font-bold"
														: ""
												}
											>
												Stat
											</span>
											{sortBy === "statType" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3 text-primary" />
												) : (
													<ArrowDown className="size-3 text-primary" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</Button>
									</TableHead>
									<TableHead className="text-xs font-semibold">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleToggleSort("source")}
											className="-ml-3 h-8 data-[state=open]:bg-accent font-mono text-[10px] uppercase tracking-wider gap-1 hover:bg-muted/50 text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<span
												className={
													sortBy === "source" ? "text-foreground font-bold" : ""
												}
											>
												Source
											</span>
											{sortBy === "source" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3 text-primary" />
												) : (
													<ArrowDown className="size-3 text-primary" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</Button>
									</TableHead>
									<TableHead className="text-xs font-semibold">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleToggleSort("statGained")}
											className="-ml-3 h-8 data-[state=open]:bg-accent font-mono text-[10px] uppercase tracking-wider gap-1 hover:bg-muted/50 text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<span
												className={
													sortBy === "statGained"
														? "text-foreground font-bold"
														: ""
												}
											>
												Gains
											</span>
											{sortBy === "statGained" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3 text-primary" />
												) : (
													<ArrowDown className="size-3 text-primary" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</Button>
									</TableHead>
									<TableHead className="text-xs font-semibold">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleToggleSort("statBefore")}
											className="-ml-3 h-8 data-[state=open]:bg-accent font-mono text-[10px] uppercase tracking-wider gap-1 hover:bg-muted/50 text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<span
												className={
													sortBy === "statBefore"
														? "text-foreground font-bold"
														: ""
												}
											>
												Before ➔ After
											</span>
											{sortBy === "statBefore" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3 text-primary" />
												) : (
													<ArrowDown className="size-3 text-primary" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</Button>
									</TableHead>
									<TableHead className="text-xs font-semibold">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleToggleSort("energyUsed")}
											className="-ml-3 h-8 data-[state=open]:bg-accent font-mono text-[10px] uppercase tracking-wider gap-1 hover:bg-muted/50 text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<span
												className={
													sortBy === "energyUsed"
														? "text-foreground font-bold"
														: ""
												}
											>
												Energy
											</span>
											{sortBy === "energyUsed" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3 text-primary" />
												) : (
													<ArrowDown className="size-3 text-primary" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</Button>
									</TableHead>
									<TableHead className="text-xs font-semibold">
										<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
											Gains / E
										</span>
									</TableHead>
									<TableHead className="text-xs font-semibold text-right pr-5">
										<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
											Actions
										</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{logsLoading ? (
									<TableRow>
										<TableCell
											colSpan={8}
											className="h-32 text-center text-xs text-muted-foreground"
										>
											<div className="flex items-center justify-center gap-2">
												<Loader2 className="size-4 animate-spin text-primary" />
												<span>Loading battlestats logs...</span>
											</div>
										</TableCell>
									</TableRow>
								) : logs.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={8}
											className="h-32 text-center text-xs text-muted-foreground"
										>
											No training logs match the selected filters.
										</TableCell>
									</TableRow>
								) : (
									logs.map((log) => {
										const statBadge = getStatBadgeStyle(log.statType);
										const srcBadge = getSourceBadgeStyle(log.source);

										return (
											<TableRow
												key={log.id}
												className="border-b border-border/30 hover:bg-muted/30 transition-colors"
											>
												{/* Timestamp */}
												<TableCell className="text-xs font-mono py-3">
													<div className="font-medium text-foreground">
														{formatDate(log.timestamp)}
													</div>
													<div className="text-[10px] text-muted-foreground">
														{formatRelativeTime(log.timestamp)}
													</div>
												</TableCell>

												{/* Discipline */}
												<TableCell className="py-3">
													<Badge
														variant="outline"
														className={`text-xs capitalize font-semibold gap-1.5 px-2.5 py-0.5 rounded-lg border ${statBadge.bg}`}
													>
														{log.statType}
													</Badge>
												</TableCell>

												{/* Source */}
												<TableCell className="py-3">
													<Badge
														variant="outline"
														className={`text-[11px] font-medium px-2 py-0.5 rounded-lg border ${srcBadge.badge}`}
													>
														{srcBadge.label}
													</Badge>
												</TableCell>

												{/* Stat Gained */}
												<TableCell className="text-xs font-mono font-bold text-emerald-400 py-3">
													+{formatNumber(log.statGained)}
												</TableCell>

												{/* Before / After */}
												<TableCell className="text-xs font-mono py-3">
													{log.statBefore !== null && log.statAfter !== null ? (
														<div className="flex items-center gap-1.5 text-muted-foreground">
															<span>{formatNumber(log.statBefore)}</span>
															<span className="text-foreground font-bold">
																➔
															</span>
															<span className="text-foreground font-semibold">
																{formatNumber(log.statAfter)}
															</span>
														</div>
													) : (
														<span className="text-muted-foreground/60">—</span>
													)}
												</TableCell>

												{/* Trains / Energy */}
												<TableCell className="text-xs font-mono py-3">
													{log.trains !== null || log.energyUsed !== null ? (
														<div className="flex items-center gap-1.5 text-muted-foreground">
															<span className="text-amber-400 font-semibold">
																{log.energyUsed ?? 0} E
															</span>
														</div>
													) : (
														<span className="text-muted-foreground/60">—</span>
													)}
												</TableCell>

												{/* Gains / E efficiency */}
												<TableCell className="text-xs font-mono py-3">
													{log.gainPerEnergy !== null &&
													log.gainPerEnergy > 0 ? (
														<span className="text-primary font-semibold">
															+{formatDecimal(log.gainPerEnergy, 2)}
														</span>
													) : (
														<span className="text-muted-foreground/60">—</span>
													)}
												</TableCell>

												{/* Actions */}
												<TableCell className="text-right pr-5 py-3">
													<div className="flex items-center justify-end gap-1.5">
														<Button
															variant="ghost"
															size="icon"
															onClick={() => setInspectLog(log)}
															className="size-7 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
															title="Inspect Log Entry"
														>
															<Eye className="size-3.5" />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															onClick={() => handleCopyLogJson(log)}
															className="size-7 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
															title="Copy Raw JSON"
														>
															<Copy className="size-3.5" />
														</Button>
													</div>
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>

					{/* Pagination footer */}
					<div className="p-4 border-t border-border/40 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
						<div>
							Showing{" "}
							<span className="font-semibold text-foreground">
								{logs.length > 0 ? (page - 1) * pageSize + 1 : 0}
							</span>{" "}
							to{" "}
							<span className="font-semibold text-foreground">
								{Math.min(page * pageSize, totalLogs)}
							</span>{" "}
							of{" "}
							<span className="font-semibold text-foreground">
								{formatNumber(totalLogs)}
							</span>{" "}
							records
						</div>

						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setPage((p) => Math.max(1, p - 1))}
								disabled={page <= 1 || logsLoading}
								className="rounded-xl text-xs h-8 gap-1 cursor-pointer"
							>
								<ChevronLeft className="size-3.5" />
								<span>Previous</span>
							</Button>
							<div className="px-2 font-mono text-foreground font-semibold">
								Page {page} of {totalPages || 1}
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
								disabled={page >= totalPages || logsLoading}
								className="rounded-xl text-xs h-8 gap-1 cursor-pointer"
							>
								<span>Next</span>
								<ChevronRight className="size-3.5" />
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Log Detail Inspection Dialog */}
			<Dialog
				open={!!inspectLog}
				onOpenChange={(open) => !open && setInspectLog(null)}
			>
				<DialogContent className="sm:max-w-lg rounded-2xl border-border/60 bg-card/95 backdrop-blur-2xl shadow-2xl">
					<DialogHeader>
						<DialogTitle className="text-base font-bold font-display flex items-center gap-2">
							<Dumbbell className="size-4 text-primary" />
							Log Entry Details
						</DialogTitle>
						<DialogDescription className="text-xs">
							Detailed stat increment metrics and metadata for record ID{" "}
							<span className="font-mono text-foreground">
								{inspectLog?.id}
							</span>
						</DialogDescription>
					</DialogHeader>

					{inspectLog && (
						<div className="space-y-4 py-2 text-xs">
							<div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-muted/40 border border-border/50">
								<div>
									<div className="text-muted-foreground text-[11px]">
										Discipline
									</div>
									<div className="font-bold text-foreground capitalize mt-0.5">
										{inspectLog.statType}
									</div>
								</div>
								<div>
									<div className="text-muted-foreground text-[11px]">
										Source
									</div>
									<div className="font-bold text-foreground capitalize mt-0.5">
										{inspectLog.source}
									</div>
								</div>
								<div>
									<div className="text-muted-foreground text-[11px]">
										Gain Amount
									</div>
									<div className="font-bold text-emerald-400 font-mono mt-0.5">
										+{formatNumber(inspectLog.statGained)}
									</div>
								</div>
								<div>
									<div className="text-muted-foreground text-[11px]">
										Energy Used
									</div>
									<div className="font-bold text-amber-400 font-mono mt-0.5">
										{inspectLog.energyUsed ?? 0} E
									</div>
								</div>
							</div>

							<div className="space-y-1.5">
								<span className="text-[11px] font-semibold text-muted-foreground">
									Raw JSON Payload
								</span>
								<pre className="p-3 rounded-xl bg-background/80 border border-border/50 text-[11px] font-mono text-muted-foreground overflow-x-auto max-h-48">
									{JSON.stringify(inspectLog, null, 2)}
								</pre>
							</div>
						</div>
					)}

					<DialogFooter className="gap-2 pt-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => inspectLog && handleCopyLogJson(inspectLog)}
							className="rounded-xl text-xs gap-1.5"
						>
							<Copy className="size-3.5" />
							<span>Copy JSON</span>
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={() => setInspectLog(null)}
							className="rounded-xl text-xs"
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Reconcile Modal Confirmation */}
			<Dialog open={reconcileModalOpen} onOpenChange={setReconcileModalOpen}>
				<DialogContent className="sm:max-w-md rounded-2xl border-border/60 bg-card/95 backdrop-blur-2xl shadow-2xl">
					<DialogHeader>
						<DialogTitle className="text-base font-bold font-display flex items-center gap-2">
							<RefreshCw className="size-4 text-primary" />
							Reconcile & Rebuild Battlestats Ledger
						</DialogTitle>
						<DialogDescription className="text-xs">
							This command re-parses historical personal logs into `gym_ledgers`
							to recover any missed gym trains, stat enhancers, books, or
							company specials.
						</DialogDescription>
					</DialogHeader>

					<div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 space-y-1.5">
						<span className="font-bold flex items-center gap-1.5">
							<AlertCircle className="size-4" />
							Non-destructive Background Operation
						</span>
						<p className="text-[11px] text-amber-300/80 leading-relaxed">
							The scheduler executes an optimized anti-join scan across all
							historical logs in SQLite. UI metrics will update automatically
							upon completion.
						</p>
					</div>

					<DialogFooter className="gap-2 pt-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setReconcileModalOpen(false)}
							disabled={reconciling}
							className="rounded-xl text-xs"
						>
							Cancel
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={handleReconcile}
							disabled={reconciling}
							className="rounded-xl text-xs gap-1.5"
						>
							{reconciling && <Loader2 className="size-3.5 animate-spin" />}
							<span>{reconciling ? "Dispatching..." : "Start Rebuild"}</span>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export const GymLedgerPage = BattlestatsLedgerPage;
