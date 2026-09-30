import { apiClient } from "../api";
import {
	calculateGymGainBreakdown,
	DEFAULT_SETTINGS,
	formatCompactNumber,
	formatDecimal,
	GYM_DEFINITIONS,
	getTargetRatios,
	POLLING_CONFIG,
	STORAGE_KEYS,
} from "../config";
import type {
	BattlestatsAnalyticsResponse,
	EfficiencyDataPayload,
	RatioType,
	StatType,
} from "../types";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

export class GymDomObserver {
	private observer: MutationObserver | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private backgroundPollTimer: ReturnType<typeof setInterval> | null = null;
	private currentPollInterval: number = POLLING_CONFIG.SLOW_INTERVAL_MS;
	private efficiencyData: EfficiencyDataPayload | null = null;
	private analyticsData: BattlestatsAnalyticsResponse | null = null;

	public setRampedUp(active: boolean): void {
		const targetInterval = active
			? POLLING_CONFIG.FAST_INTERVAL_MS
			: POLLING_CONFIG.SLOW_INTERVAL_MS;
		if (this.currentPollInterval === targetInterval) return;
		this.currentPollInterval = targetInterval;
		if (this.backgroundPollTimer) {
			clearInterval(this.backgroundPollTimer);
			if (active) {
				this.reloadData().catch(() => {});
			}
			this.backgroundPollTimer = setInterval(() => {
				this.reloadData().catch(() => {});
			}, this.currentPollInterval);
		}
	}

	public async start(): Promise<void> {
		if (!window.location.href.includes("gym.php")) {
			return;
		}

		await this.loadData();
		this.scanAndInject();

		this.observer = new MutationObserver(() => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				this.scanAndInject();
			}, 150);
		});

		const target = document.querySelector("#gymroot") ?? document.body;
		this.observer.observe(target, {
			childList: true,
			subtree: true,
		});

		this.backgroundPollTimer = setInterval(() => {
			this.reloadData().catch(() => {});
		}, this.currentPollInterval);
	}

	public stop(): void {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.backgroundPollTimer) {
			clearInterval(this.backgroundPollTimer);
			this.backgroundPollTimer = null;
		}
	}

	public async reloadData(): Promise<void> {
		await this.loadData();
		this.scanAndInject(true);
	}

	private async loadData(): Promise<void> {
		try {
			const [efficiency, prefs, analytics] = await Promise.all([
				apiClient.getEfficiencyData(),
				apiClient.getBattlestatsPreferences().catch(() => null),
				apiClient.getBattlestatsAnalytics("30d").catch(() => null),
			]);
			this.efficiencyData = efficiency;
			if (prefs) {
				GM_setValue(STORAGE_KEYS.ratioType, prefs.ratioType);
				GM_setValue(STORAGE_KEYS.mainStat, prefs.mainStat);
			}
			if (analytics) {
				this.analyticsData = analytics;
			}
		} catch {
			this.efficiencyData = apiClient.getCachedEfficiency();
			this.analyticsData = apiClient.getCachedBattlestatsAnalytics();
		}
	}

	private getActiveGymId(): number {
		// Scan gym carousel buttons for the active button
		const activeBtn = document.querySelector(
			'button[class*="gymButton"][class*="active"]',
		);
		if (activeBtn) {
			const icon = activeBtn.querySelector('[class*="gymIcon"]');
			const match = icon?.className.match(/gym-(\d+)/);
			if (match?.[1]) {
				const num = Number(match[1]);
				if (!Number.isNaN(num) && num > 0) return num;
			}
		}
		// Default to George's (Gym 24)
		return 24;
	}

	private readStatsFromDom(): Record<StatType, number> | null {
		const statMap: Partial<Record<StatType, number>> = {};
		const statTypes: StatType[] = ["strength", "defense", "speed", "dexterity"];

		for (const st of statTypes) {
			const el = document.querySelector(`li[class*="${st}"]`);
			if (!el) continue;
			const valEl = el.querySelector('[class*="propertyValue"]');
			if (valEl) {
				const raw = valEl.textContent?.replace(/,/g, "").trim() ?? "";
				const parsed = Number(raw);
				if (!Number.isNaN(parsed) && parsed > 0) {
					statMap[st] = parsed;
				}
			}
		}

		if (
			statMap.strength &&
			statMap.defense &&
			statMap.speed &&
			statMap.dexterity
		) {
			return statMap as Record<StatType, number>;
		}

		// Fallback to API cached stats if DOM isn't fully ready
		if (this.efficiencyData?.stats) {
			return this.efficiencyData.stats;
		}

		return null;
	}

	public scanAndInject(_force = false): void {
		try {
			const propertiesUl = document.querySelector('ul[class*="properties"]');
			if (!propertiesUl) return;

			// 1. Inject quick top HUD with strictly gym-only gains
			this.injectQuickHud(propertiesUl, _force);

			// 2. Read stats, settings and gym details
			const stats = this.readStatsFromDom();
			if (!stats) return;

			const ratioType = GM_getValue<RatioType>(
				STORAGE_KEYS.ratioType,
				DEFAULT_SETTINGS.ratioType,
			);
			const mainStat = GM_getValue<StatType>(
				STORAGE_KEYS.mainStat,
				DEFAULT_SETTINGS.mainStat,
			);
			const ratios = getTargetRatios(ratioType, mainStat);

			const activeGymId = this.getActiveGymId();
			const gymDef = GYM_DEFINITIONS[activeGymId] ?? GYM_DEFINITIONS[24];
			if (!gymDef) return;

			const totalStats =
				stats.strength + stats.defense + stats.speed + stats.dexterity;
			const maxHappy = this.efficiencyData?.maxHappy ?? 5025;
			const perks = this.efficiencyData?.perks ?? {
				strength: 1,
				defense: 1,
				speed: 1,
				dexterity: 1,
			};

			// 3. Calculate gains and priority
			const statTypes: StatType[] = [
				"strength",
				"defense",
				"speed",
				"dexterity",
			];
			const rows = statTypes.map((st) => {
				const current = stats[st];
				const target = totalStats * ratios[st];
				const diff = current - target;
				const dots = gymDef[st];
				const perk = perks[st];

				const breakdown = calculateGymGainBreakdown(
					st,
					current,
					maxHappy,
					dots,
					gymDef.energy,
					perk,
				);

				return {
					statType: st,
					current,
					target,
					diff,
					dots,
					gainPerE: breakdown.gainPerE,
					gainPerTrain: breakdown.totalGain,
				};
			});

			const maxGainPerE = Math.max(...rows.map((r) => r.gainPerE));

			const scored = rows.map((r) => {
				if (r.current >= r.target) {
					return { ...r, priorityScore: -1 };
				}
				const ratioDeficit = (r.target - r.current) / (r.target || 1);
				const relativeEfficiency =
					maxGainPerE > 0 ? r.gainPerE / maxGainPerE : 0;
				const priorityScore = ratioDeficit * 0.5 + relativeEfficiency * 0.5;
				return { ...r, priorityScore };
			});

			const bestStat = [...scored].sort(
				(a, b) => b.priorityScore - a.priorityScore,
			)[0]?.statType;

			// 4. Inject pills and priority badges into each stat card
			for (const row of scored) {
				const li = document.querySelector<HTMLElement>(
					`li[class*="${row.statType}"]`,
				);
				if (!li) continue;

				// Highlight container for best stat
				if (row.statType === bestStat) {
					li.classList.add("blasted-gym-card-priority");
				} else {
					li.classList.remove("blasted-gym-card-priority");
				}

				// In-content efficiency pill
				const contentContainer = li.querySelector('[class*="propertyContent"]');
				if (contentContainer) {
					let pill = contentContainer.querySelector(
						".blasted-stat-efficiency-pill",
					);
					if (!pill) {
						pill = document.createElement("div");
						pill.className = "blasted-stat-efficiency-pill";
						const descEl = contentContainer.querySelector(
							'[class*="description"]',
						);
						if (descEl) {
							descEl.parentNode?.insertBefore(pill, descEl.nextSibling);
						} else {
							contentContainer.prepend(pill);
						}
					}

					const isSurplus = row.diff >= 0;
					const diffSign = isSurplus ? "+" : "-";
					const diffFormatted = `${diffSign}${formatCompactNumber(Math.abs(row.diff))}`;
					const curPct = (row.current / (totalStats || 1)) * 100;
					const targetPct = ratios[row.statType] * 100;
					const pctDiff = curPct - targetPct;
					const pctDiffSign = pctDiff >= 0 ? "+" : "-";
					const pctFormatted = `${pctDiffSign}${Math.abs(pctDiff).toFixed(1)}%`;

					pill.innerHTML = `
					${
						row.statType === bestStat
							? `
						<div class="blasted-pill-target-header">
							<span class="blasted-pill-target-label">TARGET STAT</span>
							<span class="blasted-pill-target-tag ${isSurplus ? "surplus" : "deficit"}">
								${isSurplus ? "ON TARGET" : "DEFICIT"}
							</span>
						</div>`
							: ""
					}
					<div class="blasted-pill-row">
						<span class="blasted-pill-label">Ratio:</span>
						<span class="blasted-pill-val ${isSurplus ? "surplus" : "deficit"}">
							${diffFormatted} • ${pctFormatted}
						</span>
					</div>
				`;
				}
			}
		} catch (err) {
			console.error("[Blasted's Script] scanAndInject error:", err);
		}
	}

	private injectQuickHud(propertiesUl: Element, force: boolean): void {
		const existingHud = document.querySelector("#blasted-gym-hud");
		if (existingHud && !force) return;

		const parent = propertiesUl.parentElement;
		if (!parent) return;

		let hud = existingHud as HTMLElement | null;
		if (!hud) {
			hud = document.createElement("div");
			hud.id = "blasted-gym-hud";
			parent.insertBefore(hud, propertiesUl);
		}

		const analytics =
			this.analyticsData ?? apiClient.getCachedBattlestatsAnalytics();
		const gymSource = analytics?.sourceBreakdown?.find(
			(s) => s.source === "gym",
		);
		const gymGained = gymSource?.gained ?? 0;
		const gymEnergy = gymSource?.energy ?? 0;
		const gymGainPerE = gymEnergy > 0 ? gymGained / gymEnergy : 0;

		if (gymGained <= 0) {
			hud.innerHTML = `
				<div class="blasted-hud-metrics">
					<span class="blasted-hud-item">
						<span class="hud-label">Gym Gain:</span>
						<span class="hud-value font-mono text-slate-400">No training recorded</span>
					</span>
				</div>
			`;
			return;
		}

		hud.innerHTML = `
			<div class="blasted-hud-metrics">
				<span class="blasted-hud-item">
					<span class="hud-label">Gym Gain:</span>
					<span class="hud-value font-mono text-emerald">+${formatCompactNumber(gymGained)} (${formatCompactNumber(gymEnergy)}E)</span>
				</span>
				<span class="blasted-hud-divider">|</span>
				<span class="blasted-hud-item">
					<span class="hud-label">Gym Gain/E:</span>
					<span class="hud-value font-mono text-sky">+${formatDecimal(gymGainPerE, 1)}</span>
				</span>
			</div>
		`;
	}
}
