import { Progress as ProgressPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Progress({
	className,
	value,
	indicatorClassName,
	...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
	indicatorClassName?: string;
}) {
	return (
		<ProgressPrimitive.Root
			data-slot="progress"
			className={cn(
				"relative h-2 w-full overflow-hidden rounded-full bg-muted/60 border border-border/40",
				className,
			)}
			{...props}
		>
			<ProgressPrimitive.Indicator
				data-slot="progress-indicator"
				className={cn(
					"h-full w-full flex-1 bg-primary transition-all duration-500 ease-out",
					indicatorClassName,
				)}
				style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
			/>
		</ProgressPrimitive.Root>
	);
}

export { Progress };
