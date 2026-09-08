import { and, eq, or, sql } from "drizzle-orm";
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
 * Net Available = max(0, Total Deposited - Total Accepted Requests) for items,
 * and Net Available = Total Deposited - Total Spent for Currency.
 */
export async function getArmoryStock(
	guildId: string,
	isTest: boolean,
): Promise<Map<string, ItemStock>> {
	// 1. Total deposited / stocked
	const depositRows = await db
		.select({
			itemId: elimsArmoryDeposits.itemId,
			itemName: elimsArmoryDeposits.itemName,
			category: elimsArmoryDeposits.itemCategory,
			totalDeposited: sql<number>`COALESCE(SUM(${elimsArmoryDeposits.quantity}), 0)::bigint`,
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

	// 2. Total consumed by accepted item requests
	const consumedRows = await db
		.select({
			itemId: elimsItemRequests.itemId,
			itemName: elimsItemRequests.itemName,
			totalConsumed: sql<number>`COALESCE(SUM(${elimsItemRequests.quantity}), 0)::bigint`,
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

	// 3. Total cash spent on armory purchases
	const spentRows = await db
		.select({
			itemId: elimsArmoryDeposits.itemId,
			itemName: elimsArmoryDeposits.itemName,
			totalSpent: sql<number>`COALESCE(SUM(${elimsArmoryDeposits.quantity}), 0)::bigint`,
		})
		.from(elimsArmoryDeposits)
		.where(
			and(
				eq(elimsArmoryDeposits.guildId, guildId),
				eq(elimsArmoryDeposits.isTest, isTest),
				or(
					eq(elimsArmoryDeposits.status, "spent"),
					eq(elimsArmoryDeposits.status, "consumed"),
				),
			),
		)
		.groupBy(elimsArmoryDeposits.itemId, elimsArmoryDeposits.itemName);

	const stockMap = new Map<string, ItemStock>();

	for (const row of depositRows) {
		const key = row.itemId || row.itemName.trim().toLowerCase();
		const deposited = Number(row.totalDeposited);
		stockMap.set(key, {
			itemId: row.itemId,
			itemName: row.itemName.trim(),
			category: row.category,
			deposited,
			consumed: 0,
			available: deposited,
		});
	}

	for (const row of consumedRows) {
		const key = row.itemId || row.itemName.trim().toLowerCase();
		const consumed = Number(row.totalConsumed);
		const existing = stockMap.get(key);
		if (existing) {
			existing.consumed += consumed;
			existing.available = Math.max(0, existing.deposited - existing.consumed);
		} else {
			stockMap.set(key, {
				itemId: row.itemId,
				itemName: row.itemName.trim(),
				deposited: 0,
				consumed,
				available: 0,
			});
		}
	}

	for (const row of spentRows) {
		const key = row.itemId || row.itemName.trim().toLowerCase();
		const spent = Number(row.totalSpent);
		const existing = stockMap.get(key);
		if (existing) {
			existing.consumed += spent;
			existing.available =
				key === "money"
					? existing.deposited - existing.consumed
					: Math.max(0, existing.deposited - existing.consumed);
		} else {
			stockMap.set(key, {
				itemId: row.itemId,
				itemName: row.itemName.trim(),
				category: "Currency",
				deposited: 0,
				consumed: spent,
				available: key === "money" ? -spent : 0,
			});
		}
	}

	return stockMap;
}
