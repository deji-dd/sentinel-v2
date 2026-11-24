import {
	and,
	capitalAccess,
	capitalInvestments,
	capitalInvestorContacts,
	capitalInvestors,
	capitalPayoutObligations,
	db,
	eq,
	getCapitalAlertPreferences,
	getCapitalInvestors,
	getCapitalState,
	getWorkerState,
	gte,
	inArray,
	or,
	tornUsers,
	upsertWorkerState,
} from "@sentinel/database";
import type {
	CapitalBook,
	CapitalPersonalAlertPayload,
} from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import {
	computeInvestorMetrics,
	computeNav,
	formatMoney,
	Logger,
	parseMoney,
	parseUnits,
} from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { requestWithPool } from "../../lib/pool-key-request";

const logger = new Logger("Scheduler", "CapitalPersonalAlerts");

const PORTFOLIO_URL = "https://stocks.blasted-labs.tech/portfolio";
const PAPER_DESK_URL = "https://stocks.blasted-labs.tech/desk/paper";

const APR_MILESTONES = [10, 25, 50, -10, -20] as const;
const APR_MIN_DAYS = 30;
const CACHE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

interface AprState {
	lastAprPct: number | null;
	fired: number[];
}

interface InvestorRow {
	id: string;
	kind: string;
	tornId: number | null;
	displayName: string;
}

function payoutStateId(book: CapitalBook): string {
	return `capital:personal-alerts:payouts:${book}`;
}
const APR_STATE_ID = "capital:personal-alerts:apr";

function broadcast(payload: CapitalPersonalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_personal_alert", data: payload });
}

function signedPct(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function linkFor(book: CapitalBook): string {
	return book === "paper" ? PAPER_DESK_URL : PORTFOLIO_URL;
}

/**
 * Resolves the Discord snowflake to DM for one investor.
 *
 * Precedence: explicit capital_access link, primary contact, the tornUsers
 * cache (populated by the API's resolver), then a live Torn API lookup. The
 * paper book has no real recipients — simulations go to the owner so the whole
 * path can be exercised safely.
 */
async function resolveRecipient(
	book: CapitalBook,
	investor: InvestorRow,
): Promise<string | null> {
	if (book === "paper") {
		return process.env.DISCORD_USER_ID?.trim() || null;
	}

	const [access] = await db
		.select({ discordId: capitalAccess.discordId })
		.from(capitalAccess)
		.where(
			and(
				eq(capitalAccess.book, "live"),
				eq(capitalAccess.investorId, investor.id),
			),
		)
		.limit(1);
	if (access?.discordId) return access.discordId;

	const [contact] = await db
		.select({ discordId: capitalInvestorContacts.discordId })
		.from(capitalInvestorContacts)
		.where(
			and(
				eq(capitalInvestorContacts.book, "live"),
				eq(capitalInvestorContacts.investorId, investor.id),
				eq(capitalInvestorContacts.role, "primary"),
			),
		)
		.limit(1);
	if (contact?.discordId) return contact.discordId;

	if (!investor.tornId) return null;

	const [cached] = await db
		.select({
			discordId: tornUsers.discordId,
			updatedAt: tornUsers.updatedAt,
		})
		.from(tornUsers)
		.where(eq(tornUsers.tornId, investor.tornId))
		.limit(1);
	if (
		cached?.discordId &&
		cached.updatedAt &&
		Date.now() - new Date(cached.updatedAt).getTime() < CACHE_FRESH_MS
	) {
		return cached.discordId;
	}

	try {
		const resolved = await requestWithPool(
			"capital:discord-lookup",
			async (key) =>
				tornApi.get("/user", {
					apiKey: key.apiKey,
					userId: key.userId,
					queryParams: {
						selections: ["discord", "profile"],
						id: investor.tornId as number,
					},
				}),
		);
		const response = resolved as {
			profile?: { id?: number; name?: string };
			player_id?: number;
			name?: string;
			discord?: { discordID?: string; discord_id?: string };
		};
		const discordId =
			response?.discord?.discordID || response?.discord?.discord_id || null;
		const profileId =
			response?.profile?.id ?? response?.player_id ?? investor.tornId;
		const name =
			response?.profile?.name ?? response?.name ?? investor.displayName;
		if (discordId) {
			// Clear a stale mapping for a different Torn player before writing.
			await db
				.update(tornUsers)
				.set({ discordId: null })
				.where(and(eq(tornUsers.discordId, discordId)));
			await db
				.insert(tornUsers)
				.values({ tornId: profileId, name, discordId, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: tornUsers.tornId,
					set: { name, discordId, updatedAt: new Date() },
				});
		}
		return discordId;
	} catch (error) {
		logger.warn(
			`Could not resolve Discord ID for Torn ${investor.tornId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return cached?.discordId ?? null;
	}
}

/** Emits payout due/paid notices for obligations created or settled recently. */
async function runPayoutAlerts(book: CapitalBook, now: Date): Promise<void> {
	const stateId = payoutStateId(book);
	const previous = await getWorkerState(stateId);
	const cursor = previous?.cursor ?? null;
	if (previous === null || cursor === null) {
		// First run: seed the cursor, never replay a book's entire payout history.
		await upsertWorkerState({ workerId: stateId, cursor: now.getTime() });
		return;
	}

	const since = new Date(cursor);
	const obligations = await db
		.select()
		.from(capitalPayoutObligations)
		.where(
			and(
				eq(capitalPayoutObligations.book, book),
				or(
					gte(capitalPayoutObligations.createdAt, since),
					gte(capitalPayoutObligations.paidAt, since),
				),
			),
		)
		.orderBy(capitalPayoutObligations.createdAt);

	const investors = new Map(
		(await getCapitalInvestors(book)).map((investor) => [
			investor.id,
			investor,
		]),
	);
	const recipients = new Map<string, string | null>();
	let emitted = 0;

	for (const obligation of obligations) {
		if (
			obligation.status === "skipped_no_profit" ||
			obligation.status === "cancelled"
		) {
			continue;
		}
		const investor = investors.get(obligation.investorId);
		if (!investor || investor.kind === "operator") continue;

		const isPaid =
			["paid", "partially_paid"].includes(obligation.status) &&
			obligation.paidAt !== null &&
			obligation.paidAt.getTime() >= cursor;
		const isDue =
			!isPaid &&
			obligation.createdAt.getTime() >= cursor &&
			["due", "unfunded"].includes(obligation.status);
		if (!isPaid && !isDue) continue;

		const preferences = await getCapitalAlertPreferences(investor.id);
		if (!preferences.payoutsEnabled) continue;

		if (!recipients.has(investor.id)) {
			recipients.set(investor.id, await resolveRecipient(book, investor));
		}
		const recipientDiscordId = recipients.get(investor.id);
		if (!recipientDiscordId) continue;

		const reinvested =
			obligation.paidBy === "system:reinvest" ||
			(obligation.note ?? "").toLowerCase().includes("reinvest");
		const kind = isPaid ? "payout_paid" : "payout_due";
		const title = isPaid
			? reinvested
				? "Distribution reinvested"
				: "Distribution paid"
			: "Distribution ready to pay";
		const body = isPaid
			? reinvested
				? `Your ${obligation.frequency} distribution was compounded into your investment.`
				: `Your ${obligation.frequency} distribution has been marked paid.`
			: `Your ${obligation.frequency} distribution is ready. The owner has been notified to send it.`;

		broadcast({
			recipientDiscordId,
			investorId: investor.id,
			book,
			kind,
			title,
			body,
			fields: [
				{
					name: "Mode",
					value: book === "paper" ? "Simulation" : "Live",
					inline: true,
				},
				{
					name: "Type",
					value: reinvested ? "Reinvested" : "Cash",
					inline: true,
				},
				{
					name: "Gross",
					value: `$${formatMoney(parseMoney(obligation.grossAmount))}`,
					inline: true,
				},
				{
					name: "Fee",
					value: `$${formatMoney(parseMoney(obligation.feeAmount))}`,
					inline: true,
				},
				{
					name: "Net",
					value: `$${formatMoney(parseMoney(obligation.netAmount))}`,
					inline: true,
				},
			],
			link: linkFor(book),
		});
		emitted++;
	}

	await upsertWorkerState({
		workerId: stateId,
		cursor: now.getTime(),
		details: emitted > 0 ? { lastEmitted: emitted } : undefined,
		lastRunAt: now,
	});
}

/** Emits APR milestone crossings using persisted per-investor state. */
async function runAprAlerts(now: Date): Promise<void> {
	const previous = await getWorkerState(APR_STATE_ID);
	const states = (previous?.details ?? {}) as Record<string, AprState>;
	let changed = false;

	for (const book of ["live", "paper"] as const) {
		const state = await getCapitalState(book);
		const nav = computeNav({
			cash: state.cash,
			units: state.units,
			positions: state.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		});
		const investors = (await getCapitalInvestors(book)).filter(
			(investor) => investor.kind !== "operator",
		);
		if (investors.length === 0) continue;

		const lots = await db
			.select({
				investorId: capitalInvestments.investorId,
				principal: capitalInvestments.principal,
				units: capitalInvestments.units,
				cumulativePayouts: capitalInvestments.cumulativePayouts,
				cumulativeFees: capitalInvestments.cumulativeFees,
				openedAt: capitalInvestments.openedAt,
			})
			.from(capitalInvestments)
			.where(
				and(
					eq(capitalInvestments.book, book),
					eq(capitalInvestments.status, "active"),
					inArray(
						capitalInvestments.investorId,
						investors.map((investor) => investor.id),
					),
				),
			);

		const byInvestor = new Map<string, typeof lots>();
		for (const lot of lots) {
			const bucket = byInvestor.get(lot.investorId) ?? [];
			bucket.push(lot);
			byInvestor.set(lot.investorId, bucket);
		}

		for (const investor of investors) {
			const investorLots = byInvestor.get(investor.id) ?? [];
			if (investorLots.length === 0) continue;
			const principal = investorLots.reduce(
				(total, lot) => total + parseMoney(lot.principal),
				0n,
			);
			const units = investorLots.reduce(
				(total, lot) => total + parseUnits(lot.units),
				0n as bigint,
			);
			const firstOpened = investorLots
				.map((lot) => lot.openedAt.getTime())
				.sort((a, b) => a - b)[0];
			if (principal <= 0n || firstOpened === undefined) continue;

			const metrics = computeInvestorMetrics({
				principal,
				units,
				navPerUnit: nav.navPerUnit,
				cumulativePayouts: investorLots.reduce(
					(total, lot) => total + parseMoney(lot.cumulativePayouts),
					0n,
				),
				cumulativeFees: investorLots.reduce(
					(total, lot) => total + parseMoney(lot.cumulativeFees),
					0n,
				),
				openedAt: new Date(firstOpened),
				now,
			});
			const apr = metrics.aprPct;
			if (apr === null || (metrics.daysInvested ?? 0) < APR_MIN_DAYS) continue;

			const preferences = await getCapitalAlertPreferences(investor.id);
			if (!preferences.aprEnabled) continue;

			const prior = states[investor.id] ?? { lastAprPct: null, fired: [] };
			const fired = new Set(prior.fired);
			for (const level of APR_MILESTONES) {
				const crossed =
					level > 0
						? prior.lastAprPct !== null &&
							prior.lastAprPct < level &&
							apr >= level
						: prior.lastAprPct !== null &&
							prior.lastAprPct > level &&
							apr <= level;
				if (!crossed || fired.has(level)) continue;
				fired.add(level);

				const recipientDiscordId = await resolveRecipient(book, investor);
				if (!recipientDiscordId) continue;
				broadcast({
					recipientDiscordId,
					investorId: investor.id,
					book,
					kind: "apr",
					title: `Your APR ${level > 0 ? "reached" : "fell to"} ${level}%`,
					body: `Your portfolio's annualized return has ${level > 0 ? "risen above" : "fallen below"} ${level}%.`,
					fields: [
						{
							name: "Mode",
							value: book === "paper" ? "Simulation" : "Live",
							inline: true,
						},
						{ name: "Your APR", value: signedPct(apr), inline: true },
						{
							name: "Total return",
							value: signedPct(metrics.totalReturnPct ?? 0),
							inline: true,
						},
						{
							name: "Days invested",
							value: String(metrics.daysInvested ?? 0),
							inline: true,
						},
					],
					link: linkFor(book),
				});
			}
			states[investor.id] = { lastAprPct: apr, fired: [...fired] };
			changed = true;
		}
	}

	if (changed || previous === null) {
		await upsertWorkerState({
			workerId: APR_STATE_ID,
			details: states,
			lastRunAt: now,
		});
	}
}

export async function runCapitalPersonalAlertsCycle(
	now = new Date(),
): Promise<void> {
	try {
		for (const book of ["live", "paper"] as const) {
			try {
				await runPayoutAlerts(book, now);
			} catch (error) {
				logger.error(
					`Personal payout alerts failed for ${book}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		await runAprAlerts(now);
	} catch (error) {
		logger.error("Personal alerts cycle failed:", error);
	}
}
