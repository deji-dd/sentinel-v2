import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { describeError, formatDateTime } from "@/lib/format";
import {
	type FactionRow,
	type FactionType,
	type MethodologyResponse,
	type RankingsResponse,
	type RankingWindow,
} from "@/lib/types";

import { FetchError } from "./FetchError";
import { PageHeader } from "./PageHeader";
import { PageLoader } from "./PageLoader";
import { RankingTable } from "./RankingTable";
import { SectionCard } from "./SectionCard";
import { StatCard, StatGrid } from "./StatCard";
import { StatusBadge } from "./StatusBadge";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { WindowTabs } from "./WindowTabs";

interface RankingOverviewProps {
	scope: "faction" | "member";
	factionType: FactionType;
	title: string;
	description: string;
	icon: LucideIcon;
	limit: number;
	allowTypeSwitch?: boolean;
	initialFactionId?: number | null;
}

const FAILURE = "Unable to load rankings.";

export function RankingOverview({
	scope,
	factionType,
	title,
	description,
	icon,
	limit,
	allowTypeSwitch = false,
	initialFactionId = null,
}: RankingOverviewProps) {
	const { user } = useAuth();
	const [window, setWindow] = useState<RankingWindow>("90d");
	const [type, setType] = useState<FactionType>(factionType);
	const [rankings, setRankings] = useState<RankingsResponse | null>(null);
	const [methodology, setMethodology] = useState<MethodologyResponse | null>(
		null,
	);
	const [factions, setFactions] = useState<FactionRow[]>([]);
	const [factionFilter, setFactionFilter] = useState<number | null>(
		initialFactionId,
	);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);

		const load = async () => {
			const res = await api.v2.yaba.rankings.get({
				query: { scope, type, window },
			});
			if (!active) return;
			if (res.error) {
				setError(describeError(res.error) ?? FAILURE);
				setRankings(null);
			} else {
				setRankings(res.data);
			}
			setLoading(false);
		};

		void load().catch((cause: unknown) => {
			if (!active) return;
			setError(describeError(cause) ?? FAILURE);
			setLoading(false);
		});

		return () => {
			active = false;
		};
	}, [scope, type, window]);

	useEffect(() => {
		let active = true;
		void api.v2.yaba.methodology
			.get()
			.then((res) => {
				if (active && res.data && "metrics" in res.data) {
					setMethodology(res.data);
				}
			})
			.catch(() => {
				// Labels are optional — raw metric keys remain readable.
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (scope !== "member") return;
		let active = true;
		void api.v2.yaba.factions
			.get()
			.then((res) => {
				if (active && res.data && "factions" in res.data) {
					setFactions(res.data.factions);
				}
			})
			.catch(() => {
				// The filter simply stays on "all factions".
			});
		return () => {
			active = false;
		};
	}, [scope]);

	const metricLabels = useMemo<Record<string, string>>(() => {
		if (methodology && "metrics" in methodology) {
			return { ...methodology.metrics };
		}
		return {};
	}, [methodology]);

	const rows = useMemo(() => {
		if (!rankings || !("rows" in rankings)) return [];
		const all = rankings.rows ?? [];
		if (scope === "member" && factionFilter !== null) {
			return all.filter((row) => row.factionId === factionFilter);
		}
		return all;
	}, [rankings, scope, factionFilter]);

	const visibleRows = rows.slice(0, limit);

	const metricKeys = useMemo(() => {
		const seen = new Set<string>();
		for (const row of visibleRows) {
			for (const key of Object.keys(row.components ?? {})) seen.add(key);
		}
		const known = Object.keys(metricLabels).filter((key) => seen.has(key));
		const unknown = [...seen].filter((key) => !metricLabels[key]);
		return [...known, ...unknown].slice(0, 12);
	}, [visibleRows, metricLabels]);

	const factionNames = useMemo(() => {
		const names: Record<number, string> = {};
		for (const faction of factions) names[faction.factionId] = faction.name;
		return names;
	}, [factions]);

	const generatedAt =
		rankings && "generatedAt" in rankings ? rankings.generatedAt : null;
	const unrankedCount =
		rankings && "unrankedCount" in rankings ? rankings.unrankedCount : 0;

	return (
		<>
			<PageHeader
				title={title}
				description={description}
				icon={icon}
				badge={
					<StatusBadge
						tone={error ? "danger" : generatedAt ? "success" : "neutral"}
					>
						{error
							? "Unavailable"
							: generatedAt
								? "Snapshot ready"
								: "No snapshot"}
					</StatusBadge>
				}
			/>

			{error ? <FetchError message={error} /> : null}

			<StatGrid>
				<StatCard
					label="Ranked"
					value={rows.length}
					hint={`Top ${limit} shown`}
				/>
				<StatCard label="Unranked" value={unrankedCount} tone="warning" />
				<StatCard label="Window" value={window} tone="info" />
				<StatCard
					label="Generated"
					value={formatDateTime(generatedAt)}
					hint={
						rankings && "factionType" in rankings ? rankings.factionType : type
					}
				/>
			</StatGrid>

			<SectionCard
				title={scope === "member" ? "Top players" : "Top factions"}
				description="Percentile score from the selected metrics; coverage shows how many metrics had data."
				flush
			>
				<div className="flex flex-col gap-4 p-4 sm:p-6">
					<WindowTabs value={window} onChange={setWindow} />
					{scope === "member" ? (
						<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
							<div className="flex w-full flex-col gap-1.5 sm:max-w-64">
								<Label className="text-xs font-medium text-muted-foreground">
									Faction
								</Label>
								<Select
									value={factionFilter === null ? "all" : String(factionFilter)}
									onValueChange={(value) =>
										setFactionFilter(value === "all" ? null : Number(value))
									}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="All factions" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">All factions</SelectItem>
										{factions.map((faction) => (
											<SelectItem
												key={faction.factionId}
												value={String(faction.factionId)}
											>
												{faction.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{allowTypeSwitch ? (
								<div className="flex w-full flex-col gap-1.5 sm:max-w-48">
									<Label className="text-xs font-medium text-muted-foreground">
										Report type
									</Label>
									<Select
										value={type}
										onValueChange={(value) =>
											setType(value === "revive" ? "revive" : "combat")
										}
									>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="combat">Combat</SelectItem>
											<SelectItem value="revive">Revive</SelectItem>
										</SelectContent>
									</Select>
								</div>
							) : null}
						</div>
					) : null}

					{loading ? (
						<PageLoader variant="inline" label="Loading rankings..." />
					) : (
						<RankingTable
							rows={visibleRows}
							metricKeys={metricKeys}
							metricLabels={metricLabels}
							showFaction={scope === "member"}
							factionNames={factionNames}
						/>
					)}
				</div>
			</SectionCard>

			<p className="text-xs text-muted-foreground">
				Signed in as {user?.username ?? "a guest"}. Admin tools are only
				available to alliance administrators.
			</p>
		</>
	);
}
