import { Eraser, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelSelect, type DiscordChannel } from "@/components/ChannelSelect";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface SubversiveDibsConfig {
	enabled: boolean;
	channelId: string | null;
	claimLeadTime: number;
	maxDibsPerPerson: number;
	postHospTimeoutSeconds: number;
	autoDeleteOnDowned: boolean;
	channelMaintenanceEnabled?: boolean;
	maxDibsMessageAgeHours?: number;
	sweepIntervalMinutes?: number;
}

/**
 * Family factions that can run the Subversive script with their own dibs
 * settings. Mirrors SUBVERSIVE_FAMILY_FACTION_IDS on the API.
 */
const DIBS_FACTIONS = [
	{ id: 2013, name: "Subversive Alliance" },
	{ id: 27312, name: "SA Succession" },
] as const;

const DEFAULT_CONFIG: SubversiveDibsConfig = {
	enabled: true,
	channelId: null,
	claimLeadTime: 5,
	maxDibsPerPerson: 1,
	postHospTimeoutSeconds: 20,
	autoDeleteOnDowned: true,
	channelMaintenanceEnabled: true,
	maxDibsMessageAgeHours: 6,
	sweepIntervalMinutes: 15,
};

export function DibsConfigPage({
	guildId: _guildId,
}: {
	guildId?: string;
} = {}) {
	const [factionId, setFactionId] = useState<number>(DIBS_FACTIONS[0].id);
	const [config, setConfig] = useState<SubversiveDibsConfig>(DEFAULT_CONFIG);
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [sweeping, setSweeping] = useState(false);
	const [lastSweep, setLastSweep] = useState<string | null>(null);

	const activeFaction =
		DIBS_FACTIONS.find((f) => f.id === factionId) ?? DIBS_FACTIONS[0];

	// Channels are shared across factions, so they are fetched only once.
	const fetchChannels = useCallback(async () => {
		try {
			const chRes = await fetch("/v2/subversive/guild-channels");
			if (chRes.ok) {
				const chData = (await chRes.json()) as { channels: DiscordChannel[] };
				setChannels(chData.channels ?? []);
			}
		} catch (err) {
			console.error("Failed loading dibs channels:", err);
		}
	}, []);

	const fetchConfig = useCallback(async (targetFactionId: number) => {
		setLoading(true);
		try {
			const cfgRes = await fetch(
				`/v2/subversive/dibs-config?factionId=${targetFactionId}`,
			);

			if (cfgRes.ok) {
				const cfgData = (await cfgRes.json()) as {
					config?: SubversiveDibsConfig;
				};
				if (cfgData.config) {
					setConfig({ ...DEFAULT_CONFIG, ...cfgData.config });
				} else {
					setConfig(DEFAULT_CONFIG);
				}
			} else {
				const err = (await cfgRes.json().catch(() => ({}))) as {
					error?: string;
				};
				toast.error(err.error || "Failed to load dibs configuration.");
			}
		} catch (err) {
			console.error("Failed loading dibs data:", err);
			toast.error("Failed to load dibs configuration.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchChannels();
	}, [fetchChannels]);

	useEffect(() => {
		void fetchConfig(factionId);
	}, [factionId, fetchConfig]);

	/**
	 * Triggers an on-demand channel sweep for the active faction. Removes
	 * orphaned dibs callouts left behind by termed wars, API restarts, or
	 * failed IPC deliveries.
	 */
	const handleSweep = async () => {
		setSweeping(true);
		try {
			const res = await fetch("/v2/subversive/dibs/sweep", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ factionId }),
			});

			const data = (await res.json()) as {
				success?: boolean;
				error?: string;
				skipped?: string;
				liveMessageCount?: number;
				trackedMessageCount?: number;
			};

			if (!res.ok || !data.success) {
				if (data.skipped === "no_channel_configured") {
					toast.error("No dibs channel is configured for this faction yet.");
				} else if (data.skipped === "bot_unreachable") {
					toast.error("Discord bot is offline — sweep could not run.");
				} else {
					toast.error(data.error || "Failed to sweep the dibs channel.");
				}
				return;
			}

			setLastSweep(new Date().toLocaleTimeString());
			toast.success(
				`Channel swept. ${data.trackedMessageCount ?? 0} tracked, ${data.liveMessageCount ?? 0} still active.`,
			);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to sweep the channel.",
			);
		} finally {
			setSweeping(false);
		}
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			const res = await fetch("/v2/subversive/dibs-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ factionId, ...config }),
			});

			if (!res.ok) {
				const err = (await res.json()) as { error?: string };
				throw new Error(err.error || "Failed to update configuration");
			}

			const data = (await res.json()) as {
				config: SubversiveDibsConfig;
			};
			setConfig({ ...DEFAULT_CONFIG, ...data.config });
			toast.success(
				`Dibs settings updated for ${activeFaction.name} [${activeFaction.id}].`,
			);
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
			<Tabs
				value={String(factionId)}
				onValueChange={(val) => setFactionId(Number(val))}
			>
				<TabsList className="w-full max-w-lg">
					{DIBS_FACTIONS.map((faction) => (
						<TabsTrigger key={faction.id} value={String(faction.id)}>
							{faction.name}
							<span className="ml-1 font-mono text-[10px] opacity-70">
								[{faction.id}]
							</span>
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<Card className="border-border bg-card">
				<CardHeader>
					<CardTitle className="text-base font-medium flex items-center gap-2">
						Dibs Settings — {activeFaction.name} [{activeFaction.id}]
					</CardTitle>
					<p className="text-xs text-muted-foreground">
						These settings apply only to {activeFaction.name}'s ranked war. Each
						family faction is configured separately.
					</p>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Enable Dibs</div>
							<div className="text-xs text-muted-foreground">
								Allow members of {activeFaction.name} to claim hospital exit
								dibs.
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
								htmlFor={`discord-dibs-channel-${factionId}`}
								className="text-xs font-mono font-medium text-foreground"
							>
								Discord Dibs Channel
							</label>
							<ChannelSelect
								id={`discord-dibs-channel-${factionId}`}
								channels={channels}
								value={config.channelId}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										channelId: val === "none" ? null : val,
									}))
								}
								noneLabel="No channel selected (Disabled)"
								placeholder="Select target channel"
								triggerClassName="w-full"
							/>
						</div>

						<div className="space-y-2">
							<label
								htmlFor={`claim-lead-time-${factionId}`}
								className="text-xs font-mono font-medium text-foreground"
							>
								Claim Lead Time (Minutes)
							</label>
							<Input
								id={`claim-lead-time-${factionId}`}
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
						</div>

						<div className="space-y-2">
							<label
								htmlFor={`max-dibs-per-person-${factionId}`}
								className="text-xs font-mono font-medium text-foreground"
							>
								Max Dibs Per Person
							</label>
							<Input
								id={`max-dibs-per-person-${factionId}`}
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
						</div>

						<div className="space-y-2">
							<label
								htmlFor={`post-hosp-lock-${factionId}`}
								className="text-xs font-mono font-medium text-foreground"
							>
								Post-Hospital Lock Duration (Seconds)
							</label>
							<Input
								id={`post-hosp-lock-${factionId}`}
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
						</div>
					</div>

					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Auto-Delete on Downed</div>
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
				<CardHeader>
					<CardTitle className="text-base font-medium flex items-center gap-2">
						Channel Maintenance
					</CardTitle>
					<p className="text-xs text-muted-foreground">
						Removes orphaned and expired dibs callouts from the Discord channel.
						This cleans up after wars that were termed, API restarts, and failed
						Discord deliveries — cases the normal dibs lifecycle cannot reach.
					</p>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Enable Automatic Sweeps</div>
							<div className="text-xs text-muted-foreground">
								Runs the cleanup on a schedule. Manual sweeps still work when
								this is off.
							</div>
						</div>
						<Switch
							checked={config.channelMaintenanceEnabled ?? true}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({
									...prev,
									channelMaintenanceEnabled: checked,
								}))
							}
						/>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div className="space-y-2">
							<label
								htmlFor={`max-dibs-age-${factionId}`}
								className="text-xs font-mono font-medium text-foreground"
							>
								Max Message Age (Hours)
							</label>
							<Input
								id={`max-dibs-age-${factionId}`}
								type="number"
								min={1}
								max={168}
								value={config.maxDibsMessageAgeHours ?? 6}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										maxDibsMessageAgeHours: Math.max(
											1,
											Number(e.target.value) || 1,
										),
									}))
								}
							/>
							<p className="text-[11px] text-muted-foreground">
								Dibs callouts older than this are always removed.
							</p>
						</div>

						<div className="space-y-2">
							<label
								htmlFor={`sweep-interval-${factionId}`}
								className="text-xs font-mono font-medium text-foreground"
							>
								Sweep Interval (Minutes)
							</label>
							<Input
								id={`sweep-interval-${factionId}`}
								type="number"
								min={0}
								max={1440}
								value={config.sweepIntervalMinutes ?? 15}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										sweepIntervalMinutes: Math.max(
											0,
											Number(e.target.value) || 0,
										),
									}))
								}
							/>
							<p className="text-[11px] text-muted-foreground">
								0 disables the automatic schedule.
							</p>
						</div>
					</div>
				</CardContent>
				<CardFooter className="flex items-center justify-between gap-3 border-t border-border pt-4">
					<span className="text-[11px] text-muted-foreground">
						{lastSweep ? `Last swept at ${lastSweep}` : "Not swept yet"}
					</span>
					<div className="flex gap-2">
						<Button
							variant="outline"
							onClick={handleSweep}
							disabled={sweeping}
							className="gap-2"
						>
							{sweeping ? (
								<RefreshCw className="size-4 animate-spin" />
							) : (
								<Eraser className="size-4" />
							)}
							Sweep Now
						</Button>
						<Button onClick={handleSave} disabled={saving} className="gap-2">
							{saving ? (
								<RefreshCw className="size-4 animate-spin" />
							) : (
								<Save className="size-4" />
							)}
							Save Changes
						</Button>
					</div>
				</CardFooter>
			</Card>
		</div>
	);
}
