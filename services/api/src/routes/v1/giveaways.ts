import {
	and,
	count,
	db,
	desc,
	type ElimsGiveawayConfig,
	eq,
	giveawayEntries,
	giveaways,
	inArray,
	systemStates,
} from "@sentinel/database";
import { Elysia, t } from "elysia";
import { syncElimsGiveawaysViaIpc } from "../../lib/bot-ipc";
import { authPlugin } from "../../middleware/auth";
import { verifyElimsAdmin } from "./elims";

const ELIMS_CONFIG_ID = "elims:guild_config";
const ELIMS_GIVEAWAYS_CONFIG_ID = "elims:giveaways_config";

async function getElimsGuildId(): Promise<string | null> {
	const [existing] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, ELIMS_CONFIG_ID));

	if (!existing?.init || !existing.data) return null;
	const data = existing.data as { guildId?: string };
	return data.guildId ?? null;
}

export const giveawayRoutes = new Elysia({ prefix: "/elims/giveaways" })
	.use(authPlugin)

	// ─── GET /api/v1/elims/giveaways/config ──────────────────────────────────
	.get(
		"/config",
		async ({ user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const [sysState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_GIVEAWAYS_CONFIG_ID));

			const config = (sysState?.data as ElimsGiveawayConfig | undefined) ?? {
				announcementChannelId: null,
				managerChannelId: null,
				managerRoleIds: [],
				updatedAt: new Date().toISOString(),
			};

			return { config };
		},
		{
			detail: {
				summary: "Get Giveaway Configuration",
				description:
					"Fetches announcement channel, manager channel, and manager roles for giveaways.",
			},
		},
	)

	// ─── POST /api/v1/elims/giveaways/config ─────────────────────────────────
	.post(
		"/config",
		async ({ body, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const guildId = await getElimsGuildId();
			if (!guildId) {
				set.status = 400;
				return { error: "Elims tournament server is not configured." };
			}

			const updatedConfig: ElimsGiveawayConfig = {
				announcementChannelId: body.announcementChannelId ?? null,
				managerChannelId: body.managerChannelId ?? null,
				managerRoleIds: body.managerRoleIds ?? [],
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: ELIMS_GIVEAWAYS_CONFIG_ID,
					init: true,
					data: updatedConfig as unknown as Record<string, unknown>,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: updatedConfig as unknown as Record<string, unknown>,
						updatedAt: new Date(),
					},
				});

			// Notify bot to update or ensure giveaway embeds
			void syncElimsGiveawaysViaIpc(guildId);

			return { success: true, config: updatedConfig };
		},
		{
			body: t.Object({
				announcementChannelId: t.Nullable(t.String()),
				managerChannelId: t.Optional(t.Nullable(t.String())),
				managerRoleIds: t.Optional(t.Array(t.String())),
			}),
			detail: {
				summary: "Update Giveaway Configuration",
				description: "Saves channel settings and manager roles for giveaways.",
			},
		},
	)

	// ─── GET /api/v1/elims/giveaways ─────────────────────────────────────────
	.get(
		"/",
		async ({ query, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const guildId = await getElimsGuildId();
			if (!guildId) {
				return { giveaways: [], total: 0 };
			}

			const page = Math.max(1, Number(query.page ?? 1));
			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
			const offset = (page - 1) * limit;

			const conditions = [eq(giveaways.guildId, guildId)];
			if (query.status && query.status !== "all") {
				conditions.push(eq(giveaways.status, query.status));
			}

			const items = await db
				.select()
				.from(giveaways)
				.where(and(...conditions))
				.orderBy(desc(giveaways.createdAt))
				.limit(limit)
				.offset(offset);

			const [totalCountRes] = await db
				.select({ val: count() })
				.from(giveaways)
				.where(and(...conditions));

			const total = totalCountRes?.val ?? 0;

			// Fetch entry counts for these giveaways in batch
			const itemIds = items.map((i) => i.id);
			const entryCountMap = new Map<string, number>();

			if (itemIds.length > 0) {
				const entryCounts = await db
					.select({
						giveawayId: giveawayEntries.giveawayId,
						val: count(),
					})
					.from(giveawayEntries)
					.where(inArray(giveawayEntries.giveawayId, itemIds))
					.groupBy(giveawayEntries.giveawayId);

				for (const ec of entryCounts) {
					entryCountMap.set(ec.giveawayId, ec.val);
				}
			}

			const enrichedItems = items.map((gw) => ({
				...gw,
				entriesCount: entryCountMap.get(gw.id) ?? 0,
			}));

			return {
				giveaways: enrichedItems,
				total,
				page,
				limit,
			};
		},
		{
			query: t.Object({
				status: t.Optional(t.String()),
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Giveaways",
				description:
					"Returns active and historical giveaways with entry counts and winners.",
			},
		},
	)

	// ─── POST /api/v1/elims/giveaways/:id/cancel ─────────────────────────────
	.post(
		"/:id/cancel",
		async ({ params, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const guildId = await getElimsGuildId();
			if (!guildId) {
				set.status = 400;
				return { error: "Elims tournament server is not configured." };
			}

			const [giveaway] = await db
				.select()
				.from(giveaways)
				.where(eq(giveaways.id, params.id));

			if (!giveaway) {
				set.status = 404;
				return { error: "Giveaway not found." };
			}

			if (giveaway.status !== "active") {
				set.status = 400;
				return { error: "Only active giveaways can be cancelled." };
			}

			await db
				.update(giveaways)
				.set({
					status: "cancelled",
					updatedAt: new Date(),
				})
				.where(eq(giveaways.id, params.id));

			void syncElimsGiveawaysViaIpc(guildId);

			return { success: true };
		},
		{
			params: t.Object({ id: t.String() }),
			detail: {
				summary: "Cancel Giveaway",
				description: "Cancels an active giveaway without rolling winners.",
			},
		},
	);
