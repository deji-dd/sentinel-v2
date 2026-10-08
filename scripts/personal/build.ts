import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function getVersion(): string {
	const versionPath = join(import.meta.dir, "version.json");
	try {
		const raw = readFileSync(versionPath, "utf-8");
		const data = JSON.parse(raw) as {
			major: number;
			minor: number;
			patch: number;
		};
		const shouldBump =
			process.argv.includes("--bump") || process.env.BUMP_VERSION === "true";
		if (shouldBump) {
			if (process.argv.includes("--major")) {
				data.major = (data.major ?? 0) + 1;
				data.minor = 0;
				data.patch = 0;
			} else if (process.argv.includes("--minor")) {
				data.minor = (data.minor ?? 0) + 1;
				data.patch = 0;
			} else {
				data.patch = (data.patch ?? 0) + 1;
			}
			writeFileSync(
				versionPath,
				`${JSON.stringify(data, null, "\t")}\n`,
				"utf-8",
			);
		}
		return `${data.major}.${data.minor}.${data.patch}`;
	} catch {
		return "1.0.1";
	}
}

function getMetadataBanner(version: string): string {
	return `// ==UserScript==
// @name         Blasted's Script
// @namespace    blasted.torn
// @version      ${version}
// @description  Personal Torn analytics and intelligence hub: Crimes ROI, Battlestats, Wealth, and more
// @author       Blasted [1934909]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.blasted-labs.tech
// @connect      sentinel.blasted-labs.tech
// @connect      localhost
// @connect      127.0.0.1
// @downloadURL  https://api.blasted-labs.tech/v2/personal/script.user.js
// @updateURL    https://api.blasted-labs.tech/v2/personal/script.user.js
// @run-at       document-idle
// ==/UserScript==

`;
}

async function build() {
	const startTime = performance.now();
	const version = getVersion();
	const entryPath = join(import.meta.dir, "src/index.ts");
	const outPath = join(import.meta.dir, "../blasted-script.user.js");

	const result = await Bun.build({
		entrypoints: [entryPath],
		target: "browser",
		format: "iife",
		minify: false, // Keep readable for inspection
		sourcemap: "none",
	});

	if (!result.success) {
		console.error("Build failed:", result.logs);
		process.exit(1);
	}

	const output = await result.outputs[0]?.text();
	if (!output) {
		console.error("No output generated from build.");
		process.exit(1);
	}

	const finalCode = `${getMetadataBanner(version)}${output}`;
	writeFileSync(outPath, finalCode, "utf-8");

	const elapsed = (performance.now() - startTime).toFixed(2);
	console.log(
		`Successfully built Blasted's Script v${version} -> ${outPath} (${elapsed}ms)`,
	);
}

build();
