import {
	and,
	capitalAccess,
	capitalInvestors,
	db,
	eq,
	or,
} from "@sentinel/database";
import type { CapitalAccessRole, CapitalBook } from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";

import type { AuthUser } from "../middleware/auth";
import { resolveDiscordTornUser } from "./resolve-discord-torn-user";

const logger = new Logger("API", "CapitalAccess");

export interface CapitalAccessContext {
	user: AuthUser;
	tornId: number | null;
	role: CapitalAccessRole;
	investorId: string | null;
	isAdmin: boolean;
}

function isPlatformAdmin(user: AuthUser, ownerDiscordId: string): boolean {
	if (user.role === "owner" || user.role === "admin") return true;
	return Boolean(ownerDiscordId) && user.discordId === ownerDiscordId;
}

/**
 * Resolves the caller's capital role for one book.
 *
 * The platform owner is always an admin. Everyone else is checked against
 * `capital_access` by Discord ID first (the login identity) and then Torn ID
 * (resolved through the existing Discord→Torn cache). An investor with an
 * active lot is auto-whitelisted on deposit; this fallback also repairs a
 * missing access row without silently granting access to a stranger.
 */
export async function resolveCapitalAccess(
	user: AuthUser,
	book: CapitalBook,
	ownerDiscordId: string,
): Promise<CapitalAccessContext> {
	const isAdmin = isPlatformAdmin(user, ownerDiscordId);
	if (isAdmin) {
		return {
			user,
			tornId: user.tornId,
			role: "admin",
			investorId: null,
			isAdmin,
		};
	}

	let tornId = user.tornId;
	if (!tornId && user.discordId) {
		const resolved = await resolveDiscordTornUser(user.discordId);
		tornId = resolved?.tornId ?? null;
	}

	const conditions = [];
	if (user.discordId) {
		conditions.push(eq(capitalAccess.discordId, user.discordId));
	}
	if (tornId) {
		conditions.push(eq(capitalAccess.tornId, tornId));
	}

	if (conditions.length > 0) {
		const [access] = await db
			.select()
			.from(capitalAccess)
			.where(and(eq(capitalAccess.book, book), or(...conditions)))
			.limit(1);
		if (access) {
			return {
				user,
				tornId,
				role:
					access.role === "admin" || access.role === "investor"
						? access.role
						: "viewer",
				investorId: access.investorId,
				isAdmin: access.role === "admin",
			};
		}
	}

	// An investor whose access row is missing (an older deposit, or an admin
	// deleting the row) still owns their lots; grant the minimum matching role.
	if (tornId) {
		const [investor] = await db
			.select()
			.from(capitalInvestors)
			.where(
				and(
					eq(capitalInvestors.book, book),
					eq(capitalInvestors.tornId, tornId),
					eq(capitalInvestors.status, "active"),
				),
			)
			.limit(1);
		if (investor) {
			try {
				await db
					.insert(capitalAccess)
					.values({
						book,
						tornId,
						discordId: user.discordId,
						role: "investor",
						investorId: investor.id,
						note: "Auto-whitelisted on access resolution.",
					})
					.onConflictDoNothing();
			} catch (error) {
				logger.warn(
					`Failed to backfill capital access for Torn #${tornId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return {
				user,
				tornId,
				role: "investor",
				investorId: investor.id,
				isAdmin: false,
			};
		}
	}

	return { user, tornId, role: "viewer", investorId: null, isAdmin: false };
}

export function canReadCapital(access: CapitalAccessContext): boolean {
	return (
		access.isAdmin || access.role === "investor" || access.role === "viewer"
	);
}

export function canInvestCapital(access: CapitalAccessContext): boolean {
	return access.isAdmin || access.role === "investor";
}
