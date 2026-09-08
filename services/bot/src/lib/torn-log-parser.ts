export interface ParsedDepositLog {
	itemName: string;
	quantity: number;
	donorName: string;
	donorTornId: number | null;
	message?: string | null;
	timestamp?: string | null;
	rawLog: string;
}

export interface ParsedBuyLog {
	itemName: string;
	quantity: number;
	totalCost: number;
	priceEach: number | null;
	source?: string | null;
	timestamp?: string | null;
	rawLog: string;
}

export interface ParsedArmoryInput {
	deposits: ParsedDepositLog[];
	buys: ParsedBuyLog[];
}

export interface ParsedSentLog {
	itemName: string;
	quantity: number;
	recipientName: string;
	recipientTornId: number | null;
	timestamp?: string | null;
	rawLog: string;
}

/**
 * Extracts username and optional Torn ID from a string that might contain a markdown link.
 * e.g. "[Clitasaurus](https://www.torn.com/profiles.php?XID=2059853)" -> { name: "Clitasaurus", tornId: 2059853 }
 * e.g. "Clitasaurus" -> { name: "Clitasaurus", tornId: null }
 */
export function extractUserAndId(raw: string): {
	name: string;
	tornId: number | null;
} {
	const trimmed = raw.trim();
	const mdMatch = trimmed.match(
		/\[([^\]]+)\]\((?:https?:\/\/[^)]*XID=(\d+)[^)]*|[^)]+)\)/i,
	);
	if (mdMatch?.[1]) {
		const tornId = mdMatch[2] ? Number.parseInt(mdMatch[2], 10) : null;
		return {
			name: mdMatch[1].trim(),
			tornId: Number.isNaN(tornId) ? null : tornId,
		};
	}

	const bracketMatch = trimmed.match(/^(.+?)\s*\[(\d+)\]$/);
	if (bracketMatch?.[1] && bracketMatch[2]) {
		const tornId = Number.parseInt(bracketMatch[2], 10);
		return {
			name: bracketMatch[1].trim(),
			tornId: Number.isNaN(tornId) ? null : tornId,
		};
	}

	// Plain text name
	return {
		name: trimmed.replace(/^\[|\]$/g, ""),
		tornId: null,
	};
}

/**
 * Normalizes item quantity string ("a", "an", "16x", "16") to a number.
 */
function normalizeQuantity(qtyStr: string): number {
	const lower = qtyStr.trim().toLowerCase();
	if (lower === "a" || lower === "an") return 1;
	const cleaned = lower.replace(/x$/, "");
	const parsed = Number.parseInt(cleaned, 10);
	return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

/**
 * Parses numeric money amount from a currency string (e.g. "$42,743,465" -> 42743465).
 */
export function parseMoneyAmount(amountStr: string): number {
	const cleaned = amountStr.replace(/[^0-9]/g, "");
	const parsed = Number.parseInt(cleaned, 10);
	return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/**
 * Parses a single deposit log line (sent logs, received logs, or trade logs).
 * Supports both items and direct cash transfers ($42,743,465).
 */
export function parseDepositLogLine(line: string): ParsedDepositLog[] {
	const trimmed = line.trim();
	if (!trimmed) return [];

	// Optional timestamp prefix e.g. "00:50:02 - 06/09/26 " or 4-digit year
	const tsMatch = trimmed.match(
		/^(\d{2}:\d{2}:\d{2}\s*-\s*\d{2}\/\d{2}\/\d{2,4})\s+(.+)$/,
	);
	const timestamp = tsMatch?.[1]?.trim() ?? null;
	const content = tsMatch?.[2] ?? trimmed;

	// Pattern 1a: Money received: "You were sent $(AMOUNT) from (DONOR)( with the message: (MSG))?"
	const p1MoneyMatch = content.match(
		/^You were sent\s+\$([\d,]+)\s+from\s+(.+?)(?:\s+with the message:\s*(.*))?$/i,
	);
	if (p1MoneyMatch?.[1] && p1MoneyMatch[2]) {
		const amount = parseMoneyAmount(p1MoneyMatch[1]);
		const { name: donorName, tornId: donorTornId } = extractUserAndId(
			p1MoneyMatch[2],
		);
		const message = p1MoneyMatch[3]?.trim() || null;
		return [
			{
				itemName: "Money",
				quantity: amount,
				donorName,
				donorTornId,
				message,
				timestamp,
				rawLog: trimmed,
			},
		];
	}

	// Pattern 1b: Items received: "You were sent (a|an|\d+x|\d+) (ITEM) from (DONOR)( with the message: (MSG))?"
	const p1Match = content.match(
		/^You were sent\s+(a|an|\d+x|\d+)\s+(.+?)\s+from\s+(.+?)(?:\s+with the message:\s*(.*))?$/i,
	);
	if (p1Match?.[1] && p1Match[2] && p1Match[3]) {
		const quantity = normalizeQuantity(p1Match[1]);
		const itemName = p1Match[2].trim();
		const { name: donorName, tornId: donorTornId } = extractUserAndId(
			p1Match[3],
		);
		const message = p1Match[4]?.trim() || null;

		return [
			{
				itemName,
				quantity,
				donorName,
				donorTornId,
				message,
				timestamp,
				rawLog: trimmed,
			},
		];
	}

	// Pattern 2a: Money sent: "(DONOR) sent $(AMOUNT) to you(?:\s+with the message:\s*(.*))?"
	const p2MoneyMatch = content.match(
		/^(.+?)\s+sent\s+\$([\d,]+)\s+to you(?:\s+with the message:\s*(.*))?$/i,
	);
	if (p2MoneyMatch?.[1] && p2MoneyMatch[2]) {
		const { name: donorName, tornId: donorTornId } = extractUserAndId(
			p2MoneyMatch[1],
		);
		const amount = parseMoneyAmount(p2MoneyMatch[2]);
		const message = p2MoneyMatch[3]?.trim() || null;

		return [
			{
				itemName: "Money",
				quantity: amount,
				donorName,
				donorTornId,
				message,
				timestamp,
				rawLog: trimmed,
			},
		];
	}

	// Pattern 2b: Items sent: "(DONOR) sent (a|an|\d+x|\d+) (ITEM) to you(?:\s+with the message:\s*(.*))?"
	const p2Match = content.match(
		/^(.+?)\s+sent\s+(a|an|\d+x|\d+)\s+(.+?)\s+to you(?:\s+with the message:\s*(.*))?$/i,
	);
	if (p2Match?.[1] && p2Match[2] && p2Match[3]) {
		const { name: donorName, tornId: donorTornId } = extractUserAndId(
			p2Match[1],
		);
		const quantity = normalizeQuantity(p2Match[2]);
		const itemName = p2Match[3].trim();
		const message = p2Match[4]?.trim() || null;

		return [
			{
				itemName,
				quantity,
				donorName,
				donorTornId,
				message,
				timestamp,
				rawLog: trimmed,
			},
		];
	}

	// Pattern 3: "(DONOR) traded (ITEMS...) to you(?:\s+with the message:\s*(.*?))?(?:\s*(?:\[view\]|view|\[.*?\]\(.*?\)))?$"
	const p3Match = content.match(
		/^(.+?)\s+traded\s+(.+?)\s+to you(?:\s+with the message:\s*(.*?))?(?:\s*(?:\[view\]|view|\[.*?\]\(.*?\)))?$/i,
	);
	if (p3Match?.[1] && p3Match[2]) {
		const { name: donorName, tornId: donorTornId } = extractUserAndId(
			p3Match[1],
		);
		const message = p3Match[3]?.trim() || null;
		const itemsRaw = p3Match[2];

		const parsedItems: ParsedDepositLog[] = [];

		// Extract any cash included in the trade e.g. "$150,000,000" or "$5,000,000"
		const moneyMatches = itemsRaw.matchAll(/\$([\d,]+)/g);
		for (const m of moneyMatches) {
			if (m[1]) {
				parsedItems.push({
					itemName: "Money",
					quantity: parseMoneyAmount(m[1]),
					donorName,
					donorTornId,
					message,
					timestamp,
					rawLog: trimmed,
				});
			}
		}

		// Clean cash amounts from the trade string to isolate physical items
		const cleanedItems = itemsRaw
			.replace(/(?:,\s*)?\$[\d,]+(?:\s*,\s*)?/g, ", ")
			.replace(/^,\s*|,\s*$/g, "")
			.trim();

		if (cleanedItems) {
			const chunks = cleanedItems
				.split(",")
				.map((c) => c.trim())
				.filter(Boolean);

			for (const chunk of chunks) {
				const qMatch = chunk.match(/^(a|an|\d+x|\d+)\s+(.+)$/i);
				let quantity = 1;
				let itemName = chunk;
				if (qMatch?.[1] && qMatch[2]) {
					quantity = normalizeQuantity(qMatch[1]);
					itemName = qMatch[2].trim();
				}
				parsedItems.push({
					itemName,
					quantity,
					donorName,
					donorTornId,
					message,
					timestamp,
					rawLog: trimmed,
				});
			}
		}

		if (parsedItems.length > 0) {
			return parsedItems;
		}
	}

	return [];
}

/**
 * Parses a single item buy / purchase event log line.
 * Supports:
 * - "17:57:08 - 07/09/26 You bought a Donator Pack on BLS-Envoy's bazaar at $23,560,000 each for a total of $23,560,000"
 * - "07:09:10 - 05/09/26 You bought 249x Smoke Grenade on the item market from someone at $90,500 each for a total of $22,534,500"
 * - "05:10:17 - 05/09/26 You bought 20x Serotonin at $1,300,000 each for a total of $26,000,000 from Pharmacy"
 */
export function parseBuyLogLine(line: string): ParsedBuyLog | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	const tsMatch = trimmed.match(
		/^(\d{2}:\d{2}:\d{2}\s*-\s*\d{2}\/\d{2}\/\d{2,4})\s+(.+)$/,
	);
	const timestamp = tsMatch?.[1]?.trim() ?? null;
	const content = tsMatch?.[2] ?? trimmed;

	const buyMatch = content.match(/^You bought\s+(a|an|\d+x|\d+)\s+(.+)$/i);
	if (!buyMatch?.[1] || !buyMatch[2]) return null;

	const quantity = normalizeQuantity(buyMatch[1]);
	const rest = buyMatch[2].trim();

	// Extract total cost and/or unit price
	let totalCost = 0;
	let priceEach: number | null = null;
	const totalMatch =
		rest.match(/for\s+a\s+total\s+of\s+\$([\d,]+)/i) ??
		rest.match(/for\s+\$([\d,]+)/i);
	const eachMatch = rest.match(/at\s+\$([\d,]+)(?:\s+each)?/i);

	if (totalMatch?.[1]) {
		totalCost = parseMoneyAmount(totalMatch[1]);
	}
	if (eachMatch?.[1]) {
		priceEach = parseMoneyAmount(eachMatch[1]);
	}
	if (!totalCost && priceEach) {
		totalCost = quantity * priceEach;
	}
	if (totalCost && !priceEach && quantity > 0) {
		priceEach = Math.round(totalCost / quantity);
	}

	// Split rest into before-price and after-price segments
	const priceRegex =
		/(?:at\s+\$([\d,]+)(?:\s+each)?(?:\s+for\s+a\s+total\s+of\s+\$([\d,]+))?|for\s+(?:a\s+total\s+of\s+)?\$([\d,]+))/i;
	const pMatch = rest.match(priceRegex);
	let beforePrice = rest;
	let afterPrice = "";
	if (pMatch && pMatch.index !== undefined) {
		beforePrice = rest.slice(0, pMatch.index).trim();
		afterPrice = rest.slice(pMatch.index + pMatch[0].length).trim();
	}

	let source: string | null = null;
	if (afterPrice) {
		const afterSrc = afterPrice.replace(/^(?:from|on|in|at)\s+/i, "").trim();
		if (afterSrc) source = afterSrc;
	}

	let itemName = beforePrice;
	// Look for location before the price (e.g. "on BLS-Envoy's bazaar", "on the item market from someone")
	const srcRegex =
		/\s+(?:on|in|from|at)\s+((?:the\s+item\s+market.*|.*?(?:'s\s+bazaar|bazaar|market|pharmacy|store)|someone.*|[\w\s'-]+))$/i;
	const srcMatch = beforePrice.match(srcRegex);
	if (srcMatch && srcMatch.index !== undefined) {
		itemName = beforePrice.slice(0, srcMatch.index).trim();
		if (!source && srcMatch[1]) {
			source = srcMatch[1].trim();
		}
	}

	return {
		itemName,
		quantity,
		totalCost,
		priceEach,
		source,
		timestamp,
		rawLog: trimmed,
	};
}

/**
 * Parses multiline chat input in the armory storage channel into both deposit logs and buy logs.
 */
export function parseArmoryChatInput(input: string): ParsedArmoryInput {
	const lines = input
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const deposits: ParsedDepositLog[] = [];
	const buys: ParsedBuyLog[] = [];

	for (const line of lines) {
		const buy = parseBuyLogLine(line);
		if (buy) {
			buys.push(buy);
			continue;
		}

		const depList = parseDepositLogLine(line);
		for (const dep of depList) {
			deposits.push(dep);
		}
	}

	return { deposits, buys };
}

/**
 * Parses a single deposit log line. Returns the first parsed item for compatibility.
 */
export function parseSingleDepositLog(line: string): ParsedDepositLog | null {
	const results = parseDepositLogLine(line);
	return results[0] ?? null;
}

/**
 * Parses multiline deposit log input into an array of parsed deposit logs.
 */
export function parseDepositLogs(input: string): ParsedDepositLog[] {
	const lines = input
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const results: ParsedDepositLog[] = [];

	for (const line of lines) {
		const parsedList = parseDepositLogLine(line);
		for (const parsed of parsedList) {
			results.push(parsed);
		}
	}

	return results;
}

/**
 * Parses a single sent / verification Torn event log line.
 * Supports:
 * - "04:37:52 - 04/09/26 You sent a Business Class Ticket to BabyLuST"
 * - "00:37:23 - 04/09/26 You sent 5x Flash Grenade to Fahquetu"
 * - "14:02:49 - 30/11/25 You sent an Armor Cache to ladyK"
 * - "You sent 5x Flash Grenade to Fahquetu"
 * - "You sent 5x Flash Grenade to [Fahquetu](https://...)"
 */
export function parseSingleSentLog(line: string): ParsedSentLog | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	// Optional timestamp prefix e.g. "04:37:52 - 04/09/26 "
	const tsMatch = trimmed.match(
		/^(\d{2}:\d{2}:\d{2}\s*-\s*\d{2}\/\d{2}\/\d{2,4})\s+(.+)$/,
	);
	const timestamp = tsMatch?.[1]?.trim() ?? null;
	const content = tsMatch?.[2] ?? trimmed;

	// Pattern: "You sent (a|an|\d+x|\d+) (ITEM) to (RECIPIENT)"
	const match = content.match(
		/^You sent\s+(a|an|\d+x|\d+)\s+(.+?)\s+to\s+(.+)$/i,
	);
	if (!match?.[1] || !match[2] || !match[3]) {
		return null;
	}

	const quantity = normalizeQuantity(match[1]);
	const itemName = match[2].trim();
	const { name: recipientName, tornId: recipientTornId } = extractUserAndId(
		match[3],
	);

	return {
		itemName,
		quantity,
		recipientName,
		recipientTornId,
		timestamp,
		rawLog: trimmed,
	};
}

/**
 * Validates whether a parsed sent log matches a target item request.
 * - Recipient name matching is STRICTLY CASE-SENSITIVE per specifications.
 * - Item name is matched case-insensitively.
 * - Quantity must be greater than or equal to requested quantity.
 */
export function validateSentLogAgainstRequest(
	parsedLog: ParsedSentLog,
	expected: {
		recipientTornName: string;
		recipientTornId?: number | null;
		itemName: string;
		quantity: number;
	},
): { isValid: boolean; error?: string } {
	// Case-sensitive recipient name check
	const nameMatches = parsedLog.recipientName === expected.recipientTornName;
	const idMatches =
		parsedLog.recipientTornId !== null &&
		expected.recipientTornId !== null &&
		expected.recipientTornId !== undefined &&
		parsedLog.recipientTornId === expected.recipientTornId;

	if (!nameMatches && !idMatches) {
		return {
			isValid: false,
			error: `Recipient mismatch: expected "${expected.recipientTornName}", but log shows "${parsedLog.recipientName}". Names are case-sensitive.`,
		};
	}

	// Item name check (case-insensitive)
	if (parsedLog.itemName.toLowerCase() !== expected.itemName.toLowerCase()) {
		return {
			isValid: false,
			error: `Item mismatch: expected "${expected.itemName}", but log shows "${parsedLog.itemName}".`,
		};
	}

	// Quantity check
	if (parsedLog.quantity < expected.quantity) {
		return {
			isValid: false,
			error: `Quantity mismatch: expected at least ${expected.quantity}x ${expected.itemName}, but log shows only ${parsedLog.quantity}x.`,
		};
	}

	return { isValid: true };
}
