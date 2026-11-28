import { Loader2 } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface PageLoaderProps {
	/** Status line under the app name, e.g. "Loading Server Config...". */
	label?: string;
	/** `inline` fills its parent box instead of the viewport. */
	variant?: "viewport" | "inline";
	className?: string;
}

/**
 * The single loading state for the dashboard. Previously each page (and the
 * router, and the shell) carried its own near-identical full-screen spinner
 * with `h-screen w-screen`, which is wrong on mobile browsers because
 * `100vh` includes the collapsing URL bar.
 */
export function PageLoader({
	label = "Loading...",
	variant = "viewport",
	className,
}: PageLoaderProps) {
	return (
		<div
			data-slot="page-loader"
			role="status"
			aria-live="polite"
			className={cn(
				"flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground",
				variant === "viewport"
					? "min-h-dvh w-full px-6"
					: "min-h-40 w-full py-10",
				className,
			)}
		>
			<Spinner className="size-6 text-primary" />
			<div className="flex items-center gap-2 font-mono text-xs">
				<span className="font-bold tracking-widest text-foreground uppercase">
					Sentinel
				</span>
				<span className="tracking-wider text-muted-foreground uppercase">
					• {label}
				</span>
			</div>
		</div>
	);
}

/** Small inline spinner + label for cards, tables and buttons. */
export function InlineLoader({
	label = "Loading...",
	className,
}: {
	label?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-center gap-2 text-xs text-muted-foreground",
				className,
			)}
		>
			<Loader2 className="size-3.5 animate-spin text-primary" />
			<span>{label}</span>
		</div>
	);
}

export default PageLoader;
