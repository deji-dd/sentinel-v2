import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { Elysia } from "elysia";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

/**
 * Host-based & SPA fallback static file serving plugin for Elysia.
 * Serves bundled static assets from web/bot-dashboard/dist or web/user-dashboard/dist based on request Host/Origin.
 */
export const staticSpaPlugin = new Elysia({ name: "middleware.staticSpa" }).get(
	"*",
	async ({ request, set }) => {
		const url = new URL(request.url);

		// Bypass API, Swagger, and system routes
		if (
			url.pathname.startsWith("/api") ||
			url.pathname.startsWith("/swagger")
		) {
			return;
		}

		const host = request.headers.get("host") ?? "";
		const origin = request.headers.get("origin") ?? "";

		let appDir = "web/bot-dashboard/dist";

		if (
			host.includes("tt-selector") ||
			host.startsWith("tt.") ||
			origin.includes("tt-selector")
		) {
			appDir = "web/tt-selector/dist";
		} else if (
			host.includes("user-dashboard") ||
			host.includes("ayodejib.dev") ||
			host.startsWith("user.") ||
			origin.includes("user-dashboard")
		) {
			appDir = "web/user-dashboard/dist";
		}

		const rootDir = join(import.meta.dir, "../../../..", appDir);
		const sharedDir = join(import.meta.dir, "../../../../web/shared-assets");
		const relativePath = url.pathname.slice(1);
		const filePath = join(rootDir, relativePath);
		const sharedFilePath = join(sharedDir, relativePath);

		// Serve static asset file if it exists in app dist or in web/shared-assets
		const targetFile =
			relativePath &&
			existsSync(filePath) &&
			(await Bun.file(filePath).exists())
				? filePath
				: relativePath &&
						existsSync(sharedFilePath) &&
						(await Bun.file(sharedFilePath).exists())
					? sharedFilePath
					: null;

		if (targetFile) {
			const file = Bun.file(targetFile);
			const ext = extname(targetFile).toLowerCase();
			const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

			return new Response(file, {
				headers: {
					"Content-Type": contentType,
					"Cache-Control":
						ext === ".html"
							? "no-cache"
							: "public, max-age=31536000, immutable",
				},
			});
		}

		// Fallback to index.html for HTML5 SPA client routing
		const indexPath = join(rootDir, "index.html");
		if (existsSync(indexPath)) {
			const indexFile = Bun.file(indexPath);
			return new Response(indexFile, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-cache",
				},
			});
		}

		set.status = 404;
		return {
			success: false,
			error:
				"Static SPA build files not found. Run bun bot-dashboard:build first.",
		};
	},
);
