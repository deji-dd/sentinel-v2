import {
	Check,
	ChevronDown,
	ChevronRight,
	Eye,
	EyeOff,
	FolderKanban,
	Layers,
	Loader2,
	Paintbrush,
	Plus,
	Save,
	Search,
	Trash2,
	X,
} from "lucide-react";

import { useMemo, useState } from "react";
import {
	calculateDailyValue,
	formatCurrency,
	parseRewardString,
} from "../../lib/racket-utils";
import type {
	MapLabel,
	TerritoryMetadataResponse,
	UserMap,
} from "./TacticalMapCanvas";

interface MapSidebarProps {
	currentMap: UserMap;
	metadata: TerritoryMetadataResponse | null;
	selectedLabelId: string | null;
	isSaving: boolean;
	isDirty: boolean;
	onSelectLabel: (labelId: string) => void;
	onUpdateLabel: (
		labelId: string,
		updater: (prev: MapLabel) => MapLabel,
	) => void;
	onAddLabel: () => void;
	onDeleteLabel: (labelId: string) => void;
	onRemoveTerritoryFromLabel: (labelId: string, territoryId: string) => void;
	onOpenMapManager: () => void;
	onSaveMap: () => void;
}

const PRESET_COLORS = [
	"#3b82f6", // Blue
	"#ef4444", // Red
	"#10b981", // Emerald
	"#f59e0b", // Amber
	"#8b5cf6", // Purple
	"#ec4899", // Pink
	"#06b6d4", // Cyan
	"#f97316", // Orange
	"#84cc16", // Lime
	"#64748b", // Slate
];

export function MapSidebar({
	currentMap,
	metadata,
	selectedLabelId,
	isSaving,
	isDirty,
	onSelectLabel,
	onUpdateLabel,
	onAddLabel,
	onDeleteLabel,
	onRemoveTerritoryFromLabel,
	onOpenMapManager,
	onSaveMap,
}: MapSidebarProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [expandedLabelId, setExpandedLabelId] = useState<string | null>(null);

	// Compute live aggregate stats per label
	const labelStats = useMemo(() => {
		const result: Record<
			string,
			{
				respect: number;
				count: number;
				rackets: number;
				dailyValue: number;
				rewards: string[];
				sectors: Record<number, number>;
			}
		> = {};

		for (const label of currentMap.labels) {
			const stat = {
				respect: 0,
				count: label.territories.length,
				rackets: 0,
				dailyValue: 0,
				rewards: [] as string[],
				sectors: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } as Record<
					number,
					number
				>,
			};

			for (const tid of label.territories) {
				const bp = metadata?.territories[tid];
				if (!bp) continue;

				stat.respect += bp.respect;

				if (bp.sector) {
					stat.sectors[bp.sector] = (stat.sectors[bp.sector] ?? 0) + 1;
				}

				if (bp.racket) {
					stat.rackets += 1;
					if (bp.racket.name) {
						stat.rewards.push(bp.racket.name);
					}
					if (metadata) {
						const rewardInfo = parseRewardString(
							bp.racket.reward,
							metadata.itemNames,
						);
						stat.dailyValue += calculateDailyValue(rewardInfo, metadata.prices);
					}
				}
			}

			result[label.id] = stat;
		}

		return result;
	}, [currentMap.labels, metadata]);

	// Global map totals
	const globalTotals = useMemo(() => {
		let totalTTs = 0;
		let totalRespect = 0;
		let totalRackets = 0;
		let totalDailyIncome = 0;

		Object.values(labelStats).forEach((s) => {
			totalTTs += s.count;
			totalRespect += s.respect;
			totalRackets += s.rackets;
			totalDailyIncome += s.dailyValue;
		});

		return { totalTTs, totalRespect, totalRackets, totalDailyIncome };
	}, [labelStats]);

	const filteredLabels = useMemo(() => {
		const q = searchQuery.toLowerCase().trim();
		if (!q) return currentMap.labels;
		return currentMap.labels.filter((l) => l.text.toLowerCase().includes(q));
	}, [currentMap.labels, searchQuery]);

	return (
		<aside className="w-80 sm:w-96 h-full flex flex-col border-r border-border/80 bg-[#0d1117]/95 backdrop-blur-md z-30 select-none shadow-2xl">
			{/* Top Bar / Map Switcher Header */}
			<div className="p-4 border-b border-border/60 bg-[#090c12]/80 space-y-3">
				<div className="flex items-center justify-between gap-2">
					<button
						type="button"
						onClick={onOpenMapManager}
						className="flex items-center gap-2 group text-left min-w-0 cursor-pointer"
					>
						<div className="size-7 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0 group-hover:bg-amber-500/20 transition-colors">
							<FolderKanban className="size-4" />
						</div>
						<div className="min-w-0">
							<div className="flex items-center gap-1.5">
								<span className="font-bold text-sm text-zinc-100 truncate group-hover:text-amber-400 transition-colors">
									{currentMap.name}
								</span>
								<ChevronDown className="size-3.5 text-zinc-400 group-hover:text-amber-400 transition-colors" />
							</div>
							<p className="text-[10px] text-zinc-400 font-mono">
								Switch or manage maps
							</p>
						</div>
					</button>

					{/* Save Button */}
					<button
						type="button"
						onClick={onSaveMap}
						disabled={isSaving || !isDirty}
						className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-colors ${
							isDirty
								? "bg-amber-500 hover:bg-amber-400 text-black shadow-md shadow-amber-500/20 font-bold cursor-pointer"
								: "bg-zinc-800 text-zinc-400 border border-border/40 shadow-none opacity-60 cursor-default"
						}`}
					>
						{isSaving ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : isDirty ? (
							<Save className="size-3.5" />
						) : (
							<Check className="size-3.5 text-emerald-400" />
						)}
						<span>
							{isSaving ? "Saving..." : isDirty ? "Save Map" : "Saved"}
						</span>
					</button>
				</div>

				{/* Global Stats Bar */}
				<div className="grid grid-cols-3 gap-2 pt-1 font-mono">
					<div className="p-2 rounded-xl bg-zinc-900/80 border border-border/60">
						<span className="text-[10px] text-zinc-500 block uppercase">
							Territories
						</span>
						<span className="text-sm font-bold text-zinc-100">
							{globalTotals.totalTTs}
						</span>
					</div>
					<div className="p-2 rounded-xl bg-zinc-900/80 border border-border/60">
						<span className="text-[10px] text-zinc-500 block uppercase">
							Respect
						</span>
						<span className="text-sm font-bold text-emerald-400">
							{globalTotals.totalRespect.toLocaleString()}
						</span>
					</div>
					<div className="p-2 rounded-xl bg-zinc-900/80 border border-border/60">
						<span className="text-[10px] text-zinc-500 block uppercase">
							Rackets
						</span>
						<span className="text-sm font-bold text-amber-400">
							{globalTotals.totalRackets}
						</span>
					</div>
				</div>
			</div>

			{/* Factions Section Header & Search */}
			<div className="p-3 border-b border-border/60 space-y-2 bg-[#090c12]/40">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1.5 text-xs font-mono font-bold tracking-wider text-zinc-400 uppercase">
						<Layers className="size-3.5 text-amber-400" />
						<span>Faction Layers ({currentMap.labels.length})</span>
					</div>
					<button
						type="button"
						onClick={onAddLabel}
						className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 flex items-center gap-1 cursor-pointer transition-colors"
					>
						<Plus className="size-3" />
						<span>Add Faction</span>
					</button>
				</div>

				{/* Search filter */}
				<div className="relative">
					<Search className="size-3.5 text-zinc-500 absolute left-2.5 top-2.5" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Filter factions..."
						className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-zinc-900/90 border border-border text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500 font-sans"
					/>
				</div>
			</div>

			{/* Faction Labels List */}
			<div className="flex-1 overflow-y-auto p-3 space-y-2.5">
				{filteredLabels.length === 0 ? (
					<div className="p-8 text-center text-xs text-zinc-500 font-mono">
						No faction layers found. Click "Add Faction" to create one.
					</div>
				) : (
					filteredLabels.map((label) => {
						const isSelected = selectedLabelId === label.id;
						const isExpanded = expandedLabelId === label.id;
						const stats = labelStats[label.id];

						return (
							<div
								key={label.id}
								className={`rounded-xl border transition-all overflow-hidden ${
									isSelected
										? "bg-zinc-900/95 shadow-lg"
										: "border-border/60 bg-zinc-900/40 hover:border-zinc-700"
								}`}
								style={{
									borderColor: isSelected ? `${label.color}99` : undefined,
									boxShadow: isSelected
										? `0 4px 20px ${label.color}20`
										: undefined,
								}}
							>
								{/* Card Header Row */}
								<div className="p-3 flex items-center justify-between gap-2.5">
									{/* Color dot / picker & Brush indicator */}
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => onSelectLabel(label.id)}
											className={`size-6 rounded-lg flex items-center justify-center shrink-0 transition-transform cursor-pointer ${
												isSelected
													? "ring-2 ring-white scale-110 shadow-md"
													: "opacity-80 hover:opacity-100"
											}`}
											style={{ backgroundColor: label.color }}
											title={
												isSelected
													? "Active Painting Brush"
													: "Click to Select as Paint Brush"
											}
										>
											{isSelected && (
												<Paintbrush className="size-3 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
											)}
										</button>

										<input
											type="text"
											value={label.text}
											onChange={(e) =>
												onUpdateLabel(label.id, (prev) => ({
													...prev,
													text: e.target.value,
												}))
											}
											className="font-bold text-xs text-zinc-100 bg-transparent focus:outline-none focus:bg-zinc-800/80 px-1.5 py-0.5 rounded transition-colors truncate max-w-[130px]"
										/>
									</div>

									{/* Quick stats & action toggles */}
									<div className="flex items-center gap-1.5 shrink-0">
										<span className="font-mono text-[11px] font-bold text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded-full">
											{label.territories.length} TTs
										</span>

										{/* Toggle Visible */}
										<button
											type="button"
											onClick={() =>
												onUpdateLabel(label.id, (prev) => ({
													...prev,
													enabled: !prev.enabled,
												}))
											}
											className={`size-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
												label.enabled
													? "text-zinc-300 hover:bg-zinc-800"
													: "text-zinc-600 bg-zinc-950/60"
											}`}
											title={label.enabled ? "Hide layer" : "Show layer"}
										>
											{label.enabled ? (
												<Eye className="size-3.5" />
											) : (
												<EyeOff className="size-3.5 text-zinc-500" />
											)}
										</button>

										{/* Expand toggle */}
										<button
											type="button"
											onClick={() =>
												setExpandedLabelId(isExpanded ? null : label.id)
											}
											className="size-7 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition-colors cursor-pointer"
										>
											{isExpanded ? (
												<ChevronDown className="size-3.5" />
											) : (
												<ChevronRight className="size-3.5" />
											)}
										</button>
									</div>
								</div>

								{/* Expanded Card Details */}
								{isExpanded && (
									<div className="px-3 pb-3 pt-1 border-t border-border/40 space-y-3 bg-[#090c12]/60">
										{/* Color Swatches */}
										<div>
											<span className="text-[10px] text-zinc-400 font-mono block mb-1.5">
												Select Color Palette
											</span>
											<div className="flex flex-wrap gap-1.5 items-center">
												{PRESET_COLORS.map((c) => (
													<button
														key={c}
														type="button"
														onClick={() =>
															onUpdateLabel(label.id, (prev) => ({
																...prev,
																color: c,
															}))
														}
														className={`size-5 rounded-md transition-transform cursor-pointer ${
															label.color === c
																? "ring-2 ring-white scale-110"
																: "opacity-75 hover:opacity-100"
														}`}
														style={{ backgroundColor: c }}
													/>
												))}
												<input
													type="color"
													value={label.color}
													onChange={(e) =>
														onUpdateLabel(label.id, (prev) => ({
															...prev,
															color: e.target.value,
														}))
													}
													className="size-5 rounded cursor-pointer border-0 bg-transparent"
													title="Custom color"
												/>
											</div>
										</div>

										{/* Detailed Stats */}
										{stats && (
											<div className="space-y-2 text-[11px] font-mono">
												<div className="grid grid-cols-2 gap-2">
													<div className="p-2 rounded-lg bg-zinc-900/90 border border-border/60">
														<div className="text-zinc-500 text-[10px]">
															Daily Respect
														</div>
														<div className="font-bold text-emerald-400">
															+{stats.respect.toLocaleString()}
														</div>
													</div>
													<div className="p-2 rounded-lg bg-zinc-900/90 border border-border/60">
														<div className="text-zinc-500 text-[10px]">
															Rackets
														</div>
														<div className="font-bold text-amber-400">
															{stats.rackets}{" "}
															{stats.rackets === 1 ? "Racket" : "Rackets"}
														</div>
													</div>
												</div>
												<div className="p-2 rounded-lg bg-zinc-900/90 border border-border/60 flex items-center justify-between">
													<div className="text-zinc-500 text-[10px]">
														Racket Value / Day
													</div>
													<div className="font-bold text-amber-300">
														{formatCurrency(stats.dailyValue)}/day
													</div>
												</div>
											</div>
										)}

										{/* Claimed Territories List */}
										<div>
											<div className="flex items-center justify-between mb-1.5">
												<span className="text-[10px] text-zinc-400 font-mono">
													Claimed Territories ({label.territories.length})
												</span>
												{label.territories.length > 0 && (
													<button
														type="button"
														onClick={() =>
															onUpdateLabel(label.id, (prev) => ({
																...prev,
																territories: [],
															}))
														}
														className="text-[10px] text-destructive hover:underline cursor-pointer font-mono"
													>
														Clear All
													</button>
												)}
											</div>

											{label.territories.length === 0 ? (
												<div className="p-3 rounded-lg bg-zinc-900/50 border border-dashed border-border/80 text-center text-[10px] text-zinc-500 font-mono">
													Click any territory on the map to paint.
												</div>
											) : (
												<div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto p-1.5 rounded-lg bg-zinc-950/80 border border-border/60">
													{label.territories.map((tid) => (
														<span
															key={tid}
															className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-900 border border-border text-[10px] font-mono font-bold text-zinc-300"
														>
															<span>{tid}</span>
															<button
																type="button"
																onClick={() =>
																	onRemoveTerritoryFromLabel(label.id, tid)
																}
																className="hover:text-destructive cursor-pointer"
															>
																<X className="size-2.5" />
															</button>
														</span>
													))}
												</div>
											)}
										</div>

										{/* Delete Faction Button */}
										{currentMap.labels.length > 1 && (
											<div className="pt-1 flex justify-end">
												<button
													type="button"
													onClick={() => onDeleteLabel(label.id)}
													className="text-[11px] text-destructive hover:text-red-400 flex items-center gap-1 font-semibold cursor-pointer transition-colors"
												>
													<Trash2 className="size-3" />
													<span>Delete Faction Layer</span>
												</button>
											</div>
										)}
									</div>
								)}
							</div>
						);
					})
				)}
			</div>
		</aside>
	);
}
