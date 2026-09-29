import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./config";
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

	const drawer = new DrawerPanel(
		() => {
			if (crimesObserver) crimesObserver.reloadData();
			if (gymObserver) gymObserver.reloadData();
		},
		() => {
			if (gymObserver) gymObserver.scanAndInject(true);
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
	}

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
