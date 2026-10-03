import { Elysia, t } from "elysia";

export async function serveBlastedUserscript(
	query: { env?: string },
	set: {
		status?: number | string;
		headers: Record<string, string | number | undefined>;
	},
) {
	const candidatePaths = [
		`${process.cwd()}/scripts/blasted-script.user.js`,
		`${process.cwd()}/../../scripts/blasted-script.user.js`,
	];
	let file = Bun.file(candidatePaths[0] ?? "");
	for (const p of candidatePaths) {
		const candidate = Bun.file(p);
		if (await candidate.exists()) {
			file = candidate;
			break;
		}
	}
	if (!(await file.exists())) {
		set.status = 404;
		return "Userscript file not found.";
	}
	let content = await file.text();
	if (query.env === "dev") {
		content = content
			.replace(
				/apiUrl:\s*"https:\/\/(?:sentinel|api)\.blasted-labs\.tech"/g,
				'apiUrl: "http://localhost:3000"',
			)
			.replace(
				/@downloadURL\s+https:\/\/(?:sentinel|api)\.blasted-labs\.tech\/(?:api\/v1\/system\/crime-ledger|v2\/system\/crime-ledger|v2\/personal)\/script\.user\.js/g,
				"@downloadURL  http://localhost:3000/v2/personal/script.user.js?env=dev",
			)
			.replace(
				/@updateURL\s+https:\/\/(?:sentinel|api)\.blasted-labs\.tech\/(?:api\/v1\/system\/crime-ledger|v2\/system\/crime-ledger|v2\/personal)\/script\.user\.js/g,
				"@updateURL    http://localhost:3000/v2/personal/script.user.js?env=dev",
			);
	}
	set.headers["content-type"] = "application/javascript; charset=utf-8";
	set.headers["cache-control"] = "no-cache";
	return content;
}

export const personalRoutes = new Elysia({ prefix: "/personal" })
	// ─── GET /v2/personal/script & /v2/personal/script.user.js (Serve Blasted's Script) ───
	.get(
		"/script",
		async ({ query, set }) => {
			return serveBlastedUserscript(query, set);
		},
		{
			query: t.Object({
				env: t.Optional(t.String()),
			}),
			detail: {
				summary: "Serve Blasted's Script",
				description:
					"Serves the Blasted's Script personal userscript with optional dev environment override.",
			},
		},
	)
	.get(
		"/script.user.js",
		async ({ query, set }) => {
			return serveBlastedUserscript(query, set);
		},
		{
			query: t.Object({
				env: t.Optional(t.String()),
			}),
			detail: {
				summary: "Serve Blasted's Script (Tampermonkey direct install)",
				description:
					"Serves the Blasted's Script personal userscript directly for browser userscript managers.",
			},
		},
	);
