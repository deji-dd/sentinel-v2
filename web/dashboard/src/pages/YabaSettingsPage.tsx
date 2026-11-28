import { BarChart3, ExternalLink, Hash, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ChannelSelect, type DiscordChannel } from "@/components/ChannelSelect";
import { PageHeader } from "@/components/PageHeader";
import { PageShell } from "@/components/PageShell";
import { SectionCard, SectionCardFooter } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";
import { useRouter } from "../router";

const YABA_UI_URL = "https://yaba.blasted-labs.tech";

interface YabaChannels {
	factionChannelId: string | null;
	playerChannelId: string | null;
}

function extractApiError(error: unknown, fallback: string): string {
	if (typeof error === "object" && error !== null && "value" in error) {
		const value = (error as { value?: { error?: string } }).value;
		if (typeof value?.error === "string") return value.error;
	}
	return fallback;
}

export function YabaSettingsPage() {
	const { toast } = useToast();
	const { path } = useRouter();
	const guildId = path.match(/^\/guilds\/([^/]+)/)?.[1] ?? null;

	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [config, setConfig] = useState<YabaChannels>({
		factionChannelId: null,
		playerChannelId: null,
	});
	const [savedConfig, setSavedConfig] = useState<YabaChannels>({
		factionChannelId: null,
		playerChannelId: null,
	});

	const load = useCallback(async (): Promise<void> => {
		if (!guildId) {
			setLoading(false);
			return;
		}
		try {
			const [configRes, channelsRes] = await Promise.all([
				api.v2.yaba.admin.channels.get(),
				api.v2.guilds({ guildId }).channels.get(),
			]);
			if (configRes.error) {
				toast(
					extractApiError(configRes.error, "Failed to load YABA channels."),
					"error",
				);
				return;
			}
			if (configRes.data && "factionChannelId" in configRes.data) {
				const loaded: YabaChannels = {
					factionChannelId: configRes.data.factionChannelId ?? null,
					playerChannelId: configRes.data.playerChannelId ?? null,
				};
				setConfig(loaded);
				setSavedConfig(loaded);
			}
			if (channelsRes.data && "channels" in channelsRes.data) {
				setChannels(channelsRes.data.channels);
			}
		} catch {
			toast("Failed to load YABA channels.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void load();
	}, [load]);

	const isDirty =
		config.factionChannelId !== savedConfig.factionChannelId ||
		config.playerChannelId !== savedConfig.playerChannelId;
	const isDisabled =
		!config.factionChannelId && !config.playerChannelId && !isDirty;

	const saveChannels = async () => {
		setSaving(true);
		try {
			const res = await api.v2.yaba.admin.channels.put({
				factionChannelId: config.factionChannelId,
				playerChannelId: config.playerChannelId,
			});
			if (res.error) {
				toast(
					extractApiError(res.error, "Failed to save YABA channels."),
					"error",
				);
				return;
			}
			toast("YABA chart channels saved.", "success");
			await load();
		} catch {
			toast("Failed to save YABA channels.", "error");
		} finally {
			setSaving(false);
		}
	};

	const headerActions = (
		<Button variant="outline" size="sm" asChild className="gap-2">
			<a href={YABA_UI_URL} target="_blank" rel="noreferrer">
				<ExternalLink className="size-3.5 shrink-0" />
				<span className="truncate">Open YABA</span>
			</a>
		</Button>
	);

	if (loading || !guildId) {
		return (
			<PageShell>
				<PageHeader
					title="YABA Stats"
					description="Choose the channels for the daily faction and player charts."
					icon={BarChart3}
				/>
				<Skeleton className="h-10 w-full max-w-lg rounded-xl" />
				<Skeleton className="h-80 w-full rounded-xl" />
			</PageShell>
		);
	}

	return (
		<PageShell>
			<PageHeader
				title="YABA Stats"
				description="Choose the two channels where the bot posts the daily YABA top-10 charts."
				icon={BarChart3}
				actions={headerActions}
			/>

			<SectionCard
				title="Daily chart channels"
				description="These are the two channels where the bot posts the daily top-10 charts. Select “none” to disable a chart."
				icon={Hash}
				action={
					<StatusBadge
						tone={isDirty ? "warning" : isDisabled ? "neutral" : "success"}
						size="sm"
					>
						{isDirty ? "Unsaved" : isDisabled ? "Disabled" : "Saved"}
					</StatusBadge>
				}
			>
				<div className="flex flex-col gap-5">
					<div className="flex min-w-0 flex-col gap-2">
						<Label
							htmlFor="yaba-faction-channel"
							className="text-sm font-semibold"
						>
							Faction chart channel
						</Label>
						<p className="text-xs text-muted-foreground">
							Receives the daily top-10 factions chart.
						</p>
						<div className="w-full min-w-0 sm:max-w-md">
							<ChannelSelect
								id="yaba-faction-channel"
								channels={channels}
								value={config.factionChannelId}
								onValueChange={(value) =>
									setConfig((previous) => ({
										...previous,
										factionChannelId: value === "none" ? null : value,
									}))
								}
								noneLabel="-- No Channel --"
								placeholder="-- No Channel --"
							/>
						</div>
					</div>

					<div className="flex min-w-0 flex-col gap-2">
						<Label
							htmlFor="yaba-player-channel"
							className="text-sm font-semibold"
						>
							Player chart channel
						</Label>
						<p className="text-xs text-muted-foreground">
							Receives the daily top-10 players chart.
						</p>
						<div className="w-full min-w-0 sm:max-w-md">
							<ChannelSelect
								id="yaba-player-channel"
								channels={channels}
								value={config.playerChannelId}
								onValueChange={(value) =>
									setConfig((previous) => ({
										...previous,
										playerChannelId: value === "none" ? null : value,
									}))
								}
								noneLabel="-- No Channel --"
								placeholder="-- No Channel --"
							/>
						</div>
					</div>
				</div>

				<SectionCardFooter
					status={
						isDirty ? (
							<span className="text-warning">Unsaved changes pending</span>
						) : (
							<span>
								Changes take effect on the next daily post. Messages are edited
								in place.
							</span>
						)
					}
				>
					<Button
						type="button"
						onClick={() => void saveChannels()}
						disabled={saving}
						className="gap-2"
					>
						{saving ? (
							<Spinner className="size-4 shrink-0" />
						) : (
							<Save className="size-4" />
						)}
						{saving ? "Saving..." : "Save Channels"}
					</Button>
				</SectionCardFooter>
			</SectionCard>

			<SectionCard title="How the daily report works" icon={BarChart3}>
				<div className="flex flex-col gap-3 text-sm text-muted-foreground">
					<p>
						Each day the bot posts a top 10 factions chart and a top 10 players
						chart, each with its own chart image and a link to{" "}
						<a
							href={YABA_UI_URL}
							target="_blank"
							rel="noreferrer"
							className="break-anywhere text-primary underline underline-offset-4"
						>
							{YABA_UI_URL}
						</a>
						.
					</p>
					<p>
						Messages are edited in place rather than reposted, so each channel
						keeps a single up-to-date chart instead of a daily flood of new
						posts.
					</p>
				</div>
			</SectionCard>
		</PageShell>
	);
}

export default YabaSettingsPage;
