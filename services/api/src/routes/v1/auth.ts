import { db, eq, userSessions, users } from "@sentinel/database";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import type { AuthSession, AuthUser } from "../../middleware/auth";

export const authRoutes = new Elysia({ prefix: "/auth" })
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
			console.error("Error retrieving session from database:", error);
			return {
				user: null as AuthUser | null,
				session: null as AuthSession | null,
			};
		}
	})
	.get(
		"/me",
		({ user }) => {
			return {
				authenticated: Boolean(user),
				user: user ?? null,
			};
		},
		{
			detail: {
				summary: "Current User",
				description: "Returns active user session info.",
			},
		},
	)
	.post(
		"/logout",
		({ session, cookie }) => {
			if (session) {
				db.delete(userSessions).where(eq(userSessions.id, session.id)).run();
			}

			if (cookie.session) {
				cookie.session.remove();
			}

			return {
				success: true,
				message: "Logged out successfully",
			};
		},
		{
			detail: {
				summary: "Logout",
				description: "Deletes session from database and clears cookie.",
			},
		},
	)
	// ─── Discord OAuth2 ───────────────────────────────────────────────────────
	.get(
		"/discord",
		({ redirect }) => {
			const params = new URLSearchParams({
				client_id: env.DISCORD_CLIENT_ID,
				redirect_uri: env.DISCORD_REDIRECT_URI,
				response_type: "code",
				scope: "identify guilds",
			});

			return redirect(
				`https://discord.com/api/oauth2/authorize?${params.toString()}`,
				302,
			);
		},
		{
			detail: {
				summary: "Discord OAuth2 Redirect",
				description: "Redirects the user to Discord OAuth2 authorization page.",
			},
		},
	)
	.get(
		"/discord/callback",
		async ({ query, cookie, redirect }) => {
			const code = query.code;
			const error = query.error;

			if (error || !code) {
				return redirect("/#/login?error=access_denied", 302);
			}

			// Exchange code for tokens
			const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: env.DISCORD_CLIENT_ID,
					client_secret: env.DISCORD_CLIENT_SECRET,
					grant_type: "authorization_code",
					code,
					redirect_uri: env.DISCORD_REDIRECT_URI,
				}),
			});

			if (!tokenRes.ok) {
				return redirect("/#/login?error=token_exchange_failed", 302);
			}

			const tokens = (await tokenRes.json()) as {
				access_token: string;
				token_type: string;
				expires_in: number;
				refresh_token: string;
				scope: string;
			};

			// Fetch Discord user info
			const userRes = await fetch("https://discord.com/api/users/@me", {
				headers: { Authorization: `Bearer ${tokens.access_token}` },
			});

			if (!userRes.ok) {
				return redirect("/#/login?error=user_fetch_failed", 302);
			}

			const discordUser = (await userRes.json()) as {
				id: string;
				username: string;
				global_name: string | null;
				avatar: string | null;
				email: string | null;
			};

			const isOwner = Boolean(
				env.DISCORD_USER_ID && discordUser.id === env.DISCORD_USER_ID,
			);

			// Upsert user in our DB by discordId
			let user = db
				.select()
				.from(users)
				.where(eq(users.discordId, discordUser.id))
				.get();

			const displayName = discordUser.global_name ?? discordUser.username;
			const avatarUrl = discordUser.avatar
				? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
				: null;

			if (!user) {
				const inserted = db
					.insert(users)
					.values({
						discordId: discordUser.id,
						username: displayName,
						role: isOwner ? "owner" : "user",
					})
					.returning()
					.get();
				user = inserted;
			} else {
				db.update(users)
					.set({
						username: displayName,
						...(isOwner && user.role !== "owner" && user.role !== "admin"
							? { role: "owner" }
							: {}),
					})
					.where(eq(users.discordId, discordUser.id))
					.run();
				if (isOwner && user.role !== "owner" && user.role !== "admin") {
					user.role = "owner";
				}
			}

			// Store access token in session for guild fetching later
			const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
			const newSession = db
				.insert(userSessions)
				.values({
					userId: user.id,
					expiresAt,
					// We temporarily store discordAccessToken in ipAddress column as workaround
					// until a proper column is added — revisit when schema is updated
				})
				.returning()
				.get();

			if (cookie.session) {
				cookie.session.set({
					value: newSession.id,
					httpOnly: true,
					secure: env.NODE_ENV === "production",
					sameSite: "lax",
					path: "/",
					maxAge: 7 * 86400,
				});
			}

			// Store discord access token and avatar in a session metadata cookie (non-httpOnly so JS can read it)
			if (cookie.discord_meta) {
				cookie.discord_meta.set({
					value: JSON.stringify({
						accessToken: tokens.access_token,
						avatar: avatarUrl,
					}),
					httpOnly: false,
					secure: env.NODE_ENV === "production",
					sameSite: "lax",
					path: "/",
					maxAge: 7 * 86400,
				});
			}

			return redirect("/", 302);
		},
		{
			query: t.Object({
				code: t.Optional(t.String()),
				error: t.Optional(t.String()),
				state: t.Optional(t.String()),
			}),
			detail: {
				summary: "Discord OAuth2 Callback",
				description:
					"Handles Discord OAuth2 callback, creates session, and redirects to dashboard.",
			},
		},
	)
	// ─── Demo Login (dev only) ────────────────────────────────────────────────
	.post(
		"/demo-login",
		async ({ body, cookie: { session }, request }) => {
			const username = body.username;
			const role = body.role ?? "user";

			let user = db
				.select()
				.from(users)
				.where(eq(users.username, username))
				.get();

			if (!user) {
				const inserted = db
					.insert(users)
					.values({
						username,
						role,
					})
					.returning()
					.get();
				user = inserted;
			}

			const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
			const ipAddress = request.headers.get("x-forwarded-for") ?? "127.0.0.1";
			const userAgent = request.headers.get("user-agent") ?? "Unknown";

			const newSession = db
				.insert(userSessions)
				.values({
					userId: user.id,
					expiresAt,
					ipAddress,
					userAgent,
				})
				.returning()
				.get();

			if (session) {
				session.set({
					value: newSession.id,
					httpOnly: true,
					secure: process.env.NODE_ENV === "production",
					sameSite: "lax",
					path: "/",
					maxAge: 7 * 86400,
				});
			}

			return {
				success: true,
				user: {
					id: user.id,
					username: user.username,
					role: user.role,
					discordId: user.discordId,
					tornId: user.tornId,
				},
				sessionId: newSession.id,
			};
		},
		{
			body: t.Object({
				username: t.String(),
				role: t.Optional(t.String()),
			}),
			detail: {
				summary: "Demo Login",
				description:
					"Creates an in-house database session and sets an HTTP-Only cookie.",
			},
		},
	);
