import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
	icon?: LucideIcon;
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Call-to-action rendered under the copy. */
	action?: React.ReactNode;
	className?: string;
}

/** Consistent "nothing here yet" block used by every list, table and picker. */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: EmptyStateProps) {
	return (
		<Empty
			className={cn("border-border/60 bg-muted/10 py-10 md:py-14", className)}
		>
			<EmptyHeader>
				{Icon ? (
					<EmptyMedia variant="icon">
						<Icon />
					</EmptyMedia>
				) : null}
				<EmptyTitle className="text-sm font-semibold sm:text-base">
					{title}
				</EmptyTitle>
				{description ? (
					<EmptyDescription className="text-xs sm:text-sm">
						{description}
					</EmptyDescription>
				) : null}
			</EmptyHeader>
			{action ? <EmptyContent>{action}</EmptyContent> : null}
		</Empty>
	);
}

export default EmptyState;
