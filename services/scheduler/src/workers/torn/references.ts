import {
	db,
	systemStates,
	tornCrimes,
	tornGyms,
	tornItems,
	tornProperties,
	tornStocks,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import {
	getNextUtcTargetTimestamp,
	startEventDrivenRunner,
} from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "torn:reference_sync";
const logger = new Logger("Scheduler", "References");

type ApiGym = {
	name: string;
	stage: number;
	cost: number;
	energy: number;
	strength: number;
	speed: number;
	defense: number;
	dexterity: number;
	note: string;
};

type ApiProperty = {
	id: number | string;
	name?: string;
	cost?: number;
	happy?: number;
	upkeep?: number;
	modifications?: string[];
	staff?: string[];
};

type TornFullReferenceResponse = {
	items?: TornSchema<"TornItem">[];
	crimes?: TornSchema<"TornCrime">[];
	stocks?: TornSchema<"TornStock">[];
	properties?: ApiProperty[];
	gyms?: Record<string, ApiGym>;
};

type PointsMarketResponse = {
	pointsmarket?: Record<string, { cost: number; quantity: number }>;
};

/**
 * Syncs static public reference data from Torn (Items, Crimes, Stocks, Properties, Gyms, Points Market Price).
 */
export async function runTornReferenceSync(): Promise<number> {
	const finishSync = logger.time();

	try {
		const [res, marketRes] = (await Promise.all([
			tornApi.getPersonal("/torn", {
				queryParams: {
					selections: ["items", "crimes", "stocks", "properties", "gyms"],
				},
			}),
			tornApi.getPersonal("/market", {
				queryParams: { selections: ["pointsmarket"] },
			}),
		])) as [TornFullReferenceResponse, PointsMarketResponse];

		const now = new Date();

		// Calculate average points market price across top 5,000 points
		if (marketRes.pointsmarket) {
			let totalCost = 0;
			let totalQty = 0;
			for (const listing of Object.values(marketRes.pointsmarket)) {
				totalQty += listing.quantity;
				totalCost += listing.cost * listing.quantity;
				if (totalQty >= 5000) break;
			}
			const avgPointsPrice =
				totalQty > 0 ? Math.round(totalCost / totalQty) : 0;

			if (avgPointsPrice > 0) {
				await db
					.insert(systemStates)
					.values({
						id: "points_market_price",
						data: { price: avgPointsPrice },
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: {
							data: { price: avgPointsPrice },
							updatedAt: now,
						},
					});

				logger.info(
					`Updated average Points Market Price: $${avgPointsPrice.toLocaleString()} (sample: ${totalQty} points).`,
				);
			}
		}

		if (res.items) {
			const itemsList = Array.isArray(res.items)
				? res.items
				: Object.values(res.items);

			const validItems = itemsList.filter(
				(item): item is TornSchema<"TornItem"> & { id: number } =>
					item !== null &&
					typeof item === "object" &&
					"id" in item &&
					typeof item.id === "number",
			);

			if (validItems.length > 0) {
				const chunkSize = 100;
				for (let i = 0; i < validItems.length; i += chunkSize) {
					const chunk = validItems.slice(i, i + chunkSize);
					await db.transaction(async (tx) => {
						for (const item of chunk) {
							await tx
								.insert(tornItems)
								.values({
									id: item.id.toString(),
									name: item.name ?? `Item ${item.id}`,
									data: item,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: tornItems.id,
									set: {
										name: item.name ?? `Item ${item.id}`,
										data: item,
										updatedAt: now,
									},
								});
						}
					});
				}
				logger.info(`Synced ${validItems.length} Torn Items to SQLite.`);
			}
		}

		if (res.crimes) {
			const crimesList = Array.isArray(res.crimes)
				? res.crimes
				: Object.values(res.crimes);

			const validCrimes = crimesList.filter(
				(crime): crime is TornSchema<"TornCrime"> & { id: number } =>
					crime !== null &&
					typeof crime === "object" &&
					"id" in crime &&
					typeof crime.id === "number",
			);

			if (validCrimes.length > 0) {
				const enrichedCrimes = await Promise.all(
					validCrimes.map(async (crime) => {
						try {
							const subRes = (await tornApi.getPersonal(
								"/torn/{crimeId}/subcrimes",
								{
									pathParams: { crimeId: crime.id },
								},
							)) as { subcrimes?: TornSchema<"TornSubcrime">[] };

							return {
								...crime,
								subcrimes: subRes?.subcrimes ?? [],
							};
						} catch (err) {
							logger.warn(
								`Failed to fetch subcrimes for crime ${crime.id}: ${err instanceof Error ? err.message : String(err)}`,
							);
							return {
								...crime,
								subcrimes: [],
							};
						}
					}),
				);

				const chunkSize = 100;
				for (let i = 0; i < enrichedCrimes.length; i += chunkSize) {
					const chunk = enrichedCrimes.slice(i, i + chunkSize);
					await db.transaction(async (tx) => {
						for (const crime of chunk) {
							await tx
								.insert(tornCrimes)
								.values({
									id: crime.id.toString(),
									name: crime.name ?? `Crime ${crime.id}`,
									data: crime,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: tornCrimes.id,
									set: {
										name: crime.name ?? `Crime ${crime.id}`,
										data: crime,
										updatedAt: now,
									},
								});
						}
					});
				}
				logger.info(
					`Synced ${enrichedCrimes.length} Torn Crimes with subcrimes to SQLite.`,
				);
			}
		}

		if (res.stocks) {
			const stocksList = Array.isArray(res.stocks)
				? res.stocks
				: Object.values(res.stocks);

			const validStocks = stocksList.filter(
				(stock): stock is TornSchema<"TornStock"> & { stock_id: number } =>
					stock !== null &&
					typeof stock === "object" &&
					"stock_id" in stock &&
					typeof stock.stock_id === "number",
			);

			if (validStocks.length > 0) {
				const chunkSize = 100;
				for (let i = 0; i < validStocks.length; i += chunkSize) {
					const chunk = validStocks.slice(i, i + chunkSize);
					await db.transaction(async (tx) => {
						for (const stock of chunk) {
							await tx
								.insert(tornStocks)
								.values({
									id: stock.stock_id.toString(),
									name: stock.name ?? `Stock ${stock.stock_id}`,
									acronym: stock.acronym ?? "",
									market: stock,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: tornStocks.id,
									set: {
										name: stock.name ?? `Stock ${stock.stock_id}`,
										acronym: stock.acronym ?? "",
										market: stock,
										updatedAt: now,
									},
								});
						}
					});
				}
				logger.info(`Synced ${validStocks.length} Torn Stocks to SQLite.`);
			}
		}

		if (res.properties) {
			const propList = Array.isArray(res.properties)
				? res.properties
				: Object.values(res.properties);

			const validProps = propList.filter(
				(p): p is ApiProperty =>
					p !== null && typeof p === "object" && "id" in p && Boolean(p.id),
			);

			if (validProps.length > 0) {
				const chunkSize = 100;
				for (let i = 0; i < validProps.length; i += chunkSize) {
					const chunk = validProps.slice(i, i + chunkSize);
					await db.transaction(async (tx) => {
						for (const prop of chunk) {
							await tx
								.insert(tornProperties)
								.values({
									id: String(prop.id),
									name: prop.name ?? `Property ${prop.id}`,
									data: prop,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: tornProperties.id,
									set: {
										name: prop.name ?? `Property ${prop.id}`,
										data: prop,
										updatedAt: now,
									},
								});
						}
					});
				}
				logger.info(`Synced ${validProps.length} Torn Properties to SQLite.`);
			}
		}

		if (res.gyms) {
			const gymsList: Array<Record<string, unknown>> = Array.isArray(res.gyms)
				? (res.gyms as Array<Record<string, unknown>>)
				: Object.values(res.gyms as Record<string, Record<string, unknown>>);

			if (gymsList.length > 0) {
				await db.transaction(async (tx) => {
					for (const gym of gymsList) {
						const gymId = String(gym.id ?? "");
						if (!gymId) continue;

						const modifiers = (gym.modifiers ?? {}) as {
							strength?: number;
							speed?: number;
							defense?: number;
							dexterity?: number;
						};

						const gymName = (gym.name as string | undefined) ?? `Gym ${gymId}`;
						const stageVal = Number(gym.stage ?? 0);
						const costVal = Number(gym.cost ?? 0);
						const energyVal = Number(gym.energy_cost ?? gym.energy ?? 0);
						const strVal = Number(modifiers.strength ?? gym.strength ?? 0);
						const spdVal = Number(modifiers.speed ?? gym.speed ?? 0);
						const defVal = Number(modifiers.defense ?? gym.defense ?? 0);
						const dexVal = Number(modifiers.dexterity ?? gym.dexterity ?? 0);
						const noteVal = (gym.note as string | null | undefined) ?? null;

						await tx
							.insert(tornGyms)
							.values({
								id: gymId,
								name: gymName,
								stage: stageVal,
								cost: costVal,
								energy: energyVal,
								strength: strVal,
								speed: spdVal,
								defense: defVal,
								dexterity: dexVal,
								note: noteVal,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoUpdate({
								target: tornGyms.id,
								set: {
									name: gymName,
									stage: stageVal,
									cost: costVal,
									energy: energyVal,
									strength: strVal,
									speed: spdVal,
									defense: defVal,
									dexterity: dexVal,
									note: noteVal,
									updatedAt: now,
								},
							});
					}
				});
				logger.info(`Synced ${gymsList.length} Torn Gyms to SQLite.`);
			}
		}

		finishSync();
		return getNextUtcTargetTimestamp(0, 15);
	} catch (err) {
		logger.error("Failed to sync public Torn reference data:", err);
		return getNextUtcTargetTimestamp(0, 15);
	}
}

/**
 * Starts the event-driven reference sync worker scheduled to run daily at 00:15 UTC.
 */
export function startTornReferences(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: 86400,
		initialDelayMs: options?.initialDelayMs,
		handler: runTornReferenceSync,
	});
}
