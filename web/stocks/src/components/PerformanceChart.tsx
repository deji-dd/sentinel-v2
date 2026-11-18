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

function formatPointTime(
	value: string,
	granularity: "hourly" | "daily",
): string {
	if (granularity === "hourly") {
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return "—";
		return date.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		});
	}
	return isoDate(value);
}

/** Smallest allowed Y span, as a fraction of the value: ±1% around the middle. */
const MIN_SPAN_RATIO = 0.02;

/** NAV per unit is stored with four decimals; format ticks and tooltips to match. */
function formatNav(value: number | string): string {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed.toFixed(4) : "—";
}

/**
 * Hug the data instead of anchoring the Y axis at zero. NAV per unit sits near
 * 1.0 and daily moves are a fraction of a percent, so a zero baseline flattens
 * the chart into a straight line. The buffer keeps the line off the edges, and
 * the minimum span stops a nearly flat series from filling the chart with noise.
 */
function navDomain(
	points: CapitalPerformancePoint[],
): [number, number] | ["auto", "auto"] {
	const values = points
		.map((point) => Number(point.navPerUnit))
		.filter((value) => Number.isFinite(value));
	if (values.length === 0) return ["auto", "auto"];
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pad = (max - min) * 0.08 || Math.abs(max) * 0.001 || 1;
	const lower = min - pad;
	const upper = max + pad;
	const center = (min + max) / 2;
	const minSpan = Math.abs(center) * MIN_SPAN_RATIO;
	if (minSpan <= 0 || upper - lower >= minSpan) return [lower, upper];
	return [center - minSpan / 2, center + minSpan / 2];
}

export function PerformanceChart({
	points,
	label = "NAV per unit",
	granularity = "daily",
}: {
	points: CapitalPerformancePoint[];
	label?: string;
	granularity?: "hourly" | "daily";
}) {
	const data = points.map((point) => ({
		date: point.capturedAtIso,
		nav: Number(point.navPerUnit),
	}));
	const yDomain = navDomain(points);
	if (data.length < 2) {
		const desc =
			granularity === "hourly"
				? "The chart appears after the first few hourly snapshots."
				: "The chart appears after the first few daily snapshots.";
		return <EmptyState title="Not enough history yet" description={desc} />;
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
						tickFormatter={(value) => formatPointTime(value, granularity)}
					/>
					<YAxis
						stroke="var(--muted-foreground)"
						fontSize={11}
						tickLine={false}
						axisLine={false}
						width={56}
						domain={yDomain}
						tickFormatter={formatNav}
					/>
					<Tooltip
						labelFormatter={(value) =>
							formatPointTime(String(value), granularity)
						}
						formatter={(value) => formatNav(String(value))}
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
