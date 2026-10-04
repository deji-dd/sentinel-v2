import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";

type StatTone =
	| "neutral"
	| "primary"
	| "success"
	| "warning"
	| "danger"
	| "info";

interface StatCardProps {
	label: React.ReactNode;
	value: React.ReactNode;
	icon?: LucideIcon;
	hint?: React.ReactNode;
	tone?: StatTone;
	className?: React.ComponentProps<typeof Card>["className"];
}

const toneStyles: Record<StatTone, string> = {
	neutral: "text-muted-foreground",
	primary: "text-primary",
	success: "text-success",
	warning: "text-warning",
	danger: "text-destructive",
	info: "text-info",
};

/** Compact metric tile — wraps its value instead of clipping it. */
export function StatCard({
	label,
	value,
	icon: Icon,
	hint,
	tone = "neutral",
	className,
}: StatCardProps) {
	return (
		<Card
			data-slot="stat-card"
			className={cn(
				"gap-0 rounded-xl border-border/80 bg-card/90 py-0 shadow-sm",
				className,
			)}
		>
			<CardContent className="flex flex-col gap-1.5 px-4 py-4">
				<div className="flex items-center justify-between gap-3">
					<span className="min-w-0 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
						{label}
					</span>
					{Icon ? (
						<Icon className={cn("size-4 shrink-0", toneStyles[tone])} />
					) : null}
				</div>
				<div className="text-xl font-semibold tracking-tight break-anywhere tabular-nums sm:text-2xl">
					{value}
				</div>
				{hint ? (
					<div className="text-[11px] text-muted-foreground">{hint}</div>
				) : null}
			</CardContent>
		</Card>
	);
}

/** Responsive grid for `StatCard`s: 1 → 2 → 4 columns. */
export function StatGrid({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

export { StatusBadge };
export default StatCard;
