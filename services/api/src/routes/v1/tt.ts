import type { MapLabel } from "@sentinel/database";
import {
	and,
	db,
	desc,
	eq,
	systemStates,
	territoryBlueprints,
	territoryStates,
	tornItems,
	userMaps,
	userSessions,
	users,
} from "@sentinel/database";
import { Elysia, t } from "elysia";
import type { AuthSession, AuthUser } from "../../middleware/auth";

export const ttRoutes = new Elysia({ prefix: "/tt" })
	.derive(async ({ cookie }) => {
		const sessionToken = cookie.session?.value;

		if (typeof sessionToken !== "string" || !sessionToken) {
			return {
				user: null as AuthUser | null,
				session: null as AuthSession | null,
			};
		}

		try {
			const result = db
				.select({
					user: {
						id: users.id,
						discordId: users.discordId,
						tornId: users.tornId,
						username: users.username,
						role: users.role,
					},
					session: {
						id: userSessions.id,
						userId: userSessions.userId,
						expiresAt: userSessions.expiresAt,
					},
				})
				.from(userSessions)
				.innerJoin(users, eq(userSessions.userId, users.id))
				.where(eq(userSessions.id, sessionToken))
				.get();

			if (!result) {
				return {
					user: null as AuthUser | null,
					session: null as AuthSession | null,
				};
			}

			return {
				user: result.user as AuthUser,
				session: result.session as AuthSession,
			};
		} catch {
			return {
				user: null as AuthUser | null,
				session: null as AuthSession | null,
			};
		}
	})
	// ─── GET /api/v1/tt/metadata ───────────────────────────────────────────────
	.get(
		"/metadata",
		async ({ set }) => {
			const blueprints = db.select().from(territoryBlueprints).all();
			const states = db.select().from(territoryStates).all();
			const items = db.select().from(tornItems).all();
			const pointsState = db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "points_market_price"))
				.get();

			if (blueprints.length === 0) {
				set.status = 503;
				return {
					error:
						"Territory database is uninitialized or empty. Please run territory data sync.",
				};
			}

			const statesMap = new Map(states.map((s) => [s.id, s]));

			let pointsPrice = 0;
			if (pointsState?.data && typeof pointsState.data === "object") {
				const pointsData = pointsState.data as Record<string, unknown>;
				if (typeof pointsData.price === "number") {
					pointsPrice = pointsData.price;
				}
			}

			const itemNames: Record<string, string> = {};
			const itemPrices: Record<string, number> = {};

			for (const it of items) {
				if (it.name) {
					itemNames[it.id] = it.name;
				}
				if (it.data && typeof it.data === "object") {
					const data = it.data as Record<string, unknown>;
					let price = 0;

					if (typeof data.market_value === "number") {
						price = data.market_value;
					} else if (
						data.value &&
						typeof data.value === "object" &&
						typeof (data.value as Record<string, unknown>).market_price ===
							"number"
					) {
						price = (data.value as Record<string, unknown>)
							.market_price as number;
					} else if (typeof data.market_price === "number") {
						price = data.market_price;
					}

					if (price > 0) {
						itemPrices[it.id] = price;
						if (it.name) {
							itemPrices[it.name] = price;
						}
					}
				}
			}

			const territories: Record<
				string,
				{
					sector: number;
					respect: number;
					size: number;
					density: number;
					slots: number;
					racket?: {
						name: string;
						reward:
							| string
							| {
									type: string;
									quantity: number;
									id: number | null;
							  };
					};
				}
			> = {};

			for (const bp of blueprints) {
				let respect = 0;

				if (bp.data && typeof bp.data === "object") {
					const bpData = bp.data as Record<string, unknown>;
					if (typeof bpData.daily_respect === "number") {
						respect = bpData.daily_respect;
					} else if (typeof bpData.respect === "number") {
						respect = bpData.respect;
					}
				}

				const state = statesMap.get(bp.id);
				let racketMeta:
					| {
							name: string;
							reward:
								| string
								| {
										type: string;
										quantity: number;
										id: number | null;
								  };
					  }
					| undefined;

				if (state?.racket && typeof state.racket === "object") {
					const r = state.racket as Record<string, unknown>;
					if (typeof r.name === "string") {
						racketMeta = {
							name: r.name,
							reward:
								(r.reward as
									| string
									| {
											type: string;
											quantity: number;
											id: number | null;
									  }) ?? `${r.name} reward`,
						};
					}
				}

				territories[bp.id] = {
					sector: bp.sector ?? 0,
					respect,
					size: bp.size ?? 0,
					density: bp.density ?? 0,
					slots: bp.slots ?? 0,
					...(racketMeta ? { racket: racketMeta } : {}),
				};
			}

			return {
				territories,
				prices: {
					items: itemPrices,
					points: pointsPrice,
				},
				itemNames,
			};
		},

		{
			detail: {
				summary: "Territory Metadata",
				description:
					"Returns territory blueprints, active rackets, and price metadata for map valuation.",
			},
		},
	)
	// ─── GET /api/v1/tt/maps ───────────────────────────────────────────────────
	.get(
		"/maps",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return {
					maps: [],
					error: "Unauthorized",
				};
			}

			const maps = db
				.select()
				.from(userMaps)
				.where(eq(userMaps.userId, user.id))
				.orderBy(desc(userMaps.updatedAt))
				.all();

			return {
				maps,
			};
		},
		{
			detail: {
				summary: "Get User Maps",
				description:
					"Returns all territory maps belonging to the logged-in user.",
			},
		},
	)
	// ─── GET /api/v1/tt/maps/:mapId ───────────────────────────────────────────
	.get(
		"/maps/:mapId",
		async ({ user, params, set }) => {
			const map = db
				.select()
				.from(userMaps)
				.where(eq(userMaps.id, params.mapId))
				.get();

			if (!map) {
				set.status = 404;
				return { error: "Map not found" };
			}

			if (!map.isPublic && (!user || map.userId !== user.id)) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			return { map };
		},
		{
			params: t.Object({ mapId: t.String() }),
			detail: {
				summary: "Get Map by ID",
				description: "Fetches a specific territory map by ID.",
			},
		},
	)
	// ─── POST /api/v1/tt/maps ──────────────────────────────────────────────────
	.post(
		"/maps",
		async ({ user, body, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const mapName = body.name.trim() || "Untitled Map";
			const labels = body.labels as MapLabel[];
			const assignments = body.assignments as Record<string, string>;

			if (body.mapId) {
				const existing = db
					.select()
					.from(userMaps)
					.where(and(eq(userMaps.id, body.mapId), eq(userMaps.userId, user.id)))
					.get();

				if (existing) {
					db.update(userMaps)
						.set({
							name: mapName,
							labels,
							assignments,
							isPublic: body.isPublic ?? existing.isPublic,
							updatedAt: new Date(),
						})
						.where(eq(userMaps.id, body.mapId))
						.run();

					const updated = db
						.select()
						.from(userMaps)
						.where(eq(userMaps.id, body.mapId))
						.get();

					return { success: true, map: updated };
				}
			}

			const newId = crypto.randomUUID();
			db.insert(userMaps)
				.values({
					id: newId,
					userId: user.id,
					name: mapName,
					labels,
					assignments,
					isPublic: body.isPublic ?? false,
				})
				.run();

			const created = db
				.select()
				.from(userMaps)
				.where(eq(userMaps.id, newId))
				.get();

			return { success: true, map: created };
		},
		{
			body: t.Object({
				mapId: t.Optional(t.String()),
				name: t.String(),
				labels: t.Array(
					t.Object({
						id: t.String(),
						text: t.String(),
						color: t.String(),
						enabled: t.Boolean(),
						territories: t.Array(t.String()),
						respect: t.Number(),
						sectors: t.Number(),
						rackets: t.Number(),
					}),
				),
				assignments: t.Record(t.String(), t.String()),
				isPublic: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Create or Save User Map",
				description: "Saves territory assignments and labels for a user map.",
			},
		},
	)
	// ─── DELETE /api/v1/tt/maps/:mapId ─────────────────────────────────────────
	.delete(
		"/maps/:mapId",
		async ({ user, params, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const existing = db
				.select()
				.from(userMaps)
				.where(and(eq(userMaps.id, params.mapId), eq(userMaps.userId, user.id)))
				.get();

			if (!existing) {
				set.status = 404;
				return { error: "Map not found or not owned by user" };
			}

			db.delete(userMaps).where(eq(userMaps.id, params.mapId)).run();

			return { success: true };
		},
		{
			params: t.Object({ mapId: t.String() }),
			detail: {
				summary: "Delete User Map",
				description: "Deletes a custom user map.",
			},
		},
	);
