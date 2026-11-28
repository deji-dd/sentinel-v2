import { Swords } from "lucide-react";

import { RankingOverview } from "@/components/RankingOverview";

export function CombatOverviewPage() {
	return (
		<RankingOverview
			scope="faction"
			factionType="combat"
			title="Combat overview"
			description="Top 20 combat factions across the selected window, scored from weekly activity signals."
			icon={Swords}
			limit={20}
		/>
	);
}
