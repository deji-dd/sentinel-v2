import type { CapitalPerformancePoint } from "@sentinel/schemas";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

import { isoDate } from "../lib/api";
import { EmptyState } from "./ui";

export function PerformanceChart({
	points,
	label = "NAV per unit",
}: {
	points: CapitalPerformancePoint[];
	label?: string;
}) {
	const data = points.map((point) => ({
		date: isoDate(point.capturedAtIso),
		nav: Number(point.navPerUnit),
	}));
	if (data.length < 2) {
		return (
			<EmptyState
				title="Not enough history yet"
				description="The chart appears after the first few daily snapshots."
			/>
		);
	}
	return (
		<div className="h-56 w-full">
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart data={data}>
					<defs>
						<linearGradient id="capitalNavFill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor="var(--primary)" stopOpacity={0.35} />
							<stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
						</linearGradient>
					</defs>
					<CartesianGrid
						stroke="var(--border)"
						strokeOpacity={0.4}
						vertical={false}
					/>
					<XAxis
						dataKey="date"
						stroke="var(--muted-foreground)"
						fontSize={11}
						tickLine={false}
						axisLine={false}
					/>
					<YAxis
						stroke="var(--muted-foreground)"
						fontSize={11}
						tickLine={false}
						axisLine={false}
						width={52}
					/>
					<Tooltip
						contentStyle={{
							background: "var(--card)",
							border: "1px solid var(--border)",
							borderRadius: 8,
							fontSize: 12,
						}}
					/>
					<Area
						type="monotone"
						dataKey="nav"
						name={label}
						stroke="var(--primary)"
						fill="url(#capitalNavFill)"
						strokeWidth={2}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}
