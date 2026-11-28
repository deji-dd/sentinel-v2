import { BookOpen } from "lucide-react";
import { useEffect, useState } from "react";

import { FetchError } from "@/components/FetchError";
import { PageHeader } from "@/components/PageHeader";
import { PageLoader } from "@/components/PageLoader";
import { SectionCard } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { describeError } from "@/lib/format";
import type { MethodologyResponse } from "@/lib/types";

export function MethodologyPage() {
	const [methodology, setMethodology] = useState<MethodologyResponse | null>(
		null,
	);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void api.v2.yaba.methodology
			.get()
			.then((res) => {
				if (!active) return;
				if (res.error) {
					setError(describeError(res.error) ?? "Unable to load methodology.");
				} else if (res.data && "formula" in res.data) {
					setMethodology(res.data);
				}
				setLoading(false);
			})
			.catch((cause: unknown) => {
				if (!active) return;
				setError(describeError(cause) ?? "Unable to load methodology.");
				setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<>
			<PageHeader
				title="Methodology"
				description="How the YABA percentile scores are calculated."
				icon={BookOpen}
			/>

			{error ? <FetchError message={error} /> : null}
			{loading ? (
				<PageLoader variant="inline" label="Loading methodology..." />
			) : null}

			{methodology && "formula" in methodology ? (
				<>
					<SectionCard title="Scoring formula">
						<p className="text-sm leading-relaxed text-foreground">
							{methodology.formula}
						</p>
					</SectionCard>

					<SectionCard title="Faction aggregation">
						<p className="text-sm leading-relaxed text-foreground">
							{methodology.factionAggregation}
						</p>
					</SectionCard>

					<SectionCard
						title="Metrics"
						description="Labels used across the leaderboards and the ranking builder."
					>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
							{Object.entries(methodology.metrics).map(([key, label]) => (
								<div
									key={key}
									className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
								>
									<span className="min-w-0 truncate text-xs text-foreground">
										{label}
									</span>
									<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
										{key}
									</span>
								</div>
							))}
						</div>
					</SectionCard>

					<SectionCard title="Windows">
						<div className="flex flex-wrap gap-2">
							{methodology.windows.map((window) => (
								<StatusBadge key={window} tone="info">
									{window}
								</StatusBadge>
							))}
						</div>
					</SectionCard>

					<SectionCard title="Notes">
						<ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
							{methodology.notes.map((note) => (
								<li key={note} className="min-w-0 break-anywhere">
									{note}
								</li>
							))}
						</ul>
					</SectionCard>
				</>
			) : null}
		</>
	);
}
