import { treaty } from "@elysiajs/eden";
import type { App } from "@sentinel/api";

/**
 * Eden Treaty client providing 100% end-to-end TypeScript autocomplete & type safety.
 * Connects to the same origin as the serving API (avoids CORS since same-origin).
 */
export const api = treaty<App>(window.location.origin);
