import type * as React from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Label for the confirming button. */
	confirmLabel?: string;
	cancelLabel?: string;
	/** `destructive` paints the confirm button red. */
	tone?: "default" | "destructive";
	onConfirm: () => void;
	children?: React.ReactNode;
}

/**
 * Standard confirmation prompt.
 *
 * Buttons stack full-width on phones so the destructive action is never a
 * cramped tap target next to Cancel.
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	tone = "destructive",
	onConfirm,
	children,
}: ConfirmDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="max-h-[85dvh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto p-5 sm:p-6">
				<AlertDialogHeader>
					<AlertDialogTitle className="text-base sm:text-lg">
						{title}
					</AlertDialogTitle>
					{description ? (
						<AlertDialogDescription className="text-xs sm:text-sm">
							{description}
						</AlertDialogDescription>
					) : null}
				</AlertDialogHeader>

				{children}

				<AlertDialogFooter className="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<AlertDialogCancel className="h-10 w-full sm:h-8 sm:w-auto">
						{cancelLabel}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						className={cn(
							"h-10 w-full sm:h-8 sm:w-auto",
							tone === "default" &&
								"bg-primary text-primary-foreground hover:bg-primary/90",
						)}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export default ConfirmDialog;
