import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDecimal, formatNumber } from "@/lib/utils";

export type ActiveGymData = {
	id: string;
	name: string;
	cost: number;
	energy: number;
	strength: number;
	speed: number;
	defense: number;
	dexterity: number;
};

export type EfficiencyDataPayload = {
	stats: {
		strength: number;
		defense: number;
		speed: number;
		dexterity: number;
	};
	maxHappy: number;
	perks: {
		strength: number;
		defense: number;
		speed: number;
		dexterity: number;
	};
	activeGyms: {
		strength: ActiveGymData | null;
		defense: ActiveGymData | null;
		speed: ActiveGymData | null;
		dexterity: ActiveGymData | null;
	};
};

const STAT_CONSTANTS = {
	strength: { a: 1600, b: 1700 },
	speed: { a: 1600, b: 2000 },
	dexterity: { a: 1800, b: 1500 },
	defense: { a: 2100, b: -600 },
} as const;

function calculateGainBreakdown(
	statType: "strength" | "defense" | "speed" | "dexterity",
	currentStat: number,
	happy: number,
	gymDots: number,
	energyCost: number,
	perkMultiplier: number,
) {
	const S = Math.min(currentStat, 50_000_000);
	const H = happy;
	const { a, b } = STAT_CONSTANTS[statType];

	const lnHappy = Math.log(1 + H / 250);
	const roundedLn = Number(lnHappy.toFixed(4));
	const gymFactor = Number((1 + 0.07 * roundedLn).toFixed(4));

	const happyFactor = 8 * H ** 1.05;
	const statConstantFactor = (1 - (H / 99999) ** 2) * a + b;

	const G = gymDots / 10;
	const E = energyCost;

	const baseGain = S * gymFactor + happyFactor + statConstantFactor;
	const totalGain = baseGain * (1 / 200000) * G * E * perkMultiplier;

	return {
		totalGain,
		gymFactor,
		happyFactor,
		statConstantFactor,
		baseGain,
		perkMultiplier,
		G,
	};
}

export function TrainingEfficiencyTable({
	data,
	isLoading,
}: {
	data: EfficiencyDataPayload | null;
	isLoading: boolean;
}) {
	if (isLoading) {
		return (
			<Card className="border border-border/40 bg-card/50 shadow-sm backdrop-blur-xl animate-pulse mt-8">
				<CardHeader className="border-b border-border/40 pb-4">
					<CardTitle className="text-base font-semibold">
						Training Efficiency Analyzer
					</CardTitle>
				</CardHeader>
				<CardContent className="h-48" />
			</Card>
		);
	}

	if (!data) return null;

	const totalStats =
		data.stats.strength +
		data.stats.defense +
		data.stats.speed +
		data.stats.dexterity;

	const targetRatios = {
		strength: 0.3086,
		speed: 0.2469,
		defense: 0.2222,
		dexterity: 0.2222,
	};

	const statsOrder = ["strength", "speed", "defense", "dexterity"] as const;

	// Pre-calculate to find the highest efficiency
	const rowsData = statsOrder.map((statType) => {
		const current = data.stats[statType];
		const target = totalStats * targetRatios[statType];
		const diff = current - target;
		const gym = data.activeGyms[statType];
		const perk = data.perks[statType];

		let breakdown = null;
		let gainPerE = 0;

		if (gym) {
			const gymDots = gym[statType] as number;
			breakdown = calculateGainBreakdown(
				statType,
				current,
				data.maxHappy,
				gymDots,
				gym.energy,
				perk,
			);
			gainPerE = breakdown.totalGain / gym.energy;
		}

		return { statType, current, target, diff, gym, perk, breakdown, gainPerE };
	});

	const maxGainPerE = Math.max(...rowsData.map((r) => r.gainPerE));

	const scoredRows = rowsData.map((row) => {
		if (row.current >= row.target) {
			return { ...row, priorityScore: -1 };
		}

		const ratioDeficit = (row.target - row.current) / (row.target || 1);
		const relativeEfficiency = maxGainPerE > 0 ? row.gainPerE / maxGainPerE : 0;
		// 50% weight to ratio deficit, 50% weight to relative efficiency
		const priorityScore = ratioDeficit * 0.5 + relativeEfficiency * 0.5;
		return { ...row, priorityScore };
	});

	const furthestBehind = [...scoredRows].sort(
		(a, b) => b.priorityScore - a.priorityScore,
	)[0]?.statType;

	return (
		<div className="space-y-4 mt-8">
			<Card className="border border-border/40 bg-card/50 shadow-sm backdrop-blur-xl">
				<CardHeader className="border-b border-border/40 pb-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<CardTitle className="text-base font-semibold">
								Efficiency Data Breakdown
							</CardTitle>
						</div>
						<div className="flex items-center gap-2">
							<span className="text-xs font-mono text-muted-foreground bg-muted/30 px-2 py-1 rounded">
								Max Happy: {formatNumber(data.maxHappy)}
							</span>
						</div>
					</div>
				</CardHeader>
				<CardContent className="p-0 overflow-x-auto">
					<Table>
						<TableHeader className="bg-muted/20">
							<TableRow className="hover:bg-transparent">
								<TableHead className="font-semibold text-xs tracking-wider uppercase">
									Stat
								</TableHead>
								<TableHead className="font-semibold text-xs tracking-wider uppercase">
									Active Gym
								</TableHead>
								<TableHead className="font-semibold text-xs tracking-wider uppercase">
									Target Diff
								</TableHead>
								<TableHead className="font-semibold text-xs tracking-wider uppercase text-emerald-400">
									Gain / Train
								</TableHead>
								<TableHead className="font-semibold text-xs tracking-wider uppercase text-primary">
									Gain / E
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rowsData.map(
								({ statType, current, diff, gym, breakdown, gainPerE }) => (
									<TableRow key={statType} className="hover:bg-muted/5">
										<TableCell className="font-medium capitalize text-sm">
											<div className="flex items-center gap-2">
												{statType}
												{statType === furthestBehind && (
													<span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-destructive/20 text-destructive border border-destructive/30">
														Priority
													</span>
												)}
											</div>
											<div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
												{formatNumber(current)}
											</div>
										</TableCell>
										<TableCell>
											{gym ? (
												<div className="flex flex-col">
													<span className="text-sm">{gym.name}</span>
													<span className="text-[10px] text-muted-foreground uppercase font-mono">
														{gym.energy}E • {gym[statType]} Dots
													</span>
												</div>
											) : (
												<span className="text-muted-foreground/60 text-sm">
													—
												</span>
											)}
										</TableCell>
										<TableCell className="font-mono text-sm">
											<div
												className={`${diff < 0 ? "text-destructive font-bold" : "text-emerald-500"}`}
											>
												{diff > 0 ? "+" : ""}
												{formatNumber(diff)}
											</div>
										</TableCell>
										<TableCell className="font-mono text-emerald-400">
											{breakdown ? (
												<TooltipProvider>
													<Tooltip delayDuration={100}>
														<TooltipTrigger className="border-b border-dashed border-emerald-400/50 pb-0.5 font-semibold cursor-help">
															+{formatNumber(breakdown.totalGain)}
														</TooltipTrigger>
														<TooltipContent
															side="right"
															className="bg-popover text-popover-foreground border-border p-3 shadow-xl z-50"
														>
															<div className="space-y-2 text-xs font-mono">
																<p className="font-bold text-sm mb-1 pb-1 border-b border-border">
																	Calculation Breakdown
																</p>
																<div className="flex justify-between gap-4">
																	<span className="text-muted-foreground">
																		Gym Dots (G):
																	</span>
																	<span>{breakdown.G}</span>
																</div>
																<div className="flex justify-between gap-4">
																	<span className="text-muted-foreground">
																		Gym Factor:
																	</span>
																	<span>{breakdown.gymFactor}</span>
																</div>
																<div className="flex justify-between gap-4">
																	<span className="text-muted-foreground">
																		Happy Factor:
																	</span>
																	<span>
																		{formatNumber(breakdown.happyFactor)}
																	</span>
																</div>
																<div className="flex justify-between gap-4">
																	<span className="text-muted-foreground">
																		Stat Constant:
																	</span>
																	<span>
																		{formatNumber(breakdown.statConstantFactor)}
																	</span>
																</div>
																<div className="flex justify-between gap-4 border-t border-border pt-1 mt-1">
																	<span className="text-muted-foreground">
																		Perk Multiplier:
																	</span>
																	<span className="text-primary font-bold">
																		{breakdown.perkMultiplier}x
																	</span>
																</div>
															</div>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											) : (
												"—"
											)}
										</TableCell>
										<TableCell className="font-mono font-bold text-primary">
											{gainPerE > 0 ? `+${formatDecimal(gainPerE, 2)}` : "—"}
										</TableCell>
									</TableRow>
								),
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	);
}
