import {
	DEFAULT_SETTINGS,
	escapeHtml,
	isDocumentVisible,
	POLLING_CONFIG,
	STORAGE_KEYS,
} from "../config";
import { BattlestatsTab } from "../modules/battlestats-tab";
import { CompanyTab } from "../modules/company-tab";
import { CrimesTab } from "../modules/crimes-tab";
import { StocksTab } from "../modules/stocks-tab";
import { WealthTab } from "../modules/wealth-tab";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

/**
 * A usable drawer width for the current window.
 *
 * Returns 0 when the width should be left to the stylesheet: a stored value that
 * is not a number, or a viewport too narrow to drag in at all. Otherwise the width
 * is held between a readable minimum and whichever is smaller of the hard maximum
 * and the space the window can actually give up.
 */
function clampDrawerWidth(width: number, viewportWidth: number): number {
	if (!Number.isFinite(width) || width <= 0) return 0;
	if (viewportWidth < RESIZE_MIN_VIEWPORT_PX) return 0;
	const max = Math.max(
		MIN_DRAWER_WIDTH,
		Math.min(MAX_DRAWER_WIDTH, viewportWidth - DRAG_GUTTER_PX),
	);
	return Math.round(Math.min(Math.max(width, MIN_DRAWER_WIDTH), max));
}

/** Tabs that render a body. */
export type DrawerTabName =
	| "crimes"
	| "battlestats"
	| "company"
	| "stocks"
	| "wealth"
	| "settings";

/** The lifecycle every tab body implements, so the drawer has one code path. */
interface DrawerTab {
	init(): void | Promise<void>;
	render(): void;
	refresh(): Promise<void>;
}

const TAB_LABELS: Record<DrawerTabName, string> = {
	crimes: "Crimes",
	battlestats: "Battlestats",
	company: "Company",
	stocks: "Stocks",
	wealth: "Wealth",
	settings: "Settings",
};

const TAB_ORDER: DrawerTabName[] = [
	"crimes",
	"battlestats",
	"company",
	"stocks",
	"wealth",
	"settings",
];

/** Narrower than this and the tables inside stop being readable. */
const MIN_DRAWER_WIDTH = 380;
/** Widest the drawer may be dragged, however wide the window is. */
const MAX_DRAWER_WIDTH = 1_600;
/** Window width kept visible beside the drawer while dragging. */
const DRAG_GUTTER_PX = 48;
/** Below this the drawer is full-width and the handle is hidden. */
const RESIZE_MIN_VIEWPORT_PX = 700;

/**
 * The drawer shell.
 *
 * Every tab used to be handled by its own branch in five separate places (mount,
 * switch, poll, manual refresh, open), and the copies drifted: switching to Crimes
 * constructed the tab and rendered its loading state without ever fetching, so an
 * open from a crime badge showed an empty panel until the next poll. One registry
 * with one lifecycle removes the class of bug rather than that instance of it.
 */
export class DrawerPanel {
	private overlay: HTMLElement;
	private drawer: HTMLElement;
	private tabs = new Map<DrawerTabName, DrawerTab>();
	private activeTabName: DrawerTabName = "crimes";
	private onRatioChange?: () => void;
	private onSettingsSaved?: () => void;
	private onOpenChange?: (isOpen: boolean) => void;
	/** User-dragged width in pixels; 0 means "use the stylesheet default". */
	private width = 0;
	private dragging = false;

	constructor(
		onSettingsSaved?: () => void,
		onRatioChange?: () => void,
		onOpenChange?: (isOpen: boolean) => void,
	) {
		this.onSettingsSaved = onSettingsSaved;
		this.onRatioChange = onRatioChange;
		this.onOpenChange = onOpenChange;

		// A tab name written by an older build must not mount nothing.
		const stored = GM_getValue<string>(STORAGE_KEYS.activeTab, "crimes");
		this.activeTabName = this.isTabName(stored) ? stored : "crimes";

		this.overlay = document.createElement("div");
		this.overlay.className = "blasted-drawer-overlay";

		this.drawer = document.createElement("div");
		this.drawer.className = "blasted-drawer";

		this.overlay.addEventListener("click", () => this.close());
		this.buildSkeleton();
		this.width = clampDrawerWidth(
			GM_getValue<number>(STORAGE_KEYS.drawerWidth, 0),
			window.innerWidth,
		);
		this.applyWidth();
		this.bindResizeHandle();
		window.addEventListener("resize", () => this.applyWidth());
	}

	private pollTimer: ReturnType<typeof setInterval> | null = null;

	private isTabName(value: string): value is DrawerTabName {
		return Object.hasOwn(TAB_LABELS, value);
	}

	public getElements(): { overlay: HTMLElement; drawer: HTMLElement } {
		return { overlay: this.overlay, drawer: this.drawer };
	}

	public isOpen(): boolean {
		return this.drawer.classList.contains("open");
	}

	/** Applies the stored width, or clears it when the user has never dragged. */
	private applyWidth(): void {
		const resolved = clampDrawerWidth(this.width, window.innerWidth);
		if (resolved > 0) {
			this.drawer.style.width = `${resolved}px`;
		} else {
			this.drawer.style.removeProperty("width");
		}
	}

	/**
	 * Drags the drawer's left edge to resize it.
	 *
	 * The drawer is a fixed-width panel, and the stock and ledger tables inside it
	 * have more columns than fit at 580px. Pointer events cover mouse, pen and
	 * touch alike, and the class is only set while a drag is live so the width
	 * transition stays out of the way.
	 */
	private bindResizeHandle(): void {
		const handle = this.drawer.querySelector<HTMLElement>("#drawer-resize");
		if (!handle) return;

		const move = (event: PointerEvent): void => {
			if (!this.dragging) return;
			this.width = clampDrawerWidth(
				window.innerWidth - event.clientX,
				window.innerWidth,
			);
			this.applyWidth();
		};

		const end = (): void => {
			if (!this.dragging) return;
			this.dragging = false;
			this.drawer.classList.remove("resizing");
			document.body.style.removeProperty("cursor");
			document.body.style.removeProperty("user-select");
			GM_setValue(STORAGE_KEYS.drawerWidth, this.width);
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
		};

		handle.addEventListener("pointerdown", (event) => {
			if (window.innerWidth < RESIZE_MIN_VIEWPORT_PX) return;
			event.preventDefault();
			this.dragging = true;
			this.drawer.classList.add("resizing");
			// Text selection fights the drag, and the cursor has to stay a resize
			// cursor even when the pointer outruns the 6px handle.
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			handle.setPointerCapture(event.pointerId);
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		});

		// Double-click resets to the stylesheet width without touching storage keys
		// the user cannot see.
		handle.addEventListener("dblclick", () => {
			this.width = 0;
			GM_setValue(STORAGE_KEYS.drawerWidth, 0);
			this.applyWidth();
		});
	}

	public open(tab?: DrawerTabName): void {
		if (tab) {
			this.switchTab(tab);
		}
		this.drawer.classList.add("open");
		this.overlay.classList.add("open");
		GM_setValue(STORAGE_KEYS.panelOpen, true);
		this.onOpenChange?.(true);
		// A tab mounted for the first time is already fetching; one that was already
		// up is refreshed, so opening the panel after a while does not show the
		// payload from whenever it was last polled.
		const { created } = this.ensureTab(this.activeTabName);
		if (!created) {
			void this.refreshActiveTab().catch(() => {});
		}
		this.startPolling();
	}

	public close(): void {
		this.drawer.classList.remove("open");
		this.overlay.classList.remove("open");
		GM_setValue(STORAGE_KEYS.panelOpen, false);
		this.stopPolling();
		this.onOpenChange?.(false);
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			if (!this.isOpen()) {
				this.stopPolling();
				return;
			}
			// Nothing to poll into a panel the player is not looking at; the same
			// check gates the page observers.
			if (!isDocumentVisible()) return;
			void this.refreshActiveTab().catch(() => {});
		}, POLLING_CONFIG.DRAWER_INTERVAL_MS);
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

	/**
	 * Constructs a tab on first use and starts it.
	 *
	 * Returns immediately: the drawer never blocks on a request, and each tab
	 * renders its own loading state while it fetches.
	 */
	private ensureTab(name: DrawerTabName): { tab: DrawerTab; created: boolean } {
		const existing = this.tabs.get(name);
		if (existing) return { tab: existing, created: false };

		if (name === "settings") {
			const settingsTab: DrawerTab = {
				init: () => this.renderSettings(),
				render: () => this.renderSettings(),
				refresh: async () => this.renderSettings(),
			};
			this.tabs.set("settings", settingsTab);
			return { tab: settingsTab, created: true };
		}

		const body = this.drawer.querySelector<HTMLElement>("#drawer-body");
		if (!body) throw new Error("#drawer-body is missing from the drawer");

		let tab: DrawerTab;
		if (name === "crimes") {
			tab = new CrimesTab(body, () => this.openSettings());
		} else if (name === "battlestats") {
			tab = new BattlestatsTab(
				body,
				() => this.openSettings(),
				() => {
					this.onRatioChange?.();
				},
			);
		} else if (name === "company") {
			tab = new CompanyTab(body, () => this.openSettings());
		} else if (name === "wealth") {
			tab = new WealthTab(body, () => this.openSettings());
		} else {
			tab = new StocksTab(body, () => this.openSettings());
		}

		this.tabs.set(name, tab);
		void Promise.resolve(tab.init()).catch((err) => {
			console.error(
				`[Blasted's Script] Failed to initialise the ${name} tab:`,
				err,
			);
			this.setStatus("Error", "error");
		});
		return { tab, created: true };
	}

	private async refreshActiveTab(): Promise<void> {
		const { tab } = this.ensureTab(this.activeTabName);
		await tab.refresh();
	}

	private buildSkeleton(): void {
		const tabButtons = TAB_ORDER.map(
			(name) =>
				`<button class="drawer-tab ${this.activeTabName === name ? "active" : ""}" data-tab="${name}">${TAB_LABELS[name]}</button>`,
		).join("");

		this.drawer.innerHTML = `
			<!-- Drag handle: widens the panel on desktop, hidden on phones -->
			<div
				id="drawer-resize"
				class="drawer-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label="Drag to resize the panel, double-click to reset"
				title="Drag to resize · double-click to reset"
			></div>

			<!-- Header with Tabs and Actions -->
			<div class="drawer-header">
				<div class="drawer-tabs">
					${tabButtons}
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
			this.setStatus("Syncing...", "loading");
			this.refreshActiveTab()
				.then(() => this.setStatus("Connected", "ok"))
				.catch(() => this.setStatus("Error", "error"));
		});

		this.drawer
			.querySelectorAll<HTMLButtonElement>("button[data-tab]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const tabName = btn.getAttribute("data-tab");
					if (tabName && this.isTabName(tabName) && !btn.disabled) {
						this.switchTab(tabName);
					}
				});
			});

		// Mount whatever was active when the script last ran.
		this.ensureTab(this.activeTabName);
		// `open()` calls this too; nothing here refreshes on mount.
	}

	public switchTab(tab: DrawerTabName): void {
		this.activeTabName = tab;
		GM_setValue(STORAGE_KEYS.activeTab, tab);
		this.drawer
			.querySelectorAll<HTMLButtonElement>("button[data-tab]")
			.forEach((btn) => {
				btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
			});

		if (!this.drawer.querySelector<HTMLElement>("#drawer-body")) return;

		const { tab: tabInstance, created } = this.ensureTab(tab);
		// A tab mounted for the first time has just rendered its loading state and
		// started fetching; repainting now would wipe that request's output.
		if (!created) tabInstance.render();
	}

	private renderSettings(): void {
		const container = this.drawer.querySelector<HTMLElement>("#drawer-body");
		if (!container) return;

		const currentKey = GM_getValue<string>(STORAGE_KEYS.apiKey, "");
		const currentUrl = GM_getValue<string>(
			STORAGE_KEYS.apiUrl,
			DEFAULT_SETTINGS.apiUrl,
		);
		const showBadges = GM_getValue<boolean>(
			STORAGE_KEYS.showBadges,
			DEFAULT_SETTINGS.showBadges,
		);

		container.innerHTML = `
			<div class="settings-group">
				<div style="font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">Configuration</div>

				<label class="settings-label">
					Sentinel API Key (Personal)
					<input id="input-api-key" type="password" class="input-text" value="${escapeHtml(currentKey)}" placeholder="Enter your secret API key..." />
					<span style="font-size: 11px; color: #94a3b8;">Used to authenticate requests to your personal crime ledger &amp; telemetry.</span>
				</label>

				<label class="settings-label">
					API Base URL
					<input id="input-api-url" type="text" class="input-text" value="${escapeHtml(currentUrl)}" placeholder="${escapeHtml(DEFAULT_SETTINGS.apiUrl)}" />
					<span style="font-size: 11px; color: #94a3b8;">
						Your key is only ever sent to api.blasted-labs.tech, sentinel.blasted-labs.tech or
						localhost. Any other host is refused rather than handed the key.
					</span>
				</label>

				<label class="checkbox-row" style="margin-top: 6px;">
					<input id="chk-show-badges" type="checkbox" ${showBadges ? "checked" : ""} />
					<span>Show ROI &amp; Profit badges directly on Torn crime cards</span>
				</label>

				<div class="tos-table">
					<div class="tos-title">How your API key is used</div>
					<table>
						<tbody>
							<tr><th>Data storage</th><td>Your key is kept in your userscript manager's storage on this device. The ledger data it produces is stored on the Sentinel server to build the analytics shown here.</td></tr>
							<tr><th>Data sharing</th><td>Nobody. Nothing is shared with your faction, your friends, or any third party.</td></tr>
							<tr><th>Purpose of use</th><td>Non-malicious statistical analysis and personal gain: crime, battlestats, company, stock and wealth analytics for your own account.</td></tr>
							<tr><th>Key storage</th><td>Stored encrypted server-side and never shared. Requests from this script are authenticated with the key you enter above.</td></tr>
							<tr><th>Key access level</th><td>Limited or custom: the selections this script needs (personal logs, battlestats, stocks, company, money). Nothing beyond that is requested.</td></tr>
						</tbody>
					</table>
				</div>

				<button id="btn-save-settings" class="btn-primary" style="margin-top: 8px;">Save Settings</button>
			</div>
		`;

		container
			.querySelector("#btn-save-settings")
			?.addEventListener("click", () => {
				const keyInput =
					container.querySelector<HTMLInputElement>("#input-api-key");
				const urlInput =
					container.querySelector<HTMLInputElement>("#input-api-url");
				const badgesInput =
					container.querySelector<HTMLInputElement>("#chk-show-badges");

				if (keyInput) {
					GM_setValue(STORAGE_KEYS.apiKey, keyInput.value.trim());
				}
				if (urlInput) {
					const url = urlInput.value.trim();
					GM_setValue(
						STORAGE_KEYS.apiUrl,
						url.length > 0 ? url : DEFAULT_SETTINGS.apiUrl,
					);
				}
				if (badgesInput) {
					GM_setValue(STORAGE_KEYS.showBadges, badgesInput.checked);
				}

				this.setStatus("Settings saved", "ok");
				this.onSettingsSaved?.();
			});
	}
}
