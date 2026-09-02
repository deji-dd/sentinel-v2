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
	logger.info(`Lightweight healthcheck server listening on port ${healthPort}`);

	const shutdown = (signal: string) => {
		logger.info(`Received ${signal}. Shutting down Discord bot client...`);
		healthServer.stop();
		client.destroy();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	try {
		logger.info("Connecting Discord Bot V2 client...");
		await client.login(token);
	} catch (error) {
		logger.error("Failed to connect Discord Bot V2:", error);
	}
}

main();
