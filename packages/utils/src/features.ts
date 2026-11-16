/**
 * Succession Oil / company feature switch.
 *
 * The company was sold, so every oil-rig surface (scheduler collectors, bot
 * slash commands and DM handlers, and the /v2/company API routes) consults this
 * one flag. All code and stored data stay in place; flipping the environment
 * variable back on restores the feature with no code changes.
 *
 * Disabled is the default: only an explicit truthy value enables it, so an
 * unset or mistyped value can never accidentally revive the collectors.
 */
export function isOilRigEnabled(): boolean {
	const raw = process.env.OIL_RIG_ENABLED?.trim().toLowerCase();
	return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}
