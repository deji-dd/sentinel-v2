import { apiClient } from "../api";
import { CRIME_SLUG_MAP, formatMoney, POLLING_CONFIG } from "../config";
import type { CrimeCategoryAnalytics } from "../types";

export class CrimesDomObserver {
	private categoryMap: Map<number, CrimeCategoryAnalytics> = new Map();
	private observer: MutationObserver | null = null;
	private onOpenDrawer: () => void;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private backgroundPollTimer: ReturnType<typeof setInterval> | null = null;
	private currentPollInterval: number = POLLING_CONFIG.SLOW_INTERVAL_MS;

	constructor(onOpenDrawer: () => void) {
		this.onOpenDrawer = onOpenDrawer;
	}

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
		if (!window.location.href.includes("sid=crimes")) {
			return;
		}

		await this.loadCategoryData();
		this.scanAndInject();

		this.observer = new MutationObserver(() => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				this.scanAndInject();
			}, 150);
		});

		this.observer.observe(document.body, {
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
		await this.loadCategoryData();
		this.scanAndInject(true);
	}

	private async loadCategoryData(): Promise<void> {
		try {
			const state = await apiClient.getCrimeLedgerState();
			const categories = state.allTimeCategories ?? [];
			this.categoryMap.clear();
			for (const cat of categories) {
				this.categoryMap.set(cat.crimeId, cat);
			}
		} catch {
			const cached = apiClient.getCachedState();
			if (cached?.allTimeCategories) {
				for (const cat of cached.allTimeCategories) {
					this.categoryMap.set(cat.crimeId, cat);
				}
			}
		}
	}

	public scanAndInject(force = false): void {
		// Target crime category cards on Torn Crimes 2.0
		// Torn cards usually have links href="#/<crime-name>" or class containing crime item
		const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="#/"]');

		links.forEach((link) => {
			const href = link.getAttribute("href") ?? "";
			const slugMatch = href.match(/#\/([a-z0-9-]+)/i);
			if (!slugMatch?.[1]) return;

			const slug = slugMatch[1].toLowerCase();
			const crimeId = CRIME_SLUG_MAP[slug];
			if (!crimeId) return;

			// Check if badge already injected in this card
			const existingBadge = link.querySelector(".blasted-crime-badge");
			if (existingBadge && !force) return;

			const cat = this.categoryMap.get(crimeId);
			if (!cat) return;

			if (existingBadge) {
				existingBadge.remove();
			}

			const badge = document.createElement("div");
			badge.className = "blasted-crime-badge";
			badge.title = `Blasted's Analytics: Click to view historical charts & breakdowns for ${cat.crimeName}`;
			badge.innerHTML = `
				<span class="badge-roi">${formatMoney(cat.efficiency)}/N</span>
				<span class="badge-sep">|</span>
				<span class="badge-profit">${formatMoney(cat.value)}</span>
			`;

			badge.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.onOpenDrawer();
			});

			const mobileTitle = link.querySelector(
				'[class*="titleAndStatus"] [class*="crimeTitle"]',
			);
			if (mobileTitle) {
				badge.classList.add("blasted-mobile-badge");
				mobileTitle.insertAdjacentElement("afterend", badge);
			} else {
				link.appendChild(badge);
			}
		});
	}
}
