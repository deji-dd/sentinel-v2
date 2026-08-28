import { format } from "date-fns";
import {
	AlertCircle,
	ArrowUpDown,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Coins,
	Copy,
	DollarSign,
	Eye,
	Flame,
	Loader2,
	Package,
	RefreshCw,
	Search,
	Sparkles,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
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
	Dialog,
	DialogContent,
	DialogDescription,
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

export interface StocksLedgerState {
	scope?: "active" | "all_time";
	status: "idle" | "running" | "completed" | "error";
	totalIndexedLogs: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totalInDb: number;
	totalDividendValue: number;
	distinctStocksCount: number;
	activeUserStocksCount: number;
	totalPersonalLogsCount: number;
	dbOldestDate: string | null;
	dbNewestDate: string | null;
	topProfitStock?: StockAnalytics | null;
	allTimeStocks?: StockAnalytics[];
}

export interface StockLogItem {
	id: string;
	stockId: number;
	stockName: string;
	acronym: string;
	logType: number;
	value: number;
	itemId: number | null;
	itemName: string | null;
	timestamp: string | number;
	createdAt: string | number;
}

export interface StockAnalytics {
	stockId: number;
	stockName: string;
	acronym: string;
	count: number;
	value: number;
	percentage: number;
}

export interface DailyStockTimeline {
	date: string;
	count: number;
	value: number;
}

export interface TopYieldEvent {
	id: string;
	stockId: number;
	stockName: string;
	acronym: string;
	logType: number;
	value: number;
	itemId: number | null;
	timestamp: string | number;
}

export interface StockRoiItem {
	stockId: number;
	name: string;
	acronym: string;
	logo: string | null;
	price: number;
	requirement: number;
	frequency: number;
	isPassive: boolean;
	rewardCategory: "cash" | "item" | "points" | "resource" | "passive";
	description: string;
	rewardValuePerCycle: number;
	annualRewardValue: number;
	firstBlockCost: number;
	realDividendsGotten: number;
	currentRealizedApr: number;
	userShares: number;
	userBlocks: number;
	targetBlockLevel: number;
	partialShares: number;
	nextBlockSharesRequired: number;
	sharesRemainingForNextBlock: number;
	progressPercent: number;
	nextBlockCost: number;
	nextBlockApr: number;
	nextPaybackYears: number | null;
	apr: number;
	paybackYears: number | null;
}

const formatCurrency = (val: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(val);

const formatNumber = (val: number) =>
	new Intl.NumberFormat("en-US").format(val);

export function StocksLedgerPage() {
	const { path } = useRouter();
	const { setPageReady } = useGlobalLoading();

	// Scope: "active" (Current Active Holding Period) vs "all_time" (Lifetime History)
	const [scope, setScope] = useState<"active" | "all_time">("active");
	const scopeRef = useRef(scope);
	const wsRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		scopeRef.current = scope;
	}, [scope]);

	// State Management
	const [state, setState] = useState<StocksLedgerState | null>(null);
	const [logs, setLogs] = useState<StockLogItem[]>([]);
	const [totalLogsCount, setTotalLogsCount] = useState<number>(0);
	const [totalPages, setTotalPages] = useState<number>(1);
	const [page, setPage] = useState<number>(1);
	const [limit, setLimit] = useState<number>(50);

	// Filters
	const [daysFilter, setDaysFilter] = useState<string>("30");
	const [dateRange, setDateRange] = useState<DateRange | undefined>();
	const [stockIdFilter, setStockIdFilter] = useState<string>("ALL");
	const [searchQuery, setSearchQuery] = useState<string>("");
	const [minValFilter, setMinValFilter] = useState<string>("");
	const [sortBy, setSortBy] = useState<string>("timestamp");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

	// Analytics data
	const [_timelineData, setTimelineData] = useState<DailyStockTimeline[]>([]);
	const [_topEvents, setTopEvents] = useState<TopYieldEvent[]>([]);

	// ROI & APR Table Data
	const [activeRoiStocks, setActiveRoiStocks] = useState<StockRoiItem[]>([]);
	const [passiveRoiStocks, setPassiveRoiStocks] = useState<StockRoiItem[]>([]);
	const [roiSearch, setRoiSearch] = useState<string>("");
	const [roiLoading, setRoiLoading] = useState<boolean>(true);

	// Modal / Loading States
	const [selectedLog, setSelectedLog] = useState<StockLogItem | null>(null);
	const [isReconciling, setIsReconciling] = useState<boolean>(false);
	const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(true);
	const [_isLoadingState, setIsLoadingState] = useState<boolean>(true);

	// Stock logo lookup map
	const stockLogoMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const s of [...activeRoiStocks, ...passiveRoiStocks]) {
			if (s.logo) {
				map.set(s.acronym, s.logo);
				map.set(String(s.stockId), s.logo);
			}
		}
		return map;
	}, [activeRoiStocks, passiveRoiStocks]);

	// Scope Change Handler
	const handleScopeChange = (newScope: "active" | "all_time") => {
		if (scope === newScope) return;
		setScope(newScope);
		setPage(1);
		if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
			wsRef.current.send(
				JSON.stringify({ type: "set_scope", scope: newScope }),
			);
		}
	};

	// 1. Fetch State & Overall Aggregates
	const fetchState = useCallback(async () => {
		try {
			const res = await fetch(
				`/api/v1/system/stock-ledger/state?scope=${scope}`,
			);
			if (res.ok) {
				const data = (await res.json()) as StocksLedgerState;
				setState(data);
			}
		} catch (err) {
			console.error("Failed to fetch stocks ledger state:", err);
		} finally {
			setIsLoadingState(false);
		}
	}, [scope]);

	// 2. Fetch Paginated Logs
	const fetchLogs = useCallback(async () => {
		setIsLoadingLogs(true);
		try {
			const params = new URLSearchParams();
			params.set("scope", scope);
			params.set("page", String(page));
			params.set("limit", String(limit));
			params.set("sortBy", sortBy);
			params.set("sortOrder", sortOrder);

			if (dateRange?.from) {
				params.set("from", `${format(dateRange.from, "yyyy-MM-dd")}T00:00:00Z`);
			}
			if (dateRange?.to) {
				params.set("to", `${format(dateRange.to, "yyyy-MM-dd")}T23:59:59Z`);
			}
			if (!dateRange?.from && !dateRange?.to && daysFilter !== "all") {
				params.set("days", daysFilter);
			}
			if (stockIdFilter !== "ALL") {
				params.set("stockId", stockIdFilter);
			}
			if (searchQuery.trim()) {
				params.set("search", searchQuery.trim());
			}
			if (minValFilter.trim()) {
				params.set("minVal", minValFilter.trim());
			}

			const res = await fetch(
				`/api/v1/system/stock-ledger/logs?${params.toString()}`,
			);
			if (res.ok) {
				const data = await res.json();
				setLogs(data.logs ?? []);
				setTotalLogsCount(data.total ?? 0);
				setTotalPages(data.totalPages ?? 1);
			}
		} catch (err) {
			console.error("Failed to fetch stock logs:", err);
		} finally {
			setIsLoadingLogs(false);
		}
	}, [
		scope,
		page,
		limit,
		sortBy,
		sortOrder,
		dateRange,
		daysFilter,
		stockIdFilter,
		searchQuery,
		minValFilter,
	]);

	// 3. Fetch Analytics Timeline & Top Events
	const fetchAnalytics = useCallback(async () => {
		try {
			const params = new URLSearchParams();
			params.set("scope", scope);
			if (dateRange?.from) {
				params.set("from", `${format(dateRange.from, "yyyy-MM-dd")}T00:00:00Z`);
			}
			if (dateRange?.to) {
				params.set("to", `${format(dateRange.to, "yyyy-MM-dd")}T23:59:59Z`);
			}
			if (!dateRange?.from && !dateRange?.to && daysFilter !== "all") {
				params.set("days", daysFilter);
			}
			if (stockIdFilter !== "ALL") {
				params.set("stockId", stockIdFilter);
			}

			const res = await fetch(
				`/api/v1/system/stock-ledger/analytics?${params.toString()}`,
			);
			if (res.ok) {
				const data = await res.json();
				setTimelineData(data.timeline ?? []);
				setTopEvents(data.topYieldEvents ?? []);
			}
		} catch (err) {
			console.error("Failed to fetch stock analytics:", err);
		}
	}, [scope, dateRange, daysFilter, stockIdFilter]);

	// 4. Fetch Stock ROI & APR Table
	const fetchRoiTable = useCallback(async () => {
		setRoiLoading(true);
		try {
			const res = await fetch(
				`/api/v1/system/stock-ledger/roi-table?scope=${scope}`,
			);
			if (res.ok) {
				const data = await res.json();
				setActiveRoiStocks(data.activeStocks ?? []);
				setPassiveRoiStocks(data.passiveStocks ?? []);
			}
		} catch (err) {
			console.error("Failed to fetch stock ROI table:", err);
		} finally {
			setRoiLoading(false);
		}
	}, [scope]);

	// Initial setup & WebSocket listener
	useEffect(() => {
		fetchState();
		fetchLogs();
		fetchAnalytics();
		fetchRoiTable();

		let ws: WebSocket | null = null;
		try {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${protocol}//${window.location.host}/api/ws/stocks-ledger`;
			ws = new WebSocket(wsUrl);
			wsRef.current = ws;

			ws.onopen = () => {
				ws?.send(
					JSON.stringify({ type: "set_scope", scope: scopeRef.current }),
				);
			};

			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data);
					if (msg.type === "state_update" || msg.type === "state_snapshot") {
						if (msg.state) {
							if (msg.state.scope && msg.state.scope !== scopeRef.current) {
								return;
							}
							setState((prev) => ({ ...prev, ...msg.state }));
						}
					}
				} catch {
					// Ignore invalid ws frame
				}
			};
		} catch {
			// WS connection optional
		}

		setPageReady(path);

		return () => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.close();
			}
			wsRef.current = null;
		};
	}, [
		fetchState,
		fetchLogs,
		fetchAnalytics,
		fetchRoiTable,
		path,
		setPageReady,
	]);

	// Trigger reconciliation
	const handleReconcile = async () => {
		setIsReconciling(true);
		try {
			const res = await fetch("/api/v1/system/stock-ledger/reconcile", {
				method: "POST",
			});
			const data = await res.json();
			if (res.ok && data.success) {
				toast.success("Reconstruction Dispatched", {
					description:
						"Scheduler worker is rebuilding stock dividend ledger records in background.",
				});
				fetchState();
				fetchLogs();
				fetchAnalytics();
				fetchRoiTable();
			} else {
				toast.error("Reconstruction Failed", {
					description: data.message ?? "Could not reach background worker.",
				});
			}
		} catch (_err) {
			toast.error("Error", {
				description: "Network error triggering reconstruction.",
			});
		} finally {
			setIsReconciling(false);
		}
	};

	const handleSort = (column: string) => {
		if (sortBy === column) {
			setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(column);
			setSortOrder("desc");
		}
		setPage(1);
	};

	const formatTimestamp = (ts: string | number) => {
		try {
			const dateObj =
				typeof ts === "number"
					? new Date(ts < 1e11 ? ts * 1000 : ts)
					: new Date(ts);
			return format(dateObj, "MMM dd, yyyy HH:mm:ss");
		} catch {
			return String(ts);
		}
	};

	// Filter ROI tables by search input
	const filteredActiveRoi = activeRoiStocks.filter((item) => {
		if (!roiSearch.trim()) return true;
		const query = roiSearch.toLowerCase().trim();
		return (
			item.name.toLowerCase().includes(query) ||
			item.acronym.toLowerCase().includes(query) ||
			item.description.toLowerCase().includes(query)
		);
	});

	const filteredPassiveRoi = passiveRoiStocks.filter((item) => {
		if (!roiSearch.trim()) return true;
		const query = roiSearch.toLowerCase().trim();
		return (
			item.name.toLowerCase().includes(query) ||
			item.acronym.toLowerCase().includes(query) ||
			item.description.toLowerCase().includes(query)
		);
	});

	// Calculate Personal Realized ROI (Dividends Received vs Benefit Block Investment Cost)
	const topRealizedRoiStock = useMemo(() => {
		if (!state?.allTimeStocks || state.allTimeStocks.length === 0) return null;

		const roiMap = new Map(activeRoiStocks.map((r) => [r.stockId, r]));

		const ranked = state.allTimeStocks
			.map((st) => {
				const meta = roiMap.get(st.stockId);
				const price = meta?.price ?? 0;
				const req = meta?.requirement ?? 0;
				const userShares = meta?.userShares ?? 0;

				const sharesForBb = userShares > 0 ? userShares : req;
				const bbCost = sharesForBb * price;

				const realizedRoi = bbCost > 0 ? (st.value / bbCost) * 100 : 0;

				return {
					...st,
					bbCost,
					realizedRoi: Number(realizedRoi.toFixed(2)),
				};
			})
			.sort((a, b) => b.realizedRoi - a.realizedRoi);

		return ranked[0] ?? null;
	}, [state?.allTimeStocks, activeRoiStocks]);

	return (
		<div className="space-y-6">
			{/* Header Section */}
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-card/40 p-6 rounded-2xl">
				{/* Scope Selector: Active Holding Period vs All-Time History */}
				<div className="flex items-center rounded-xl bg-background/60 border border-border/60 p-1">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => handleScopeChange("active")}
						className={`h-8 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
							scope === "active"
								? "bg-emerald-500/20 text-emerald-400 shadow-xs border border-emerald-500/30"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Active Holdings
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => handleScopeChange("all_time")}
						className={`h-8 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
							scope === "all_time"
								? "bg-sky-500/20 text-sky-400 shadow-xs border border-sky-500/30"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						All-Time History
					</Button>
				</div>

				<div className="flex flex-wrap items-center gap-2.5">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							fetchLogs();
							fetchRoiTable();
						}}
						disabled={isLoadingLogs}
						className="rounded-xl h-9 text-xs cursor-pointer border-border/80 hover:bg-accent/60"
					>
						<RefreshCw
							className={`size-3.5 mr-1.5 ${isLoadingLogs ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>

					<Button
						size="sm"
						onClick={handleReconcile}
						disabled={isReconciling || state?.status === "running"}
						className="rounded-xl h-9 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs cursor-pointer"
					>
						{isReconciling ? (
							<Loader2 className="size-3.5 mr-1.5 animate-spin" />
						) : (
							<Sparkles className="size-3.5 mr-1.5" />
						)}
						Re-Initialize Ledger
					</Button>
				</div>
			</div>

			{/* KPI Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-3 gap-4">
				<Card className="rounded-2xl border-border/60 bg-gradient-to-br from-card/60 via-card/40 to-emerald-950/20 backdrop-blur-xl shadow-xs overflow-hidden relative group">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity text-emerald-400 pointer-events-none">
						<DollarSign className="size-24 -mr-6 -mt-6" />
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="text-xs font-medium text-emerald-400/90 flex items-center gap-1.5">
							Total Dividend Income
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground">
							{formatCurrency(state?.totalDividendValue ?? 0)}
						</CardTitle>
					</CardHeader>
				</Card>

				<Card className="rounded-2xl border-border/60 bg-gradient-to-br from-card/60 via-card/40 to-amber-950/20 backdrop-blur-xl shadow-xs overflow-hidden relative group">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity text-amber-400 pointer-events-none">
						<Flame className="size-24 -mr-6 -mt-6" />
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="text-xs font-medium text-amber-400/90 flex items-center gap-1.5">
							Top Yield Stock
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground truncate">
							{state?.topProfitStock?.acronym ?? "N/A"}
						</CardTitle>
					</CardHeader>
				</Card>

				<Card className="rounded-2xl border-border/60 bg-gradient-to-br from-card/60 via-card/40 to-sky-950/20 backdrop-blur-xl shadow-xs overflow-hidden relative group">
					<div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity text-sky-400 pointer-events-none">
						<Sparkles className="size-24 -mr-6 -mt-6" />
					</div>
					<CardHeader className="pb-2">
						<CardDescription className="text-xs font-medium text-sky-400/90 flex items-center gap-1.5">
							Best ROI
						</CardDescription>
						<CardTitle className="text-2xl font-bold font-mono tracking-tight text-foreground truncate flex items-center justify-between">
							<span>{topRealizedRoiStock?.acronym ?? "N/A"}</span>
							{topRealizedRoiStock && (
								<Badge
									variant="outline"
									className="rounded-lg bg-emerald-500/20 text-emerald-400 border-emerald-500/40 text-xs font-mono font-bold"
								>
									{topRealizedRoiStock.realizedRoi}% Recouped
								</Badge>
							)}
						</CardTitle>
					</CardHeader>
				</Card>
			</div>

			{/* Stock Benefit ROI & APR Table */}
			<Card className="rounded-2xl border-border/60 bg-card/40 backdrop-blur-xl shadow-xs">
				<CardHeader>
					<div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<CardTitle className="text-base font-bold font-display text-foreground">
									Stock ROI & APR Table
								</CardTitle>
							</div>
						</div>

						<div className="flex items-center gap-3">
							<div className="relative w-64">
								<Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
								<Input
									placeholder="Search stock ticker or reward..."
									value={roiSearch}
									onChange={(e) => setRoiSearch(e.target.value)}
									className="pl-9 h-9 rounded-xl text-xs border-border/60 bg-background/50 focus:bg-background"
								/>
								{roiSearch && (
									<button
										type="button"
										onClick={() => setRoiSearch("")}
										className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
									>
										<X className="size-3.5" />
									</button>
								)}
							</div>
						</div>
					</div>
				</CardHeader>

				<CardContent className="space-y-6">
					{/* Active Dividend Yield Table (Sorted by APR % Descending) */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<h3 className="text-xs font-bold font-mono uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
								Active Stocks
							</h3>
							<span className="text-[11px] font-mono text-muted-foreground">
								{filteredActiveRoi.length} active stock
								{filteredActiveRoi.length === 1 ? "" : "s"}
							</span>
						</div>

						<div className="rounded-xl border border-border/60 overflow-hidden bg-background/30">
							<Table>
								<TableHeader className="bg-muted/40">
									<TableRow className="border-border/60 hover:bg-transparent text-xs font-semibold text-muted-foreground">
										<TableHead>Stock Name</TableHead>
										<TableHead>Benefit Payout</TableHead>
										<TableHead className="text-right">
											Current Shares & Progress
										</TableHead>
										<TableHead className="text-right">Dividends</TableHead>
										<TableHead className="text-right">APR</TableHead>
										<TableHead className="text-right">Next BB Cost</TableHead>
										<TableHead className="text-right">Next APR</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{roiLoading ? (
										<TableRow>
											<TableCell colSpan={10} className="h-32 text-center">
												<div className="flex items-center justify-center gap-2 text-muted-foreground text-xs">
													<Loader2 className="size-4 animate-spin text-emerald-400" />
													Calculating stock ROI & APR metrics...
												</div>
											</TableCell>
										</TableRow>
									) : filteredActiveRoi.length === 0 ? (
										<TableRow>
											<TableCell
												colSpan={10}
												className="h-24 text-center text-xs text-muted-foreground"
											>
												No active stocks found matching "{roiSearch}".
											</TableCell>
										</TableRow>
									) : (
										filteredActiveRoi.map((item) => (
											<TableRow
												key={item.stockId}
												className={`border-border/40 hover:bg-accent/40 transition-colors text-xs ${
													item.userBlocks > 0
														? "bg-emerald-500/5"
														: item.partialShares > 0
															? "bg-sky-500/5"
															: ""
												}`}
											>
												<TableCell className="font-semibold text-foreground">
													<div className="flex items-center gap-2">
														{item.logo && (
															<img
																src={item.logo}
																alt={item.acronym}
																className="size-5 rounded-md object-contain bg-background p-0.5 border border-border/40"
															/>
														)}
														<div className="space-y-0.5">
															<div className="flex items-center gap-1.5">
																<span>{item.name}</span>
																<Badge
																	variant="outline"
																	className="rounded-md bg-muted/60 text-foreground border-border/60 text-[9px] font-mono font-bold px-1 py-0"
																>
																	{item.acronym}
																</Badge>
															</div>
															<div className="flex items-center gap-1 text-[10px]">
																{item.userBlocks > 0 && (
																	<span className="text-purple-400 font-mono font-bold">
																		Owned {item.userBlocks} block
																		{item.userBlocks === 1 ? "" : "s"}
																	</span>
																)}
															</div>
														</div>
													</div>
												</TableCell>

												<TableCell>
													<div className="space-y-0.5">
														<span
															className="font-semibold text-sky-400 block truncate max-w-[150px]"
															title={item.description}
														>
															{item.description}
														</span>
														<Badge
															variant="outline"
															className="text-[9px] font-mono py-0 px-1.5 border-border/60 text-muted-foreground"
														>
															Every {item.frequency} Days
														</Badge>
													</div>
												</TableCell>

												<TableCell className="text-right font-mono">
													<div className="space-y-1 flex flex-col items-end">
														<div className="flex items-center gap-1.5 text-[11px] font-bold">
															<span className="text-foreground">
																{formatNumber(item.userShares)}
															</span>
														</div>

														<span className="text-[9px] text-muted-foreground block">
															{item.sharesRemainingForNextBlock > 0
																? `${formatNumber(item.sharesRemainingForNextBlock)} left for BB #${item.targetBlockLevel}`
																: `Block #${item.userBlocks} Owned`}
														</span>
													</div>
												</TableCell>

												<TableCell className="text-right font-mono font-semibold text-foreground">
													{formatCurrency(item.realDividendsGotten)}
												</TableCell>

												<TableCell className="text-right font-mono font-bold">
													<Badge
														variant="outline"
														className={`rounded-lg px-2 py-0.5 font-mono text-xs font-bold ${
															item.currentRealizedApr >= 50
																? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
																: item.currentRealizedApr >= 20
																	? "bg-sky-500/20 text-sky-400 border-sky-500/40"
																	: item.currentRealizedApr >= 10
																		? "bg-amber-500/20 text-amber-400 border-amber-500/40"
																		: "bg-muted/50 text-muted-foreground border-border/60"
														}`}
													>
														{item.currentRealizedApr}%
													</Badge>
												</TableCell>

												<TableCell className="text-right font-mono">
													<div className="space-y-0.5">
														<span className="font-bold text-foreground block">
															{formatCurrency(item.nextBlockCost)}
														</span>
														<span className="text-[9px] text-muted-foreground block">
															Block #{item.targetBlockLevel} Cost
														</span>
													</div>
												</TableCell>

												<TableCell className="text-right font-mono font-bold">
													<Badge
														variant="outline"
														className={`rounded-lg px-2 py-0.5 font-mono text-xs font-bold ${
															item.nextBlockApr >= 50
																? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
																: item.nextBlockApr >= 20
																	? "bg-sky-500/20 text-sky-400 border-sky-500/40"
																	: item.nextBlockApr >= 10
																		? "bg-amber-500/20 text-amber-400 border-amber-500/40"
																		: "bg-muted/50 text-muted-foreground border-border/60"
														}`}
													>
														{item.nextBlockApr}%
													</Badge>
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</div>
					</div>

					{/* Passive & Resource Benefits Table (Permanently Last) */}
					<div className="space-y-2 pt-4 border-t border-border/40">
						<div className="flex items-center justify-between">
							<h3 className="text-xs font-bold font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
								Passive Stocks
							</h3>
							<span className="text-[11px] font-mono text-muted-foreground">
								{filteredPassiveRoi.length} passive stock
								{filteredPassiveRoi.length === 1 ? "" : "s"}
							</span>
						</div>

						<div className="rounded-xl border border-border/60 overflow-hidden bg-background/20">
							<Table>
								<TableHeader className="bg-muted/30">
									<TableRow className="border-border/60 hover:bg-transparent text-xs font-semibold text-muted-foreground">
										<TableHead>Stock Name</TableHead>

										<TableHead>Passive Benefit / Perk</TableHead>
										<TableHead className="text-right">
											Owned / Next Increment
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{roiLoading ? (
										<TableRow>
											<TableCell
												colSpan={6}
												className="h-20 text-center text-xs text-muted-foreground"
											>
												Loading passive stocks...
											</TableCell>
										</TableRow>
									) : filteredPassiveRoi.length === 0 ? (
										<TableRow>
											<TableCell
												colSpan={6}
												className="h-20 text-center text-xs text-muted-foreground"
											>
												No passive stocks found matching "{roiSearch}".
											</TableCell>
										</TableRow>
									) : (
										filteredPassiveRoi.map((item) => (
											<TableRow
												key={item.stockId}
												className={`border-border/40 hover:bg-accent/40 transition-colors text-xs ${
													item.userBlocks > 0 ? "bg-purple-500/5" : ""
												}`}
											>
												<TableCell className="font-semibold text-foreground">
													<div className="flex items-center gap-2">
														{item.logo && (
															<img
																src={item.logo}
																alt={item.acronym}
																className="size-5 rounded-md object-contain bg-background p-0.5 border border-border/40"
															/>
														)}
														<div className="space-y-0.5">
															<div className="flex items-center gap-1.5">
																<span>{item.name}</span>
																<Badge
																	variant="outline"
																	className="rounded-md bg-muted/60 text-foreground border-border/60 text-[9px] font-mono font-bold px-1 py-0"
																>
																	{item.acronym}
																</Badge>
															</div>
															<div className="flex items-center gap-1 text-[10px]">
																{item.userBlocks > 0 && (
																	<span className="text-purple-400 font-mono font-bold">
																		Owned {item.userBlocks} block
																		{item.userBlocks === 1 ? "" : "s"}
																	</span>
																)}
															</div>
														</div>
													</div>
												</TableCell>

												<TableCell>
													<div className="space-y-0.5">
														<span
															className="font-medium text-purple-300 block truncate max-w-[240px]"
															title={item.description}
														>
															{item.description}
														</span>
														{item.frequency > 0 && (
															<Badge
																variant="outline"
																className="text-[9px] font-mono py-0 px-1.5 border-border/60 text-muted-foreground"
															>
																Every {item.frequency} Days
															</Badge>
														)}
													</div>
												</TableCell>

												<TableCell className="text-right font-mono">
													{item.userBlocks > 0 ? (
														<Badge
															variant="outline"
															className="rounded-lg bg-purple-500/10 text-purple-400 border-purple-500/30 text-[10px]"
														>
															Owned ({item.userBlocks} block
															{item.userBlocks === 1 ? "" : "s"})
														</Badge>
													) : (
														<span className="text-muted-foreground text-[11px]">
															Next: {formatCurrency(item.nextBlockCost)}
														</span>
													)}
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Filters & Log Table */}
			<Card className="rounded-2xl border-border/60 bg-card/40 backdrop-blur-xl shadow-xs">
				<CardHeader>
					<div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
						<div>
							<CardTitle className="text-base font-bold font-display text-foreground">
								Dividend Records
							</CardTitle>
						</div>

						{/* Quick Date Presets */}
						<div className="flex flex-wrap items-center gap-2">
							<div className="flex items-center rounded-xl bg-background/60 border border-border/60 p-1">
								{["7", "30", "90", "all"].map((d) => (
									<Button
										key={d}
										variant="ghost"
										size="sm"
										onClick={() => {
											setDaysFilter(d);
											setDateRange(undefined);
											setPage(1);
										}}
										className={`h-7 px-2.5 rounded-lg text-xs font-medium cursor-pointer ${
											daysFilter === d && !dateRange
												? "bg-primary/20 text-primary font-semibold"
												: "text-muted-foreground hover:text-foreground"
										}`}
									>
										{d === "all" ? "All Time" : `${d}d`}
									</Button>
								))}
							</div>

							{/* Custom Date Range Popover */}
							<Popover>
								<PopoverTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										className="h-9 rounded-xl text-xs border-border/60 cursor-pointer"
									>
										<CalendarDays className="size-3.5 mr-1.5 text-muted-foreground" />
										{dateRange?.from ? (
											dateRange.to ? (
												<>
													{format(dateRange.from, "LLL dd")} -{" "}
													{format(dateRange.to, "LLL dd")}
												</>
											) : (
												format(dateRange.from, "LLL dd, yyyy")
											)
										) : (
											<span>Pick Custom Range</span>
										)}
									</Button>
								</PopoverTrigger>
								<PopoverContent
									className="w-auto p-0 rounded-2xl border-border/80 bg-background/95 backdrop-blur-2xl shadow-2xl"
									align="end"
								>
									<Calendar
										mode="range"
										defaultMonth={dateRange?.from}
										selected={dateRange}
										onSelect={(range) => {
											setDateRange(range);
											if (range?.from) setPage(1);
										}}
										numberOfMonths={2}
									/>
									{dateRange && (
										<div className="p-3 border-t border-border/60 flex justify-end">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setDateRange(undefined)}
												className="h-7 text-xs text-muted-foreground hover:text-foreground rounded-lg"
											>
												Clear Range
											</Button>
										</div>
									)}
								</PopoverContent>
							</Popover>
						</div>
					</div>

					{/* Filter controls row */}
					<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 pt-4 border-t border-border/40">
						{/* Search Input */}
						<div className="relative">
							<Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
							<Input
								placeholder="Search log ID or ticker..."
								value={searchQuery}
								onChange={(e) => {
									setSearchQuery(e.target.value);
									setPage(1);
								}}
								className="pl-9 h-9 rounded-xl text-xs border-border/60 bg-background/50 focus:bg-background"
							/>
							{searchQuery && (
								<button
									type="button"
									onClick={() => setSearchQuery("")}
									className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
								>
									<X className="size-3.5" />
								</button>
							)}
						</div>

						{/* Stock Filter */}
						<Select
							value={stockIdFilter}
							onValueChange={(val) => {
								setStockIdFilter(val);
								setPage(1);
							}}
						>
							<SelectTrigger className="h-9 rounded-xl text-xs border-border/60 bg-background/50">
								<SelectValue placeholder="All Stocks" />
							</SelectTrigger>
							<SelectContent className="rounded-xl border-border/80 bg-background/95 backdrop-blur-xl">
								<SelectItem value="ALL">All Stocks</SelectItem>
								{state?.allTimeStocks?.map((st) => (
									<SelectItem key={st.stockId} value={String(st.stockId)}>
										{st.acronym} - {st.stockName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>

						{/* Min Value Filter */}
						<Input
							placeholder="Min payout ($)..."
							type="number"
							value={minValFilter}
							onChange={(e) => {
								setMinValFilter(e.target.value);
								setPage(1);
							}}
							className="h-9 rounded-xl text-xs border-border/60 bg-background/50 focus:bg-background"
						/>

						{/* Limit Selector */}
						<Select
							value={String(limit)}
							onValueChange={(val) => {
								setLimit(Number(val));
								setPage(1);
							}}
						>
							<SelectTrigger className="h-9 rounded-xl text-xs border-border/60 bg-background/50">
								<SelectValue placeholder="50 per page" />
							</SelectTrigger>
							<SelectContent className="rounded-xl border-border/80 bg-background/95 backdrop-blur-xl">
								<SelectItem value="25">25 per page</SelectItem>
								<SelectItem value="50">50 per page</SelectItem>
								<SelectItem value="100">100 per page</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</CardHeader>

				<CardContent>
					<div className="rounded-xl border border-border/60 overflow-hidden bg-background/30">
						<Table>
							<TableHeader className="bg-muted/40">
								<TableRow className="border-border/60 hover:bg-transparent">
									<TableHead
										onClick={() => handleSort("timestamp")}
										className="cursor-pointer select-none text-xs font-semibold text-muted-foreground hover:text-foreground"
									>
										<div className="flex items-center gap-1">
											Timestamp
											<ArrowUpDown className="size-3" />
										</div>
									</TableHead>
									<TableHead
										onClick={() => handleSort("stockId")}
										className="cursor-pointer select-none text-xs font-semibold text-muted-foreground hover:text-foreground"
									>
										<div className="flex items-center gap-1">
											Stock Name
											<ArrowUpDown className="size-3" />
										</div>
									</TableHead>

									<TableHead className="text-xs font-semibold text-muted-foreground">
										Payout Yield / Item
									</TableHead>
									<TableHead
										onClick={() => handleSort("value")}
										className="text-right cursor-pointer select-none text-xs font-semibold text-muted-foreground hover:text-foreground"
									>
										<div className="flex items-center justify-end gap-1">
											Total Value ($)
											<ArrowUpDown className="size-3" />
										</div>
									</TableHead>
									<TableHead className="text-right text-xs font-semibold text-muted-foreground">
										Action
									</TableHead>
								</TableRow>
							</TableHeader>

							<TableBody>
								{isLoadingLogs ? (
									<TableRow>
										<TableCell colSpan={6} className="h-32 text-center">
											<div className="flex items-center justify-center gap-2 text-muted-foreground text-xs">
												<Loader2 className="size-4 animate-spin text-primary" />
												Loading dividend logs...
											</div>
										</TableCell>
									</TableRow>
								) : logs.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6} className="h-32 text-center">
											<div className="flex flex-col items-center justify-center gap-1 text-muted-foreground text-xs">
												<AlertCircle className="size-5 opacity-40 mb-1" />
												<span>
													No stock dividend logs found for current filters.
												</span>
											</div>
										</TableCell>
									</TableRow>
								) : (
									logs.map((log) => {
										const logo =
											stockLogoMap.get(log.acronym) ??
											stockLogoMap.get(String(log.stockId)) ??
											null;
										return (
											<TableRow
												key={log.id}
												className="border-border/40 hover:bg-accent/40 transition-colors text-xs"
											>
												<TableCell className="font-mono text-muted-foreground whitespace-nowrap">
													{formatTimestamp(log.timestamp)}
												</TableCell>
												<TableCell className="font-semibold text-foreground">
													<div className="flex items-center gap-2">
														{logo && (
															<img
																src={logo}
																alt={log.acronym}
																className="size-5 rounded-md object-contain bg-background p-0.5 border border-border/40"
															/>
														)}
														<div className="space-y-0.5">
															<div className="flex items-center gap-1.5">
																<span
																	className="truncate max-w-[160px]"
																	title={log.stockName}
																>
																	{log.stockName}
																</span>
																<Badge
																	variant="outline"
																	className="rounded-md bg-muted/60 text-foreground border-border/60 text-[9px] font-mono font-bold px-1 py-0"
																>
																	{log.acronym}
																</Badge>
															</div>
														</div>
													</div>
												</TableCell>

												<TableCell>
													{log.itemName ? (
														<span className="inline-flex items-center gap-1.5 font-medium text-sky-400">
															<Package className="size-3.5" />
															{log.itemName}
														</span>
													) : (
														<span className="inline-flex items-center gap-1.5 font-medium text-emerald-400">
															<Coins className="size-3.5" />
															Cash Payout
														</span>
													)}
												</TableCell>
												<TableCell className="text-right font-mono font-bold text-emerald-400 whitespace-nowrap">
													{formatCurrency(log.value)}
												</TableCell>
												<TableCell className="text-right whitespace-nowrap">
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setSelectedLog(log)}
														className="h-7 px-2 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60"
													>
														<Eye className="size-3.5 mr-1" /> View
													</Button>
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>

					{/* Pagination Footer */}
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 text-xs text-muted-foreground">
						<div>
							Showing{" "}
							<span className="font-mono font-bold text-foreground">
								{logs.length}
							</span>{" "}
							of{" "}
							<span className="font-mono font-bold text-foreground">
								{formatNumber(totalLogsCount)}
							</span>{" "}
							dividend records
						</div>

						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={page <= 1 || isLoadingLogs}
								onClick={() => setPage((p) => Math.max(1, p - 1))}
								className="h-8 rounded-xl border-border/60 text-xs cursor-pointer"
							>
								<ChevronLeft className="size-3.5 mr-1" /> Previous
							</Button>

							<span className="font-mono px-2 text-xs">
								Page {page} of {totalPages}
							</span>

							<Button
								variant="outline"
								size="sm"
								disabled={page >= totalPages || isLoadingLogs}
								onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
								className="h-8 rounded-xl border-border/60 text-xs cursor-pointer"
							>
								Next <ChevronRight className="size-3.5 ml-1" />
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Detail Dialog Modal */}
			<Dialog
				open={Boolean(selectedLog)}
				onOpenChange={(open) => !open && setSelectedLog(null)}
			>
				<DialogContent className="sm:max-w-md rounded-2xl border-border/80 bg-background/95 backdrop-blur-2xl shadow-2xl">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-lg font-bold font-display">
							<Badge
								variant="outline"
								className="rounded-lg bg-emerald-500/10 text-emerald-400 border-emerald-500/30 font-mono text-xs font-bold"
							>
								{selectedLog?.acronym}
							</Badge>
							<span>{selectedLog?.stockName}</span>
						</DialogTitle>
						<DialogDescription className="text-xs">
							Detailed payload inspection for dividend log #{selectedLog?.id}
						</DialogDescription>
					</DialogHeader>

					{selectedLog && (
						<div className="space-y-4 pt-2 text-xs">
							<div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-muted/30 border border-border/50 font-mono">
								<div>
									<span className="text-muted-foreground block text-[10px]">
										LOG ID
									</span>
									<span className="font-semibold text-foreground">
										{selectedLog.id}
									</span>
								</div>
								<div>
									<span className="text-muted-foreground block text-[10px]">
										STOCK ID
									</span>
									<span className="font-semibold text-foreground">
										#{selectedLog.stockId}
									</span>
								</div>
								<div>
									<span className="text-muted-foreground block text-[10px]">
										TIMESTAMP
									</span>
									<span className="font-semibold text-foreground">
										{formatTimestamp(selectedLog.timestamp)}
									</span>
								</div>
								<div>
									<span className="text-muted-foreground block text-[10px]">
										PAYOUT VALUE
									</span>
									<span className="font-bold text-emerald-400">
										{formatCurrency(selectedLog.value)}
									</span>
								</div>
							</div>

							{selectedLog.itemName && (
								<div className="p-3.5 rounded-xl bg-sky-500/10 border border-sky-500/20 space-y-1">
									<span className="text-[10px] font-mono text-sky-400 font-semibold uppercase">
										Item Benefit Payout
									</span>
									<p className="text-xs font-bold text-foreground flex items-center gap-1.5">
										<Package className="size-4 text-sky-400" />
										{selectedLog.itemName}
									</p>
								</div>
							)}

							<div className="flex justify-end pt-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										navigator.clipboard.writeText(
											JSON.stringify(selectedLog, null, 2),
										);
										toast.success("Copied", {
											description: "Log payload copied to clipboard.",
										});
									}}
									className="rounded-xl h-8 text-xs border-border/60 cursor-pointer"
								>
									<Copy className="size-3 mr-1.5" /> Copy JSON
								</Button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
