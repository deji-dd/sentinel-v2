import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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

export interface TeamAttackBreakdownItem {
	teamId: number;
	teamName: string;
	count: number;
	percentage: number;
}

export interface TeamAttackBreakdown {
	teamId: number;
	teamName: string;
	incoming: {
		total: number;
		byTeam: TeamAttackBreakdownItem[];
	};
	outgoing: {
		total: number;
		byTeam: TeamAttackBreakdownItem[];
	};
	topThreat: TeamAttackBreakdownItem | null;
	topTarget: TeamAttackBreakdownItem | null;
}

export interface RecentAttackItem {
	id: string;
	attackerId: number;
	attackerName: string;
	attackerTeamId: number;
	attackerTeamName: string;
	victimId: number;
	victimName: string;
	victimTeamId: number;
	victimTeamName: string;
	details: string | null;
	detectedAt: string;
}

export interface AttackMatrixResponse {
	teams: Array<{
		id: number;
		name: string;
		lives: number;
		score: number;
		position: number;
		eliminated: boolean;
	}>;
	matrix: Record<number, Record<number, number>>;
	teamBreakdowns: Record<number, TeamAttackBreakdown>;
	recentAttacks: RecentAttackItem[];
	totalRecordedAttacks: number;
	timeframe: "all" | "24h" | "1h";
}

function mergeAttackMatrixData(
	incoming: AttackMatrixResponse,
	prev: AttackMatrixResponse | null,
): AttackMatrixResponse {
	if (!prev) return incoming;
	const prevScoreMap = new Map(prev.teams.map((t) => [t.id, t.score]));
	const mergedTeams = incoming.teams.map((team) => {
		const prevScore = prevScoreMap.get(team.id);
		if (team.score === 0 && !team.eliminated && prevScore && prevScore > 0) {
			return { ...team, score: prevScore };
		}
		return team;
	});
	return {
		...incoming,
		teams: mergedTeams,
	};
}

export function ElimsAttackMatrix() {
	const [data, setData] = useState<AttackMatrixResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [wsConnected, setWsConnected] = useState(false);
	const [timeframe, setTimeframe] = useState<"all" | "24h" | "1h">("all");
	const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
	const wsRef = useRef<WebSocket | null>(null);

	// 1. REST fallback / initial fetch
	const fetchAttackData = useCallback(async () => {
		try {
			const res = await api.api.v1.elims["attack-matrix"].get({
				query: { timeframe },
			});
			if (res.data && "teams" in res.data) {
				const responseData = res.data as unknown as AttackMatrixResponse;
				setData((prev) => mergeAttackMatrixData(responseData, prev));
				// Default selected team to team 88 or first alive team
				setSelectedTeamId((prev) => {
					if (prev) return prev;
					const defaultTeam =
						responseData.teams.find((t) => t.id === 88) ??
						responseData.teams[0];
					return defaultTeam?.id ?? null;
				});
			}
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to load attack telemetry data.",
			);
		} finally {
			setLoading(false);
		}
	}, [timeframe]);

	// Initial fetch
	useEffect(() => {
		fetchAttackData();
	}, [fetchAttackData]);

	// 2. Real-time WebSocket streaming
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
					if (ws?.readyState === WebSocket.OPEN) {
						ws.send(JSON.stringify({ type: "get_attack_matrix", timeframe }));
					}
				};

				ws.onmessage = (event) => {
					try {
						const message = JSON.parse(event.data);
						if (message.type === "elims_attack_matrix" && message.data) {
							const responseData = message.data as AttackMatrixResponse;
							setData((prev) => mergeAttackMatrixData(responseData, prev));
							setLoading(false);
							setSelectedTeamId((prev) => {
								if (prev) return prev;
								const defaultTeam =
									responseData.teams.find((t) => t.id === 88) ??
									responseData.teams[0];
								return defaultTeam?.id ?? null;
							});
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
					reconnectTimeout = setTimeout(connect, 3000);
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
	}, [timeframe]);

	// 3. Fallback polling only when WebSocket is disconnected
	useEffect(() => {
		if (wsConnected) return;
		const interval = setInterval(fetchAttackData, 6000);
		return () => clearInterval(interval);
	}, [wsConnected, fetchAttackData]);

	const handleTimeframeChange = (val: "all" | "24h" | "1h") => {
		setTimeframe(val);
		if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
			wsRef.current.send(
				JSON.stringify({ type: "get_attack_matrix", timeframe: val }),
			);
		}
	};

	const selectedBreakdown = useMemo(() => {
		if (!data || !selectedTeamId) return null;
		return data.teamBreakdowns[selectedTeamId] ?? null;
	}, [data, selectedTeamId]);

	const selectedTeamMeta = useMemo(() => {
		if (!data || !selectedTeamId) return null;
		return data.teams.find((t) => t.id === selectedTeamId) ?? null;
	}, [data, selectedTeamId]);

	// Find max attack cell value in the matrix for color heat scaling
	const maxCellVal = useMemo(() => {
		if (!data) return 1;
		let max = 1;
		for (const row of Object.values(data.matrix)) {
			for (const val of Object.values(row)) {
				if (val > max) max = val;
			}
		}
		return max;
	}, [data]);

	if (loading && !data) {
		return (
			<div className="flex flex-col gap-4">
				<Skeleton className="h-10 w-64" />
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<Skeleton className="h-72 w-full" />
					<Skeleton className="h-72 w-full" />
				</div>
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	const teams = data?.teams ?? [];

	return (
		<div className="flex flex-col gap-6">
			{/* Controls Bar: Timeframe & Focus Selector */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-card/60 p-4 rounded-xl border border-border">
				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-2">
						<span className="font-mono text-sm font-semibold tracking-tight">
							Attack Flow
						</span>
					</div>

					<Badge variant="outline" className="font-mono text-xs">
						{data?.totalRecordedAttacks.toLocaleString() ?? 0} confirmed attacks
					</Badge>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					{/* Timeframe Filter */}
					<Tabs
						value={timeframe}
						onValueChange={(val) =>
							handleTimeframeChange(val as "all" | "24h" | "1h")
						}
					>
						<TabsList className="h-8">
							<TabsTrigger value="all" className="text-xs px-2.5">
								All Time
							</TabsTrigger>
							<TabsTrigger value="24h" className="text-xs px-2.5">
								Last 24h
							</TabsTrigger>
							<TabsTrigger value="1h" className="text-xs px-2.5">
								Last 1h
							</TabsTrigger>
						</TabsList>
					</Tabs>

					{/* Team Spotlight Dropdown */}
					<div className="w-52">
						<Select
							value={selectedTeamId ? String(selectedTeamId) : ""}
							onValueChange={(val) => setSelectedTeamId(Number(val))}
						>
							<SelectTrigger className="h-8 text-xs font-mono">
								<SelectValue placeholder="Select team spotlight..." />
							</SelectTrigger>
							<SelectContent>
								{teams.map((t) => (
									<SelectItem
										key={t.id}
										value={String(t.id)}
										className="font-mono text-xs"
									>
										{t.name} ({t.lives} HP)
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			</div>

			{/* Section 1: Team Spotlight - Side-by-Side Incoming vs Outgoing Breakdown */}
			{selectedBreakdown && selectedTeamMeta && (
				<div className="flex flex-col gap-4">
					{/* Team Header Banner */}
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-muted/20 rounded-lg border border-border/80">
						<div className="flex items-center gap-3">
							<div className="size-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center font-mono font-bold text-primary text-sm">
								#{selectedTeamMeta.position}
							</div>
							<div>
								<div className="flex items-center gap-2">
									<h2 className="text-base font-bold tracking-tight">
										{selectedTeamMeta.name}
									</h2>
									{selectedTeamMeta.eliminated && (
										<Badge
											variant="destructive"
											className="text-[10px] uppercase"
										>
											Out
										</Badge>
									)}
								</div>
								<p className="text-xs text-muted-foreground font-mono">
									{selectedTeamMeta.lives} Lives Remaining • Score:{" "}
									{selectedTeamMeta.score.toLocaleString()}
								</p>
							</div>
						</div>

						{/* Attack Balance Metric */}
						<div className="flex items-center gap-4 font-mono text-xs">
							<div className="text-right">
								<div className="text-muted-foreground text-[11px]">
									Total Incoming
								</div>
								<div className="text-destructive font-bold text-sm">
									{selectedBreakdown.incoming.total.toLocaleString()}
								</div>
							</div>
							<div className="h-8 w-px bg-border" />
							<div className="text-right">
								<div className="text-muted-foreground text-[11px]">
									Total Outgoing
								</div>
								<div className="text-emerald-500 font-bold text-sm">
									{selectedBreakdown.outgoing.total.toLocaleString()}
								</div>
							</div>
						</div>
					</div>

					{/* Breakdown Cards Grid */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{/* 1. Incoming Attacks Breakdown */}
						<Card className="border-border/80">
							<CardHeader className="pb-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<CardTitle className="text-sm font-semibold">
											Incoming Attacks
										</CardTitle>
									</div>
									<Badge
										variant="outline"
										className="font-mono text-[11px] text-destructive border-destructive/30 bg-destructive/10"
									>
										<ArrowDownLeft className="size-3 mr-1" />
										{selectedBreakdown.incoming.total.toLocaleString()} Hits
									</Badge>
								</div>
								<CardDescription className="text-xs">
									Where attacks are coming from (Who is attacking{" "}
									{selectedTeamMeta.name}?)
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{selectedBreakdown.incoming.byTeam.length === 0 ? (
									<div className="py-8 text-center text-xs font-mono text-muted-foreground">
										No confirmed incoming attacks recorded for this timeframe.
									</div>
								) : (
									selectedBreakdown.incoming.byTeam.map((item) => (
										<div key={item.teamId} className="flex flex-col gap-1.5">
											<div className="flex items-center justify-between text-xs font-mono">
												<span className="font-medium truncate max-w-[200px]">
													{item.teamName}
												</span>
												<div className="flex items-center gap-2 shrink-0">
													<span className="font-bold text-foreground">
														{item.count.toLocaleString()}
													</span>
													<span className="text-muted-foreground font-semibold min-w-[45px] text-right text-destructive">
														{item.percentage}%
													</span>
												</div>
											</div>
											{/* Percentage Visual Bar */}
											<div className="w-full h-2 bg-muted/40 rounded-full overflow-hidden">
												<div
													className="h-full bg-destructive rounded-full transition-all duration-300"
													style={{ width: `${Math.max(2, item.percentage)}%` }}
												/>
											</div>
										</div>
									))
								)}
							</CardContent>
						</Card>

						{/* 2. Outgoing Attacks Breakdown */}
						<Card className="border-border/80">
							<CardHeader className="pb-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<CardTitle className="text-sm font-semibold">
											Outgoing Attacks
										</CardTitle>
									</div>
									<Badge
										variant="outline"
										className="font-mono text-[11px] text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
									>
										<ArrowUpRight className="size-3 mr-1" />
										{selectedBreakdown.outgoing.total.toLocaleString()} Hits
									</Badge>
								</div>
								<CardDescription className="text-xs">
									Where attacks are going to (Who is {selectedTeamMeta.name}{" "}
									targeting?)
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{selectedBreakdown.outgoing.byTeam.length === 0 ? (
									<div className="py-8 text-center text-xs font-mono text-muted-foreground">
										No confirmed outgoing attacks recorded for this timeframe.
									</div>
								) : (
									selectedBreakdown.outgoing.byTeam.map((item) => (
										<div key={item.teamId} className="flex flex-col gap-1.5">
											<div className="flex items-center justify-between text-xs font-mono">
												<span className="font-medium truncate max-w-[200px]">
													{item.teamName}
												</span>
												<div className="flex items-center gap-2 shrink-0">
													<span className="font-bold text-foreground">
														{item.count.toLocaleString()}
													</span>
													<span className="text-muted-foreground font-semibold min-w-[45px] text-right text-emerald-500">
														{item.percentage}%
													</span>
												</div>
											</div>
											{/* Percentage Visual Bar */}
											<div className="w-full h-2 bg-muted/40 rounded-full overflow-hidden">
												<div
													className="h-full bg-emerald-500 rounded-full transition-all duration-300"
													style={{ width: `${Math.max(2, item.percentage)}%` }}
												/>
											</div>
										</div>
									))
								)}
							</CardContent>
						</Card>
					</div>
				</div>
			)}

			{/* Section 2: 12x12 Cross-Team Attack Matrix Heatmap */}
			<Card className="border-border/80">
				<CardHeader className="pb-3">
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<div>
							<div className="flex items-center gap-2">
								<CardTitle className="text-sm font-semibold">
									12×12 Inter-Team War Matrix
								</CardTitle>
							</div>
							<CardDescription className="text-xs mt-1">
								Rows represent the <strong>Attacking Team</strong>; Columns
								represent the <strong>Victim Team</strong>. Click any row or
								header to spotlight that team.
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-40 font-mono text-xs">
										Attacker \ Target
									</TableHead>
									{teams.map((t) => (
										<TableHead
											key={t.id}
											onClick={() => setSelectedTeamId(t.id)}
											className={`w-12 font-mono text-[10px] text-center p-1 cursor-pointer select-none hover:text-primary ${
												selectedTeamId === t.id
													? "bg-primary/10 text-primary font-bold rounded-t"
													: ""
											}`}
											title={`Target: ${t.name}`}
										>
											{t.name.substring(0, 4)}
										</TableHead>
									))}
									<TableHead className="w-16 font-mono text-xs text-right pr-2">
										Total
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{teams.map((attacker) => {
									let rowTotal = 0;
									const isSelected = selectedTeamId === attacker.id;

									return (
										<TableRow
											key={attacker.id}
											className={isSelected ? "bg-primary/5 font-semibold" : ""}
										>
											<TableCell
												onClick={() => setSelectedTeamId(attacker.id)}
												className="font-mono text-xs font-medium cursor-pointer hover:text-primary truncate max-w-[160px]"
											>
												<span
													className={isSelected ? "text-primary font-bold" : ""}
												>
													{attacker.name}
												</span>
											</TableCell>

											{teams.map((target) => {
												if (attacker.id === target.id) {
													return (
														<TableCell
															key={target.id}
															className="p-1 text-center font-mono text-[10px] bg-muted/10 text-muted-foreground/30 select-none border border-border/20"
														>
															—
														</TableCell>
													);
												}

												const hits =
													data?.matrix[attacker.id]?.[target.id] ?? 0;
												rowTotal += hits;
												const ratio = hits / maxCellVal;

												let cellClass = "bg-muted/5 text-muted-foreground/30";
												if (ratio > 0.6) {
													cellClass =
														"bg-red-500/80 text-white font-bold dark:text-white";
												} else if (ratio > 0.3) {
													cellClass =
														"bg-red-500/50 text-foreground font-semibold";
												} else if (ratio > 0.1) {
													cellClass = "bg-red-500/25 text-foreground";
												} else if (hits > 0) {
													cellClass = "bg-red-500/10 text-foreground/80";
												}

												return (
													<TableCell
														key={target.id}
														className={`p-1 text-center font-mono text-[10px] tabular-nums border border-border/20 ${cellClass}`}
														title={`${attacker.name} ➔ ${target.name}: ${hits} hits`}
													>
														{hits > 0 ? hits : "·"}
													</TableCell>
												);
											})}

											<TableCell className="font-mono text-xs text-right tabular-nums pr-2 font-bold text-foreground">
												{rowTotal.toLocaleString()}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>

					<div className="flex items-center justify-between mt-4 text-[11px] font-mono text-muted-foreground">
						<div className="flex items-center gap-1">
							<span>Tip:</span>
							<span>Click any team name to filter spotlight breakdown</span>
						</div>
						<div className="flex items-center gap-2">
							<span>Heat Scale:</span>
							<span className="inline-block size-3 rounded bg-muted/20 border" />
							<span>0</span>
							<span className="inline-block size-3 rounded bg-red-500/10" />
							<span>Low</span>
							<span className="inline-block size-3 rounded bg-red-500/50" />
							<span>Med</span>
							<span className="inline-block size-3 rounded bg-red-500/80" />
							<span>High</span>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Section 3: Live Attack Telemetry Ticker */}
			<Card className="border-border/80">
				<CardHeader className="pb-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<CardTitle className="text-sm font-semibold">
								Latest Confirmed Attacks
							</CardTitle>
						</div>
					</div>
				</CardHeader>
				<CardContent className="p-0">
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-24 font-mono text-xs">Time</TableHead>
									<TableHead className="font-mono text-xs">Attacker</TableHead>
									<TableHead className="w-12 text-center font-mono text-xs" />
									<TableHead className="font-mono text-xs">Victim</TableHead>
									<TableHead className="font-mono text-xs text-right pr-4">
										Details
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{!data?.recentAttacks || data.recentAttacks.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={5}
											className="h-24 text-center text-sm font-mono text-muted-foreground"
										>
											No live attacks recorded yet. Tracking active.
										</TableCell>
									</TableRow>
								) : (
									data.recentAttacks.map((att) => {
										const timeStr = new Date(att.detectedAt)
											.toISOString()
											.substring(11, 19);
										return (
											<TableRow key={att.id}>
												<TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
													{timeStr} TCT
												</TableCell>
												<TableCell className="font-mono text-xs font-medium">
													<div className="flex items-center gap-1.5">
														<Badge
															variant="outline"
															className="text-[10px] px-1.5 py-0 h-4 border-emerald-500/30 text-emerald-500"
														>
															{att.attackerTeamName}
														</Badge>
														<span>{att.attackerName}</span>
													</div>
												</TableCell>
												<TableCell className="text-center font-mono text-xs text-muted-foreground">
													➔
												</TableCell>
												<TableCell className="font-mono text-xs font-medium">
													<div className="flex items-center gap-1.5">
														<Badge
															variant="outline"
															className="text-[10px] px-1.5 py-0 h-4 border-destructive/30 text-destructive"
														>
															{att.victimTeamName}
														</Badge>
														<span>{att.victimName}</span>
													</div>
												</TableCell>
												<TableCell className="font-mono text-xs text-right text-muted-foreground pr-4 truncate max-w-[250px]">
													{att.details ?? "Hospitalized"}
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
		</div>
	);
}
