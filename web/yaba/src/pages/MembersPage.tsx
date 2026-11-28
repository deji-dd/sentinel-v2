import { UsersRound } from "lucide-react";

import { RankingOverview } from "@/components/RankingOverview";

function initialFactionFromHash(): number | null {
	const query = window.location.hash.split("?")[1] ?? "";
	const raw = new URLSearchParams(query).get("factionId");
	if (raw === null) return null;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function MembersPage() {
	return (
		<RankingOverview
			scope="member"
			factionType="combat"
			title="Member overview"
			description="Top 50 players with a faction filter and the same window controls as the faction reports."
			icon={UsersRound}
			limit={50}
			allowTypeSwitch
			initialFactionId={initialFactionFromHash()}
		/>
	);
}
