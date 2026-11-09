/**
 * Extracts the profile picture URL from a Torn user profile response.
 *
 * Torn API v1 returns a flat object with `profile_image`; v2 (and some older
 * responses) nest it under `profile.image` or `profile.profile_image`. The
 * chat avatar toggle used to read only the nested `image` field, so every
 * valid key looked like it had no picture and the request failed with a 502.
 */
export function pickTornAvatarUrl(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	const nested =
		typeof value.profile === "object" && value.profile !== null
			? (value.profile as Record<string, unknown>)
			: null;
	const candidates = [
		value.profile_image,
		nested?.profile_image,
		value.image,
		nested?.image,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.startsWith("https://")) {
			return candidate;
		}
	}
	return null;
}
