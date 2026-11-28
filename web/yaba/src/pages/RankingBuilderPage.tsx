import { SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { FetchError } from "@/components/FetchError";
import { PageHeader } from "@/components/PageHeader";
import { PageLoader } from "@/components/PageLoader";
import { RankingTable } from "@/components/RankingTable";
import { SectionCard } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WindowTabs } from "@/components/WindowTabs";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { describeError } from "@/lib/format";
import {
	DEFAULT_METRICS,
	type RankingsResponse,
	type RankingWindow,
	SECONDARY_METRICS,
} from "@/lib/types";

const FALLBACK_LABELS: Record<string, string> = {
	xanax: "Xanax taken",
	activity: "Hours active",
	hits: "Ranked war hits",
	revives: "Revives given",
	battle: "Battle score (FFScouter)",
	winRate: "Attack win rate",
	damagePerHit: "Damage per hit",
	critRate: "Critical hit rate",
	reviveSkill: "Revive skill",
};

export function RankingBuilderPage() {
	const { isAdmin } = useAuth();
	const [metrics, setMetrics] = useState<string[]>([...DEFAULT_METRICS.combat]);
	const [weights, setWeights] = useState<Record<string, string>>({});
	const [name, setName] = useState("Sheet default");
	const [window, setWindow] = useState<RankingWindow>("90d");
	const [metricLabels, setMetricLabels] =
		useState<Record<string, string>>(FALLBACK_LABELS);
	const [preview, setPreview] = useState<RankingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void api.v2.yaba.methodology
			.get()
			.then((res) => {
				if (!active || !res.data || !("metrics" in res.data)) return;
				setMetricLabels(res.data.metrics);
			})
			.catch(() => {
				// Fall back to the built-in labels.
			});

		if (isAdmin) {
			void api.v2.yaba.admin.preset
				.get()
				.then((res) => {
					if (!active || !res.data || !("preset" in res.data)) return;
					const preset = res.data.preset;
					if (!preset) return;
					if (Array.isArray(preset.metrics)) {
						setMetrics(
							preset.metrics.filter(
								(key): key is string => typeof key === "string",
							),
						);
					}
					if (typeof preset.name === "string") setName(preset.name);
					const nextWeights: Record<string, string> = {};
					const rawWeights: unknown = preset.weights;
					if (typeof rawWeights === "object" && rawWeights !== null) {
						for (const [key, value] of Object.entries(rawWeights)) {
							if (typeof value === "number") nextWeights[key] = String(value);
						}
					}
					setWeights(nextWeights);
				})
				.catch(() => {
					// The default preset stays in place if the lookup fails.
				});
		}
		return () => {
			active = false;
		};
	}, [isAdmin]);

	useEffect(() => {
		let active = true;
		setLoading(true);
		void api.v2.yaba.rankings
			.get({ query: { scope: "faction", type: "combat", window } })
			.then((res) => {
				if (!active) return;
				if (res.error) {
					setError(describeError(res.error) ?? "Unable to load preview.");
					setPreview(null);
				} else {
					setPreview(res.data);
					setError(null);
				}
				setLoading(false);
			})
			.catch((cause: unknown) => {
				if (!active) return;
				setError(describeError(cause) ?? "Unable to load preview.");
				setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [window]);

	const catalog = useMemo(() => {
		const keys = Object.keys(metricLabels);
		for (const key of [...DEFAULT_METRICS.combat, ...SECONDARY_METRICS]) {
			if (!keys.includes(key)) keys.push(key);
		}
		return keys;
	}, [metricLabels]);

	const primaryMetrics = catalog.filter(
		(key) => !SECONDARY_METRICS.some((secondary) => secondary === key),
	);
	const secondaryMetrics = catalog.filter((key) =>
		SECONDARY_METRICS.some((secondary) => secondary === key),
	);

	function toggleMetric(key: string, checked: boolean) {
		setMetrics((current) =>
			checked ? [...current, key] : current.filter((metric) => metric !== key),
		);
	}

	async function savePreset() {
		if (metrics.length === 0) {
			setError("Select at least one metric.");
			return;
		}
		const numericWeights: Record<string, number> = {};
		for (const key of metrics) {
			const parsed = Number(weights[key] ?? "1");
			if (!Number.isFinite(parsed) || parsed <= 0) {
				setError(`Enter a positive weight for ${metricLabels[key] ?? key}.`);
				return;
			}
			numericWeights[key] = parsed;
		}

		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const res = await api.v2.yaba.admin.preset.put({
				name: name.trim() || "Custom",
				metrics,
				weights: numericWeights,
			});
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to save preset.");
				return;
			}
			const recompute = await api.v2.yaba.admin.rankings.recompute.post();
			if (recompute.error) {
				setError(
					describeError(recompute.error) ?? "Unable to recompute rankings.",
				);
				return;
			}
			setNotice("Preset saved. Rankings are being recomputed.");
		} catch (cause: unknown) {
			setError(describeError(cause) ?? "Unable to save preset.");
		} finally {
			setSaving(false);
		}
	}

	const previewRows =
		preview && "rows" in preview ? (preview.rows ?? []).slice(0, 20) : [];

	return (
		<>
			<PageHeader
				title="Ranking builder"
				description="Choose the metrics and weights used by the report, then preview the public ranking snapshot."
				icon={SlidersHorizontal}
				badge={
					<StatusBadge tone={isAdmin ? "primary" : "neutral"}>
						{isAdmin ? "Admin controls" : "Preview only"}
					</StatusBadge>
				}
			/>

			{error ? <FetchError message={error} /> : null}
			{notice ? <StatusBadge tone="success">{notice}</StatusBadge> : null}

			<SectionCard
				title="Metric selection"
				description="The sheet default uses Xanax, activity, hits or revives, and battle score."
			>
				<div className="flex flex-col gap-6">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{[...primaryMetrics, ...secondaryMetrics].map((key) => (
							<div
								key={key}
								className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
							>
								<Checkbox
									id={`metric-${key}`}
									checked={metrics.includes(key)}
									onCheckedChange={(checked) =>
										toggleMetric(key, checked === true)
									}
								/>
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<Label
										htmlFor={`metric-${key}`}
										className="min-w-0 truncate text-xs"
									>
										{metricLabels[key] ?? key}
									</Label>
									{secondaryMetrics.includes(key) ? (
										<span className="text-[10px] text-muted-foreground uppercase">
											Secondary
										</span>
									) : null}
								</div>
								<Input
									type="number"
									min={0}
									step="0.1"
									aria-label={`Weight for ${metricLabels[key] ?? key}`}
									className="h-9 w-16 shrink-0 text-right"
									value={weights[key] ?? "1"}
									onChange={(event) =>
										setWeights((current) => ({
											...current,
											[key]: event.target.value,
										}))
									}
								/>
							</div>
						))}
					</div>

					{isAdmin ? (
						<div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-end">
							<div className="flex w-full flex-col gap-1.5 sm:max-w-64">
								<Label htmlFor="preset-name">Preset name</Label>
								<Input
									id="preset-name"
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
							</div>
							<Button
								type="button"
								onClick={() => void savePreset()}
								disabled={saving}
							>
								{saving ? "Saving..." : "Save preset & recompute"}
							</Button>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setMetrics([...DEFAULT_METRICS.combat]);
									setWeights({});
									setName("Sheet default");
									setNotice(null);
								}}
							>
								Reset
							</Button>
						</div>
					) : null}
				</div>
			</SectionCard>

			<SectionCard
				title="Preview"
				description="Latest published snapshot. Saved presets take effect after recomputation."
				flush
			>
				<div className="flex flex-col gap-4 p-4 sm:p-6">
					<WindowTabs value={window} onChange={setWindow} />
					{loading ? (
						<PageLoader variant="inline" label="Loading preview..." />
					) : (
						<RankingTable
							rows={previewRows}
							metricKeys={metrics.slice(0, 12)}
							metricLabels={metricLabels}
						/>
					)}
				</div>
			</SectionCard>
		</>
	);
}
