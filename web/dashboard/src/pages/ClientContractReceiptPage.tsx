import {
	AlertTriangle,
	ArrowUpDown,
	Clock,
	Download,
	ExternalLink,
	History,
	Loader2,
	RefreshCw,
	Search,
	Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface ReceiptTarget {
	defenderId: number;
	defenderName: string;
	totalHits: number;
	standardHitsReceived: number;
	strickenHitsReceived: number;
	standardRate?: number;
	strickenRate?: number;
	totalCost: number;
}

interface ReceiptHit {
	id: string;
	attackId: number;
	targetId: number;
	targetName: string;
	result: string;
	isStricken: boolean;
	cost: number;
	timestamp: string;
}

interface ReceiptData {
	contract: {
		id: string;
		guildId: string;
		factionId: number;
		factionName: string;
		warStatusAtCreation: "no_war" | "upcoming" | "active";
		warOpponent?: {
			id: number;
			name: string;
		} | null;
		startTime: string;
		endTime: string | null;
		status: "active" | "upcoming" | "completed" | "cancelled";
		hitPrice: number;
		strickenHitPrice?: number | null;
		excludedMembers?: number[];
		createdAt: string;
	};
	summary: {
		totalHits: number;
		totalPayout: number;
		targetsHitCount: number;
		targetBreakdown: ReceiptTarget[];
		hits?: ReceiptHit[];
	};
}

interface ClientContractReceiptPageProps {
	contractId: string;
}

export function formatTctDateTime(date: Date | string): string {
	const d = typeof date === "string" ? new Date(date) : date;
	if (Number.isNaN(d.getTime())) return String(date);
	const pad = (n: number) => n.toString().padStart(2, "0");
	const hours = pad(d.getUTCHours());
	const minutes = pad(d.getUTCMinutes());
	const seconds = pad(d.getUTCSeconds());
	const day = pad(d.getUTCDate());
	const month = pad(d.getUTCMonth() + 1);
	const year = d.getUTCFullYear();
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} TCT`;
}

export function ClientContractReceiptPage({
	contractId,
}: ClientContractReceiptPageProps) {
	const { toast } = useToast();
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [data, setData] = useState<ReceiptData | null>(null);

	// Client view tab: "targets" (breakdown) or "history" (chronological hit log)
	const [activeTab, setActiveTab] = useState<"targets" | "history">("targets");

	// Targets filter/sort
	const [targetSearchQuery, setTargetSearchQuery] = useState("");
	const [targetSortField, setTargetSortField] = useState<
		"hits" | "name" | "cost"
	>("hits");
	const [targetSortAsc, setTargetSortAsc] = useState(false);

	// Hit History filter/sort
	const [hitSearchQuery, setHitSearchQuery] = useState("");
	const [hitSortField, setHitSortField] = useState<"time" | "name" | "cost">(
		"time",
	);
	const [hitSortAsc, setHitSortAsc] = useState(false);

	const fetchReceipt = async (silent = false) => {
		if (!silent) setRefreshing(true);
		try {
			const res = await api.v2.merc.contracts({ contractId }).receipt.get();

			if (res.error || !res.data || !("contract" in res.data)) {
				const errMsg =
					res.data && "error" in res.data && typeof res.data.error === "string"
						? res.data.error
						: "Failed to load contract receipt.";
				setError(errMsg);
			} else {
				setData(res.data as unknown as ReceiptData);
				setError(null);
			}
		} catch (err) {
			if (!silent) {
				setError(
					err instanceof Error
						? err.message
						: "Error fetching contract receipt.",
				);
			}
		} finally {
			setLoading(false);
			if (!silent) setRefreshing(false);
		}
	};

	useEffect(() => {
		fetchReceipt();

		// Auto-poll every 15s while active contract
		const interval = setInterval(() => {
			if (data?.contract.status === "active") {
				fetchReceipt(true);
			}
		}, 15_000);

		return () => clearInterval(interval);
	}, [contractId, data?.contract.status]);

	// Filter and sort client targets
	const filteredTargets = useMemo(() => {
		if (!data?.summary.targetBreakdown) return [];

		const query = targetSearchQuery.trim().toLowerCase();
		const list = data.summary.targetBreakdown.filter((t) => {
			if (!query) return true;
			return (
				t.defenderName.toLowerCase().includes(query) ||
				String(t.defenderId).includes(query)
			);
		});

		return list.sort((a, b) => {
			let comp = 0;
			if (targetSortField === "hits") {
				comp = b.totalHits - a.totalHits;
			} else if (targetSortField === "cost") {
				comp = b.totalCost - a.totalCost;
			} else {
				comp = a.defenderName.localeCompare(b.defenderName);
			}
			return targetSortAsc ? -comp : comp;
		});
	}, [data, targetSearchQuery, targetSortField, targetSortAsc]);

	// Filter and sort hits history
	const filteredHits = useMemo(() => {
		if (!data?.summary.hits) return [];

		const query = hitSearchQuery.trim().toLowerCase();
		const list = data.summary.hits.filter((h) => {
			if (!query) return true;
			return (
				h.targetName.toLowerCase().includes(query) ||
				String(h.targetId).includes(query) ||
				h.result.toLowerCase().includes(query)
			);
		});

		return list.sort((a, b) => {
			let comp = 0;
			if (hitSortField === "time") {
				comp =
					new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
			} else if (hitSortField === "cost") {
				comp = b.cost - a.cost;
			} else {
				comp = a.targetName.localeCompare(b.targetName);
			}
			return hitSortAsc ? -comp : comp;
		});
	}, [data, hitSearchQuery, hitSortField, hitSortAsc]);

	const downloadCsvFile = (content: string, filename: string) => {
		const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", filename);
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const handleDownloadTargetsCsv = () => {
		if (!data) return;

		let csv =
			"Target Name,Torn ID,Total Times Hit,Standard Hits,Stricken Hits,Total Cost ($)\n";
		for (const t of data.summary.targetBreakdown) {
			csv += `"${t.defenderName.replace(/"/g, '""')}",${t.defenderId},${t.totalHits},${t.standardHitsReceived},${t.strickenHitsReceived},${t.totalCost}\n`;
		}

		downloadCsvFile(
			csv,
			`client_targets_${data.contract.factionId}_${data.contract.id}.csv`,
		);
		toast("Client Target Breakdown CSV exported!", "success");
	};

	const handleDownloadHitsCsv = () => {
		if (!data?.summary.hits) return;

		let csv = "Timestamp (TCT),Target Name,Torn ID,Result,Stricken,Cost ($)\n";
		for (const h of data.summary.hits) {
			csv += `"${formatTctDateTime(h.timestamp)}","${h.targetName.replace(/"/g, '""')}",${h.targetId},"${h.result}",${h.isStricken ? "Yes" : "No"},${h.cost}\n`;
		}

		downloadCsvFile(
			csv,
			`client_hit_history_${data.contract.factionId}_${data.contract.id}.csv`,
		);
		toast("Client Hit History Log CSV exported!", "success");
	};

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground px-4">
				<Loader2 className="size-8 animate-spin text-primary mb-4" />
				<div className="font-mono text-sm tracking-wider uppercase text-muted-foreground">
					Loading Contract Receipt...
				</div>
			</div>
		);
	}

	if (error || !data) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground px-4">
				<Card className="max-w-md w-full border-border/80 bg-card/90 shadow-2xl backdrop-blur-md rounded-2xl p-6 text-center space-y-4">
					<div className="size-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mx-auto">
						<AlertTriangle className="size-6" />
					</div>
					<h2 className="text-xl font-bold tracking-tight">
						Receipt Not Found
					</h2>
					<p className="text-sm text-muted-foreground">
						{error ?? "Contract not found."}
					</p>
					<Button
						onClick={() => fetchReceipt()}
						variant="outline"
						className="mt-2"
					>
						Retry
					</Button>
				</Card>
			</div>
		);
	}

	const { contract, summary } = data;
	const totalHitsCount = summary.totalHits ?? 0;
	const totalAccruedCost = summary.totalPayout ?? 0;
	const standardHitsCount = summary.targetBreakdown.reduce(
		(acc, t) => acc + t.standardHitsReceived,
		0,
	);
	const strickenHitsCount = summary.targetBreakdown.reduce(
		(acc, t) => acc + t.strickenHitsReceived,
		0,
	);
	const hitsList = summary.hits ?? [];

	return (
		<div className="min-h-screen bg-background text-foreground py-10 px-4 flex justify-center">
			<div className="max-w-4xl w-full space-y-8">
				{/* Top Branding & Status Header */}
				<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-6">
					<div>
						<div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs font-mono uppercase tracking-wider mb-2">
							Subversive Merc Service • Client Receipt
						</div>
						<h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
							{contract.factionName}
						</h1>
						<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono mt-1">
							<span>CONTRACT: {contract.id.slice(0, 8)}</span>
							<span>•</span>
							<span>
								CREATED: {new Date(contract.createdAt).toLocaleDateString()}
							</span>
							{contract.warOpponent && (
								<>
									<span>•</span>
									<span>WAR OPPONENT: {contract.warOpponent.name}</span>
								</>
							)}
						</div>
					</div>

					<div className="flex items-center gap-2">
						<Badge
							className={`font-mono text-xs uppercase px-3 py-1 ${
								contract.status === "active"
									? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
									: contract.status === "completed"
										? "bg-muted text-muted-foreground border border-border"
										: "bg-amber-500/10 text-amber-400 border border-amber-500/30"
							}`}
						>
							{contract.status === "active" && (
								<span className="size-2 rounded-full bg-emerald-400 animate-pulse mr-1.5 inline-block" />
							)}
							{contract.status}
						</Badge>

						<Button
							variant="outline"
							size="sm"
							onClick={() => fetchReceipt()}
							disabled={refreshing}
							className="h-8 gap-1.5 text-xs font-mono"
						>
							<RefreshCw
								className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
							/>
							Refresh
						</Button>

						{activeTab === "targets" ? (
							<Button
								variant="outline"
								size="sm"
								onClick={handleDownloadTargetsCsv}
								className="h-8 gap-1.5 text-xs font-mono"
							>
								<Download className="size-3.5" />
								Targets CSV
							</Button>
						) : (
							<Button
								variant="outline"
								size="sm"
								onClick={handleDownloadHitsCsv}
								className="h-8 gap-1.5 text-xs font-mono"
							>
								<Download className="size-3.5" />
								Hit History CSV
							</Button>
						)}
					</div>
				</div>

				{/* High-Level Metric Cards */}
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
					<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
						<span className="text-[11px] font-mono text-muted-foreground uppercase">
							TOTAL HITS RECORDED
						</span>
						<div className="text-2xl font-black text-foreground">
							{totalHitsCount.toLocaleString()}
						</div>
					</Card>

					<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
						<span className="text-[11px] font-mono text-muted-foreground uppercase">
							TOTAL ACCRUED COST
						</span>
						<div className="text-2xl font-black text-emerald-400">
							${totalAccruedCost.toLocaleString()}
						</div>
					</Card>

					<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
						<span className="text-[11px] font-mono text-muted-foreground uppercase">
							STANDARD HITS
						</span>
						<div className="text-2xl font-black text-foreground">
							{standardHitsCount.toLocaleString()}
						</div>
					</Card>

					<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
						<span className="text-[11px] font-mono text-muted-foreground uppercase">
							STRICKEN HITS
						</span>
						<div className="text-2xl font-black text-purple-400">
							{strickenHitsCount.toLocaleString()}
						</div>
					</Card>
				</div>

				{/* Tab Selector: Target Breakdown vs Hit History */}
				<div className="flex items-center gap-2 border-b border-border/40 pb-2">
					<Button
						variant={activeTab === "targets" ? "default" : "ghost"}
						size="sm"
						onClick={() => setActiveTab("targets")}
						className="gap-2 font-mono text-xs"
					>
						<Users className="size-3.5" />
						Target Breakdown ({summary.targetBreakdown.length})
					</Button>
					<Button
						variant={activeTab === "history" ? "default" : "ghost"}
						size="sm"
						onClick={() => setActiveTab("history")}
						className="gap-2 font-mono text-xs"
					>
						<History className="size-3.5" />
						Hit History Log ({hitsList.length})
					</Button>
				</div>

				{/* ═══════════════════════════════════════════════════════════════ */}
				{/* TAB 1: FACTION TARGET BREAKDOWN */}
				{/* ═══════════════════════════════════════════════════════════════ */}
				{activeTab === "targets" && (
					<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
						<CardHeader className="border-b border-border/40 pb-4">
							<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
								<CardTitle className="text-base font-semibold flex items-center gap-2">
									Faction Target Breakdown ({filteredTargets.length})
								</CardTitle>

								<div className="relative max-w-xs w-full">
									<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
									<Input
										placeholder="Filter member name or ID..."
										value={targetSearchQuery}
										onChange={(e) => setTargetSearchQuery(e.target.value)}
										className="h-8 pl-8 text-xs font-mono bg-background"
									/>
								</div>
							</div>
						</CardHeader>
						<CardContent className="pt-4 p-0">
							{filteredTargets.length === 0 ? (
								<div className="p-8 text-center text-sm text-muted-foreground space-y-2">
									<p>No targets recorded yet.</p>
									<p className="text-xs">
										When mercenaries land hits against your faction members,
										they will appear here in real time.
									</p>
								</div>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-left text-xs font-sans">
										<thead className="bg-muted/30 text-muted-foreground font-mono text-[11px] border-b border-border/40">
											<tr>
												<th
													className="py-2.5 px-4 cursor-pointer"
													onClick={() => {
														if (targetSortField === "name")
															setTargetSortAsc(!targetSortAsc);
														else {
															setTargetSortField("name");
															setTargetSortAsc(false);
														}
													}}
												>
													<div className="flex items-center gap-1">
														FACTION MEMBER
														<ArrowUpDown className="size-3" />
													</div>
												</th>
												<th
													className="py-2.5 px-4 text-center cursor-pointer"
													onClick={() => {
														if (targetSortField === "hits")
															setTargetSortAsc(!targetSortAsc);
														else {
															setTargetSortField("hits");
															setTargetSortAsc(false);
														}
													}}
												>
													<div className="flex items-center justify-center gap-1">
														TOTAL HITS
														<ArrowUpDown className="size-3" />
													</div>
												</th>
												<th className="py-2.5 px-4 text-center">STANDARD</th>
												<th className="py-2.5 px-4 text-center">STRICKEN</th>
												<th
													className="py-2.5 px-4 text-right cursor-pointer"
													onClick={() => {
														if (targetSortField === "cost")
															setTargetSortAsc(!targetSortAsc);
														else {
															setTargetSortField("cost");
															setTargetSortAsc(false);
														}
													}}
												>
													<div className="flex items-center justify-end gap-1">
														TOTAL COST ($)
														<ArrowUpDown className="size-3" />
													</div>
												</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-border/20 font-mono">
											{filteredTargets.map((target) => (
												<tr
													key={target.defenderId}
													className="hover:bg-muted/10 transition-colors"
												>
													<td className="py-3 px-4 font-sans">
														<div className="font-semibold text-foreground flex items-center gap-1.5">
															<a
																href={`https://www.torn.com/profiles.php?XID=${target.defenderId}`}
																target="_blank"
																rel="noreferrer"
																className="hover:text-primary hover:underline flex items-center gap-1"
															>
																{target.defenderName}
																<ExternalLink className="size-3 text-muted-foreground" />
															</a>
														</div>
														<div className="text-[10px] text-muted-foreground font-mono">
															ID: {target.defenderId}
														</div>
													</td>
													<td className="py-3 px-4 text-center font-bold text-foreground">
														{target.totalHits}
													</td>
													<td className="py-3 px-4 text-center text-muted-foreground">
														{target.standardHitsReceived}
													</td>
													<td className="py-3 px-4 text-center text-purple-400 font-semibold">
														{target.strickenHitsReceived > 0
															? target.strickenHitsReceived
															: "-"}
													</td>
													<td className="py-3 px-4 text-right font-bold text-emerald-400">
														${target.totalCost.toLocaleString()}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</CardContent>
					</Card>
				)}

				{/* ═══════════════════════════════════════════════════════════════ */}
				{/* TAB 2: CHRONOLOGICAL HIT HISTORY LOG */}
				{/* ═══════════════════════════════════════════════════════════════ */}
				{activeTab === "history" && (
					<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
						<CardHeader className="border-b border-border/40 pb-4">
							<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
								<CardTitle className="text-base font-semibold flex items-center gap-2">
									Hit History Log ({filteredHits.length})
								</CardTitle>

								<div className="relative max-w-xs w-full">
									<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
									<Input
										placeholder="Filter target or result..."
										value={hitSearchQuery}
										onChange={(e) => setHitSearchQuery(e.target.value)}
										className="h-8 pl-8 text-xs font-mono bg-background"
									/>
								</div>
							</div>
						</CardHeader>
						<CardContent className="pt-4 p-0">
							{filteredHits.length === 0 ? (
								<div className="p-8 text-center text-sm text-muted-foreground space-y-2">
									<p>No hit history recorded yet.</p>
									<p className="text-xs">
										Individual hits landed by mercenaries during the contract
										will appear here in chronological order.
									</p>
								</div>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-left text-xs font-sans">
										<thead className="bg-muted/30 text-muted-foreground font-mono text-[11px] border-b border-border/40">
											<tr>
												<th
													className="py-2.5 px-4 cursor-pointer"
													onClick={() => {
														if (hitSortField === "time")
															setHitSortAsc(!hitSortAsc);
														else {
															setHitSortField("time");
															setHitSortAsc(false);
														}
													}}
												>
													<div className="flex items-center gap-1">
														TIMESTAMP (TCT)
														<ArrowUpDown className="size-3" />
													</div>
												</th>
												<th
													className="py-2.5 px-4 cursor-pointer"
													onClick={() => {
														if (hitSortField === "name")
															setHitSortAsc(!hitSortAsc);
														else {
															setHitSortField("name");
															setHitSortAsc(false);
														}
													}}
												>
													<div className="flex items-center gap-1">
														FACTION MEMBER
														<ArrowUpDown className="size-3" />
													</div>
												</th>
												<th className="py-2.5 px-4 text-center">RESULT</th>
												<th className="py-2.5 px-4 text-center">STRICKEN</th>
												<th
													className="py-2.5 px-4 text-right cursor-pointer"
													onClick={() => {
														if (hitSortField === "cost")
															setHitSortAsc(!hitSortAsc);
														else {
															setHitSortField("cost");
															setHitSortAsc(false);
														}
													}}
												>
													<div className="flex items-center justify-end gap-1">
														COST ($)
														<ArrowUpDown className="size-3" />
													</div>
												</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-border/20 font-mono">
											{filteredHits.map((hit) => (
												<tr
													key={hit.id}
													className="hover:bg-muted/10 transition-colors"
												>
													<td className="py-3 px-4 text-muted-foreground text-[11px]">
														<div className="flex items-center gap-1.5">
															<Clock className="size-3 text-muted-foreground" />
															{formatTctDateTime(hit.timestamp)}
														</div>
													</td>
													<td className="py-3 px-4 font-sans">
														<div className="font-semibold text-foreground flex items-center gap-1.5">
															<a
																href={`https://www.torn.com/profiles.php?XID=${hit.targetId}`}
																target="_blank"
																rel="noreferrer"
																className="hover:text-primary hover:underline flex items-center gap-1"
															>
																{hit.targetName}
																<ExternalLink className="size-3 text-muted-foreground" />
															</a>
														</div>
														<div className="text-[10px] text-muted-foreground font-mono">
															ID: {hit.targetId}
														</div>
													</td>
													<td className="py-3 px-4 text-center">
														<Badge
															variant="outline"
															className={`font-mono text-[10px] uppercase ${
																hit.result.toLowerCase() === "hospitalized"
																	? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
																	: "border-border text-muted-foreground"
															}`}
														>
															{hit.result}
														</Badge>
													</td>
													<td className="py-3 px-4 text-center">
														{hit.isStricken ? (
															<Badge className="font-mono text-[10px] uppercase bg-purple-500/20 text-purple-400 border border-purple-500/30">
																Stricken
															</Badge>
														) : (
															<span className="text-muted-foreground">-</span>
														)}
													</td>
													<td className="py-3 px-4 text-right font-bold text-emerald-400">
														${hit.cost.toLocaleString()}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}

export default ClientContractReceiptPage;
