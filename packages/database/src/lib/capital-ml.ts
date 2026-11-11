import { and, desc, eq, isNull, lt } from "drizzle-orm";

import { db } from "../../index";
import {
	type CapitalMlModelRow,
	capitalMlModels,
	type CapitalMlPredictionRow,
	capitalMlPredictions,
	type NewCapitalMlModelRow,
	type NewCapitalMlPredictionRow,
} from "../schema/capital";

/** The model the engine should use, or null when nothing has been trained. */
export async function getActiveCapitalMlModel(): Promise<CapitalMlModelRow | null> {
	const [row] = await db
		.select()
		.from(capitalMlModels)
		.where(eq(capitalMlModels.active, true))
		.orderBy(desc(capitalMlModels.trainedAt))
		.limit(1);
	return row ?? null;
}

export async function getCapitalMlModel(
	id: string,
): Promise<CapitalMlModelRow | null> {
	const [row] = await db
		.select()
		.from(capitalMlModels)
		.where(eq(capitalMlModels.id, id))
		.limit(1);
	return row ?? null;
}

export async function listCapitalMlModels(
	limit = 10,
): Promise<CapitalMlModelRow[]> {
	return db
		.select()
		.from(capitalMlModels)
		.orderBy(desc(capitalMlModels.trainedAt))
		.limit(limit);
}

/** Inserts a trained model; optionally makes it the only active row. */
export async function insertCapitalMlModel(
	model: NewCapitalMlModelRow,
	options: { activate?: boolean } = {},
): Promise<CapitalMlModelRow> {
	return db.transaction(async (tx) => {
		if (options.activate) {
			await tx
				.update(capitalMlModels)
				.set({ active: false, updatedAt: new Date() })
				.where(eq(capitalMlModels.active, true));
		}
		const [row] = await tx
			.insert(capitalMlModels)
			.values({ ...model, active: options.activate ?? false })
			.returning();
		if (!row) throw new Error("Failed to insert capital ML model.");
		return row;
	});
}

export async function insertCapitalMlPrediction(
	row: NewCapitalMlPredictionRow,
): Promise<CapitalMlPredictionRow> {
	const [created] = await db
		.insert(capitalMlPredictions)
		.values(row)
		.returning();
	if (!created) throw new Error("Failed to insert capital ML prediction.");
	return created;
}

/** Predictions whose horizon has elapsed and whose outcome is not filled yet. */
export async function getPendingCapitalMlPredictions(
	before: Date,
	limit = 200,
): Promise<CapitalMlPredictionRow[]> {
	return db
		.select()
		.from(capitalMlPredictions)
		.where(
			and(
				isNull(capitalMlPredictions.evaluatedAt),
				lt(capitalMlPredictions.createdAt, before),
			),
		)
		.orderBy(capitalMlPredictions.createdAt)
		.limit(limit);
}

export async function completeCapitalMlPrediction(
	id: string,
	outcome: { realizedReturnPct: number; barrierHit: 0 | 1 },
): Promise<void> {
	await db
		.update(capitalMlPredictions)
		.set({
			evaluatedAt: new Date(),
			realizedReturnPct: outcome.realizedReturnPct,
			barrierHit: outcome.barrierHit,
		})
		.where(eq(capitalMlPredictions.id, id));
}
