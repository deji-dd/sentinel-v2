import { db, eq, userSessions, users } from "@sentinel/database";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { verifyUserSharesGuildWithBot } from "../../lib/discord-auth";
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
			const [result] = await db
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
				.where(eq(userSessions.id, sessionToken));

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
				await db.delete(userSessions).where(eq(userSessions.id, sessionToken));
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
				result.user.role !== "owner"
			) {
				await db
					.update(users)
					.set({ role: "owner" })
					.where(eq(users.id, result.user.id));
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
		async ({ session, cookie }) => {
			if (session) {
				await db.delete(userSessions).where(eq(userSessions.id, session.id));
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
		({ query, redirect, request }) => {
			const redirectTo = query.redirect_to ?? "/";
			const url = new URL(request.url);
			const host = request.headers.get("host") ?? "localhost:3000";
			const protocol =
				url.protocol ||
				(request.headers.get("x-forwarded-proto")
					? `${request.headers.get("x-forwarded-proto")}:`
					: "http:");

			// If DISCORD_REDIRECT_URI is explicitly set, use it; otherwise compute based on current host
			const redirectUri =
				env.DISCORD_REDIRECT_URI ||
				`${protocol}//${host}/api/v1/auth/discord/callback`;

			const statePayload = JSON.stringify({
				returnTo: redirectTo,
				redirectUri,
			});

			const params = new URLSearchParams({
				client_id: env.DISCORD_CLIENT_ID,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: "identify guilds",
				state: Buffer.from(statePayload).toString("base64url"),
			});

			return redirect(
				`https://discord.com/api/oauth2/authorize?${params.toString()}`,
				302,
			);
		},
		{
			query: t.Object({
				redirect_to: t.Optional(t.String()),
			}),
			detail: {
				summary: "Discord OAuth2 Redirect",
				description: "Redirects the user to Discord OAuth2 authorization page.",
			},
		},
	)
	.get(
		"/discord/callback",
		async ({ query, cookie, redirect, request }) => {
			const code = query.code;
			const error = query.error;

			let returnTo = "/";
			let redirectUri = env.DISCORD_REDIRECT_URI;

			if (query.state) {
				try {
					const decoded = Buffer.from(query.state, "base64url").toString(
						"utf-8",
					);
					const parsed = JSON.parse(decoded) as {
						returnTo?: string;
						redirectUri?: string;
					};
					if (parsed.returnTo) returnTo = parsed.returnTo;
					if (parsed.redirectUri) redirectUri = parsed.redirectUri;
				} catch {
					returnTo = decodeURIComponent(query.state);
				}
			}

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
					redirect_uri: redirectUri,
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

			// Enforce server membership restriction: User must share a Discord server with Sentinel
			if (!isOwner) {
				const hasMutualGuild = await verifyUserSharesGuildWithBot(
					tokens.access_token,
					discordUser.id,
				);

				if (!hasMutualGuild) {
					const target =
						returnTo.startsWith("http://") || returnTo.startsWith("https://")
							? returnTo
							: returnTo.startsWith("/")
								? returnTo
								: `/${returnTo}`;
					const baseWithoutHash = target.split("#")[0];
					const separator = baseWithoutHash?.includes("?") ? "&" : "?";
					return redirect(
						`${baseWithoutHash}#/login${separator}error=no_mutual_server`,
						302,
					);
				}
			}

			// Upsert user in our DB by discordId
			const [existingUser] = await db
				.select()
				.from(users)
				.where(eq(users.discordId, discordUser.id));

			let user = existingUser;
			const displayName = discordUser.global_name ?? discordUser.username;
			const avatarUrl = discordUser.avatar
				? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
				: null;

			if (!user) {
				const [inserted] = await db
					.insert(users)
					.values({
						discordId: discordUser.id,
						username: displayName,
						avatar: avatarUrl,
						role: isOwner ? "owner" : "user",
					})
					.returning();
				user = inserted;
			} else {
				await db
					.update(users)
					.set({
						username: displayName,
						avatar: avatarUrl,
						...(isOwner && user.role !== "owner" && user.role !== "admin"
							? { role: "owner" }
							: {}),
					})
					.where(eq(users.discordId, discordUser.id));
				if (isOwner && user.role !== "owner" && user.role !== "admin") {
					user.role = "owner";
				}
			}

			if (!user) {
				return redirect("/#/login?error=user_creation_failed", 302);
			}

			// Store access token in session for guild fetching later
			const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
			const [newSession] = await db
				.insert(userSessions)
				.values({
					userId: user.id,
					expiresAt,
				})
				.returning();

			if (!newSession) {
				return redirect("/#/login?error=session_creation_failed", 302);
			}

			const host = request.headers.get("host") ?? "";
			const cookieDomain =
				env.NODE_ENV === "production"
					? ".blasted-labs.tech"
					: host.includes(".localhost")
						? ".localhost"
						: undefined;

			if (cookie.session) {
				cookie.session.set({
					value: newSession.id,
					httpOnly: true,
					secure: env.NODE_ENV === "production",
					sameSite: "lax",
					path: "/",
					domain: cookieDomain,
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
					domain: cookieDomain,
					maxAge: 7 * 86400,
				});
			}

			let targetRedirect = returnTo;
			if (
				!targetRedirect.startsWith("http://") &&
				!targetRedirect.startsWith("https://")
			) {
				targetRedirect = targetRedirect.startsWith("/")
					? targetRedirect
					: `/${targetRedirect}`;
			}

			if (targetRedirect.includes("#/login")) {
				targetRedirect = targetRedirect.replace(/#\/login.*/, "#/");
			}

			if (env.NODE_ENV !== "production") {
				const separator = targetRedirect.includes("#")
					? targetRedirect.includes("?")
						? "&"
						: "?"
					: "#/?";
				targetRedirect = `${targetRedirect}${separator}token=${newSession.id}`;
			}

			return redirect(targetRedirect, 302);
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

			const [existingUser] = await db
				.select()
				.from(users)
				.where(eq(users.username, username));

			let user = existingUser;

			if (!user) {
				const [inserted] = await db
					.insert(users)
					.values({
						username,
						role,
					})
					.returning();
				user = inserted;
			}

			if (!user) {
				return { success: false, error: "Failed to resolve demo user" };
			}

			const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
			const ipAddress = request.headers.get("x-forwarded-for") ?? "127.0.0.1";
			const userAgent = request.headers.get("user-agent") ?? "Unknown";

			const [newSession] = await db
				.insert(userSessions)
				.values({
					userId: user.id,
					expiresAt,
					ipAddress,
					userAgent,
				})
				.returning();

			if (session && newSession) {
				session.set({
					value: newSession.id,
					httpOnly: true,
					secure: process.env.NODE_ENV === "production",
					sameSite: "lax",
					path: "/",
					domain:
						process.env.NODE_ENV === "production"
							? ".blasted-labs.tech"
							: undefined,
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
					avatar: user.avatar,
					tornId: user.tornId,
				},

				sessionId: newSession?.id,
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
