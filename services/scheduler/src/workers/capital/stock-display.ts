import { db, eq, tornStocks } from "@sentinel/database";

/**
 * Human-readable label for a Torn stock in an alert: `[ACRONYM] Name`.
 *
 * Falls back to the raw stock id when the catalogue row is missing so an alert
 * is never blocked by a lookup miss.
 */
export async function stockDisplayLabel(stockId: number): Promise<string> {
	const [stock] = await db
		.select({ name: tornStocks.name, acronym: tornStocks.acronym })
		.from(tornStocks)
		.where(eq(tornStocks.id, String(stockId)))
		.limit(1);

	const acronym = stock?.acronym.trim() ?? "";
	const name = stock?.name.trim() ?? "";
	if (acronym && name) return `[${acronym}] ${name}`;
	if (acronym) return `[${acronym}]`;
	if (name) return name;
	return `stock #${stockId}`;
}
