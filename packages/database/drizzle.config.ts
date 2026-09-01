import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema/index.ts",
	out: "./drizzle",
	dbCredentials: {
		url:
			process.env.DATABASE_URL ||
			`postgres://${process.env.POSTGRES_USER || "sentinel_user"}:${process.env.POSTGRES_PASSWORD || "sentinel_password"}@${process.env.POSTGRES_HOST || "localhost"}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || "sentinel_db"}`,
	},
});
