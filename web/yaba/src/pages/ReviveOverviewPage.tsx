import { HeartPulse } from "lucide-react";

import { RankingOverview } from "@/components/RankingOverview";

export function ReviveOverviewPage() {
	return (
		<RankingOverview
			scope="faction"
			factionType="revive"
			title="Revive overview"
			description="Top 20 revive-focused factions across the selected window."
			icon={HeartPulse}
			limit={20}
		/>
	);
}
