import { db, eq, systemAlerts } from "@sentinel/database";
import type { Client } from "discord.js";
import { createSuccessEmbed } from "./embeds";
import { logger } from "./logger";

/**
 * Checks for pending system boot alerts in the database and sends DMs to the bot owner.
 *
 * @param client - The Discord Client instance
 */
export async function processPendingBootAlerts(client: Client): Promise<void> {
	const ownerId = process.env.DISCORD_USER_ID;

	if (!ownerId) {
		logger.warn(
			"DISCORD_USER_ID environment variable is not set. Skipping owner boot DM alert.",
		);
		return;
	}

	try {
		const pendingAlerts = await db.query.systemAlerts.findMany({
			where: eq(systemAlerts.isRead, false),
			orderBy: (systemAlerts, { asc }) => [asc(systemAlerts.createdAt)],
		});

		if (pendingAlerts.length === 0) return;

		const owner = await client.users.fetch(ownerId).catch((err) => {
			logger.error(`Failed to fetch Discord user ${ownerId}:`, err);
			return null;
		});

		if (!owner) return;

		for (const alert of pendingAlerts) {
			const bootTime = alert.createdAt ?? new Date();

			const embed = createSuccessEmbed(
				"System Boot Event",
				alert.message,
			).addFields(
				{ name: "Component", value: `\`${alert.component}\``, inline: true },
				{
					name: "Boot Time",
					value: `<t:${Math.floor(bootTime.getTime() / 1000)}:F>`,
					inline: true,
				},
			);

			try {
				await owner.send({ embeds: [embed] });
				await db
					.update(systemAlerts)
					.set({ isRead: true })
					.where(eq(systemAlerts.id, alert.id));
				logger.info(
					`Delivered boot alert DM to owner for component: ${alert.component}`,
				);
			} catch (sendErr) {
				logger.error(
					`Failed to send boot DM to owner for alert ${alert.id}:`,
					sendErr,
				);
			}
		}
	} catch (err) {
		logger.error("Error while processing boot alerts:", err);
	}
}

/**
 * Starts periodic polling for pending system boot alerts.
 *
 * @param client - The Discord Client instance
 * @param intervalMs - Polling interval in milliseconds (default 15,000ms)
 */
export function startBootAlertNotifier(
	client: Client,
	intervalMs = 15000,
): NodeJS.Timeout {
	void processPendingBootAlerts(client);

	return setInterval(() => {
		void processPendingBootAlerts(client);
	}, intervalMs);
}
