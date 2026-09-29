import { apiClient } from "../api";
import {
	calculateGymGainBreakdown,
	DEFAULT_SETTINGS,
	formatCompactNumber,
	formatDecimal,
	formatNumber,
	GYM_DEFINITIONS,
	getTargetRatios,
	parseShorthandNumber,
	STORAGE_KEYS,
} from "../config";
import type {
	BattlestatsAnalyticsResponse,
	BattlestatsLedgerState,
	DailyBattlestatsTimeline,
	EfficiencyDataPayload,
	RatioType,
	StatType,
} from "../types";
import { renderBattlestatsSvgChart } from "../ui/svg-chart";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

export class BattlestatsTab {
	private container: HTMLElement;
	private state: BattlestatsLedgerState | null = null;
	private analytics: BattlestatsAnalyticsResponse | null = null;
	private efficiencyData: EfficiencyDataPayload | null = null;
	private currentTimeframe: "7d" | "14d" | "30d" | "90d" | "all" = "30d";
	private currentChartMode: "stats" | "energy" = "energy";
	private targetGoal: number | null = null;
	private onOpenSettings: () => void;
	private onRatioChange?: () => void;

	constructor(
		container: HTMLElement,
		onOpenSettings: () => void,
		onRatioChange?: () => void,
	) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;
		this.onRatioChange = onRatioChange;
		this.currentTimeframe = GM_getValue<"7d" | "14d" | "30d" | "90d" | "all">(
			STORAGE_KEYS.battlestatsTimeframe,
			"30d",
		);
		this.targetGoal = GM_getValue<number | null>(
			STORAGE_KEYS.battlestatsGoal,
			null,
		);
	}

	public async init(): Promise<void> {
		this.state = apiClient.getCachedBattlestatsState();
		this.analytics = apiClient.getCachedBattlestatsAnalytics();
		this.efficiencyData = apiClient.getCachedEfficiency();
		this.render();
		await this.refresh();
	}

	public async refresh(): Promise<void> {
		try {
			const [stateRes, analyticsRes, efficiencyRes, prefsRes] =
				await Promise.all([
					apiClient.getBattlestatsState(),
					apiClient.getBattlestatsAnalytics(this.currentTimeframe),
					apiClient.getEfficiencyData(),
					apiClient.getBattlestatsPreferences().catch(() => null),
				]);
			this.state = stateRes;
			this.analytics = analyticsRes;
			this.efficiencyData = efficiencyRes;
			if (prefsRes) {
				GM_setValue(STORAGE_KEYS.ratioType, prefsRes.ratioType);
				GM_setValue(STORAGE_KEYS.mainStat, prefsRes.mainStat);
			}
			this.render();
		} catch (err) {
			console.error(
				"[Blasted's Script] Error refreshing battlestats data:",
				err,
			);
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	public setTimeframe(tf: "7d" | "14d" | "30d" | "90d" | "all"): void {
		this.currentTimeframe = tf;
		GM_setValue(STORAGE_KEYS.battlestatsTimeframe, tf);
		this.refresh();
	}

	public setChartMode(mode: "stats" | "energy"): void {
		this.currentChartMode = mode;
		this.renderChartOnly();
	}

	private renderError(message: string): void {
		const isAuthError =
			message.toLowerCase().includes("unauthorized") ||
			message.toLowerCase().includes("api key");
		this.container.innerHTML = `
			<div class="kpi-card" style="border-color: #ef4444; background: rgba(239, 68, 68, 0.1);">
				<div class="kpi-label" style="color: #f87171;">Connection Notice</div>
				<div style="font-size: 13px; color: #fca5a5; margin: 6px 0;">${message}</div>
				${
					isAuthError
						? `<button id="btn-fix-key-bs" class="btn-primary" style="margin-top: 8px; width: fit-content;">Configure API Key in Settings</button>`
						: `<button id="btn-retry-bs" class="btn-primary" style="margin-top: 8px; width: fit-content;">Retry Connection</button>`
				}
			</div>
		`;

		this.container
			.querySelector("#btn-fix-key-bs")
			?.addEventListener("click", () => {
				this.onOpenSettings();
			});

		this.container
			.querySelector("#btn-retry-bs")
			?.addEventListener("click", () => {
				this.refresh();
			});
	}

	public render(): void {
		if (!this.state && !this.analytics && !this.efficiencyData) {
			this.container.innerHTML = `
				<div style="padding: 40px 0; text-align: center; color: #94a3b8; font-family: monospace; font-size: 13px;">
					Loading Battlestats Analytics...
				</div>
			`;
			return;
		}

		const ratioType = GM_getValue<RatioType>(
			STORAGE_KEYS.ratioType,
			DEFAULT_SETTINGS.ratioType,
		);
		const mainStat = GM_getValue<StatType>(
			STORAGE_KEYS.mainStat,
			DEFAULT_SETTINGS.mainStat,
		);
		const ratios = getTargetRatios(ratioType, mainStat);

		// Current stats
		const stats = this.efficiencyData?.stats ?? {
			strength: 0,
			defense: 0,
			speed: 0,
			dexterity: 0,
		};
		const totalStats =
			stats.strength + stats.defense + stats.speed + stats.dexterity;

		// Timeline & KPIs
		const timeline = this.analytics?.timeline ?? [];
		const summary = this.analytics?.summary ?? {
			totalGained: 0,
			totalTrains: 0,
			totalEnergyUsed: 0,
			totalLogs: 0,
			avgGainPerTrain: 0,
			avgGainPerEnergy: 0,
		};

		const numDays =
			this.currentTimeframe === "7d"
				? 7
				: this.currentTimeframe === "14d"
					? 14
					: this.currentTimeframe === "30d"
						? 30
						: this.currentTimeframe === "90d"
							? 90
							: Math.max(timeline.length, 1);

		const avgGainPerDay = summary.totalGained / Math.max(numDays, 1);
		const avgEnergyPerDay = summary.totalEnergyUsed / Math.max(numDays, 1);

		// Efficiency & Priority Stat computation
		const gymDef = GYM_DEFINITIONS[24]; // Reference George's dots
		const maxHappy = this.efficiencyData?.maxHappy ?? 5025;
		const perks = this.efficiencyData?.perks ?? {
			strength: 1,
			defense: 1,
			speed: 1,
			dexterity: 1,
		};

		const statList: StatType[] = ["strength", "defense", "speed", "dexterity"];
		const scoredRows = statList.map((st) => {
			const current = stats[st];
			const target = totalStats * ratios[st];
			const diff = current - target;
			const dots = gymDef?.[st] ?? 7.5;
			const perk = perks[st];
			const breakdown = calculateGymGainBreakdown(
				st,
				current,
				maxHappy,
				dots,
				gymDef?.energy ?? 10,
				perk,
			);
			return {
				statType: st,
				current,
				target,
				diff,
				gainPerE: breakdown.gainPerE,
			};
		});

		const maxGainPerE = Math.max(...scoredRows.map((r) => r.gainPerE), 1);
		const rankedStats = scoredRows.map((row) => {
			if (row.current >= row.target) {
				return { ...row, priorityScore: -1 };
			}
			const ratioDeficit = (row.target - row.current) / (row.target || 1);
			const relativeEfficiency =
				maxGainPerE > 0 ? row.gainPerE / maxGainPerE : 0;
			const priorityScore = ratioDeficit * 0.5 + relativeEfficiency * 0.5;
			return { ...row, priorityScore };
		});

		const recommendedStat = [...rankedStats].sort(
			(a, b) => b.priorityScore - a.priorityScore,
		)[0];

		const recCurPct = recommendedStat
			? (recommendedStat.current / (totalStats || 1)) * 100
			: 0;
		const recTgtPct = recommendedStat
			? ratios[recommendedStat.statType] * 100
			: 0;
		const recPctDiff = recCurPct - recTgtPct;
		const recPctDiffSign = recPctDiff >= 0 ? "+" : "-";
		const recPctFormatted = `${recPctDiffSign}${Math.abs(recPctDiff).toFixed(1)}%`;

		const sources = this.analytics?.sourceBreakdown ?? [];
		const getSrc = (name: "gym" | "item" | "book" | "company") =>
			sources.find((s) => s.source === name) ?? {
				source: name,
				count: 0,
				gained: 0,
				trains: 0,
				energy: 0,
				percentage: 0,
			};

		const gymSrc = getSrc("gym");
		const itemSrc = getSrc("item");
		const bookSrc = getSrc("book");
		const compSrc = getSrc("company");

		this.container.innerHTML = `
			<!-- KPI Grid (9 Cards, 3 per row on desktop) -->
			<div class="kpi-grid">
				<div class="kpi-card">
					<div class="kpi-label">Total Stat Gained</div>
					<div class="kpi-value val-blue">+${formatCompactNumber(summary.totalGained)}</div>
					<div class="kpi-sub">${formatCompactNumber(summary.totalEnergyUsed)} E recorded</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Total Energy Used</div>
					<div class="kpi-value val-amber">${formatCompactNumber(summary.totalEnergyUsed)} E</div>
					<div class="kpi-sub">Across ${this.currentTimeframe.toUpperCase()} window</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Recommended Stat</div>
					<div class="kpi-value val-green" style="font-size: 16px; text-transform: capitalize;">
						${recommendedStat?.statType ?? "Balanced"}
					</div>
					<div class="kpi-sub">${
						recommendedStat && recommendedStat.diff < 0
							? `-${formatCompactNumber(Math.abs(recommendedStat.diff))} deficit`
							: "On target"
					}</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Avg Stat / Day</div>
					<div class="kpi-value val-blue">+${formatCompactNumber(avgGainPerDay)}</div>
					<div class="kpi-sub">Across ${numDays} days</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Avg Energy / Day</div>
					<div class="kpi-value val-amber">${Math.round(avgEnergyPerDay)} E</div>
					<div class="kpi-sub">Daily training volume</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Gym Training</div>
					<div class="kpi-value val-emerald">+${formatCompactNumber(gymSrc.gained)}</div>
					<div class="kpi-sub">${
						gymSrc.energy > 0
							? `${formatCompactNumber(gymSrc.energy)} E • +${formatDecimal(gymSrc.gained / gymSrc.energy, 1)}/E`
							: `${gymSrc.count} trains`
					}</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Stat Enhancers</div>
					<div class="kpi-value val-blue">+${formatCompactNumber(itemSrc.gained)}</div>
					<div class="kpi-sub">${
						itemSrc.count > 0
							? `${itemSrc.count} used • ${itemSrc.percentage.toFixed(1)}%`
							: "None used"
					}</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Books</div>
					<div class="kpi-value val-sky">+${formatCompactNumber(bookSrc.gained)}</div>
					<div class="kpi-sub">${
						bookSrc.count > 0
							? `${bookSrc.count} read • ${bookSrc.percentage.toFixed(1)}%`
							: "None read"
					}</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Company Specials</div>
					<div class="kpi-value val-amber">+${formatCompactNumber(compSrc.gained)}</div>
					<div class="kpi-sub">${
						compSrc.count > 0
							? `${compSrc.count} trains • ${compSrc.percentage.toFixed(1)}%`
							: "None used"
					}</div>
				</div>
			</div>

			<!-- Target Ratio Strategy Card (Clean Sentinel Styling) -->
			<div class="chart-card">
				<div class="chart-header">
					<div class="chart-title">Target Ratio Strategy</div>
					<div class="chart-controls">
						<!-- Ratio Formula Selector Pills -->
						<div class="btn-pill-group">
							<button class="btn-pill ${ratioType === "baldr" ? "active" : ""}" data-formula="baldr">Baldr</button>
							<button class="btn-pill ${ratioType === "hank" ? "active" : ""}" data-formula="hank">Hank</button>
						</div>
						<!-- Main Stat Selector Pills -->
						<div class="btn-pill-group">
							<button class="btn-pill ${mainStat === "strength" ? "active" : ""}" data-main="strength">Str</button>
							<button class="btn-pill ${mainStat === "defense" ? "active" : ""}" data-main="defense">Def</button>
							<button class="btn-pill ${mainStat === "speed" ? "active" : ""}" data-main="speed">Spd</button>
							<button class="btn-pill ${mainStat === "dexterity" ? "active" : ""}" data-main="dexterity">Dex</button>
						</div>
					</div>
				</div>

				<!-- Strategy Status Strip -->
				<div class="chart-scrub-strip" style="background: rgba(14, 165, 233, 0.08); border-color: rgba(56, 189, 248, 0.3);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 10px; font-weight: 800; color: #38bdf8; background: rgba(56, 189, 248, 0.15); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3);">
							TARGET
						</span>
						<span style="font-weight: 700; color: #f8fafc; text-transform: uppercase;">
							${recommendedStat?.statType ?? "BALANCED"}
						</span>
					</div>
					<div style="font-size: 11px;">
						${
							recommendedStat && recommendedStat.diff < 0
								? `<span style="color: #f87171; font-weight: 600;">Deficit: -${formatCompactNumber(Math.abs(recommendedStat.diff))} • ${recPctFormatted}</span>`
								: `<span style="color: #34d399; font-weight: 600;">All stats meet ratio target</span>`
						}
					</div>
				</div>

				<!-- Visual Ratio Bars -->
				<div class="stat-ratio-bars">
					${statList
						.map((st) => {
							const cur = stats[st];
							const curPct = (cur / (totalStats || 1)) * 100;
							const targetPct = ratios[st] * 100;
							const diff = cur - totalStats * ratios[st];
							const isDeficit = diff < 0;
							const diffSign = isDeficit ? "-" : "+";
							const diffFormatted = `${diffSign}${formatCompactNumber(Math.abs(diff))}`;
							const pctDiff = curPct - targetPct;
							const pctDiffSign = pctDiff >= 0 ? "+" : "-";
							const pctFormatted = `${pctDiffSign}${Math.abs(pctDiff).toFixed(1)}%`;
							return `
								<div class="ratio-stat-row">
									<div class="ratio-stat-meta">
										<span class="stat-name ${st}">${st.charAt(0).toUpperCase() + st.slice(1)}</span>
										<span class="stat-diff ${isDeficit ? "deficit" : "surplus"}">
											${diffFormatted} • ${pctFormatted}
										</span>
									</div>
									<div class="ratio-bar-track">
										<div class="ratio-bar-fill ${st}" style="width: ${Math.min(curPct * 2, 100)}%;"></div>
										<div class="ratio-bar-target" style="left: ${Math.min(targetPct * 2, 100)}%;" title="Target: ${targetPct.toFixed(1)}%"></div>
									</div>
								</div>
							`;
						})
						.join("")}
				</div>
			</div>

			<!-- Goal & Timeframe Prediction Card -->
			<div class="chart-card">
				<div class="chart-header">
					<div class="chart-title">Goal & Timeframe Prediction</div>
					<div style="font-size: 11px; color: #94a3b8; font-weight: 600;">
						Based on ${this.currentTimeframe.toUpperCase()} pace (${formatCompactNumber(avgGainPerDay)}/day)
					</div>
				</div>

				<div class="goal-input-row">
					<div class="goal-input-wrap">
						<span class="goal-prefix">Target BS:</span>
						<input
							type="text"
							id="input-bs-goal"
							class="goal-input-field"
							placeholder="e.g. 8.5b, 9b, 10000000000"
							value="${this.targetGoal ? formatNumber(this.targetGoal) : ""}"
						/>
					</div>
					<div class="goal-quick-chips">
						<button class="btn-chip" data-add-bs="100000000">+100M</button>
						<button class="btn-chip" data-add-bs="250000000">+250M</button>
						<button class="btn-chip" data-add-bs="500000000">+500M</button>
						<button class="btn-chip" data-add-bs="1000000000">+1B</button>
						<button class="btn-chip" data-add-bs="2000000000">+2B</button>
					</div>
				</div>

				<!-- Prediction Output Container -->
				<div id="prediction-output-wrap">
					${this.renderPredictionOutput(totalStats, avgGainPerDay, avgEnergyPerDay, ratios)}
				</div>
			</div>

			<!-- Gain Progression Timeline Card (Matches Crimes Chart Card) -->
			<div class="chart-card">
				<div class="chart-header">
					<div class="chart-title">Gain Progression Timeline</div>
					<div class="chart-controls">
						<!-- Metric Mode Pills -->
						<div class="btn-pill-group">
							<button class="btn-pill ${this.currentChartMode === "energy" ? "active" : ""}" data-mode="energy">Gains & Energy</button>
							<button class="btn-pill ${this.currentChartMode === "stats" ? "active" : ""}" data-mode="stats">Stat Breakdown</button>
						</div>
						<!-- Timeframe Pills -->
						<div class="btn-pill-group">
							<button class="btn-pill ${this.currentTimeframe === "7d" ? "active" : ""}" data-tf="7d">7D</button>
							<button class="btn-pill ${this.currentTimeframe === "14d" ? "active" : ""}" data-tf="14d">14D</button>
							<button class="btn-pill ${this.currentTimeframe === "30d" ? "active" : ""}" data-tf="30d">30D</button>
							<button class="btn-pill ${this.currentTimeframe === "90d" ? "active" : ""}" data-tf="90d">90D</button>
							<button class="btn-pill ${this.currentTimeframe === "all" ? "active" : ""}" data-tf="all">All</button>
						</div>
					</div>
				</div>

				<!-- Scrubber Status Strip -->
				<div id="chart-scrub-strip" class="chart-scrub-strip">
					<span>Hover or drag across chart to inspect daily breakdown</span>
				</div>

				<!-- Responsive SVG Chart Canvas -->
				<div id="chart-canvas-wrap" class="chart-svg-wrap"></div>
			</div>
		`;

		this.attachEventListeners(
			totalStats,
			avgGainPerDay,
			avgEnergyPerDay,
			ratios,
		);
		this.renderChartOnly();
	}

	private renderChartOnly(): void {
		const chartWrap =
			this.container.querySelector<HTMLElement>("#chart-canvas-wrap");
		if (!chartWrap) return;

		const timeline = this.analytics?.timeline ?? [];
		const scrubStrip =
			this.container.querySelector<HTMLElement>("#chart-scrub-strip");

		const containerW = chartWrap.clientWidth || 540;

		renderBattlestatsSvgChart(chartWrap, {
			data: timeline,
			mode: this.currentChartMode,
			width: containerW,
			height: 220,
			onScrub: (item: DailyBattlestatsTimeline | null) => {
				if (!scrubStrip) return;
				if (!item) {
					scrubStrip.innerHTML =
						"<span>Hover or drag across chart to inspect daily breakdown</span>";
					return;
				}
				const gainE =
					item.energyUsed > 0
						? ` • +${formatDecimal(item.totalGained / item.energyUsed, 1)} Gain/E`
						: "";
				scrubStrip.innerHTML = `
					<span style="font-weight: 700; color: #cbd5e1;">${item.date}:</span>
					<span style="font-weight: 700; color: #38bdf8;">+${formatNumber(item.totalGained)}</span>
					<span style="color: #fbbf24;">(${item.energyUsed}E${gainE})</span>
					<span style="font-size: 10px; color: #94a3b8;">
						[Str: ${formatNumber(item.strength)} | Def: ${formatNumber(item.defense)} | Spd: ${formatNumber(item.speed)} | Dex: ${formatNumber(item.dexterity)}]
					</span>
				`;
			},
		});
	}

	private attachEventListeners(
		totalStats: number,
		avgGainPerDay: number,
		avgEnergyPerDay: number,
		ratios: Record<StatType, number>,
	): void {
		// Goal input field & quick chips
		const goalInput =
			this.container.querySelector<HTMLInputElement>("#input-bs-goal");
		const outputWrap = this.container.querySelector<HTMLElement>(
			"#prediction-output-wrap",
		);

		if (goalInput && outputWrap) {
			const updatePrediction = (val: number | null) => {
				this.targetGoal = val;
				if (val !== null) {
					GM_setValue(STORAGE_KEYS.battlestatsGoal, val);
				}
				outputWrap.innerHTML = this.renderPredictionOutput(
					totalStats,
					avgGainPerDay,
					avgEnergyPerDay,
					ratios,
				);
			};

			goalInput.addEventListener("input", () => {
				const parsed = parseShorthandNumber(goalInput.value);
				updatePrediction(parsed);
			});

			this.container.querySelectorAll("[data-add-bs]").forEach((btn) => {
				btn.addEventListener("click", () => {
					const add = Number(btn.getAttribute("data-add-bs"));
					if (!Number.isNaN(add) && add > 0) {
						const newTarget = totalStats + add;
						goalInput.value = formatNumber(newTarget);
						updatePrediction(newTarget);
					}
				});
			});
		}

		// Formula pills (Baldr / Hank)
		this.container.querySelectorAll("[data-formula]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const val = btn.getAttribute("data-formula") as RatioType;
				if (val) {
					GM_setValue(STORAGE_KEYS.ratioType, val);
					this.render();
					if (this.onRatioChange) this.onRatioChange();
					const currentMain = GM_getValue<StatType>(
						STORAGE_KEYS.mainStat,
						DEFAULT_SETTINGS.mainStat,
					);
					apiClient
						.saveBattlestatsPreferences({
							ratioType: val,
							mainStat: currentMain,
						})
						.catch((err) => {
							console.warn(
								"[Blasted's Script] Failed to sync preferences to Sentinel:",
								err,
							);
						});
				}
			});
		});

		// Main stat pills (Str / Def / Spd / Dex)
		this.container.querySelectorAll("[data-main]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const val = btn.getAttribute("data-main") as StatType;
				if (val) {
					GM_setValue(STORAGE_KEYS.mainStat, val);
					this.render();
					if (this.onRatioChange) this.onRatioChange();
					const currentRatio = GM_getValue<RatioType>(
						STORAGE_KEYS.ratioType,
						DEFAULT_SETTINGS.ratioType,
					);
					apiClient
						.saveBattlestatsPreferences({
							ratioType: currentRatio,
							mainStat: val,
						})
						.catch((err) => {
							console.warn(
								"[Blasted's Script] Failed to sync preferences to Sentinel:",
								err,
							);
						});
				}
			});
		});

		// Timeframe pills
		this.container.querySelectorAll("[data-tf]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const tf = btn.getAttribute("data-tf") as
					| "7d"
					| "14d"
					| "30d"
					| "90d"
					| "all";
				if (tf) this.setTimeframe(tf);
			});
		});

		// Chart mode pills
		this.container.querySelectorAll("[data-mode]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const mode = btn.getAttribute("data-mode") as "stats" | "energy";
				if (mode) {
					this.currentChartMode = mode;
					this.container.querySelectorAll("[data-mode]").forEach((b) => {
						b.classList.remove("active");
					});
					btn.classList.add("active");
					this.renderChartOnly();
				}
			});
		});
	}

	private renderPredictionOutput(
		totalStats: number,
		avgGainPerDay: number,
		avgEnergyPerDay: number,
		ratios: Record<StatType, number>,
	): string {
		if (!this.targetGoal) {
			return `
				<div class="chart-scrub-strip" style="background: rgba(30, 41, 59, 0.5); border-color: #334155; margin-top: 10px;">
					<span>Enter a target greater than your current battlestats (+${formatCompactNumber(totalStats)}) or click a quick chip above to calculate predicted days.</span>
				</div>
			`;
		}

		if (this.targetGoal <= totalStats) {
			return `
				<div class="chart-scrub-strip" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3); margin-top: 10px;">
					<span style="color: #f87171; font-weight: 600;">Target (+${formatCompactNumber(this.targetGoal)}) must be greater than current battlestats (+${formatCompactNumber(totalStats)}).</span>
				</div>
			`;
		}

		if (avgGainPerDay <= 0) {
			return `
				<div class="chart-scrub-strip" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3); margin-top: 10px;">
					<span style="color: #f87171; font-weight: 600;">No stat gains recorded in this timeframe to estimate pace. Try switching to 30D or 90D.</span>
				</div>
			`;
		}

		const neededGain = this.targetGoal - totalStats;
		const predictedDays = Math.ceil(neededGain / avgGainPerDay);
		const targetDate = new Date(
			Date.now() + predictedDays * 24 * 60 * 60 * 1000,
		);
		const dateStr = targetDate.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
		const timeUnit =
			predictedDays >= 60
				? `~${(predictedDays / 30.4).toFixed(1)} Months`
				: predictedDays >= 14
					? `~${(predictedDays / 7).toFixed(1)} Weeks`
					: `${predictedDays} Days`;

		const gymSource = this.analytics?.sourceBreakdown?.find(
			(s) => s.source === "gym",
		);
		const gymGainPerE =
			gymSource && gymSource.energy > 0
				? gymSource.gained / gymSource.energy
				: (this.analytics?.summary.avgGainPerEnergy ?? 0);
		const neededEnergy =
			gymGainPerE > 0 ? Math.ceil(neededGain / gymGainPerE) : null;

		return `
			<div class="prediction-results-grid">
				<div class="prediction-card">
					<div class="prediction-label">Estimated Time</div>
					<div class="prediction-value val-blue">${predictedDays.toLocaleString()} Days</div>
					<div class="prediction-sub">${timeUnit} remaining</div>
				</div>
				<div class="prediction-card">
					<div class="prediction-label">Projected Date</div>
					<div class="prediction-value val-green">${dateStr}</div>
					<div class="prediction-sub">At +${formatCompactNumber(avgGainPerDay)} stats/day</div>
				</div>
				<div class="prediction-card">
					<div class="prediction-label">Energy Required</div>
					<div class="prediction-value val-amber">${neededEnergy ? `${formatCompactNumber(neededEnergy)} E` : "N/A"}</div>
					<div class="prediction-sub">${avgEnergyPerDay > 0 ? `At ~${Math.round(avgEnergyPerDay)} E/day` : "Based on historical pace"}</div>
				</div>
			</div>

			<div class="chart-scrub-strip" style="background: rgba(14, 165, 233, 0.08); border-color: rgba(56, 189, 248, 0.3); margin-top: 10px; font-size: 11px;">
				<span style="color: #cbd5e1; font-weight: 600;">Goal Breakdown:</span>
				<span style="color: #38bdf8;">Str: +${formatCompactNumber(this.targetGoal * ratios.strength)}</span>
				<span style="color: #38bdf8;">Def: +${formatCompactNumber(this.targetGoal * ratios.defense)}</span>
				<span style="color: #38bdf8;">Spd: +${formatCompactNumber(this.targetGoal * ratios.speed)}</span>
				<span style="color: #38bdf8;">Dex: +${formatCompactNumber(this.targetGoal * ratios.dexterity)}</span>
			</div>
		`;
	}
}
