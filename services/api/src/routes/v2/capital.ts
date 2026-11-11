import {
	and,
	capitalAccess,
	capitalAuditLog,
	type CapitalBook,
	capitalEngineRuns,
	capitalInvestments,
	capitalInvestorContacts,
	capitalInvestors,
	capitalOrders,
	capitalPaymentIntents,
	capitalPayoutObligations,
	capitalSmokeReports,
	capitalWithdrawalRequests,
	db,
	eq,
	getCapitalConfig,
	getCapitalEngineRuns,
	getCapitalFills,
	getCapitalInvestors,
	getCapitalIssues,
	getCapitalOrders,
	getCapitalPaymentIntents,
	getCapitalPayouts,
	getCapitalSmokeReports,
	getCapitalState,
	getCapitalWithdrawals,
	inArray,
	isCapitalBook,
	recordCapitalAudit,
	resolveCapitalIssue,
	updateCapitalConfig,
} from "@sentinel/database";
import {
	type CapitalBook as CapitalBookSchema,
	type CapitalPayoutView,
	type CapitalWithdrawalView,
	isCapitalPayoutFrequency,
	isCapitalSignalMode,
} from "@sentinel/schemas";
import {
	formatMoney,
	makeReferenceCode,
	parseMoney,
	toNumber,
} from "@sentinel/utils";
import { Elysia, t } from "elysia";

import { env } from "../../config/env";
import { canReadCapital, resolveCapitalAccess } from "../../lib/capital-access";
import {
	addInvestorContact,
	createDepositLot,
	createInvestor,
	createWithdrawalQuote,
	createWithdrawalRequest,
	findInvestorByTornId,
	getCapitalAdminOverview,
	getCapitalPublicOverview,
	getInvestorPortfolio,
	payPayout,
	payWithdrawal,
	recordManualFill,
	resetPaperBook,
	toCapitalSettings,
	updateInvestor,
} from "../../lib/capital-service";
import {
	notifySchedulerForceRun,
	sendSchedulerRequest,
} from "../../lib/scheduler-ipc";
import { authPlugin } from "../../middleware/auth";

function isOwner(
	user: { role: string; discordId: string | null } | null,
): boolean {
	if (!user) return false;
	if (user.role === "owner" || user.role === "admin") return true;
	return Boolean(env.DISCORD_USER_ID) && user.discordId === env.DISCORD_USER_ID;
}

function parseBook(
	value: string | undefined,
	set: { status?: number | string },
): CapitalBook | null {
	if (!isCapitalBook(value)) {
		set.status = 400;
		return null;
	}
	return value;
}

function asDate(value: unknown): Date {
	if (value instanceof Date && Number.isFinite(value.getTime())) return value;
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		if (Number.isFinite(parsed.getTime())) return parsed;
	}
	return new Date();
}

async function ownsLot(
	book: CapitalBook,
	investorId: string,
	investmentId: string,
): Promise<boolean> {
	const [lot] = await db
		.select({ investorId: capitalInvestments.investorId })
		.from(capitalInvestments)
		.where(
			and(
				eq(capitalInvestments.id, investmentId),
				eq(capitalInvestments.book, book),
			),
		)
		.limit(1);
	return lot?.investorId === investorId;
}

export const capitalRoutes = new Elysia({ prefix: "/capital" })
	.use(authPlugin)
	.onBeforeHandle(({ request, set }) => {
		// Host isolation for browser callers. The capital API is shared by the
		// `stocks` app and the API host itself; another dashboard's origin must
		// not be able to read this feature through the shared session cookie.
		const origin = request.headers.get("origin");
		if (!origin) return;
		const allowed = new Set([
			"https://stocks.blasted-labs.tech",
			"https://api.blasted-labs.tech",
			"http://localhost:5177",
			"http://127.0.0.1:5177",
			"http://localhost:3000",
			"http://127.0.0.1:3000",
		]);
		if (!allowed.has(origin)) {
			set.status = 403;
			return {
				success: false,
				error: "Capital API is not available from this origin.",
			};
		}
	})
	.get(
		"/public",
		async ({ query }) =>
			getCapitalPublicOverview(query.book === "paper" ? "paper" : "live"),
		{ query: t.Object({ book: t.Optional(t.String()) }) },
	)
	.get("/me", async ({ user, set }) => {
		if (!user) {
			set.status = 401;
			return { success: false, error: "Unauthorized" };
		}
		const access = await resolveCapitalAccess(
			user,
			"live",
			env.DISCORD_USER_ID,
		);
		if (!canReadCapital(access)) {
			set.status = 403;
			return { success: false, error: "Capital access denied." };
		}
		let investorId = access.investorId;
		if (!investorId && access.tornId) {
			investorId = await findInvestorByTornId("live", access.tornId);
		}
		if (!investorId) {
			return {
				success: true,
				investor: null,
				totals: null,
				lots: [],
				payouts: [],
				withdrawals: [],
				performance: [],
				warnings: ["No active investment is linked to this account."],
			};
		}
		return getInvestorPortfolio("live", investorId);
	})
	.post(
		"/me/withdrawals/quote",
		async ({ body, user, set }) => {
			if (!user) {
				set.status = 401;
				return { success: false, error: "Unauthorized" };
			}
			const access = await resolveCapitalAccess(
				user,
				"live",
				env.DISCORD_USER_ID,
			);
			let investorId = access.investorId;
			if (!investorId && access.tornId) {
				investorId = await findInvestorByTornId("live", access.tornId);
			}
			if (!investorId && !access.isAdmin) {
				set.status = 403;
				return { success: false, error: "No capital access." };
			}
			const investmentId = body.investmentId;
			if (
				!access.isAdmin &&
				(!investorId || !(await ownsLot("live", investorId, investmentId)))
			) {
				set.status = 403;
				return { success: false, error: "That lot does not belong to you." };
			}
			const { createWithdrawalQuote } =
				await import("../../lib/capital-service");
			return createWithdrawalQuote({
				book: "live",
				investmentId,
				requestedAmount: body.amount ?? null,
			});
		},
		{
			body: t.Object({
				investmentId: t.String(),
				amount: t.Optional(t.String()),
			}),
		},
	)
	.post(
		"/me/withdrawals",
		async ({ body, user, set }) => {
			if (!user) {
				set.status = 401;
				return { success: false, error: "Unauthorized" };
			}
			const access = await resolveCapitalAccess(
				user,
				"live",
				env.DISCORD_USER_ID,
			);
			let investorId = access.investorId;
			if (!investorId && access.tornId) {
				investorId = await findInvestorByTornId("live", access.tornId);
			}
			if (!investorId) {
				set.status = 403;
				return { success: false, error: "No active investment." };
			}
			if (!(await ownsLot("live", investorId, body.investmentId))) {
				set.status = 403;
				return { success: false, error: "That lot does not belong to you." };
			}
			const request = await createWithdrawalRequest({
				book: "live",
				investmentId: body.investmentId,
				investorId,
				requestedAmount: body.amount,
				actor: user.discordId ?? user.username,
			});
			return { success: true, request };
		},
		{
			body: t.Object({
				investmentId: t.String(),
				amount: t.String(),
				note: t.Optional(t.String()),
			}),
		},
	)
	.get("/admin/:book/overview", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return getCapitalAdminOverview(book);
	})
	.get("/admin/:book/settings", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return {
			success: true,
			settings: toCapitalSettings(await getCapitalConfig(book)),
		};
	})
	.put(
		"/admin/:book/settings",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };

			const current = await getCapitalConfig(book);
			const patch: Record<string, unknown> = {};
			const booleanFields = [
				"publicShowAum",
				"publicShowTrades",
				"publicShowHoldings",
				"publicShowFees",
				"withdrawalPerformanceFeeEnabled",
				"notifyUnmatchedBuys",
				"paperAutoFill",
				"mlEnabled",
				"engineEnabled",
				"liveEnabled",
			];
			const numberFields = [
				"feeRateDailyBps",
				"feeRateWeeklyBps",
				"feeRateMonthlyBps",
				"minCashReservePct",
				"maxEquityPct",
				"maxStockWeightPct",
				"maxPositions",
				"riskPerTradePct",
				"stopAtrMultiplier",
				"stopMinPct",
				"trailingTriggerR",
				"trailingAtrMultiplier",
				"trailingPct",
				"tightenTrailPct",
				"scaleOutR",
				"scaleOutFraction",
				"timeStopDays",
				"minEntryScore",
				"maxRsi",
				"overboughtSigma",
				"reversalEntrySigma",
				"reversalExitSigma",
				"maxVolatilityPct",
				"mlWeight",
				"mlMinConfidence",
				"mlMaxModelAgeDays",
				"regimeSmaDays",
				"drawdownHaltPct",
				"drawdownDeriskPct",
				"dailyLossHaltPct",
				"stopCooldownDays",
				"maxNewPositionsPerWeek",
				"orderValidityMinutes",
				"staleDataSeconds",
				"saleFeeBps",
				"withdrawalExitFeeBps",
				"withdrawalNoticeDays",
				"paymentMatchTolerancePct",
				"paperSlippageBps",
			];
			const stringFields = ["withdrawalMinAmount", "paperStartingCash"];
			for (const field of booleanFields) {
				const value = body[field];
				if (typeof value === "boolean") patch[field] = value;
			}
			for (const field of numberFields) {
				const value = body[field];
				if (typeof value === "number" && Number.isFinite(value)) {
					patch[field] = value;
				}
			}
			for (const field of stringFields) {
				const value = body[field];
				if (value === null) patch[field] = null;
				else if (typeof value === "string") patch[field] = value;
			}
			if (body.signalMode !== undefined) {
				if (!isCapitalSignalMode(body.signalMode)) {
					set.status = 400;
					return { success: false, error: "Invalid signal mode." };
				}
				patch.signalMode = body.signalMode;
			}

			const updated = await updateCapitalConfig(
				book,
				patch,
				user?.discordId ?? user?.username ?? null,
			);
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "settings.update",
				entityType: "capital_book_config",
				entityId: book,
				before: current,
				after: updated,
			});
			return { success: true, settings: toCapitalSettings(updated) };
		},
		{ body: t.Record(t.String(), t.Unknown()) },
	)
	.get("/admin/:book/investors", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const overview = await getCapitalAdminOverview(book);
		return { success: true, investors: overview.investors };
	})
	.post(
		"/admin/:book/investors",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const kind = book === "paper" ? "test" : (body.kind ?? "user");
			if (book === "live") {
				if (kind !== "user" && kind !== "faction" && kind !== "operator") {
					set.status = 400;
					return {
						success: false,
						error:
							"Live investors must be users, factions or operators. Test investors belong on the paper desk.",
					};
				}
				if (!Number.isInteger(body.tornId) || (body.tornId ?? 0) <= 0) {
					set.status = 400;
					return { success: false, error: "A valid Torn ID is required." };
				}
			} else if (
				body.tornId !== undefined &&
				(!Number.isInteger(body.tornId) || body.tornId <= 0)
			) {
				set.status = 400;
				return { success: false, error: "Invalid Torn ID." };
			}
			const tornId =
				Number.isInteger(body.tornId) && (body.tornId ?? 0) > 0
					? body.tornId
					: null;
			const frequency = isCapitalPayoutFrequency(body.frequency)
				? body.frequency
				: "weekly";
			const payoutMode = body.payoutMode === "reinvest" ? "reinvest" : "cash";
			const investor = await createInvestor({
				book,
				kind,
				tornId,
				factionId: body.factionId ?? null,
				displayName: body.displayName,
				frequency,
				payoutMode,
				actor: user?.discordId ?? null,
			});
			for (const contact of body.contacts ?? []) {
				const added = await addInvestorContact({
					book,
					investorId: investor.id,
					tornId: contact.tornId ?? null,
					discordId: contact.discordId ?? null,
					name: contact.name ?? null,
					role: contact.role === "primary" ? "primary" : "viewer",
				});
				if (added.tornId || added.discordId) {
					await db
						.insert(capitalAccess)
						.values({
							book,
							tornId: added.tornId,
							discordId: added.discordId,
							role: "viewer",
							investorId: investor.id,
							note: "Faction contact access.",
						})
						.onConflictDoNothing();
				}
			}
			if (investor.tornId) {
				await db
					.insert(capitalAccess)
					.values({
						book,
						tornId: investor.tornId,
						role: "investor",
						investorId: investor.id,
						note: "Auto-whitelisted on investor creation.",
					})
					.onConflictDoNothing();
			}
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "investor.create",
				entityType: "capital_investor",
				entityId: investor.id,
				after: investor as unknown as Record<string, unknown>,
			});
			return { success: true, investor };
		},
		{
			body: t.Object({
				kind: t.Optional(t.String()),
				tornId: t.Optional(t.Number()),
				factionId: t.Optional(t.Number()),
				displayName: t.String(),
				frequency: t.Optional(t.String()),
				payoutMode: t.Optional(t.String()),
				contacts: t.Optional(
					t.Array(
						t.Object({
							tornId: t.Optional(t.Number()),
							discordId: t.Optional(t.String()),
							name: t.Optional(t.String()),
							role: t.Optional(t.String()),
						}),
					),
				),
			}),
		},
	)
	.patch(
		"/admin/:book/investors/:id",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			if (
				body.frequency !== undefined &&
				!isCapitalPayoutFrequency(body.frequency)
			) {
				set.status = 400;
				return { success: false, error: "Invalid payout frequency." };
			}
			if (
				body.payoutMode !== undefined &&
				body.payoutMode !== "cash" &&
				body.payoutMode !== "reinvest"
			) {
				set.status = 400;
				return { success: false, error: "Invalid payout mode." };
			}
			const investor = await updateInvestor({
				book,
				investorId: params.id,
				displayName: body.displayName?.trim() || undefined,
				frequency: isCapitalPayoutFrequency(body.frequency)
					? body.frequency
					: undefined,
				payoutMode:
					body.payoutMode === "cash" || body.payoutMode === "reinvest"
						? body.payoutMode
						: undefined,
				status: body.status === undefined ? undefined : body.status,
			});
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "investor.update",
				entityType: "capital_investor",
				entityId: investor.id,
				after: investor as unknown as Record<string, unknown>,
			});
			return { success: true, investor };
		},
		{
			body: t.Object({
				displayName: t.Optional(t.String()),
				frequency: t.Optional(t.String()),
				payoutMode: t.Optional(t.String()),
				status: t.Optional(t.String()),
			}),
		},
	)
	.post(
		"/admin/:book/investors/:id/contacts",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const contact = await addInvestorContact({
				book,
				investorId: params.id,
				tornId: body.tornId ?? null,
				discordId: body.discordId ?? null,
				name: body.name ?? null,
				role: body.role === "primary" ? "primary" : "viewer",
			});
			if (contact.tornId || contact.discordId) {
				await db
					.insert(capitalAccess)
					.values({
						book,
						tornId: contact.tornId,
						discordId: contact.discordId,
						role: "viewer",
						investorId: params.id,
						note: "Investor contact access.",
					})
					.onConflictDoNothing();
			}
			return { success: true, contact };
		},
		{
			body: t.Object({
				tornId: t.Optional(t.Number()),
				discordId: t.Optional(t.String()),
				name: t.Optional(t.String()),
				role: t.Optional(t.String()),
			}),
		},
	)
	.delete("/admin/:book/contacts/:id", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		await db
			.delete(capitalInvestorContacts)
			.where(
				and(
					eq(capitalInvestorContacts.id, params.id),
					eq(capitalInvestorContacts.book, book),
				),
			);
		return { success: true };
	})
	.post(
		"/admin/:book/investors/:id/deposits",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const result = await createDepositLot({
				book,
				investorId: params.id,
				amount: body.amount,
				occurredAt: asDate(body.occurredAt),
				actor: user?.discordId ?? null,
				note: body.note ?? null,
			});
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "deposit.create",
				entityType: "capital_investment",
				entityId: result.investmentId,
				after: result as unknown as Record<string, unknown>,
			});
			return { success: true, ...result };
		},
		{
			body: t.Object({
				amount: t.String(),
				occurredAt: t.Optional(t.String()),
				note: t.Optional(t.String()),
			}),
		},
	)
	.get("/admin/:book/payouts", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const rows = await getCapitalPayouts(book);
		return { success: true, payouts: rows };
	})
	.post(
		"/admin/:book/payouts/pay",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const payout = await payPayout({
				book,
				obligationId: body.obligationId,
				amount: body.amount ?? null,
				idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
				actor: user?.discordId ?? null,
				note: body.note ?? null,
			});
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "payout.pay",
				entityType: "capital_payout_obligation",
				entityId: payout.id,
				after: payout as unknown as Record<string, unknown>,
			});
			return { success: true, payout };
		},
		{
			body: t.Object({
				obligationId: t.String(),
				amount: t.Optional(t.String()),
				idempotencyKey: t.Optional(t.String()),
				note: t.Optional(t.String()),
			}),
		},
	)
	.get("/admin/:book/withdrawals", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const rows = await getCapitalWithdrawals(book);
		return { success: true, withdrawals: rows };
	})
	.post(
		"/admin/:book/withdrawals/:id/approve",
		async ({ params, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			await db
				.update(capitalWithdrawalRequests)
				.set({
					status: "approved",
					approvedAt: new Date(),
					approvedBy: user?.discordId ?? null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(capitalWithdrawalRequests.id, params.id),
						eq(capitalWithdrawalRequests.book, book),
					),
				);
			const [request] = await db
				.select()
				.from(capitalWithdrawalRequests)
				.where(
					and(
						eq(capitalWithdrawalRequests.id, params.id),
						eq(capitalWithdrawalRequests.book, book),
					),
				)
				.limit(1);
			if (request) {
				const [investor] = await db
					.select()
					.from(capitalInvestors)
					.where(eq(capitalInvestors.id, request.investorId))
					.limit(1);
				if (investor?.tornId && request.referenceCode) {
					await db
						.insert(capitalPaymentIntents)
						.values({
							book,
							kind: "withdrawal",
							investorId: request.investorId,
							investmentId: request.investmentId,
							counterpartyTornId: investor.tornId,
							expectedAmount: request.netAmount,
							referenceCode: request.referenceCode,
							expiresAt: new Date(Date.now() + 7 * 86_400_000),
							note: "Withdrawal verification code; include this in the Torn transfer message.",
						})
						.onConflictDoNothing();
				}
			}
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "withdrawal.approve",
				entityType: "capital_withdrawal_request",
				entityId: params.id,
			});
			return { success: true };
		},
	)
	.post(
		"/admin/:book/withdrawals/:id/reject",
		async ({ params, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			await db
				.update(capitalWithdrawalRequests)
				.set({
					status: "rejected",
					rejectedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(capitalWithdrawalRequests.id, params.id),
						eq(capitalWithdrawalRequests.book, book),
					),
				);
			return { success: true };
		},
	)
	.post("/admin/:book/withdrawals/:id/pay", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const request = await payWithdrawal({
			book,
			requestId: params.id,
			actor: user?.discordId ?? null,
		});
		await recordCapitalAudit({
			book,
			actorDiscordId: user?.discordId ?? null,
			action: "withdrawal.pay",
			entityType: "capital_withdrawal_request",
			entityId: request.id,
			after: request as unknown as Record<string, unknown>,
		});
		return { success: true, withdrawal: request };
	})
	.get("/admin/:book/reconciliation", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return { success: true, issues: await getCapitalIssues(book) };
	})
	.get("/admin/:book/issues", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return { success: true, issues: await getCapitalIssues(book) };
	})
	.post(
		"/admin/:book/issues/:id/resolve",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const status = body.status === "ignored" ? "ignored" : "resolved";
			await resolveCapitalIssue(
				params.id,
				status,
				user?.discordId ?? null,
				body.note ?? null,
			);
			await recordCapitalAudit({
				book,
				actorDiscordId: user?.discordId ?? null,
				action: "issue.resolve",
				entityType: "capital_reconciliation_issue",
				entityId: params.id,
				note: body.note ?? null,
			});
			return { success: true };
		},
		{
			body: t.Object({
				status: t.Optional(t.String()),
				note: t.Optional(t.String()),
			}),
		},
	)
	.get("/admin/:book/payment-intents", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return { success: true, intents: await getCapitalPaymentIntents(book) };
	})
	.post(
		"/admin/:book/payment-intents",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const prefix =
				body.kind === "payout"
					? "PAY"
					: body.kind === "withdrawal"
						? "WDR"
						: "DEP";
			let frequency = isCapitalPayoutFrequency(body.frequency)
				? body.frequency
				: null;
			let payoutMode =
				body.payoutMode === "cash" || body.payoutMode === "reinvest"
					? body.payoutMode
					: null;
			if (body.investorId && (frequency === null || payoutMode === null)) {
				const [investor] = await db
					.select()
					.from(capitalInvestors)
					.where(
						and(
							eq(capitalInvestors.book, book),
							eq(capitalInvestors.id, body.investorId),
						),
					)
					.limit(1);
				if (investor) {
					if (frequency === null) {
						frequency = isCapitalPayoutFrequency(investor.frequency)
							? investor.frequency
							: "weekly";
					}
					if (payoutMode === null) {
						payoutMode =
							investor.payoutMode === "reinvest" ? "reinvest" : "cash";
					}
				}
			}
			const [intent] = await db
				.insert(capitalPaymentIntents)
				.values({
					book,
					kind: body.kind,
					investorId: body.investorId ?? null,
					investmentId: body.investmentId ?? null,
					frequency,
					payoutMode: payoutMode ?? "cash",
					payoutIds: body.payoutIds ?? [],
					counterpartyTornId: body.counterpartyTornId ?? null,
					expectedAmount: formatMoney(parseMoney(body.expectedAmount)),
					tolerancePct: body.tolerancePct ?? 1,
					referenceCode: makeReferenceCode(prefix),
					expiresAt: new Date(Date.now() + 7 * 86_400_000),
					note: body.note ?? null,
					createdBy: user?.discordId ?? null,
				})
				.returning();
			return { success: true, intent };
		},
		{
			body: t.Object({
				kind: t.String(),
				investorId: t.Optional(t.String()),
				investmentId: t.Optional(t.String()),
				frequency: t.Optional(t.String()),
				payoutMode: t.Optional(t.String()),
				payoutIds: t.Optional(t.Array(t.String())),
				counterpartyTornId: t.Optional(t.Number()),
				expectedAmount: t.String(),
				tolerancePct: t.Optional(t.Number()),
				note: t.Optional(t.String()),
			}),
		},
	)
	.post("/admin/:book/orders/:id/accept", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		await db
			.update(capitalOrders)
			.set({
				status: "accepted",
				acceptedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(capitalOrders.id, params.id),
					eq(capitalOrders.book, book),
					inArray(capitalOrders.status, ["recommended", "partially_filled"]),
				),
			);
		return { success: true };
	})
	.post("/admin/:book/orders/:id/cancel", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		await db
			.update(capitalOrders)
			.set({ status: "cancelled", updatedAt: new Date() })
			.where(
				and(
					eq(capitalOrders.id, params.id),
					eq(capitalOrders.book, book),
					inArray(capitalOrders.status, [
						"recommended",
						"accepted",
						"partially_filled",
					]),
				),
			);
		return { success: true };
	})
	.get("/admin/:book/orders", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return { success: true, orders: await getCapitalOrders(book) };
	})
	.get("/admin/:book/fills", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return { success: true, fills: await getCapitalFills(book) };
	})
	.post(
		"/admin/:book/fills",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			if (body.side !== "buy" && body.side !== "sell") {
				set.status = 400;
				return { success: false, error: "Invalid side." };
			}
			if (!Number.isInteger(body.shares) || body.shares <= 0) {
				set.status = 400;
				return { success: false, error: "Shares must be a positive integer." };
			}
			const fill = await recordManualFill({
				book,
				stockId: body.stockId,
				side: body.side,
				shares: body.shares,
				price: body.price,
				fees: body.fees ?? "0",
				orderId: body.orderId ?? null,
				actor: user?.discordId ?? null,
				note: body.note ?? null,
			});
			return { success: true, fill };
		},
		{
			body: t.Object({
				stockId: t.Number(),
				side: t.String(),
				shares: t.Number(),
				price: t.String(),
				fees: t.Optional(t.String()),
				orderId: t.Optional(t.String()),
				note: t.Optional(t.String()),
			}),
		},
	)
	.get("/admin/:book/access", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const rows = await db
			.select()
			.from(capitalAccess)
			.where(eq(capitalAccess.book, book));
		return { success: true, access: rows };
	})
	.post(
		"/admin/:book/access",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book) return { success: false, error: "Invalid book." };
			const [row] = await db
				.insert(capitalAccess)
				.values({
					book,
					tornId: body.tornId ?? null,
					discordId: body.discordId ?? null,
					role: body.role,
					investorId: body.investorId ?? null,
					note: body.note ?? null,
					createdBy: user?.discordId ?? null,
				})
				.returning();
			return { success: true, access: row };
		},
		{
			body: t.Object({
				tornId: t.Optional(t.Number()),
				discordId: t.Optional(t.String()),
				role: t.String(),
				investorId: t.Optional(t.String()),
				note: t.Optional(t.String()),
			}),
		},
	)
	.delete("/admin/:book/access/:id", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		await db
			.delete(capitalAccess)
			.where(
				and(eq(capitalAccess.id, params.id), eq(capitalAccess.book, book)),
			);
		return { success: true };
	})
	.get("/admin/:book/audit", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const rows = await db
			.select()
			.from(capitalAuditLog)
			.where(eq(capitalAuditLog.book, book))
			.orderBy(capitalAuditLog.createdAt);
		return { success: true, audit: rows };
	})
	.get("/admin/:book/engine/runs", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		return { success: true, runs: await getCapitalEngineRuns(book) };
	})
	.post("/admin/:book/engine/run", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const delivered = await notifySchedulerForceRun("capital:engine").catch(
			() => false,
		);
		return { success: delivered, book };
	})
	.post(
		"/admin/:book/paper/reset",
		async ({ params, body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			const book = parseBook(params.book, set);
			if (!book || book !== "paper") {
				set.status = 400;
				return { success: false, error: "Paper book only." };
			}
			const config = await getCapitalConfig("paper");
			const startingCash = body.startingCash ?? config.paperStartingCash;
			await resetPaperBook(startingCash, user?.discordId ?? null);
			return { success: true };
		},
		{
			body: t.Object({
				startingCash: t.Optional(t.String()),
			}),
		},
	)
	.post(
		"/admin/paper/smoke-test",
		async ({ body, user, set }) => {
			if (!isOwner(user)) {
				set.status = 403;
				return { success: false, error: "Admin access required." };
			}
			try {
				const report = await sendSchedulerRequest(
					"capital_smoke_test",
					{ startingCash: body.startingCash ?? null },
					180_000,
				);
				return { success: true, report };
			} catch (error) {
				set.status = 503;
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Scheduler is unreachable.",
				};
			}
		},
		{ body: t.Object({ startingCash: t.Optional(t.String()) }) },
	)
	.get("/admin/:book/smoke-reports", async ({ params, user, set }) => {
		if (!isOwner(user)) {
			set.status = 403;
			return { success: false, error: "Admin access required." };
		}
		const book = parseBook(params.book, set);
		if (!book) return { success: false, error: "Invalid book." };
		const rows = await db
			.select()
			.from(capitalSmokeReports)
			.where(eq(capitalSmokeReports.book, book))
			.orderBy(capitalSmokeReports.startedAt);
		return { success: true, reports: rows };
	});
