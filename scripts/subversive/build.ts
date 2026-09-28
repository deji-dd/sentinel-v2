import { join } from "node:path";
import { getMetadataHeader } from "./metadata";

const SCRIPT_DIR = import.meta.dir;
const ROOT_DIR = join(SCRIPT_DIR, "../..");
const OUT_FILE = join(ROOT_DIR, "scripts/subversive-alliance.user.js");
const VERSION_FILE = join(SCRIPT_DIR, "version.json");
const ENTRY_FILE = join(SCRIPT_DIR, "src/index.ts");

function parseSemver(v: string): [number, number, number] {
	const parts = v.trim().split(".").map(Number);
	return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

async function bumpVersion(
	type: "patch" | "minor" | "major" = "patch",
): Promise<string> {
	const versionData = (await Bun.file(VERSION_FILE).json()) as {
		version: string;
	};
	const [major, minor, patch] = parseSemver(versionData.version || "1.0.0");

	let next = "";
	if (type === "major") next = `${major + 1}.0.0`;
	else if (type === "minor") next = `${major}.${minor + 1}.0`;
	else next = `${major}.${minor}.${patch + 1}`;

	versionData.version = next;
	await Bun.write(VERSION_FILE, `${JSON.stringify(versionData, null, "\t")}\n`);
	return next;
}

async function getVersion(): Promise<string> {
	try {
		const data = await Bun.file(VERSION_FILE).json();
		return data.version || "1.0.0";
	} catch {
		return "1.0.0";
	}
}

async function build(): Promise<boolean> {
	const start = performance.now();
	const version = await getVersion();

	const buildResult = await Bun.build({
		entrypoints: [ENTRY_FILE],
		target: "browser",
		format: "iife",
		minify: false,
	});

	if (!buildResult.success) {
		console.error("❌ Build failed:");
		for (const log of buildResult.logs) {
			console.error(log);
		}
		return false;
	}

	const code = await buildResult.outputs[0]?.text();
	if (!code) {
		console.error("❌ Output code was empty.");
		return false;
	}

	const banner = getMetadataHeader(version);
	const output = `${banner}\n\n${code}`;
	await Bun.write(OUT_FILE, output);

	// Ensure generated bundle conforms to Biome formatting
	Bun.spawnSync(["bunx", "@biomejs/biome", "format", "--write", OUT_FILE]);

	const ms = (performance.now() - start).toFixed(1);
	console.log(
		`✅ [Subversive Alliance] v${version} built -> scripts/subversive-alliance.user.js (${ms}ms)`,
	);
	return true;
}

const args = process.argv.slice(2);
const shouldBump = args.includes("--bump");

if (shouldBump) {
	// Support: bun subversive:bump --minor  OR  bun subversive:bump --patch  OR  bun subversive:bump (defaults to patch)
	const type = args.includes("--major")
		? "major"
		: args.includes("--minor")
			? "minor"
			: "patch";
	const nextVersion = await bumpVersion(type);
	console.log(`🚀 Bumped version to v${nextVersion} (${type})`);
}

await build();
