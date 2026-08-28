import { format } from "date-fns";
import {
	ArrowDownRight,
	ArrowUpRight,
	Building2,
	ChevronLeft,
	ChevronRight,
	Coins,
	Fingerprint,
	History,
	Loader2,
	Play,
	RefreshCw,
	RotateCcw,
	Search,
	Sparkles,
	TrendingUp,
	Wallet,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Progress } from "@/components/ui/progress";
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

// --- Types & Interfaces ---

export interface WealthState {
	init: boolean;
	initTimestamp: number | null;
	status: string;
	lastSyncTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totals: {
		totalInflow: number;
		totalOutflow: number;
		netProfit: number;
		crimesInflow: number;
		stocksInflow: number;
		companyInflow: number;
		companyOutflow: number;
		otherInflow: number;
	};
	totalEventsIndexed: number;
}

export interface WealthTimelinePoint {
	date: string;
	inflow: number;
	outflow: number;
	netProfit: number;
	cumulative: number;
	count: number;
}

export interface LedgerEventItem {
	id: string;
	logId: string | null;
	timestamp: string | number;
	type: string;
	categoryId: number;
	transactionName: string;
	assetsAffected: unknown;
	cashFlow: number;
	realizedPnl: number;
	createdAt: string | number;
}

const chartConfig: ChartConfig = {
	inflow: {
		label: "Inflow ($)",
		color: "hsl(142, 76%, 45%)",
	},
	cumulative: {
		label: "Cumulative Net ($)",
		color: "hsl(199, 89%, 48%)",
	},
};

function formatMoney(amount: number): string {
	if (Math.abs(amount) >= 1_000_000_000) {
		return `$${(amount / 1_000_000_000).toFixed(2)}B`;
	}
	if (Math.abs(amount) >= 1_000_000) {
		return `$${(amount / 1_000_000).toFixed(2)}M`;
	}
	if (Math.abs(amount) >= 10_000) {
		return `$${(amount / 1_000).toFixed(1)}k`;
	}
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(amount);
}

function formatFullMoney(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(amount);
}

export function WealthPage() {
	const { path } = useRouter();
	const { setPageReady } = useGlobalLoading();

	// State
	const [wealthState, setWealthState] = useState<WealthState | null>(null);
	const [timeline, setTimeline] = useState<WealthTimelinePoint[]>([]);
	const [ledgerEventsList, setLedgerEventsList] = useState<LedgerEventItem[]>(
		[],
	);
	const [totalEvents, setTotalEvents] = useState<number>(0);
	const [totalPages, setTotalPages] = useState<number>(1);
	const [page, setPage] = useState<number>(1);
	const [limit, _setLimit] = useState<number>(25);

	// Filters
	const [typeFilter, setTypeFilter] = useState<string>("ALL");
	const [searchQuery, setSearchQuery] = useState<string>("");
	const [debouncedSearch, setDebouncedSearch] = useState<string>("");

	// UI Loading
	const [isLoadingState, setIsLoadingState] = useState<boolean>(true);
	const [isLoadingTimeline, setIsLoadingTimeline] = useState<boolean>(true);
	const [isLoadingLedger, setIsLoadingLedger] = useState<boolean>(true);
	const [isInitializing, setIsInitializing] = useState<boolean>(false);
	const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
	const [showResetDialog, setShowResetDialog] = useState<boolean>(false);

	// Debounce search
	useEffect(() => {
		const handler = setTimeout(() => {
			setDebouncedSearch(searchQuery);
			setPage(1);
		}, 300);
		return () => clearTimeout(handler);
	}, [searchQuery]);

	// Fetch Wealth State
	const fetchWealthState = useCallback(async () => {
		try {
			const res = await fetch("/api/v1/system/wealth/state");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as WealthState;
			setWealthState(data);
		} catch (err) {
			console.error("Failed to load wealth state:", err);
		} finally {
			setIsLoadingState(false);
		}
	}, []);

	// Fetch Timeline Data
	const fetchTimeline = useCallback(async () => {
		setIsLoadingTimeline(true);
		try {
			const res = await fetch("/api/v1/system/wealth/timeline");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { timeline: WealthTimelinePoint[] };
			setTimeline(data.timeline || []);
		} catch (err) {
			console.error("Failed to load wealth timeline:", err);
		} finally {
			setIsLoadingTimeline(false);
		}
	}, []);

	// Fetch Paginated Ledger Events
	const fetchLedger = useCallback(async () => {
		setIsLoadingLedger(true);
		try {
			const params = new URLSearchParams({
				page: page.toString(),
				limit: limit.toString(),
			});

			if (typeFilter && typeFilter !== "ALL") {
				params.set("type", typeFilter);
			}

			if (debouncedSearch.trim()) {
				params.set("search", debouncedSearch.trim());
			}

			const res = await fetch(
				`/api/v1/system/wealth/ledger?${params.toString()}`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				events: LedgerEventItem[];
				total: number;
				totalPages: number;
			};
			setLedgerEventsList(data.events || []);
			setTotalEvents(data.total || 0);
			setTotalPages(data.totalPages || 1);
		} catch (err) {
			console.error("Failed to load wealth ledger:", err);
		} finally {
			setIsLoadingLedger(false);
		}
	}, [page, limit, typeFilter, debouncedSearch]);

	// Initial Load
	useEffect(() => {
		fetchWealthState();
		fetchTimeline();
		fetchLedger();
	}, [fetchWealthState, fetchTimeline, fetchLedger]);

	useEffect(() => {
		if (!isLoadingState) {
			setPageReady(path);
		}
	}, [isLoadingState, path, setPageReady]);

	// Initialize Wealth Tracking
	const handleInitWealth = async (customTimestampSec?: number) => {
		setIsInitializing(true);
		try {
			const res = await fetch("/api/v1/system/wealth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					customTimestampSec ? { timestamp: customTimestampSec } : {},
				),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			toast.success("Wealth tracking initialized successfully.");
			setShowResetDialog(false);
			await Promise.all([fetchWealthState(), fetchTimeline(), fetchLedger()]);
		} catch (err) {
			console.error("Failed to init wealth tracking:", err);
			toast.error("Failed to initialize wealth tracking.");
		} finally {
			setIsInitializing(false);
		}
	};

	const handleRefresh = async () => {
		setIsRefreshing(true);
		await Promise.all([fetchWealthState(), fetchTimeline(), fetchLedger()]);
		setIsRefreshing(false);
		toast.success("Wealth data synchronized.");
	};

	const initDateFormatted = useMemo(() => {
		if (!wealthState?.initTimestamp) return null;
		return format(
			new Date(wealthState.initTimestamp * 1000),
			"MMM dd, yyyy HH:mm:ss",
		);
	}, [wealthState?.initTimestamp]);

	return (
		<div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-[1600px] mx-auto animate-in fade-in duration-300">
			{/* --- Header --- */}
			<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-end">
				{/* Controls */}
				<div className="flex flex-wrap items-center gap-2">
					{wealthState?.init && (
						<Button
							variant="outline"
							size="sm"
							className="h-9 gap-1.5 text-xs border-border/60 text-muted-foreground hover:text-foreground"
							onClick={() => setShowResetDialog(true)}
						>
							<RotateCcw className="size-3.5" />
							Reset Init Time
						</Button>
					)}
					<Button
						variant="outline"
						size="sm"
						className="h-9 gap-1.5 text-xs border-border/60"
						onClick={handleRefresh}
						disabled={isRefreshing}
					>
						<RefreshCw
							className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
						/>
						<span className="hidden sm:inline">Refresh</span>
					</Button>
				</div>
			</div>

			{/* --- Initialization Gate Banner --- */}
			{!isLoadingState && !wealthState?.init && (
				<Card className="border-primary/30 bg-primary/5 backdrop-blur-xs relative overflow-hidden shadow-lg p-6">
					<div className="flex flex-col md:flex-row items-center justify-between gap-6">
						<div className="space-y-2 text-center md:text-left">
							<div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-medium">
								<Sparkles className="size-3.5" />
								Initialization Required
							</div>
						</div>

						<Button
							size="lg"
							className="gap-2 font-semibold shadow-lg shadow-primary/20 shrink-0"
							onClick={() => handleInitWealth()}
							disabled={isInitializing}
						>
							{isInitializing ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Play className="size-4 fill-current" />
							)}
							Initialize Wealth Tracking
						</Button>
					</div>
				</Card>
			)}

			{/* --- Wealth Active Tracking Content --- */}
			{wealthState?.init && (
				<>
					{/* Init Info Subtitle Banner */}
					<div className="flex items-center justify-between p-3 rounded-xl border border-border/60 bg-muted/20 text-xs text-muted-foreground font-mono">
						<div className="flex items-center gap-2">
							<History className="size-4 text-primary" />
							<span>
								Tracking active since:{" "}
								<span className="text-foreground font-bold">
									{initDateFormatted}
								</span>
							</span>
						</div>
						<div>
							Events Processed:{" "}
							<span className="text-foreground font-bold">
								{wealthState.totalEventsIndexed.toLocaleString()}
							</span>
						</div>
					</div>

					{/* --- KPI Financial Cards --- */}
					<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
						{/* Net Profit Card */}
						<Card className="border-border/60 bg-card/60 backdrop-blur-xs relative overflow-hidden shadow-xs">
							<div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl -mr-6 -mt-6 pointer-events-none" />
							<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
								<CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
									Net Capital Profit
								</CardTitle>
								<div className="size-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
									<Wallet className="size-4" />
								</div>
							</CardHeader>
							<CardContent className="space-y-1">
								<div className="text-2xl font-bold font-mono text-emerald-400">
									{formatFullMoney(wealthState.totals.netProfit)}
								</div>
								<p className="text-[11px] text-muted-foreground">
									Total Inflow minus Outflow since init
								</p>
							</CardContent>
						</Card>

						{/* Total Inflow Card */}
						<Card className="border-border/60 bg-card/60 backdrop-blur-xs relative overflow-hidden shadow-xs">
							<div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl -mr-6 -mt-6 pointer-events-none" />
							<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
								<CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
									Total Inflow
								</CardTitle>
								<div className="size-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
									<ArrowUpRight className="size-4" />
								</div>
							</CardHeader>
							<CardContent className="space-y-1">
								<div className="text-2xl font-bold font-mono text-cyan-400">
									+{formatFullMoney(wealthState.totals.totalInflow)}
								</div>
								<p className="text-[11px] text-muted-foreground">
									Crimes + Stocks + Company Inflow
								</p>
							</CardContent>
						</Card>

						{/* Total Outflow Card */}
						<Card className="border-border/60 bg-card/60 backdrop-blur-xs relative overflow-hidden shadow-xs">
							<div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/10 rounded-full blur-2xl -mr-6 -mt-6 pointer-events-none" />
							<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
								<CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
									Total Outflow
								</CardTitle>
								<div className="size-8 rounded-lg bg-rose-500/10 text-rose-400 flex items-center justify-center">
									<ArrowDownRight className="size-4" />
								</div>
							</CardHeader>
							<CardContent className="space-y-1">
								<div className="text-2xl font-bold font-mono text-rose-400">
									-{formatFullMoney(wealthState.totals.totalOutflow)}
								</div>
								<p className="text-[11px] text-muted-foreground">
									Company wages and expenses
								</p>
							</CardContent>
						</Card>

						{/* Crime Rewards Inflow */}
						<Card className="border-border/60 bg-card/60 backdrop-blur-xs relative overflow-hidden shadow-xs">
							<div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl -mr-6 -mt-6 pointer-events-none" />
							<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
								<CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
									Crime Inflow (Since Init)
								</CardTitle>
								<div className="size-8 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
									<Fingerprint className="size-4" />
								</div>
							</CardHeader>
							<CardContent className="space-y-1">
								<div className="text-2xl font-bold font-mono text-amber-400">
									+{formatFullMoney(wealthState.totals.crimesInflow)}
								</div>
								<p className="text-[11px] text-muted-foreground">
									Illicit loot & cash generated
								</p>
							</CardContent>
						</Card>
					</div>

					{/* --- Inflow Sources Breakdown Grid --- */}
					<div className="grid gap-4 grid-cols-1 md:grid-cols-3">
						{/* Crimes Breakdown Card */}
						<div className="p-4 rounded-xl border border-border/60 bg-card/60 backdrop-blur-xs space-y-3 shadow-xs">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div className="size-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
										<Fingerprint className="size-4" />
									</div>
									<div>
										<h3 className="font-semibold text-sm">Crimes Inflow</h3>
										<p className="text-[11px] text-muted-foreground">
											Loot & Cash Heists
										</p>
									</div>
								</div>
								<span className="text-base font-bold font-mono text-emerald-400">
									+{formatMoney(wealthState.totals.crimesInflow)}
								</span>
							</div>
							<Progress
								value={
									wealthState.totals.totalInflow > 0
										? (wealthState.totals.crimesInflow /
												wealthState.totals.totalInflow) *
											100
										: 0
								}
								className="h-1.5 bg-muted/50"
							/>
						</div>

						{/* Stocks Breakdown Card */}
						<div className="p-4 rounded-xl border border-border/60 bg-card/60 backdrop-blur-xs space-y-3 shadow-xs">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div className="size-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
										<TrendingUp className="size-4" />
									</div>
									<div>
										<h3 className="font-semibold text-sm">Stock Dividends</h3>
										<p className="text-[11px] text-muted-foreground">
											Benefit Block Payouts
										</p>
									</div>
								</div>
								<span className="text-base font-bold font-mono text-cyan-400">
									+{formatMoney(wealthState.totals.stocksInflow)}
								</span>
							</div>
							<Progress
								value={
									wealthState.totals.totalInflow > 0
										? (wealthState.totals.stocksInflow /
												wealthState.totals.totalInflow) *
											100
										: 0
								}
								className="h-1.5 bg-muted/50"
							/>
						</div>

						{/* Company Breakdown Card */}
						<div className="p-4 rounded-xl border border-border/60 bg-card/60 backdrop-blur-xs space-y-3 shadow-xs">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div className="size-8 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
										<Building2 className="size-4" />
									</div>
									<div>
										<h3 className="font-semibold text-sm">Company Profit</h3>
										<p className="text-[11px] text-muted-foreground">
											+{formatMoney(wealthState.totals.companyInflow)} / -
											{formatMoney(wealthState.totals.companyOutflow)}
										</p>
									</div>
								</div>
								<span className="text-base font-bold font-mono text-purple-400">
									{formatMoney(
										wealthState.totals.companyInflow -
											wealthState.totals.companyOutflow,
									)}
								</span>
							</div>
							<Progress
								value={
									wealthState.totals.totalInflow > 0
										? (wealthState.totals.companyInflow /
												wealthState.totals.totalInflow) *
											100
										: 0
								}
								className="h-1.5 bg-muted/50"
							/>
						</div>
					</div>

					{/* --- Interactive Wealth Growth Curve Chart --- */}
					<Card className="border-border/60 bg-card/60 backdrop-blur-xs shadow-xs">
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<div className="space-y-1">
								<CardTitle className="text-base font-semibold flex items-center gap-2">
									<TrendingUp className="size-4 text-emerald-400" />
									Capital Growth & Daily Inflow
								</CardTitle>
								<CardDescription className="text-xs">
									Daily capital additions and cumulative wealth growth since
									init timestamp
								</CardDescription>
							</div>
						</CardHeader>
						<CardContent className="pt-2">
							{isLoadingTimeline ? (
								<div className="h-[280px] flex items-center justify-center">
									<Loader2 className="size-6 text-muted-foreground animate-spin" />
								</div>
							) : timeline.length === 0 ? (
								<div className="h-[280px] flex flex-col items-center justify-center text-center p-4">
									<Coins className="size-8 text-muted-foreground/40 mb-2" />
									<p className="text-xs text-muted-foreground">
										No financial events recorded since initialization yet. New
										incoming logs will populate this curve in real-time.
									</p>
								</div>
							) : (
								<div className="h-[280px] w-full">
									<ChartContainer
										config={chartConfig}
										className="h-[280px] w-full"
									>
										<AreaChart
											data={timeline}
											margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
										>
											<defs>
												<linearGradient
													id="wealthGrad"
													x1="0"
													y1="0"
													x2="0"
													y2="1"
												>
													<stop
														offset="5%"
														stopColor="rgb(16, 185, 129)"
														stopOpacity={0.4}
													/>
													<stop
														offset="95%"
														stopColor="rgb(16, 185, 129)"
														stopOpacity={0.0}
													/>
												</linearGradient>
											</defs>
											<CartesianGrid
												strokeDasharray="3 3"
												className="stroke-border/40"
												vertical={false}
											/>
											<XAxis
												dataKey="date"
												tickLine={false}
												axisLine={false}
												tickMargin={8}
											/>
											<YAxis
												tickLine={false}
												axisLine={false}
												tickMargin={8}
												tickFormatter={(val) => formatMoney(val)}
												width={60}
											/>
											<ChartTooltip
												content={({ active, payload }) => {
													if (!active || !payload?.length) return null;
													const data = payload[0]
														?.payload as WealthTimelinePoint;
													return (
														<div className="rounded-lg border border-border/80 bg-background/95 p-3 shadow-xl backdrop-blur-md text-xs space-y-1.5">
															<div className="font-semibold text-foreground">
																{data.date}
															</div>
															<div className="flex items-center justify-between gap-4">
																<span className="text-muted-foreground">
																	Daily Inflow:
																</span>
																<span className="font-mono font-bold text-emerald-400">
																	+{formatFullMoney(data.inflow)}
																</span>
															</div>
															<div className="flex items-center justify-between gap-4">
																<span className="text-muted-foreground">
																	Cumulative Net:
																</span>
																<span className="font-mono font-bold text-cyan-400">
																	{formatFullMoney(data.cumulative)}
																</span>
															</div>
														</div>
													);
												}}
											/>
											<Area
												type="monotone"
												dataKey="cumulative"
												stroke="rgb(16, 185, 129)"
												strokeWidth={2}
												fillOpacity={1}
												fill="url(#wealthGrad)"
											/>
										</AreaChart>
									</ChartContainer>
								</div>
							)}
						</CardContent>
					</Card>

					{/* --- Unified Financial Ledger Table --- */}
					<Card className="border-border/60 bg-card/60 backdrop-blur-xs shadow-xs">
						<CardHeader>
							<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
								<div className="space-y-1">
									<CardTitle className="text-base font-semibold flex items-center gap-2">
										<History className="size-4 text-primary" />
										Unified Financial Ledger Feed
									</CardTitle>
									<CardDescription className="text-xs">
										Chronological log of all transactions and cash flow events
										occurring from init timestamp onwards
									</CardDescription>
								</div>

								{/* Filters */}
								<div className="flex flex-wrap items-center gap-2">
									<div className="relative w-full sm:w-56">
										<Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
										<Input
											placeholder="Search transaction..."
											value={searchQuery}
											onChange={(e) => setSearchQuery(e.target.value)}
											className="pl-8 h-9 text-xs border-border/60 bg-background/60"
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

									<Select
										value={typeFilter}
										onValueChange={(val) => {
											setTypeFilter(val);
											setPage(1);
										}}
									>
										<SelectTrigger className="h-9 text-xs w-[140px] border-border/60 bg-background/60">
											<SelectValue placeholder="Event Type" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="ALL">All Categories</SelectItem>
											<SelectItem value="crime_reward">Crimes</SelectItem>
											<SelectItem value="stock_dividend">Stocks</SelectItem>
											<SelectItem value="injection">Company Inflow</SelectItem>
											<SelectItem value="loss">Company Outflow</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>
						</CardHeader>
						<CardContent>
							<div className="rounded-xl border border-border/60 overflow-hidden bg-background/40">
								<Table>
									<TableHeader className="bg-muted/40">
										<TableRow className="hover:bg-transparent border-border/60">
											<TableHead className="text-xs font-semibold">
												Timestamp
											</TableHead>
											<TableHead className="text-xs font-semibold">
												Category
											</TableHead>
											<TableHead className="text-xs font-semibold">
												Transaction Name
											</TableHead>
											<TableHead className="text-xs font-semibold text-right">
												Cash Flow
											</TableHead>
											<TableHead className="text-xs font-semibold text-right">
												Realized Impact
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{isLoadingLedger ? (
											<TableRow>
												<TableCell colSpan={5} className="h-32 text-center">
													<Loader2 className="size-5 text-muted-foreground animate-spin mx-auto" />
												</TableCell>
											</TableRow>
										) : ledgerEventsList.length === 0 ? (
											<TableRow>
												<TableCell
													colSpan={5}
													className="h-32 text-center text-xs text-muted-foreground"
												>
													No ledger events recorded yet since initialization.
												</TableCell>
											</TableRow>
										) : (
											ledgerEventsList.map((ev) => {
												const evDate = new Date(
													typeof ev.timestamp === "number" &&
														ev.timestamp < 1e11
														? ev.timestamp * 1000
														: ev.timestamp,
												);
												const isPositive = ev.realizedPnl >= 0;

												return (
													<TableRow
														key={ev.id}
														className="hover:bg-muted/30 border-border/40 transition-colors"
													>
														<TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
															{format(evDate, "yyyy-MM-dd HH:mm:ss")}
														</TableCell>
														<TableCell className="text-xs whitespace-nowrap">
															<Badge
																variant="outline"
																className={`text-[10px] uppercase font-mono ${
																	ev.type === "crime_reward"
																		? "border-emerald-500/30 text-emerald-400 bg-emerald-500/5"
																		: ev.type === "stock_dividend"
																			? "border-cyan-500/30 text-cyan-400 bg-cyan-500/5"
																			: "border-purple-500/30 text-purple-400 bg-purple-500/5"
																}`}
															>
																{ev.type.replace("_", " ")}
															</Badge>
														</TableCell>
														<TableCell className="text-xs text-foreground/90 font-medium">
															{ev.transactionName}
														</TableCell>
														<TableCell className="text-xs font-mono text-right whitespace-nowrap text-muted-foreground">
															{formatMoney(ev.cashFlow)}
														</TableCell>
														<TableCell className="text-xs font-mono text-right whitespace-nowrap">
															<span
																className={`font-bold ${
																	isPositive
																		? "text-emerald-400"
																		: "text-rose-400"
																}`}
															>
																{isPositive ? "+" : ""}
																{formatFullMoney(ev.realizedPnl)}
															</span>
														</TableCell>
													</TableRow>
												);
											})
										)}
									</TableBody>
								</Table>
							</div>

							{/* Pagination Footer */}
							<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-4 text-xs text-muted-foreground">
								<div>
									Showing{" "}
									<span className="font-medium text-foreground">
										{ledgerEventsList.length}
									</span>{" "}
									of{" "}
									<span className="font-medium text-foreground">
										{totalEvents.toLocaleString()}
									</span>{" "}
									transactions
								</div>

								<div className="flex items-center gap-2 self-end sm:self-auto">
									<Button
										variant="outline"
										size="sm"
										className="h-8 text-xs gap-1 border-border/60"
										disabled={page <= 1 || isLoadingLedger}
										onClick={() => setPage((p) => Math.max(1, p - 1))}
									>
										<ChevronLeft className="size-3.5" />
										Prev
									</Button>
									<span className="text-xs font-mono px-2">
										{page} / {Math.max(1, totalPages)}
									</span>
									<Button
										variant="outline"
										size="sm"
										className="h-8 text-xs gap-1 border-border/60"
										disabled={page >= totalPages || isLoadingLedger}
										onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
									>
										Next
										<ChevronRight className="size-3.5" />
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>
				</>
			)}

			{/* --- Reset Init Timestamp Dialog --- */}
			<Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
				<DialogContent className="sm:max-w-md border-border/80 bg-background/95 backdrop-blur-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-base font-bold">
							<RotateCcw className="size-4 text-amber-400" />
							Reset Wealth Tracking Time
						</DialogTitle>
						<DialogDescription className="text-xs">
							Resetting the initialization time will start wealth tracking from
							the new timestamp.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-3 py-2 text-xs">
						<p className="text-muted-foreground">
							Are you sure you want to reset the wealth tracking init time to
							the current moment?
						</p>
					</div>

					<DialogFooter className="gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setShowResetDialog(false)}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							className="bg-amber-500 hover:bg-amber-600 text-black font-semibold"
							onClick={() => handleInitWealth()}
							disabled={isInitializing}
						>
							{isInitializing ? (
								<Loader2 className="size-3.5 animate-spin mr-1" />
							) : null}
							Reset to Now
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
