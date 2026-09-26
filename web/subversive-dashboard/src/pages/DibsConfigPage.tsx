import { Clock, RefreshCw, Save, Target, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

interface SubversiveDibsConfig {
	enabled: boolean;
	channelId: string | null;
	claimLeadTime: number;
	maxDibsPerPerson: number;
	postHospTimeoutSeconds: number;
	autoDeleteOnDowned: boolean;
}

interface GuildChannel {
	id: string;
	name: string;
}

interface DibsRecord {
	targetId: number;
	targetName: string;
	targetLevel: number;
	estimatedBs: number;
	fairFight: number;
	hospitalUntil: number;
	status: "open" | "claimed";
	claimedBy?: {
		tornId?: number;
		tornName?: string;
		discordId?: string;
		discordTag?: string;
		platform: "script" | "discord";
	};
	claimedAt?: number;
	createdAt: number;
}

function formatStats(num: number | null | undefined): string {
	if (!num || !Number.isFinite(num)) return "Unknown";
	if (num >= 1e15) return `${(num / 1e15).toFixed(2)}Q`;
	if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
	if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
	if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
	if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
	return Math.round(num).toLocaleString();
}

function formatRemainingSeconds(untilSec: number): string {
	const nowSec = Math.floor(Date.now() / 1000);
	const remaining = Math.max(0, untilSec - nowSec);
	if (remaining === 0) return "Ready";
	const m = Math.floor(remaining / 60);
	const s = remaining % 60;
	return `${m}m ${s < 10 ? `0${s}` : s}s`;
}

export function DibsConfigPage() {
	const [config, setConfig] = useState<SubversiveDibsConfig>({
		enabled: true,
		channelId: null,
		claimLeadTime: 5,
		maxDibsPerPerson: 1,
		postHospTimeoutSeconds: 20,
		autoDeleteOnDowned: true,
	});
	const [channels, setChannels] = useState<GuildChannel[]>([]);
	const [activeDibs, setActiveDibs] = useState<DibsRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [refreshingClaims, setRefreshingClaims] = useState(false);

	const fetchData = useCallback(async () => {
		try {
			const [cfgRes, chRes, dibsRes] = await Promise.all([
				fetch("/api/v1/subversive/dibs-config"),
				fetch("/api/v1/subversive/guild-channels"),
				fetch("/api/v1/subversive/dibs/active"),
			]);

			if (cfgRes.ok) {
				const cfgData = (await cfgRes.json()) as {
					config: SubversiveDibsConfig;
				};
				if (cfgData.config) {
					setConfig(cfgData.config);
				}
			}

			if (chRes.ok) {
				const chData = (await chRes.json()) as { channels: GuildChannel[] };
				setChannels(chData.channels ?? []);
			}

			if (dibsRes.ok) {
				const dibsData = (await dibsRes.json()) as { dibs: DibsRecord[] };
				setActiveDibs(dibsData.dibs ?? []);
			}
		} catch (err) {
			console.error("Failed loading dibs data:", err);
			toast.error("Failed to load dibs configuration.");
		} finally {
			setLoading(false);
		}
	}, []);

	const refreshActiveClaims = async () => {
		setRefreshingClaims(true);
		try {
			const dibsRes = await fetch("/api/v1/subversive/dibs/active");
			if (dibsRes.ok) {
				const dibsData = (await dibsRes.json()) as { dibs: DibsRecord[] };
				setActiveDibs(dibsData.dibs ?? []);
			}
		} catch (err) {
			console.error("Failed refreshing active dibs:", err);
		} finally {
			setRefreshingClaims(false);
		}
	};

	useEffect(() => {
		void fetchData();
		const interval = setInterval(() => {
			void refreshActiveClaims();
		}, 3000);
		return () => clearInterval(interval);
	}, [fetchData]);

	const handleSave = async () => {
		setSaving(true);
		try {
			const res = await fetch("/api/v1/subversive/dibs-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!res.ok) {
				const err = (await res.json()) as { error?: string };
				throw new Error(err.error || "Failed to update configuration");
			}

			const data = (await res.json()) as { config: SubversiveDibsConfig };
			setConfig(data.config);
			toast.success("War Dibs settings updated successfully.");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save settings.",
			);
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div>
					<Skeleton className="h-8 w-48 mb-2" />
					<Skeleton className="h-4 w-96" />
				</div>
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-6 max-w-5xl">
			<div>
				<h1 className="text-2xl font-bold font-mono tracking-tight flex items-center gap-2">
					<Target className="size-6 text-primary" />
					War Dibs Configuration
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Configure hospital queue callouts and real-time claim locks between
					Discord and the in-game userscript.
				</p>
			</div>

			<Card className="border-border bg-card">
				<CardHeader>
					<CardTitle className="text-base font-medium flex items-center gap-2">
						<Clock className="size-4 text-primary" />
						Dibs Engine Settings
					</CardTitle>
					<CardDescription>
						Control alert timing, person limits, post-hospital lock timers, and
						Discord channels.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Enable War Dibs</div>
							<div className="text-xs text-muted-foreground">
								Activate real-time hospital exit callouts and userscript dibs
								buttons.
							</div>
						</div>
						<Switch
							checked={config.enabled}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({ ...prev, enabled: checked }))
							}
						/>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div className="space-y-2">
							<label
								htmlFor="discord-dibs-channel"
								className="text-xs font-mono font-medium text-foreground"
							>
								Discord Dibs Channel
							</label>
							<Select
								value={config.channelId ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										channelId: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger id="discord-dibs-channel" className="w-full">
									<SelectValue placeholder="Select target channel" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">
										No channel selected (Disabled)
									</SelectItem>
									{channels.map((ch) => (
										<SelectItem key={ch.id} value={ch.id}>
											#{ch.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-[11px] text-muted-foreground">
								Channel where target callout embeds will be posted and updated.
							</p>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="claim-lead-time"
								className="text-xs font-mono font-medium text-foreground"
							>
								Claim Lead Time (Minutes)
							</label>
							<Input
								id="claim-lead-time"
								type="number"
								min={1}
								max={30}
								value={config.claimLeadTime}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										claimLeadTime: Math.max(1, Number(e.target.value) || 1),
									}))
								}
							/>
							<p className="text-[11px] text-muted-foreground">
								Minutes before target leaves hospital to post the Discord
								callout and enable dibs.
							</p>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="max-dibs-per-person"
								className="text-xs font-mono font-medium text-foreground"
							>
								Max Dibs Per Person
							</label>
							<Input
								id="max-dibs-per-person"
								type="number"
								min={1}
								max={5}
								value={config.maxDibsPerPerson}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										maxDibsPerPerson: Math.max(1, Number(e.target.value) || 1),
									}))
								}
							/>
							<p className="text-[11px] text-muted-foreground">
								Maximum number of active targets a single member can claim
								concurrently (Default: 1).
							</p>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="post-hosp-lock"
								className="text-xs font-mono font-medium text-foreground"
							>
								Post-Hospital Lock Duration (Seconds)
							</label>
							<Input
								id="post-hosp-lock"
								type="number"
								min={5}
								max={120}
								value={config.postHospTimeoutSeconds}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										postHospTimeoutSeconds: Math.max(
											5,
											Number(e.target.value) || 20,
										),
									}))
								}
							/>
							<p className="text-[11px] text-muted-foreground">
								Seconds allowed after hospital exit before lock is released if
								target was not downed (Default: 20s).
							</p>
						</div>
					</div>

					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Auto-Delete on Downed</div>
							<div className="text-xs text-muted-foreground">
								Automatically delete the Discord dibs callout message when
								target is hospitalized again.
							</div>
						</div>
						<Switch
							checked={config.autoDeleteOnDowned}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({ ...prev, autoDeleteOnDowned: checked }))
							}
						/>
					</div>
				</CardContent>
				<CardFooter className="flex justify-end border-t border-border pt-4">
					<Button onClick={handleSave} disabled={saving} className="gap-2">
						{saving ? (
							<RefreshCw className="size-4 animate-spin" />
						) : (
							<Save className="size-4" />
						)}
						Save Changes
					</Button>
				</CardFooter>
			</Card>

			<Card className="border-border bg-card">
				<CardHeader className="flex flex-row items-center justify-between">
					<div>
						<CardTitle className="text-base font-medium flex items-center gap-2">
							<Users className="size-4 text-primary" />
							Active Hospital Queue Dibs ({activeDibs.length})
						</CardTitle>
						<CardDescription>
							Real-time live snapshot of opponents currently eligible or
							claimed.
						</CardDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={refreshActiveClaims}
						disabled={refreshingClaims}
						className="gap-1.5"
					>
						<RefreshCw
							className={`size-3.5 ${refreshingClaims ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>
				</CardHeader>
				<CardContent>
					{activeDibs.length === 0 ? (
						<div className="text-center py-8 text-xs text-muted-foreground">
							No active dibs claims currently in progress.
						</div>
					) : (
						<div className="rounded-md border border-border overflow-hidden">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Target</TableHead>
										<TableHead>Level</TableHead>
										<TableHead>Est. BS</TableHead>
										<TableHead>Hospital Exit</TableHead>
										<TableHead>Status</TableHead>
										<TableHead>Claimant</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{activeDibs.map((d) => (
										<TableRow key={d.targetId}>
											<TableCell className="font-medium">
												<a
													href={`https://www.torn.com/profiles.php?XID=${d.targetId}`}
													target="_blank"
													rel="noopener noreferrer"
													className="text-primary hover:underline"
												>
													{d.targetName} [{d.targetId}]
												</a>
											</TableCell>
											<TableCell>{d.targetLevel}</TableCell>
											<TableCell>{formatStats(d.estimatedBs)}</TableCell>
											<TableCell className="font-mono text-amber-500">
												{formatRemainingSeconds(d.hospitalUntil)}
											</TableCell>
											<TableCell>
												{d.status === "claimed" ? (
													<Badge
														variant="outline"
														className="text-amber-500 border-amber-500/30"
													>
														Claimed
													</Badge>
												) : (
													<Badge
														variant="outline"
														className="text-emerald-500 border-emerald-500/30"
													>
														Available
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-xs">
												{d.claimedBy ? (
													<span>
														{d.claimedBy.tornId ? (
															<a
																href={`https://www.torn.com/profiles.php?XID=${d.claimedBy.tornId}`}
																target="_blank"
																rel="noopener noreferrer"
																className="text-primary hover:underline font-medium"
															>
																{d.claimedBy.tornName ?? "Member"} [
																{d.claimedBy.tornId}]
															</a>
														) : (
															<span>
																{d.claimedBy.tornName ??
																	d.claimedBy.discordTag ??
																	"Member"}
															</span>
														)}{" "}
														<span className="text-muted-foreground uppercase text-[10px]">
															({d.claimedBy.platform})
														</span>
													</span>
												) : (
													<span className="text-muted-foreground">—</span>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
