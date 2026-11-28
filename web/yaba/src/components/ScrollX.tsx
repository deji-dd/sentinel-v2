import { ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Horizontal scroll container for content that genuinely cannot wrap
 * (wide tables, chip rows, segmented controls).
 *
 * Adds edge fade hints so it is obvious on touch devices that the content
 * continues past the viewport, plus touch-friendly momentum scrolling.
 */
export function ScrollX({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="scroll-x"
			className={cn(
				"scroll-x relative w-full min-w-0 rounded-[inherit]",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

/**
 * Segmented control that scrolls horizontally on narrow screens instead of
 * wrapping into a ragged multi-row block (the pattern used for tab strips).
 */
export function ScrollableTabs({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="scrollable-tabs"
			className={cn(
				"scroll-x -mx-1 flex w-full items-center gap-1 px-1 pb-1",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

interface PaginationProps {
	page: number;
	pageCount: number;
	onPageChange: (page: number) => void;
	/** Rendered to the left of the controls on wider screens. */
	label?: React.ReactNode;
	className?: string;
}

/** Compact, thumb-friendly pagination used under tables and log lists. */
export function Pagination({
	page,
	pageCount,
	onPageChange,
	label,
	className,
}: PaginationProps) {
	if (pageCount <= 1) return null;

	return (
		<div
			data-slot="pagination"
			className={cn(
				"flex flex-col gap-2 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6",
				className,
			)}
		>
			{label ? (
				<div className="text-[11px] text-muted-foreground sm:text-xs">
					{label}
				</div>
			) : (
				<div />
			)}

			<div className="flex items-center justify-between gap-2 sm:justify-end">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={page <= 1}
					onClick={() => onPageChange(page - 1)}
					className="gap-1.5"
				>
					<ChevronLeft className="size-3.5" />
					Prev
				</Button>

				<span className="px-1 text-[11px] font-mono tabular-nums text-muted-foreground sm:text-xs">
					{page} / {pageCount}
				</span>

				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={page >= pageCount}
					onClick={() => onPageChange(page + 1)}
					className="gap-1.5"
				>
					Next
					<ChevronRight className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}

export default ScrollX;
