import { apiClient } from "../api";
import { isDocumentVisible, POLLING_CONFIG } from "../config";
import type { CompanyEmployee, CompanyStateResponse } from "../types";

export class CompanyDomObserver {
	private employeeMap: Map<number, CompanyEmployee> = new Map();
	private observer: MutationObserver | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private backgroundPollTimer: ReturnType<typeof setInterval> | null = null;
	private visibilityHandler: (() => void) | null = null;
	private currentPollInterval: number = POLLING_CONFIG.SLOW_INTERVAL_MS;

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
		if (!window.location.href.includes("companies.php")) {
			return;
		}

		await this.loadCompanyData();
		this.scanAndInject();

		this.observer = new MutationObserver(() => {
			// Nothing here is needed while the page is in the background, and Torn's
			// rules forbid reading an unfocused page for data.
			if (!isDocumentVisible()) return;
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
			if (!isDocumentVisible()) return;
			this.reloadData().catch(() => {});
		}, this.currentPollInterval);

		// Coming back to the tab should not wait for the next tick to be correct.
		this.visibilityHandler = () => {
			if (!isDocumentVisible()) return;
			this.reloadData()
				.then(() => this.scanAndInject())
				.catch(() => {});
		};
		document.addEventListener("visibilitychange", this.visibilityHandler);
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
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}
		if (this.backgroundPollTimer) {
			clearInterval(this.backgroundPollTimer);
			this.backgroundPollTimer = null;
		}
	}

	public async reloadData(): Promise<void> {
		await this.loadCompanyData();
		this.scanAndInject(true);
	}

	private async loadCompanyData(): Promise<void> {
		try {
			const res = await apiClient.getCompanyState();
			this.populateMap(res);
		} catch {
			const cached = apiClient.getCachedCompanyState();
			if (cached) {
				this.populateMap(cached);
			}
		}
	}

	private populateMap(state: CompanyStateResponse): void {
		this.employeeMap.clear();
		// A cached payload from an older build may carry no employee list at all;
		// iterating it threw from inside the catch that was meant to be the safe path.
		for (const emp of state.employees ?? []) {
			this.employeeMap.set(emp.id, emp);
		}
	}

	public scanAndInject(_force = false): void {
		if (!window.location.href.includes("companies.php")) return;

		// Select all employee rows by locating the train link or rank dropdown
		const trainLinks = document.querySelectorAll<HTMLAnchorElement>(
			'a[href*="step=trainemp2&ID="]',
		);

		trainLinks.forEach((link) => {
			const href = link.getAttribute("href") ?? "";
			const idMatch = href.match(/ID=(\d+)/i);
			if (!idMatch?.[1]) return;

			const empId = Number(idMatch[1]);
			const emp = this.employeeMap.get(empId);
			if (!emp) return;

			const rowLi = link.closest("li");
			if (!rowLi) return;

			// 1. Role transfer target badge
			const rankDiv = rowLi.querySelector<HTMLElement>(".rank");
			if (rankDiv) {
				let roleBadge = rankDiv.querySelector<HTMLElement>(
					".blasted-role-badge",
				);
				if (emp.targetRole) {
					if (!roleBadge) {
						roleBadge = document.createElement("span");
						roleBadge.className = "blasted-inpage-badge blasted-role-badge";
						rankDiv.appendChild(roleBadge);
					}
					roleBadge.textContent = `Target: ${emp.targetRole}`;
				} else if (roleBadge) {
					roleBadge.remove();
				}
			}

			// Clean up any previously injected rehab badges
			const existingRehab = rowLi.querySelector<HTMLElement>(
				".blasted-rehab-badge",
			);
			if (existingRehab) {
				existingRehab.remove();
			}
		});
	}
}
