import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../config";
import { BattlestatsTab } from "../modules/battlestats-tab";
import { CompanyTab } from "../modules/company-tab";
import { CrimesTab } from "../modules/crimes-tab";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

export class DrawerPanel {
	private overlay: HTMLElement;
	private drawer: HTMLElement;
	private crimesTab: CrimesTab | null = null;
	private battlestatsTab: BattlestatsTab | null = null;
	private companyTab: CompanyTab | null = null;
	private onRatioChange?: () => void;
	private activeTabName:
		| "crimes"
		| "battlestats"
		| "company"
		| "stocks"
		| "wealth"
		| "settings" = "crimes";
	private onSettingsSaved?: () => void;

	constructor(onSettingsSaved?: () => void, onRatioChange?: () => void) {
		this.onSettingsSaved = onSettingsSaved;
		this.onRatioChange = onRatioChange;
		this.activeTabName = GM_getValue<
			"crimes" | "battlestats" | "company" | "stocks" | "wealth" | "settings"
		>(STORAGE_KEYS.activeTab, "crimes");
		this.overlay = document.createElement("div");
		this.overlay.className = "blasted-drawer-overlay";

		this.drawer = document.createElement("div");
		this.drawer.className = "blasted-drawer";

		this.overlay.addEventListener("click", () => this.close());
		this.buildSkeleton();
	}

	private pollTimer: ReturnType<typeof setInterval> | null = null;

	public getElements(): { overlay: HTMLElement; drawer: HTMLElement } {
		return { overlay: this.overlay, drawer: this.drawer };
	}

	public isOpen(): boolean {
		return this.drawer.classList.contains("open");
	}

	public open(
		tab?:
			| "crimes"
			| "battlestats"
			| "company"
			| "stocks"
			| "wealth"
			| "settings",
	): void {
		if (tab) {
			this.switchTab(tab);
		}
		this.drawer.classList.add("open");
		this.overlay.classList.add("open");
		GM_setValue(STORAGE_KEYS.panelOpen, true);
		if (this.activeTabName === "crimes" && this.crimesTab) {
			this.crimesTab.refresh();
		} else if (this.activeTabName === "battlestats" && this.battlestatsTab) {
			this.battlestatsTab.refresh();
		} else if (this.activeTabName === "company" && this.companyTab) {
			this.companyTab.refresh();
		}
		this.startPolling();
	}

	public close(): void {
		this.drawer.classList.remove("open");
		this.overlay.classList.remove("open");
		GM_setValue(STORAGE_KEYS.panelOpen, false);
		this.stopPolling();
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			if (!this.isOpen()) {
				this.stopPolling();
				return;
			}
			if (this.activeTabName === "crimes" && this.crimesTab) {
				this.crimesTab.refresh().catch(() => {});
			} else if (this.activeTabName === "battlestats" && this.battlestatsTab) {
				this.battlestatsTab.refresh().catch(() => {});
			} else if (this.activeTabName === "company" && this.companyTab) {
				this.companyTab.refresh().catch(() => {});
			}
		}, 15000);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	public toggle(): void {
		if (this.isOpen()) {
			this.close();
		} else {
			this.open();
		}
	}

	public setStatus(text: string, type: "ok" | "error" | "loading"): void {
		const badge = this.drawer.querySelector<HTMLElement>(
			"#drawer-status-badge",
		);
		if (!badge) return;
		badge.textContent = text;
		badge.className = `status-badge ${type}`;
	}

	public openSettings(): void {
		this.switchTab("settings");
	}

	private buildSkeleton(): void {
		this.drawer.innerHTML = `
			<!-- Header with Tabs and Actions -->
			<div class="drawer-header">
				<div class="drawer-tabs">
					<button class="drawer-tab ${this.activeTabName === "crimes" ? "active" : ""}" data-tab="crimes">
						Crimes
					</button>
					<button class="drawer-tab ${this.activeTabName === "battlestats" ? "active" : ""}" data-tab="battlestats">
						Battlestats
					</button>
					<button class="drawer-tab ${this.activeTabName === "company" ? "active" : ""}" data-tab="company">
						Company
					</button>
					<button class="drawer-tab disabled" data-tab="stocks" title="Coming soon">
						Stocks <span class="tab-badge">Soon</span>
					</button>
					<button class="drawer-tab disabled" data-tab="wealth" title="Coming soon">
						Wealth <span class="tab-badge">Soon</span>
					</button>
					<button class="drawer-tab ${this.activeTabName === "settings" ? "active" : ""}" data-tab="settings">
						Settings
					</button>
				</div>
				<div class="drawer-actions">
					<button id="btn-refresh" class="btn-icon" title="Refresh Data">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
						</svg>
					</button>
					<button id="btn-close" class="btn-icon" title="Close Panel">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				</div>
			</div>

			<!-- Dynamic Tab Body -->
			<div id="drawer-body" class="drawer-body"></div>

			<!-- Footer with status badge -->
			<div class="drawer-footer">
				<div id="drawer-status-badge" class="status-badge ok">Connected</div>
			</div>
		`;

		this.drawer
			.querySelector("#btn-close")
			?.addEventListener("click", () => this.close());
		this.drawer.querySelector("#btn-refresh")?.addEventListener("click", () => {
			if (this.activeTabName === "crimes" && this.crimesTab) {
				this.setStatus("Syncing...", "loading");
				this.crimesTab
					.refresh()
					.then(() => {
						this.setStatus("Connected", "ok");
					})
					.catch((_e) => {
						this.setStatus("Error", "error");
					});
			} else if (this.activeTabName === "battlestats" && this.battlestatsTab) {
				this.setStatus("Syncing...", "loading");
				this.battlestatsTab
					.refresh()
					.then(() => {
						this.setStatus("Connected", "ok");
					})
					.catch((_e) => {
						this.setStatus("Error", "error");
					});
			} else if (this.activeTabName === "company" && this.companyTab) {
				this.setStatus("Syncing...", "loading");
				this.companyTab
					.refresh()
					.then(() => {
						this.setStatus("Connected", "ok");
					})
					.catch((_e) => {
						this.setStatus("Error", "error");
					});
			}
		});

		// Attach tab switching events
		this.drawer
			.querySelectorAll<HTMLButtonElement>("button[data-tab]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const tabName = btn.getAttribute("data-tab") as
						| "crimes"
						| "battlestats"
						| "company"
						| "stocks"
						| "wealth"
						| "settings";
					if (tabName && !btn.classList.contains("disabled")) {
						this.switchTab(tabName);
					}
				});
			});

		// Mount initial active Tab
		const body = this.drawer.querySelector<HTMLElement>("#drawer-body");
		if (body) {
			if (this.activeTabName === "crimes") {
				this.crimesTab = new CrimesTab(body, () => this.openSettings());
				this.crimesTab.init();
			} else if (this.activeTabName === "battlestats") {
				this.battlestatsTab = new BattlestatsTab(
					body,
					() => this.openSettings(),
					() => {
						if (this.onRatioChange) this.onRatioChange();
					},
				);
				this.battlestatsTab.init();
			} else if (this.activeTabName === "company") {
				this.companyTab = new CompanyTab(body, () => this.openSettings());
				this.companyTab.init();
			} else if (this.activeTabName === "settings") {
				this.renderSettings(body);
			}
		}
	}

	public switchTab(
		tab:
			| "crimes"
			| "battlestats"
			| "company"
			| "stocks"
			| "wealth"
			| "settings",
	): void {
		this.activeTabName = tab;
		GM_setValue(STORAGE_KEYS.activeTab, tab);
		this.drawer
			.querySelectorAll<HTMLButtonElement>("button[data-tab]")
			.forEach((btn) => {
				if (btn.getAttribute("data-tab") === tab) {
					btn.classList.add("active");
				} else {
					btn.classList.remove("active");
				}
			});

		const body = this.drawer.querySelector<HTMLElement>("#drawer-body");
		if (!body) return;

		if (tab === "crimes") {
			if (!this.crimesTab) {
				this.crimesTab = new CrimesTab(body, () => this.openSettings());
			}
			this.crimesTab.render();
		} else if (tab === "battlestats") {
			if (!this.battlestatsTab) {
				this.battlestatsTab = new BattlestatsTab(
					body,
					() => this.openSettings(),
					() => {
						if (this.onRatioChange) this.onRatioChange();
					},
				);
				this.battlestatsTab.init();
			} else {
				this.battlestatsTab.render();
			}
		} else if (tab === "company") {
			if (!this.companyTab) {
				this.companyTab = new CompanyTab(body, () => this.openSettings());
				this.companyTab.init();
			} else {
				this.companyTab.render();
			}
		} else if (tab === "settings") {
			this.renderSettings(body);
		}
	}

	private renderSettings(container: HTMLElement): void {
		const currentKey = GM_getValue<string>(STORAGE_KEYS.apiKey, "");
		const showBadges = GM_getValue<boolean>(
			STORAGE_KEYS.showBadges,
			DEFAULT_SETTINGS.showBadges,
		);

		container.innerHTML = `
			<div class="settings-group">
				<div style="font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">Configuration</div>

				<label class="settings-label">
					Sentinel API Key (Personal)
					<input id="input-api-key" type="password" class="input-text" value="${currentKey}" placeholder="Enter your secret API key..." />
					<span style="font-size: 11px; color: #64748b;">Used to authenticate requests to your personal crime ledger & telemetry.</span>
				</label>

				<label class="checkbox-row" style="margin-top: 6px;">
					<input id="chk-show-badges" type="checkbox" ${showBadges ? "checked" : ""} />
					<span>Show ROI & Profit badges directly on Torn crime cards</span>
				</label>

				<button id="btn-save-settings" class="btn-primary" style="margin-top: 8px;">Save Settings</button>
			</div>
		`;

		container
			.querySelector("#btn-save-settings")
			?.addEventListener("click", () => {
				const keyInput =
					container.querySelector<HTMLInputElement>("#input-api-key");
				const badgesInput =
					container.querySelector<HTMLInputElement>("#chk-show-badges");

				if (keyInput) {
					GM_setValue(STORAGE_KEYS.apiKey, keyInput.value.trim());
				}
				if (badgesInput) {
					GM_setValue(STORAGE_KEYS.showBadges, badgesInput.checked);
				}

				this.setStatus("Settings saved!", "ok");
				if (this.onSettingsSaved) {
					this.onSettingsSaved();
				}
				setTimeout(() => {
					this.switchTab("crimes");
				}, 600);
			});
	}
}
