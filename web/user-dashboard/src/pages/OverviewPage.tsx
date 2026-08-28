import {
	Activity,
	CheckCircle2,
	Cpu,
	RotateCw,
	Search,
	ShieldCheck,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
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
import { useGlobalLoading } from "@/contexts/LoadingContext";
import { type LogEntry, useHostTelemetry } from "@/hooks/useHostTelemetry";
import { useRouter } from "@/router";

export interface ServiceViewItem {
	id: "api" | "bot" | "scheduler";
	name: string;
	category: "api" | "bot" | "worker";
	status: "healthy" | "offline";
	uptime: string;
	pid: number | null;
	cpuUsage: number | null;
	memoryUsageMb: number | null;
	heapUsageMb: number | null;
	latencyMs: number | null;
	recentLogs: LogEntry[];
}

export interface HistoricalTelemetryPoint {
	timestamp: string;
	timeValue: number;
	formattedTime: string;
	totalRssMb: number;
	totalHeapMb: number;
	apiRssMb: number;
	apiHeapMb: number;
	apiCpu: number;
	apiLatency: number;
	schedulerRssMb: number;
	schedulerHeapMb: number;
	schedulerCpu: number;
	schedulerLatency: number;
	botRssMb: number;
	botHeapMb: number;
	botCpu: number;
	botLatency: number;
}

type TimeRange = "live" | "1h" | "6h" | "24h" | "7d";
type MetricTab = "rss" | "heap" | "cpu" | "latency";

function formatUptime(seconds: number | null | undefined): string {
	if (seconds === undefined || seconds === null || seconds < 0)
		return "Offline";
	const totalSecs = Math.floor(seconds);
	if (totalSecs === 0) return "0s";
	const d = Math.floor(totalSecs / 86400);
	const h = Math.floor((totalSecs % 86400) / 3600);
	const m = Math.floor((totalSecs % 3600) / 60);
	const s = totalSecs % 60;
	if (d > 0) return `${d}d ${h}h ${m}m`;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

interface CustomTooltipProps {
	active?: boolean;
	payload?: Array<{
		name: string;
		value: number;
		color: string;
		dataKey: string;
	}>;
	label?: string;
	metricTab: MetricTab;
}

function CustomChartTooltip({
	active,
	payload,
	label,
	metricTab,
}: CustomTooltipProps) {
	if (!active || !payload || payload.length === 0) return null;

	const unit =
		metricTab === "rss" || metricTab === "heap"
			? "MB"
			: metricTab === "cpu"
				? "%"
				: "ms";

	return (
		<div className="rounded-xl border border-border/80 bg-background/90 p-3 shadow-2xl backdrop-blur-xl font-mono text-xs space-y-2 min-w-[200px]">
			<div className="border-b border-border/50 pb-1 flex items-center justify-between text-[11px] text-muted-foreground">
				<span>{label}</span>
				<span className="text-[10px] uppercase font-bold text-primary">
					{metricTab === "rss"
						? "Memory (RSS)"
						: metricTab === "heap"
							? "JS Active Heap"
							: metricTab === "cpu"
								? "CPU Usage"
								: "IPC Latency"}
				</span>
			</div>
			<div className="space-y-1.5 pt-0.5">
				{payload.map((entry) => (
					<div
						key={entry.dataKey}
						className="flex items-center justify-between gap-4"
					>
						<div className="flex items-center gap-1.5">
							<span
								className="size-2 rounded-full"
								style={{ backgroundColor: entry.color }}
							/>
							<span className="text-foreground/90 font-medium">
								{entry.name}
							</span>
						</div>
						<span className="font-bold text-foreground">
							{entry.value} {unit}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

export function OverviewPage() {
	const { path } = useRouter();
	const { setPageReady } = useGlobalLoading();
	const telemetry = useHostTelemetry();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedServiceForLogs, setSelectedServiceForLogs] =
		useState<ServiceViewItem | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);

	// Historical metrics state: defaults to "live"
	const [historyRange, setHistoryRange] = useState<TimeRange>("live");
	const [activeMetricTab, setActiveMetricTab] = useState<MetricTab>("rss");
	const [historyPoints, setHistoryPoints] = useState<
		HistoricalTelemetryPoint[]
	>([]);
	const [livePoints, setLivePoints] = useState<HistoricalTelemetryPoint[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);

	const fetchHistory = useCallback(
		async (range: "1h" | "6h" | "24h" | "7d") => {
			try {
				setIsLoadingHistory(true);
				const res = await fetch(`/api/telemetry/history?range=${range}`, {
					headers: { "X-Client-App": "user-dashboard" },
					cache: "no-store",
				});
				if (res.ok) {
					const json = (await res.json()) as {
						success: boolean;
						points: HistoricalTelemetryPoint[];
					};
					if (json.success && Array.isArray(json.points)) {
						setHistoryPoints(json.points);
					}
				}
			} catch {
				// history fetch error
			} finally {
				setIsLoadingHistory(false);
			}
		},
		[],
	);

	// Seed livePoints with recent historical points on initial load
	useEffect(() => {
		void (async () => {
			try {
				const res = await fetch("/api/telemetry/history?range=1h", {
					headers: { "X-Client-App": "user-dashboard" },
					cache: "no-store",
				});
				if (res.ok) {
					const json = (await res.json()) as {
						success: boolean;
						points: HistoricalTelemetryPoint[];
					};
					if (json.success && Array.isArray(json.points)) {
						setLivePoints(json.points.slice(-20));
					}
				}
			} catch {
				// ignore seed error
			}
		})();
	}, []);

	// Fetch history whenever range is a historical window
	useEffect(() => {
		if (historyRange !== "live") {
			void fetchHistory(historyRange);
		}
	}, [historyRange, fetchHistory]);

	// Continuous Live Streaming data collector
	useEffect(() => {
		if (!telemetry.lastChecked || telemetry.status === "connecting") return;

		const api = telemetry.services.find((s) => s.id === "api");
		const bot = telemetry.services.find((s) => s.id === "bot");
		const scheduler = telemetry.services.find((s) => s.id === "scheduler");

		const now = telemetry.lastChecked.getTime();
		const timeFormatted = telemetry.lastChecked.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});

		const pt: HistoricalTelemetryPoint = {
			timestamp: telemetry.lastChecked.toISOString(),
			timeValue: now,
			formattedTime: timeFormatted,
			totalRssMb: telemetry.totalRssMb || 0,
			totalHeapMb: telemetry.totalHeapUsedMb || 0,
			apiRssMb:
				api?.status === "online"
					? (api.memory.rssMb ??
						Number((api.memory.rssBytes / 1024 / 1024).toFixed(1)))
					: 0,
			apiHeapMb:
				api?.status === "online"
					? (api.memory.heapUsedMb ??
						Number((api.memory.heapUsedBytes / 1024 / 1024).toFixed(1)))
					: 0,
			apiCpu: api?.status === "online" ? (api.cpuUsage ?? 0) : 0,
			apiLatency: api?.status === "online" ? (api.latencyMs ?? 0) : 0,
			schedulerRssMb:
				scheduler?.status === "online"
					? (scheduler.memory.rssMb ??
						Number((scheduler.memory.rssBytes / 1024 / 1024).toFixed(1)))
					: 0,
			schedulerHeapMb:
				scheduler?.status === "online"
					? (scheduler.memory.heapUsedMb ??
						Number((scheduler.memory.heapUsedBytes / 1024 / 1024).toFixed(1)))
					: 0,
			schedulerCpu:
				scheduler?.status === "online" ? (scheduler.cpuUsage ?? 0) : 0,
			schedulerLatency:
				scheduler?.status === "online" ? (scheduler.latencyMs ?? 0) : 0,
			botRssMb:
				bot?.status === "online"
					? (bot.memory.rssMb ??
						Number((bot.memory.rssBytes / 1024 / 1024).toFixed(1)))
					: 0,
			botHeapMb:
				bot?.status === "online"
					? (bot.memory.heapUsedMb ??
						Number((bot.memory.heapUsedBytes / 1024 / 1024).toFixed(1)))
					: 0,
			botCpu: bot?.status === "online" ? (bot.cpuUsage ?? 0) : 0,
			botLatency: bot?.status === "online" ? (bot.latencyMs ?? 0) : 0,
		};

		setLivePoints((prev) => {
			const next = [...prev, pt];
			return next.slice(-30);
		});
	}, [
		telemetry.lastChecked,
		telemetry.status,
		telemetry.services,
		telemetry.totalRssMb,
		telemetry.totalHeapUsedMb,
	]);

	const chartData = useMemo(() => {
		return historyRange === "live" ? livePoints : historyPoints;
	}, [historyRange, livePoints, historyPoints]);

	useEffect(() => {
		if (telemetry.status !== "connecting") {
			setPageReady(path);
		}
	}, [telemetry.status, path, setPageReady]);

	// Map live telemetry services to UI cards
	const services: ServiceViewItem[] = useMemo(() => {
		const api = telemetry.services.find((s) => s.id === "api");
		const bot = telemetry.services.find((s) => s.id === "bot");
		const scheduler = telemetry.services.find((s) => s.id === "scheduler");

		const apiItem: ServiceViewItem = {
			id: "api",
			name: "API Gateway",
			category: "api",
			status: api?.status === "online" ? "healthy" : "offline",
			uptime:
				api?.status === "online" ? formatUptime(api.uptimeSeconds) : "Offline",
			pid: api?.pid ?? null,
			cpuUsage: api?.status === "online" ? (api.cpuUsage ?? null) : null,
			memoryUsageMb:
				api?.status === "online"
					? (api.memory.rssMb ??
						Number((api.memory.rssBytes / 1024 / 1024).toFixed(1)))
					: null,
			heapUsageMb:
				api?.status === "online"
					? (api.memory.heapUsedMb ??
						Number((api.memory.heapUsedBytes / 1024 / 1024).toFixed(1)))
					: null,
			latencyMs: api?.status === "online" ? (api.latencyMs ?? 1) : null,
			recentLogs: api?.recentLogs ?? [],
		};

		const botItem: ServiceViewItem = {
			id: "bot",
			name: "Discord Bot",
			category: "bot",
			status: bot?.status === "online" ? "healthy" : "offline",
			uptime:
				bot?.status === "online" ? formatUptime(bot.uptimeSeconds) : "Offline",
			pid: bot?.pid ?? null,
			cpuUsage: bot?.status === "online" ? (bot.cpuUsage ?? null) : null,
			memoryUsageMb:
				bot?.status === "online"
					? (bot.memory.rssMb ??
						Number((bot.memory.rssBytes / 1024 / 1024).toFixed(1)))
					: null,
			heapUsageMb:
				bot?.status === "online"
					? (bot.memory.heapUsedMb ??
						Number((bot.memory.heapUsedBytes / 1024 / 1024).toFixed(1)))
					: null,
			latencyMs: bot?.status === "online" ? (bot.latencyMs ?? null) : null,
			recentLogs: bot?.recentLogs ?? [],
		};

		const schedulerItem: ServiceViewItem = {
			id: "scheduler",
			name: "Task Scheduler",
			category: "worker",
			status: scheduler?.status === "online" ? "healthy" : "offline",
			uptime:
				scheduler?.status === "online"
					? formatUptime(scheduler.uptimeSeconds)
					: "Offline",
			pid: scheduler?.pid ?? null,
			cpuUsage:
				scheduler?.status === "online" ? (scheduler.cpuUsage ?? null) : null,
			memoryUsageMb:
				scheduler?.status === "online"
					? (scheduler.memory.rssMb ??
						Number((scheduler.memory.rssBytes / 1024 / 1024).toFixed(1)))
					: null,
			heapUsageMb:
				scheduler?.status === "online"
					? (scheduler.memory.heapUsedMb ??
						Number((scheduler.memory.heapUsedBytes / 1024 / 1024).toFixed(1)))
					: null,
			latencyMs:
				scheduler?.status === "online" ? (scheduler.latencyMs ?? null) : null,
			recentLogs: scheduler?.recentLogs ?? [],
		};

		return [apiItem, botItem, schedulerItem];
	}, [telemetry]);

	// Filter logic
	const filteredServices = useMemo(() => {
		if (!searchQuery.trim()) return services;
		const query = searchQuery.toLowerCase();
		return services.filter((s) => s.name.toLowerCase().includes(query));
	}, [services, searchQuery]);

	// Aggregate metrics computed from live state
	const aggregateStats = useMemo(() => {
		const totalServices = services.length;
		const healthyCount = services.filter((s) => s.status === "healthy").length;
		const totalMemory = (
			telemetry.totalRssMb ||
			services.reduce((acc, s) => acc + (s.memoryUsageMb ?? 0), 0)
		).toFixed(1);
		const totalHeap = (
			telemetry.totalHeapUsedMb ||
			services.reduce((acc, s) => acc + (s.heapUsageMb ?? 0), 0)
		).toFixed(1);
		const onlineWithCpu = services.filter(
			(s) => s.status === "healthy" && s.cpuUsage !== null,
		);
		const avgCpu =
			onlineWithCpu.length > 0
				? (
						onlineWithCpu.reduce((acc, s) => acc + (s.cpuUsage ?? 0), 0) /
						onlineWithCpu.length
					).toFixed(1)
				: "0.0";

		return {
			totalServices,
			healthyCount,
			totalMemory,
			totalHeap,
			avgCpu,
		};
	}, [services, telemetry]);

	// Ordered logs with latest on top for the Event Stream
	const eventStreamLogs = useMemo(() => {
		return [...telemetry.recentLogs].reverse();
	}, [telemetry.recentLogs]);

	// Interactive refresh action via WebSocket / IPC
	const handleRefreshTelemetry = () => {
		setIsRefreshing(true);
		telemetry.refresh();
		if (historyRange !== "live") {
			void fetchHistory(historyRange);
		}
		setTimeout(() => {
			setIsRefreshing(false);
		}, 400);
	};

	return (
		<div className="space-y-8 animate-in fade-in duration-300">
			{/* ─── Hero Section & Command Deck Telemetry HUD ───────────────────────────── */}
			<div className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-card/90 via-card/60 to-primary/5 p-6 sm:p-8 backdrop-blur-2xl shadow-xl">
				{/* Glowing ambient orb behind hero */}
				<div className="pointer-events-none absolute -right-20 -top-20 size-80 rounded-full bg-primary/10 blur-3xl" />
				<div className="pointer-events-none absolute -left-20 -bottom-20 size-72 rounded-full bg-indigo-500/10 blur-3xl" />

				<div className="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-end gap-6">
					{/* Quick Actions */}
					<div className="flex flex-wrap  items-center gap-2.5">
						<Button
							variant="outline"
							size="sm"
							onClick={handleRefreshTelemetry}
							disabled={isRefreshing}
							className="rounded-xl border-border/80 bg-background/50 hover:bg-accent cursor-pointer"
						>
							<RotateCw
								className={`size-3.5 ${isRefreshing ? "animate-spin text-primary" : "text-muted-foreground"}`}
							/>
							<span>
								{isRefreshing ? "Probing Fleet..." : "Refresh Telemetry"}
							</span>
						</Button>
					</div>
				</div>

				{/* ─── Metric Gauges / KPI Strip ────────────────────────────────────────── */}
				<div className="mt-8 grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
					{/* Stat 1: Fleet Nodes */}
					<div className="p-4 rounded-2xl border border-border/70 bg-card/60 backdrop-blur-md flex flex-col justify-between antigravity-card">
						<div className="flex items-center justify-between">
							<span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
								Service Health
							</span>
							<div
								className={`size-7 rounded-lg flex items-center justify-center ${
									aggregateStats.healthyCount === aggregateStats.totalServices
										? "bg-emerald-500/15 text-emerald-400"
										: "bg-amber-500/15 text-amber-400"
								}`}
							>
								<CheckCircle2 className="size-4" />
							</div>
						</div>
						<div className="mt-3">
							<div className="flex items-baseline gap-2">
								<span className="text-2xl font-bold font-mono text-foreground">
									{aggregateStats.healthyCount}/{aggregateStats.totalServices}
								</span>
							</div>
						</div>
					</div>

					{/* Stat 2: Uptime SLA */}
					<div className="p-4 rounded-2xl border border-border/70 bg-card/60 backdrop-blur-md flex flex-col justify-between antigravity-card">
						<div className="flex items-center justify-between">
							<span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
								Host Runtime
							</span>
							<div className="size-7 rounded-lg bg-sky-500/15 text-sky-400 flex items-center justify-center">
								<ShieldCheck className="size-4" />
							</div>
						</div>
						<div className="mt-3">
							<div className="flex items-baseline gap-2">
								<span className="text-2xl font-bold font-mono text-foreground">
									{telemetry.uptime !== null && telemetry.uptime >= 0
										? formatUptime(telemetry.uptime)
										: (telemetry.host ?? "Online")}
								</span>
							</div>
							<span className="text-[10px] font-mono text-muted-foreground block mt-0.5">
								{telemetry.host ?? "MAC"} • Bun v{telemetry.bunVersion ?? "1.4"}
							</span>
						</div>
					</div>

					{/* Stat 3: Fleet CPU Load */}
					<div className="p-4 rounded-2xl border border-border/70 bg-card/60 backdrop-blur-md flex flex-col justify-between antigravity-card">
						<div className="flex items-center justify-between">
							<span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
								Fleet CPU Load
							</span>
							<div className="size-7 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center">
								<Activity className="size-4" />
							</div>
						</div>
						<div className="mt-3">
							<div className="flex items-baseline gap-2">
								<span className="text-2xl font-bold font-mono text-foreground">
									{aggregateStats.avgCpu}%
								</span>
								<span className="text-[11px] font-mono text-muted-foreground">
									Avg
								</span>
							</div>
						</div>
					</div>

					{/* Stat 4: Memory Footprint */}
					<div className="p-4 rounded-2xl border border-border/70 bg-card/60 backdrop-blur-md flex flex-col justify-between antigravity-card">
						<div className="flex items-center justify-between">
							<span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
								Memory Footprint
							</span>
							<div className="size-7 rounded-lg bg-violet-500/15 text-violet-400 flex items-center justify-center">
								<Cpu className="size-4" />
							</div>
						</div>
						<div className="mt-3">
							<div className="flex items-baseline gap-2">
								<span className="text-2xl font-bold font-mono text-foreground">
									{aggregateStats.totalMemory} MB
								</span>
								<span className="text-[11px] font-mono text-muted-foreground">
									RSS
								</span>
							</div>
							<span className="text-[10px] font-mono text-emerald-400 font-medium block mt-0.5">
								{aggregateStats.totalHeap} MB Active JS Heap
							</span>
						</div>
					</div>
				</div>
			</div>

			{/* ─── Historical Fleet Performance & Resource Area Chart ──────────────────────── */}
			<div className="rounded-3xl border border-border/80 bg-card/75 backdrop-blur-xl p-6 shadow-sm space-y-6">
				<div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-border/60">
					<div className="flex items-center gap-3">
						<div>
							<div className="flex items-center gap-2">
								<h2 className="text-base font-semibold text-foreground font-display">
									Resource History
								</h2>
							</div>
						</div>
					</div>

					{/* Metric Tabs & Time Range Selectors */}
					<div className="flex flex-wrap items-center gap-3">
						{/* Metric Switcher */}
						<div className="flex items-center p-1 rounded-xl bg-background/60 border border-border/80">
							<button
								type="button"
								onClick={() => setActiveMetricTab("rss")}
								className={`px-3 py-1 text-xs font-mono rounded-lg transition-all cursor-pointer ${
									activeMetricTab === "rss"
										? "bg-primary text-primary-foreground font-semibold shadow-sm"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								RAM (RSS)
							</button>
							<button
								type="button"
								onClick={() => setActiveMetricTab("heap")}
								className={`px-3 py-1 text-xs font-mono rounded-lg transition-all cursor-pointer ${
									activeMetricTab === "heap"
										? "bg-emerald-500 text-white font-semibold shadow-sm"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								JS Heap
							</button>
							<button
								type="button"
								onClick={() => setActiveMetricTab("cpu")}
								className={`px-3 py-1 text-xs font-mono rounded-lg transition-all cursor-pointer ${
									activeMetricTab === "cpu"
										? "bg-indigo-500 text-white font-semibold shadow-sm"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								CPU (%)
							</button>
							<button
								type="button"
								onClick={() => setActiveMetricTab("latency")}
								className={`px-3 py-1 text-xs font-mono rounded-lg transition-all cursor-pointer ${
									activeMetricTab === "latency"
										? "bg-sky-500 text-white font-semibold shadow-sm"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								Latency
							</button>
						</div>

						{/* Time Range Selector */}
						<div className="flex items-center p-1 rounded-xl bg-background/60 border border-border/80">
							{(["live", "1h", "6h", "24h", "7d"] as TimeRange[]).map((r) => (
								<button
									key={r}
									type="button"
									onClick={() => setHistoryRange(r)}
									className={`px-2.5 py-1 text-xs font-mono uppercase rounded-lg transition-all cursor-pointer ${
										historyRange === r
											? r === "live"
												? "bg-emerald-500 text-white font-bold shadow-sm"
												: "bg-accent text-accent-foreground font-bold"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									{r === "live" ? "Live" : r}
								</button>
							))}
						</div>
					</div>
				</div>

				{/* Recharts Area Chart */}
				<div className="relative w-full h-[280px] sm:h-[320px]">
					{isLoadingHistory && chartData.length === 0 ? (
						<div className="absolute inset-0 flex items-center justify-center bg-card/40 backdrop-blur-xs rounded-2xl">
							<span className="text-xs font-mono text-muted-foreground flex items-center gap-2">
								<RotateCw className="size-4 animate-spin text-primary" />
								Querying historical telemetry points...
							</span>
						</div>
					) : (
						<ResponsiveContainer width="100%" height="100%">
							<AreaChart
								data={chartData}
								margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
							>
								<defs>
									{/* API Gateway Gradient */}
									<linearGradient id="gradApi" x1="0" y1="0" x2="0" y2="1">
										<stop offset="5%" stopColor="#38bdf8" stopOpacity={0.45} />
										<stop offset="95%" stopColor="#38bdf8" stopOpacity={0.0} />
									</linearGradient>
									{/* Task Scheduler Gradient */}
									<linearGradient id="gradSched" x1="0" y1="0" x2="0" y2="1">
										<stop offset="5%" stopColor="#34d399" stopOpacity={0.45} />
										<stop offset="95%" stopColor="#34d399" stopOpacity={0.0} />
									</linearGradient>
									{/* Discord Bot Gradient */}
									<linearGradient id="gradBot" x1="0" y1="0" x2="0" y2="1">
										<stop offset="5%" stopColor="#a855f7" stopOpacity={0.45} />
										<stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
									</linearGradient>
								</defs>
								<CartesianGrid
									strokeDasharray="3 3"
									stroke="hsl(var(--border) / 0.4)"
									vertical={false}
								/>
								<XAxis
									dataKey="formattedTime"
									stroke="hsl(var(--muted-foreground))"
									fontSize={10}
									tickLine={false}
									axisLine={false}
								/>

								<YAxis
									stroke="hsl(var(--muted-foreground))"
									fontSize={10}
									tickLine={false}
									axisLine={false}
									domain={[0, "auto"]}
									tickFormatter={(v) =>
										activeMetricTab === "rss" || activeMetricTab === "heap"
											? `${v}MB`
											: activeMetricTab === "cpu"
												? `${v}%`
												: `${v}ms`
									}
								/>
								<Tooltip
									content={<CustomChartTooltip metricTab={activeMetricTab} />}
								/>

								{/* Metric: Memory RSS */}
								{activeMetricTab === "rss" && (
									<>
										<Area
											type="monotone"
											dataKey="apiRssMb"
											name="API Gateway (RSS)"
											stroke="#38bdf8"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradApi)"
										/>
										<Area
											type="monotone"
											dataKey="schedulerRssMb"
											name="Task Scheduler (RSS)"
											stroke="#34d399"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradSched)"
										/>
										<Area
											type="monotone"
											dataKey="botRssMb"
											name="Discord Bot (RSS)"
											stroke="#a855f7"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradBot)"
										/>
									</>
								)}

								{/* Metric: JS Heap */}
								{activeMetricTab === "heap" && (
									<>
										<Area
											type="monotone"
											dataKey="apiHeapMb"
											name="API Gateway (JS Heap)"
											stroke="#38bdf8"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradApi)"
										/>
										<Area
											type="monotone"
											dataKey="schedulerHeapMb"
											name="Task Scheduler (JS Heap)"
											stroke="#34d399"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradSched)"
										/>
										<Area
											type="monotone"
											dataKey="botHeapMb"
											name="Discord Bot (JS Heap)"
											stroke="#a855f7"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradBot)"
										/>
									</>
								)}

								{/* Metric: CPU */}
								{activeMetricTab === "cpu" && (
									<>
										<Area
											type="monotone"
											dataKey="apiCpu"
											name="API Gateway (CPU)"
											stroke="#38bdf8"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradApi)"
										/>
										<Area
											type="monotone"
											dataKey="schedulerCpu"
											name="Task Scheduler (CPU)"
											stroke="#34d399"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradSched)"
										/>
										<Area
											type="monotone"
											dataKey="botCpu"
											name="Discord Bot (CPU)"
											stroke="#a855f7"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradBot)"
										/>
									</>
								)}

								{/* Metric: Latency */}
								{activeMetricTab === "latency" && (
									<>
										<Area
											type="monotone"
											dataKey="apiLatency"
											name="API Gateway (Latency)"
											stroke="#38bdf8"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradApi)"
										/>
										<Area
											type="monotone"
											dataKey="schedulerLatency"
											name="Task Scheduler (IPC Latency)"
											stroke="#34d399"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradSched)"
										/>
										<Area
											type="monotone"
											dataKey="botLatency"
											name="Discord Bot (IPC Latency)"
											stroke="#a855f7"
											strokeWidth={2}
											fillOpacity={1}
											fill="url(#gradBot)"
										/>
									</>
								)}
							</AreaChart>
						</ResponsiveContainer>
					)}
				</div>

				{/* Chart Legend / Active Status Bar */}
				<div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-border/50 text-[11px] font-mono">
					<div className="flex items-center gap-5">
						<div className="flex items-center gap-1.5">
							<span className="size-2.5 rounded-full bg-[#38bdf8]" />
							<span className="text-foreground">API Gateway</span>
						</div>
						<div className="flex items-center gap-1.5">
							<span className="size-2.5 rounded-full bg-[#34d399]" />
							<span className="text-foreground">Task Scheduler</span>
						</div>
						<div className="flex items-center gap-1.5">
							<span className="size-2.5 rounded-full bg-[#a855f7]" />
							<span className="text-foreground">Discord Bot</span>
						</div>
					</div>
				</div>
			</div>

			{/* ─── Services Section Header & Filter ────────────────────────────────────── */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
				<div>
					<h2 className="text-base font-semibold font-display text-foreground">
						Core Fleet Services
					</h2>
				</div>

				<div className="relative sm:w-64">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
					<Input
						type="text"
						placeholder="Filter services..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9 pr-3 rounded-xl bg-card/60 border-border/80 text-xs"
					/>
				</div>
			</div>

			{/* ─── Services Grid (3 Sentinel Core Services) ─────────────────────────────── */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
				{filteredServices.map((service) => {
					const isOnline = service.status === "healthy";

					return (
						<Card
							key={service.id}
							className="antigravity-card flex flex-col justify-between border-border/80 bg-card/75 backdrop-blur-xl relative overflow-hidden group"
						>
							{/* Top Accent Gradient Border Glow */}
							<div
								className={`absolute inset-x-0 top-0 h-[2px] transition-opacity ${
									isOnline
										? "bg-gradient-to-r from-sky-400 via-indigo-500 to-transparent opacity-40 group-hover:opacity-100"
										: "bg-gradient-to-r from-rose-500 via-rose-400 to-transparent opacity-60"
								}`}
							/>

							<div>
								{/* Card Header */}
								<CardHeader className="pb-3">
									<div className="flex items-start justify-between gap-3">
										<div className="flex items-center gap-3">
											<div className="flex flex-col min-w-0">
												<CardTitle className="text-sm font-semibold truncate text-foreground group-hover:text-primary transition-colors">
													{service.name}
												</CardTitle>
											</div>
										</div>
									</div>
								</CardHeader>

								{/* Card Content: Telemetry Metrics & Sparkbars */}
								<CardContent className="space-y-4 pt-1">
									{/* CPU & Memory Sparkbars */}
									<div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-background/50 border border-border/50">
										<div className="space-y-1.5">
											<div className="flex items-center justify-between text-[10px] font-mono">
												<span className="text-muted-foreground">CPU</span>
												<span className="font-semibold text-foreground">
													{service.cpuUsage !== null
														? `${service.cpuUsage}%`
														: "—"}
												</span>
											</div>
											<div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
												<div
													className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500 transition-all duration-500"
													style={{
														width: `${
															service.cpuUsage !== null
																? Math.min(100, service.cpuUsage * 10)
																: 0
														}%`,
													}}
												/>
											</div>
										</div>

										<div className="space-y-1.5">
											<div className="flex items-center justify-between text-[10px] font-mono">
												<span className="text-muted-foreground">RAM (RSS)</span>
												<span className="font-semibold text-foreground">
													{service.memoryUsageMb !== null
														? `${service.memoryUsageMb} MB`
														: "—"}
												</span>
											</div>
											<div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
												<div
													className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-500 transition-all duration-500"
													style={{
														width: `${
															service.memoryUsageMb !== null
																? Math.min(
																		100,
																		(service.memoryUsageMb / 128) * 100,
																	)
																: 0
														}%`,
													}}
												/>
											</div>
											{service.heapUsageMb !== null && (
												<span className="text-[9px] font-mono text-emerald-400 block truncate">
													Heap: {service.heapUsageMb} MB
												</span>
											)}
										</div>
									</div>

									{/* Key Stats Matrix */}
									<div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
										<div className="flex flex-col p-2 rounded-lg bg-background/30 border border-border/30">
											<span className="text-[9px] text-muted-foreground uppercase">
												Uptime
											</span>
											<span
												className={`font-medium truncate mt-0.5 ${
													isOnline ? "text-emerald-400" : "text-rose-400"
												}`}
											>
												{service.uptime}
											</span>
										</div>

										<div className="flex flex-col p-2 rounded-lg bg-background/30 border border-border/30">
											<span className="text-[9px] text-muted-foreground uppercase">
												Latency
											</span>
											<span
												className={`font-medium truncate mt-0.5 ${
													isOnline && service.latencyMs !== null
														? "text-sky-400"
														: "text-muted-foreground"
												}`}
											>
												{isOnline && service.latencyMs !== null
													? `${service.latencyMs} ms`
													: "—"}
											</span>
										</div>
									</div>
								</CardContent>
							</div>

							{/* Card Footer */}
							<CardFooter className="flex items-center justify-between pt-3 pb-4 px-5 border-t border-border/40">
								<div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
									<span>
										PID: {service.pid ? `#${service.pid}` : "Offline"}
									</span>
								</div>

								<Button
									variant="outline"
									size="sm"
									onClick={() => setSelectedServiceForLogs(service)}
									className="h-7 px-2.5 rounded-lg text-[11px] gap-1 cursor-pointer border-border/80 hover:bg-primary/15 hover:text-primary hover:border-primary/40"
								>
									<Terminal className="size-3" />
									<span>Logs</span>
								</Button>
							</CardFooter>
						</Card>
					);
				})}
			</div>

			{/* ─── Real-Time Fleet Event Stream ─────────────────────────────────────────── */}
			<div className="rounded-3xl border border-border/80 bg-card/75 backdrop-blur-xl p-6 shadow-sm space-y-4">
				<div className="flex items-center justify-between pb-2 border-b border-border/60">
					<div className="flex items-center gap-2.5">
						<div>
							<h2 className="text-sm font-semibold text-foreground font-display">
								Log Stream
							</h2>
						</div>
					</div>

					<Badge
						variant="outline"
						className="text-[10px] font-mono px-2 py-0.5"
					>
						{eventStreamLogs.length} events
					</Badge>
				</div>

				<div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1.5 overscroll-contain">
					{eventStreamLogs.length === 0 ? (
						<div className="p-4 rounded-2xl border border-border/40 bg-background/30 text-center">
							<span className="text-xs font-mono text-muted-foreground">
								Listening on IPC sockets for live service events...
							</span>
						</div>
					) : (
						eventStreamLogs.map((log) => (
							<div
								key={log.id}
								className="p-3.5 rounded-2xl border border-border/50 bg-background/40 hover:bg-accent/40 transition-colors flex items-start justify-between gap-4"
							>
								<div className="flex items-start gap-3 min-w-0">
									<div className="flex flex-col min-w-0">
										<div className="flex items-center gap-2 flex-wrap">
											<span className="text-xs font-semibold text-foreground">
												[{log.context}]
											</span>
											{log.subContext && (
												<Badge
													variant="secondary"
													className="text-[9px] font-mono px-1.5 py-0 font-bold border-cyan-500/30 bg-cyan-500/10 text-cyan-500"
												>
													{log.subContext}
												</Badge>
											)}
											<Badge
												variant={
													log.level === "error"
														? "destructive"
														: log.level === "warn"
															? "warning"
															: "secondary"
												}
												className="text-[9px] font-mono px-1.5 py-0 uppercase"
											>
												{log.level}
											</Badge>
											<Badge
												variant="outline"
												className="text-[9px] font-mono px-1.5 py-0"
											>
												{log.service}
											</Badge>
										</div>
										<p className="text-xs text-muted-foreground mt-0.5 leading-relaxed font-mono select-text">
											{log.message}
										</p>
									</div>
								</div>

								<span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap shrink-0">
									{log.timestamp}
								</span>
							</div>
						))
					)}
				</div>
			</div>

			{/* ─── Expandable Log Drawer / Modal ────────────────────────────────────────── */}
			{selectedServiceForLogs && (
				<Dialog
					open={selectedServiceForLogs !== null}
					onOpenChange={(open) => {
						if (!open) setSelectedServiceForLogs(null);
					}}
				>
					<DialogContent
						showCloseButton={false}
						className="w-full max-w-2xl rounded-3xl border-primary/30 bg-card/95 p-6 gap-4 max-h-[85vh] flex flex-col"
					>
						<DialogHeader className="flex-row items-center justify-between border-b border-border/60 pb-3 space-y-0">
							<div className="flex items-center gap-3">
								<div className="size-9 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
									<Terminal className="size-4.5" />
								</div>
								<div>
									<DialogTitle className="text-base font-bold text-foreground font-display">
										{selectedServiceForLogs.name}
									</DialogTitle>
									<DialogDescription className="text-[10px] font-mono text-muted-foreground">
										PID{" "}
										{selectedServiceForLogs.pid
											? `#${selectedServiceForLogs.pid}`
											: "Offline"}
									</DialogDescription>
								</div>
							</div>

							<Button
								variant="ghost"
								size="sm"
								onClick={() => setSelectedServiceForLogs(null)}
								className="rounded-xl text-xs cursor-pointer"
							>
								Close
							</Button>
						</DialogHeader>

						{/* Log Console View */}
						<div className="flex-1 overflow-y-auto p-4 rounded-2xl bg-black/90 border border-border/80 font-mono text-xs text-slate-300 space-y-2 select-text">
							{selectedServiceForLogs.recentLogs.length === 0 ? (
								<div className="text-slate-500 py-4 text-center">
									No logs recorded yet for this service session.
								</div>
							) : (
								selectedServiceForLogs.recentLogs.map((log) => (
									<div key={log.id} className="flex items-start gap-2.5">
										<span className="text-slate-500 shrink-0">
											[{log.timestamp}]
										</span>
										<span
											className={`uppercase font-bold text-[10px] px-1 rounded ${
												log.level === "info"
													? "text-sky-400 bg-sky-950/60"
													: log.level === "warn"
														? "text-amber-400 bg-amber-950/60"
														: "text-rose-400 bg-rose-950/60"
											}`}
										>
											{log.level}
										</span>
										<span className="text-sky-300 font-semibold shrink-0">
											[{log.context}]
										</span>
										{log.subContext && (
											<span className="text-cyan-400 font-bold shrink-0">
												[{log.subContext}]
											</span>
										)}
										<span className="text-slate-200 break-all">
											{log.message}
										</span>
									</div>
								))
							)}
						</div>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}
