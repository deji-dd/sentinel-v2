import type { ReactNode } from "react";
import { toast as sonnerToast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export type ToastType = "success" | "error" | "info" | "warning";

export function toast(message: string, type: ToastType = "info") {
	if (type === "success") {
		sonnerToast.success(message);
	} else if (type === "error") {
		sonnerToast.error(message);
	} else if (type === "warning") {
		sonnerToast.warning(message);
	} else {
		sonnerToast.info(message);
	}
}

export function ToastProvider({ children }: { children: ReactNode }) {
	return (
		<>
			{children}
			<Toaster position="bottom-right" closeButton />
		</>
	);
}

export function useToast() {
	return { toast };
}
