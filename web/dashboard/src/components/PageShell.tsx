import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Standard page container: consistent max width, vertical rhythm and bottom
 * breathing room. Every page in the dashboard renders through this so spacing
 * never drifts between routes.
 */
export function PageShell({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="page-shell"
			className={cn(
				"mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 pb-16 sm:gap-8",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

/** A titled block of page content with consistent internal spacing. */
export function PageSection({
	className,
	children,
	...props
}: React.ComponentProps<"section">) {
	return (
		<section
			data-slot="page-section"
			className={cn("flex min-w-0 flex-col gap-4", className)}
			{...props}
		>
			{children}
		</section>
	);
}

export default PageShell;
