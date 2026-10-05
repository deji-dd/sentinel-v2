import type { LucideIcon } from "lucide-react";
import {
	Hash,
	MapPin,
	Settings,
	ShieldAlert,
	Smile,
	Target,
	TrendingUp,
	UserCheck,
	UserPlus,
} from "lucide-react";

export interface NavItem {
	label: string;
	/** Sub path within the guild, e.g. `/verification` or `""` for the root. */
	subPath: string;
	icon: LucideIcon;
	/** Tailwind text colour used for the item's icon accent. */
	accent?: string;
	/** Only rendered when the guild is a faction server. */
	requires?: "faction";
}

export interface NavSection {
	title: string;
	items: NavItem[];
}

export interface NavContext {
	guildId: string;
	effectiveType: string | null;
	isMerc: boolean;
	isFaction: boolean;
	isAlliance: boolean;
}

/** Build the `#/guilds/:id/...` href for a nav item, preserving the type param. */
export function navHref(
	guildId: string,
	subPath: string,
	effectiveType: string | null,
): string {
	const base =
		subPath === "" ? `/guilds/${guildId}` : `/guilds/${guildId}${subPath}`;
	return effectiveType ? `${base}?type=${effectiveType}` : base;
}

/**
 * Single source of truth for the guild sidebar.
 *
 * Both the desktop rail and the mobile drawer render from this, so the two
 * navigations can never drift apart.
 */
export function getNavSections({
	isMerc,
	isFaction,
	isAlliance,
}: NavContext): NavSection[] {
	const featureItems: NavItem[] = isMerc
		? [
				{
					label: "Contracts",
					subPath: "/contracts",
					icon: ShieldAlert,
					accent: "text-warning",
				},
				{
					label: "Channel Selections",
					subPath: "/channels",
					icon: Hash,
					accent: "text-success",
				},
				{
					label: "Verification",
					subPath: "/verification",
					icon: UserCheck,
					accent: "text-info",
				},
			]
		: [
				{
					label: "Territory",
					subPath: "/territory",
					icon: MapPin,
					accent: "text-primary",
				},
				{
					label: "Verification",
					subPath: "/verification",
					icon: UserCheck,
					accent: "text-info",
				},
				isFaction
					? {
							label: "Recruitment",
							subPath: "/recruitment",
							icon: UserPlus,
							accent: "text-success",
						}
					: {
							label: "Reaction Roles",
							subPath: "/reaction-roles",
							icon: Smile,
							accent: "text-warning",
						},
				// Faction-only: stock alerts are routed per family faction, so
				// non-faction servers have nothing to configure here.
				...(isFaction
					? [
							{
								label: "Stocks",
								subPath: "/stocks",
								icon: TrendingUp,
								accent: "text-primary",
							},
						]
					: []),
			];

	const sections: NavSection[] = [
		{
			title: "Core",
			items: [{ label: "General Settings", subPath: "", icon: Settings }],
		},
		{
			title: isMerc
				? "Mercenary Features"
				: isFaction
					? "Faction Features"
					: isAlliance
						? "Alliance Features"
						: "Server Features",
			items: featureItems,
		},
	];

	// Ranked-war features are only meaningful on faction dashboards, where the
	// family factions (Subversive Alliance / SA Succession) run the script.
	if (isFaction) {
		sections.push({
			title: "RW Features",
			items: [
				{
					label: "Channel Selections",
					subPath: "/rw-channels",
					icon: Hash,
					accent: "text-success",
				},
				{
					label: "Dibs",
					subPath: "/dibs",
					icon: Target,
					accent: "text-warning",
				},
			],
		});
	}

	return sections;
}

/**
 * Label for the current sub path — used by the mobile app bar so the user
 * always knows which page they are looking at after the drawer closes.
 */
export function getPageLabel(
	subPath: string,
	sections: NavSection[],
): string | undefined {
	const normalized = subPath === "" ? "/" : subPath;
	for (const section of sections) {
		for (const item of section.items) {
			if (item.subPath === "" && normalized === "/") return item.label;
			if (item.subPath !== "" && normalized === item.subPath) return item.label;
		}
	}
	return undefined;
}
