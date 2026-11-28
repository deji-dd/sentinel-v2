import type { Treaty } from "@elysiajs/eden";

import { api } from "./api";

/** Response shapes inferred directly from the Eden treaty schema. */
export type FactionsResponse = Treaty.Data<typeof api.v2.yaba.factions.get>;
export type FactionRow = FactionsResponse["factions"][number];

export type MembersResponse = Treaty.Data<typeof api.v2.yaba.members.get>;
export type MemberRow = MembersResponse["members"][number];

export type RankingsResponse = Treaty.Data<typeof api.v2.yaba.rankings.get>;
export type RankingRow = RankingsResponse["rows"][number];

export type StatusResponse = Treaty.Data<typeof api.v2.yaba.status.get>;
export type MethodologyResponse = Treaty.Data<
	typeof api.v2.yaba.methodology.get
>;
export type ProspectiveResponse = Treaty.Data<
	typeof api.v2.yaba.prospective.get
>;

export type AdminFactionsResponse = Treaty.Data<
	typeof api.v2.yaba.admin.factions.get
>;
export type AdminFactionRow = NonNullable<
	AdminFactionsResponse["factions"]
>[number];
export type PresetResponse = Treaty.Data<typeof api.v2.yaba.admin.preset.get>;
export type ChannelsResponse = Treaty.Data<
	typeof api.v2.yaba.admin.channels.get
>;

export type AuthMeResponse = Treaty.Data<typeof api.v2.auth.me.get>;
export type AuthUser = NonNullable<AuthMeResponse["user"]>;

export const RANKING_WINDOWS = ["1d", "7d", "30d", "90d"] as const;
export type RankingWindow = (typeof RANKING_WINDOWS)[number];

export type FactionType = "combat" | "revive";

/** Metrics from the original activity sheet; secondary signals are opt-in. */
export const DEFAULT_METRICS: Record<FactionType, string[]> = {
	combat: ["xanax", "activity", "hits", "battle"],
	revive: ["xanax", "activity", "revives", "battle"],
};

export const SECONDARY_METRICS = [
	"winRate",
	"damagePerHit",
	"critRate",
	"reviveSkill",
] as const;
