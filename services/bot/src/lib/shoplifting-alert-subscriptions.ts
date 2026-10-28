import { and, db, eq, userShopliftingAlerts } from "@sentinel/database";
import {
	buildUserShopliftingAlertConditionKey,
	createEmptyUserShopliftingAlertState,
	describeUserShopliftingAlert,
	findShopliftingShop,
	isUserShopliftingAlertConditionAvailable,
	MAX_USER_SHOPLIFTING_ALERTS,
	type UserShopliftingAlertCondition,
} from "@sentinel/schemas";

/**
 * Persistence for the `/shoplifting-alerts` command.
 *
 * Kept out of the command file so validation and the SQL are reachable from
 * tests without driving a Discord interaction.
 */

/** A subscription as the list/remove views need it. */
export interface UserShopliftingAlertView {
	id: string;
	shopId: number;
	condition: UserShopliftingAlertCondition;
	conditionKey: string;
}

/** Maps a table row onto the shape the command renders. */
function toView(
	row: typeof userShopliftingAlerts.$inferSelect,
): UserShopliftingAlertView {
	return {
		id: row.id,
		shopId: row.shopId,
		condition: row.condition as UserShopliftingAlertCondition,
		conditionKey: row.conditionKey,
	};
}

/** Every alert the user owns in this guild, oldest first. */
export async function listUserShopliftingAlerts(
	guildId: string,
	discordUserId: string,
): Promise<UserShopliftingAlertView[]> {
	const rows = await db
		.select()
		.from(userShopliftingAlerts)
		.where(
			and(
				eq(userShopliftingAlerts.discordUserId, discordUserId),
				eq(userShopliftingAlerts.guildId, guildId),
			),
		)
		.orderBy(userShopliftingAlerts.createdAt);

	return rows.map(toView);
}

/** Raised when a requested subscription cannot be stored as asked. */
export class UserShopliftingAlertError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UserShopliftingAlertError";
	}
}

export interface NewUserShopliftingAlert {
	guildId: string;
	discordUserId: string;
	shopId: number;
	condition: UserShopliftingAlertCondition;
}

/**
 * Validates a subscription request against the shop's own security layout.
 *
 * A guards alert on a shop with no guards would never fire, so it is rejected
 * with a message naming the shop rather than stored as a silent row.
 */
export function validateUserShopliftingAlert(input: {
	shopId: number;
	condition: UserShopliftingAlertCondition;
}): void {
	const shop = findShopliftingShop(input.shopId);
	if (!shop) {
		throw new UserShopliftingAlertError(
			"That shop is not a Torn shoplifting location.",
		);
	}

	if (
		!isUserShopliftingAlertConditionAvailable(input.condition, input.shopId)
	) {
		throw new UserShopliftingAlertError(
			`${shop.name} does not have that security measure, so that alert could never fire.`,
		);
	}
}

/**
 * Creates a subscription, or reports that this exact alert already exists.
 *
 * Uniqueness is enforced by the database as well as the pre-check, so two rapid
 * submissions of the same form cannot both succeed.
 */
export async function createUserShopliftingAlert(
	input: NewUserShopliftingAlert,
): Promise<UserShopliftingAlertView> {
	validateUserShopliftingAlert(input);

	const existing = await listUserShopliftingAlerts(
		input.guildId,
		input.discordUserId,
	);
	if (existing.length >= MAX_USER_SHOPLIFTING_ALERTS) {
		throw new UserShopliftingAlertError(
			`You already have ${MAX_USER_SHOPLIFTING_ALERTS} shoplifting alerts, which is the maximum. Remove one with \`/shoplifting-alerts remove\` before adding another.`,
		);
	}

	const conditionKey = buildUserShopliftingAlertConditionKey({
		shopId: input.shopId,
		condition: input.condition,
	});

	if (existing.some((alert) => alert.conditionKey === conditionKey)) {
		throw new UserShopliftingAlertError(
			"You already have that exact alert. Use `/shoplifting-alerts list` to see it.",
		);
	}

	const [row] = await db
		.insert(userShopliftingAlerts)
		.values({
			guildId: input.guildId,
			discordUserId: input.discordUserId,
			shopId: input.shopId,
			condition: input.condition,
			conditionKey,
			enabled: true,
			state: createEmptyUserShopliftingAlertState(),
		})
		.onConflictDoNothing({
			target: [
				userShopliftingAlerts.discordUserId,
				userShopliftingAlerts.conditionKey,
			],
		})
		.returning();

	if (!row) {
		throw new UserShopliftingAlertError(
			"You already have that exact alert. Use `/shoplifting-alerts list` to see it.",
		);
	}

	return toView(row);
}

/**
 * Deletes one of the user's alerts.
 *
 * Scoped by `discordUserId` in the `WHERE` clause as well as by id, so a stale or
 * forged id from another member's menu cannot remove their alert.
 */
export async function deleteUserShopliftingAlert(
	id: string,
	discordUserId: string,
): Promise<boolean> {
	const deleted = await db
		.delete(userShopliftingAlerts)
		.where(
			and(
				eq(userShopliftingAlerts.id, id),
				eq(userShopliftingAlerts.discordUserId, discordUserId),
			),
		)
		.returning({ id: userShopliftingAlerts.id });

	return deleted.length > 0;
}

/** Deletes every alert the user owns in this guild. Returns the number removed. */
export async function deleteAllUserShopliftingAlerts(
	guildId: string,
	discordUserId: string,
): Promise<number> {
	const rows = await listUserShopliftingAlerts(guildId, discordUserId);
	let removed = 0;

	for (const row of rows) {
		if (await deleteUserShopliftingAlert(row.id, discordUserId)) removed++;
	}

	return removed;
}

/** Re-exported so the command can describe a row it already holds. */
export { describeUserShopliftingAlert };
