import { and, eq, sql } from "drizzle-orm";
import { db } from "../../index";
import {
	elimsArmoryDeposits,
	elimsItemRequests,
} from "../schema/elims-requests";

export interface ItemStock {
	itemId: string;
	itemName: string;
	category?: string;
	deposited: number;
	consumed: number;
	available: number;
}

/**
 * Calculates current stock for all items in a guild for either Live or Test mode.
 * Net Available = max(0, Total Deposited - Total Accepted Requests).
 */
export async function getArmoryStock(
	guildId: string,
	isTest: boolean,
): Promise<Map<string, ItemStock>> {
	// 1. Total deposited
	const depositRows = await db
		.select({
			itemId: elimsArmoryDeposits.itemId,
			itemName: elimsArmoryDeposits.itemName,
			category: elimsArmoryDeposits.itemCategory,
			totalDeposited: sql<number>`COALESCE(SUM(${elimsArmoryDeposits.quantity}), 0)::int`,
		})
		.from(elimsArmoryDeposits)
		.where(
			and(
				eq(elimsArmoryDeposits.guildId, guildId),
				eq(elimsArmoryDeposits.isTest, isTest),
				eq(elimsArmoryDeposits.status, "available"),
			),
		)
		.groupBy(
			elimsArmoryDeposits.itemId,
			elimsArmoryDeposits.itemName,
			elimsArmoryDeposits.itemCategory,
		);

	// 2. Total consumed by accepted requests
	const consumedRows = await db
		.select({
			itemId: elimsItemRequests.itemId,
			itemName: elimsItemRequests.itemName,
			totalConsumed: sql<number>`COALESCE(SUM(${elimsItemRequests.quantity}), 0)::int`,
		})
		.from(elimsItemRequests)
		.where(
			and(
				eq(elimsItemRequests.guildId, guildId),
				eq(elimsItemRequests.isTest, isTest),
				eq(elimsItemRequests.status, "accepted"),
			),
		)
		.groupBy(elimsItemRequests.itemId, elimsItemRequests.itemName);

	const stockMap = new Map<string, ItemStock>();

	for (const row of depositRows) {
		const key = row.itemId || row.itemName.trim().toLowerCase();
		stockMap.set(key, {
			itemId: row.itemId,
			itemName: row.itemName.trim(),
			category: row.category,
			deposited: row.totalDeposited,
			consumed: 0,
			available: row.totalDeposited,
		});
	}

	for (const row of consumedRows) {
		const key = row.itemId || row.itemName.trim().toLowerCase();
		const existing = stockMap.get(key);
		if (existing) {
			existing.consumed = row.totalConsumed;
			existing.available = Math.max(0, existing.deposited - row.totalConsumed);
		} else {
			stockMap.set(key, {
				itemId: row.itemId,
				itemName: row.itemName.trim(),
				deposited: 0,
				consumed: row.totalConsumed,
				available: 0,
			});
		}
	}

	return stockMap;
}
