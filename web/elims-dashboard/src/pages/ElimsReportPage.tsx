import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../lib/api";

export interface TeamReportItem {
	teamId: number;
	name: string;
	score: number;
	attacks: number;
	membersCount: number;
	activeCount?: number;
	lives: number;
	wins: number;
	losses: number;
	position: number;
	eliminated: boolean;
	eliminatedTimestamp: string | null;
	isMock: boolean;
	hourlyDistribution: number[];
	currentHourly?: number[];
	averageHourly?: number[];
	leastActiveHour: number;
	mostActiveHour: number;
	totalActivity: number;
	lastSyncedAt: string | null;
}

export interface HourlyActivityResponse {
	teams: TeamReportItem[];
	benchmarkHourly: number[];
	totalCirculation?: number;
	burnedTickets?: number;
	isMock: boolean;
	keyCount: number;
	lastSyncedAt: string | null;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHour(h: number): string {
	return `${String(h).padStart(2, "0")}:00`;
}

function getHourStats(hours: number[]) {
	let minHour = 0;
	let maxHour = 0;
	let minVal = Number.POSITIVE_INFINITY;
	let maxVal = Number.NEGATIVE_INFINITY;

	for (let h = 0; h < 24; h++) {
		const val = hours[h] ?? 0;
		if (val > 0 && val < minVal) {
			minVal = val;
			minHour = h;
		}
		if (val > maxVal) {
			maxVal = val;
			maxHour = h;
		}
	}

	return {
		least: minVal === Number.POSITIVE_INFINITY ? 0 : minHour,
		most: maxVal === Number.NEGATIVE_INFINITY ? 0 : maxHour,
	};
}

type SortField =
	| "position"
	| "name"
	| "score"
	| "lives"
	| "activeCount"
	| "attacks"
	| "wins"
	| "losses"
	| "winRate";
type SortOrder = "asc" | "desc";

export function ElimsReportPage() {
	const [data, setData] = useState<HourlyActivityResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [wsConnected, setWsConnected] = useState(false);

	// Hourly Distribution view tab: "current" (last hour data) vs "average" (all data)
	const [distributionMode, setDistributionMode] = useState<
		"current" | "average"
	>("current");

	// Table search & sort state
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<
		"all" | "active" | "eliminated"
	>("all");
	const [sortField, setSortField] = useState<SortField>("position");
	const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

	const wsRef = useRef<WebSocket | null>(null);

	// 1. REST fallback fetcher
	const fetchData = useCallback(async () => {
		try {
			const res = await api.api.v1.elims["hourly-activity"].get();
			if (res.data) {
				const resData = res.data as unknown as HourlyActivityResponse;
				setData(resData);
			}
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to load hourly activity data.",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	// Initial fetch
	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// 2. Real-time WebSocket connection
	useEffect(() => {
		let ws: WebSocket | null = null;
		let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

		function connect() {
			try {
				const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
				const wsUrl = `${protocol}//${window.location.host}/api/ws/elims-tournament`;
				ws = new WebSocket(wsUrl);
				wsRef.current = ws;

				ws.onopen = () => {
					setWsConnected(true);
				};

				ws.onmessage = (event) => {
					try {
						const message = JSON.parse(event.data);
						if (message.type === "elims_snapshot" && message.data) {
							setData(message.data as HourlyActivityResponse);
							setLoading(false);
						}
					} catch {
						// silent json parse ignore
					}
				};

				ws.onerror = () => {
					setWsConnected(false);
				};

				ws.onclose = () => {
					setWsConnected(false);
					reconnectTimeout = setTimeout(connect, 4000);
				};
			} catch {
				setWsConnected(false);
			}
		}

		connect();

		return () => {
			if (reconnectTimeout) clearTimeout(reconnectTimeout);
			if (ws) {
				ws.close();
				wsRef.current = null;
			}
		};
	}, []);

	// 3. Fallback Polling (only runs when WebSocket is disconnected)
	useEffect(() => {
		if (wsConnected) return;
		const interval = setInterval(fetchData, 5000);
		return () => clearInterval(interval);
	}, [fetchData, wsConnected]);

	const handleSort = (field: SortField) => {
		if (sortField === field) {
			setSortOrder(sortOrder === "asc" ? "desc" : "asc");
		} else {
			setSortField(field);
			// For scores, attacks, wins, default to descending
			if (
				["score", "attacks", "wins", "winRate", "activeCount"].includes(field)
			) {
				setSortOrder("desc");
			} else {
				setSortOrder("asc");
			}
		}
	};

	const teams = data?.teams ?? [];
	const eliminatedTeams = teams.filter((t) => t.eliminated || t.lives <= 0);
	const aliveTeams = teams.filter((t) => !t.eliminated && t.lives > 0);

	const totalActiveTickets = aliveTeams.reduce((sum, t) => sum + t.score, 0);
	const burnedTickets = eliminatedTeams.length * 1000;

	// Sort and filter teams for live table
	const sortedTeams = useMemo(() => {
		let list = [...teams];

		// Filter status
		if (statusFilter === "active") {
			list = list.filter((t) => !t.eliminated && t.lives > 0);
		} else if (statusFilter === "eliminated") {
			list = list.filter((t) => t.eliminated || t.lives <= 0);
		}

		// Search query
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase().trim();
			list = list.filter(
				(t) => t.name.toLowerCase().includes(q) || String(t.teamId).includes(q),
			);
		}

		// Sort
		list.sort((a, b) => {
			let valA: number | string = 0;
			let valB: number | string = 0;

			switch (sortField) {
				case "position":
					valA = a.position || (a.eliminated ? 999 : 50);
					valB = b.position || (b.eliminated ? 999 : 50);
					break;
				case "name":
					valA = a.name.toLowerCase();
					valB = b.name.toLowerCase();
					break;
				case "score":
					valA = a.score;
					valB = b.score;
					break;
				case "lives":
					valA = a.lives;
					valB = b.lives;
					break;
				case "activeCount":
					valA = a.activeCount ?? 0;
					valB = b.activeCount ?? 0;
					break;
				case "attacks":
					valA = a.attacks;
					valB = b.attacks;
					break;
				case "wins":
					valA = a.wins;
					valB = b.wins;
					break;
				case "losses":
					valA = a.losses;
					valB = b.losses;
					break;
				case "winRate": {
					const rateA =
						a.wins + a.losses > 0 ? (a.wins / (a.wins + a.losses)) * 100 : 0;
					const rateB =
						b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses)) * 100 : 0;
					valA = rateA;
					valB = rateB;
					break;
				}
			}

			if (typeof valA === "string" && typeof valB === "string") {
				return sortOrder === "asc"
					? valA.localeCompare(valB)
					: valB.localeCompare(valA);
			}

			return sortOrder === "asc"
				? Number(valA) - Number(valB)
				: Number(valB) - Number(valA);
		});

		return list;
	}, [teams, statusFilter, searchQuery, sortField, sortOrder]);

	const currentTctHour = new Date().getUTCHours();

	// Find global max activity for the selected distribution mode to scale heatmap intensity
	let maxActivity = 1;
	for (const t of teams) {
		const dist =
			distributionMode === "current"
				? (t.currentHourly ?? t.hourlyDistribution)
				: (t.averageHourly ?? t.hourlyDistribution);
		for (const val of dist) {
			if (val > maxActivity) maxActivity = val;
		}
	}

	if (loading && !data) {
		return (
			<div className="flex flex-col gap-6 p-6">
				<div className="flex items-center justify-between">
					<Skeleton className="h-8 w-48" />
					<Skeleton className="h-9 w-28" />
				</div>
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6 p-6">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div className="flex flex-wrap items-center gap-3">
					{data?.isMock ? (
						<Badge variant="secondary" className="font-mono text-xs">
							Simulation Mode
						</Badge>
					) : (
						<Badge variant="default" className="font-mono text-xs">
							Live
						</Badge>
					)}
				</div>
			</div>

			{/* Elimination Banner (if any team eliminated) */}
			{eliminatedTeams.length > 0 && (
				<div className="border border-destructive/40 bg-destructive/10 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
					<div className="flex items-center gap-2">
						<AlertTriangle className="size-4 text-destructive shrink-0" />
						<span className="font-bold text-destructive">
							ELIMINATION ALERT:
						</span>
						<span>
							{eliminatedTeams.length} team(s) reached 0 lives and have been
							eliminated! {burnedTickets.toLocaleString()} tickets burned.
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{eliminatedTeams.map((t) => (
							<Badge
								key={t.teamId}
								variant="destructive"
								className="text-[11px] font-mono"
							>
								{t.name} (0 Lives)
								{t.eliminatedTimestamp &&
									` • ${new Date(t.eliminatedTimestamp).toISOString().substring(11, 16)} TCT`}
							</Badge>
						))}
					</div>
				</div>
			)}

			{/* 1. Live Sortable Tournament Standings Table */}
			<Card>
				<CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-4 pb-3">
					<div className="flex flex-wrap items-center gap-3">
						{/* Status Filter Tabs */}
						<Tabs
							value={statusFilter}
							onValueChange={(val) =>
								setStatusFilter(val as "all" | "active" | "eliminated")
							}
						>
							<TabsList className="h-8">
								<TabsTrigger value="all" className="text-xs px-2.5">
									All ({teams.length})
								</TabsTrigger>
								<TabsTrigger value="active" className="text-xs px-2.5">
									Active ({aliveTeams.length})
								</TabsTrigger>
								{eliminatedTeams.length > 0 && (
									<TabsTrigger value="eliminated" className="text-xs px-2.5">
										Eliminated ({eliminatedTeams.length})
									</TabsTrigger>
								)}
							</TabsList>
						</Tabs>

						{/* Search Input */}
						<div className="relative w-40 sm:w-52">
							<Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
							<Input
								placeholder="Search teams..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="h-8 pl-8 text-xs font-mono"
							/>
						</div>
					</div>
				</CardHeader>

				<CardContent className="p-0">
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									{/* Position */}
									<TableHead
										onClick={() => handleSort("position")}
										className="w-16 font-mono text-xs cursor-pointer select-none hover:text-foreground"
									>
										<div className="flex items-center gap-1">
											<span>#</span>
											{sortField === "position" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Team Name */}
									<TableHead
										onClick={() => handleSort("name")}
										className="min-w-44 font-mono text-xs cursor-pointer select-none hover:text-foreground"
									>
										<div className="flex items-center gap-1">
											<span>Team</span>
											{sortField === "name" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Status / Lives */}
									<TableHead
										onClick={() => handleSort("lives")}
										className="w-40 font-mono text-xs cursor-pointer select-none hover:text-foreground"
									>
										<div className="flex items-center gap-1">
											<span>Lives</span>
											{sortField === "lives" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Tickets / Score */}
									<TableHead
										onClick={() => handleSort("score")}
										className="w-32 font-mono text-xs cursor-pointer select-none text-right hover:text-foreground"
									>
										<div className="flex items-center justify-end gap-1">
											<span>Tickets</span>
											{sortField === "score" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Active Players */}
									<TableHead
										onClick={() => handleSort("activeCount")}
										className="w-28 font-mono text-xs cursor-pointer select-none text-right hover:text-foreground"
									>
										<div className="flex items-center justify-end gap-1">
											<span>Active</span>
											{sortField === "activeCount" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Attacks */}
									<TableHead
										onClick={() => handleSort("attacks")}
										className="w-24 font-mono text-xs cursor-pointer select-none text-right hover:text-foreground"
									>
										<div className="flex items-center justify-end gap-1">
											<span>Attacks</span>
											{sortField === "attacks" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Win Rate / Record */}
									<TableHead
										onClick={() => handleSort("winRate")}
										className="w-36 font-mono text-xs cursor-pointer select-none text-right hover:text-foreground"
									>
										<div className="flex items-center justify-end gap-1">
											<span>Record (W/L)</span>
											{sortField === "winRate" ? (
												sortOrder === "asc" ? (
													<ArrowUp className="size-3" />
												) : (
													<ArrowDown className="size-3" />
												)
											) : (
												<ArrowUpDown className="size-3 opacity-30" />
											)}
										</div>
									</TableHead>

									{/* Peak Hour */}
									<TableHead className="w-24 font-mono text-xs text-center">
										Peak TCT
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sortedTeams.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={8}
											className="h-24 text-center text-sm font-mono text-muted-foreground"
										>
											No teams matching your filter.
										</TableCell>
									</TableRow>
								) : (
									sortedTeams.map((t, idx) => {
										const isElim = t.eliminated || t.lives <= 0;
										const totalBattles = t.wins + t.losses;
										const winRate =
											totalBattles > 0
												? ((t.wins / totalBattles) * 100).toFixed(1)
												: "0.0";
										const activeMembers =
											t.activeCount ??
											(isElim ? 0 : Math.round(t.membersCount * 0.2));
										const ticketPct =
											totalActiveTickets > 0 && !isElim
												? ((t.score / totalActiveTickets) * 100).toFixed(1)
												: "0.0";

										// Health bar color transition
										const healthPct = Math.max(
											0,
											Math.min(100, (t.lives / 50) * 100),
										);
										const healthColor =
											t.lives >= 35
												? "bg-emerald-500"
												: t.lives >= 15
													? "bg-amber-500"
													: "bg-red-500";

										return (
											<TableRow
												key={t.teamId}
												className={`transition-colors font-mono text-xs ${
													isElim
														? "opacity-60 bg-destructive/5 hover:bg-destructive/10"
														: "hover:bg-muted/40"
												}`}
											>
												{/* Rank / Position */}
												<TableCell className="font-bold tabular-nums">
													{isElim ? (
														<span className="text-muted-foreground">OUT</span>
													) : t.position === 1 ? (
														<Badge className="bg-amber-500/20 text-amber-500 hover:bg-amber-500/30 border-amber-500/40 text-xs px-2 py-0">
															#1
														</Badge>
													) : t.position === 2 ? (
														<Badge
															variant="secondary"
															className="text-xs px-2 py-0"
														>
															#2
														</Badge>
													) : t.position === 3 ? (
														<Badge
															variant="outline"
															className="text-xs px-2 py-0 border-amber-700/40 text-amber-700"
														>
															#3
														</Badge>
													) : (
														<span className="text-muted-foreground pl-1.5">
															#{t.position || idx + 1}
														</span>
													)}
												</TableCell>

												{/* Team Name */}
												<TableCell>
													<div className="flex items-center gap-1.5">
														<span
															className={`font-semibold ${
																isElim
																	? "line-through text-muted-foreground"
																	: ""
															}`}
														>
															{t.name}
														</span>
														<span className="text-[10px] text-muted-foreground font-normal">
															#{t.teamId}
														</span>
													</div>
												</TableCell>

												{/* Lives & Health Bar */}
												<TableCell>
													{isElim ? (
														<Badge
															variant="destructive"
															className="text-[10px] font-mono uppercase"
														>
															Eliminated
															{t.eliminatedTimestamp &&
																` (${new Date(t.eliminatedTimestamp).toISOString().substring(11, 16)} TCT)`}
														</Badge>
													) : (
														<div className="flex flex-col gap-1 w-32">
															<div className="flex items-center justify-between text-[11px] tabular-nums">
																<span className="font-medium">
																	{t.lives}/50 lives
																</span>
																<span className="text-[10px] text-muted-foreground">
																	{healthPct.toFixed(0)}%
																</span>
															</div>
															<div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
																<div
																	className={`h-full rounded-full transition-all duration-500 ${healthColor}`}
																	style={{ width: `${healthPct}%` }}
																/>
															</div>
														</div>
													)}
												</TableCell>

												{/* Tickets / Score */}
												<TableCell className="text-right tabular-nums">
													<div className="font-bold text-sm">
														{t.score.toLocaleString()}
													</div>
													{!isElim && (
														<div className="text-[10px] text-muted-foreground">
															{ticketPct}% pool
														</div>
													)}
												</TableCell>

												{/* Active Players */}
												<TableCell className="text-right tabular-nums">
													<div className="font-medium">
														{activeMembers.toLocaleString()}
													</div>
													<div className="text-[10px] text-muted-foreground">
														of {t.membersCount.toLocaleString()}
													</div>
												</TableCell>

												{/* Attacks */}
												<TableCell className="text-right tabular-nums font-medium">
													{t.attacks.toLocaleString()}
												</TableCell>

												{/* Record & Win Rate */}
												<TableCell className="text-right tabular-nums">
													<div className="font-medium">
														{t.wins}W - {t.losses}L
													</div>
													<div className="text-[10px] text-muted-foreground">
														{winRate}% WR
													</div>
												</TableCell>

												{/* Peak TCT Hour */}
												<TableCell className="text-center font-mono text-xs tabular-nums text-muted-foreground">
													{formatHour(t.mostActiveHour)}
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>

			{/* 2. Hourly Distribution Heatmap Matrix across 00-23 TCT */}
			<Card>
				<CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4">
					<div>
						<CardTitle>Hourly Activity Distribution</CardTitle>
						<p className="text-xs text-muted-foreground mt-1">
							{distributionMode === "current"
								? "Current: Most recent recorded activity per hour"
								: "Average: Historical mean activity across all recorded tournament data"}
						</p>
					</div>
					<Tabs
						value={distributionMode}
						onValueChange={(val) =>
							setDistributionMode(val as "current" | "average")
						}
						className="w-auto"
					>
						<TabsList className="h-8">
							<TabsTrigger value="current" className="text-xs px-3">
								Current (Last Hour)
							</TabsTrigger>
							<TabsTrigger value="average" className="text-xs px-3">
								Average (All Data)
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</CardHeader>
				<CardContent>
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-40 font-mono text-xs">Team</TableHead>
									<TableHead className="w-16 font-mono text-xs text-center">
										Lives
									</TableHead>
									<TableHead className="w-16 font-mono text-xs text-center">
										Least
									</TableHead>
									<TableHead className="w-16 font-mono text-xs text-center">
										Most
									</TableHead>
									{HOURS.map((h) => {
										const isCurrent = h === currentTctHour;
										return (
											<TableHead
												key={h}
												className={`w-9 font-mono text-[10px] text-center p-1 ${
													isCurrent
														? "text-primary font-bold bg-primary/10 rounded-t"
														: ""
												}`}
												title={
													isCurrent
														? `Hour ${formatHour(h)} TCT (Current TCT Hour)`
														: undefined
												}
											>
												{String(h).padStart(2, "0")}
											</TableHead>
										);
									})}
								</TableRow>
							</TableHeader>
							<TableBody>
								{teams.map((t) => {
									const isElim = t.eliminated || t.lives <= 0;
									const dist =
										distributionMode === "current"
											? (t.currentHourly ?? t.hourlyDistribution)
											: (t.averageHourly ?? t.hourlyDistribution);
									const stats = getHourStats(dist);

									return (
										<TableRow
											key={t.teamId}
											className={isElim ? "opacity-60" : ""}
										>
											<TableCell className="font-mono text-xs font-medium whitespace-nowrap">
												<div className="flex items-center gap-1.5">
													<span
														className={
															isElim ? "line-through text-muted-foreground" : ""
														}
													>
														{t.name}
													</span>
													{isElim && (
														<Badge
															variant="destructive"
															className="text-[9px] px-1 py-0 h-4 uppercase"
														>
															Out
														</Badge>
													)}
												</div>
											</TableCell>
											<TableCell className="font-mono text-xs text-center tabular-nums">
												{t.lives}/50
											</TableCell>
											<TableCell className="font-mono text-xs text-center text-muted-foreground">
												{formatHour(stats.least)}
											</TableCell>
											<TableCell className="font-mono text-xs text-center font-semibold text-emerald-500">
												{formatHour(stats.most)}
											</TableCell>
											{HOURS.map((h) => {
												const val = dist[h] ?? 0;
												const ratio = val / maxActivity;

												let cellClass = "bg-muted/10 text-muted-foreground/40";
												if (isElim) {
													cellClass = "bg-muted/5 text-muted-foreground/20";
												} else if (ratio > 0.75) {
													cellClass =
														"bg-emerald-500/80 text-emerald-950 font-bold dark:text-white";
												} else if (ratio > 0.5) {
													cellClass =
														"bg-emerald-500/50 text-foreground font-semibold";
												} else if (ratio > 0.25) {
													cellClass = "bg-emerald-500/25 text-foreground";
												} else if (ratio > 0) {
													cellClass = "bg-emerald-500/10 text-foreground/80";
												}

												return (
													<TableCell
														key={h}
														className={`p-1 text-center font-mono text-[10px] tabular-nums border border-border/20 ${cellClass}`}
														title={`${t.name} @ ${formatHour(h)}: ${val} activity (${distributionMode === "current" ? "Latest Snapshot" : "Average"})`}
													>
														{val > 0 ? val : "·"}
													</TableCell>
												);
											})}
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>

					<div className="flex items-center justify-end gap-2 mt-4 text-[11px] font-mono text-muted-foreground">
						<span>Activity Scale:</span>
						<span className="inline-block size-3 rounded bg-muted/20 border" />
						<span>0</span>
						<span className="inline-block size-3 rounded bg-emerald-500/10" />
						<span>Low</span>
						<span className="inline-block size-3 rounded bg-emerald-500/50" />
						<span>Med</span>
						<span className="inline-block size-3 rounded bg-emerald-500/80" />
						<span>Peak</span>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
