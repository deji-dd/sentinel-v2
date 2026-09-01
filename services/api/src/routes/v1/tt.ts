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
			const [result] = await db
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
				.where(eq(userSessions.id, sessionToken));

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
			const blueprints = await db.select().from(territoryBlueprints);
			const states = await db.select().from(territoryStates);
			const items = await db.select().from(tornItems);
			const [pointsState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "points_market_price"));

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

					itemPrices[it.id] = price;
				}
			}

			// Format territory map matching TT Selector structure
			const territories: Record<string, unknown> = {};
			for (const b of blueprints) {
				const state = statesMap.get(b.id);
				const bpData = (
					b.data && typeof b.data === "object" ? b.data : {}
				) as Record<string, unknown>;

				let neighbors: string[] = [];
				if (Array.isArray(bpData.neighbors)) {
					neighbors = bpData.neighbors as string[];
				} else if (typeof bpData.neighbors === "string") {
					try {
						neighbors = JSON.parse(bpData.neighbors) as string[];
					} catch {
						neighbors = [];
					}
				}

				const racketData = (
					state?.racket && typeof state.racket === "object"
						? state.racket
						: null
				) as Record<string, unknown> | null;

				territories[b.id] = {
					id: b.id,
					sector: b.sector ?? 0,
					size: b.size ?? 0,
					density: b.density ?? 0,
					slots: b.slots ?? 0,
					respect:
						typeof bpData.respect === "number"
							? bpData.respect
							: typeof bpData.daily_respect === "number"
								? bpData.daily_respect
								: 0,
					coordinates: {
						x:
							typeof bpData.coordinate_x === "number" ? bpData.coordinate_x : 0,
						y:
							typeof bpData.coordinate_y === "number" ? bpData.coordinate_y : 0,
					},
					neighbors,
					racket: racketData?.name
						? {
								name: String(racketData.name),
								reward:
									typeof racketData.reward === "string" ||
									(typeof racketData.reward === "object" &&
										racketData.reward !== null)
										? racketData.reward
										: `${racketData.name} reward`,
								level:
									typeof racketData.level === "number"
										? racketData.level
										: null,
								placementDate:
									typeof racketData.placement_date === "number"
										? racketData.placement_date
										: typeof racketData.placementDate === "number"
											? racketData.placementDate
											: null,
							}
						: null,
					war: state?.isWarring
						? {
								factionId: state.factionId ?? null,
							}
						: null,
					factionId: state?.factionId ?? null,
				};
			}

			return {
				territories,
				prices: {
					items: itemPrices,
					points: pointsPrice,
				},
				pointsPrice,
				itemNames,
				itemPrices,
				totalTerritories: Object.keys(territories).length,
				updatedAt: new Date().toISOString(),
			};
		},
		{
			detail: {
				summary: "Get TT Selector Metadata",
				description:
					"Fetches all territory blueprints, current racket/war states, and dynamic pricing items.",
			},
		},
	)
	// ─── GET /api/v1/tt/state ──────────────────────────────────────────────────
	.get(
		"/state",
		async () => {
			const states = await db.select().from(territoryStates);
			const territories: Record<
				string,
				{
					factionId: number | null;
					racket: {
						name: string;
						reward: string | null;
						level: number | null;
						placementDate: number | null;
					} | null;
					war: {
						factionId: number | null;
					} | null;
				}
			> = {};

			for (const s of states) {
				const racketData = (
					s.racket && typeof s.racket === "object" ? s.racket : null
				) as Record<string, unknown> | null;

				territories[s.id] = {
					factionId: s.factionId,
					racket: racketData?.name
						? {
								name: String(racketData.name),
								reward:
									typeof racketData.reward === "string"
										? racketData.reward
										: null,
								level:
									typeof racketData.level === "number"
										? racketData.level
										: null,
								placementDate:
									typeof racketData.placement_date === "number"
										? racketData.placement_date
										: typeof racketData.placementDate === "number"
											? racketData.placementDate
											: null,
							}
						: null,
					war: s.isWarring
						? {
								factionId: s.factionId,
							}
						: null,
				};
			}

			return {
				territories,
				count: states.length,
				updatedAt: new Date().toISOString(),
			};
		},
		{
			detail: {
				summary: "Get Territory Dynamic States",
				description: "Returns lightweight territory states and racket info.",
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

			const maps = await db
				.select()
				.from(userMaps)
				.where(eq(userMaps.userId, user.id))
				.orderBy(desc(userMaps.updatedAt));

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
			const [map] = await db
				.select()
				.from(userMaps)
				.where(eq(userMaps.id, params.mapId));

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
				const [existing] = await db
					.select()
					.from(userMaps)
					.where(
						and(eq(userMaps.id, body.mapId), eq(userMaps.userId, user.id)),
					);

				if (existing) {
					await db
						.update(userMaps)
						.set({
							name: mapName,
							labels,
							assignments,
							isPublic: body.isPublic ?? existing.isPublic,
							updatedAt: new Date(),
						})
						.where(eq(userMaps.id, body.mapId));

					const [updated] = await db
						.select()
						.from(userMaps)
						.where(eq(userMaps.id, body.mapId));

					return { success: true, map: updated };
				}
			}

			const newId = crypto.randomUUID();
			await db.insert(userMaps).values({
				id: newId,
				userId: user.id,
				name: mapName,
				labels,
				assignments,
				isPublic: body.isPublic ?? false,
			});

			const [created] = await db
				.select()
				.from(userMaps)
				.where(eq(userMaps.id, newId));

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

			const [existing] = await db
				.select()
				.from(userMaps)
				.where(
					and(eq(userMaps.id, params.mapId), eq(userMaps.userId, user.id)),
				);

			if (!existing) {
				set.status = 404;
				return { error: "Map not found or not owned by user" };
			}

			await db.delete(userMaps).where(eq(userMaps.id, params.mapId));

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
