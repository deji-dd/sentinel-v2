import { Elysia } from "elysia";

export interface SwaggerDomainConfig {
	title: string;
	description: string;
	isPathAllowed: (path: string) => boolean;
}

const ELIMS_EXACT_PATHS = new Set([
	"/users",
	"/api/users",
	"/api/v1/users",
	"/api/elims/users",
]);

export const DOMAIN_CONFIGS: Record<string, SwaggerDomainConfig> = {
	// Elims Tournament Dashboard
	"elims.blasted-labs.tech": {
		title: "Sentinel V2 — Elims API",
		description:
			"Tournament and elimination tracking endpoints for Sentinel Elims Dashboard.",
		isPathAllowed: (path: string) =>
			path.startsWith("/api/health") ||
			path.startsWith("/api/v1/elims") ||
			path.startsWith("/api/v1/auth") ||
			path.startsWith("/api/ws/elims-tournament") ||
			path.startsWith("/ws/elims-tournament") ||
			ELIMS_EXACT_PATHS.has(path),
	},

	// Territory War (TT) Selector
	"tt-selector.blasted-labs.tech": {
		title: "Sentinel V2 — TT Selector API",
		description: "Territory war & target selector endpoints.",
		isPathAllowed: (path: string) =>
			path.startsWith("/api/health") ||
			path.startsWith("/api/v1/tt") ||
			path.startsWith("/api/v1/auth"),
	},

	// Bot Configuration Dashboard
	"sentinel.blasted-labs.tech": {
		title: "Sentinel V2 — Bot Configuration API",
		description:
			"Guild configuration, verification, and reaction roles API for Sentinel Bot.",
		isPathAllowed: (path: string) =>
			path.startsWith("/api/health") ||
			path.startsWith("/api/v1/guilds") ||
			path.startsWith("/api/v1/auth"),
	},

	// User Dashboard
	"sentinel.ayodejib.dev": {
		title: "Sentinel V2 — User Dashboard API",
		description:
			"Ledger analytics, personal wealth, crime stats, and real-time ledger feeds.",
		isPathAllowed: (path: string) =>
			path.startsWith("/api/health") ||
			path.startsWith("/api/v1/system") ||
			path.startsWith("/api/v1/auth") ||
			path.startsWith("/api/ws/"),
	},
};

export const DEFAULT_SWAGGER_CONFIG: SwaggerDomainConfig = {
	title: "Sentinel V2 API Documentation",
	description:
		"Scalable backend API serving Sentinel V2 UIs and automation services.",
	isPathAllowed: () => true,
};

export function resolveDomainConfig(request: Request): SwaggerDomainConfig {
	const hostHeader = request.headers.get("host") ?? "";
	const forwardedHost = request.headers.get("x-forwarded-host") ?? "";
	const originHeader = request.headers.get("origin") ?? "";

	let urlHostname = "";
	try {
		urlHostname = new URL(request.url).hostname.toLowerCase();
	} catch {
		// Ignore invalid URL
	}

	const host =
		hostHeader.split(":")[0]?.toLowerCase() ||
		forwardedHost.split(":")[0]?.toLowerCase() ||
		urlHostname;

	// Explicit check for swagger.ayodejib.dev or localhost/127.0.0.1 -> default full API
	if (
		host === "swagger.ayodejib.dev" ||
		host === "localhost" ||
		host === "127.0.0.1" ||
		!host
	) {
		return DEFAULT_SWAGGER_CONFIG;
	}

	const directMatch = DOMAIN_CONFIGS[host];
	if (directMatch) {
		return directMatch;
	}

	// Try finding match from origin header if host header was generic (e.g. reverse proxy)
	if (originHeader) {
		try {
			const originUrl = new URL(originHeader);
			const originHost = originUrl.hostname.toLowerCase();
			const originMatch = DOMAIN_CONFIGS[originHost];
			if (originMatch) {
				return originMatch;
			}
		} catch {
			// Ignore invalid origin URL
		}
	}

	// Fallback to default full API
	return DEFAULT_SWAGGER_CONFIG;
}

/**
 * Elysia plugin that intercepts `/swagger` and `/swagger/json`
 * to dynamically filter the OpenAPI specification and customize titles per domain.
 */
export const swaggerDomainFilterPlugin = new Elysia({
	name: "middleware.swaggerDomainFilter",
}).mapResponse({ as: "global" }, async ({ request, path, response }) => {
	// Handle /swagger/json
	if (
		(path === "/swagger/json" || path === "/swagger/json/") &&
		typeof response === "object" &&
		response !== null
	) {
		const config = resolveDomainConfig(request);
		const spec = response as Record<string, unknown>;

		const rawPaths = (spec.paths as Record<string, unknown> | undefined) ?? {};
		const filteredPaths: Record<string, unknown> = {};
		const usedTags = new Set<string>();

		for (const [routePath, methods] of Object.entries(rawPaths)) {
			if (config.isPathAllowed(routePath)) {
				filteredPaths[routePath] = methods;
				if (typeof methods === "object" && methods !== null) {
					for (const methodConfig of Object.values(methods)) {
						if (
							typeof methodConfig === "object" &&
							methodConfig !== null &&
							"tags" in methodConfig &&
							Array.isArray((methodConfig as { tags: unknown }).tags)
						) {
							for (const tag of (methodConfig as { tags: unknown[] }).tags) {
								if (typeof tag === "string") {
									usedTags.add(tag);
								}
							}
						}
					}
				}
			}
		}

		const rawInfo = (spec.info as Record<string, unknown> | undefined) ?? {};
		const updatedInfo = {
			...rawInfo,
			title: config.title,
			description: config.description,
		};

		const rawTags = spec.tags;
		const filteredTags = Array.isArray(rawTags)
			? rawTags.filter((t) => {
					if (typeof t === "object" && t !== null && "name" in t) {
						const name = (t as { name: unknown }).name;
						return typeof name === "string" && usedTags.has(name);
					}
					return false;
				})
			: rawTags;

		const scopedSpec = {
			...spec,
			info: updatedInfo,
			paths: filteredPaths,
			tags: filteredTags,
		};

		return new Response(JSON.stringify(scopedSpec), {
			headers: {
				"content-type": "application/json; charset=utf-8",
			},
		});
	}

	// Handle /swagger HTML
	if (path === "/swagger" || path === "/swagger/") {
		const config = resolveDomainConfig(request);
		const rawRes =
			typeof response === "function"
				? (response as () => Response)()
				: response;

		if (rawRes instanceof Response) {
			const html = await rawRes.text();
			const updatedHtml = html
				.replace(/<title>.*?<\/title>/, `<title>${config.title}</title>`)
				.replace(
					/<meta\s+name="description"\s+content=".*?"\s*\/?>/i,
					`<meta name="description" content="${config.description}" />`,
				)
				.replace(
					/<meta\s+name="og:description"\s+content=".*?"\s*\/?>/i,
					`<meta name="og:description" content="${config.description}" />`,
				);

			return new Response(updatedHtml, {
				headers: {
					"content-type": "text/html; charset=utf8",
				},
			});
		}
	}
});
