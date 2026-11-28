import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RANKING_WINDOWS, type RankingWindow } from "@/lib/types";

import { ScrollX } from "./ScrollX";

export function WindowTabs({
	value,
	onChange,
}: {
	value: RankingWindow;
	onChange: (window: RankingWindow) => void;
}) {
	return (
		<Tabs
			value={value}
			onValueChange={(next) => {
				const match = RANKING_WINDOWS.find((window) => window === next);
				if (match) onChange(match);
			}}
		>
			<ScrollX>
				<TabsList className="w-max">
					{RANKING_WINDOWS.map((window) => (
						<TabsTrigger key={window} value={window} className="h-9">
							{window}
						</TabsTrigger>
					))}
				</TabsList>
			</ScrollX>
		</Tabs>
	);
}
