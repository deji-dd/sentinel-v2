import { db, eq, userSessions, users } from "@sentinel/database";
import { Elysia } from "elysia";
import { env } from "../config/env";
import { logger } from "../lib/logger";

export interface AuthUser {
	id: number;
	discordId: string | null;
	tornId: number | null;
	username: string;
	avatar: string | null;
	role: string;
}

export interface AuthSession {
	id: string;
	userId: number;
	expiresAt: Date | number;
}

/**
 * Auth plugin for session cookie extraction & database validation.
 */
export const authPlugin = new Elysia({ name: "authPlugin" })
	.derive({ as: "scoped" }, async ({ cookie }) => {
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
						avatar: users.avatar,
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

			const expiresAt = result.session.expiresAt;
			const expiresAtMs =
				expiresAt instanceof Date
					? expiresAt.getTime()
					: typeof expiresAt === "number"
						? expiresAt < 1e11
							? expiresAt * 1000
							: expiresAt
						: 0;

			if (expiresAtMs < Date.now()) {
				// Expired session cleanup
				db.delete(userSessions).where(eq(userSessions.id, sessionToken)).run();
				cookie.session?.remove();

				return {
					user: null as AuthUser | null,
					session: null as AuthSession | null,
				};
			}

			if (
				result.user.discordId &&
				env.DISCORD_USER_ID &&
				result.user.discordId === env.DISCORD_USER_ID &&
				result.user.role === "user"
			) {
				db.update(users)
					.set({ role: "owner" })
					.where(eq(users.id, result.user.id))
					.run();
				result.user.role = "owner";
			}

			return {
				user: result.user as AuthUser,
				session: result.session as AuthSession,
			};
		} catch (error) {
			logger.error("Error retrieving session from database:", error);
			return {
				user: null as AuthUser | null,
				session: null as AuthSession | null,
			};
		}
	})
	.macro(({ onBeforeHandle }) => ({
		requireAuth(role?: string) {
			onBeforeHandle((context: Record<string, unknown>) => {
				const user = context.user as AuthUser | null;
				const set = context.set as { status?: number };
				if (!user) {
					set.status = 401;
					return {
						success: false,
						error: "Unauthorized",
					};
				}

				if (role && user.role !== role) {
					set.status = 403;
					return {
						success: false,
						error: "Forbidden",
					};
				}
			});
		},
	}));
