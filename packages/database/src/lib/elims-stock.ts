import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../index";
import {
	elimsArmoryDeposits,
	elimsItemRequests,
	elimsStockHolders,
} from "../schema/elims-requests";

export interface ItemStock {
	itemId: string;
	itemName: string;
	category?: string;
	deposited: number;
	consumed: number;
	available: number;
	image?: string;
	marketPrice?: number;
}

export interface StockHolderAllocation {
	id: string;
	guildId: string;
	discordUserId: string;
	discordUsername: string;
	itemId: string;
	itemName: string;
	quantity: number;
	isTest: boolean;
	updatedAt: Date;
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

/**
 * Returns all active stock holders holding quantity > 0 in the guild.
 * Optionally filters by itemId.
 */
export async function getStockHolders(
	guildId: string,
	isTest: boolean,
	itemId?: string,
): Promise<StockHolderAllocation[]> {
	const conditions = [
		eq(elimsStockHolders.guildId, guildId),
		eq(elimsStockHolders.isTest, isTest),
		sql`${elimsStockHolders.quantity} > 0`,
	];

	if (itemId) {
		conditions.push(eq(elimsStockHolders.itemId, itemId));
	}

	const rows = await db
		.select()
		.from(elimsStockHolders)
		.where(and(...conditions));

	return rows.map((r) => ({
		id: r.id,
		guildId: r.guildId,
		discordUserId: r.discordUserId,
		discordUsername: r.discordUsername,
		itemId: r.itemId,
		itemName: r.itemName,
		quantity: r.quantity,
		isTest: r.isTest,
		updatedAt: r.updatedAt,
	}));
}

/**
 * Calculates unassigned armory stock for an item:
 * Unassigned = max(0, Total Available In Armory - Sum(Allocated to Holders))
 */
export async function getUnassignedStock(
	guildId: string,
	isTest: boolean,
	itemId: string,
	itemName?: string,
	preloadedStockMap?: Map<string, ItemStock>,
): Promise<{ availableTotal: number; allocated: number; unassigned: number }> {
	const stockMap = preloadedStockMap ?? (await getArmoryStock(guildId, isTest));
	const itemStock =
		stockMap.get(itemId) ??
		(itemName ? stockMap.get(itemName.trim().toLowerCase()) : undefined);

	const availableTotal = itemStock?.available ?? 0;

	const holders = await getStockHolders(guildId, isTest, itemId);
	const allocated = holders.reduce((acc, h) => acc + h.quantity, 0);
	const unassigned = Math.max(0, availableTotal - allocated);

	return { availableTotal, allocated, unassigned };
}

/**
 * Assigns stock to a holder.
 * Validates that unassigned stock is sufficient before assigning.
 */
export async function assignStockToHolder(params: {
	guildId: string;
	discordUserId: string;
	discordUsername: string;
	itemId: string;
	itemName: string;
	quantity: number;
	isTest: boolean;
}): Promise<{ success: boolean; error?: string; updatedQuantity?: number }> {
	if (params.quantity <= 0) {
		return { success: false, error: "Quantity must be greater than zero." };
	}

	const { unassigned } = await getUnassignedStock(
		params.guildId,
		params.isTest,
		params.itemId,
		params.itemName,
	);

	if (params.quantity > unassigned) {
		return {
			success: false,
			error: `Insufficient unassigned stock. Only ${unassigned.toLocaleString()} item(s) available to assign.`,
		};
	}

	const [existing] = await db
		.select()
		.from(elimsStockHolders)
		.where(
			and(
				eq(elimsStockHolders.guildId, params.guildId),
				eq(elimsStockHolders.discordUserId, params.discordUserId),
				eq(elimsStockHolders.itemId, params.itemId),
				eq(elimsStockHolders.isTest, params.isTest),
			),
		)
		.limit(1);

	let newQuantity = params.quantity;

	if (existing) {
		newQuantity = existing.quantity + params.quantity;
		await db
			.update(elimsStockHolders)
			.set({
				quantity: newQuantity,
				discordUsername: params.discordUsername,
				itemName: params.itemName,
				updatedAt: new Date(),
			})
			.where(eq(elimsStockHolders.id, existing.id));
	} else {
		await db.insert(elimsStockHolders).values({
			guildId: params.guildId,
			discordUserId: params.discordUserId,
			discordUsername: params.discordUsername,
			itemId: params.itemId,
			itemName: params.itemName,
			quantity: newQuantity,
			isTest: params.isTest,
		});
	}

	return { success: true, updatedQuantity: newQuantity };
}

/**
 * Reclaims stock from a holder back into the unassigned armory pool.
 */
export async function reclaimStockFromHolder(params: {
	guildId: string;
	discordUserId: string;
	itemId: string;
	quantity: number;
	isTest: boolean;
}): Promise<{ success: boolean; error?: string; remainingQuantity?: number }> {
	if (params.quantity <= 0) {
		return { success: false, error: "Quantity must be greater than zero." };
	}

	const [existing] = await db
		.select()
		.from(elimsStockHolders)
		.where(
			and(
				eq(elimsStockHolders.guildId, params.guildId),
				eq(elimsStockHolders.discordUserId, params.discordUserId),
				eq(elimsStockHolders.itemId, params.itemId),
				eq(elimsStockHolders.isTest, params.isTest),
			),
		)
		.limit(1);

	if (!existing || existing.quantity <= 0) {
		return {
			success: false,
			error: "Member currently holds no stock of this item.",
		};
	}

	if (params.quantity > existing.quantity) {
		return {
			success: false,
			error: `Cannot reclaim ${params.quantity} item(s). Member only holds ${existing.quantity}.`,
		};
	}

	const remainingQuantity = existing.quantity - params.quantity;

	await db
		.update(elimsStockHolders)
		.set({
			quantity: remainingQuantity,
			updatedAt: new Date(),
		})
		.where(eq(elimsStockHolders.id, existing.id));

	return { success: true, remainingQuantity };
}

/**
 * Deducts stock from a holder when an item request is accepted.
 */
export async function deductHolderStock(params: {
	guildId: string;
	discordUserId: string;
	itemId: string;
	quantity: number;
	isTest: boolean;
}): Promise<{ success: boolean; error?: string; remainingQuantity?: number }> {
	const [existing] = await db
		.select()
		.from(elimsStockHolders)
		.where(
			and(
				eq(elimsStockHolders.guildId, params.guildId),
				eq(elimsStockHolders.discordUserId, params.discordUserId),
				eq(elimsStockHolders.itemId, params.itemId),
				eq(elimsStockHolders.isTest, params.isTest),
			),
		)
		.limit(1);

	if (!existing || existing.quantity < params.quantity) {
		const currentHeld = existing?.quantity ?? 0;
		return {
			success: false,
			error: `Insufficient held stock. You hold ${currentHeld.toLocaleString()} item(s), but this request requires ${params.quantity.toLocaleString()}.`,
		};
	}

	const remainingQuantity = existing.quantity - params.quantity;

	await db
		.update(elimsStockHolders)
		.set({
			quantity: remainingQuantity,
			updatedAt: new Date(),
		})
		.where(eq(elimsStockHolders.id, existing.id));

	return { success: true, remainingQuantity };
}
