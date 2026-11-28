import { Search, UserRoundSearch } from "lucide-react";
import { useState } from "react";

import { FetchError } from "@/components/FetchError";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { StatCard, StatGrid } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { describeError, formatNumber } from "@/lib/format";
import type { ProspectiveResponse } from "@/lib/types";

export function ProspectivePage() {
	const [factionId, setFactionId] = useState("");
	const [result, setResult] = useState<ProspectiveResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function reset() {
		setFactionId("");
		setResult(null);
		setError(null);
	}

	async function analyse() {
		const parsed = Number(factionId.trim());
		if (!Number.isInteger(parsed) || parsed <= 0) {
			setError("Enter a valid numeric faction ID.");
			return;
		}
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const res = await api.v2.yaba.prospective.get({
				query: { factionId: String(parsed) },
			});
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to analyse that faction.");
				return;
			}
			if (
				res.data &&
				"error" in res.data &&
				typeof res.data.error === "string"
			) {
				setError(res.data.error);
				return;
			}
			if (res.data && "faction" in res.data) setResult(res.data);
		} catch (cause: unknown) {
			setError(describeError(cause) ?? "Unable to analyse that faction.");
		} finally {
			setLoading(false);
		}
	}

	const faction = result && "faction" in result ? result.faction : null;
	const comparison =
		result && "comparison" in result ? result.comparison : null;

	return (
		<>
			<PageHeader
				title="Prospective faction"
				description="Look up a faction that is not tracked yet and compare its size with the tracked field."
				icon={UserRoundSearch}
			/>

			<SectionCard
				title="Faction lookup"
				description="Uses the alliance's Torn API key for the lookup."
			>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
					<div className="flex w-full flex-col gap-1.5 sm:max-w-64">
						<Label htmlFor="prospective-id">Faction ID</Label>
						<Input
							id="prospective-id"
							type="number"
							min={1}
							inputMode="numeric"
							placeholder="e.g. 12345"
							value={factionId}
							onChange={(event) => setFactionId(event.target.value)}
						/>
					</div>
					<Button
						type="button"
						onClick={() => void analyse()}
						disabled={loading}
					>
						<Search className="size-4 shrink-0" />
						{loading ? "Looking up..." : "Analyse"}
					</Button>
					<Button type="button" variant="outline" onClick={reset}>
						Clear / Reset
					</Button>
				</div>
			</SectionCard>

			{error ? <FetchError message={error} /> : null}

			{faction && comparison ? (
				<SectionCard
					title={faction.name}
					description={
						faction.tag ? `Tag: ${faction.tag}` : "No faction tag available."
					}
					action={<StatusBadge tone="info">Prospective</StatusBadge>}
				>
					<div className="flex flex-col gap-4">
						<StatGrid>
							<StatCard label="Members" value={formatNumber(faction.members)} />
							<StatCard label="Respect" value={formatNumber(faction.respect)} />
							<StatCard
								label="Age (days)"
								value={formatNumber(faction.daysOld)}
							/>
							<StatCard label="ID" value={faction.factionId} tone="info" />
						</StatGrid>
						<StatGrid>
							<StatCard
								label="Tracked factions"
								value={formatNumber(comparison.trackedFactionCount)}
							/>
							<StatCard
								label="Median score"
								value={formatNumber(comparison.medianScore, 1)}
								tone="primary"
							/>
						</StatGrid>
						<p className="text-xs text-muted-foreground">{comparison.note}</p>
					</div>
				</SectionCard>
			) : null}
		</>
	);
}
