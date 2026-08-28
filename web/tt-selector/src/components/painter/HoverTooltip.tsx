import type { RewardInfo } from "../../lib/racket-utils";
import { formatCurrency } from "../../lib/racket-utils";

interface HoverTooltipProps {
	visible: boolean;
	x: number;
	y: number;
	territoryId: string;
	sector: number;
	respect: number;
	size?: number;
	density?: number;
	slots?: number;
	racket?: {
		name: string;
		rewardInfo: RewardInfo | null;
		dailyValue: number;
	};
	assignedLabel?: {
		text: string;
		color: string;
	};
}

export function HoverTooltip({
	visible,
	x,
	y,
	territoryId,
	sector,
	respect,
	size,
	density,
	slots,
	racket,
	assignedLabel,
}: HoverTooltipProps) {
	if (!visible) return null;

	return (
		<div
			className="fixed z-[2000] pointer-events-none transition-transform duration-75 ease-out"
			style={{
				left: `${x + 16}px`,
				top: `${y + 16}px`,
				maxWidth: "280px",
			}}
		>
			<div className="rounded-xl border border-border/80 bg-[#0d1117]/95 backdrop-blur-md p-3.5 shadow-2xl space-y-2 text-xs font-sans">
				{/* Header */}
				<div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
					<div className="flex items-center gap-2">
						<span className="font-mono font-bold text-sm tracking-wider text-amber-400">
							{territoryId}
						</span>
						<span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-300">
							Sector {sector}
						</span>
					</div>
					{assignedLabel && (
						<div
							className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold truncate max-w-[100px]"
							style={{
								backgroundColor: `${assignedLabel.color}25`,
								color: assignedLabel.color,
								border: `1px solid ${assignedLabel.color}60`,
							}}
						>
							{assignedLabel.text}
						</div>
					)}
				</div>

				{/* Specs Grid */}
				<div className="grid grid-cols-2 gap-2 text-[11px]">
					<div className="flex items-center gap-1.5 text-zinc-400">
						<span>Respect:</span>
						<span className="font-mono font-semibold text-zinc-200">
							{respect.toLocaleString()}
						</span>
					</div>
					{size !== undefined && (
						<div className="flex items-center gap-1.5 text-zinc-400">
							<span>Size:</span>
							<span className="font-mono font-semibold text-zinc-200">
								{size}
							</span>
						</div>
					)}
					{density !== undefined && density > 0 && (
						<div className="flex items-center gap-1.5 text-zinc-400">
							<span>Density:</span>
							<span className="font-mono font-semibold text-zinc-200">
								{density}
							</span>
						</div>
					)}
					{slots !== undefined && slots > 0 && (
						<div className="flex items-center gap-1.5 text-zinc-400">
							<span>Slots:</span>
							<span className="font-mono font-semibold text-zinc-200">
								{slots}
							</span>
						</div>
					)}
				</div>

				{/* Racket Section */}
				{racket && (
					<div className="pt-2 border-t border-border/60 space-y-1 bg-amber-500/5 -mx-3.5 -mb-3.5 p-2.5 rounded-b-xl border-t-amber-500/20">
						<div className="flex items-center justify-between text-[11px] font-semibold text-amber-400">
							<div className="flex items-center gap-1.5">
								<span>{racket.name}</span>
							</div>
							{racket.dailyValue > 0 && (
								<div className="flex items-center gap-0.5 text-emerald-400 font-mono text-[10px]">
									<span>{formatCurrency(racket.dailyValue)}/d</span>
								</div>
							)}
						</div>
						{racket.rewardInfo && (
							<div className="text-[10px] text-zinc-400 font-mono">
								{racket.rewardInfo.displayString}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
