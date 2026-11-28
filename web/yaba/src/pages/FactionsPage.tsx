import { Building2 } from "lucide-react";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/EmptyState";
import { FetchError } from "@/components/FetchError";
import { PageHeader } from "@/components/PageHeader";
import { PageLoader } from "@/components/PageLoader";
import { ScrollX } from "@/components/ScrollX";
import { SectionCard } from "@/components/SectionCard";
import { StatCard, StatGrid } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { describeError, formatDateTime, formatNumber } from "@/lib/format";
import type { FactionRow, StatusResponse } from "@/lib/types";

export function FactionsPage() {
	const [status, setStatus] = useState<StatusResponse | null>(null);
	const [factions, setFactions] = useState<FactionRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const load = async () => {
			const [statusRes, factionsRes] = await Promise.all([
				api.v2.yaba.status.get(),
				api.v2.yaba.factions.get(),
			]);
			if (!active) return;

			if (statusRes.error) {
				setError(
					describeError(statusRes.error) ?? "Unable to load collector status.",
				);
			} else if (statusRes.data && "lastRun" in statusRes.data) {
				setStatus(statusRes.data);
			}

			if (factionsRes.error) {
				setError(
					describeError(factionsRes.error) ?? "Unable to load factions.",
				);
			} else if (factionsRes.data && "factions" in factionsRes.data) {
				setFactions(factionsRes.data.factions);
			}
			setLoading(false);
		};

		void load().catch((cause: unknown) => {
			if (!active) return;
			setError(describeError(cause) ?? "Unable to load the report.");
			setLoading(false);
		});

		return () => {
			active = false;
		};
	}, []);

	const lastRun = status && "lastRun" in status ? status.lastRun : null;

	return (
		<>
			<PageHeader
				title="Tracked factions"
				description="Activity reports for the factions monitored by the YABA collector."
				icon={Building2}
				badge={
					<StatusBadge
						tone={lastRun?.status === "success" ? "success" : "neutral"}
					>
						{lastRun ? lastRun.status : "No collection yet"}
					</StatusBadge>
				}
			/>

			{error ? <FetchError message={error} /> : null}

			<StatGrid>
				<StatCard
					label="Last collection"
					value={formatDateTime(lastRun?.startedAt)}
					hint={lastRun?.kind ?? "--"}
				/>
				<StatCard
					label="Keys used"
					value={formatNumber(lastRun?.keyCount)}
					tone="info"
				/>
				<StatCard
					label="Factions"
					value={formatNumber(
						status && "factionCount" in status
							? status.factionCount
							: factions.length,
					)}
				/>
				<StatCard
					label="Members"
					value={formatNumber(
						status && "memberCount" in status ? status.memberCount : null,
					)}
				/>
			</StatGrid>

			<SectionCard
				title="Factions"
				description="Each row links to the member leaderboard for that faction."
				flush
			>
				{loading ? (
					<div className="p-4 sm:p-6">
						<PageLoader variant="inline" label="Loading factions..." />
					</div>
				) : factions.length === 0 ? (
					<div className="p-4 sm:p-6">
						<EmptyState
							title="No tracked factions"
							description="Factions appear here once an administrator adds them."
						/>
					</div>
				) : (
					<ScrollX>
						<Table className="min-w-[680px]">
							<TableHeader>
								<TableRow>
									<TableHead>Faction</TableHead>
									<TableHead>Tag</TableHead>
									<TableHead>Type</TableHead>
									<TableHead className="text-right">Members</TableHead>
									<TableHead>Leader ID</TableHead>
									<TableHead>Source</TableHead>
									<TableHead className="text-right">Report</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{factions.map((faction) => (
									<TableRow key={faction.factionId}>
										<TableCell className="min-w-0 max-w-[240px] truncate font-medium">
											{faction.name}
										</TableCell>
										<TableCell className="font-mono text-muted-foreground">
											{faction.tag ?? "--"}
										</TableCell>
										<TableCell>
											<StatusBadge
												tone={faction.type === "combat" ? "primary" : "info"}
											>
												{faction.type}
											</StatusBadge>
										</TableCell>
										<TableCell className="text-right font-mono tabular-nums">
											{formatNumber(faction.membersCount)}
										</TableCell>
										<TableCell className="font-mono text-muted-foreground">
											{faction.leaderId === null ? "--" : faction.leaderId}
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{faction.source}
										</TableCell>
										<TableCell className="text-right">
											<Button asChild variant="ghost" size="xs">
												<a href={`#/members?factionId=${faction.factionId}`}>
													Members
												</a>
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</ScrollX>
				)}
			</SectionCard>
		</>
	);
}
