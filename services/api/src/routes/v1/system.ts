import { apiKeys, db, desc, eq, userSessions, users } from "@sentinel/database";
import { encryptApiKey, hashApiKey, TornApiClient } from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { battlestatsLedgerRoutes } from "./battlestats-ledger";
import { companyRoutes } from "./company";
import { crimeLedgerRoutes } from "./crime-ledger";

export interface AuthUser {
	id: number;
	discordId: string | null;
	tornId: number | null;
	username: string | null;
	avatar: string | null;
	role: string;
}

export const systemRoutes = new Elysia({ prefix: "/system" })
	.use(crimeLedgerRoutes)
	.use(battlestatsLedgerRoutes)
	.use(companyRoutes)
	.derive(async ({ cookie }) => {
		const sessionToken = cookie.sentinel_session?.value;
		if (typeof sessionToken !== "string" || !sessionToken) {
			return {
				user: null as AuthUser | null,
			};
		}

		try {
			const [result] = await db
				.select({
					id: users.id,
					discordId: users.discordId,
					tornId: users.tornId,
					username: users.username,
					avatar: users.avatar,
					role: users.role,
				})
				.from(userSessions)
				.innerJoin(users, eq(userSessions.userId, users.id))
				.where(eq(userSessions.id, sessionToken));

			return {
				user: (result ?? null) as AuthUser | null,
			};
		} catch {
			return {
				user: null as AuthUser | null,
			};
		}
	})
	.onBeforeHandle(({ user, set }) => {
		const isDev =
			process.env.NODE_ENV === "development" || env.NODE_ENV === "development";
		if (isDev) return;

		const isAdmin =
			user?.role === "admin" ||
			user?.role === "owner" ||
			(Boolean(env.DISCORD_USER_ID) && user?.discordId === env.DISCORD_USER_ID);

		if (!isAdmin) {
			set.status = 403;
			return {
				error: "Forbidden: Admin access required for system management.",
			};
		}
	})
	// GET /api/v1/system/keys — list all system & registered API keys
	.get(
		"/keys",
		async () => {
			const keys = await db
				.select({
					id: apiKeys.id,
					userId: apiKeys.userId,
					keyType: apiKeys.keyType,
					isValid: apiKeys.isValid,
					invalidCount: apiKeys.invalidCount,
					lastInvalidAt: apiKeys.lastInvalidAt,
					lastUsedAt: apiKeys.lastUsedAt,
					createdAt: apiKeys.createdAt,
				})
				.from(apiKeys)
				.orderBy(desc(apiKeys.createdAt));

			return { keys };
		},
		{
			detail: {
				summary: "List System API Keys",
				description: "Returns all registered API keys in the system key pool.",
			},
		},
	)
	// POST /api/v1/system/keys — register a new API key to the system pool
	.post(
		"/keys",
		async ({ body, set }) => {
			const trimmedKey = body.apiKey.trim();
			if (trimmedKey.length !== 16) {
				set.status = 400;
				return {
					error:
						"Invalid Torn API key format. Key must be a 16-character string.",
				};
			}

			const keyHash = hashApiKey(
				trimmedKey,
				process.env.API_KEY_HASH_PEPPER ?? "",
			);

			// Check duplicate key
			const [existingKey] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.apiKeyHash, keyHash));

			if (existingKey) {
				set.status = 400;
				return {
					error: "This API key has already been added to the system.",
				};
			}

			// Verify key against Torn API first
			let tornUserId: number | null = null;
			let playerName = "Unknown";
			try {
				const client = new TornApiClient();
				const profile = await client.getRaw<{
					player_id?: number;
					name?: string;
				}>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "profile" },
				});
				tornUserId = profile?.player_id ?? null;
				playerName = profile?.name ?? `Player ${tornUserId}`;
				if (!tornUserId) {
					set.status = 400;
					return {
						error: "Failed to extract valid Torn Player ID from Torn API key.",
					};
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Torn API verification failed.";
				set.status = 400;
				return {
					error: `Torn API Verification Failed: ${errorMessage}`,
				};
			}

			const keyEncrypted = encryptApiKey(
				trimmedKey,
				process.env.ENCRYPTION_KEY ?? "",
			);
			const keyType = body.keyType ?? "system";

			const [inserted] = await db
				.insert(apiKeys)
				.values({
					userId: tornUserId,
					apiKeyEncrypted: keyEncrypted,
					apiKeyHash: keyHash,
					keyType,
					isValid: true,
					invalidCount: 0,
				})
				.returning({
					id: apiKeys.id,
					userId: apiKeys.userId,
					keyType: apiKeys.keyType,
					isValid: apiKeys.isValid,
					createdAt: apiKeys.createdAt,
				});

			return {
				success: true,
				key: inserted,
				playerName,
			};
		},
		{
			body: t.Object({
				apiKey: t.String(),
				keyType: t.Optional(
					t.Union([t.Literal("system"), t.Literal("personal")]),
				),
			}),
			detail: {
				summary: "Register System API Key",
				description:
					"Verifies with Torn API, encrypts, and stores a new API key in the system pool.",
			},
		},
	)
	// DELETE /api/v1/system/keys/:keyId — remove an API key from system
	.delete(
		"/keys/:keyId",
		async ({ params, set }) => {
			const [existing] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.id, params.keyId));

			if (!existing) {
				set.status = 404;
				return { error: "API key not found." };
			}

			await db.delete(apiKeys).where(eq(apiKeys.id, params.keyId));

			return { success: true };
		},
		{
			params: t.Object({
				keyId: t.String(),
			}),
			detail: {
				summary: "Delete System API Key",
				description: "Removes an API key from the central system pool.",
			},
		},
	)
	// PATCH /api/v1/system/keys/:keyId — toggle validity or reset errors
	.patch(
		"/keys/:keyId",
		async ({ params, body, set }) => {
			const [existing] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.id, params.keyId));

			if (!existing) {
				set.status = 404;
				return { error: "API key not found." };
			}

			await db
				.update(apiKeys)
				.set({
					...(body.isValid !== undefined ? { isValid: body.isValid } : {}),
					...(body.resetErrors ? { invalidCount: 0, lastInvalidAt: null } : {}),
					updatedAt: new Date(),
				})
				.where(eq(apiKeys.id, params.keyId));

			return { success: true };
		},
		{
			params: t.Object({
				keyId: t.String(),
			}),
			body: t.Object({
				isValid: t.Optional(t.Boolean()),
				resetErrors: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Update System API Key",
				description: "Updates API key validity or resets error counter.",
			},
		},
	);
