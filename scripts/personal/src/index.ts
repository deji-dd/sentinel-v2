import { DEFAULT_SETTINGS, POLLING_CONFIG, STORAGE_KEYS } from "./config";
import { CompanyDomObserver } from "./modules/company-observer";
import { CrimesDomObserver } from "./modules/crimes-observer";
import { GymDomObserver } from "./modules/gym-observer";
import { IN_PAGE_BADGE_STYLES, SHADOW_STYLES } from "./styles";
import { DrawerPanel } from "./ui/drawer";
import { FloatingLauncher } from "./ui/launcher";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;
declare function GM_registerMenuCommand(name: string, fn: () => void): void;

(() => {
	// Prevent duplicate initialization
	if (document.getElementById("blasted-script-host")) {
		return;
	}

	// 1. Inject in-page badge styles into main document head
	const pageStyle = document.createElement("style");
	pageStyle.id = "blasted-inpage-styles";
	pageStyle.textContent = IN_PAGE_BADGE_STYLES;
	document.head.appendChild(pageStyle);

	// 2. Create host element and Shadow DOM root for complete UI isolation
	const host = document.createElement("div");
	host.id = "blasted-script-host";
	document.body.appendChild(host);

	const shadowRoot = host.attachShadow({ mode: "open" });

	const shadowStyle = document.createElement("style");
	shadowStyle.textContent = SHADOW_STYLES;
	shadowRoot.appendChild(shadowStyle);

	// 3. Initialize Drawer & Launcher
	let crimesObserver: CrimesDomObserver | null = null;
	let gymObserver: GymDomObserver | null = null;
	let companyObserver: CompanyDomObserver | null = null;

	function isHudCyclingActive(): boolean {
		try {
			const lastCycle = Number(
				localStorage.getItem(POLLING_CONFIG.STORAGE_HUD_CYCLE) || 0,
			);
			if (Date.now() - lastCycle < POLLING_CONFIG.HUD_ACTIVITY_TIMEOUT_MS) {
				return true;
			}
		} catch {}
		if (
			typeof document !== "undefined" &&
			document.getElementById("satf-attack-hud-host")
		) {
			return true;
		}
		return false;
	}

	function updateObserverPollRates(drawerOpen: boolean): void {
		const active = drawerOpen || isHudCyclingActive();
		crimesObserver?.setRampedUp(active);
		gymObserver?.setRampedUp(active);
		companyObserver?.setRampedUp(active);
	}

	const drawer = new DrawerPanel(
		() => {
			if (crimesObserver) crimesObserver.reloadData();
			if (gymObserver) gymObserver.reloadData();
			if (companyObserver) companyObserver.reloadData();
		},
		() => {
			if (gymObserver) gymObserver.scanAndInject(true);
		},
		(isOpen) => {
			updateObserverPollRates(isOpen);
		},
	);

	const launcher = new FloatingLauncher(() => {
		drawer.toggle();
	});

	const { overlay, drawer: drawerEl } = drawer.getElements();
	shadowRoot.appendChild(overlay);
	shadowRoot.appendChild(drawerEl);
	shadowRoot.appendChild(launcher.getElement());

	// 4. Initialize In-Page DOM Observers
	const showBadges = GM_getValue<boolean>(
		STORAGE_KEYS.showBadges,
		DEFAULT_SETTINGS.showBadges,
	);

	if (showBadges) {
		crimesObserver = new CrimesDomObserver(() => {
			drawer.open("crimes");
		});
		crimesObserver.start();

		gymObserver = new GymDomObserver();
		gymObserver.start();

		companyObserver = new CompanyDomObserver();
		companyObserver.start();

		updateObserverPollRates(drawer.isOpen());
	}

	// Periodically evaluate HUD cycling state to ramp down observers when idle
	setInterval(() => {
		updateObserverPollRates(drawer.isOpen());
	}, 10000);

	window.addEventListener("storage", (e) => {
		if (e.key === POLLING_CONFIG.STORAGE_HUD_CYCLE) {
			updateObserverPollRates(drawer.isOpen());
		}
	});

	// 5. Restore open state if persistOpen is enabled
	const wasOpen = GM_getValue<boolean>(STORAGE_KEYS.panelOpen, false);
	const persistOpen = GM_getValue<boolean>(
		STORAGE_KEYS.persistOpen,
		DEFAULT_SETTINGS.persistOpen,
	);
	if (wasOpen && persistOpen) {
		drawer.open();
	}

	// 6. Register Tampermonkey menu commands
	if (typeof GM_registerMenuCommand !== "undefined") {
		GM_registerMenuCommand("Toggle Blasted Hub", () => {
			drawer.toggle();
		});
		GM_registerMenuCommand("Open Settings", () => {
			drawer.open();
			drawer.openSettings();
		});
	}

	console.info(
		"[Blasted's Script] Initialized successfully. Telemetry connected to Sentinel API.",
	);
})();
