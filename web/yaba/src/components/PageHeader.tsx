import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

interface PageHeaderProps {
	title: React.ReactNode;
	description?: React.ReactNode;
	icon?: LucideIcon;
	badge?: React.ReactNode;
	/** Buttons / controls. They stack full width on phones. */
	actions?: React.ReactNode;
	className?: string;
}

/**
 * The one page title block used across the dashboard.
 *
 * Actions render on their own row under the title on phones (rather than being
 * squeezed next to it), and wrap instead of overflowing on tablets.
 */
export function PageHeader({
	title,
	description,
	icon: Icon,
	badge,
	actions,
	className,
}: PageHeaderProps) {
	return (
		<header
			data-slot="page-header"
			className={cn(
				"flex min-w-0 flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-start sm:justify-between sm:gap-6",
				className,
			)}
		>
			<div className="flex min-w-0 items-start gap-3">
				{Icon ? (
					<div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
						<Icon className="size-4" />
					</div>
				) : null}

				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<h1 className="min-w-0 text-lg font-semibold tracking-tight break-anywhere sm:text-xl">
							{title}
						</h1>
						{badge}
					</div>
					{description ? (
						<p className="max-w-2xl text-xs text-muted-foreground sm:text-sm">
							{description}
						</p>
					) : null}
				</div>
			</div>

			{actions ? (
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end [&>*]:min-w-0">
					{actions}
				</div>
			) : null}
		</header>
	);
}

export default PageHeader;
