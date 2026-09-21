import { db, eq, systemStates } from "@sentinel/database";
import type { UserProfileResponse } from "@sentinel/schemas";
import { getPersonalKey, tornApi, UserRateLimiter } from "@sentinel/torn-api";
import { type Context, Elysia, t } from "elysia";
import { notifyBountyDefeated } from "../../lib/scheduler-ipc";

export const BOUNTY_STATE_ID = "personal:bounties";

export interface PersonalBountyTarget {
	id: number;
	name: string;
	level: number;
	reward: number;
	fairFight: number | null;
	estimatedBs: number | null;
	age: number;
	status: {
		state: string;
		description?: string;
		until?: number | null;
	};
	attackUrl: string;
	lastCheckedAt: number;
}

export interface PersonalBountyState {
	readyTargets: PersonalBountyTarget[];
	hospitalQueue: Array<PersonalBountyTarget & { secondsRemaining: number }>;
	lastSyncTimestamp: number;
	targetCount: number;
	pendingCount?: number;
}

const recheckRateLimiter = new UserRateLimiter(50, 60_000);

let inMemoryBountyStateCache: PersonalBountyState | null = null;
let isMockOverride = false;

export function setBountyStateObject(state: PersonalBountyState | null): void {
	inMemoryBountyStateCache = state;
	isMockOverride = state !== null;
}

export async function getBountyStateObject(): Promise<PersonalBountyState> {
	if (isMockOverride && inMemoryBountyStateCache) {
		return inMemoryBountyStateCache;
	}

	try {
		const [record] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, BOUNTY_STATE_ID));

		if (record?.data) {
			const raw = record.data as Partial<PersonalBountyState>;
			inMemoryBountyStateCache = {
				readyTargets: Array.isArray(raw.readyTargets) ? raw.readyTargets : [],
				hospitalQueue: Array.isArray(raw.hospitalQueue)
					? raw.hospitalQueue
					: [],
				lastSyncTimestamp: Number(raw.lastSyncTimestamp ?? 0),
				targetCount: Number(raw.targetCount ?? 0),
				pendingCount: Number(raw.pendingCount ?? 0),
			};
		}
	} catch {
		// Fallback to in-memory cache if DB is offline
	}

	return (
		inMemoryBountyStateCache ?? {
			readyTargets: [],
			hospitalQueue: [],
			lastSyncTimestamp: 0,
			targetCount: 0,
		}
	);
}

/**
 * Authenticates request against the registered personal key.
 */
async function authenticatePersonalRequest(
	authHeader?: string | null,
	apiKeyHeader?: string | null,
): Promise<boolean> {
	const personalKey = await getPersonalKey();
	if (!personalKey?.apiKey) return false;

	let providedKey = "";
	if (apiKeyHeader) {
		providedKey = apiKeyHeader.trim();
	} else if (authHeader) {
		const parts = authHeader.split(" ");
		if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
			providedKey = parts[1]?.trim() ?? "";
		} else {
			providedKey = authHeader.trim();
		}
	}

	return providedKey === personalKey.apiKey;
}

export const personalBountiesRoutes = new Elysia({
	prefix: "/personal/bounties",
})
	// ─── GET /api/v1/personal/bounties ───────────────────────────
	.get(
		"/",
		async ({ headers, query, set }) => {
			const authHeader = headers.authorization;
			const apiKeyHeader = headers["x-api-key"];

			const isAuthorized = await authenticatePersonalRequest(
				authHeader,
				apiKeyHeader,
			);
			if (!isAuthorized) {
				set.status = 401;
				return {
					error: "Unauthorized. Valid personal API key required.",
				};
			}

			const state = await getBountyStateObject();
			const minBounty = Number(query.minBounty ?? 100_000);
			const maxFF = Number(query.maxFF ?? 4.0);
			const nowSec = Math.floor(Date.now() / 1000);

			// Filter ready targets
			const readyTargets = state.readyTargets.filter((t) => {
				if (t.reward < minBounty) return false;
				if (t.fairFight !== null && t.fairFight > maxFF) return false;
				return true;
			});

			// Filter and update remaining seconds for hospital queue
			const hospitalQueue = state.hospitalQueue
				.filter((t) => {
					if (t.reward < minBounty) return false;
					if (t.fairFight !== null && t.fairFight > maxFF) return false;
					return true;
				})
				.map((t) => {
					const until = t.status.until ?? nowSec;
					return {
						...t,
						secondsRemaining: Math.max(0, until - nowSec),
					};
				})
				.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

			return {
				readyTargets,
				hospitalQueue,
				lastSyncTimestamp: state.lastSyncTimestamp,
				totalCount: readyTargets.length + hospitalQueue.length,
				pendingCount: state.pendingCount ?? 0,
			};
		},
		{
			query: t.Object({
				minBounty: t.Optional(t.String()),
				maxFF: t.Optional(t.String()),
			}),
			headers: t.Object({
				authorization: t.Optional(t.String()),
				"x-api-key": t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Personal Bounty Targets",
				description:
					"Returns active ready targets and hospital countdown queue filtered by min bounty and max Fair Fight.",
			},
		},
	)

	// ─── POST /api/v1/personal/bounties/recheck ──────────────────
	.post(
		"/recheck",
		async ({ headers, body, set }) => {
			const authHeader = headers.authorization;
			const apiKeyHeader = headers["x-api-key"];

			const isAuthorized = await authenticatePersonalRequest(
				authHeader,
				apiKeyHeader,
			);
			if (!isAuthorized) {
				set.status = 401;
				return {
					error: "Unauthorized. Valid personal API key required.",
				};
			}

			const personalKey = await getPersonalKey();
			if (!personalKey?.apiKey) {
				set.status = 500;
				return { error: "Personal API key not configured on server." };
			}

			const targetId = Number(body.targetId);
			if (!targetId || targetId <= 0) {
				set.status = 400;
				return { error: "Invalid targetId provided." };
			}

			const nowSec = Math.floor(Date.now() / 1000);
			try {
				await recheckRateLimiter.waitIfNeeded(personalKey.userId);
				const profileRes = (await tornApi.getPersonal("/user/{id}/profile", {
					pathParams: { id: targetId },
				})) as UserProfileResponse;

				const profile = profileRes.profile;
				if (!profile) {
					set.status = 404;
					return { error: "Target profile not found." };
				}

				const state = await getBountyStateObject();
				const existing =
					state.readyTargets.find((t) => t.id === targetId) ??
					state.hospitalQueue.find((t) => t.id === targetId);

				const updatedTarget: PersonalBountyTarget = {
					id: targetId,
					name: profile.name,
					level: profile.level,
					reward: existing?.reward ?? 0,
					fairFight: existing?.fairFight ?? null,
					estimatedBs: existing?.estimatedBs ?? null,
					age: profile.age,
					status: {
						state: profile.status.state,
						description: profile.status.description,
						until: profile.status.until,
					},
					attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`,
					lastCheckedAt: nowSec,
				};

				// Update state in systemStates
				const nextReady = state.readyTargets.filter((t) => t.id !== targetId);
				const nextHosp = state.hospitalQueue.filter((t) => t.id !== targetId);

				const stLower = (profile.status.state || "").toLowerCase();
				if (stLower === "okay") {
					nextReady.push(updatedTarget);
				} else if (stLower === "hospital") {
					const until = profile.status.until ?? nowSec;
					nextHosp.push({
						...updatedTarget,
						secondsRemaining: Math.max(0, until - nowSec),
					});
				}

				nextReady.sort((a, b) => b.reward - a.reward);
				nextHosp.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

				const nextState: PersonalBountyState = {
					readyTargets: nextReady,
					hospitalQueue: nextHosp,
					lastSyncTimestamp: nowSec,
					targetCount: nextReady.length + nextHosp.length,
					pendingCount: state.pendingCount ?? 0,
				};

				await db
					.insert(systemStates)
					.values({
						id: BOUNTY_STATE_ID,
						init: true,
						data: nextState,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: {
							data: nextState,
							updatedAt: new Date(),
						},
					});

				return {
					success: true,
					target: updatedTarget,
				};
			} catch (err) {
				set.status = 500;
				return {
					error:
						err instanceof Error
							? err.message
							: "Failed to recheck target status.",
				};
			}
		},
		{
			body: t.Object({
				targetId: t.Number(),
			}),
			headers: t.Object({
				authorization: t.Optional(t.String()),
				"x-api-key": t.Optional(t.String()),
			}),
			detail: {
				summary: "Recheck Target Status",
				description:
					"Executes an on-demand profile query for instant hospital and state accuracy.",
			},
		},
	)

	// ─── POST /api/v1/personal/bounties/defeat ────────────────────
	.post(
		"/defeat",
		async ({ body, headers, set }) => {
			const authHeader = headers.authorization;
			const apiKeyHeader = headers["x-api-key"];

			const isAuthorized = await authenticatePersonalRequest(
				authHeader,
				apiKeyHeader,
			);
			if (!isAuthorized) {
				set.status = 401;
				return {
					error: "Unauthorized. Valid personal API key required.",
				};
			}

			const targetId = Number(body.targetId);
			if (!targetId || Number.isNaN(targetId)) {
				set.status = 400;
				return { error: "targetId is required and must be a valid number." };
			}

			const outcome = body.outcome ? String(body.outcome) : "Hospitalized";
			const nowSec = Math.floor(Date.now() / 1000);
			const defaultHospitalDuration = 1800; // 30 minutes

			const state = await getBountyStateObject();
			const existing =
				state.readyTargets.find((t) => t.id === targetId) ??
				state.hospitalQueue.find((t) => t.id === targetId);

			const nextReady = state.readyTargets.filter((t) => t.id !== targetId);
			const nextHosp = state.hospitalQueue.filter((t) => t.id !== targetId);

			if (existing) {
				nextHosp.push({
					...existing,
					status: {
						state: "Hospital",
						description: outcome,
						until: nowSec + defaultHospitalDuration,
					},
					secondsRemaining: defaultHospitalDuration,
					lastCheckedAt: nowSec,
				});
			}

			nextReady.sort((a, b) => b.reward - a.reward);
			nextHosp.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

			const nextState: PersonalBountyState = {
				readyTargets: nextReady,
				hospitalQueue: nextHosp,
				lastSyncTimestamp: nowSec,
				targetCount: nextReady.length + nextHosp.length,
				pendingCount: state.pendingCount ?? 0,
			};

			setBountyStateObject(nextState);

			try {
				await db
					.insert(systemStates)
					.values({
						id: BOUNTY_STATE_ID,
						init: true,
						data: nextState,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: {
							data: nextState,
							updatedAt: new Date(),
						},
					});
			} catch {
				// Non-fatal if DB is unreachable in tests
			}

			// Notify scheduler worker over IPC
			await notifyBountyDefeated(targetId, outcome).catch(() => false);

			return {
				success: true,
				targetId,
				message: `Target ${targetId} marked as defeated.`,
			};
		},
		{
			body: t.Object({
				targetId: t.Number(),
				outcome: t.Optional(t.String()),
			}),
			headers: t.Object({
				authorization: t.Optional(t.String()),
				"x-api-key": t.Optional(t.String()),
			}),
			detail: {
				summary: "Record Target Defeat",
				description:
					"Notifies system that user defeated a bounty target, instantly moving them to hospitalQueue.",
			},
		},
	)

	// ─── GET /script & /script.user.js (Serve Userscript for 1-Click Install) ──────
	.get(
		"/script",
		async ({ query, set }) => {
			return servePersonalUserscript(query, set);
		},
		{
			query: t.Object({
				env: t.Optional(t.String()),
			}),
			detail: {
				summary: "Serve Userscript",
				description:
					"Serves the Personal Bounty Finder userscript with optional dev environment override.",
			},
		},
	)
	.get(
		"/script.user.js",
		async ({ query, set }) => {
			return servePersonalUserscript(query, set);
		},
		{
			query: t.Object({
				env: t.Optional(t.String()),
			}),
			detail: {
				summary: "Serve Userscript directly for Tampermonkey",
				description:
					"Serves the Personal Bounty Finder userscript with .user.js extension for direct installation.",
			},
		},
	);

async function servePersonalUserscript(
	query: { env?: string },
	set: Context["set"],
) {
	const candidates = [
		`${process.cwd()}/scripts/personal-bounty-finder.user.js`,
		`${process.cwd()}/../../scripts/personal-bounty-finder.user.js`,
	];
	let file = Bun.file(candidates[0] ?? "");
	if (!(await file.exists())) {
		file = Bun.file(candidates[1] ?? "");
	}
	if (!(await file.exists())) {
		set.status = 404;
		return "Userscript file not found.";
	}

	let content = await file.text();
	if (query.env === "dev") {
		content = content
			.replace(
				/apiUrl:\s*"https:\/\/sentinel\.blasted-labs\.tech"/g,
				'apiUrl: "http://localhost:3000"',
			)
			.replace(
				/@name\s+Bounty Target Finder/,
				"@name         Bounty Target Finder (DEV)",
			)
			.replace(
				/@downloadURL\s+https:\/\/sentinel\.blasted-labs\.tech\/api\/v1\/personal\/bounties\/script\.user\.js/,
				"@downloadURL  http://localhost:3000/api/v1/personal/bounties/script.user.js?env=dev",
			)
			.replace(
				/@updateURL\s+https:\/\/sentinel\.blasted-labs\.tech\/api\/v1\/personal\/bounties\/script\.user\.js/,
				"@updateURL    http://localhost:3000/api/v1/personal/bounties/script.user.js?env=dev",
			);
	}

	set.headers["content-type"] = "text/javascript; charset=utf-8";
	set.headers["cache-control"] = "no-cache";
	return content;
}
