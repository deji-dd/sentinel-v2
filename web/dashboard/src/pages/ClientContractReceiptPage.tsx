import {
	AlertTriangle,
	ArrowUpDown,
	Download,
	ExternalLink,
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

interface ReceiptMercPayout {
	attackerId: number;
	attackerName: string;
	attackerFactionId: number | null;
	attackerFactionName: string | null;
	totalHits: number;
	standardHits: number;
	strickenHits: number;
	totalPayout: number;
}

interface ReceiptFactionPayout {
	factionId: number | null;
	factionName: string;
	totalHits: number;
	totalPayout: number;
	mercs: ReceiptMercPayout[];
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
		createdAt: string;
	};
	summary: {
		totalHits: number;
		totalPayout: number;
		participatingMercsCount: number;
		targetsHitCount: number;
		targetBreakdown: ReceiptTarget[];
		mercPayouts?: ReceiptMercPayout[];
		factionPayouts?: ReceiptFactionPayout[];
	};
}

interface ClientContractReceiptPageProps {
	contractId: string;
}

export function ClientContractReceiptPage({
	contractId,
}: ClientContractReceiptPageProps) {
	const { toast } = useToast();
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [data, setData] = useState<ReceiptData | null>(null);

	// Receipt mode: "client" (targets) or "merc" (payouts)
	const [receiptMode, setReceiptMode] = useState<"client" | "merc">("client");

	// Client view filter/sort
	const [clientSearchQuery, setClientSearchQuery] = useState("");
	const [clientSortField, setClientSortField] = useState<
		"hits" | "name" | "cost"
	>("hits");
	const [clientSortAsc, setClientSortAsc] = useState(false);

	// Merc view state
	const [selectedMercFaction, setSelectedMercFaction] = useState<string>("all");
	const [mercSearchQuery, setMercSearchQuery] = useState("");
	const [mercSortField, setMercSortField] = useState<
		"hits" | "name" | "payout"
	>("payout");
	const [mercSortAsc, setMercSortAsc] = useState(false);

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

		// Auto-poll every 30s while active
		const interval = setInterval(() => {
			if (data?.contract.status === "active") {
				fetchReceipt(true);
			}
		}, 30_000);

		return () => clearInterval(interval);
	}, [contractId, data?.contract.status]);

	// Filter and sort client targets
	const filteredTargets = useMemo(() => {
		if (!data?.summary.targetBreakdown) return [];

		const query = clientSearchQuery.trim().toLowerCase();
		const list = data.summary.targetBreakdown.filter((t) => {
			if (!query) return true;
			return (
				t.defenderName.toLowerCase().includes(query) ||
				String(t.defenderId).includes(query)
			);
		});

		return list.sort((a, b) => {
			let comp = 0;
			if (clientSortField === "hits") {
				comp = b.totalHits - a.totalHits;
			} else if (clientSortField === "cost") {
				comp = b.totalCost - a.totalCost;
			} else {
				comp = a.defenderName.localeCompare(b.defenderName);
			}
			return clientSortAsc ? -comp : comp;
		});
	}, [data, clientSearchQuery, clientSortField, clientSortAsc]);

	// Mercenary payouts list based on selected faction
	const currentMercList = useMemo(() => {
		if (!data?.summary) return [];

		let rawList: ReceiptMercPayout[] = [];
		if (selectedMercFaction === "all") {
			rawList = data.summary.mercPayouts ?? [];
		} else {
			const factionGroup = data.summary.factionPayouts?.find(
				(f) =>
					(f.factionId ? String(f.factionId) : f.factionName) ===
					selectedMercFaction,
			);
			rawList = factionGroup?.mercs ?? [];
		}

		const query = mercSearchQuery.trim().toLowerCase();
		const filtered = rawList.filter((m) => {
			if (!query) return true;
			return (
				m.attackerName.toLowerCase().includes(query) ||
				String(m.attackerId).includes(query) ||
				(m.attackerFactionName?.toLowerCase().includes(query) ?? false)
			);
		});

		return filtered.sort((a, b) => {
			let comp = 0;
			if (mercSortField === "hits") {
				comp = b.totalHits - a.totalHits;
			} else if (mercSortField === "payout") {
				comp = b.totalPayout - a.totalPayout;
			} else {
				comp = a.attackerName.localeCompare(b.attackerName);
			}
			return mercSortAsc ? -comp : comp;
		});
	}, [data, selectedMercFaction, mercSearchQuery, mercSortField, mercSortAsc]);

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

	const handleDownloadClientCsv = () => {
		if (!data) return;

		let csv =
			"Target Name,Torn ID,Total Times Hit,Standard Hits,Stricken Hits,Total Cost ($)\n";
		for (const t of data.summary.targetBreakdown) {
			csv += `"${t.defenderName.replace(/"/g, '""')}",${t.defenderId},${t.totalHits},${t.standardHitsReceived},${t.strickenHitsReceived},${t.totalCost}\n`;
		}

		downloadCsvFile(
			csv,
			`client_receipt_${data.contract.factionId}_${data.contract.id}.csv`,
		);
		toast("Client Target Receipt CSV exported!", "success");
	};

	const generateMercCsv = (mercs: ReceiptMercPayout[]) => {
		let csv =
			"Mercenary Name,Torn ID,Faction,Total Hits,Standard Hits,Stricken Hits,Total Payout ($)\n";
		for (const m of mercs) {
			const factionStr =
				m.attackerFactionName ||
				(m.attackerFactionId
					? `Faction #${m.attackerFactionId}`
					: "Independent");
			csv += `"${m.attackerName.replace(/"/g, '""')}",${m.attackerId},"${factionStr.replace(/"/g, '""')}",${m.totalHits},${m.standardHits},${m.strickenHits},${m.totalPayout}\n`;
		}
		return csv;
	};

	const handleDownloadCurrentMercCsv = () => {
		if (!data) return;

		if (selectedMercFaction === "all") {
			const csv = generateMercCsv(data.summary.mercPayouts ?? []);
			downloadCsvFile(csv, `merc_payouts_combined_${data.contract.id}.csv`);
			toast("Combined Merc Receipt CSV exported!", "success");
		} else {
			const factionGroup = data.summary.factionPayouts?.find(
				(f) =>
					(f.factionId ? String(f.factionId) : f.factionName) ===
					selectedMercFaction,
			);
			const safeFaction = (factionGroup?.factionName ?? selectedMercFaction)
				.replace(/[^a-zA-Z0-9_-]/g, "_")
				.toLowerCase();
			const csv = generateMercCsv(factionGroup?.mercs ?? []);
			downloadCsvFile(
				csv,
				`merc_payouts_${safeFaction}_${data.contract.id}.csv`,
			);
			toast(
				`${factionGroup?.factionName ?? "Faction"} Merc Receipt CSV exported!`,
				"success",
			);
		}
	};

	const handleDownloadAllMercReceipts = () => {
		if (!data) return;

		// 1. Combined Receipt
		const combinedCsv = generateMercCsv(data.summary.mercPayouts ?? []);
		downloadCsvFile(
			combinedCsv,
			`merc_payouts_combined_${data.contract.id}.csv`,
		);

		// 2 & 3. Per-Faction Receipts
		const factions = data.summary.factionPayouts ?? [];
		for (let i = 0; i < factions.length; i++) {
			const fp = factions[i];
			if (!fp) continue;
			setTimeout(
				() => {
					const safeFaction = fp.factionName
						.replace(/[^a-zA-Z0-9_-]/g, "_")
						.toLowerCase();
					const factionCsv = generateMercCsv(fp.mercs);
					downloadCsvFile(
						factionCsv,
						`merc_payouts_${safeFaction}_${data.contract.id}.csv`,
					);
				},
				(i + 1) * 300,
			);
		}

		toast(
			`Exported all ${1 + factions.length} receipts (Combined + ${factions.length} factions)!`,
			"success",
		);
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
	const factionPayouts = summary.factionPayouts ?? [];

	// Compute selected merc metrics
	const selectedMercTotals =
		selectedMercFaction === "all"
			? {
					mercsCount: summary.mercPayouts?.length ?? 0,
					hits: summary.totalHits,
					payout: summary.totalPayout,
					standardHits:
						summary.mercPayouts?.reduce((acc, m) => acc + m.standardHits, 0) ??
						0,
					strickenHits:
						summary.mercPayouts?.reduce((acc, m) => acc + m.strickenHits, 0) ??
						0,
				}
			: (() => {
					const fp = factionPayouts.find(
						(f) =>
							(f.factionId ? String(f.factionId) : f.factionName) ===
							selectedMercFaction,
					);
					return {
						mercsCount: fp?.mercs.length ?? 0,
						hits: fp?.totalHits ?? 0,
						payout: fp?.totalPayout ?? 0,
						standardHits:
							fp?.mercs.reduce((acc, m) => acc + m.standardHits, 0) ?? 0,
						strickenHits:
							fp?.mercs.reduce((acc, m) => acc + m.strickenHits, 0) ?? 0,
					};
				})();

	return (
		<div className="min-h-screen bg-background text-foreground py-10 px-4 flex justify-center">
			<div className="max-w-4xl w-full space-y-8">
				{/* Top Branding & Status Header */}
				<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-6">
					<div>
						<div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs font-mono uppercase tracking-wider mb-2">
							Subversive Merc Service • Receipt Viewer
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

						{receiptMode === "client" ? (
							<Button
								variant="outline"
								size="sm"
								onClick={handleDownloadClientCsv}
								className="h-8 gap-1.5 text-xs font-mono"
							>
								<Download className="size-3.5" />
								CSV
							</Button>
						) : (
							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="sm"
									onClick={handleDownloadCurrentMercCsv}
									className="h-8 gap-1.5 text-xs font-mono"
								>
									<Download className="size-3.5" />
									CSV
								</Button>
								{factionPayouts.length > 1 && (
									<Button
										variant="secondary"
										size="sm"
										onClick={handleDownloadAllMercReceipts}
										className="h-8 gap-1.5 text-xs font-mono"
										title="Download All 3 Receipts (Combined + each faction)"
									>
										<Download className="size-3.5" />
										All 3 Receipts
									</Button>
								)}
							</div>
						)}
					</div>
				</div>

				{/* Primary Receipt Switcher (Client vs Merc) */}
				<div className="flex items-center justify-between gap-4 p-1.5 rounded-2xl bg-muted/30 border border-border/40">
					<div className="grid grid-cols-2 gap-1.5 w-full sm:w-auto">
						<button
							type="button"
							onClick={() => setReceiptMode("client")}
							className={`px-5 py-2 rounded-xl text-xs font-semibold font-mono uppercase tracking-wider transition-all ${
								receiptMode === "client"
									? "bg-primary text-primary-foreground shadow-sm font-bold"
									: "text-muted-foreground hover:text-foreground hover:bg-muted/50"
							}`}
						>
							Client Receipt (Targets)
						</button>
						<button
							type="button"
							onClick={() => setReceiptMode("merc")}
							className={`px-5 py-2 rounded-xl text-xs font-semibold font-mono uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
								receiptMode === "merc"
									? "bg-primary text-primary-foreground shadow-sm font-bold"
									: "text-muted-foreground hover:text-foreground hover:bg-muted/50"
							}`}
						>
							<Users className="size-3.5" />
							Merc Receipt (Payouts)
						</button>
					</div>

					{receiptMode === "merc" && factionPayouts.length > 0 && (
						<div className="hidden sm:flex items-center gap-1 text-[11px] font-mono text-muted-foreground">
							<span>3-WAY SPLIT:</span>
							<span className="font-bold text-foreground">
								Combined + {factionPayouts.length} Factions
							</span>
						</div>
					)}
				</div>

				{/* ═══════════════════════════════════════════════════════════════ */}
				{/* CLIENT RECEIPT VIEW */}
				{/* ═══════════════════════════════════════════════════════════════ */}
				{receiptMode === "client" && (
					<>
						{/* High-Level Metric Cards */}
						<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									TOTAL HITS RECORDED
								</span>
								<div className="text-2xl font-black text-foreground">
									{summary.totalHits.toLocaleString()}
								</div>
							</Card>

							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									TOTAL ACCRUED COST
								</span>
								<div className="text-2xl font-black text-emerald-400">
									${summary.totalPayout.toLocaleString()}
								</div>
							</Card>

							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									STANDARD HITS
								</span>
								<div className="text-2xl font-black text-foreground">
									{summary.targetBreakdown
										.reduce((acc, t) => acc + t.standardHitsReceived, 0)
										.toLocaleString()}
								</div>
							</Card>

							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									STRICKEN HITS
								</span>
								<div className="text-2xl font-black text-purple-400">
									{summary.targetBreakdown
										.reduce((acc, t) => acc + t.strickenHitsReceived, 0)
										.toLocaleString()}
								</div>
							</Card>
						</div>

						{/* Target Breakdown Table Card */}
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
											value={clientSearchQuery}
											onChange={(e) => setClientSearchQuery(e.target.value)}
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
															if (clientSortField === "name")
																setClientSortAsc(!clientSortAsc);
															else {
																setClientSortField("name");
																setClientSortAsc(false);
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
															if (clientSortField === "hits")
																setClientSortAsc(!clientSortAsc);
															else {
																setClientSortField("hits");
																setClientSortAsc(false);
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
															if (clientSortField === "cost")
																setClientSortAsc(!clientSortAsc);
															else {
																setClientSortField("cost");
																setClientSortAsc(false);
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
					</>
				)}

				{/* ═══════════════════════════════════════════════════════════════ */}
				{/* MERC RECEIPT VIEW (WITH 3-SPLIT: COMBINED + PER-FACTION) */}
				{/* ═══════════════════════════════════════════════════════════════ */}
				{receiptMode === "merc" && (
					<div className="space-y-6">
						{/* Faction Tabs: Combined + Per Faction */}
						<div className="flex flex-wrap items-center gap-2">
							<Button
								variant={selectedMercFaction === "all" ? "default" : "outline"}
								size="sm"
								onClick={() => setSelectedMercFaction("all")}
								className="h-8 rounded-xl font-mono text-xs gap-1.5"
							>
								<span>All Mercenaries (Combined)</span>
								<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
									{summary.mercPayouts?.length ?? 0}
								</Badge>
							</Button>

							{factionPayouts.map((fp) => {
								const key = fp.factionId
									? String(fp.factionId)
									: fp.factionName;
								const isSelected = selectedMercFaction === key;
								return (
									<Button
										key={key}
										variant={isSelected ? "default" : "outline"}
										size="sm"
										onClick={() => setSelectedMercFaction(key)}
										className="h-8 rounded-xl font-mono text-xs gap-1.5"
									>
										<span>{fp.factionName}</span>
										<Badge
											variant="secondary"
											className="px-1.5 py-0 text-[10px]"
										>
											{fp.mercs.length}
										</Badge>
									</Button>
								);
							})}
						</div>

						{/* Metric Cards for Selected Merc Receipt */}
						<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									PARTICIPATING MERCS
								</span>
								<div className="text-2xl font-black text-foreground">
									{selectedMercTotals.mercsCount}
								</div>
							</Card>

							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									TOTAL PAYOUT
								</span>
								<div className="text-2xl font-black text-emerald-400">
									${selectedMercTotals.payout.toLocaleString()}
								</div>
							</Card>

							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									STANDARD HITS
								</span>
								<div className="text-2xl font-black text-foreground">
									{selectedMercTotals.standardHits.toLocaleString()}
								</div>
							</Card>

							<Card className="border-border/80 bg-card/90 shadow-md rounded-2xl p-4 space-y-1">
								<span className="text-[11px] font-mono text-muted-foreground uppercase">
									STRICKEN HITS
								</span>
								<div className="text-2xl font-black text-purple-400">
									{selectedMercTotals.strickenHits.toLocaleString()}
								</div>
							</Card>
						</div>

						{/* Merc Payout Table Card */}
						<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
							<CardHeader className="border-b border-border/40 pb-4">
								<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
									<CardTitle className="text-base font-semibold flex items-center gap-2">
										<span>
											{selectedMercFaction === "all"
												? "All Mercenaries Payout Receipt"
												: `${
														factionPayouts.find(
															(f) =>
																(f.factionId
																	? String(f.factionId)
																	: f.factionName) === selectedMercFaction,
														)?.factionName ?? "Faction"
													} Payout Receipt`}
										</span>
										<span className="text-muted-foreground font-mono text-xs font-normal">
											({currentMercList.length} mercs)
										</span>
									</CardTitle>

									<div className="relative max-w-xs w-full">
										<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
										<Input
											placeholder="Filter mercenary name or ID..."
											value={mercSearchQuery}
											onChange={(e) => setMercSearchQuery(e.target.value)}
											className="h-8 pl-8 text-xs font-mono bg-background"
										/>
									</div>
								</div>
							</CardHeader>
							<CardContent className="pt-4 p-0">
								{currentMercList.length === 0 ? (
									<div className="p-8 text-center text-sm text-muted-foreground space-y-2">
										<p>
											No mercenary payouts recorded for this faction selection.
										</p>
										<p className="text-xs">
											When attacks are verified, mercenary payouts will appear
											here.
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
															if (mercSortField === "name")
																setMercSortAsc(!mercSortAsc);
															else {
																setMercSortField("name");
																setMercSortAsc(false);
															}
														}}
													>
														<div className="flex items-center gap-1">
															MERCENARY
															<ArrowUpDown className="size-3" />
														</div>
													</th>
													<th className="py-2.5 px-4 text-center">FACTION</th>
													<th
														className="py-2.5 px-4 text-center cursor-pointer"
														onClick={() => {
															if (mercSortField === "hits")
																setMercSortAsc(!mercSortAsc);
															else {
																setMercSortField("hits");
																setMercSortAsc(false);
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
															if (mercSortField === "payout")
																setMercSortAsc(!mercSortAsc);
															else {
																setMercSortField("payout");
																setMercSortAsc(false);
															}
														}}
													>
														<div className="flex items-center justify-end gap-1">
															TOTAL PAYOUT ($)
															<ArrowUpDown className="size-3" />
														</div>
													</th>
												</tr>
											</thead>
											<tbody className="divide-y divide-border/20 font-mono">
												{currentMercList.map((merc) => (
													<tr
														key={merc.attackerId}
														className="hover:bg-muted/10 transition-colors"
													>
														<td className="py-3 px-4 font-sans">
															<div className="font-semibold text-foreground flex items-center gap-1.5">
																<a
																	href={`https://www.torn.com/profiles.php?XID=${merc.attackerId}`}
																	target="_blank"
																	rel="noreferrer"
																	className="hover:text-primary hover:underline flex items-center gap-1"
																>
																	{merc.attackerName}
																	<ExternalLink className="size-3 text-muted-foreground" />
																</a>
															</div>
															<div className="text-[10px] text-muted-foreground font-mono">
																ID: {merc.attackerId}
															</div>
														</td>
														<td className="py-3 px-4 text-center">
															<Badge
																variant="outline"
																className="text-[10px] font-mono px-2 py-0.5"
															>
																{merc.attackerFactionName ||
																	(merc.attackerFactionId
																		? `Faction #${merc.attackerFactionId}`
																		: "Independent")}
															</Badge>
														</td>
														<td className="py-3 px-4 text-center font-bold text-foreground">
															{merc.totalHits}
														</td>
														<td className="py-3 px-4 text-center text-muted-foreground">
															{merc.standardHits}
														</td>
														<td className="py-3 px-4 text-center text-purple-400 font-semibold">
															{merc.strickenHits > 0 ? merc.strickenHits : "-"}
														</td>
														<td className="py-3 px-4 text-right font-bold text-emerald-400">
															${merc.totalPayout.toLocaleString()}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</CardContent>
						</Card>
					</div>
				)}
			</div>
		</div>
	);
}

export default ClientContractReceiptPage;
