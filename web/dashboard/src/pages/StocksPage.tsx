import {
	formatStockAlertWindow,
	type GuildStockAlertConfig,
	MAX_STOCK_ALERT_CHANGE_RULES,
	STOCK_ALERT_CHANGE_WINDOW_MINUTES,
	STOCK_ALERT_RANGE_LABELS,
	STOCK_ALERT_RANGES,
	type StockAlertChangeRule,
	type StockAlertRange,
} from "@sentinel/schemas";
import {
	Clock,
	Play,
	Plus,
	RotateCcw,
	Save,
	Trash2,
	TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelSelect, type DiscordChannel } from "@/components/ChannelSelect";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { PageShell } from "@/components/PageShell";
import { SectionCard, SectionCardFooter } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

/**
 * Wire shape of the configuration endpoint: the shared config plus the bookkeeping
 * fields, which arrive as nulls rather than being absent.
 */
interface StockAlertConfig
	extends Omit<GuildStockAlertConfig, "updatedAt" | "updatedBy"> {
	updatedAt?: string | null;
	updatedBy?: string | null;
}

/**
 * Every move window the API accepts, labelled the same way the alert itself
 * labels it.
 *
 * Derived from the shared constant rather than repeated here, so the dashboard
 * cannot offer a window the worker refuses to evaluate.
 */
const CHANGE_WINDOW_OPTIONS: ReadonlyArray<{ value: number; label: string }> =
	STOCK_ALERT_CHANGE_WINDOW_MINUTES.map((value) => ({
		value,
		label: formatStockAlertWindow(value),
	}));

const MAX_CHANGE_RULES = MAX_STOCK_ALERT_CHANGE_RULES;

const RANGE_DESCRIPTIONS: Record<StockAlertRange, string> = {
	"1h": "The last hour of trading.",
	"24h": "The last day.",
	"7d": "The last week.",
	"30d": "The last month.",
	"1y": "The last year.",
	all_time: "Rare, notable events: a stock's best or worst price ever.",
};

const DEFAULT_CONFIG: StockAlertConfig = {
	enabled: false,
	channelId: null,
	changeRules: [
		{ windowMinutes: 30, thresholdPct: 0.5 },
		{ windowMinutes: 60, thresholdPct: 1 },
	],
	highLowRanges: ["24h", "all_time"],
	cooldownMinutes: 30,
};

/** Structural comparison for the dirty check, arrays included. */
function serialize(config: StockAlertConfig): string {
	return JSON.stringify({
		enabled: config.enabled,
		channelId: config.channelId,
		changeRules: config.changeRules,
		highLowRanges: config.highLowRanges,
		cooldownMinutes: config.cooldownMinutes,
	});
}

/**
 * Torn stock-market alert settings for one Discord guild.
 *
 * Guild-wide by design: the alert channel, the sensitivity and the audience are
 * properties of the server, and both family factions are members of it. The
 * previous per-faction split made an admin configure the same channel twice and
 * reason about two independent cooldowns.
 */
export function StocksPage({ guildId }: { guildId?: string } = {}) {
	const [config, setConfig] = useState<StockAlertConfig>(DEFAULT_CONFIG);
	const [initialConfig, setInitialConfig] =
		useState<StockAlertConfig>(DEFAULT_CONFIG);
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [triggering, setTriggering] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	const basePath = guildId ? `/v2/guilds/${guildId}` : null;

	const fetchChannels = useCallback(async () => {
		if (!basePath) return;
		try {
			const res = await fetch(`${basePath}/channels`);
			if (res.ok) {
				const data = (await res.json()) as { channels?: DiscordChannel[] };
				setChannels(data.channels ?? []);
			}
		} catch (err) {
			console.error("Failed loading stock alert channels:", err);
		}
	}, [basePath]);

	const fetchConfig = useCallback(async () => {
		if (!basePath) {
			setLoadError("No server selected.");
			setLoading(false);
			return;
		}

		setLoading(true);
		setLoadError(null);
		try {
			const res = await fetch(`${basePath}/stock-alert-config`);

			if (res.ok) {
				const data = (await res.json()) as { config?: StockAlertConfig };
				const loaded = { ...DEFAULT_CONFIG, ...(data.config ?? {}) };
				setConfig(loaded);
				setInitialConfig(loaded);
			} else {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				const message = err.error || "Failed to load stock alert settings.";
				setLoadError(message);
				toast.error(message);
			}
		} catch (err) {
			console.error("Failed loading stock alert settings:", err);
			const message = "Failed to load stock alert settings.";
			setLoadError(message);
			toast.error(message);
		} finally {
			setLoading(false);
		}
	}, [basePath]);

	useEffect(() => {
		void fetchChannels();
	}, [fetchChannels]);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	const isDirty = serialize(config) !== serialize(initialConfig);

	const handleDiscard = () => {
		setConfig(initialConfig);
	};

	const handleSave = async () => {
		if (!basePath) return;
		setSaving(true);
		try {
			const res = await fetch(`${basePath}/stock-alert-config`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					enabled: config.enabled,
					channelId: config.channelId,
					changeRules: config.changeRules,
					highLowRanges: config.highLowRanges,
					cooldownMinutes: config.cooldownMinutes,
				}),
			});

			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(err.error || "Failed to update stock alert settings.");
			}

			const data = (await res.json()) as { config: StockAlertConfig };
			const saved = { ...DEFAULT_CONFIG, ...data.config };
			setConfig(saved);
			setInitialConfig(saved);
			toast.success("Stock alert settings updated for this server.");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save settings.",
			);
		} finally {
			setSaving(false);
		}
	};

	const handleRunNow = async () => {
		if (!basePath) return;
		setTriggering(true);
		try {
			const res = await fetch(`${basePath}/stock-alerts/run-now`, {
				method: "POST",
			});
			const data = (await res.json().catch(() => ({}))) as {
				message?: string;
				error?: string;
			};
			if (!res.ok) {
				throw new Error(data.error || "Failed to trigger a stock alert check.");
			}
			toast.success(data.message ?? "Stock alert check triggered.");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to trigger a check.",
			);
		} finally {
			setTriggering(false);
		}
	};

	const updateRule = (
		index: number,
		patch: Partial<StockAlertChangeRule>,
	): void => {
		setConfig((prev) => ({
			...prev,
			changeRules: prev.changeRules.map((rule, ruleIndex) =>
				ruleIndex === index ? { ...rule, ...patch } : rule,
			),
		}));
	};

	const addRule = (): void => {
		setConfig((prev) => {
			const used = new Set(prev.changeRules.map((rule) => rule.windowMinutes));
			const next =
				CHANGE_WINDOW_OPTIONS.find((option) => !used.has(option.value)) ??
				CHANGE_WINDOW_OPTIONS[0];
			if (!next) return prev;
			return {
				...prev,
				changeRules: [
					...prev.changeRules,
					{ windowMinutes: next.value, thresholdPct: 0.5 },
				],
			};
		});
	};

	const removeRule = (index: number): void => {
		setConfig((prev) => ({
			...prev,
			changeRules: prev.changeRules.filter(
				(_, ruleIndex) => ruleIndex !== index,
			),
		}));
	};

	const toggleRange = (range: StockAlertRange, checked: boolean): void => {
		setConfig((prev) => ({
			...prev,
			highLowRanges: checked
				? // Kept in the canonical order the API stores, so the dirty check does
					// not report a difference purely from click order.
					STOCK_ALERT_RANGES.filter(
						(entry) => entry === range || prev.highLowRanges.includes(entry),
					)
				: prev.highLowRanges.filter((entry) => entry !== range),
		}));
	};

	const usedWindows = new Set(
		config.changeRules.map((rule) => rule.windowMinutes),
	);
	const canAddRule =
		config.changeRules.length < MAX_CHANGE_RULES &&
		usedWindows.size < CHANGE_WINDOW_OPTIONS.length;
	const needsChannel = config.enabled && !config.channelId;
	const selectedRangeCount = config.highLowRanges.length;

	if (loading) {
		return (
			<PageShell>
				<PageHeader title="Stocks" icon={TrendingUp} />
				<Skeleton className="h-10 w-full max-w-lg rounded-xl" />
				<Skeleton className="h-96 w-full rounded-xl" />
			</PageShell>
		);
	}

	if (loadError) {
		return (
			<PageShell>
				<PageHeader title="Stocks" icon={TrendingUp} />
				<EmptyState
					icon={TrendingUp}
					title="Stock alerts unavailable"
					description={loadError}
					action={
						<Button
							type="button"
							variant="outline"
							className="gap-2"
							onClick={() => void fetchConfig()}
						>
							<RotateCcw className="size-3.5" />
							Retry
						</Button>
					}
				/>
			</PageShell>
		);
	}

	return (
		<PageShell>
			<PageHeader
				title="Stocks"
				icon={TrendingUp}
				description="Torn stock market alerts: notable price moves plus highs and lows over the ranges you choose, posted to one Discord channel for the whole server."
				actions={
					<Button
						type="button"
						variant="outline"
						className="gap-2"
						onClick={() => void handleRunNow()}
						disabled={triggering}
					>
						{triggering ? (
							<Spinner className="size-3.5" />
						) : (
							<Play className="size-3.5" />
						)}
						Run check now
					</Button>
				}
			/>

			<SectionCard
				title="Server-wide settings"
				description="Both family factions share these settings, and every member's personal alerts are configured separately with /stock-alerts."
				action={
					<StatusBadge tone={isDirty ? "warning" : "success"} size="sm">
						{isDirty ? "Unsaved" : "Saved"}
					</StatusBadge>
				}
				flush
			>
				<div className="flex flex-col gap-6 px-4 py-4 sm:px-6">
					{/* ── Enable ─────────────────────────────────────────────── */}
					<div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 sm:p-4">
						<div className="min-w-0 space-y-0.5">
							<div className="text-sm font-medium">Stock alerts</div>
							<div className="text-xs text-muted-foreground">
								Post alerts for this server into the channel selected below.
							</div>
						</div>
						<Switch
							checked={config.enabled}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({ ...prev, enabled: checked }))
							}
						/>
					</div>

					{/* ── Channel ────────────────────────────────────────────── */}
					<div className="flex flex-col gap-3">
						<div className="flex min-w-0 flex-col gap-1">
							<Label htmlFor="stock-alerts-channel">Alert channel</Label>
							<span className="text-xs text-muted-foreground">
								Where stock alerts for this server are posted.
							</span>
						</div>

						<div className="w-full min-w-0 sm:max-w-md">
							<ChannelSelect
								id="stock-alerts-channel"
								channels={channels}
								value={config.channelId}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										channelId: val === "none" ? null : val,
									}))
								}
								noneLabel="-- No Channel Selected --"
								placeholder="-- No Channel Selected --"
								contentClassName="rounded-xl border-border bg-popover text-popover-foreground"
							/>
						</div>

						{needsChannel ? (
							<p className="flex items-center gap-2 text-xs font-medium text-warning">
								<span className="size-2 shrink-0 rounded-full bg-warning" />
								Alerts are enabled but unrouted — pick a channel or nothing will
								be posted.
							</p>
						) : null}
					</div>

					{/* ── Notable moves ──────────────────────────────────────── */}
					<div className="flex flex-col gap-3 border-t border-border/60 pt-4">
						<div className="flex flex-col gap-1">
							<span className="text-sm font-semibold tracking-tight">
								Notable price moves
							</span>
							<span className="text-xs text-muted-foreground">
								Alert when a price moves at least this much within the window.
								Each window can be used once; mixes like 0.5% in 30 minutes and
								10% in a week are allowed.
							</span>
						</div>

						{config.changeRules.length === 0 ? (
							<p className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
								No move rules configured — only high/low alerts will be sent.
							</p>
						) : null}

						<div className="flex flex-col gap-3">
							{config.changeRules.map((rule, index) => (
								<div
									key={`${rule.windowMinutes}-${index}`}
									className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-end sm:gap-3 sm:p-4"
								>
									<div className="flex min-w-0 flex-1 flex-col gap-2">
										<Label htmlFor={`rule-window-${index}`}>Window</Label>
										<Select
											value={String(rule.windowMinutes)}
											onValueChange={(val) =>
												updateRule(index, { windowMinutes: Number(val) })
											}
										>
											<SelectTrigger
												id={`rule-window-${index}`}
												className="w-full"
											>
												<SelectValue placeholder="Select a window" />
											</SelectTrigger>
											<SelectContent>
												{CHANGE_WINDOW_OPTIONS.map((option) => (
													<SelectItem
														key={option.value}
														value={String(option.value)}
														disabled={
															option.value !== rule.windowMinutes &&
															usedWindows.has(option.value)
														}
													>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									<div className="flex min-w-0 flex-1 flex-col gap-2">
										<Label htmlFor={`rule-threshold-${index}`}>
											Move threshold (%)
										</Label>
										<Input
											id={`rule-threshold-${index}`}
											type="number"
											min={0.05}
											max={500}
											step={0.05}
											value={rule.thresholdPct}
											onChange={(e) =>
												updateRule(index, {
													thresholdPct: Number(e.target.value),
												})
											}
										/>
									</div>

									<Button
										type="button"
										variant="outline"
										size="icon"
										aria-label={`Remove the ${formatStockAlertWindow(rule.windowMinutes)} rule`}
										title="Remove rule"
										disabled={saving}
										onClick={() => removeRule(index)}
										className="shrink-0 self-start sm:self-end"
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							))}
						</div>

						<Button
							type="button"
							variant="outline"
							className="w-full gap-2 sm:w-fit"
							disabled={!canAddRule}
							onClick={addRule}
						>
							<Plus className="size-3.5 shrink-0" />
							Add rule
						</Button>
					</div>

					{/* ── Highs & lows ───────────────────────────────────────── */}
					<div className="flex flex-col gap-3 border-t border-border/60 pt-4">
						<div className="flex flex-col gap-1">
							<span className="text-sm font-semibold tracking-tight">
								Highs &amp; lows
							</span>
							<span className="text-xs text-muted-foreground">
								Pick any combination of ranges. Alerts are only raised on a{" "}
								<em>new</em> high or low within a range, so a price sitting at
								its peak does not repeat.
							</span>
						</div>

						<div className="grid gap-2 sm:grid-cols-2">
							{STOCK_ALERT_RANGES.map((range) => (
								<Label
									key={range}
									htmlFor={`stock-alert-range-${range}`}
									className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-muted/20 p-3"
								>
									<Checkbox
										id={`stock-alert-range-${range}`}
										checked={config.highLowRanges.includes(range)}
										onCheckedChange={(checked) =>
											toggleRange(range, checked === true)
										}
										className="mt-0.5"
									/>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="text-sm font-medium">
											{STOCK_ALERT_RANGE_LABELS[range]} high / low
										</span>
										<span className="text-xs font-normal text-muted-foreground">
											{RANGE_DESCRIPTIONS[range]}
										</span>
									</span>
								</Label>
							))}
						</div>

						{selectedRangeCount === 0 ? (
							<p className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
								No ranges selected — only the price-move rules above will alert.
							</p>
						) : null}
					</div>

					{/* ── Cooldown ───────────────────────────────────────────── */}
					<div className="flex flex-col gap-3 border-t border-border/60 pt-4">
						<div className="flex min-w-0 flex-col gap-1">
							<Label htmlFor="stock-alert-cooldown">Cooldown (minutes)</Label>
							<span className="text-xs text-muted-foreground">
								Minimum gap between two alerts of the same kind for the same
								stock. A suppressed alert still updates the stored baseline, so
								an ongoing move is reported once rather than repeatedly.
							</span>
						</div>
						<div className="w-full sm:max-w-40">
							<Input
								id="stock-alert-cooldown"
								type="number"
								min={0}
								max={1440}
								value={config.cooldownMinutes}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										cooldownMinutes: Number(e.target.value),
									}))
								}
							/>
						</div>
					</div>

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
							<span>
								{config.enabled && config.channelId
									? "Alerts active — checked every 5 minutes"
									: "All settings saved"}
							</span>
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

export default StocksPage;
