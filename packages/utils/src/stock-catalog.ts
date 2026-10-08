// Type-only, and deliberately relative: `@sentinel/utils` is a leaf package with
// no workspace dependencies (see its package.json), so the shared contract is
// reached the same way the userscript reaches it — by path, at compile time only.
import type {
	StockBenefitKind,
	StockBenefitValuation,
	StockResourceUnit,
} from "../../schemas/src/stocks";

/**
 * The stock benefit catalogue: what every Torn stock actually pays, and whether
 * that payout can be turned into a dollar figure.
 *
 * WHY THIS IS CODE AND NOT A DATABASE READ
 *
 * `torn_stocks` carries the authoritative requirement, frequency, description and
 * price from Torn, and it is preferred whenever a row exists. But it is refreshed
 * by a daily reference sync and can legitimately be empty (a fresh database, a
 * skipped cycle, or the profile of the earlier bug where the stock half of that
 * sync wrote nothing while items and crimes succeeded). A stocks tab that cannot
 * name stock 15 without a database row is not worth much, so the wiki's published
 * benefit table is mirrored here as a fallback and to carry the one thing Torn
 * does not report at all: whether a payout is cash, an item, a resource, or
 * nothing priceable.
 *
 * Ids, requirements, frequencies and passive flags were verified against
 * `GET /torn/stocks` (35 stocks) rather than transcribed by hand; the valuations
 * come from the wiki's Stock Market benefit table, which is where the item,
 * resource and passive classifications live.
 */

/** How one dividend cycle of a stock is paid, before any price lookup. */
export type CatalogBenefitValuation =
	| { kind: "cash"; amount: number }
	| {
			kind: "item";
			itemName: string;
			/** Torn item id, when the payout is a specific tradeable item. */
			itemId?: number;
			quantity: number;
			note?: string;
	  }
	| { kind: "resource"; unit: StockResourceUnit; quantity: number }
	| {
			kind: Extract<StockBenefitKind, "ammo" | "property" | "passive">;
			note: string;
	  };

export interface CatalogStock {
	stockId: number;
	name: string;
	acronym: string;
	/** Shares in the first increment; each further increment costs double. */
	requirementShares: number;
	passive: boolean;
	/** Days per cycle for active benefits, 7 for the passive hold requirement. */
	frequencyDays: number;
	/** Torn's own benefit wording, so the tab reads the same as the game. */
	description: string;
	valuation: CatalogBenefitValuation;
	/** Hard cap on increments, where the game imposes one. */
	maxIncrements?: number;
	note?: string;
}

/**
 * Every stock in the game, keyed by id. Passive entries carry `frequencyDays: 7`
 * because that is the hold requirement before a passive benefit activates.
 */
export const STOCK_CATALOG: readonly CatalogStock[] = [
	{
		stockId: 1,
		name: "Torn & Shanghai Banking",
		acronym: "TSB",
		requirementShares: 3_000_000,
		passive: false,
		frequencyDays: 31,
		description: "$50,000,000",
		valuation: { kind: "cash", amount: 50_000_000 },
	},
	{
		stockId: 2,
		name: "Torn City Investments",
		acronym: "TCI",
		requirementShares: 1_500_000,
		passive: true,
		frequencyDays: 7,
		description: "a 10% bank interest bonus",
		valuation: {
			kind: "passive",
			note: "Raises bank interest by 10%; its value depends on your balance and deposit schedule.",
		},
	},
	{
		stockId: 3,
		name: "Syscore MFG",
		acronym: "SYS",
		requirementShares: 3_000_000,
		passive: true,
		frequencyDays: 7,
		description: "an Advanced firewall",
		valuation: {
			kind: "passive",
			note: "Blocks Intricate Hack, Proxy Hacking, virus cancels and IP Tracing against you and your company.",
		},
	},
	{
		stockId: 4,
		name: "Legal Authorities Group",
		acronym: "LAG",
		requirementShares: 750_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Lawyer's Business Card",
		valuation: {
			kind: "item",
			itemId: 368,
			itemName: "Lawyer's Business Card",
			quantity: 1,
		},
	},
	{
		stockId: 5,
		name: "Insured On Us",
		acronym: "IOU",
		requirementShares: 3_000_000,
		passive: false,
		frequencyDays: 31,
		description: "$12,000,000",
		valuation: { kind: "cash", amount: 12_000_000 },
		note: "Also pays out when anyone uses the Law city job's Paralegal special.",
	},
	{
		stockId: 6,
		name: "Grain",
		acronym: "GRN",
		requirementShares: 500_000,
		passive: false,
		frequencyDays: 31,
		description: "$4,000,000",
		valuation: { kind: "cash", amount: 4_000_000 },
	},
	{
		stockId: 7,
		name: "Torn City Health Service",
		acronym: "THS",
		requirementShares: 150_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Box of Medical Supplies",
		valuation: {
			kind: "item",
			itemId: 365,
			itemName: "Box of Medical Supplies",
			quantity: 1,
		},
	},
	{
		stockId: 8,
		name: "Yazoo",
		acronym: "YAZ",
		requirementShares: 1_000_000,
		passive: true,
		frequencyDays: 7,
		description: "Free banner advertising",
		valuation: {
			kind: "passive",
			note: "Free newspaper banner advertising; worth whatever you would otherwise pay for it.",
		},
	},
	{
		stockId: 9,
		name: "The Torn City Times",
		acronym: "TCT",
		requirementShares: 100_000,
		passive: false,
		frequencyDays: 31,
		description: "$1,000,000",
		valuation: { kind: "cash", amount: 1_000_000 },
	},
	{
		stockId: 10,
		name: "Crude & Co",
		acronym: "CNC",
		requirementShares: 7_500_000,
		passive: false,
		frequencyDays: 31,
		description: "$80,000,000",
		valuation: { kind: "cash", amount: 80_000_000 },
	},
	{
		stockId: 11,
		name: "Messaging Inc.",
		acronym: "MSG",
		requirementShares: 300_000,
		passive: true,
		frequencyDays: 7,
		description: "Free classified advertising",
		valuation: {
			kind: "passive",
			note: "Free newspaper classified advertising; worth the listing fee you stop paying.",
		},
	},
	{
		stockId: 12,
		name: "TC Music Industries",
		acronym: "TMI",
		requirementShares: 6_000_000,
		passive: false,
		frequencyDays: 31,
		description: "$25,000,000",
		valuation: { kind: "cash", amount: 25_000_000 },
	},
	{
		stockId: 13,
		name: "TC Media Productions",
		acronym: "TCP",
		requirementShares: 1_000_000,
		passive: true,
		frequencyDays: 7,
		description: "a Company sales boost",
		valuation: {
			kind: "passive",
			note: "Company sales boost; its value is a share of company revenue, not a cash payout.",
		},
	},
	{
		stockId: 14,
		name: "I Industries Ltd.",
		acronym: "IIL",
		requirementShares: 1_000_000,
		passive: true,
		frequencyDays: 7,
		description: "50% coding time reduction",
		valuation: {
			kind: "passive",
			note: "Halves virus coding time; worth your own time, not money.",
		},
	},
	{
		stockId: 15,
		name: "Feathery Hotels Group",
		acronym: "FHG",
		requirementShares: 2_000_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Feathery Hotel Coupon",
		valuation: {
			kind: "item",
			itemId: 367,
			itemName: "Feathery Hotel Coupon",
			quantity: 1,
		},
	},
	{
		stockId: 16,
		name: "Symbiotic Ltd.",
		acronym: "SYM",
		requirementShares: 500_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Drug Pack",
		valuation: {
			kind: "item",
			itemId: 370,
			itemName: "Drug Pack",
			quantity: 1,
		},
	},
	{
		stockId: 17,
		name: "Lucky Shots Casino",
		acronym: "LSC",
		requirementShares: 500_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Lottery Voucher",
		valuation: {
			kind: "item",
			itemId: 369,
			itemName: "Lottery Voucher",
			quantity: 1,
		},
	},
	{
		stockId: 18,
		name: "Performance Ribaldry Network",
		acronym: "PRN",
		requirementShares: 1_000_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Erotic DVD",
		valuation: {
			kind: "item",
			itemId: 366,
			itemName: "Erotic DVD",
			quantity: 1,
		},
	},
	{
		stockId: 19,
		name: "Eaglewood Mercenary",
		acronym: "EWM",
		requirementShares: 1_000_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Box of Grenades",
		valuation: {
			kind: "item",
			itemId: 364,
			itemName: "Box of Grenades",
			quantity: 1,
		},
	},
	{
		stockId: 20,
		name: "Torn City Motors",
		acronym: "TCM",
		requirementShares: 1_000_000,
		passive: true,
		frequencyDays: 7,
		description: "10% racing skill gain boost",
		valuation: {
			kind: "passive",
			note: "Racing skill boost; only worth something while you race.",
		},
	},
	{
		stockId: 21,
		name: "Empty Lunchbox Traders",
		acronym: "ELT",
		requirementShares: 5_000_000,
		passive: true,
		frequencyDays: 7,
		description: "10% home upgrade discount",
		valuation: {
			kind: "passive",
			note: "Home upgrade discount; worth 10% of whatever upgrades you still have left to buy.",
		},
	},
	{
		stockId: 22,
		name: "Home Retail Group",
		acronym: "HRG",
		requirementShares: 10_000_000,
		passive: false,
		frequencyDays: 31,
		description: "1x Random Property",
		valuation: {
			kind: "property",
			note: "One of 13 properties from Trailer to Private Island, each equally likely; the expected value is not a market price.",
		},
	},
	{
		stockId: 23,
		name: "Tell Group Plc.",
		acronym: "TGP",
		requirementShares: 2_500_000,
		passive: true,
		frequencyDays: 7,
		description: "Company advertising boost",
		valuation: {
			kind: "passive",
			note: "Company advertising boost; worth your company's ad budget, not a cash payout.",
		},
	},
	{
		stockId: 24,
		name: "Munster Beverage Corp.",
		acronym: "MUN",
		requirementShares: 5_000_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Six-Pack of Energy Drink",
		valuation: {
			kind: "item",
			itemId: 818,
			itemName: "Six-Pack of Energy Drink",
			quantity: 1,
		},
	},
	{
		stockId: 25,
		name: "West Side University",
		acronym: "WSU",
		requirementShares: 1_000_000,
		passive: true,
		frequencyDays: 7,
		description: "a 10% education course time reduction",
		valuation: {
			kind: "passive",
			note: "Education time reduction; worth the course time it saves you.",
		},
	},
	{
		stockId: 26,
		name: "International School TC",
		acronym: "IST",
		requirementShares: 100_000,
		passive: true,
		frequencyDays: 7,
		description: "Free education courses",
		valuation: {
			kind: "passive",
			note: "Free education; worth the course fees you stop paying.",
		},
	},
	{
		stockId: 27,
		name: "Big Al's Gun Shop",
		acronym: "BAG",
		requirementShares: 3_000_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Ammunition Pack",
		valuation: {
			kind: "ammo",
			note: "Special ammo matching your equipped weapon: 6 rounds for heavy artillery, 100 for pistol and shotgun calibres, 250 for rifle and SMG calibres.",
		},
	},
	{
		stockId: 28,
		name: "Evil Ducks Candy Corp",
		acronym: "EVL",
		requirementShares: 100_000,
		passive: false,
		frequencyDays: 7,
		description: "1000 happiness",
		valuation: { kind: "resource", unit: "happy", quantity: 1000 },
	},
	{
		stockId: 29,
		name: "Mc Smoogle Corp",
		acronym: "MCS",
		requirementShares: 350_000,
		passive: false,
		frequencyDays: 7,
		description: "100 energy",
		valuation: { kind: "resource", unit: "energy", quantity: 100 },
		maxIncrements: 10,
		note: "Capped at 10 increments: 1,000 energy, the most a player can hold.",
	},
	{
		stockId: 30,
		name: "Wind Lines Travel",
		acronym: "WLT",
		requirementShares: 9_000_000,
		passive: true,
		frequencyDays: 7,
		description: "Private jet access",
		valuation: {
			kind: "passive",
			note: "Private jet travel, and immunity to the Detective Agency's flight delay special.",
		},
	},
	{
		stockId: 31,
		name: "Torn City Clothing",
		acronym: "TCC",
		requirementShares: 7_500_000,
		passive: false,
		frequencyDays: 31,
		description: "1x Clothing Cache",
		valuation: {
			kind: "item",
			itemName: "Clothing Cache",
			quantity: 1,
			note: "Random clothing rather than a tradeable cache item, so it has no single market price.",
		},
	},
	{
		stockId: 32,
		name: "Alcoholics Synonymous",
		acronym: "ASS",
		requirementShares: 1_000_000,
		passive: false,
		frequencyDays: 7,
		description: "1x Six-Pack of Alcohol",
		valuation: {
			kind: "item",
			itemId: 817,
			itemName: "Six-Pack of Alcohol",
			quantity: 1,
		},
	},
	{
		stockId: 33,
		name: "Herbal Releaf Co.",
		acronym: "CBD",
		requirementShares: 350_000,
		passive: false,
		frequencyDays: 7,
		description: "50 nerve",
		valuation: { kind: "resource", unit: "nerve", quantity: 50 },
	},
	{
		stockId: 34,
		name: "Lo Squalo Waste Management",
		acronym: "LOS",
		requirementShares: 7_500_000,
		passive: true,
		frequencyDays: 7,
		description: "25% boost to mission credits and money earned",
		valuation: {
			kind: "passive",
			note: "Mission credit and money boost; worth 25% of your mission income.",
		},
	},
	{
		stockId: 35,
		name: "PointLess",
		acronym: "PTS",
		requirementShares: 10_000_000,
		passive: false,
		frequencyDays: 7,
		description: "100 points",
		valuation: { kind: "resource", unit: "points", quantity: 100 },
	},
] as const;

/** The catalogue row for a stock id, if this build knows about the stock. */
export function catalogStock(stockId: number): CatalogStock | undefined {
	return STOCK_CATALOG.find((s) => s.stockId === stockId);
}

/**
 * Every Torn item id a payout can be paid in, so a caller can price the whole
 * catalogue in one lookup instead of only the items that have already been paid
 * out. Without this, a stock whose dividend has never landed is reported as
 * unpriceable even though its item trades on the market.
 */
export const STOCK_CATALOG_ITEM_IDS: readonly number[] = [
	...new Set(
		STOCK_CATALOG.flatMap((stock) =>
			stock.valuation.kind === "item" && stock.valuation.itemId !== undefined
				? [stock.valuation.itemId]
				: [],
		),
	),
];

const RESOURCE_LABELS: Record<StockResourceUnit, string> = {
	energy: "energy",
	nerve: "nerve",
	happy: "happiness",
	points: "points",
};

/**
 * Turns a catalogue valuation into a dollar figure per dividend cycle.
 *
 * `priced: false` is a real answer, not a failure: it means no honest dollar
 * figure exists for this payout, and every surface downstream is expected to show
 * a dash rather than a zero that would read as "this stock pays nothing".
 *
 * Only points are tradeable among the resources, so only points are priced — from
 * the points market, the same price a player would pay to buy them. Energy, nerve
 * and happiness cannot be sold for cash at any price, so valuing them would be an
 * invented number; they stay unpriced, exactly like a passive benefit.
 */
export function valueCatalogBenefit(
	valuation: CatalogBenefitValuation,
	pointsPrice: number,
	itemPricesById: ReadonlyMap<number, number>,
	itemPricesByName: ReadonlyMap<string, number>,
): StockBenefitValuation {
	if (valuation.kind === "cash") {
		return {
			kind: "cash",
			cashPerCycle: valuation.amount,
			valuePerCycle: valuation.amount,
			priced: true,
		};
	}

	if (valuation.kind === "resource") {
		const priced = valuation.unit === "points" && pointsPrice > 0;
		return {
			kind: "resource",
			resourceUnit: valuation.unit,
			resourceQuantity: valuation.quantity,
			valuePerCycle: priced ? pointsPrice * valuation.quantity : 0,
			priced,
			pricingNote: priced
				? undefined
				: valuation.unit === "points"
					? "No points-market price is on record, so this payout carries no dollar figure."
					: `${RESOURCE_LABELS[valuation.unit]} cannot be sold for cash, so this payout is excluded from every money figure.`,
		};
	}

	if (valuation.kind === "item") {
		const byId =
			valuation.itemId !== undefined
				? (itemPricesById.get(valuation.itemId) ?? 0)
				: 0;
		const byName =
			byId > 0
				? 0
				: (itemPricesByName.get(valuation.itemName.toLowerCase()) ?? 0);
		const unitPrice = byId > 0 ? byId : byName;
		const valuePerCycle = unitPrice * valuation.quantity;
		return {
			kind: "item",
			itemId: valuation.itemId,
			itemName: valuation.itemName,
			itemQuantity: valuation.quantity,
			valuePerCycle,
			priced: valuePerCycle > 0,
			pricingNote:
				valuePerCycle > 0
					? valuation.note
					: (valuation.note ??
						`No market price on record for ${valuation.itemName}, so this payout carries no dollar figure.`),
		};
	}

	return {
		kind: valuation.kind,
		valuePerCycle: 0,
		priced: false,
		pricingNote: valuation.note,
	};
}
