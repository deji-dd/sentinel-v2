import { formatCoverage, formatNumber, formatScore } from "@/lib/format";
import type { RankingRow } from "@/lib/types";

import { EmptyState } from "./EmptyState";
import { ScrollX } from "./ScrollX";
import { StatusBadge } from "./StatusBadge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";

interface RankingTableProps {
	rows: RankingRow[];
	metricKeys: string[];
	metricLabels: Record<string, string>;
	showFaction?: boolean;
	factionNames?: Record<number, string>;
}

function coverageTone(coverage: number): "success" | "warning" | "danger" {
	if (coverage >= 0.75) return "success";
	if (coverage >= 0.4) return "warning";
	return "danger";
}

export function RankingTable({
	rows,
	metricKeys,
	metricLabels,
	showFaction = false,
	factionNames = {},
}: RankingTableProps) {
	if (rows.length === 0) {
		return (
			<EmptyState
				title="No rankings yet"
				description="A ranking snapshot has not been generated for these filters."
			/>
		);
	}

	return (
		<ScrollX>
			<Table className="min-w-[720px]">
				<TableHeader>
					<TableRow>
						<TableHead className="w-14">#</TableHead>
						<TableHead>Entity</TableHead>
						{showFaction ? <TableHead>Faction</TableHead> : null}
						<TableHead className="text-right">Score</TableHead>
						{metricKeys.map((key) => (
							<TableHead key={key} className="text-right whitespace-nowrap">
								{metricLabels[key] ?? key}
							</TableHead>
						))}
						<TableHead className="text-right">Coverage</TableHead>
						<TableHead className="text-right">Samples</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row, index) => (
						<TableRow key={`${row.id}-${index}`}>
							<TableCell className="font-mono tabular-nums text-muted-foreground">
								{row.rank || index + 1}
							</TableCell>
							<TableCell className="max-w-[220px] truncate font-medium">
								{row.name}
							</TableCell>
							{showFaction ? (
								<TableCell className="max-w-[180px] truncate text-muted-foreground">
									{row.factionId === null
										? "--"
										: (factionNames[row.factionId] ?? row.factionId)}
								</TableCell>
							) : null}
							<TableCell className="text-right font-mono font-semibold tabular-nums text-primary">
								{formatScore(row.score)}
							</TableCell>
							{metricKeys.map((key) => (
								<TableCell
									key={key}
									className="text-right font-mono tabular-nums text-muted-foreground"
								>
									{formatNumber(row.components[key] ?? null, 1)}
								</TableCell>
							))}
							<TableCell className="text-right">
								<StatusBadge tone={coverageTone(row.coverage)} size="sm">
									{formatCoverage(row.coverage)}
								</StatusBadge>
							</TableCell>
							<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
								{formatNumber(row.sampleSize)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</ScrollX>
	);
}
