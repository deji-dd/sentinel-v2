import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Format timestamp in hardcoded UTC with TCT (Torn City Time) suffix.
 * Example output: "2026-09-06 19:40:01 TCT"
 */
export function formatTctTimestamp(
	val?: string | Date | number | null,
): string {
	if (!val) return "--";
	const d = new Date(val);
	if (Number.isNaN(d.getTime())) return "--";
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const hours = String(d.getUTCHours()).padStart(2, "0");
	const minutes = String(d.getUTCMinutes()).padStart(2, "0");
	const seconds = String(d.getUTCSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} TCT`;
}
