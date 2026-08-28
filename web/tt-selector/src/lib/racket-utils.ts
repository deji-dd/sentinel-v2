export interface RewardInfo {
	amount: number;
	type: "cash" | "items" | "points";
	itemName?: string;
	displayString: string;
}

export function parseRewardString(
	rewardOrString:
		| string
		| { type: string; quantity: number; id: number | null }
		| null
		| undefined,
	itemNames: Record<string, string> = {},
): RewardInfo | null {
	if (!rewardOrString) return null;

	if (typeof rewardOrString === "object") {
		const typeMap: Record<string, "cash" | "items" | "points"> = {
			Money: "cash",
			Points: "points",
			Item: "items",
		};
		const type = typeMap[rewardOrString.type] ?? "cash";
		const idStr = rewardOrString.id ? String(rewardOrString.id) : undefined;
		const resolvedName =
			idStr && itemNames[idStr] ? itemNames[idStr] : rewardOrString.type;

		let displayString = `${rewardOrString.quantity.toLocaleString()}x ${resolvedName} daily`;
		if (type === "cash") {
			displayString = `$${rewardOrString.quantity.toLocaleString()} daily`;
		}

		return {
			amount: rewardOrString.quantity,
			type,
			itemName: idStr,
			displayString,
		};
	}

	const rewardString = String(rewardOrString);

	const cashMatch = rewardString.match(/^\$([0-9,]+)\s+daily$/i);
	if (cashMatch?.[1]) {
		const amount = parseInt(cashMatch[1].replace(/,/g, ""), 10);
		if (!Number.isNaN(amount)) {
			return { amount, type: "cash", displayString: rewardString };
		}
	}

	const pointsMatch = rewardString.match(/^([0-9,]+)x\s+Points\s+daily$/i);
	if (pointsMatch?.[1]) {
		const amount = parseInt(pointsMatch[1].replace(/,/g, ""), 10);
		if (!Number.isNaN(amount)) {
			return {
				amount,
				type: "points",
				itemName: "Points",
				displayString: rewardString,
			};
		}
	}

	const itemsMatch = rewardString.match(/^([0-9,]+)x\s+(.+)\s+daily$/i);
	if (itemsMatch?.[1] && itemsMatch?.[2]) {
		const amount = parseInt(itemsMatch[1].replace(/,/g, ""), 10);
		const itemName = itemsMatch[2].trim();
		if (!Number.isNaN(amount)) {
			return { amount, type: "items", itemName, displayString: rewardString };
		}
	}

	return null;
}

export interface PriceMetadata {
	items: Record<string, number>;
	points: number;
}

export function calculateDailyValue(
	reward: RewardInfo | null,
	prices: PriceMetadata | Record<string, number> = { items: {}, points: 0 },
): number {
	if (!reward) return 0;
	if (reward.type === "cash") return reward.amount;
	if (reward.type === "points") {
		const pointsPrice =
			typeof prices === "object" && "points" in prices
				? Number(prices.points) || 0
				: 0;
		return reward.amount * pointsPrice;
	}
	const itemPrices =
		typeof prices === "object" && "items" in prices
			? (prices.items as Record<string, number>)
			: (prices as Record<string, number>);
	const unitPrice =
		itemPrices[reward.itemName ?? ""] ??
		itemPrices[reward.displayString ?? ""] ??
		0;
	return reward.amount * unitPrice;
}

export function formatCurrency(amount: number): string {
	if (amount >= 1_000_000_000) {
		return `$${(amount / 1_000_000_000).toFixed(2)}B`;
	}
	if (amount >= 1_000_000) {
		return `$${(amount / 1_000_000).toFixed(1)}M`;
	}
	if (amount >= 1_000) {
		return `$${(amount / 1_000).toFixed(0)}k`;
	}
	return `$${amount.toLocaleString()}`;
}
