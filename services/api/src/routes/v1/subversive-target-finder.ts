import { createHmac } from "node:crypto";
import {
	and,
	db,
	eq,
	subversiveTargetFinderTargets,
	subversiveTargetFinderUsers,
} from "@sentinel/database";
import {
	decryptApiKey,
	encryptApiKey,
	getFFScouterTargets,
	getPlayerStats,
	hashApiKey,
	isValidApiKey,
	TornApiClient,
} from "@sentinel/torn-api";
import { type Context, Elysia, t } from "elysia";
import {
	type CachedUserSession,
	type CurrentWarInfo,
	subversiveTargetCache,
} from "../../lib/subversive-target-cache";

const SUBVERSIVE_FACTION_ID = 2013;

interface TornProfileResponse {
	player_id?: number;
	name?: string;
	faction?: {
		faction_id?: number;
		faction_name?: string;
	} | null;
	strength?: number;
	speed?: number;
	defense?: number;
	dexterity?: number;
	total?: number;
}

interface TornBattlestatsResponse {
	strength?: number;
	speed?: number;
	defense?: number;
	dexterity?: number;
	total?: number;
}

function calculateBsScore(
	str: number,
	spd: number,
	def: number,
	dex: number,
): number {
	return (
		Math.sqrt(Math.max(0, str)) +
		Math.sqrt(Math.max(0, spd)) +
		Math.sqrt(Math.max(0, def)) +
		Math.sqrt(Math.max(0, dex))
	);
}

function extractBearerToken(authHeader?: string | null): string | null {
	if (!authHeader) return null;
	const parts = authHeader.split(" ");
	if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
		return parts[1] ?? null;
	}
	return null;
}

function generateUserToken(tornId: number, apiKeyHash: string): string {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	const sig = createHmac("sha256", masterKey)
		.update(`${tornId}:${apiKeyHash}`)
		.digest("hex")
		.slice(0, 32);
	return `satf_${tornId}_${sig}`;
}

export async function resolveUserSession(
	token: string,
): Promise<CachedUserSession | null> {
	let session = subversiveTargetCache.getUserByToken(token);
	if (session?.isActive) return session;

	const match = token.match(/^satf_(\d+)_([a-f0-9]+)$/);
	if (!match) return null;

	const tornId = Number.parseInt(match[1] ?? "", 10);
	const providedSig = match[2] ?? "";
	if (!tornId || !providedSig) return null;

	const [userRow] = await db
		.select()
		.from(subversiveTargetFinderUsers)
		.where(
			and(
				eq(subversiveTargetFinderUsers.tornId, tornId),
				eq(subversiveTargetFinderUsers.isActive, true),
			),
		);

	if (!userRow) return null;

	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	const expectedSig = createHmac("sha256", masterKey)
		.update(`${tornId}:${userRow.apiKeyHash}`)
		.digest("hex")
		.slice(0, 32);

	if (providedSig !== expectedSig) return null;

	session = {
		tornId: userRow.tornId,
		tornName: userRow.tornName,
		bsScore: userRow.bsScore,
		token,
		isActive: userRow.isActive,
		expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
		statsCachedAt: userRow.statsCachedAt.getTime(),
		apiKeyEncrypted: userRow.apiKeyEncrypted,
	};
	subversiveTargetCache.setUserSession(session);
	return session;
}

export const subversiveTargetFinderRoutes = new Elysia({
	prefix: "/target-finder",
})
	// Initialize in-memory cache
	.onStart(async () => {
		await subversiveTargetCache.initialize();
	})

	// ─── POST /auth (Validate Faction 2013 & Issue Session Token) ───────────────
	.post(
		"/auth",
		async ({ body, set }) => {
			const trimmedKey = (body?.apiKey ?? "").trim();
			if (!isValidApiKey(trimmedKey)) {
				set.status = 400;
				return {
					success: false,
					error:
						"Invalid Torn API key format. Must be a 16-character alphanumeric string.",
				};
			}

			let profile: TornProfileResponse | null = null;
			let battlestats: TornBattlestatsResponse | null = null;

			const client = new TornApiClient();

			try {
				profile = await client.getRaw<TornProfileResponse>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "profile" },
				});
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Torn API verification failed.";
				set.status = 400;
				return {
					success: false,
					error: `Torn API Verification Failed: ${msg}`,
				};
			}

			// Try fetching battlestats (succeeds with Limited/Full keys, throws with Public keys)
			try {
				battlestats = await client.getRaw<TornBattlestatsResponse>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "battlestats" },
				});
			} catch {
				// Key is Public Access only. Fall back to FFScouter below.
			}

			const tornId = profile?.player_id;
			const playerName = profile?.name ?? `Player ${tornId}`;
			const factionId = profile?.faction?.faction_id;

			if (!tornId) {
				set.status = 400;
				return {
					success: false,
					error: "Could not retrieve player profile from Torn.",
				};
			}

			// STRICT FACTION 2013 ENFORCEMENT
			if (factionId !== SUBVERSIVE_FACTION_ID) {
				set.status = 403;
				return {
					success: false,
					error:
						"Access Denied: You must be an active member of Subversive Alliance (Faction 2013) to use this tool.",
				};
			}

			let str = Number(battlestats?.strength ?? profile?.strength ?? 0);
			let spd = Number(battlestats?.speed ?? profile?.speed ?? 0);
			let def = Number(battlestats?.defense ?? profile?.defense ?? 0);
			let dex = Number(battlestats?.dexterity ?? profile?.dexterity ?? 0);
			let bsScore = calculateBsScore(str, spd, def, dex);

			// If key is Public Access (battlestats was inaccessible), look up score via FFScouter
			if (bsScore <= 0) {
				try {
					const [ffResult] = await getPlayerStats([tornId]);
					if (ffResult?.bs_estimate && ffResult.bs_estimate > 0) {
						if (ffResult.distribution?.stats_percentage) {
							const strPct =
								(ffResult.distribution.stats_percentage.strength ?? 25) / 100;
							const spdPct =
								(ffResult.distribution.stats_percentage.speed ?? 25) / 100;
							const defPct =
								(ffResult.distribution.stats_percentage.defense ?? 25) / 100;
							const dexPct =
								(ffResult.distribution.stats_percentage.dexterity ?? 25) / 100;

							str = ffResult.bs_estimate * strPct;
							spd = ffResult.bs_estimate * spdPct;
							def = ffResult.bs_estimate * defPct;
							dex = ffResult.bs_estimate * dexPct;
							bsScore = calculateBsScore(str, spd, def, dex);
						} else {
							bsScore = 2 * Math.sqrt(ffResult.bs_estimate);
						}
					}
				} catch {
					// Continue with minimum score if FFScouter also doesn't have it
				}
			}

			// Fallback baseline score if brand new account with no stats
			if (bsScore <= 0) {
				bsScore = 100;
			}

			const pepper = process.env.API_KEY_HASH_PEPPER ?? "";
			const apiKeyHash = hashApiKey(trimmedKey, pepper);
			const masterKey = process.env.ENCRYPTION_KEY ?? "";
			const apiKeyEncrypted = encryptApiKey(trimmedKey, masterKey);

			const token = generateUserToken(tornId, apiKeyHash);
			const now = new Date();

			// Persist user in DB
			await db
				.insert(subversiveTargetFinderUsers)
				.values({
					tornId,
					tornName: playerName,
					apiKeyEncrypted,
					apiKeyHash,
					bsScore,
					battleStats: {
						strength: str,
						speed: spd,
						defense: def,
						dexterity: dex,
						total: str + spd + def + dex,
					},
					statsCachedAt: now,
					isActive: true,
					lastSeenAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: subversiveTargetFinderUsers.tornId,
					set: {
						tornName: playerName,
						apiKeyEncrypted,
						apiKeyHash,
						bsScore,
						battleStats: {
							strength: str,
							speed: spd,
							defense: def,
							dexterity: dex,
							total: str + spd + def + dex,
						},
						statsCachedAt: now,
						isActive: true,
						lastSeenAt: now,
						updatedAt: now,
					},
				});

			// Cache session in RAM for ultra-fast queries
			subversiveTargetCache.setUserSession({
				tornId,
				tornName: playerName,
				bsScore,
				token,
				isActive: true,
				expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
				statsCachedAt: now.getTime(),
			});

			return {
				success: true,
				token,
				user: {
					tornId,
					tornName: playerName,
					bsScore: Number(bsScore.toFixed(2)),
					statsCachedAt: now.toISOString(),
				},
			};
		},
		{
			body: t.Object({
				apiKey: t.String(),
			}),
		},
	)

	// ─── GET /targets/next (RAM-Served Next Matching Target) ────────────────────
	.get("/targets/next", async ({ headers, query, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return {
				success: false,
				error: "Session expired or membership revoked. Please re-authenticate.",
			};
		}

		const minFF = Number.parseFloat((query.minFF as string) || "1.5");
		const maxFF = Number.parseFloat((query.maxFF as string) || "3.0");
		const factionlessOnly = query.factionlessOnly === "true";
		const inactiveOnly = query.inactiveOnly === "true";

		const rawExclude = (query.exclude as string) || "";
		const excludeIds = new Set(
			rawExclude
				.split(",")
				.map((id) => Number.parseInt(id.trim(), 10))
				.filter((id) => Number.isInteger(id) && id > 0),
		);

		let target = subversiveTargetCache.findNextTarget({
			attackerScore: session.bsScore,
			minFF,
			maxFF,
			factionlessOnly,
			inactiveOnly,
			excludeIds,
		});

		// ─── On-Demand Fallback: Query FFScouter directly for requested FF range ───
		if (!target) {
			try {
				const freshTargets = await getFFScouterTargets({
					minff: minFF,
					maxff: maxFF,
					factionless: factionlessOnly ? 1 : 0,
					inactiveonly: inactiveOnly ? 1 : 0,
					limit: 20,
				});

				const now = new Date();
				for (const t of freshTargets) {
					if (!t.player_id || t.player_id <= 0) continue;
					const score =
						t.bs_estimate && t.bs_estimate > 0
							? 2 * Math.sqrt(t.bs_estimate)
							: 0;
					const isFactionless = !t.faction_id || t.faction_id === 0;

					await db
						.insert(subversiveTargetFinderTargets)
						.values({
							targetId: t.player_id,
							name: t.name ?? `Player ${t.player_id}`,
							level: t.level ?? 1,
							factionId: t.faction_id ?? null,
							factionName: t.faction_name ?? null,
							daysOld: 30,
							isInactive: inactiveOnly,
							isFactionless,
							inHospital: false,
							hospitalUntil: null,
							estimatedBs: t.bs_estimate ?? 0,
							estimatedScore: score,
							status: "okay",
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: subversiveTargetFinderTargets.targetId,
							set: {
								name: t.name ? t.name : undefined,
								level: t.level ? t.level : undefined,
								factionId: t.faction_id ?? null,
								factionName: t.faction_name ?? null,
								estimatedBs: t.bs_estimate ?? 0,
								estimatedScore: score,
								updatedAt: now,
							},
						});

					subversiveTargetCache.addOrUpdate({
						targetId: t.player_id,
						name: t.name ?? `Player ${t.player_id}`,
						level: t.level ?? 1,
						factionId: t.faction_id ?? null,
						factionName: t.faction_name ?? null,
						daysOld: 30,
						lastAction: null,
						isInactive: inactiveOnly,
						isFactionless,
						inHospital: false,
						estimatedBs: t.bs_estimate ?? 0,
						estimatedScore: score,
					});
				}

				// Retry pick after on-demand insertion
				target = subversiveTargetCache.findNextTarget({
					attackerScore: session.bsScore,
					minFF,
					maxFF,
					factionlessOnly,
					inactiveOnly,
					excludeIds,
				});
			} catch {
				// Continue if FFScouter on-demand query fails
			}
		}

		if (!target) {
			return {
				success: false,
				message:
					"No matching targets found within your specified Fair Fight range and filters.",
				totalPoolCount: subversiveTargetCache.getTotalTargetsCount(),
			};
		}

		// Keep member's lastSeenAt fresh for activity tracking
		void db
			.update(subversiveTargetFinderUsers)
			.set({ lastSeenAt: new Date() })
			.where(eq(subversiveTargetFinderUsers.tornId, session.tornId))
			.catch(() => {});

		return {
			success: true,
			target,
			member: {
				tornId: session.tornId,
				tornName: session.tornName,
			},
		};
	})

	// ─── POST /targets/:id/hit (Report Target Attack / Hospitalization) ────────
	.post("/targets/:id/hit", async ({ headers, params, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Unauthorized." };
		}

		const targetId = Number.parseInt(params.id, 10);
		if (targetId > 0) {
			subversiveTargetCache.evict(targetId);
			const now = new Date();
			const hospitalUntil = new Date(now.getTime() + 15 * 60 * 1000);
			await db
				.update(subversiveTargetFinderTargets)
				.set({
					inHospital: true,
					hospitalUntil,
					status: "hospital",
					updatedAt: now,
				})
				.where(eq(subversiveTargetFinderTargets.targetId, targetId));
		}

		return { success: true };
	})

	// ─── GET /me (Current User Status & Stats) ──────────────────────────────────
	.get("/me", async ({ headers, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Invalid or expired session." };
		}

		return {
			success: true,
			user: {
				tornId: session.tornId,
				tornName: session.tornName,
				bsScore: Number(session.bsScore.toFixed(2)),
				statsCachedAt: new Date(session.statsCachedAt).toISOString(),
				isActive: session.isActive,
			},
		};
	})

	// ─── POST /refresh-stats (Force Refresh Own Stats from Torn API) ─────────────
	.post("/refresh-stats", async ({ headers, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Invalid or expired session." };
		}

		const [userRow] = await db
			.select()
			.from(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.tornId, session.tornId));

		if (!userRow) {
			set.status = 404;
			return { success: false, error: "User record not found." };
		}

		const masterKey = process.env.ENCRYPTION_KEY ?? "";
		let plainApiKey: string;
		try {
			plainApiKey = decryptApiKey(userRow.apiKeyEncrypted, masterKey);
		} catch {
			set.status = 500;
			return { success: false, error: "Failed to decrypt stored API key." };
		}

		try {
			const client = new TornApiClient();
			const battlestats = await client.getRaw<TornBattlestatsResponse>(
				"user/",
				{
					apiKey: plainApiKey,
					queryParams: { selections: "battlestats" },
				},
			);

			const str = Number(battlestats?.strength ?? 0);
			const spd = Number(battlestats?.speed ?? 0);
			const def = Number(battlestats?.defense ?? 0);
			const dex = Number(battlestats?.dexterity ?? 0);
			const newBsScore = calculateBsScore(str, spd, def, dex);
			const now = new Date();

			await db
				.update(subversiveTargetFinderUsers)
				.set({
					bsScore: newBsScore,
					battleStats: {
						strength: str,
						speed: spd,
						defense: def,
						dexterity: dex,
						total: str + spd + def + dex,
					},
					statsCachedAt: now,
					updatedAt: now,
				})
				.where(eq(subversiveTargetFinderUsers.tornId, session.tornId));

			session.bsScore = newBsScore;
			session.statsCachedAt = now.getTime();
			subversiveTargetCache.setUserSession(session);

			return {
				success: true,
				bsScore: Number(newBsScore.toFixed(2)),
				statsCachedAt: now.toISOString(),
			};
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed to refresh stats.";
			set.status = 500;
			return { success: false, error: msg };
		}
	})

	// ─── GET /war/status (Current Ranked War State & Intel) ────────────────────
	.get("/war/status", async ({ headers, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Session expired or invalid." };
		}

		let war = subversiveTargetCache.getWarState();
		if (
			(war.state === "no_war" || war.target === null) &&
			session.apiKeyEncrypted
		) {
			try {
				const masterKey = process.env.ENCRYPTION_KEY ?? "";
				const plainKey = decryptApiKey(session.apiKeyEncrypted, masterKey);
				if (plainKey && plainKey.length === 16) {
					const client = new TornApiClient();
					const warsRes = (await client.get("/faction/{id}/wars", {
						apiKey: plainKey,
						pathParams: { id: SUBVERSIVE_FACTION_ID },
					})) as {
						wars?: {
							ranked?: {
								war_id: number;
								start: number;
								end: number | null;
								target: number;
								winner: number | null;
								factions: Array<{
									id: number;
									name: string;
									score: number;
									chain: number;
								}>;
							} | null;
						};
					};

					const ranked = warsRes.wars?.ranked;
					if (ranked && ranked.end === null && ranked.winner === null) {
						const factions = ranked.factions ?? [];
						const saFaction = factions.find(
							(f) => f.id === SUBVERSIVE_FACTION_ID,
						);
						const oppFaction = factions.find(
							(f) => f.id !== SUBVERSIVE_FACTION_ID,
						);
						const nowSec = Math.floor(Date.now() / 1000);

						const newWar: CurrentWarInfo = {
							state: nowSec >= ranked.start ? "active" : "scheduled",
							warId: ranked.war_id,
							start: ranked.start,
							target: ranked.target,
							winner: ranked.winner,
							opponent: oppFaction
								? {
										id: oppFaction.id,
										name: oppFaction.name,
										score: oppFaction.score,
										chain: oppFaction.chain,
									}
								: null,
							subversive: saFaction
								? {
										id: saFaction.id,
										name: saFaction.name,
										score: saFaction.score,
										chain: saFaction.chain,
									}
								: null,
							lastUpdated: Date.now(),
						};
						subversiveTargetCache.setWarState(newWar);
						war = newWar;
					}
				}
			} catch {
				// Non-fatal, fallback to cached state
			}
		}

		const opponents = subversiveTargetCache.getWarOpponents();

		let lead = 0;
		if (war.subversive && war.opponent) {
			lead = war.subversive.score - war.opponent.score;
		}

		return {
			success: true,
			war: {
				...war,
				lead,
			},
			totalOpponents: opponents.length,
			opponentIds:
				war.state === "active" || war.state === "scheduled"
					? opponents.map((o) => o.id)
					: [],
		};
	})

	// ─── GET /war/targets/next (Get Next Attackable Ranked War Target) ──────────
	.get("/war/targets/next", async ({ headers, query, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Session expired or invalid." };
		}

		// Attacker state verification (flight / travel locking)
		const attackerState = (
			(headers["x-attacker-state"] as string) ||
			(query.attackerState as string) ||
			""
		)
			.toLowerCase()
			.trim();

		if (attackerState === "traveling" || attackerState === "abroad") {
			return {
				success: false,
				allowed: false,
				reason: `Target requests locked while ${attackerState}. Return to Torn to resume war operations.`,
				target: null,
			};
		}

		const war = subversiveTargetCache.getWarState();
		const rawExclude = (query.exclude as string) || "";
		const excludeIds = new Set(
			rawExclude
				.split(",")
				.map((id) => Number.parseInt(id.trim(), 10))
				.filter((id) => Number.isInteger(id) && id > 0),
		);

		const minFF = query.minFF
			? Number.parseFloat(query.minFF as string)
			: undefined;
		const maxFF = query.maxFF
			? Number.parseFloat(query.maxFF as string)
			: undefined;
		const maxBS = query.maxBS
			? Number.parseFloat(query.maxBS as string)
			: undefined;

		if (war.state !== "active" && war.state !== "scheduled") {
			return {
				success: false,
				message: "No active ranked war.",
				target: null,
				war,
			};
		}

		const target = subversiveTargetCache.getNextWarTarget({
			attackerBsScore: session.bsScore,
			excludeIds,
			minFF,
			maxFF,
			maxBS,
		});

		if (!target) {
			return {
				success: false,
				message:
					"No targets currently available matching criteria. Check hospital queue or settings.",
				target: null,
				war,
			};
		}

		return {
			success: true,
			target,
			war,
			member: {
				tornId: session.tornId,
				tornName: session.tornName,
			},
		};
	})

	// ─── GET /war/targets/:id (Opponent or Target Intel Details for Attack HUD) ──
	.get("/war/targets/:id", async ({ headers, params, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Session expired or invalid." };
		}

		const targetId = Number.parseInt(params.id, 10);
		if (!targetId || Number.isNaN(targetId)) {
			set.status = 400;
			return { success: false, error: "Invalid target ID." };
		}

		const target = await subversiveTargetCache.getTargetOrOpponentDetails(
			targetId,
			session.bsScore,
		);

		return {
			success: true,
			isWarTarget: target.isWarTarget,
			target,
		};
	})

	// ─── GET /war/targets/available (List of Current Attackable War Targets) ────
	.get("/war/targets/available", async ({ headers, query, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Session expired or invalid." };
		}

		const rawExclude = (query.exclude as string) || "";
		const excludeIds = new Set(
			rawExclude
				.split(",")
				.map((id) => Number.parseInt(id.trim(), 10))
				.filter((id) => Number.isInteger(id) && id > 0),
		);

		const targets = subversiveTargetCache.getAvailableWarTargets({
			attackerBsScore: session.bsScore,
			excludeIds,
		});

		return {
			success: true,
			targets,
			total: targets.length,
			war: subversiveTargetCache.getWarState(),
		};
	})

	// ─── GET /war/hospital-queue (Opponents Exiting Hospital Soon) ──────────────
	.get("/war/hospital-queue", async ({ headers, query, set }) => {
		const token = extractBearerToken(headers.authorization);
		if (!token) {
			set.status = 401;
			return { success: false, error: "Authentication token required." };
		}

		const session = await resolveUserSession(token);
		if (!session?.isActive) {
			set.status = 401;
			return { success: false, error: "Session expired or invalid." };
		}

		const limit = Math.min(
			50,
			Math.max(1, Number.parseInt((query.limit as string) || "15", 10)),
		);
		const queue = subversiveTargetCache.getHospitalQueue({
			limit,
			attackerBsScore: session.bsScore,
		});

		return {
			success: true,
			queue,
		};
	})

	// ─── GET /script & /script.user.js (Serve Userscript Directly for 1-Click Install) ────────────
	.get("/script", async ({ query, set }) => {
		return serveUserscript(query, set);
	})
	.get("/script.user.js", async ({ query, set }) => {
		return serveUserscript(query, set);
	});

async function serveUserscript(query: { env?: string }, set: Context["set"]) {
	try {
		const primaryPath = `${process.cwd()}/scripts/subversive-alliance.user.js`;
		const fallbackPath = `${process.cwd()}/scripts/subversive-target-finder.user.js`;
		let file = Bun.file(primaryPath);
		if (!(await file.exists())) {
			file = Bun.file(fallbackPath);
		}
		if (!(await file.exists())) {
			set.status = 404;
			return "Userscript file not found.";
		}
		let content = await file.text();
		if (query.env === "dev") {
			content = content
				.replace(
					/apiUrl:\s*"https:\/\/subversive\.blasted-labs\.tech"/g,
					'apiUrl: "http://localhost:3000"',
				)
				.replace(
					/@name\s+Subversive Alliance(?: - (?:Target Finder|Ranked War Engine))?/,
					"@name         Subversive Alliance (DEV)",
				);
		}
		set.headers["content-type"] = "text/javascript; charset=utf-8";
		set.headers["cache-control"] = "no-cache";
		return content;
	} catch (_err) {
		set.status = 500;
		return "Failed to read userscript file.";
	}
}
