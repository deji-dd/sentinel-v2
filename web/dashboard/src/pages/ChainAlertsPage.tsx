import {
	DEFAULT_SUBVERSIVE_CHAIN_CONFIG,
	MAX_SUBVERSIVE_CHAIN_START,
	MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
	MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	MIN_SUBVERSIVE_CHAIN_START,
	MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	type SubversiveChainConfig,
} from "@sentinel/schemas";
import { Link2, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelSelect, type DiscordChannel } from "@/components/ChannelSelect";
import { PageHeader } from "@/components/PageHeader";
import { PageShell } from "@/components/PageShell";
import { SectionCard, SectionCardFooter } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface DiscordRole {
	id: string;
	name: string;
	color: number;
	position: number;
}

interface ChainAlertConfig
	extends Omit<SubversiveChainConfig, "updatedAt" | "updatedBy"> {
	updatedAt?: string | null;
	updatedBy?: string | null;
}

/**
 * Family factions that run their own chain. Mirrors
 * SUBVERSIVE_FAMILY_FACTION_IDS on the API.
 */
const CHAIN_FACTIONS = [
	{ id: 2013, name: "Subversive Alliance" },
	{ id: 27312, name: "SA Succession" },
] as const;

const DEFAULT_CONFIG: ChainAlertConfig = {
	...DEFAULT_SUBVERSIVE_CHAIN_CONFIG,
};

/** Structural comparison for the dirty check. */
function serialize(config: ChainAlertConfig): string {
	return JSON.stringify({
		enabled: config.enabled,
		channelId: config.channelId,
		warningRoleId: config.warningRoleId,
		minimumChainStart: config.minimumChainStart,
		chainTimeWarningSeconds: config.chainTimeWarningSeconds,
		subsequentWarningIntervalSeconds: config.subsequentWarningIntervalSeconds,
	});
}

function asInteger(value: string, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * Chain-monitoring settings for both Subversive family factions.
 *
 * Each faction has its own chain, so each row here is configured independently.
 * The page only writes configuration; the scheduler's `subversive:chain_monitor`
 * worker polls Torn and sends the actual role pings.
 */
export function ChainAlertsPage({ guildId }: { guildId?: string } = {}) {
	const [factionId, setFactionId] = useState<number>(CHAIN_FACTIONS[0].id);
	const [config, setConfig] = useState<ChainAlertConfig>(DEFAULT_CONFIG);
	const [initialConfig, setInitialConfig] =
		useState<ChainAlertConfig>(DEFAULT_CONFIG);
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [roles, setRoles] = useState<DiscordRole[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);

	const activeFaction =
		CHAIN_FACTIONS.find((faction) => faction.id === factionId) ??
		CHAIN_FACTIONS[0];

	const fetchChannels = useCallback(async () => {
		try {
			const res = await fetch("/v2/subversive/guild-channels");
			if (res.ok) {
				const data = (await res.json()) as { channels?: DiscordChannel[] };
				setChannels(data.channels ?? []);
			} else {
				toast.error("Failed to load Discord channels.");
			}
		} catch (err) {
			console.error("Failed loading chain alert channels:", err);
			toast.error("Failed to load Discord channels.");
		}
	}, []);

	const fetchRoles = useCallback(async () => {
		if (!guildId) return;
		try {
			const res = await fetch(`/v2/guilds/${guildId}/roles`);
			if (res.ok) {
				const data = (await res.json()) as { roles?: DiscordRole[] };
				const sorted = [...(data.roles ?? [])].sort(
					(a, b) => b.position - a.position,
				);
				setRoles(sorted);
			} else {
				toast.error("Failed to load Discord roles.");
			}
		} catch (err) {
			console.error("Failed loading chain alert roles:", err);
			toast.error("Failed to load Discord roles.");
		}
	}, [guildId]);

	const fetchConfig = useCallback(async (targetFactionId: number) => {
		setLoading(true);
		try {
			const res = await fetch(
				`/v2/subversive/chain-config?factionId=${targetFactionId}`,
			);

			if (res.ok) {
				const data = (await res.json()) as { config?: ChainAlertConfig };
				const loaded = { ...DEFAULT_CONFIG, ...(data.config ?? {}) };
				setConfig(loaded);
				setInitialConfig(loaded);
			} else {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				toast.error(err.error || "Failed to load chain settings.");
			}
		} catch (err) {
			console.error("Failed loading chain settings:", err);
			toast.error("Failed to load chain settings.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchChannels();
		void fetchRoles();
	}, [fetchChannels, fetchRoles]);

	useEffect(() => {
		void fetchConfig(factionId);
	}, [factionId, fetchConfig]);

	const isDirty = serialize(config) !== serialize(initialConfig);

	const handleDiscard = () => {
		setConfig(initialConfig);
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			const res = await fetch("/v2/subversive/chain-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					factionId,
					enabled: config.enabled,
					channelId: config.channelId,
					warningRoleId: config.warningRoleId,
					minimumChainStart: config.minimumChainStart,
					chainTimeWarningSeconds: config.chainTimeWarningSeconds,
					subsequentWarningIntervalSeconds:
						config.subsequentWarningIntervalSeconds,
				}),
			});

			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(err.error || "Failed to update chain settings");
			}

			const data = (await res.json()) as { config?: ChainAlertConfig };
			const saved = { ...DEFAULT_CONFIG, ...(data.config ?? {}) };
			setConfig(saved);
			setInitialConfig(saved);
			toast.success(
				`Chain settings updated for ${activeFaction.name} [${activeFaction.id}].`,
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
			<PageShell>
				<PageHeader title="Chain Alerts" icon={Link2} />
				<Skeleton className="h-10 w-full max-w-lg rounded-xl" />
				<Skeleton className="h-80 w-full rounded-xl" />
			</PageShell>
		);
	}

	const selectedRole = roles.find((role) => role.id === config.warningRoleId);
	const roleOptionExists = !config.warningRoleId || Boolean(selectedRole);

	return (
		<PageShell>
			<PageHeader
				title="Chain Alerts"
				icon={Link2}
				description="Poll each faction's chain and ping a role when the chain timer gets low. Every warning includes three low-stat, okay targets."
			/>

			<Tabs
				value={String(factionId)}
				onValueChange={(value) => setFactionId(Number(value))}
			>
				<TabsList className="h-auto w-full max-w-lg p-1">
					{CHAIN_FACTIONS.map((faction) => (
						<TabsTrigger
							key={faction.id}
							value={String(faction.id)}
							className="min-w-0 py-1.5"
						>
							<span className="truncate">{faction.name}</span>
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<SectionCard
				title={`${activeFaction.name} chain monitor`}
				description={`Faction ID ${activeFaction.id} · settings are independent for each family faction.`}
				action={
					<StatusBadge tone={isDirty ? "warning" : "success"} size="sm">
						{isDirty ? "Unsaved" : "Saved"}
					</StatusBadge>
				}
			>
				<div className="flex flex-col gap-5 px-4 py-4 sm:px-6">
					<div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
						<div className="min-w-0 space-y-0.5">
							<div className="text-sm font-semibold">Enable chain monitor</div>
							<p className="text-xs text-muted-foreground">
								When enabled and routed to a channel, the worker polls{" "}
								{activeFaction.name}'s chain and sends warnings.
							</p>
						</div>
						<Switch
							checked={config.enabled}
							onCheckedChange={(checked) =>
								setConfig((previous) => ({ ...previous, enabled: checked }))
							}
						/>
					</div>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor={`chain-channel-${factionId}`}>
								Discord alert channel
							</Label>
							<ChannelSelect
								id={`chain-channel-${factionId}`}
								channels={channels}
								value={config.channelId}
								onValueChange={(value) =>
									setConfig((previous) => ({
										...previous,
										channelId: value === "none" ? null : value,
									}))
								}
								noneLabel="-- No Channel Selected --"
								placeholder="-- No Channel Selected --"
							/>
							<p className="text-xs text-muted-foreground">
								No channel means the worker does not poll this faction at all.
							</p>
						</div>

						<div className="space-y-2">
							<Label htmlFor={`chain-role-${factionId}`}>Warning role</Label>
							<Select
								value={config.warningRoleId ?? "none"}
								onValueChange={(value) =>
									setConfig((previous) => ({
										...previous,
										warningRoleId: value === "none" ? null : value,
									}))
								}
							>
								<SelectTrigger
									id={`chain-role-${factionId}`}
									className="w-full bg-background text-foreground"
								>
									<SelectValue placeholder="-- No Role Selected --" />
								</SelectTrigger>
								<SelectContent className="max-h-72 rounded-xl border-border bg-popover text-popover-foreground">
									<SelectItem value="none">
										<span className="text-muted-foreground italic">
											-- No Role Selected --
										</span>
									</SelectItem>
									{!roleOptionExists && config.warningRoleId ? (
										<SelectItem value={config.warningRoleId}>
											Unknown role ({config.warningRoleId})
										</SelectItem>
									) : null}
									{roles.map((role) => (
										<SelectItem key={role.id} value={role.id}>
											{role.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								Mentioned on every warning. Leave unselected to send without a
								ping.
							</p>
						</div>

						<div className="space-y-2">
							<Label htmlFor={`chain-minimum-${factionId}`}>
								Minimum chain start
							</Label>
							<Input
								id={`chain-minimum-${factionId}`}
								type="number"
								min={MIN_SUBVERSIVE_CHAIN_START}
								max={MAX_SUBVERSIVE_CHAIN_START}
								step={1}
								value={config.minimumChainStart}
								onChange={(event) =>
									setConfig((previous) => ({
										...previous,
										minimumChainStart: asInteger(
											event.target.value,
											previous.minimumChainStart,
										),
									}))
								}
							/>
							<p className="text-xs text-muted-foreground">
								The worker idles until a chain reaches this count, then polls
								every 5 seconds. No warning fires below it.
							</p>
						</div>

						<div className="space-y-2">
							<Label htmlFor={`chain-warning-${factionId}`}>
								Warn at seconds remaining
							</Label>
							<Input
								id={`chain-warning-${factionId}`}
								type="number"
								min={MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS}
								max={MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS}
								step={1}
								value={config.chainTimeWarningSeconds}
								onChange={(event) =>
									setConfig((previous) => ({
										...previous,
										chainTimeWarningSeconds: asInteger(
											event.target.value,
											previous.chainTimeWarningSeconds,
										),
									}))
								}
							/>
							<p className="text-xs text-muted-foreground">
								Measured against the chain timer. 60 means "ping when 60 seconds
								or less are left".
							</p>
						</div>

						<div className="space-y-2">
							<Label htmlFor={`chain-repeat-${factionId}`}>
								Repeat every (seconds)
							</Label>
							<Input
								id={`chain-repeat-${factionId}`}
								type="number"
								min={0}
								max={MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS}
								step={1}
								value={config.subsequentWarningIntervalSeconds}
								onChange={(event) =>
									setConfig((previous) => ({
										...previous,
										subsequentWarningIntervalSeconds: asInteger(
											event.target.value,
											previous.subsequentWarningIntervalSeconds,
										),
									}))
								}
							/>
							<p className="text-xs text-muted-foreground">
								Repeat warnings while the timer stays low. 0 sends only the
								first warning.
							</p>
						</div>
					</div>

					<div className="rounded-xl border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground sm:p-4">
						Every warning picks up to three targets from the target-finder pool:
						currently okay, not in hospital, and ranked by lowest estimated
						battle stats. If the pool has no eligible targets, the warning still
						sends with a fallback message.
					</div>
				</div>

				<SectionCardFooter
					status={
						isDirty ? (
							<span className="text-warning">Unsaved changes pending</span>
						) : config.updatedAt ? (
							<span>
								Last saved {new Date(config.updatedAt).toLocaleString()}
								{config.updatedBy ? ` by ${config.updatedBy}` : ""}
							</span>
						) : (
							<span>Factory defaults shown</span>
						)
					}
				>
					{isDirty ? (
						<Button
							type="button"
							variant="outline"
							onClick={handleDiscard}
							disabled={saving}
							className="gap-2"
						>
							<RotateCcw className="size-3.5" />
							Discard
						</Button>
					) : null}

					<Button
						type="button"
						onClick={() => void handleSave()}
						disabled={saving || !isDirty}
						className="gap-2"
					>
						{saving ? (
							<Spinner className="size-4" />
						) : (
							<Save className="size-4" />
						)}
						{saving ? "Saving..." : "Save Changes"}
					</Button>
				</SectionCardFooter>
			</SectionCard>
		</PageShell>
	);
}

export default ChainAlertsPage;
