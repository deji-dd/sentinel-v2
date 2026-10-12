import { createHmac } from "node:crypto";
import {
	and,
	db,
	eq,
	subversiveTargetFinderTargets,
	subversiveTargetFinderUsers,
	tornUsers,
} from "@sentinel/database";
import type { UserProfileResponse } from "@sentinel/schemas";
import {
	decryptApiKey,
	encryptApiKey,
	getFFScouterTargets,
	getPlayerStats,
	hashApiKey,
	isValidApiKey,
	TEMPORARY_DISABLE_ERROR_CODES,
	TORN_ERROR_CODES,
	TornApiClient,
	TornError,
	tornApi,
} from "@sentinel/torn-api";
import {
	describeSubversiveFamilyFactions,
	getSubversiveFactionName,
	isAttackableInTorn,
	isHospitalStatus,
	isSubversiveFamilyFaction,
	Logger,
	resolveSubversiveFactionId,
	tornStateSlug,
} from "@sentinel/utils";
import { type Context, Elysia, t } from "elysia";
import {
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
	subversiveKeyHealthManager,
} from "../../lib/subversive-key-pool";
import {
	type CachedUserSession,
	type CurrentWarInfo,
	type MatchedTargetResult,
	subversiveTargetCache,
} from "../../lib/subversive-target-cache";
import { subversiveWarEventManager } from "../../lib/subversive-war-events";

const logger = new Logger("API", "SubversiveTargetFinder");

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

/**
 * Torn error codes that mean the *key* cannot serve the request, as opposed to
 * the target being unavailable (code 6 "Incorrect ID" and friends). A check
 * failing on one of these is the member's key problem, not a missing target,
 * and must be reported as such.
 */
const KEY_UNUSABLE_ERROR_CODES = new Set([1, 2, 5, 9, 10, 13, 14, 16, 18]);

/**
 * Wall-clock budget for a single chain-target scout.
 *
 * The 20-check cap only bounds a press when Torn answers promptly: it says
 * nothing about how long 20 sequential round trips actually take, and the Torn
 * client's own request timeout is 30s, so one slow call can hold the press open
 * far past the point where the connection is still alive. Bun closes a
 * connection that has been idle for `idleTimeout` — 10s by default, and this
 * service does not raise it — so a handler that runs longer than that is
 * answered with a dropped request instead of a result, and the member cannot
 * tell a hung scout from a broken tool.
 *
 * 8s leaves room for candidate selection (including the FFScouter fallback),
 * the per-candidate DB writes and the response itself, so the press always ends
 * in a real answer. Tunable per environment without touching the logic.
 */
const DEFAULT_VERIFICATION_BUDGET_MS = 8_000;

function verificationBudgetMs(): number {
	const configured = Number(process.env.SUBVERSIVE_VERIFICATION_BUDGET_MS);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_VERIFICATION_BUDGET_MS;
}

/** Returned by `awaitWithinDeadline` when the scout runs out of wall clock. */
const BUDGET_SPENT = Symbol("verification-budget-spent");

/**
 * Awaits `promise` only until `deadline`, giving up with `BUDGET_SPENT` if the
 * budget runs out first. Abandoning the call is deliberate: the underlying
 * request keeps running under the client's own 30s timeout, which is longer
 * than the whole press is allowed to take.
 */
function awaitWithinDeadline<T>(
	promise: Promise<T>,
	deadline: number,
): Promise<T | typeof BUDGET_SPENT> {
	// The abandoned request can still settle (or fail) later; keep that rejection
	// observed so it never surfaces as an unhandled rejection.
	void promise.catch(() => {});

	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return Promise.resolve(BUDGET_SPENT);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<typeof BUDGET_SPENT>((resolve) => {
		timer = setTimeout(() => resolve(BUDGET_SPENT), remainingMs);
	});

	return Promise.race([promise, expiry]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function describeTornError(error: TornError): string {
	const known = TORN_ERROR_CODES[error.code];
	return `${known ?? error.message} (Torn error ${error.code})`;
}

/**
 * Decrypts the requesting member's own Torn API key.
 *
 * Sessions cached by `/auth` are seeded in RAM without the encrypted key, so a
 * miss falls back to the persisted row and hydrates the cache for later
 * requests instead of paying for a query every time.
 */
export async function resolveMemberApiKey(
	session: CachedUserSession,
): Promise<string | null> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";

	const decrypt = (encrypted?: string | null): string | null => {
		if (!encrypted || !masterKey) return null;
		try {
			const plain = decryptApiKey(encrypted, masterKey);
			return isValidApiKey(plain) ? plain : null;
		} catch {
			return null;
		}
	};

	const cachedKey = decrypt(session.apiKeyEncrypted);
	if (cachedKey) return cachedKey;

	const [userRow] = await db
		.select({ apiKeyEncrypted: subversiveTargetFinderUsers.apiKeyEncrypted })
		.from(subversiveTargetFinderUsers)
		.where(eq(subversiveTargetFinderUsers.tornId, session.tornId));

	const memberKey = decrypt(userRow?.apiKeyEncrypted);
	if (!memberKey || !userRow) return null;

	session.apiKeyEncrypted = userRow.apiKeyEncrypted;
	subversiveTargetCache.setUserSession(session);
	return memberKey;
}

/**
 * True while the member's key is inside a Torn-imposed cooldown. Both trackers
 * are consulted: this service's Subversive pool and the Torn client that marks
 * keys on the errors it observes directly.
 */
function isMemberKeyCoolingDown(apiKey: string): boolean {
	return (
		subversiveKeyHealthManager.isKeyTemporarilyDisabled(apiKey) ||
		tornApi.keyHealthManager.isKeyTemporarilyDisabled(apiKey)
	);
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
		factionId: resolveSubversiveFactionId(userRow.factionId),
		factionName:
			userRow.factionName ?? getSubversiveFactionName(userRow.factionId),
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
			const rawFactionId = profile?.faction?.faction_id;
			const factionName =
				profile?.faction?.faction_name ??
				getSubversiveFactionName(rawFactionId);

			if (!tornId) {
				set.status = 400;
				return {
					success: false,
					error: "Could not retrieve player profile from Torn.",
				};
			}

			// FAMILY FACTION ENFORCEMENT (2013 Subversive Alliance / 27312 SA Succession)
			if (!isSubversiveFamilyFaction(rawFactionId)) {
				set.status = 403;
				return {
					success: false,
					error: `Access Denied: You must be an active member of ${describeSubversiveFamilyFactions()} to use this tool.`,
				};
			}

			const factionId = resolveSubversiveFactionId(rawFactionId);

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
					factionId,
					factionName,
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
						factionId,
						factionName,
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

			// Write-through to general tornUsers registry
			await db
				.insert(tornUsers)
				.values({
					tornId,
					name: playerName,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: tornUsers.tornId,
					set: {
						name: playerName,
						updatedAt: now,
					},
				})
				.catch(() => {});

			// Cache session in RAM for ultra-fast queries. The encrypted key
			// travels with it so on-demand chain-target checks can run the
			// member's own key from the very first request.
			subversiveTargetCache.setUserSession({
				tornId,
				tornName: playerName,
				factionId,
				factionName,
				bsScore,
				token,
				isActive: true,
				expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
				statsCachedAt: now.getTime(),
				apiKeyEncrypted,
			});

			return {
				success: true,
				token,
				user: {
					tornId,
					tornName: playerName,
					factionId,
					factionName,
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

	// ─── GET /targets/next (On-Demand Burst-Verified Next Target) ───────────────
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

		// The budget covers everything from here on — candidate selection and the
		// optional FFScouter fallback included — because what has to stay inside
		// the connection ceiling is the whole press, not just the checks.
		const verificationDeadline = Date.now() + verificationBudgetMs();

		const minFF = Number.parseFloat((query.minFF as string) || "1.2");
		const maxFF = Number.parseFloat((query.maxFF as string) || "3.0");
		const clampedMinFF = Math.max(1.0, minFF);
		const clampedMaxFF = Math.min(3.0, maxFF);

		const rawIgnore =
			(query.ignore as string) || (query.exclude as string) || "";
		const ignoreIds = new Set(
			rawIgnore
				.split(",")
				.map((id) => Number.parseInt(id.trim(), 10))
				.filter((id) => Number.isInteger(id) && id > 0),
		);

		// 1. Get candidate targets matching attacker's FF score bracket
		let candidates = subversiveTargetCache.getCandidatesForVerification({
			attackerScore: session.bsScore,
			minFF: clampedMinFF,
			maxFF: clampedMaxFF,
			ignoreIds,
			limit: 30,
		});

		// Fallback: If cache has fewer than 10 candidates, seed from FFScouter
		if (candidates.length < 10) {
			try {
				const freshTargets = await getFFScouterTargets({
					minff: clampedMinFF,
					maxff: clampedMaxFF,
					inactiveonly: 1,
					limit: 30,
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
							isInactive: true,
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
						isInactive: true,
						isFactionless,
						inHospital: false,
						hospitalUntil: null,
						estimatedBs: t.bs_estimate ?? 0,
						estimatedScore: score,
					});
				}

				candidates = subversiveTargetCache.getCandidatesForVerification({
					attackerScore: session.bsScore,
					minFF: clampedMinFF,
					maxFF: clampedMaxFF,
					ignoreIds,
					limit: 30,
				});
			} catch {
				// Continue if FFScouter on-demand seeding fails
			}
		}

		if (candidates.length === 0) {
			return {
				success: false,
				message:
					"No matching targets found within your specified Fair Fight range and filters.",
				totalPoolCount: subversiveTargetCache.getTotalTargetsCount(),
			};
		}

		// 2. Verification runs on the requesting member's OWN key. Chain-target
		// scouting is charged to whoever asked for it, so a pooled key belonging
		// to another member is never spent on this request — and when the
		// member's key cannot be used, the request fails rather than silently
		// borrowing someone else's.
		const memberApiKey = await resolveMemberApiKey(session);
		if (!memberApiKey) {
			set.status = 503;
			return {
				success: false,
				error:
					"Your Torn API key is unavailable for target verification. Please re-connect your API key in Settings.",
			};
		}

		if (isMemberKeyCoolingDown(memberApiKey)) {
			set.status = 429;
			return {
				success: false,
				error:
					"Your Torn API key is temporarily on cooldown with Torn. Please wait a few minutes and try again.",
			};
		}

		// 3. Verify candidates one at a time on the member's own key, stopping at
		// the first target that comes back attackable. A lucky press costs a
		// single Torn call; an unlucky one walks the pool until either the check
		// cap or the wall-clock budget runs out. The cap bounds how much of the
		// member's Torn budget a press can spend (comfortably inside the
		// in-process 50 requests/minute limiter); the deadline bounds how long the
		// press can take.
		const MAX_CHECKS_PER_REQUEST = 20;
		const THREE_DAYS_SEC = 3 * 24 * 60 * 60; // 3 days in seconds
		let verifiedTarget: MatchedTargetResult | null = null;
		let memberKeyError: TornError | null = null;
		let checksRun = 0;
		let budgetSpent = false;

		for (const candidate of candidates) {
			if (checksRun >= MAX_CHECKS_PER_REQUEST) break;
			if (Date.now() >= verificationDeadline) {
				budgetSpent = true;
				break;
			}

			let profileData: UserProfileResponse;
			try {
				checksRun++;
				const outcome = await awaitWithinDeadline(
					tornApi.get("/user/{id}/profile", {
						apiKey: memberApiKey,
						userId: session.tornId,
						pathParams: { id: candidate.targetId },
						// These are opportunistic checks inside a sequential loop: a
						// retry would sleep 5s on a rate limit (5000 * attempt) and can
						// outlast the userscript's request budget. Skipping and letting
						// the member press again is cheaper, so no retries here.
						maxAttempts: 1,
					}),
					verificationDeadline,
				);

				if (outcome === BUDGET_SPENT) {
					budgetSpent = true;
					break;
				}

				profileData = outcome as unknown as UserProfileResponse;
			} catch (error) {
				if (
					error instanceof TornError &&
					KEY_UNUSABLE_ERROR_CODES.has(error.code)
				) {
					if (TEMPORARY_DISABLE_ERROR_CODES.has(error.code)) {
						markSubversiveKeyDisabled(memberApiKey, error.code);
					}
					memberKeyError = error;
					break;
				}
				// Target-level failures (deleted player, Torn hiccup) are not a key
				// problem: leave that key's health alone and take the next candidate.
				continue;
			}

			recordSubversiveKeySuccess(memberApiKey);

			const now = new Date();
			const nowSec = Math.floor(now.getTime() / 1000);

			const lastActionTimestamp =
				profileData.profile?.last_action?.timestamp ?? 0;
			const statusObj = profileData.profile?.status;
			// Torn only reports `until` for a live status (hospital, jail); a traveler or
			// an Abroad member has none, and that absence must stay an absence.
			const untilSec = statusObj?.until ?? null;

			// Inactivity check: Permanently active (logged in < 3 days ago)?
			// If player has been active within 3 days, remove from DB & cache permanently
			if (
				lastActionTimestamp > 0 &&
				nowSec - lastActionTimestamp < THREE_DAYS_SEC
			) {
				await db
					.delete(subversiveTargetFinderTargets)
					.where(eq(subversiveTargetFinderTargets.targetId, candidate.targetId))
					.catch(() => {});
				subversiveTargetCache.evict(candidate.targetId);
				continue;
			}

			// Unattackable states. Only a hospital stay carries a Torn timer, so it is
			// the only one that may write `hospitalUntil`: every other state
			// (Traveling, Abroad, Jail, Federal, Fallen) has none, and inventing a
			// 15-minute "hospital exit" for them made the maintenance sweep declare
			// them attackable again without ever re-checking Torn. They record their
			// real state instead, stay out of the ready pool, and are re-verified
			// before they can be offered again.
			if (!isAttackableInTorn(statusObj)) {
				const isHospitalStay = isHospitalStatus(statusObj);
				const hospitalUntil =
					isHospitalStay && untilSec !== null
						? new Date(untilSec * 1000)
						: null;

				await db
					.update(subversiveTargetFinderTargets)
					.set({
						inHospital: true,
						hospitalUntil,
						status: tornStateSlug(statusObj),
						lastAction:
							lastActionTimestamp > 0
								? new Date(lastActionTimestamp * 1000)
								: null,
						updatedAt: now,
					})
					.where(eq(subversiveTargetFinderTargets.targetId, candidate.targetId))
					.catch(() => {});

				if (hospitalUntil) {
					subversiveTargetCache.markHospital(
						candidate.targetId,
						hospitalUntil.getTime(),
					);
				} else {
					// No timer to expire: the target is simply out until a verification
					// finds them free again.
					subversiveTargetCache.evict(candidate.targetId);
				}
				continue;
			}

			// Target is Okay and permanently inactive (>= 3 days offline)
			const rawFF = 1 + (8 / 3) * (candidate.estimatedScore / session.bsScore);
			const calculatedFF = Math.max(
				1.0,
				Math.min(clampedMaxFF, Number(rawFF.toFixed(2))),
			);

			await db
				.update(subversiveTargetFinderTargets)
				.set({
					inHospital: false,
					hospitalUntil: null,
					status: "okay",
					lastAction:
						lastActionTimestamp > 0
							? new Date(lastActionTimestamp * 1000)
							: null,
					isInactive: true,
					updatedAt: now,
				})
				.where(eq(subversiveTargetFinderTargets.targetId, candidate.targetId))
				.catch(() => {});

			if (calculatedFF >= clampedMinFF && calculatedFF <= clampedMaxFF) {
				// Soft-reserve target for 60s so concurrent and staggered requests skip them
				subversiveTargetCache.reserveTarget(candidate.targetId, 60_000);

				verifiedTarget = {
					id: candidate.targetId,
					name: candidate.name,
					level: candidate.level,
					factionId: candidate.factionId,
					factionName: candidate.factionName,
					isFactionless: candidate.isFactionless,
					isInactive: true,
					estimatedBs: candidate.estimatedBs,
					fairFight: calculatedFF,
					attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${candidate.targetId}`,
				};
				break;
			}
		}

		// Worth knowing about in the logs: it means the pool is being walked to the
		// end of its budget without turning up an attackable target, which is a
		// pool-quality problem rather than a member's key problem.
		if (budgetSpent && !verifiedTarget) {
			logger.warn(
				`Chain target scout for user ${session.tornId} used its ${verificationBudgetMs()}ms budget after ${checksRun} check(s) of ${candidates.length} candidate(s) without an attackable target.`,
			);
		}

		// The member's own key broke mid-scout: report it instead of quietly
		// retrying on someone else's key.
		if (!verifiedTarget && memberKeyError) {
			// Torn's per-key request limit is transient and is not a key fault, so
			// it must not cool the key down nor tell the member to check Settings.
			const rateLimited = memberKeyError.code === 5;
			set.status = rateLimited ? 429 : 503;
			return {
				success: false,
				error: rateLimited
					? "Your Torn API key hit Torn's request limit during verification. Please wait a moment and try again."
					: `Target verification with your Torn API key failed: ${describeTornError(
							memberKeyError,
						)}. Please check your key in Settings and try again.`,
			};
		}

		if (!verifiedTarget) {
			return {
				success: false,
				retryAfter: 5,
				message:
					"No targets currently available out of hospital. Please wait 5 seconds before retrying.",
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
			target: verifiedTarget,
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

		const factionId = resolveSubversiveFactionId(session.factionId);
		let war = subversiveTargetCache.getWarState(factionId);
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
						pathParams: { id: factionId },
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
						const saFaction = factions.find((f) => f.id === factionId);
						const oppFaction = factions.find((f) => f.id !== factionId);
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
						subversiveTargetCache.setWarState(newWar, factionId);
						war = newWar;
					}
				}
			} catch {
				// Non-fatal, fallback to cached state
			}
		}

		const opponents = subversiveTargetCache.getWarOpponents(factionId);

		let lead = 0;
		if (war.subversive && war.opponent) {
			lead = war.subversive.score - war.opponent.score;
		}

		// Diagnostics: the userscript renders nothing when this is 0, so record
		// which side is empty (cache miss vs member genuinely at zero).
		const userHitCount = subversiveTargetCache.getUserHitCount(
			session.tornId,
			factionId,
		);
		if (war.state === "active") {
			logger.warn(
				`War status: user ${session.tornId} on faction ${factionId} -> userHitCount=${userHitCount} (factionCached=${subversiveTargetCache.hasHitCounts(factionId)}).`,
			);
		}

		return {
			success: true,
			war: {
				...war,
				lead,
				userHitCount,
			},
			// The viewing member's own landed ranked war hits, resolved server
			// side from the per-faction counts the scheduler publishes.
			userHitCount,
			factionId,
			factionName: getSubversiveFactionName(factionId),
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

		const factionId = resolveSubversiveFactionId(session.factionId);
		const war = subversiveTargetCache.getWarState(factionId);
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

		const userHitCount = subversiveTargetCache.getUserHitCount(
			session.tornId,
			factionId,
		);

		if (war.state !== "active" && war.state !== "scheduled") {
			return {
				success: false,
				message: "No active ranked war.",
				target: null,
				war: {
					...war,
					userHitCount,
				},
			};
		}

		const target = subversiveTargetCache.getNextWarTarget({
			attackerBsScore: session.bsScore,
			factionId,
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
				war: {
					...war,
					userHitCount,
				},
			};
		}

		return {
			success: true,
			target,
			war: {
				...war,
				userHitCount,
			},
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
			resolveSubversiveFactionId(session.factionId),
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

		const factionId = resolveSubversiveFactionId(session.factionId);
		const targets = subversiveTargetCache.getAvailableWarTargets({
			attackerBsScore: session.bsScore,
			factionId,
			excludeIds,
		});

		const userHitCount = subversiveTargetCache.getUserHitCount(
			session.tornId,
			factionId,
		);

		return {
			success: true,
			targets,
			total: targets.length,
			war: {
				...subversiveTargetCache.getWarState(factionId),
				userHitCount,
			},
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
			factionId: resolveSubversiveFactionId(session.factionId),
		});

		return {
			success: true,
			queue,
		};
	})

	// ─── GET /war/events (HTTP Reverse Polling / Long Polling Push) ──────────────
	.get("/war/events", async ({ headers, query, request, set }) => {
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

		const sinceVersion =
			Number.parseInt((query.sinceVersion as string) || "0", 10) || 0;
		const maxFF = query.maxFF
			? Number.parseFloat(query.maxFF as string)
			: undefined;
		const maxBS = query.maxBS
			? Number.parseFloat(query.maxBS as string)
			: undefined;
		const timeoutMs = query.timeout
			? Number.parseInt(query.timeout as string, 10)
			: undefined;

		return subversiveWarEventManager.waitForUpdate(session, sinceVersion, {
			maxFF,
			maxBS,
			timeoutMs,
			signal: request.signal,
		});
	})

	// ─── GET /script & /script.user.js (Serve Userscript Directly for 1-Click Install) ────────────
	.get("/script", async ({ query, set }) => {
		return serveUserscript(query, set);
	})
	.get("/script.user.js", async ({ query, set }) => {
		return serveUserscript(query, set);
	});

export async function serveUserscript(
	query: { env?: string },
	set: Context["set"],
) {
	try {
		const candidatePaths = [
			`${process.cwd()}/scripts/subversive-alliance.user.js`,
			`${process.cwd()}/../../scripts/subversive-alliance.user.js`,
			`${process.cwd()}/scripts/subversive-target-finder.user.js`,
			`${process.cwd()}/../../scripts/subversive-target-finder.user.js`,
		];
		let file = Bun.file(candidatePaths[0] ?? "");
		for (const path of candidatePaths) {
			const candidate = Bun.file(path);
			if (await candidate.exists()) {
				file = candidate;
				break;
			}
		}
		if (!(await file.exists())) {
			set.status = 404;
			return "Userscript file not found.";
		}
		let content = await file.text();
		if (query.env === "dev") {
			content = content
				.replace(
					/apiUrl:\s*"https:\/\/(?:api|subversive)\.blasted-labs\.tech"/g,
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
