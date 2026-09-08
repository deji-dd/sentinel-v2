import { and, db, elimsItemRequests, eq, lt } from "@sentinel/database";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	EmbedBuilder,
} from "discord.js";
import { EMBED_COLORS } from "./embeds";
import { logger } from "./logger";
import { formatTctTimestamp } from "./torn-log-parser";

/**
 * Builds the verification reminder embed & buttons sent to an approver.
 */
export function buildVerificationReminderMessage(request: {
	id: string;
	itemName: string;
	quantity: number;
	tornName: string | null;
	tornId: number | null;
	handledAt: Date | null;
	createdAt?: Date | null;
	isTest: boolean;
}): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
	const shortId = request.id.slice(0, 8);
	const targetProfile = request.tornId
		? `[${request.tornName ?? "Player"} [${request.tornId}]](https://www.torn.com/profiles.php?XID=${request.tornId})`
		: `**${request.tornName ?? "Unknown"}**`;

	const timeInfo = request.createdAt
		? `\n*Request Time:* \`${formatTctTimestamp(request.createdAt)} TCT\``
		: "";

	const embed = new EmbedBuilder()
		.setTitle(`Verification Pending — Request #${shortId}`)
		.setColor(EMBED_COLORS.WARNING)
		.setDescription(
			`You approved an item request for **${request.quantity.toLocaleString()}x ${request.itemName}** to ${targetProfile}.${timeInfo}\n\n` +
				"**Next Step:** Send the items in Torn, copy your event log, and click **Verify Send** below.\n\n" +
				"*Example Log:*\n`16:12:24 - 08/09/26 You sent " +
				`${request.quantity === 1 ? "a " : `${request.quantity}x `}${request.itemName} to ${request.tornName ?? "Player"}` +
				" with the message: Prelicked`\n\n",
		)
		.setFooter({
			text: "Sentinel",
		})
		.setTimestamp(new Date());

	const verifyBtn = new ButtonBuilder()
		.setCustomId(`elims_verify_send:${request.id}`)
		.setLabel("Verify Send (Paste Log)")
		.setStyle(ButtonStyle.Primary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(verifyBtn);

	return { embed, row };
}

/**
 * Checks all requests with pending verification and delivers 1-minute reminders to approvers.
 */
export async function checkPendingVerificationReminders(
	client: Client,
): Promise<void> {
	try {
		const now = Date.now();
		const oneMinuteAgo = new Date(now - 60 * 1000);

		// Find accepted requests that are awaiting verification and handled at least 1 min ago
		const pendingRequests = await db
			.select()
			.from(elimsItemRequests)
			.where(
				and(
					eq(elimsItemRequests.status, "accepted"),
					eq(elimsItemRequests.verificationStatus, "pending_verification"),
					lt(elimsItemRequests.handledAt, oneMinuteAgo),
				),
			);

		for (const req of pendingRequests) {
			if (!req.handledByDiscordId) continue;

			// Check if we reminded within the last 60 seconds
			const meta = (req.metadata as Record<string, unknown> | null) ?? {};
			const lastReminderAt = meta.lastReminderAt
				? new Date(meta.lastReminderAt as string).getTime()
				: 0;

			if (now - lastReminderAt < 55 * 1000) {
				// Reminded recently, skip this iteration
				continue;
			}

			try {
				const approver = await client.users
					.fetch(req.handledByDiscordId)
					.catch(() => null);
				if (!approver) continue;

				const { embed, row } = buildVerificationReminderMessage({
					id: req.id,
					itemName: req.itemName,
					quantity: req.quantity,
					tornName: req.tornName,
					tornId: req.tornId,
					handledAt: req.handledAt,
					createdAt: req.createdAt,
					isTest: req.isTest,
				});

				const sent = await approver
					.send({ embeds: [embed], components: [row] })
					.then(() => true)
					.catch(() => false);

				if (sent) {
					meta.lastReminderAt = new Date().toISOString();
					await db
						.update(elimsItemRequests)
						.set({ metadata: meta })
						.where(eq(elimsItemRequests.id, req.id));
				}
			} catch (err) {
				logger.warn(
					`Failed to send verification reminder to approver ${req.handledByDiscordId}:`,
					err,
				);
			}
		}
	} catch (err) {
		logger.error("Error in checkPendingVerificationReminders:", err);
	}
}

let reminderTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the 1-minute verification reminder background interval.
 */
export function startVerificationReminderScheduler(client: Client): void {
	if (reminderTimer) {
		clearInterval(reminderTimer);
	}

	// Run every 60 seconds
	reminderTimer = setInterval(() => {
		void checkPendingVerificationReminders(client);
	}, 60 * 1000);

	logger.info(
		"Elims 2-stage verification reminder scheduler started (1m interval).",
	);
}
