import type * as React from "react";

import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SectionCardProps
	extends Omit<React.ComponentProps<typeof Card>, "title"> {
	title?: React.ReactNode;
	description?: React.ReactNode;
	/** Right-aligned control in the header (button, switch, badge...). */
	action?: React.ReactNode;
	/** Icon shown next to the title. */
	icon?: React.ComponentType<{ className?: string }>;
	/** Removes the inner padding — for tables that need edge-to-edge rows. */
	flush?: boolean;
}

/**
 * A titled card with the dashboard's standard padding scale.
 *
 * Padding tightens on phones (`px-4`) and opens up from `sm` (`px-6`) so narrow
 * screens keep usable content width.
 */
export function SectionCard({
	title,
	description,
	action,
	icon: Icon,
	flush = false,
	className,
	children,
	...props
}: SectionCardProps) {
	const hasHeader = Boolean(title || description || action);

	return (
		<Card
			data-slot="section-card"
			className={cn(
				"gap-0 overflow-hidden rounded-xl border-border/80 bg-card/90 py-0 shadow-sm backdrop-blur-md",
				className,
			)}
			{...props}
		>
			{hasHeader ? (
				<CardHeader className="gap-1 border-b border-border/50 px-4 py-4 sm:px-6">
					<div className="flex min-w-0 items-start gap-2.5">
						{Icon ? (
							<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						) : null}
						<div className="flex min-w-0 flex-col gap-1">
							{title ? (
								<CardTitle className="text-sm font-semibold tracking-tight break-anywhere">
									{title}
								</CardTitle>
							) : null}
							{description ? (
								<CardDescription className="text-xs">
									{description}
								</CardDescription>
							) : null}
						</div>
					</div>
					{action ? <CardAction>{action}</CardAction> : null}
				</CardHeader>
			) : null}

			<CardContent className={cn(flush ? "p-0" : "px-4 py-4 sm:px-6")}>
				{children}
			</CardContent>
		</Card>
	);
}

/**
 * Footer used by settings-style cards: a status hint plus primary/secondary
 * actions that stack full-width on phones instead of colliding.
 */
export function SectionCardFooter({
	status,
	children,
	className,
}: {
	status?: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 border-t border-border/60 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6",
				className,
			)}
		>
			{status ? (
				<div className="min-w-0 text-xs text-muted-foreground">{status}</div>
			) : (
				<div />
			)}
			{children ? (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
					{children}
				</div>
			) : null}
		</div>
	);
}

export default SectionCard;
