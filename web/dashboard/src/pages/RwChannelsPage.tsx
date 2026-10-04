import { Clock, Hash, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelSelect, type DiscordChannel } from "@/components/ChannelSelect";
import { PageHeader } from "@/components/PageHeader";
import { PageShell } from "@/components/PageShell";
import { SectionCard, SectionCardFooter } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface RwChannelConfig {
	primaryDisplaysChannelId: string | null;
	secondaryDisplaysChannelId: string | null;
	updatedAt?: string | null;
	updatedBy?: string | null;
}

/**
 * Family factions that can run the ranked-war tooling with their own channel
 * selections. Mirrors SUBVERSIVE_FAMILY_FACTION_IDS on the API.
 */
const RW_FACTIONS = [
	{ id: 2013, name: "Subversive Alliance" },
	{ id: 27312, name: "SA Succession" },
] as const;

const DEFAULT_CONFIG: RwChannelConfig = {
	primaryDisplaysChannelId: null,
	secondaryDisplaysChannelId: null,
};

/**
 * Every ranked-war channel a faction can select, in display order. Adding a new
 * selection means adding a field here plus its slot on the config/API side.
 */
const CHANNEL_FIELDS: ReadonlyArray<{
	field: keyof RwChannelConfig;
	label: string;
	/** Design-token accent so the highlight survives the light theme. */
	accent: string;
}> = [
	{
		field: "primaryDisplaysChannelId",
		label: "Primary Displays",
		accent: "text-warning",
	},
	{
		field: "secondaryDisplaysChannelId",
		label: "Secondary Displays",
		accent: "text-info",
	},
];

export function RwChannelsPage({
	guildId: _guildId,
}: {
	guildId?: string;
} = {}) {
	const [factionId, setFactionId] = useState<number>(RW_FACTIONS[0].id);
	const [config, setConfig] = useState<RwChannelConfig>(DEFAULT_CONFIG);
	const [initialConfig, setInitialConfig] =
		useState<RwChannelConfig>(DEFAULT_CONFIG);
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);

	const activeFaction =
		RW_FACTIONS.find((f) => f.id === factionId) ?? RW_FACTIONS[0];

	// Channels are shared across factions, so they are fetched only once.
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
			console.error("Failed loading ranked-war channels:", err);
			toast.error("Failed to load Discord channels.");
		}
	}, []);

	const fetchConfig = useCallback(async (targetFactionId: number) => {
		setLoading(true);
		try {
			const res = await fetch(
				`/v2/subversive/rw-channels-config?factionId=${targetFactionId}`,
			);

			if (res.ok) {
				const data = (await res.json()) as { config?: RwChannelConfig };
				const loaded = { ...DEFAULT_CONFIG, ...(data.config ?? {}) };
				setConfig(loaded);
				setInitialConfig(loaded);
			} else {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				toast.error(err.error || "Failed to load channel selections.");
			}
		} catch (err) {
			console.error("Failed loading ranked-war channels:", err);
			toast.error("Failed to load channel selections.");
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

	const isDirty = CHANNEL_FIELDS.some(
		({ field }) => config[field] !== initialConfig[field],
	);

	const handleDiscard = () => {
		setConfig(initialConfig);
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			const res = await fetch("/v2/subversive/rw-channels-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					factionId,
					primaryDisplaysChannelId: config.primaryDisplaysChannelId,
					secondaryDisplaysChannelId: config.secondaryDisplaysChannelId,
				}),
			});

			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(err.error || "Failed to update channel selections");
			}

			const data = (await res.json()) as { config: RwChannelConfig };
			const saved = { ...DEFAULT_CONFIG, ...data.config };
			setConfig(saved);
			setInitialConfig(saved);
			toast.success(
				`Channel selections updated for ${activeFaction.name} [${activeFaction.id}].`,
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
				<PageHeader
					title="Channel Selections"
					description="Designate the channels ranked-war displays are posted to."
					icon={Hash}
				/>
				<Skeleton className="h-10 w-full max-w-lg rounded-xl" />
				<Skeleton className="h-72 w-full rounded-xl" />
			</PageShell>
		);
	}

	return (
		<PageShell>
			<PageHeader
				title="Channel Selections"
				description="Designate the channels ranked-war displays are posted to."
				icon={Hash}
			/>

			{/* Faction switcher. Two long faction names cannot share a phone row
			    comfortably, so the list stretches and each label truncates. */}
			<Tabs
				value={String(factionId)}
				onValueChange={(val) => setFactionId(Number(val))}
			>
				<TabsList className="h-auto w-full max-w-lg p-1">
					{RW_FACTIONS.map((faction) => (
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
				title={activeFaction.name}
				description={`Faction ID ${activeFaction.id}`}
				action={
					<StatusBadge tone={isDirty ? "warning" : "success"} size="sm">
						{isDirty ? "Unsaved" : "Saved"}
					</StatusBadge>
				}
				flush
			>
				<div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
					{CHANNEL_FIELDS.map(({ field, label, accent }) => {
						const inputId = `select-${String(field)}-${factionId}`;
						const selected = config[field] ?? null;

						// The two displays must not share a channel: the primary
						// channel's stale-message sweep deletes any bot-authored
						// message it does not recognise, so a shared channel would
						// have it destroy the travel embed as strays. Hiding the
						// other field's selection makes the conflict unreachable
						// rather than relying on the save being rejected.
						const otherField = CHANNEL_FIELDS.find(
							(f) => f.field !== field,
						)?.field;
						const reservedByOther = otherField ? config[otherField] : null;
						const availableChannels = reservedByOther
							? channels.filter((c) => c.id !== reservedByOther)
							: channels;

						return (
							<div
								key={field}
								className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 sm:p-4"
							>
								<Label
									htmlFor={inputId}
									className="cursor-pointer text-sm font-semibold"
								>
									{label}
								</Label>

								<div className="w-full min-w-0 sm:max-w-md">
									<ChannelSelect
										id={inputId}
										channels={availableChannels}
										value={selected}
										onValueChange={(val) =>
											setConfig((prev) => ({
												...prev,
												[field]: val === "none" ? null : val,
											}))
										}
										noneLabel="-- No Channel Selected --"
										placeholder="-- No Channel Selected --"
										contentClassName="rounded-xl border-border bg-popover text-popover-foreground"
									/>
								</div>

								{selected ? (
									<div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-1.5 text-xs">
										<span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase">
											Selected
										</span>
										<span
											className={`min-w-0 truncate font-mono font-semibold ${accent}`}
											title={
												channels.find((c) => c.id === selected)?.name ??
												selected
											}
										>
											#
											{channels.find((c) => c.id === selected)?.name ??
												selected}
										</span>
									</div>
								) : null}
							</div>
						);
					})}

					{config.updatedAt ? (
						<div className="flex flex-col gap-1 border-t border-border/60 pt-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
							<div className="flex items-center gap-1.5">
								<Clock className="size-3.5 shrink-0" />
								<span>
									Last updated: {new Date(config.updatedAt).toLocaleString()}
								</span>
							</div>
							{config.updatedBy ? (
								<span className="truncate font-mono text-[10px]">
									By: {config.updatedBy}
								</span>
							) : null}
						</div>
					) : null}
				</div>

				<SectionCardFooter
					status={
						isDirty ? (
							<span className="flex items-center gap-2 font-medium text-warning">
								<span className="size-2 shrink-0 animate-pulse rounded-full bg-warning" />
								Unsaved changes pending
							</span>
						) : (
							<span>All settings saved</span>
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

export default RwChannelsPage;
