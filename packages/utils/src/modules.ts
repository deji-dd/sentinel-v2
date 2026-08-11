export const VALID_MODULE_KEYS = [
	"verification",
	"territory",
	"reaction_role",
] as const;

export type ModuleKey = (typeof VALID_MODULE_KEYS)[number];

const MODULE_ALIASES: Record<string, ModuleKey> = {
	verification: "verification",
	verify: "verification",
	verifications: "verification",
	territory: "territory",
	territories: "territory",
	reaction_role: "reaction_role",
	reaction_roles: "reaction_role",
	reactions: "reaction_role",
	reaction: "reaction_role",
};

/**
 * Normalizes an array of raw module strings (e.g. from DB or API input)
 * into a clean, deduplicated array containing only valid canonical singular ModuleKeys.
 */
export function normalizeModules(
	modules: string[] | null | undefined,
): ModuleKey[] {
	if (!modules || !Array.isArray(modules)) return [];
	const normalized = new Set<ModuleKey>();
	for (const mod of modules) {
		if (typeof mod !== "string") continue;
		const canonical = MODULE_ALIASES[mod.toLowerCase().trim()];
		if (canonical) {
			normalized.add(canonical);
		}
	}
	return Array.from(normalized);
}

/**
 * Checks if a specific module (or alias) is enabled in a module list.
 */
export function isModuleEnabled(
	enabledModules: string[] | null | undefined,
	moduleKey: string,
): boolean {
	if (
		!enabledModules ||
		!Array.isArray(enabledModules) ||
		enabledModules.length === 0
	)
		return false;
	const canonicalTarget = MODULE_ALIASES[moduleKey.toLowerCase().trim()];
	if (!canonicalTarget) return false;
	for (const mod of enabledModules) {
		if (
			typeof mod === "string" &&
			MODULE_ALIASES[mod.toLowerCase().trim()] === canonicalTarget
		) {
			return true;
		}
	}
	return false;
}
