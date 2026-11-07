/**
 * Authorisation for director-only oil-rig commands.
 *
 * `DISCORD_USER_ID` is the bot owner/director. The check is deliberately
 * fail-closed: when the variable is missing or blank nobody is authorised,
 * rather than everybody. Commands that send the director's private company
 * data must never become public because an environment variable was omitted.
 */
export function isDirectorUser(userId: string | null | undefined): boolean {
	const directorId = process.env.DISCORD_USER_ID?.trim();
	if (!directorId) return false;
	return userId?.trim() === directorId;
}
