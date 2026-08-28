import { db, eq, systemAlerts } from "@sentinel/database";
import type { Client } from "discord.js";
import { createSuccessEmbed } from "./embeds";
import { logger } from "./logger";

/**
 * Maximum age in milliseconds for a boot alert to be considered valid for sending a DM.
 * Alerts older than this threshold (e.g. while the bot was offline or in development)
 * are marked as read and skipped to prevent DM spam.
 */
const MAX_ALERT_AGE_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Checks for pending system boot alerts in the database and sends DMs to the bot owner.
 * In development mode (NODE_ENV !== "production"), alert DMs are disabled by default
 * unless explicitly enabled via ENABLE_DEV_BOOT_ALERTS=true or ENABLE_BOOT_ALERTS=true.
 *
 * @param client - The Discord Client instance
 */
export async function processPendingBootAlerts(client: Client): Promise<void> {
	const isDev =
		process.env.NODE_ENV === "development" ||
		process.env.NODE_ENV !== "production";
	const allowInDev =
		process.env.ENABLE_DEV_BOOT_ALERTS === "true" ||
		process.env.ENABLE_BOOT_ALERTS === "true";

	try {
		const pendingAlerts = await db.query.systemAlerts.findMany({
			where: eq(systemAlerts.isRead, false),
			orderBy: (systemAlerts, { asc }) => [asc(systemAlerts.createdAt)],
		});

		if (pendingAlerts.length === 0) return;

		// In development mode (without explicit opt-in), drain and mark pending alerts
		// as read so they do not accumulate in the database or spam DMs.
		if (isDev && !allowInDev) {
			for (const alert of pendingAlerts) {
				await db
					.update(systemAlerts)
					.set({ isRead: true })
					.where(eq(systemAlerts.id, alert.id));
			}
			return;
		}

		const ownerId = process.env.DISCORD_USER_ID;
		if (!ownerId) {
			logger.warn(
				"DISCORD_USER_ID environment variable is not set. Skipping owner boot DM alert.",
			);
			return;
		}

		const owner = await client.users.fetch(ownerId).catch((err) => {
			logger.error(`Failed to fetch Discord user ${ownerId}:`, err);
			return null;
		});

		if (!owner) return;

		const now = Date.now();

		for (const alert of pendingAlerts) {
			const bootTime = alert.createdAt ?? new Date();
			const alertAgeMs = now - bootTime.getTime();

			// If the alert was generated while the bot was offline or exceeded age threshold, discard it
			if (alertAgeMs > MAX_ALERT_AGE_MS) {
				await db
					.update(systemAlerts)
					.set({ isRead: true })
					.where(eq(systemAlerts.id, alert.id));
				logger.info(
					`Skipped stale boot alert for component: ${alert.component} (created ${Math.round(alertAgeMs / 1000)}s ago)`,
				);
				continue;
			}

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
	const isDev =
		process.env.NODE_ENV === "development" ||
		process.env.NODE_ENV !== "production";
	const allowInDev =
		process.env.ENABLE_DEV_BOOT_ALERTS === "true" ||
		process.env.ENABLE_BOOT_ALERTS === "true";

	if (isDev && !allowInDev) {
		logger.info(
			"Boot alert DMs are disabled in development mode (set ENABLE_DEV_BOOT_ALERTS=true to enable).",
		);
	}

	void processPendingBootAlerts(client);

	return setInterval(() => {
		void processPendingBootAlerts(client);
	}, intervalMs);
}
