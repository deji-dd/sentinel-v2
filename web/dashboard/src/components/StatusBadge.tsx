import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Semantic status colours.
 *
 * The tones map onto the `--success` / `--warning` / `--info` design tokens so
 * a status looks right in both the dark and light palettes, instead of the
 * hardcoded `text-amber-400 bg-amber-500/10` pairs the pages used to inline
 * (which were unreadable in light mode).
 */
const statusBadgeVariants = cva(
	"inline-flex w-fit max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-3",
	{
		variants: {
			tone: {
				neutral: "border-border bg-muted/60 text-muted-foreground",
				primary: "border-primary/30 bg-primary/10 text-primary",
				success: "border-success/30 bg-success/10 text-success",
				warning: "border-warning/30 bg-warning/10 text-warning",
				danger: "border-destructive/30 bg-destructive/10 text-destructive",
				info: "border-info/30 bg-info/10 text-info",
			},
			size: {
				default: "px-2 py-0.5 text-[11px]",
				sm: "px-1.5 py-0 text-[10px]",
				lg: "px-2.5 py-1 text-xs",
			},
		},
		defaultVariants: {
			tone: "neutral",
			size: "default",
		},
	},
);

interface StatusBadgeProps
	extends React.ComponentProps<"span">,
		VariantProps<typeof statusBadgeVariants> {
	/** Leading dot, e.g. for live/offline indicators. */
	dot?: boolean;
	/** Pulsing dot — pair with `tone="success"` for "live". */
	pulse?: boolean;
	icon?: React.ComponentType<{ className?: string }>;
}

export function StatusBadge({
	className,
	tone,
	size,
	dot = false,
	pulse = false,
	icon: Icon,
	children,
	...props
}: StatusBadgeProps) {
	return (
		<span
			data-slot="status-badge"
			data-tone={tone ?? "neutral"}
			className={cn(statusBadgeVariants({ tone, size }), className)}
			{...props}
		>
			{dot ? (
				<span
					aria-hidden="true"
					className={cn(
						"size-1.5 shrink-0 rounded-full bg-current",
						pulse && "animate-pulse",
					)}
				/>
			) : null}
			{Icon ? <Icon className="size-3" /> : null}
			{children}
		</span>
	);
}

export { statusBadgeVariants };
export default StatusBadge;
