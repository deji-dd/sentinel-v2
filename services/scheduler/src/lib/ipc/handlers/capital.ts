import {
	capitalSmokeReports,
	db,
	getCapitalConfig,
	getCapitalState,
	resetCapitalPaperBook,
} from "@sentinel/database";
import type {
	CapitalAlertPayload,
	CapitalSmokeReport,
	IpcMessage,
} from "@sentinel/schemas";
import { computeNav, formatMoney, Logger } from "@sentinel/utils";

import { runCapitalEngineCycle } from "../../../workers/capital/engine";
import {
	beginPoolCallRecording,
	endPoolCallRecording,
	type PoolCallRecord,
} from "../../pool-key-request";
import type { IpcActionHandler } from "../types";

const logger = new Logger("SchedulerIPC", "CapitalSmoke");

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runs one full paper cycle on demand from the dashboard.
 *
 * The report is persisted before the response is sent, so a dropped IPC reply
 * still leaves an auditable record. The paper alert is emitted separately and
 * carries `[PAPER]` styling in the bot, never the live alert path.
 */
/**
 * Sends one labelled test alert through the same path a real trade alert uses.
 *
 * It never creates an order or touches the book: the point is to prove the
 * scheduler → IPC → bot → owner DM wiring without waiting for a signal.
 */
export const handleCapitalTestAlert: IpcActionHandler = async (ctx) => {
	const message = ctx.message as IpcMessage & { requestId?: string };
	const rawData =
		"data" in message && isRecord(message.data)
			? (message.data as Record<string, unknown>)
			: {};
	const book = rawData.book === "live" ? "live" : "paper";
	const link =
		book === "paper"
			? "https://stocks.blasted-labs.tech/desk/paper"
			: "https://stocks.blasted-labs.tech/desk";
	const payload: CapitalAlertPayload = {
		kind: "recommendation",
		book,
		title: "TEST ALERT — routing works",
		body: "This is a test alert from the desk. No order was created and no book was changed.",
		fields: [
			{
				name: "Mode",
				value: book === "paper" ? "SIMULATION — no real funds" : "LIVE",
				inline: true,
			},
		],
		link,
	};
	ctx.server.broadcast({ action: "capital_alert", data: payload });
	ctx.server.broadcast({
		action: "capital_test_alert_result",
		requestId: message.requestId,
		data: { success: true, book },
	});
};

export const handleCapitalSmokeTest: IpcActionHandler = async (ctx) => {
	const message = ctx.message as IpcMessage & { requestId?: string };
	const rawData =
		"data" in message && isRecord(message.data) ? message.data : {};
	const requestedCash =
		typeof rawData.startingCash === "string" ? rawData.startingCash : null;

	const startedAt = new Date();
	const steps: CapitalSmokeReport["steps"] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	let apiCalls: PoolCallRecord[] = [];
	let report: CapitalSmokeReport;

	beginPoolCallRecording();
	try {
		const config = await getCapitalConfig("paper");
		const startingCash = requestedCash ?? config.paperStartingCash;

		const resetStart = Date.now();
		await resetCapitalPaperBook(startingCash, null);
		steps.push({
			id: "reset",
			label: "Reset paper book",
			status: "completed",
			durationMs: Date.now() - resetStart,
			detail: `Seeded ${startingCash} of virtual cash.`,
			error: null,
		});

		const engineStart = Date.now();
		const result = await runCapitalEngineCycle({
			books: ["paper"],
			trigger: "smoke",
		});
		apiCalls = endPoolCallRecording();
		steps.push({
			id: "engine",
			label: "Engine cycle",
			status: result.errors.length > 0 ? "failed" : "completed",
			durationMs: Date.now() - engineStart,
			detail: `${result.stocksPolled} stocks polled, ${result.stocksScored} scored, ${result.recommendations} orders, ${result.paperFills} paper fills.`,
			error: result.errors[0] ?? null,
		});
		errors.push(...result.errors);
		if (result.stocksScored === 0) {
			warnings.push(
				"No stock had enough recorded history to score; run the smoke test again after a few market polls.",
			);
		}
		if (result.recommendations === 0) {
			warnings.push(
				"No entry or exit met the configured criteria. Early history (under 7 days) is the usual reason; the paper book keeps recording candles.",
			);
		}

		const reportId = crypto.randomUUID();
		const paperState = await getCapitalState("paper");
		const paperNav = computeNav({
			cash: paperState.cash,
			units: paperState.units,
			positions: paperState.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		});

		report = {
			id: reportId,
			book: "paper",
			startedAtIso: startedAt.toISOString(),
			finishedAtIso: new Date().toISOString(),
			status: errors.length > 0 ? "failed" : "completed",
			steps,
			apiCalls,
			dataAgeSeconds: result.dataAgeSeconds,
			stocksScored: result.stocksScored,
			recommendations: result.recommendations,
			simulatedFills: result.paperFills,
			navPerUnit: formatMoney(paperNav.navPerUnit),
			cash: formatMoney(paperNav.cash),
			errors,
			warnings,
			trigger: "manual",
		};

		await db.insert(capitalSmokeReports).values({
			id: report.id,
			book: "paper",
			startedAt: startedAt,
			finishedAt: new Date(),
			status: report.status,
			trigger: "manual",
			report: report as unknown as Record<string, unknown>,
		});
	} catch (error) {
		apiCalls = endPoolCallRecording();
		const messageText = error instanceof Error ? error.message : String(error);
		logger.error("Capital smoke test failed:", error);
		report = {
			id: crypto.randomUUID(),
			book: "paper",
			startedAtIso: startedAt.toISOString(),
			finishedAtIso: new Date().toISOString(),
			status: "failed",
			steps,
			apiCalls,
			dataAgeSeconds: null,
			stocksScored: 0,
			recommendations: 0,
			simulatedFills: 0,
			navPerUnit: null,
			cash: null,
			errors: [messageText],
			warnings,
			trigger: "manual",
		};
	}

	ctx.server.broadcast({
		action: "capital_smoke_result",
		requestId: message.requestId,
		data: report,
	});

	ctx.server.broadcast({
		action: "capital_paper_alert",
		data: {
			reportId: report.id,
			title: "[PAPER] Capital smoke test",
			summary: `${report.status === "completed" ? "Completed" : "Failed"}: ${report.stocksScored} scored, ${report.recommendations} orders, ${report.simulatedFills} fills${report.errors[0] ? ` — ${report.errors[0]}` : ""}`,
			success: report.status === "completed",
			link: "https://stocks.blasted-labs.tech/desk/paper",
		},
	});
};
