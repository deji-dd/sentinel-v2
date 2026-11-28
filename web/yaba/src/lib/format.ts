/** Formatting helpers shared by the report tables and status cards. */
export function formatNumber(
	value: number | null | undefined,
	digits = 0,
): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "--";
	return value.toLocaleString(undefined, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
}

export function formatScore(value: number | null | undefined): string {
	return formatNumber(value, 1);
}

export function formatCoverage(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "--";
	return `${Math.round(value * 100)}%`;
}

export function formatDateTime(value: string | null | undefined): string {
	if (!value) return "--";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "--";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Read a human message out of the unknown error shapes Eden can return. */
export function describeError(error: unknown): string | null {
	if (error === null || error === undefined) return null;
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && "value" in error) {
		const value = (error as { value?: unknown }).value;
		if (typeof value === "object" && value !== null && "error" in value) {
			const message = (value as { error?: unknown }).error;
			if (typeof message === "string") return message;
		}
	}
	return "The request failed. Please try again.";
}
