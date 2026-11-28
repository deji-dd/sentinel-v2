export const NAV_ITEMS = [
	{ key: "factions", label: "Factions", hash: "#/" },
	{ key: "combat", label: "Combat", hash: "#/combat" },
	{ key: "revive", label: "Revive", hash: "#/revive" },
	{ key: "members", label: "Members", hash: "#/members" },
	{ key: "builder", label: "Builder", hash: "#/builder" },
	{ key: "prospective", label: "Prospective", hash: "#/prospective" },
	{ key: "methodology", label: "Methodology", hash: "#/methodology" },
	{ key: "admin", label: "Admin", hash: "#/admin" },
] as const;

export type RouteKey = (typeof NAV_ITEMS)[number]["key"];

export function parseRoute(hash: string): RouteKey {
	const path = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
	const match = NAV_ITEMS.find((item) => item.key === path);
	return match?.key ?? "factions";
}
