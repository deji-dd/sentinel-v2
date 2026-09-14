import {
	ExternalLink,
	History,
	MessageSquare,
	RefreshCw,
	RotateCcw,
	Search,
	Settings,
	UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useRouter } from "../router";

interface Candidate {
	id: string;
	playerId: number;
	playerName: string;
	playerLevel: number;
	factionId: number;
	factionName: string;
	warId: number;
	attacks: number;
	factionTotalAttacks: number;
	attackPercentage: number;
	score: number;
	estimatedStats: {
		bsEstimate: number | null;
		fairFight: number | null;
		source?: string | null;
		humanEstimate?: string | null;
	} | null;
	status: "new" | "contacted" | "rejected" | "recruited";
	notified: boolean;
	notifiedAt: string | null;
	notes: string | null;
	createdAt: string;
}

interface RecruitmentMetrics {
	total: number;
	new: number;
	contacted: number;
	rejected: number;
	recruited: number;
	totalWarsEvaluated: number;
}

interface RecruitmentConfig {
	minStats: number;
	minAttacks: number | "";
	minAttackPercentage: number | "";
	notificationChannelId: string | null;
	notificationsEnabled: boolean;
	termedClusterPercentage: number | "";
	autoScanEnabled: boolean;
	excludedFactionIds: number[];
}

interface EvaluatedWar {
	id: number;
	start: string | null;
	end: string | null;
	target: number;
	winnerFactionId: number | null;
	forfeit: boolean;
	isTermed: boolean;
	termedReason: string | null;
	status: string;
	candidateCount: number;
	evaluatedAt: string;
}

interface GuildChannel {
	id: string;
	name: string;
}

function formatNumberHuman(num: number | null | undefined): string {
	if (num === null || num === undefined || num === 0) return "N/A";
	if (num >= 1_000_000_000) {
		return `${(num / 1_000_000_000).toFixed(2)}B`;
	}
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(2)}M`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`;
	}
	return num.toLocaleString();
}

export function RecruitmentPage() {
	const { navigate } = useRouter();
	const [candidates, setCandidates] = useState<Candidate[]>([]);
	const [metrics, setMetrics] = useState<RecruitmentMetrics>({
		total: 0,
		new: 0,
		contacted: 0,
		rejected: 0,
		recruited: 0,
		totalWarsEvaluated: 0,
	});
	const [loading, setLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [page, setPage] = useState(1);
	const [totalPages, setTotalPages] = useState(1);
	const [hasApiKeys, setHasApiKeys] = useState<boolean | null>(null);

	// Settings modal state
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [savingSettings, setSavingSettings] = useState(false);
	const [config, setConfig] = useState<RecruitmentConfig>({
		minStats: 1_000_000_000,
		minAttacks: 25,
		minAttackPercentage: 8.0,
		notificationChannelId: null,
		notificationsEnabled: false,
		termedClusterPercentage: 60,
		autoScanEnabled: false,
		excludedFactionIds: [],
	});
	const [channels, setChannels] = useState<GuildChannel[]>([]);
	const [configLoading, setConfigLoading] = useState(true);
	const [statsInput, setStatsInput] = useState<string>(() =>
		config.minStats > 0 ? config.minStats.toLocaleString("en-US") : "",
	);

	// Evaluated wars modal state
	const [warsOpen, setWarsOpen] = useState(false);
	const [warsLoading, setWarsLoading] = useState(false);
	const [evaluatedWars, setEvaluatedWars] = useState<EvaluatedWar[]>([]);

	// Trigger scan state
	const [scanning, setScanning] = useState(false);
	const [resettingCycle, setResettingCycle] = useState(false);
	const [confirmingReset, setConfirmingReset] = useState(false);

	// Notes edit dialog state
	const [noteDialogCandidate, setNoteDialogCandidate] =
		useState<Candidate | null>(null);
	const [noteText, setNoteText] = useState("");
	const [savingNote, setSavingNote] = useState(false);

	const fetchCandidates = useCallback(async () => {
		setLoading(true);
		try {
			const params = new URLSearchParams({
				page: String(page),
				limit: "25",
			});
			if (searchQuery.trim()) {
				params.append("search", searchQuery.trim());
			}

			const res = await fetch(
				`/api/v1/subversive/recruitment/candidates?${params.toString()}`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				candidates: Candidate[];
				pagination: { totalPages: number };
				metrics: RecruitmentMetrics;
			};

			setCandidates(data.candidates ?? []);
			setTotalPages(data.pagination?.totalPages ?? 1);
			if (data.metrics) setMetrics(data.metrics);
		} catch (err) {
			console.error("Failed to load candidates:", err);
			toast.error("Failed to load recruitment candidates");
		} finally {
			setLoading(false);
		}
	}, [page, searchQuery]);

	// Fetch recruitment settings & guild channels & API key availability
	const fetchSettingsAndChannels = useCallback(async () => {
		try {
			const [cfgRes, chRes, keysRes] = await Promise.all([
				fetch("/api/v1/subversive/recruitment/config"),
				fetch("/api/v1/subversive/guild-channels"),
				fetch("/api/v1/subversive/api-keys"),
			]);

			if (cfgRes.ok) {
				const cfgData = (await cfgRes.json()) as { config: RecruitmentConfig };
				if (cfgData.config) {
					setConfig(cfgData.config);
					setStatsInput(
						cfgData.config.minStats > 0
							? cfgData.config.minStats.toLocaleString("en-US")
							: "",
					);
				}
			}
			if (chRes.ok) {
				const chData = (await chRes.json()) as { channels: GuildChannel[] };
				setChannels(chData.channels ?? []);
			}
			if (keysRes.ok) {
				const keysData = (await keysRes.json()) as { keys?: unknown[] };
				setHasApiKeys((keysData.keys?.length ?? 0) > 0);
			}
		} catch (err) {
			console.error("Failed to fetch settings/channels:", err);
		} finally {
			setConfigLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchCandidates();
		fetchSettingsAndChannels();
	}, [fetchCandidates, fetchSettingsAndChannels]);

	const openSettings = () => {
		setConfirmingReset(false);
		fetchSettingsAndChannels();
		setStatsInput(
			config.minStats > 0 ? config.minStats.toLocaleString("en-US") : "",
		);
		setSettingsOpen(true);
	};

	const saveSettings = async () => {
		setSavingSettings(true);
		try {
			const payload = {
				...config,
				minAttacks: Number(config.minAttacks) || 25,
				minAttackPercentage: Number(config.minAttackPercentage) || 8.0,
				termedClusterPercentage: Number(config.termedClusterPercentage) || 60,
			};

			const res = await fetch("/api/v1/subversive/recruitment/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			toast.success("Recruitment configuration saved successfully");
			setSettingsOpen(false);
		} catch (err) {
			console.error("Failed to save config:", err);
			toast.error("Failed to save recruitment configuration");
		} finally {
			setSavingSettings(false);
		}
	};

	// Trigger immediate manual scan
	const triggerScan = async () => {
		if (hasApiKeys === false) {
			toast.error(
				"No Torn API keys configured. Please add an API key in Guild Configuration before scanning.",
			);
			return;
		}

		setScanning(true);
		try {
			const res = await fetch("/api/v1/subversive/recruitment/scan-now", {
				method: "POST",
			});
			const data = (await res.json()) as { message?: string; error?: string };
			if (!res.ok) {
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			toast.success(data.message || "Recruitment scan triggered");
			setTimeout(() => {
				fetchCandidates();
			}, 3000);
		} catch (err) {
			console.error("Failed to trigger scan:", err);
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to trigger recruitment scan",
			);
		} finally {
			setScanning(false);
		}
	};

	// Dev-only: Reset recruitment cycle for today
	const executeResetTodayCycle = async () => {
		setResettingCycle(true);
		try {
			const res = await fetch("/api/v1/subversive/recruitment/reset-today", {
				method: "POST",
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { message: string };
			toast.success(data.message || "Recruitment cycle reset for today");
			setConfirmingReset(false);
			fetchCandidates();
			if (warsOpen) {
				openWarsModal();
			}
		} catch (err) {
			console.error("Failed to reset cycle:", err);
			toast.error("Failed to reset recruitment cycle for today");
		} finally {
			setResettingCycle(false);
		}
	};

	// Load evaluated wars history
	const openWarsModal = async () => {
		setWarsOpen(true);
		setWarsLoading(true);
		try {
			const res = await fetch("/api/v1/subversive/recruitment/wars?limit=50");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { wars: EvaluatedWar[] };
			setEvaluatedWars(data.wars ?? []);
		} catch (err) {
			console.error("Failed to load evaluated wars:", err);
			toast.error("Failed to load evaluated ranked wars history");
		} finally {
			setWarsLoading(false);
		}
	};

	// Save candidate notes
	const saveNotes = async () => {
		if (!noteDialogCandidate) return;
		setSavingNote(true);
		try {
			const res = await fetch(
				`/api/v1/subversive/recruitment/candidates/${noteDialogCandidate.id}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ notes: noteText }),
				},
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			toast.success("Notes saved");
			setCandidates((prev) =>
				prev.map((c) =>
					c.id === noteDialogCandidate.id ? { ...c, notes: noteText } : c,
				),
			);
			setNoteDialogCandidate(null);
		} catch (err) {
			console.error("Failed to save note:", err);
			toast.error("Failed to save candidate notes");
		} finally {
			setSavingNote(false);
		}
	};

	return (
		<div className="flex flex-col gap-6 max-w-7xl mx-auto pb-12">
			{/* Page Header */}
			<div className="flex flex-col md:flex-row md:items-center justify-end gap-4">
				<div className="flex items-center gap-2 flex-wrap">
					<Button
						variant="outline"
						size="sm"
						onClick={openWarsModal}
						className="gap-1.5"
					>
						<History className="size-4 text-muted-foreground" />
						Evaluated Wars ({metrics.totalWarsEvaluated})
					</Button>

					<Button
						variant="outline"
						size="sm"
						onClick={openSettings}
						className="gap-1.5"
					>
						<Settings className="size-4 text-muted-foreground" />
						Filter Rules
					</Button>

					<Button
						size="sm"
						onClick={triggerScan}
						disabled={scanning}
						className="gap-1.5"
					>
						<RefreshCw className={`size-4 ${scanning ? "animate-spin" : ""}`} />
						{scanning ? "Scanning..." : "Scan Now"}
					</Button>
				</div>
			</div>

			{/* Missing API Keys Warning Banner */}
			{hasApiKeys === false && (
				<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive dark:text-destructive-foreground">
					<div className="flex items-center gap-2.5 text-xs">
						<span className="font-semibold">Torn API Key Required:</span>
						<span>
							Recruitment scans require at least one Torn API key registered for
							Subversive. System keys cannot be used for guild scans.
						</span>
					</div>
					<Button
						variant="destructive"
						size="sm"
						onClick={() => navigate("/guild-config")}
						className="h-7 text-xs shrink-0 cursor-pointer"
					>
						Configure API Keys
					</Button>
				</div>
			)}

			{/* Poller Paused Warning Banner */}
			{!configLoading && !config.autoScanEnabled && hasApiKeys !== false && (
				<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200">
					<div className="flex items-center gap-2.5 text-xs">
						<span className="font-semibold">Automated Scanning Paused:</span>
						<span>
							Configure your filter rules and Discord alerts, then enable the
							automated poller to begin monitoring today's ranked wars.
						</span>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={openSettings}
						className="h-7 text-xs border-amber-500/40 hover:bg-amber-500/20 shrink-0"
					>
						Configure Rules
					</Button>
				</div>
			)}

			{/* Search Toolbar */}
			<div className="flex items-center justify-end">
				<div className="relative w-full sm:w-80">
					<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
					<Input
						placeholder="Search player or faction..."
						value={searchQuery}
						onChange={(e) => {
							setSearchQuery(e.target.value);
							setPage(1);
						}}
						className="pl-8"
					/>
				</div>
			</div>

			{/* Candidates Table */}
			<Card>
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Player</TableHead>
								<TableHead>Estimated Stats</TableHead>
								<TableHead>Faction</TableHead>
								<TableHead className="text-right">War Output</TableHead>
								<TableHead className="text-center">Share</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{loading ? (
								<TableRow>
									<TableCell colSpan={7} className="text-center py-12">
										<RefreshCw className="size-6 animate-spin mx-auto text-muted-foreground mb-2" />
										<p className="text-sm text-muted-foreground">
											Loading recruitment leads...
										</p>
									</TableCell>
								</TableRow>
							) : candidates.length === 0 ? (
								<TableRow>
									<TableCell colSpan={7} className="text-center py-16">
										<UserPlus className="size-8 mx-auto text-muted-foreground mb-2 opacity-50" />
										<p className="font-semibold text-base">
											No candidates found
										</p>
										<p className="text-sm text-muted-foreground max-w-sm mx-auto mt-1">
											Try adjusting your filter rules, running a new scan, or
											clearing your search terms.
										</p>
									</TableCell>
								</TableRow>
							) : (
								candidates.map((c) => (
									<TableRow key={c.id}>
										{/* Player Name & Level */}
										<TableCell>
											<div className="flex flex-col">
												<div className="flex items-center gap-1.5 font-medium">
													<a
														href={`https://www.torn.com/profiles.php?XID=${c.playerId}`}
														target="_blank"
														rel="noreferrer"
														className="hover:underline flex items-center gap-1 text-primary"
													>
														{c.playerName}
														<ExternalLink className="size-3 opacity-60" />
													</a>
													<span className="text-xs text-muted-foreground font-mono">
														[{c.playerId}]
													</span>
												</div>
												<span className="text-xs text-muted-foreground">
													Level {c.playerLevel}
												</span>
											</div>
										</TableCell>

										{/* Estimated Battle Stats */}
										<TableCell>
											<div className="flex flex-col">
												<div className="flex items-center gap-1.5 font-mono text-sm">
													{formatNumberHuman(c.estimatedStats?.bsEstimate)}
												</div>
											</div>
										</TableCell>

										{/* Faction */}
										<TableCell>
											<div className="flex flex-col">
												<a
													href={`https://www.torn.com/factions.php?step=profile&ID=${c.factionId}`}
													target="_blank"
													rel="noreferrer"
													className="hover:underline text-sm font-medium text-foreground flex items-center gap-1"
												>
													{c.factionName}
													<ExternalLink className="size-2.5 opacity-60" />
												</a>
											</div>
										</TableCell>

										{/* Attacks & War Score */}
										<TableCell className="text-right">
											<div className="flex flex-col items-end">
												<span className="font-semibold font-mono text-sm">
													{c.attacks.toLocaleString()} hits
												</span>
												<span className="text-xs text-muted-foreground">
													Score: {c.score.toLocaleString()}
												</span>
											</div>
										</TableCell>

										{/* Percentage of Faction Hits */}
										<TableCell className="text-center">
											<Badge
												variant="secondary"
												className="font-mono text-xs bg-primary/10 text-primary border-primary/20"
											>
												{c.attackPercentage.toFixed(1)}%
											</Badge>
										</TableCell>

										{/* Action Dropdown & Notes */}
										<TableCell className="text-right">
											<div className="flex items-center justify-end gap-1.5">
												<Button
													variant="ghost"
													size="icon"
													className="size-8"
													title={c.notes || "Add notes"}
													onClick={() => {
														setNoteDialogCandidate(c);
														setNoteText(c.notes || "");
													}}
												>
													<MessageSquare
														className={`size-4 ${
															c.notes ? "text-primary" : "text-muted-foreground"
														}`}
													/>
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>
			</Card>

			{/* Pagination Controls */}
			{totalPages > 1 && (
				<div className="flex items-center justify-between px-2 text-sm text-muted-foreground">
					<span>
						Page {page} of {totalPages}
					</span>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={page <= 1}
							onClick={() => setPage((p) => Math.max(1, p - 1))}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={page >= totalPages}
							onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
						>
							Next
						</Button>
					</div>
				</div>
			)}

			{/* Settings Dialog */}
			<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Recruitment Filter Rules</DialogTitle>
					</DialogHeader>

					<div className="flex flex-col gap-4 py-2 text-sm">
						{/* Min Estimated Stats */}
						<div className="flex flex-col gap-1.5">
							<label htmlFor="min-stats" className="font-medium text-xs">
								Minimum Estimated Battle Stats
							</label>
							<Input
								id="min-stats"
								type="text"
								inputMode="numeric"
								value={statsInput}
								onChange={(e) => {
									const raw = e.target.value.replace(/[^0-9]/g, "");
									if (!raw) {
										setStatsInput("");
										setConfig((prev) => ({ ...prev, minStats: 0 }));
										return;
									}
									const num = Number(raw);
									setStatsInput(num.toLocaleString("en-US"));
									setConfig((prev) => ({ ...prev, minStats: num }));
								}}
								placeholder="e.g. 1,000,000,000"
							/>
							<div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
								<span>
									Current:{" "}
									<strong className="text-foreground">
										{config.minStats === 0
											? "Any (No stat floor)"
											: formatNumberHuman(config.minStats)}
									</strong>
								</span>
							</div>
							<div className="flex items-center gap-1.5 flex-wrap pt-0.5">
								{[
									0, 1_000_000_000, 2_000_000_000, 3_000_000_000, 5_000_000_000,
									10_000_000_000,
								].map((val) => (
									<Button
										key={val}
										type="button"
										variant={config.minStats === val ? "default" : "outline"}
										size="sm"
										className="h-6 text-[11px] px-2 py-0 cursor-pointer"
										onClick={() => {
											setStatsInput(val > 0 ? val.toLocaleString("en-US") : "");
											setConfig((prev) => ({ ...prev, minStats: val }));
										}}
									>
										{val === 0 ? "Any" : formatNumberHuman(val)}
									</Button>
								))}
							</div>
						</div>

						{/* Min Attacks & Attack % */}
						<div className="grid grid-cols-2 gap-3">
							<div className="flex flex-col gap-1.5">
								<label htmlFor="min-attacks" className="font-medium text-xs">
									Min Attacks (Hits)
								</label>
								<Input
									id="min-attacks"
									type="number"
									value={config.minAttacks}
									onChange={(e) => {
										const val = e.target.value;
										setConfig((prev) => ({
											...prev,
											minAttacks: val === "" ? "" : Number(val),
										}));
									}}
									placeholder="25"
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<label htmlFor="min-share" className="font-medium text-xs">
									Min Faction Share %
								</label>
								<Input
									id="min-share"
									type="number"
									step="0.5"
									value={config.minAttackPercentage}
									onChange={(e) => {
										const val = e.target.value;
										setConfig((prev) => ({
											...prev,
											minAttackPercentage: val === "" ? "" : Number(val),
										}));
									}}
									placeholder="8.0"
								/>
							</div>
						</div>

						{/* Termed War Sensitivity */}
						<div className="flex flex-col gap-1.5">
							<label htmlFor="cluster-thresh" className="font-medium text-xs">
								Termed War Cluster Sensitivity (% of Hitters)
							</label>
							<Input
								id="cluster-thresh"
								type="number"
								min="20"
								max="100"
								value={config.termedClusterPercentage}
								onChange={(e) => {
									const val = e.target.value;
									setConfig((prev) => ({
										...prev,
										termedClusterPercentage: val === "" ? "" : Number(val),
									}));
								}}
								placeholder="60"
							/>
							<span className="text-[11px] text-muted-foreground">
								If ≥ {config.termedClusterPercentage || 60}% of active members
								hit the same attack quota, the war is rejected as termed.
							</span>
						</div>

						<div className="border-t pt-3 flex flex-col gap-3">
							{/* Background Polling Switch */}
							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="font-medium text-xs">Automated Poller</span>
									<span className="text-[11px] text-muted-foreground">
										Scan completed wars in the background
									</span>
								</div>
								<Switch
									checked={config.autoScanEnabled}
									onCheckedChange={(checked) =>
										setConfig((prev) => ({ ...prev, autoScanEnabled: checked }))
									}
								/>
							</div>

							{/* Discord Notifications Switch */}
							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="font-medium text-xs">
										Discord Channel Alerts
									</span>
									<span className="text-[11px] text-muted-foreground">
										Post embeds to Discord channel
									</span>
								</div>
								<Switch
									checked={config.notificationsEnabled}
									onCheckedChange={(checked) =>
										setConfig((prev) => ({
											...prev,
											notificationsEnabled: checked,
										}))
									}
								/>
							</div>

							{/* Target Notification Channel */}
							{config.notificationsEnabled && (
								<div className="flex flex-col gap-1.5 pt-1">
									<label
										htmlFor="select-channel"
										className="font-medium text-xs"
									>
										Notification Channel
									</label>
									<Select
										value={config.notificationChannelId || ""}
										onValueChange={(val) =>
											setConfig((prev) => ({
												...prev,
												notificationChannelId: val || null,
											}))
										}
									>
										<SelectTrigger id="select-channel" className="w-full">
											<SelectValue placeholder="Select Discord text channel..." />
										</SelectTrigger>
										<SelectContent>
											{channels.map((ch) => (
												<SelectItem key={ch.id} value={ch.id}>
													#{ch.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
						</div>

						{/* Dev-only: Reset Recruitment Cycle for Today */}
						{import.meta.env.DEV && (
							<div className="border border-dashed border-red-500/30 bg-red-500/5 dark:bg-red-500/10 p-3 rounded-lg flex flex-col gap-2">
								<div className="flex items-start sm:items-center justify-between gap-3">
									<div className="flex flex-col">
										<span className="font-semibold text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
											<RotateCcw className="size-3.5" />
											Dev Controls
										</span>
										<span className="text-[11px] text-muted-foreground">
											{confirmingReset
												? "Are you sure? This will wipe today's candidates & war cache from 00:00 TCT."
												: "Reset today's cycle (wipes candidates, today's evaluated wars, & in-memory cache)."}
										</span>
									</div>
									{confirmingReset ? (
										<div className="flex items-center gap-1.5 shrink-0">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="h-7 text-xs"
												onClick={() => setConfirmingReset(false)}
												disabled={resettingCycle}
											>
												Cancel
											</Button>
											<Button
												type="button"
												variant="destructive"
												size="sm"
												className="h-7 text-xs font-semibold cursor-pointer"
												onClick={executeResetTodayCycle}
												disabled={resettingCycle}
											>
												{resettingCycle ? (
													<>
														<RefreshCw className="size-3 animate-spin mr-1.5" />
														Resetting...
													</>
												) : (
													"Confirm Reset"
												)}
											</Button>
										</div>
									) : (
										<Button
											type="button"
											variant="destructive"
											size="sm"
											className="h-8 text-xs shrink-0 cursor-pointer"
											onClick={() => setConfirmingReset(true)}
											disabled={resettingCycle}
										>
											Reset Cycle for Today
										</Button>
									)}
								</div>
							</div>
						)}
					</div>

					<DialogFooter>
						<Button variant="outline" onClick={() => setSettingsOpen(false)}>
							Cancel
						</Button>
						<Button onClick={saveSettings} disabled={savingSettings}>
							{savingSettings ? "Saving..." : "Save Settings"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Evaluated Wars History Dialog */}
			<Dialog open={warsOpen} onOpenChange={setWarsOpen}>
				<DialogContent className="sm:max-w-3xl md:max-w-4xl lg:max-w-5xl w-full max-h-[85vh] flex flex-col">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							Evaluated Ranked Wars History
						</DialogTitle>
					</DialogHeader>

					<div className="overflow-y-auto flex-1 border rounded-md">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>War ID</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Outcome / Details</TableHead>
									<TableHead className="text-right">Candidates</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{warsLoading ? (
									<TableRow>
										<TableCell colSpan={4} className="text-center py-8">
											<RefreshCw className="size-5 animate-spin mx-auto text-muted-foreground mb-1" />
											<span className="text-xs text-muted-foreground">
												Loading wars...
											</span>
										</TableCell>
									</TableRow>
								) : evaluatedWars.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={4}
											className="text-center py-8 text-sm text-muted-foreground"
										>
											No ranked wars evaluated yet. Trigger a scan to start.
										</TableCell>
									</TableRow>
								) : (
									evaluatedWars.map((w) => (
										<TableRow key={w.id}>
											<TableCell className="font-mono text-xs font-semibold">
												<a
													href={`https://www.torn.com/war.php?step=rankreport&rankID=${w.id}`}
													target="_blank"
													rel="noreferrer"
													className="hover:underline flex items-center gap-1 text-primary"
												>
													#{w.id}
													<ExternalLink className="size-3 opacity-60" />
												</a>
											</TableCell>
											<TableCell>
												{w.status === "processed" && (
													<Badge
														variant="outline"
														className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
													>
														Competitive
													</Badge>
												)}
												{w.status === "dropped_termed" && (
													<Badge
														variant="outline"
														className="bg-amber-500/10 text-amber-600 border-amber-500/20"
													>
														Termed War
													</Badge>
												)}
												{w.status === "dropped_forfeit" && (
													<Badge
														variant="outline"
														className="bg-red-500/10 text-red-600 border-red-500/20"
													>
														Forfeited
													</Badge>
												)}
												{w.status === "error" && (
													<Badge variant="destructive">Error</Badge>
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{w.termedReason ? (
													<span className="text-amber-600 dark:text-amber-400 font-medium">
														{w.termedReason}
													</span>
												) : w.winnerFactionId ? (
													`Winner Faction: ${w.winnerFactionId}`
												) : (
													"Completed"
												)}
											</TableCell>
											<TableCell className="text-right font-mono text-xs font-semibold">
												{w.candidateCount > 0 ? (
													<span className="text-emerald-600 dark:text-emerald-400">
														+{w.candidateCount} leads
													</span>
												) : (
													<span className="text-muted-foreground">0</span>
												)}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>

					<DialogFooter>
						<Button variant="outline" onClick={() => setWarsOpen(false)}>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Notes Dialog */}
			<Dialog
				open={Boolean(noteDialogCandidate)}
				onOpenChange={(open) => {
					if (!open) setNoteDialogCandidate(null);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Candidate Notes</DialogTitle>
						<DialogDescription>
							Notes for {noteDialogCandidate?.playerName} [
							{noteDialogCandidate?.playerId}].
						</DialogDescription>
					</DialogHeader>

					<div className="py-2">
						<textarea
							value={noteText}
							onChange={(e) => setNoteText(e.target.value)}
							placeholder="e.g. Contacted on Discord, willing to join after current war..."
							className="w-full h-28 p-3 rounded-md border text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary"
						/>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setNoteDialogCandidate(null)}
						>
							Cancel
						</Button>
						<Button onClick={saveNotes} disabled={savingNote}>
							{savingNote ? "Saving..." : "Save Notes"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
