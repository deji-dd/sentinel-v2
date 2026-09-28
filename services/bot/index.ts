import {
	Client,
	Events,
	GatewayIntentBits,
	type Interaction,
	Partials,
	Status,
} from "discord.js";
import { buildCommandsCollection } from "./src/commands";
import { guildCreateEvent } from "./src/events/guild-create";
import { guildMemberAddEvent } from "./src/events/guild-member-add";
import { interactionCreateEvent } from "./src/events/interaction-create";
import { readyEvent } from "./src/events/ready";
import { handleArmoryStorageChatMessage } from "./src/lib/elims-armory-storage";
import {
	createBaseEmbed,
	createErrorEmbed,
	EMBED_COLORS,
} from "./src/lib/embeds";
import { setupBotIpcListeners } from "./src/lib/ipc";
import { logger } from "./src/lib/logger";
import { handleReactionRoleAdd } from "./src/lib/reaction-roles";
import { deployCommands } from "./src/scripts/deploy-commands";

async function main(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	if (!token) {
		logger.warn(
			"No DISCORD_TOKEN found in environment variables. Discord bot is idle.",
		);
		return;
	}

	// Auto-deploy commands in production or if AUTO_DEPLOY_COMMANDS is explicitly enabled
	const shouldAutoDeploy =
		process.env.NODE_ENV === "production" ||
		process.env.AUTO_DEPLOY_COMMANDS === "true";

	if (shouldAutoDeploy) {
		logger.info("Auto-deploying slash commands on bot startup...");
		await deployCommands();
	}

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.GuildMembers,
			GatewayIntentBits.GuildMessageReactions,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
		partials: [
			Partials.Message,
			Partials.Channel,
			Partials.Reaction,
			Partials.User,
			Partials.GuildMember,
		],
	});

	const commands = buildCommandsCollection();

	client.once(Events.ClientReady, (readyClient) =>
		readyEvent.execute(readyClient),
	);
	client.on(Events.InteractionCreate, (interaction: Interaction) =>
		interactionCreateEvent.execute(interaction, commands),
	);
	client.on(Events.GuildCreate, (guild) => guildCreateEvent.execute(guild));
	client.on(Events.GuildMemberAdd, (member) =>
		guildMemberAddEvent.execute(member),
	);
	client.on(Events.MessageReactionAdd, (reaction, user) =>
		handleReactionRoleAdd(reaction, user),
	);
	client.on(Events.MessageCreate, async (message) => {
		void handleArmoryStorageChatMessage(message);

		// Handle on-demand personal DM command for Succession Oil briefing
		const allowedUserId = process.env.DISCORD_USER_ID;
		if (
			allowedUserId &&
			message.author.id === allowedUserId &&
			!message.guild
		) {
			const clean = message.content.trim().toLowerCase();
			if (
				clean === "!oil" ||
				clean === "oil" ||
				clean === "!briefing" ||
				clean === "briefing"
			) {
				try {
					await message.channel.sendTyping();
					const standbyEmbed = createBaseEmbed(
						"Director Briefing",
						"Analyzing...Stand by for your briefing.",
						EMBED_COLORS.PRIMARY,
					);
					await message.reply({ embeds: [standbyEmbed] });
					const { generateAndSendDirectorBriefing } = await import(
						"@sentinel/utils"
					);
					const { db, desc, oilRigSnapshots } = await import(
						"@sentinel/database"
					);
					await generateAndSendDirectorBriefing({
						useLiveData: true,
						fetchLiveData: async () => {
							const { tornApi } = await import("@sentinel/torn-api");
							const live = await tornApi.getPersonal("/company", {
								queryParams: { selections: ["profile", "employees", "stock"] },
							});
							return live as unknown as import("@sentinel/utils").CompanySnapshot;
						},
						fetchHistory: async () => {
							const rows = await db
								.select()
								.from(oilRigSnapshots)
								.orderBy(desc(oilRigSnapshots.timestamp))
								.limit(14);
							const chronological = rows.reverse();
							return chronological.map((r, idx) => {
								const rawEmps = (
									Array.isArray(r.employees) ? r.employees : []
								) as Array<Record<string, unknown>>;
								const dailyWages = rawEmps.reduce(
									(sum, e) => sum + Number(e.wage ?? 0),
									0,
								);
								const dailyProfit =
									r.dailyRevenue - dailyWages - (r.adBudget ?? 0);

								let dailyProduced: number | undefined;
								const prev = idx > 0 ? chronological[idx - 1] : undefined;
								if (prev && r.barrelsSold >= 0) {
									const delta = r.barrelsInStock - prev.barrelsInStock;
									const est = delta + r.barrelsSold;
									if (est >= 0) {
										dailyProduced = est;
									}
								}

								return {
									timestamp: Math.floor(r.timestamp.getTime() / 1000),
									isoDate: r.timestamp.toISOString().slice(0, 10),
									stars: r.rating,
									dailyIncome: r.dailyRevenue,
									weeklyIncome: r.weeklyRevenue,
									dailyWages,
									dailyProfit,
									dailyProduced,
									efficiency: r.efficiency,
									environment: r.environment,
									popularity: r.popularity,
									adBudget: r.adBudget,
									stock: {
										barrelPrice: r.barrelPrice,
										inStock: r.barrelsInStock,
										soldAmount: r.barrelsSold,
										fillPct:
											r.storageCapacity > 0
												? Number(
														(
															(r.barrelsInStock / r.storageCapacity) *
															100
														).toFixed(1),
													)
												: 0,
									},
									metrics: {
										totalAddictionPenalty: Number(
											(r.metrics as { totalAddictionPenalty?: number })
												?.totalAddictionPenalty ?? 0,
										),
										employeesWithAddiction: Number(
											(r.metrics as { employeesWithAddiction?: number })
												?.employeesWithAddiction ?? 0,
										),
									},
								};
							});
						},
					});
				} catch (err) {
					logger.error("Failed to generate on-demand oil briefing in DM:", err);
					await message.reply({
						embeds: [
							createErrorEmbed(
								"Briefing Generation Failed",
								`Failed to generate briefing: ${err instanceof Error ? err.message : String(err)}`,
							),
						],
					});
				}
			}
		}
	});

	// Register IPC event listeners for real-time dashboard dispatches
	setupBotIpcListeners(client);

	// Start lightweight internal healthcheck server
	const healthPort = Number(process.env.BOT_HEALTH_PORT) || 3000;
	const healthServer = Bun.serve({
		port: healthPort,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health" || url.pathname === "/") {
				const isReady = client.isReady() && client.ws.status === Status.Ready;
				return isReady
					? Response.json({
							status: "ok",
							service: "sentinel-bot",
							ping: client.ws.ping,
							uptime: process.uptime(),
						})
					: new Response("Bot gateway disconnected", { status: 503 });
			}
			return new Response("Not Found", { status: 404 });
		},
	});
	logger.info(`Healthcheck server listening on port ${healthPort}`);

	const shutdown = (signal: string) => {
		logger.info(`Received ${signal}. Shutting down Discord bot client...`);
		healthServer.stop();
		client.destroy();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("unhandledRejection", (reason) => {
		logger.error("Unhandled Promise Rejection in Discord Bot:", reason);
	});
	process.on("uncaughtException", (error) => {
		logger.error("Uncaught Exception in Discord Bot:", error);
	});

	try {
		logger.info("Connecting Discord Bot V2 client...");
		await client.login(token);
	} catch (error) {
		logger.error("Failed to connect Discord Bot V2:", error);
	}
}

main();
