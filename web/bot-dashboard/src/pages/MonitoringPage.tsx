import {
	AlertCircle,
	CheckCircle2,
	ExternalLink,
	Loader2,
	Plus,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import NotInitializedView from "../components/NotInitializedView";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface Channel {
	id: string;
	name: string;
	type: number;
}

interface MonitoredFaction {
	id: string;
	guildId: string;
	factionId: number;
	factionName: string | null;
	factionTag: string | null;
	revivesEnabled: boolean;
	revivesChannelId: string | null;
	revivesMessageIds?: string[];
	lastRevivesCheckAt: string | Date | null;
	createdAt: string | Date;
	updatedAt: string | Date;
}

interface MonitoringPageProps {
	guildId: string;
}

export default function MonitoringPage({ guildId }: MonitoringPageProps) {
	const { toast } = useToast();

	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);
	const [isModuleEnabled, setIsModuleEnabled] = useState(false);

	const [channels, setChannels] = useState<Channel[]>([]);
	const [monitors, setMonitors] = useState<MonitoredFaction[]>([]);

	// Add Faction Modal State
	const [isAddModalOpen, setIsAddModalOpen] = useState(false);
	const [newFactionId, setNewFactionId] = useState("");
	const [isResolvingFaction, setIsResolvingFaction] = useState(false);
	const [resolvedFaction, setResolvedFaction] = useState<{
		name: string;
		tag: string | null;
	} | null>(null);
	const [isSubmittingNew, setIsSubmittingNew] = useState(false);

	// Action State
	const [savingMonitorId, setSavingMonitorId] = useState<string | null>(null);
	const [deletingMonitorId, setDeletingMonitorId] = useState<string | null>(
		null,
	);

	const fetchInitialData = useCallback(async () => {
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const [configRes, channelsRes, monitoringRes] = await Promise.all([
				guildRoute.config.get(),
				guildRoute.channels.get(),
				guildRoute.monitoring.get(),
			]);

			if (configRes.data) {
				const data = configRes.data;
				if (!data.initialized || !data.config) {
					setIsInitialized(false);
					setLoading(false);
					return;
				}

				setIsInitialized(true);
				const cfg = data.config as typeof data.config & {
					moduleMonitoring?: boolean;
				};
				setIsModuleEnabled(cfg.moduleMonitoring ?? false);
			}

			if (channelsRes.data && "channels" in channelsRes.data) {
				const textChannels = channelsRes.data.channels.filter(
					(c: Channel) => c.type === 0,
				);
				setChannels(textChannels);
			}

			if (monitoringRes.data && "monitored" in monitoringRes.data) {
				setMonitors(monitoringRes.data.monitored as MonitoredFaction[]);
			}
		} catch {
			toast("Failed to load monitoring data.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void fetchInitialData();
	}, [fetchInitialData]);

	// Resolves faction details when adding a new faction
	const handleResolveFaction = async () => {
		const parsedId = parseInt(newFactionId.trim(), 10);
		if (!parsedId || parsedId <= 0) {
			toast("Please enter a valid numeric Faction ID.", "error");
			return;
		}

		setIsResolvingFaction(true);
		setResolvedFaction(null);

		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute
				.factions({ factionId: String(parsedId) })
				.get();
			if (res.data && "faction" in res.data && res.data.faction) {
				setResolvedFaction({
					name: res.data.faction.name,
					tag: res.data.faction.tag ?? null,
				});
				toast("Faction verified on Torn.", "success");
			} else {
				toast("Faction not found on Torn.", "error");
			}
		} catch {
			toast("Could not resolve faction details.", "error");
		} finally {
			setIsResolvingFaction(false);
		}
	};

	const handleAddFaction = async () => {
		const parsedId = parseInt(newFactionId.trim(), 10);
		if (!parsedId || parsedId <= 0) {
			toast("Invalid Faction ID.", "error");
			return;
		}

		setIsSubmittingNew(true);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.monitoring.post({
				factionId: parsedId,
				revivesEnabled: true,
				revivesChannelId: null,
			});

			if (res.error) {
				const err = res.error as { value?: { error?: string } };
				toast(err.value?.error || "Failed to add faction.", "error");
				return;
			}

			toast("Faction monitoring activated!", "success");
			setIsAddModalOpen(false);
			setNewFactionId("");
			setResolvedFaction(null);

			// Refresh list
			const refreshRes = await guildRoute.monitoring.get();
			if (refreshRes.data && "monitored" in refreshRes.data) {
				setMonitors(refreshRes.data.monitored as MonitoredFaction[]);
			}
		} catch {
			toast("Failed to register monitored faction.", "error");
		} finally {
			setIsSubmittingNew(false);
		}
	};

	const handleUpdateMonitor = async (
		monitorId: string,
		updates: { revivesEnabled?: boolean; revivesChannelId?: string | null },
	) => {
		setSavingMonitorId(monitorId);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.monitoring({ monitorId }).patch(updates);

			if (res.error) {
				const err = res.error as { value?: { error?: string } };
				toast(err.value?.error || "Failed to update settings.", "error");
				return;
			}

			setMonitors((prev) =>
				prev.map((m) => (m.id === monitorId ? { ...m, ...updates } : m)),
			);
			toast("Monitoring settings updated.", "success");
		} catch {
			toast("Failed to update monitored faction.", "error");
		} finally {
			setSavingMonitorId(null);
		}
	};

	const handleDeleteMonitor = async (monitorId: string) => {
		setDeletingMonitorId(monitorId);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			await guildRoute.monitoring({ monitorId }).delete();

			setMonitors((prev) => prev.filter((m) => m.id !== monitorId));
			toast("Faction removed from monitoring.", "info");
		} catch {
			toast("Failed to delete monitored faction.", "error");
		} finally {
			setDeletingMonitorId(null);
		}
	};

	if (loading) {
		return (
			<div className="space-y-6 max-w-5xl mx-auto p-6">
				<Skeleton className="h-12 w-64 rounded-xl" />
				<Skeleton className="h-48 w-full rounded-2xl" />
				<Skeleton className="h-64 w-full rounded-2xl" />
			</div>
		);
	}

	if (!isInitialized) {
		return <NotInitializedView guildId={guildId} />;
	}

	return (
		<div className="space-y-8 max-w-5xl mx-auto p-6 pb-24">
			{/* Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-6">
				<div className="space-y-1">
					<div className="flex items-center gap-2.5">
						<h1 className="text-2xl font-bold tracking-tight text-foreground">
							Faction Monitoring
						</h1>
					</div>
				</div>

				<Button
					onClick={() => setIsAddModalOpen(true)}
					className="shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white gap-2 shadow-lg shadow-emerald-500/20 rounded-xl"
				>
					<Plus className="size-4" />
					Add Monitored Faction
				</Button>
			</div>

			{/* Module Disabled Warning Banner */}
			{!isModuleEnabled && (
				<div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 flex items-start gap-3 text-amber-300">
					<AlertCircle className="size-5 shrink-0 mt-0.5" />
					<div className="text-sm space-y-1">
						<p className="font-semibold">
							Monitoring Module is Disabled for this Server
						</p>
						<p className="text-xs text-amber-300/80 leading-relaxed">
							Faction monitoring will not execute background checks until the
							Sentinel bot owner enables the <strong>Monitoring</strong> module
							in Server Settings.
						</p>
					</div>
				</div>
			)}

			{/* Monitored Factions List */}
			<div className="space-y-6">
				{monitors.length === 0 ? (
					<Card className="border-border/60 bg-card/40 backdrop-blur-md rounded-2xl border-dashed">
						<CardContent className="py-16 text-center space-y-4">
							<div className="space-y-1.5 max-w-md mx-auto">
								<h3 className="font-semibold text-foreground text-base">
									No Factions Currently Monitored
								</h3>
							</div>
							<Button
								variant="outline"
								onClick={() => setIsAddModalOpen(true)}
								className="gap-2 rounded-xl mt-2"
							>
								<Plus className="size-4" />
								Add Your First Faction
							</Button>
						</CardContent>
					</Card>
				) : (
					monitors.map((m) => {
						const isRevivesActive =
							m.revivesEnabled && Boolean(m.revivesChannelId);
						const isPaused = m.revivesEnabled && !m.revivesChannelId;

						return (
							<Card
								key={m.id}
								className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl overflow-hidden"
							>
								<CardHeader className="border-b border-border/40 py-4 px-6 bg-secondary/20">
									<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
										<div className="flex items-center gap-3">
											<div>
												<div className="flex items-center gap-2">
													<span className="font-bold text-base text-foreground">
														{m.factionName || `Faction ${m.factionId}`}
													</span>
													{m.factionTag && (
														<Badge
															variant="outline"
															className="font-mono text-[10px] bg-secondary/60"
														>
															[{m.factionTag}]
														</Badge>
													)}
													<a
														href={`https://www.torn.com/factions.php?step=profile&ID=${m.factionId}`}
														target="_blank"
														rel="noreferrer"
														className="text-muted-foreground hover:text-foreground transition-colors"
														title="View on Torn"
													>
														<ExternalLink className="size-3.5" />
													</a>
												</div>
												<p className="text-xs text-muted-foreground font-mono">
													Faction ID: {m.factionId}
												</p>
											</div>
										</div>

										<div className="flex items-center gap-2 self-end sm:self-center">
											<Button
												variant="ghost"
												size="sm"
												disabled={deletingMonitorId === m.id}
												onClick={() => handleDeleteMonitor(m.id)}
												className="text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-xl size-8 p-0"
												title="Stop Monitoring"
											>
												{deletingMonitorId === m.id ? (
													<Loader2 className="size-4 animate-spin" />
												) : (
													<Trash2 className="size-4" />
												)}
											</Button>
										</div>
									</div>
								</CardHeader>

								<CardContent className="p-6 space-y-6">
									{/* Sub-Category: Revives */}
									<div className="p-4 rounded-xl border border-border/60 bg-background/50 space-y-4">
										<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/30 pb-3">
											<div className="space-y-0.5">
												<div className="flex items-center gap-2">
													<span className="font-semibold text-sm text-foreground">
														Revives Monitoring
													</span>
													<Badge
														variant={
															isRevivesActive
																? "secondary"
																: isPaused
																	? "outline"
																	: "outline"
														}
														className={`text-[10px] font-mono ${
															isRevivesActive
																? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
																: isPaused
																	? "text-amber-400 bg-amber-500/10 border-amber-500/30"
																	: "text-muted-foreground"
														}`}
													>
														{isRevivesActive
															? "Active"
															: isPaused
																? "Paused (No Channel)"
																: "Disabled"}
													</Badge>
												</div>
											</div>

											<div className="flex items-center gap-2">
												<Switch
													id={`revives-toggle-${m.id}`}
													checked={m.revivesEnabled}
													disabled={savingMonitorId === m.id}
													onCheckedChange={(checked) =>
														handleUpdateMonitor(m.id, {
															revivesEnabled: checked,
														})
													}
												/>
											</div>
										</div>

										{/* Channel Selector */}
										<div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
											<div className="space-y-1.5">
												<label
													htmlFor={`channel-select-${m.id}`}
													className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
												>
													Dedicated Discord Output Channel
												</label>
												<Select
													value={m.revivesChannelId || "none"}
													onValueChange={(val) =>
														handleUpdateMonitor(m.id, {
															revivesChannelId: val === "none" ? null : val,
														})
													}
													disabled={savingMonitorId === m.id}
												>
													<SelectTrigger
														id={`channel-select-${m.id}`}
														className="rounded-xl border-border/70 bg-card/60 text-sm"
													>
														<SelectValue placeholder="Select output channel..." />
													</SelectTrigger>
													<SelectContent className="max-h-64">
														<SelectGroup>
															<SelectItem value="none">
																-- None (Paused) --
															</SelectItem>
															{channels.map((ch) => (
																<SelectItem key={ch.id} value={ch.id}>
																	#{ch.name}
																</SelectItem>
															))}
														</SelectGroup>
													</SelectContent>
												</Select>
											</div>

											<div className="text-xs text-muted-foreground space-y-1 self-end">
												{isPaused ? (
													<p className="text-amber-400/90 flex items-center gap-1.5 font-medium">
														<AlertCircle className="size-3.5 shrink-0" />
														Category will not be monitored until an output
														channel is chosen.
													</p>
												) : isRevivesActive ? (
													<p className="text-emerald-400/90 flex items-center gap-1.5 font-medium">
														<CheckCircle2 className="size-3.5 shrink-0" />
														Scheduler checks every 1 min and updates the single
														continuous embed.
													</p>
												) : null}
												{m.lastRevivesCheckAt && (
													<p className="text-muted-foreground/70 font-mono text-[11px]">
														Last synchronized:{" "}
														{new Date(
															m.lastRevivesCheckAt,
														).toLocaleTimeString()}
													</p>
												)}
											</div>
										</div>
									</div>
								</CardContent>
							</Card>
						);
					})
				)}
			</div>

			{/* Add Monitored Faction Modal */}
			<Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
				<DialogContent className="sm:max-w-md rounded-2xl border-border/80 bg-card/95 backdrop-blur-xl">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-lg font-bold">
							Add Faction
						</DialogTitle>
					</DialogHeader>

					<div className="space-y-4 py-2">
						<div className="space-y-2">
							<label
								htmlFor="new-faction-id"
								className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
							>
								Torn Faction ID
							</label>
							<div className="flex gap-2">
								<Input
									id="new-faction-id"
									placeholder="e.g. 7709"
									value={newFactionId}
									onChange={(e) => {
										setNewFactionId(e.target.value);
										setResolvedFaction(null);
									}}
									className="rounded-xl border-border/70 bg-background/60 font-mono text-sm"
								/>
								<Button
									type="button"
									variant="outline"
									onClick={handleResolveFaction}
									disabled={isResolvingFaction || !newFactionId.trim()}
									className="rounded-xl shrink-0 gap-1.5"
								>
									{isResolvingFaction ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<RefreshCw className="size-3.5" />
									)}
									Verify
								</Button>
							</div>

							{resolvedFaction && (
								<div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center justify-between">
									<div className="flex items-center gap-1.5">
										<CheckCircle2 className="size-4 shrink-0" />
										<span className="font-semibold">
											{resolvedFaction.name}
										</span>
										{resolvedFaction.tag && (
											<span className="font-mono">[{resolvedFaction.tag}]</span>
										)}
									</div>
								</div>
							)}
						</div>
					</div>

					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							variant="ghost"
							onClick={() => setIsAddModalOpen(false)}
							className="rounded-xl text-xs"
						>
							Cancel
						</Button>
						<Button
							onClick={handleAddFaction}
							disabled={isSubmittingNew || !newFactionId.trim()}
							className="rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs gap-1.5"
						>
							{isSubmittingNew && <Loader2 className="size-3.5 animate-spin" />}
							Start Monitoring
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
