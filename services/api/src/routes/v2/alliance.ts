import {
	allianceApiKeys,
	and,
	db,
	desc,
	eq,
	getAllianceGuildId,
	guildConfigs,
	isNull,
	or,
} from "@sentinel/database";
import {
	clearAllianceKeyPoolCache,
	encryptApiKey,
	hashApiKey,
	healAllianceKeyNames,
	isValidApiKey,
	PublicKeyRequiredError,
	verifyPublicApiKey,
} from "@sentinel/torn-api";
import { Elysia, t } from "elysia";

import { syncAllianceKeyDonationViaIpc } from "../../lib/bot-ipc";
import { authPlugin } from "../../middleware/auth";
import { verifyGuildAdmin } from "./guilds";

async function requireAllianceAdmin(
	user: { role?: string; discordId?: string | null } | null | undefined,
	set: { status?: number | string },
): Promise<string | null> {
	const guildId = getAllianceGuildId();
	if (!guildId) {
		set.status = 400;
		return null;
	}
	if (!(await verifyGuildAdmin(user, guildId))) {
		set.status = 403;
		return null;
	}
	return guildId;
}

async function ensureGuildConfig(guildId: string): Promise<void> {
	await db
		.insert(guildConfigs)
		.values({ guildId })
		.onConflictDoNothing({ target: guildConfigs.guildId });
}

/** Keys explicitly donated for the Alliance guild plus the imported global pool. */
function visibleAllianceKeys(guildId: string) {
	return or(
		isNull(allianceApiKeys.guildId),
		eq(allianceApiKeys.guildId, guildId),
	);
}

export const allianceRoutes = new Elysia({ prefix: "/alliance" })
	.use(authPlugin)
	// ─── GET /v2/alliance/key-pool ────────────────────────────────────────
	.get(
		"/key-pool",
		async ({ user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}

			await ensureGuildConfig(guildId);
			const [config] = await db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, guildId));

			const keys = await db
				.select({
					id: allianceApiKeys.id,
					tornId: allianceApiKeys.tornId,
					tornName: allianceApiKeys.tornName,
					isValid: allianceApiKeys.isValid,
					invalidCount: allianceApiKeys.invalidCount,
					donatedByDiscordId: allianceApiKeys.donatedByDiscordId,
					donatedByDiscordTag: allianceApiKeys.donatedByDiscordTag,
					lastUsedAt: allianceApiKeys.lastUsedAt,
					createdAt: allianceApiKeys.createdAt,
				})
				.from(allianceApiKeys)
				.where(visibleAllianceKeys(guildId))
				.orderBy(desc(allianceApiKeys.createdAt));

			return {
				keys,
				channelId: config?.keyDonationChannelId ?? null,
			};
		},
		{
			detail: {
				summary: "Fetch Alliance Key Pool",
				description:
					"Lists public keys in the shared Alliance territory key pool.",
			},
		},
	)
	// ─── POST /v2/alliance/key-pool ───────────────────────────────────────
	.post(
		"/key-pool",
		async ({ body, user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}

			const rawKey = body.apiKey.trim();
			if (!isValidApiKey(rawKey)) {
				set.status = 400;
				return {
					error:
						"Invalid Torn API key format. Must be a 16-character alphanumeric string.",
				};
			}

			let verified;
			try {
				verified = await verifyPublicApiKey(rawKey);
			} catch (err) {
				set.status = 400;
				if (err instanceof PublicKeyRequiredError) {
					return { error: err.message };
				}
				return {
					error:
						err instanceof Error
							? err.message
							: "Torn API verification failed.",
				};
			}

			const keyHash = hashApiKey(rawKey, process.env.API_KEY_HASH_PEPPER ?? "");
			const [duplicate] = await db
				.select({ id: allianceApiKeys.id })
				.from(allianceApiKeys)
				.where(eq(allianceApiKeys.apiKeyHash, keyHash));
			if (duplicate) {
				set.status = 400;
				return { error: "This API key is already in the Alliance key pool." };
			}

			const [inserted] = await db
				.insert(allianceApiKeys)
				.values({
					guildId,
					tornId: verified.tornId,
					tornName: verified.tornName,
					apiKeyEncrypted: encryptApiKey(
						rawKey,
						process.env.ENCRYPTION_KEY ?? "",
					),
					apiKeyHash: keyHash,
					isValid: true,
					invalidCount: 0,
					donatedByDiscordId: user?.discordId ?? null,
					donatedByDiscordTag: user?.username ?? "Dashboard Admin",
				})
				.returning({
					id: allianceApiKeys.id,
					tornId: allianceApiKeys.tornId,
					tornName: allianceApiKeys.tornName,
					isValid: allianceApiKeys.isValid,
					createdAt: allianceApiKeys.createdAt,
				});
			clearAllianceKeyPoolCache();

			return { success: true, key: inserted };
		},
		{
			body: t.Object({ apiKey: t.String() }),
			detail: {
				summary: "Add Alliance Key",
				description:
					"Verifies a Public Only Torn API key and adds it to the Alliance key pool.",
			},
		},
	)
	// ─── DELETE /v2/alliance/key-pool/:id ─────────────────────────────────
	.delete(
		"/key-pool/:id",
		async ({ params, user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}

			const deleted = await db
				.delete(allianceApiKeys)
				.where(
					and(
						eq(allianceApiKeys.id, params.id),
						eq(allianceApiKeys.guildId, guildId),
					),
				)
				.returning({ id: allianceApiKeys.id });

			if (deleted.length === 0) {
				set.status = 404;
				return { error: "API key not found." };
			}
			clearAllianceKeyPoolCache();
			return { success: true };
		},
		{
			params: t.Object({ id: t.String() }),
			detail: { summary: "Remove Alliance Key" },
		},
	)
	// ─── POST /v2/alliance/key-pool/resolve-names ─────────────────────────
	.post(
		"/key-pool/resolve-names",
		async ({ user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}
			const healed = await healAllianceKeyNames({ force: true });
			return { success: true, healed };
		},
		{
			detail: {
				summary: "Resolve Alliance Key Names",
				description:
					"Fetches Torn display names for imported keys that were seeded without one.",
			},
		},
	)
	// ─── GET /v2/alliance/key-donation-channel ────────────────────────────
	.get(
		"/key-donation-channel",
		async ({ user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}
			const [config] = await db
				.select({
					channelId: guildConfigs.keyDonationChannelId,
				})
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, guildId));
			return { channelId: config?.channelId ?? null };
		},
		{
			detail: {
				summary: "Get Alliance Key Donation Channel",
				description:
					"Fetches the channel hosting the persistent donation embed.",
			},
		},
	)
	// ─── PUT /v2/alliance/key-donation-channel ────────────────────────────
	.put(
		"/key-donation-channel",
		async ({ body, user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}
			await ensureGuildConfig(guildId);

			const newChannelId = body.channelId?.trim() || null;
			await db
				.update(guildConfigs)
				.set({
					keyDonationChannelId: newChannelId,
					keyDonationEmbedMessageId: null,
					updatedAt: new Date(),
				})
				.where(eq(guildConfigs.guildId, guildId));

			void syncAllianceKeyDonationViaIpc(guildId);
			return { success: true, channelId: newChannelId };
		},
		{
			body: t.Object({ channelId: t.Nullable(t.String()) }),
			detail: {
				summary: "Set Alliance Key Donation Channel",
				description: "Configures or disables the persistent donation embed.",
			},
		},
	)
	// ─── POST /v2/alliance/key-donation-channel/sync ──────────────────────
	.post(
		"/key-donation-channel/sync",
		async ({ user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) {
				return {
					error:
						set.status === 403
							? "Forbidden"
							: "Alliance server is not configured.",
				};
			}
			void syncAllianceKeyDonationViaIpc(guildId);
			return { success: true };
		},
		{
			detail: {
				summary: "Sync Alliance Key Donation Embed",
				description: "Asks the bot to refresh or repost the donation embed.",
			},
		},
	);
