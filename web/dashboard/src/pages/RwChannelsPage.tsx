import { Clock, Loader2, RotateCcw, Save } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface RwChannelConfig {
	primaryDisplaysChannelId: string | null;
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
};

/**
 * Every ranked-war channel a faction can select, in display order. Adding a new
 * selection means adding a field here plus its slot on the config/API side.
 */
const CHANNEL_FIELDS: ReadonlyArray<{
	field: keyof RwChannelConfig;
	label: string;
	accent: string;
}> = [
	{
		field: "primaryDisplaysChannelId",
		label: "Primary Displays",

		accent: "text-amber-400",
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
			<div className="space-y-6">
				<div className="pb-6 border-b border-border/60">
					<Skeleton className="h-9 w-64" />
				</div>
				<Skeleton className="h-96 w-full rounded-2xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 pb-12 max-w-5xl">
			<Tabs
				value={String(factionId)}
				onValueChange={(val) => setFactionId(Number(val))}
			>
				<TabsList className="w-full max-w-lg">
					{RW_FACTIONS.map((faction) => (
						<TabsTrigger key={faction.id} value={String(faction.id)}>
							{faction.name}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-base font-medium">
						Channel Selections
					</CardTitle>
				</CardHeader>

				<CardContent className="space-y-6">
					{CHANNEL_FIELDS.map(({ field, label, accent }) => {
						const inputId = `select-${String(field)}-${factionId}`;
						const selected = config[field] ?? null;

						return (
							<div
								key={field}
								className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3"
							>
								<label
									htmlFor={inputId}
									className="text-sm font-semibold text-foreground block cursor-pointer"
								>
									{label}
								</label>

								<div className="max-w-md">
									<ChannelSelect
										id={inputId}
										channels={channels}
										value={selected}
										onValueChange={(val) =>
											setConfig((prev) => ({
												...prev,
												[field]: val === "none" ? null : val,
											}))
										}
										noneLabel="-- No Channel Selected --"
										placeholder="-- No Channel Selected --"
										contentClassName="rounded-xl border-border bg-popover text-popover-foreground max-h-72"
									/>
								</div>

								{selected && (
									<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
										<span className="text-muted-foreground text-[10px]">
											SELECTED:
										</span>
										<span className={`${accent} font-semibold`}>
											#
											{channels.find((c) => c.id === selected)?.name ??
												selected}
										</span>
									</div>
								)}
							</div>
						);
					})}

					{config.updatedAt && (
						<div className="pt-2 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/60">
							<div className="flex items-center gap-1.5">
								<Clock className="size-3.5" />
								<span>
									Last updated: {new Date(config.updatedAt).toLocaleString()}
								</span>
							</div>
							{config.updatedBy && (
								<span className="font-mono text-[10px]">
									By: {config.updatedBy}
								</span>
							)}
						</div>
					)}
				</CardContent>

				<CardFooter className="flex items-center justify-between gap-4 border-t border-border pt-4">
					<div className="text-xs text-muted-foreground font-mono">
						{isDirty ? (
							<span className="text-amber-500 flex items-center gap-2 font-medium">
								<span className="size-2 rounded-full bg-amber-500 animate-pulse" />
								Unsaved changes pending
							</span>
						) : (
							<span>All settings saved</span>
						)}
					</div>

					<div className="flex items-center gap-3">
						{isDirty && (
							<Button
								type="button"
								variant="outline"
								onClick={handleDiscard}
								disabled={saving}
								className="h-10 px-4 rounded-xl text-xs font-semibold cursor-pointer gap-2"
							>
								<RotateCcw className="size-3.5" data-icon="inline-start" />
								Discard Changes
							</Button>
						)}

						<Button
							type="button"
							onClick={() => void handleSave()}
							disabled={saving || !isDirty}
							className="h-10 px-6 rounded-xl text-xs font-semibold cursor-pointer gap-2"
						>
							{saving ? (
								<Loader2
									className="size-4 animate-spin"
									data-icon="inline-start"
								/>
							) : (
								<Save className="size-4" data-icon="inline-start" />
							)}
							{saving ? "Saving Changes..." : "Save Changes"}
						</Button>
					</div>
				</CardFooter>
			</Card>
		</div>
	);
}

export default RwChannelsPage;
