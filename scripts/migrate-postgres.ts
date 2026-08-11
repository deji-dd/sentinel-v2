import { spawnSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import postgres from "postgres";
import {
	apiKeys,
	db,
	factionRoleMappings,
	guildApiKeys,
	guildConfigs,
	personalLogs,
	reactionRoleMappings,
	reactionRoleMessages,
	verificationLogs,
	verifiedUsers,
} from "../packages/database";
import { encryptApiKey } from "../packages/torn-api";
import { Logger } from "../packages/utils";

function getVal<T = unknown>(
	row: Record<string, unknown>,
	snakeKey: string,
	camelKey: string,
): T | undefined {
	if (row[snakeKey] !== undefined) return row[snakeKey] as T;
	if (row[camelKey] !== undefined) return row[camelKey] as T;
	return undefined;
}

function standardizeEncryptedKey(rawEncrypted: string): string {
	const masterKey = process.env.ENCRYPTION_KEY || "";
	if (!rawEncrypted || !masterKey) return rawEncrypted;

	// Legacy 16-byte IV payload format (96 hex chars: 32 IV + 32 Tag + 32 Cipher)
	if (rawEncrypted.length === 96) {
		try {
			const derivedKey = createHash("sha256").update(masterKey).digest();
			const ivHex = rawEncrypted.slice(0, 32);
			const tagHex = rawEncrypted.slice(32, 64);
			const ciphertextHex = rawEncrypted.slice(64);

			const decipher = createDecipheriv(
				"aes-256-gcm",
				derivedKey,
				Buffer.from(ivHex, "hex"),
			);
			decipher.setAuthTag(Buffer.from(tagHex, "hex"));
			let plainText = decipher.update(
				Buffer.from(ciphertextHex, "hex"),
				undefined,
				"utf8",
			);
			plainText += decipher.final("utf8");

			if (plainText) {
				return encryptApiKey(plainText, masterKey);
			}
		} catch {}
	}
	return rawEncrypted;
}

const logger = new Logger("PostgresMigratorCLI");

// ─── ANSI Styling ─────────────────────────────────────────────────────────────
const ESC = "\x1b";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const CYAN = `${CSI}36m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;

function printBanner() {
	console.log(`
${CYAN}${BOLD}===============================================================
       Sentinel v2 — Production Database Migration CLI
   PostgreSQL ➔ SQLite (sentinel.db) One-to-One Migrator
===============================================================${RESET}
`);
}

function printHelp() {
	printBanner();
	console.log(`
${BOLD}USAGE:${RESET}
  bun run db:migrate:postgres [options]

${BOLD}OPTIONS:${RESET}
  --url <connection_string>   Full Postgres connection URI 
                              (e.g., postgres://user:pass@host:5432/dbname)
  --host <hostname>           Postgres host (default: localhost or PGHOST)
  --port <port>               Postgres port (default: 5432 or PGPORT)
  --user <username>           Postgres username (default: postgres or PGUSER)
  --password <password>       Postgres password (default: PGPASSWORD)
  --dbname <name>             Postgres database name (default: sentinel or PGDATABASE)
  --use-psql                  Use system 'psql' CLI binary for data extraction
  --tables <table1,table2>   Migrate only specific comma-separated tables
  --dry-run                   Query Postgres count without modifying SQLite
  --help                      Show this help dialog

${BOLD}EXAMPLES:${RESET}
  # Dev Migration (uses NODE_ENV=development):
  bun db:migrate:postgres:dev

  # Prod Migration (uses NODE_ENV=production):
  bun db:migrate:postgres:prod

  # Using connection URL:
  bun run db:migrate:postgres --url "postgres://postgres:secret@127.0.0.1:5432/sentinel_prod"
`);
}

// ─── CLI Argument Parser ──────────────────────────────────────────────────────
type CliOptions = {
	url?: string;
	host?: string;
	port?: number;
	user?: string;
	password?: string;
	dbname?: string;
	usePsql: boolean;
	tables?: string[];
	dryRun: boolean;
	help: boolean;
};

function parseArgs(args: string[]): CliOptions {
	const opts: CliOptions = {
		usePsql: false,
		dryRun: false,
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg === "--help" || arg === "-h") {
			opts.help = true;
		} else if (arg === "--use-psql") {
			opts.usePsql = true;
		} else if (arg === "--dry-run") {
			opts.dryRun = true;
		} else if (arg === "--url" && args[i + 1]) {
			opts.url = args[++i];
		} else if (arg === "--host" && args[i + 1]) {
			opts.host = args[++i];
		} else if (arg === "--port" && args[i + 1]) {
			opts.port = Number(args[++i]);
		} else if (arg === "--user" && args[i + 1]) {
			opts.user = args[++i];
		} else if (arg === "--password" && args[i + 1]) {
			opts.password = args[++i];
		} else if (arg === "--dbname" && args[i + 1]) {
			opts.dbname = args[++i];
		} else if (arg === "--tables" && args[i + 1]) {
			const rawTables = args[++i];
			if (rawTables) {
				opts.tables = rawTables.split(",").map((t) => t.trim());
			}
		}
	}
	return opts;
}

function cleanConnectionString(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.searchParams.has("schema")) {
			const schema = parsed.searchParams.get("schema");
			parsed.searchParams.delete("schema");
			if (schema && !parsed.searchParams.has("search_path")) {
				parsed.searchParams.set("search_path", schema);
			}
		}
		return parsed.toString();
	} catch {
		return rawUrl;
	}
}

function buildConnectionString(opts: CliOptions): string {
	let rawUrl = opts.url;
	if (!rawUrl) rawUrl = process.env.POSTGRES_URL;

	if (rawUrl) {
		return cleanConnectionString(rawUrl);
	}

	return "";
}

// ─── Utility Data Transformers ─────────────────────────────────────────────
function toDate(val: unknown): Date {
	if (val instanceof Date) return val;
	if (typeof val === "string" || typeof val === "number") return new Date(val);
	return new Date();
}

function toNullableDate(val: unknown): Date | null {
	if (!val) return null;
	if (val instanceof Date) return val;
	if (typeof val === "string" || typeof val === "number") return new Date(val);
	return null;
}

function parseJsonArray<T = string>(val: unknown): T[] {
	if (Array.isArray(val)) return val as T[];
	if (typeof val === "string") {
		try {
			const parsed = JSON.parse(val);
			if (Array.isArray(parsed)) return parsed as T[];
		} catch {}
	}
	return [];
}

// ─── Data Extraction Engine ──────────────────────────────────────────────────
async function fetchRowsPostgres(
	connUrl: string,
	usePsql: boolean,
	tableName: string,
): Promise<Record<string, unknown>[]> {
	if (usePsql) {
		const query = `SELECT json_agg(t) FROM (SELECT * FROM ${tableName}) t;`;
		const res = spawnSync("psql", [connUrl, "-t", "-A", "-c", query], {
			encoding: "utf-8",
			maxBuffer: 100 * 1024 * 1024,
		});

		if (res.error) {
			throw new Error(`System psql execution error: ${res.error.message}`);
		}
		if (res.status !== 0) {
			throw new Error(
				`psql command failed with exit code ${res.status}: ${res.stderr}`,
			);
		}

		const stdout = res.stdout.trim();
		if (!stdout || stdout === "null") return [];
		try {
			return JSON.parse(stdout) as Record<string, unknown>[];
		} catch (e) {
			throw new Error(
				`Failed to parse JSON output from psql for table ${tableName}: ${String(e)}`,
			);
		}
	}

	const sql = postgres(connUrl, { max: 1, idle_timeout: 5 });
	try {
		const rows = (await sql.unsafe(`SELECT * FROM ${tableName};`)) as Record<
			string,
			unknown
		>[];
		await sql.end();
		return rows;
	} catch (err) {
		await sql.end();
		throw err;
	}
}

// ─── Migration Processors ─────────────────────────────────────────────────────
async function processTable(
	tableName: string,
	rows: Record<string, unknown>[],
	dryRun: boolean,
): Promise<number> {
	if (rows.length === 0) {
		logger.info(`[${tableName}] 0 records found in Postgres.`);
		return 0;
	}

	if (dryRun) {
		logger.info(
			`${YELLOW}[Dry Run] ${tableName}: ${rows.length} records ready for migration.${RESET}`,
		);
		return rows.length;
	}

	let migrated = 0;
	switch (tableName) {
		case "api_keys":
			for (const row of rows) {
				const idVal = getVal<string>(row, "id", "id");
				const userIdVal = getVal<number>(row, "user_id", "userId");
				const rawEncKey = getVal<string>(
					row,
					"api_key_encrypted",
					"apiKeyEncrypted",
				);
				const keyHash = getVal<string>(row, "api_key_hash", "apiKeyHash");

				if (userIdVal === undefined || !rawEncKey || !keyHash) {
					logger.warn(
						`Skipping api_keys row due to missing required fields: ${JSON.stringify(row)}`,
					);
					continue;
				}

				await db
					.insert(apiKeys)
					.values({
						id: String(idVal ?? crypto.randomUUID()),
						userId: Number(userIdVal),
						apiKeyEncrypted: standardizeEncryptedKey(String(rawEncKey)),
						apiKeyHash: String(keyHash),
						keyType: String(getVal(row, "key_type", "keyType") ?? "personal"),
						isValid: Boolean(getVal(row, "is_valid", "isValid") ?? true),
						invalidCount: Number(
							getVal(row, "invalid_count", "invalidCount") ?? 0,
						),
						lastInvalidAt: toNullableDate(
							getVal(row, "last_invalid_at", "lastInvalidAt"),
						),
						lastUsedAt: toNullableDate(
							getVal(row, "last_used_at", "lastUsedAt"),
						),
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "guild_configs":
			for (const row of rows) {
				const guildIdVal = getVal<string>(row, "guild_id", "guildId");
				if (!guildIdVal) continue;

				await db
					.insert(guildConfigs)
					.values({
						guildId: String(guildIdVal),
						logChannelId:
							(getVal<string>(row, "log_channel_id", "logChannelId") as
								| string
								| null) ?? null,
						adminRoleIds: parseJsonArray<string>(
							getVal(row, "admin_role_ids", "adminRoleIds"),
						),
						enabledModules: parseJsonArray<string>(
							getVal(row, "enabled_modules", "enabledModules"),
						),
						verifiedRoleIds: parseJsonArray<string>(
							getVal(row, "verified_role_ids", "verifiedRoleIds"),
						),
						nicknameTemplate:
							(getVal<string>(row, "nickname_template", "nicknameTemplate") as
								| string
								| null) ?? "[{tag}] {name} [{id}]",
						verifyOnJoin: Boolean(
							getVal(row, "verify_on_join", "verifyOnJoin") ?? false,
						),
						verifyCron: Boolean(
							getVal(row, "verify_cron", "verifyCron") ?? false,
						),
						verifyCronInterval: Number(
							getVal(row, "verify_cron_interval", "verifyCronInterval") ?? 24,
						),
						lastVerifyCronAt: toNullableDate(
							getVal(row, "last_verify_cron_at", "lastVerifyCronAt"),
						),
						protectedRoleIds: parseJsonArray<string>(
							getVal(row, "protected_role_ids", "protectedRoleIds"),
						),
						factionListChannelId:
							(getVal<string>(
								row,
								"faction_list_channel_id",
								"factionListChannelId",
							) as string | null) ?? null,
						factionListMessageIds: parseJsonArray<string>(
							getVal(row, "faction_list_message_ids", "factionListMessageIds"),
						),
						ttFullChannelId:
							(getVal<string>(row, "tt_full_channel_id", "ttFullChannelId") as
								| string
								| null) ?? null,
						ttFilteredChannelId:
							(getVal<string>(
								row,
								"tt_filtered_channel_id",
								"ttFilteredChannelId",
							) as string | null) ?? null,
						ttTerritoryIds: parseJsonArray<string>(
							getVal(row, "tt_territory_ids", "ttTerritoryIds"),
						),
						ttFactionIds: parseJsonArray<number>(
							getVal(row, "tt_faction_ids", "ttFactionIds"),
						),
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "reaction_role_messages":
			for (const row of rows) {
				await db
					.insert(reactionRoleMessages)
					.values({
						id: String(getVal(row, "id", "id") ?? crypto.randomUUID()),
						guildId: String(getVal(row, "guild_id", "guildId")),
						title: String(getVal(row, "title", "title")),
						channelId: String(getVal(row, "channel_id", "channelId")),
						messageId:
							(getVal<string>(row, "message_id", "messageId") as
								| string
								| null) ?? null,
						requiredRoleId:
							(getVal<string>(row, "required_role_id", "requiredRoleId") as
								| string
								| null) ?? null,
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "reaction_role_mappings":
			for (const row of rows) {
				await db
					.insert(reactionRoleMappings)
					.values({
						id: String(getVal(row, "id", "id") ?? crypto.randomUUID()),
						messageId: String(getVal(row, "message_id", "messageId")),
						emoji: String(getVal(row, "emoji", "emoji")),
						roleId: String(getVal(row, "role_id", "roleId")),
						description:
							(getVal<string>(row, "description", "description") as
								| string
								| null) ?? null,
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "guild_api_keys":
			for (const row of rows) {
				const guildIdVal = getVal<string>(row, "guild_id", "guildId");
				const rawEncKey = getVal<string>(
					row,
					"api_key_encrypted",
					"apiKeyEncrypted",
				);
				const keyHash = getVal<string>(row, "api_key_hash", "apiKeyHash");

				if (!guildIdVal || !rawEncKey || !keyHash) continue;

				await db
					.insert(guildApiKeys)
					.values({
						id: String(getVal(row, "id", "id") ?? crypto.randomUUID()),
						guildId: String(guildIdVal),
						userId: getVal(row, "user_id", "userId")
							? Number(getVal(row, "user_id", "userId"))
							: null,
						apiKeyEncrypted: standardizeEncryptedKey(String(rawEncKey)),
						apiKeyHash: String(keyHash),
						providedBy:
							(getVal<string>(row, "provided_by", "providedBy") as
								| string
								| null) ?? null,
						isValid: Boolean(getVal(row, "is_valid", "isValid") ?? true),
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "faction_role_mappings":
			for (const row of rows) {
				const guildIdVal = getVal<string>(row, "guild_id", "guildId");
				const factionIdVal = getVal<number>(row, "faction_id", "factionId");

				if (!guildIdVal || factionIdVal === undefined) {
					logger.warn(
						`Skipping faction_role_mappings row due to missing required fields: ${JSON.stringify(row)}`,
					);
					continue;
				}

				await db
					.insert(factionRoleMappings)
					.values({
						id: String(getVal(row, "id", "id") ?? crypto.randomUUID()),
						guildId: String(guildIdVal),
						factionId: Number(factionIdVal),
						factionName:
							(getVal<string>(row, "faction_name", "factionName") as
								| string
								| null) ?? null,
						memberRoleIds: parseJsonArray<string>(
							getVal(row, "member_role_ids", "memberRoleIds"),
						),
						leaderRoleIds: parseJsonArray<string>(
							getVal(row, "leader_role_ids", "leaderRoleIds"),
						),
						enabled: Boolean(getVal(row, "enabled", "enabled") ?? true),
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "verified_users":
			for (const row of rows) {
				const discordIdVal = getVal<string>(row, "discord_id", "discordId");
				const tornIdVal = getVal<number>(row, "torn_id", "tornId");
				const tornNameVal = getVal<string>(row, "torn_name", "tornName");

				if (!discordIdVal || tornIdVal === undefined || !tornNameVal) {
					logger.warn(
						`Skipping verified_users row due to missing required fields: ${JSON.stringify(row)}`,
					);
					continue;
				}

				await db
					.insert(verifiedUsers)
					.values({
						discordId: String(discordIdVal),
						tornId: Number(tornIdVal),
						tornName: String(tornNameVal),
						factionId: getVal(row, "faction_id", "factionId")
							? Number(getVal(row, "faction_id", "factionId"))
							: null,
						factionTag:
							(getVal<string>(row, "faction_tag", "factionTag") as
								| string
								| null) ?? null,
						lastCheckedAt: toDate(
							getVal(row, "last_checked_at", "lastCheckedAt") ??
								getVal(row, "updated_at", "updatedAt"),
						),
						createdAt: toDate(
							getVal(row, "created_at", "createdAt") ??
								getVal(row, "updated_at", "updatedAt"),
						),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "verification_logs":
			for (const row of rows) {
				await db
					.insert(verificationLogs)
					.values({
						id: String(getVal(row, "id", "id") ?? crypto.randomUUID()),
						guildId: String(getVal(row, "guild_id", "guildId")),
						discordId: String(getVal(row, "discord_id", "discordId")),
						status: String(getVal(row, "status", "status")),
						triggeredBy: String(
							getVal(row, "triggered_by", "triggeredBy") ?? "user",
						),
						rolesAdded: parseJsonArray<string>(
							getVal(row, "roles_added", "rolesAdded"),
						),
						rolesRemoved: parseJsonArray<string>(
							getVal(row, "roles_removed", "rolesRemoved"),
						),
						oldNickname:
							(getVal<string>(row, "old_nickname", "oldNickname") as
								| string
								| null) ?? null,
						newNickname:
							(getVal<string>(row, "new_nickname", "newNickname") as
								| string
								| null) ?? null,
						error:
							(getVal<string>(row, "error", "error") as string | null) ?? null,
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		case "personal_logs":
			for (const row of rows) {
				const idVal = getVal<string>(row, "id", "id");
				const logVal = getVal<number>(row, "log", "log");
				const dataVal = getVal<unknown>(row, "data", "data");

				if (!idVal || logVal === undefined || !dataVal) continue;

				await db
					.insert(personalLogs)
					.values({
						id: String(idVal),
						log: Number(logVal),
						title:
							(getVal<string>(row, "title", "title") as string | null) ?? null,
						timestamp: toDate(getVal(row, "timestamp", "timestamp")),
						category:
							(getVal<string>(row, "category", "category") as string | null) ??
							null,
						data:
							typeof dataVal === "string"
								? JSON.parse(dataVal)
								: (dataVal as Record<string, unknown>),
						createdAt: toDate(getVal(row, "created_at", "createdAt")),
						updatedAt: toDate(getVal(row, "updated_at", "updatedAt")),
					})
					.onConflictDoNothing();
				migrated++;
			}
			break;

		default:
			logger.warn(`Unknown table "${tableName}" ignored.`);
			return 0;
	}

	logger.info(
		`${GREEN}✓ Migrated ${migrated} records into SQLite table "${tableName}"${RESET}`,
	);
	return migrated;
}

// ─── Main Execution Handler ───────────────────────────────────────────────────
async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	printBanner();

	const connString = buildConnectionString(opts);
	const maskedConn = connString.replace(/:[^:@]+@/, ":****@");

	logger.info(`Target Postgres DB: ${maskedConn}`);
	logger.info(
		`Extraction Mode: ${opts.usePsql ? "System 'psql' binary" : "Native Driver"}`,
	);

	const allTables = [
		"api_keys",
		"guild_configs",
		"reaction_role_messages",
		"reaction_role_mappings",
		"guild_api_keys",
		"faction_role_mappings",
		"verified_users",
		"verification_logs",
		"personal_logs",
	];

	const targetTables = opts.tables
		? allTables.filter((t) => opts.tables?.includes(t))
		: allTables;

	if (targetTables.length === 0) {
		logger.error("No valid tables selected for migration.");
		process.exit(1);
	}

	logger.info(`Target tables: ${targetTables.join(", ")}\n`);

	let totalMigrated = 0;
	const startTime = Date.now();

	for (const table of targetTables) {
		try {
			const rows = await fetchRowsPostgres(connString, opts.usePsql, table);
			const count = await processTable(table, rows, opts.dryRun);
			totalMigrated += count;
		} catch (err) {
			logger.warn(`Failed or skipped table "${table}":`, err);
		}
	}

	const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`
${GREEN}${BOLD}===============================================================
  MIGRATION COMPLETE!
  Total Records Processed: ${totalMigrated}
  Duration: ${elapsedSec}s
===============================================================${RESET}
`);
}

main().catch((err) => {
	logger.error("Fatal Migration Error:", err);
	process.exit(1);
});
