// ==UserScript==
// @name         Bounty Target Finder
// @namespace    sentinel.torn
// @version      1.2.0
// @description  Personal bounty target finder and hospital queue
// @author       Blasted [1934909]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @connect      sentinel.blasted-labs.tech
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @downloadURL  https://sentinel.blasted-labs.tech/api/v1/personal/bounties/script.user.js
// @updateURL    https://sentinel.blasted-labs.tech/api/v1/personal/bounties/script.user.js
// @run-at       document-idle
// ==/UserScript==

(() => {
	const STORAGE = {
		apiKey: "pbtf_api_key",
		panelOpen: "pbtf_panel_open",
		activeTab: "pbtf_active_tab",
		launcherPos: "pbtf_launcher_pos",
		panelPos: "pbtf_panel_pos",
		cachedTargets: "pbtf_cached_targets",
		cachedHospital: "pbtf_cached_hospital",
	};

	const DEFAULTS = {
		apiUrl: "https://sentinel.blasted-labs.tech",
	};

	function safeJsonParse(val, fallback) {
		try {
			return val ? JSON.parse(val) : fallback;
		} catch {
			return fallback;
		}
	}

	const state = {
		apiUrl: DEFAULTS.apiUrl.replace(/\/+$/, ""),
		apiKey: GM_getValue(STORAGE.apiKey, "") || "",
		panelOpen:
			GM_getValue(STORAGE.panelOpen, false) === true ||
			GM_getValue(STORAGE.panelOpen, false) === "true",
		activeTab: GM_getValue(STORAGE.activeTab, "ready"),
		readyTargets: safeJsonParse(GM_getValue(STORAGE.cachedTargets, "[]"), []),
		hospitalQueue: safeJsonParse(GM_getValue(STORAGE.cachedHospital, "[]"), []),
		pollInterval: null,
		ws: null,
		wsConnected: false,
		lastWsMessageAt: 0,
		reconnectTimer: null,
	};

	function formatMoney(num) {
		if (!num || !Number.isFinite(num)) return "$0";
		return `$${Math.round(num).toLocaleString()}`;
	}

	function formatSeconds(totalSeconds) {
		if (totalSeconds <= 0) return "0s";
		const m = Math.floor(totalSeconds / 60);
		const s = Math.floor(totalSeconds % 60);
		if (m > 60) {
			const h = Math.floor(m / 60);
			const remM = m % 60;
			return `${h}h ${remM}m`;
		}
		if (m > 0) return `${m}m ${s}s`;
		return `${s}s`;
	}

	function getFFColor(ff) {
		if (typeof ff !== "number" || Number.isNaN(ff)) return "#a1a1aa";
		if (ff >= 3.5) return "#ef4444"; // 3.5 - 4.0 (Red)
		if (ff >= 3.0) return "#f97316"; // 3.0 - 3.5 (Orange)
		if (ff >= 2.5) return "#eab308"; // 2.5 - 3.0 (Amber/Yellow)
		if (ff >= 2.0) return "#3b82f6"; // 2.0 - 2.5 (Blue)
		return "#10b981"; // 0.0 - 2.0 (Green)
	}

	function apiRequest(endpoint, options = {}) {
		const url = `${state.apiUrl}${endpoint}`;
		const headers = {
			Accept: "application/json",
			"Content-Type": "application/json",
			...(options.headers || {}),
		};

		if (state.apiKey) {
			headers["x-api-key"] = state.apiKey;
		}

		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: options.method || "GET",
				url,
				headers,
				data: options.body ? JSON.stringify(options.body) : undefined,
				timeout: 15000,
				onload: (res) => {
					let data;
					try {
						data = JSON.parse(res.responseText);
					} catch {
						data = { message: res.responseText };
					}

					if (res.status >= 200 && res.status < 300) {
						resolve(data);
					} else {
						const errMessage =
							data.error ||
							data.message ||
							`Request failed with status ${res.status}`;
						reject(new Error(errMessage));
					}
				},
				onerror: () =>
					reject(new Error("Could not connect to Sentinel API server.")),
				ontimeout: () => reject(new Error("Request timed out.")),
			});
		});
	}

	function start() {
		if (
			!document.body ||
			document.getElementById("personal-bounty-finder-host")
		) {
			return;
		}

		const host = document.createElement("div");
		host.id = "personal-bounty-finder-host";
		document.body.appendChild(host);
		const root = host.attachShadow({ mode: "open" });

		root.innerHTML = `
		<style>
			:host {
				all: initial;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
				--bg: #09090b;
				--card: #141417;
				--card-hover: #1c1c20;
				--border: #27272a;
				--text: #f4f4f5;
				--muted: #a1a1aa;
				--accent: #10b981;
				--accent-hover: #059669;
				--blue: #3b82f6;
				--danger: #ef4444;
				--warning: #f59e0b;
			}
			*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
			button, input { font: inherit; color: inherit; }

			#pbtf-launcher {
				position: fixed;
				z-index: 2147483646;
				height: 38px;
				padding: 0 14px;
				left: calc(100vw - 160px);
				top: calc(100vh - 56px);
				display: flex;
				align-items: center;
				gap: 8px;
				border-radius: 20px;
				border: 1px solid var(--border);
				background: var(--bg);
				box-shadow: 0 4px 16px rgba(0,0,0,0.6);
				cursor: grab;
				user-select: none;
				touch-action: none;
				transition: transform 0.15s, border-color 0.15s;
			}
			#pbtf-launcher:hover {
				border-color: var(--accent);
				transform: translateY(-2px);
			}
			#pbtf-launcher:active { cursor: grabbing; transform: translateY(0); }
			.pbtf-launcher-title {
				font-size: 11px;
				font-weight: 700;
				letter-spacing: 0.5px;
				color: var(--text);
				text-transform: uppercase;
			}
			.pbtf-badge {
				font-size: 12px;
				font-weight: 800;
				padding: 2px 7px;
				border-radius: 10px;
				background: var(--accent);
				color: #000;
			}

			#pbtf-panel {
				position: fixed;
				z-index: 2147483647;
				width: 420px;
				max-width: calc(100vw - 20px);
				max-height: calc(100vh - 20px);
				display: none;
				padding: 16px;
				border-radius: 14px;
				border: 1px solid var(--border);
				background: rgba(14, 14, 18, 0.98);
				backdrop-filter: blur(16px);
				color: var(--text);
				box-shadow: 0 12px 48px rgba(0,0,0,0.8);
				overflow-y: auto;
			}
			#pbtf-panel.open { display: block; }

			.pbtf-header {
				display: flex;
				flex-direction: column;
				gap: 10px;
				margin-bottom: 12px;
				padding-bottom: 10px;
				border-bottom: 1px solid var(--border);
				cursor: move;
			}
			.pbtf-header-top {
				display: flex;
				justify-content: space-between;
				align-items: center;
			}
			.pbtf-header-right {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.pbtf-title {
				font-size: 13px;
				font-weight: 800;
				letter-spacing: 0.5px;
				color: var(--text);
				text-transform: uppercase;
			}
			.pbtf-status {
				font-size: 11px;
				font-weight: 600;
				color: var(--muted);
			}
			.pbtf-status.ok { color: var(--accent); }
			.pbtf-status.error { color: var(--danger); }
			.pbtf-close-btn {
				background: none;
				border: none;
				color: var(--muted);
				font-size: 18px;
				font-weight: 700;
				line-height: 1;
				cursor: pointer;
				padding: 0 4px;
				border-radius: 4px;
				transition: all 0.15s;
			}
			.pbtf-close-btn:hover {
				color: var(--text);
				background: var(--card);
			}

			.pbtf-btn-refresh {
				padding: 3px 8px;
				font-size: 11px;
				font-weight: 700;
				border-radius: 6px;
				border: 1px solid var(--border);
				background: var(--card);
				color: var(--muted);
				cursor: pointer;
				transition: all 0.15s;
			}
			.pbtf-btn-refresh:hover {
				color: var(--text);
				background: var(--card-hover);
				border-color: var(--accent);
			}

			.pbtf-tabs {
				display: flex;
				gap: 6px;
				margin-bottom: 12px;
				border-bottom: 1px solid var(--border);
				padding-bottom: 8px;
			}
			.pbtf-tab-btn {
				flex: 1;
				padding: 6px 10px;
				font-size: 11px;
				font-weight: 700;
				text-align: center;
				border-radius: 6px;
				border: 1px solid transparent;
				background: transparent;
				color: var(--muted);
				cursor: pointer;
				transition: all 0.15s;
			}
			.pbtf-tab-btn:hover {
				color: var(--text);
				background: var(--card);
			}
			.pbtf-tab-btn.active {
				color: var(--text);
				background: var(--card);
				border-color: var(--border);
			}

			.pbtf-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
				min-height: 80px;
				max-height: 420px;
				overflow-y: auto;
			}

			.pbtf-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 9px 12px;
				border-radius: 8px;
				background: var(--card);
				border: 1px solid var(--border);
				transition: background 0.15s, border-color 0.15s;
			}
			.pbtf-row:hover {
				background: var(--card-hover);
				border-color: #3f3f46;
			}
			.pbtf-row-left {
				display: flex;
				flex-direction: column;
				gap: 3px;
			}
			.pbtf-row-name {
				display: flex;
				align-items: center;
				gap: 6px;
				font-size: 13px;
				font-weight: 700;
				color: var(--text);
			}
			.pbtf-row-id {
				font-size: 11px;
				color: var(--muted);
				font-weight: 500;
			}
			.pbtf-row-sub {
				display: flex;
				align-items: center;
				gap: 8px;
				font-size: 11px;
				color: var(--muted);
			}
			.pbtf-ff-badge {
				font-weight: 700;
				font-size: 11px;
				padding: 1px 5px;
				border-radius: 4px;
				border: 1px solid currentColor;
			}

			.pbtf-row-right {
				display: flex;
				align-items: center;
				gap: 10px;
			}
			.pbtf-reward {
				font-size: 13px;
				font-weight: 800;
				color: #34d399;
			}
			.pbtf-btn-hit {
				padding: 5px 12px;
				font-size: 11px;
				font-weight: 800;
				border-radius: 6px;
				border: none;
				background: var(--accent);
				color: #000;
				cursor: pointer;
				text-decoration: none;
				transition: background 0.15s;
			}
			.pbtf-btn-hit:hover {
				background: var(--accent-hover);
			}

			.pbtf-btn-check {
				padding: 4px 8px;
				font-size: 10px;
				font-weight: 700;
				border-radius: 5px;
				border: 1px solid var(--border);
				background: var(--card);
				color: var(--muted);
				cursor: pointer;
				transition: all 0.15s;
			}
			.pbtf-btn-check:hover {
				color: var(--text);
				border-color: var(--accent);
			}

			.pbtf-empty {
				text-align: center;
				padding: 24px 0;
				color: var(--muted);
				font-size: 12px;
				font-weight: 500;
			}

			.pbtf-settings-pane {
				display: flex;
				flex-direction: column;
				gap: 12px;
				padding: 4px 0;
			}
			.pbtf-field {
				display: flex;
				flex-direction: column;
				gap: 4px;
			}
			.pbtf-field label {
				font-size: 11px;
				font-weight: 700;
				color: var(--muted);
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.pbtf-field input {
				padding: 7px 10px;
				font-size: 12px;
				border-radius: 6px;
				border: 1px solid var(--border);
				background: var(--card);
				color: var(--text);
				outline: none;
			}
			.pbtf-field input:focus {
				border-color: var(--accent);
			}
			.pbtf-btn-save {
				margin-top: 4px;
				padding: 8px;
				font-size: 11px;
				font-weight: 800;
				border-radius: 6px;
				border: none;
				background: var(--accent);
				color: #000;
				cursor: pointer;
			}
			.pbtf-btn-save:hover { background: var(--accent-hover); }

			/* Overhead Target Display on Attack Page */
			#pbtf-overhead-bar {
				position: fixed;
				top: 12px;
				left: 50%;
				transform: translateX(-50%);
				z-index: 2147483645;
				display: none;
				align-items: center;
				gap: 12px;
				padding: 8px 16px;
				border-radius: 12px;
				border: 1px solid var(--border);
				background: rgba(14, 14, 18, 0.96);
				backdrop-filter: blur(16px);
				box-shadow: 0 8px 32px rgba(0,0,0,0.8);
				color: var(--text);
				font-size: 12px;
				font-weight: 600;
				white-space: nowrap;
				user-select: none;
			}
			#pbtf-overhead-bar.visible { display: flex; }
			.pbtf-overhead-tag {
				font-size: 10px;
				font-weight: 800;
				letter-spacing: 0.5px;
				padding: 2px 6px;
				border-radius: 4px;
				background: var(--card-hover);
				color: var(--muted);
				text-transform: uppercase;
			}
			.pbtf-overhead-tag.bounty {
				background: rgba(16, 185, 129, 0.2);
				color: var(--accent);
				border: 1px solid rgba(16, 185, 129, 0.4);
			}
			.pbtf-overhead-tag.defeated {
				background: rgba(239, 68, 68, 0.2);
				color: var(--danger);
				border: 1px solid rgba(239, 68, 68, 0.4);
			}
			.pbtf-overhead-info {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.pbtf-overhead-name {
				font-weight: 800;
				color: #fff;
			}
			.pbtf-overhead-reward {
				color: var(--accent);
				font-weight: 700;
			}
			.pbtf-overhead-cycle {
				display: flex;
				align-items: center;
				gap: 6px;
				margin-left: 6px;
				border-left: 1px solid var(--border);
				padding-left: 10px;
			}
			.pbtf-overhead-btn {
				padding: 4px 8px;
				font-size: 11px;
				font-weight: 700;
				border-radius: 6px;
				border: 1px solid var(--border);
				background: var(--card);
				color: var(--text);
				cursor: pointer;
				transition: all 0.15s;
			}
			.pbtf-overhead-btn:hover:not(:disabled) {
				background: var(--card-hover);
				border-color: var(--accent);
			}
			.pbtf-overhead-btn:disabled {
				opacity: 0.4;
				cursor: not-allowed;
			}
		</style>

		<!-- Overhead Target Display on Attack Page -->
		<div id="pbtf-overhead-bar">
			<div id="pbtf-overhead-content" style="display:flex;align-items:center;gap:10px;"></div>
		</div>

		<!-- Floating Launcher -->
		<div id="pbtf-launcher">
			<span class="pbtf-launcher-title">Bounties</span>
			<span class="pbtf-badge" id="pbtf-launcher-count">0</span>
		</div>

		<!-- Main Panel -->
		<div id="pbtf-panel">
			<div class="pbtf-header" id="pbtf-drag-handle">
				<div class="pbtf-header-top">
					<div class="pbtf-title">Bounty Target Finder</div>
					<div class="pbtf-header-right">
						<div class="pbtf-status ok" id="pbtf-status-text">Ready</div>
						<button type="button" class="pbtf-btn-refresh" id="pbtf-refresh-btn" title="Refresh">Refresh</button>
						<button type="button" class="pbtf-close-btn" id="pbtf-close-btn" title="Close Panel">&times;</button>
					</div>
				</div>
			</div>

			<div class="pbtf-tabs">
				<button type="button" class="pbtf-tab-btn active" data-tab="ready" id="pbtf-tab-ready">
					Ready (<span id="pbtf-count-ready">0</span>)
				</button>
				<button type="button" class="pbtf-tab-btn" data-tab="hospital" id="pbtf-tab-hosp">
					Hospital (<span id="pbtf-count-hosp">0</span>)
				</button>
				<button type="button" class="pbtf-tab-btn" data-tab="settings" id="pbtf-tab-settings">
					Settings
				</button>
			</div>

			<!-- Ready Targets Tab -->
			<div id="pbtf-pane-ready" class="pbtf-list"></div>

			<!-- Hospital Queue Tab -->
			<div id="pbtf-pane-hosp" class="pbtf-list" style="display:none;"></div>

			<!-- Settings Tab -->
			<div id="pbtf-pane-settings" class="pbtf-settings-pane" style="display:none;">
				<div class="pbtf-field">
					<label>Personal Torn API Key</label>
					<input type="password" id="pbtf-input-key" placeholder="Enter API key" value="${state.apiKey}" />
				</div>
				<button type="button" class="pbtf-btn-save" id="pbtf-btn-save-settings">Save Key</button>
			</div>
		</div>
		`;

		// Elements
		const launcher = root.getElementById("pbtf-launcher");
		const launcherCount = root.getElementById("pbtf-launcher-count");
		const panel = root.getElementById("pbtf-panel");
		const dragHandle = root.getElementById("pbtf-drag-handle");
		const statusEl = root.getElementById("pbtf-status-text");
		const refreshBtn = root.getElementById("pbtf-refresh-btn");

		const closeBtn = root.getElementById("pbtf-close-btn");
		const tabReady = root.getElementById("pbtf-tab-ready");
		const tabHosp = root.getElementById("pbtf-tab-hosp");
		const tabSettings = root.getElementById("pbtf-tab-settings");

		const paneReady = root.getElementById("pbtf-pane-ready");
		const paneHosp = root.getElementById("pbtf-pane-hosp");
		const paneSettings = root.getElementById("pbtf-pane-settings");

		const countReady = root.getElementById("pbtf-count-ready");
		const countHosp = root.getElementById("pbtf-count-hosp");

		const inputKey = root.getElementById("pbtf-input-key");
		const btnSaveSettings = root.getElementById("pbtf-btn-save-settings");

		// Status helper
		function setStatus(text, type = "ok") {
			state.statusText = text;
			state.statusType = type;
			if (statusEl) {
				statusEl.textContent = text;
				statusEl.className = `pbtf-status ${type}`;
			}
		}

		// Tab switching
		function switchTab(tab) {
			state.activeTab = tab;
			GM_setValue(STORAGE.activeTab, tab);

			tabReady?.classList.toggle("active", tab === "ready");
			tabHosp?.classList.toggle("active", tab === "hospital");
			tabSettings?.classList.toggle("active", tab === "settings");

			if (paneReady)
				paneReady.style.display = tab === "ready" ? "flex" : "none";
			if (paneHosp)
				paneHosp.style.display = tab === "hospital" ? "flex" : "none";
			if (paneSettings)
				paneSettings.style.display = tab === "settings" ? "flex" : "none";
		}

		tabReady?.addEventListener("click", () => switchTab("ready"));
		tabHosp?.addEventListener("click", () => switchTab("hospital"));
		tabSettings?.addEventListener("click", () => switchTab("settings"));

		// Position panel relative to launcher (beneath in Y axis or beside in X axis)
		function positionPanelRelativeToLauncher() {
			if (!panel || !launcher) return;
			const isMobile = window.innerWidth <= 480;
			if (isMobile) {
				panel.style.left = "10px";
				panel.style.top = "10px";
				panel.style.width = "calc(100vw - 20px)";
				return;
			}

			panel.style.width = "420px";
			const lRect = launcher.getBoundingClientRect();
			const pWidth = 420;
			const pHeight = Math.min(
				panel.offsetHeight || 480,
				window.innerHeight - 20,
			);

			const spaceBelow = window.innerHeight - lRect.bottom - 12;
			const spaceAbove = lRect.top - 12;
			const spaceLeft = lRect.left - 12;
			const spaceRight = window.innerWidth - lRect.right - 12;

			let left;
			let top;

			// 1. Primary: Beneath launcher in Y axis if there is enough vertical room
			if (spaceBelow >= Math.min(320, pHeight)) {
				top = lRect.bottom + 8;
				// Align horizontally with launcher
				if (lRect.left > window.innerWidth / 2) {
					left = lRect.right - pWidth;
				} else {
					left = lRect.left;
				}
			}
			// 2. Secondary: Beside launcher in X axis (left or right)
			else if (spaceLeft >= pWidth || spaceRight >= pWidth) {
				if (spaceLeft >= pWidth) {
					left = lRect.left - pWidth - 8;
				} else {
					left = lRect.right + 8;
				}
				top = Math.max(
					10,
					Math.min(window.innerHeight - pHeight - 10, lRect.top),
				);
			}
			// 3. Fallback: Above launcher in Y axis
			else if (spaceAbove >= 200) {
				top = Math.max(10, lRect.top - pHeight - 8);
				left =
					lRect.left > window.innerWidth / 2
						? lRect.right - pWidth
						: lRect.left;
			}
			// 4. Clamped viewport fallback
			else {
				left =
					lRect.left > window.innerWidth / 2
						? lRect.left - pWidth - 8
						: lRect.right + 8;
				top = Math.max(10, lRect.bottom + 8);
			}

			left = Math.max(10, Math.min(window.innerWidth - pWidth - 10, left));
			top = Math.max(10, Math.min(window.innerHeight - pHeight - 10, top));

			panel.style.left = `${left}px`;
			panel.style.top = `${top}px`;
			GM_setValue(STORAGE.panelPos, { x: left, y: top });
		}

		function openPanel() {
			state.panelOpen = true;
			GM_setValue(STORAGE.panelOpen, true);
			panel?.classList.add("open");
			positionPanelRelativeToLauncher();
			fetchBounties();
		}

		function closePanel() {
			state.panelOpen = false;
			GM_setValue(STORAGE.panelOpen, false);
			panel?.classList.remove("open");
		}

		function togglePanel(force) {
			const next = typeof force === "boolean" ? force : !state.panelOpen;
			if (next) {
				openPanel();
			} else {
				closePanel();
			}
		}

		closeBtn?.addEventListener("click", () => closePanel());

		launcher?.addEventListener("click", (e) => {
			if (isDragging) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			togglePanel();
		});

		// Render Ready Targets
		function renderReadyTargets(targets) {
			if (!paneReady) return;
			if (!targets || targets.length === 0) {
				paneReady.innerHTML = `
					<div class="pbtf-empty">
						No targets currently available.
					</div>
				`;
				return;
			}

			paneReady.innerHTML = targets
				.map((t) => {
					const ffText =
						t.fairFight !== null && t.fairFight !== undefined
							? `FF: ${t.fairFight.toFixed(2)}`
							: "FF: ?";
					const ffColor = getFFColor(t.fairFight);

					return `
						<div class="pbtf-row" data-id="${t.id}">
							<div class="pbtf-row-left">
								<div class="pbtf-row-name">
									<span>${t.name}</span>
									<span class="pbtf-row-id">[${t.id}]</span>
								</div>
								<div class="pbtf-row-sub">
									<span>Lvl ${t.level}</span>
									<span>·</span>
									<span class="pbtf-ff-badge" style="color: ${ffColor}; border-color: ${ffColor}50; background: ${ffColor}18;">${ffText}</span>
								</div>
							</div>
							<div class="pbtf-row-right">
								<span class="pbtf-reward">${formatMoney(t.reward)}</span>
								<a class="pbtf-btn-hit" href="${t.attackUrl}" target="_blank" rel="noopener">Hit</a>
							</div>
						</div>
					`;
				})
				.join("");
		}

		// Render Hospital Queue
		function renderHospitalQueue(queue) {
			if (!paneHosp) return;
			if (!queue || queue.length === 0) {
				paneHosp.innerHTML = `
					<div class="pbtf-empty">
						No hospitalized targets matching criteria.
					</div>
				`;
				return;
			}

			paneHosp.innerHTML = queue
				.map((t) => {
					const ffText =
						t.fairFight !== null && t.fairFight !== undefined
							? `FF: ${t.fairFight.toFixed(2)}`
							: "FF: ?";
					const ffColor = getFFColor(t.fairFight);
					const timeText = formatSeconds(t.secondsRemaining ?? 0);

					return `
						<div class="pbtf-row" data-id="${t.id}">
							<div class="pbtf-row-left">
								<div class="pbtf-row-name">
									<span>${t.name}</span>
									<span class="pbtf-row-id">[${t.id}]</span>
								</div>
								<div class="pbtf-row-sub">
									<span>Lvl ${t.level}</span>
									<span>·</span>
									<span class="pbtf-ff-badge" style="color: ${ffColor}; border-color: ${ffColor}50; background: ${ffColor}18;">${ffText}</span>
									<span>·</span>
									<span class="pbtf-hosp-time" data-until="${t.status?.until || 0}">${timeText}</span>
								</div>
							</div>
							<div class="pbtf-row-right">
								<span class="pbtf-reward">${formatMoney(t.reward)}</span>
								<button type="button" class="pbtf-btn-check" data-id="${t.id}">Check</button>
								<a class="pbtf-btn-hit" href="${t.attackUrl}" target="_blank" rel="noopener">Hit</a>
							</div>
						</div>
					`;
				})
				.join("");

			// Attach on-demand recheck listeners
			paneHosp.querySelectorAll(".pbtf-btn-check").forEach((btn) => {
				btn.addEventListener("click", async () => {
					const targetId = Number(btn.getAttribute("data-id"));
					if (!targetId) return;

					btn.textContent = "Checking...";
					btn.setAttribute("disabled", "true");

					try {
						const res = await apiRequest("/api/v1/personal/bounties/recheck", {
							method: "POST",
							body: { targetId },
						});

						if (res?.target) {
							setStatus(
								`Updated ${res.target.name}: ${res.target.status.state}`,
								"ok",
							);
							fetchBounties();
						}
					} catch (err) {
						setStatus(err.message, "error");
						btn.textContent = "Check";
						btn.removeAttribute("disabled");
					}
				});
			});
		}

		// Countdown ticker for hospital queue
		if (state.hospTimer) {
			clearInterval(state.hospTimer);
		}
		state.hospTimer = setInterval(() => {
			const nowSec = Math.floor(Date.now() / 1000);
			root.querySelectorAll(".pbtf-hosp-time").forEach((el) => {
				const until = Number(el.getAttribute("data-until"));
				if (until > 0) {
					const rem = Math.max(0, until - nowSec);
					el.textContent = formatSeconds(rem);
				}
			});
		}, 1000);

		function applyBountyData(res) {
			if (!res) return;
			state.readyTargets = res.readyTargets || [];
			state.hospitalQueue = res.hospitalQueue || [];
			GM_setValue(STORAGE.cachedTargets, JSON.stringify(state.readyTargets));
			GM_setValue(STORAGE.cachedHospital, JSON.stringify(state.hospitalQueue));

			if (launcherCount) {
				launcherCount.textContent = String(state.readyTargets.length);
			}
			if (countReady) {
				countReady.textContent = String(state.readyTargets.length);
			}
			if (countHosp) {
				countHosp.textContent = String(state.hospitalQueue.length);
			}

			renderReadyTargets(state.readyTargets);
			renderHospitalQueue(state.hospitalQueue);
			updateOverheadBar();

			const queueTag =
				res.pendingCount && res.pendingCount > 0
					? ` (${res.pendingCount} queued)`
					: "";
			const statusLabel = state.wsConnected
				? `Live${queueTag}`
				: `Ready${queueTag}`;
			setStatus(statusLabel, "ok");
		}

		// Fetch Bounties via HTTP
		async function fetchBounties() {
			if (!state.apiKey) {
				setStatus("API key required", "error");
				switchTab("settings");
				return;
			}

			if (!state.wsConnected) {
				setStatus("Syncing...", "ok");
			}
			try {
				const res = await apiRequest("/api/v1/personal/bounties");
				applyBountyData(res);
			} catch (err) {
				if (!state.wsConnected) {
					setStatus(err.message, "error");
				}
			}
		}

		function getWsUrl() {
			const base = state.apiUrl.replace(/\/+$/, "");
			if (base.startsWith("https://")) {
				return base.replace(/^https:\/\//, "wss://");
			}
			if (base.startsWith("http://")) {
				return base.replace(/^http:\/\//, "ws://");
			}
			return `wss://${base}`;
		}

		function connectWebSocket() {
			if (!state.apiKey) return;
			if (
				state.ws &&
				(state.ws.readyState === WebSocket.OPEN ||
					state.ws.readyState === WebSocket.CONNECTING)
			) {
				return;
			}

			try {
				const wsEndpoint = `${getWsUrl()}/api/ws/personal-bounties?apiKey=${encodeURIComponent(state.apiKey)}`;
				const ws = new WebSocket(wsEndpoint);
				state.ws = ws;

				ws.onopen = () => {
					state.wsConnected = true;
					setStatus("Live", "ok");
					ws.send(JSON.stringify({ type: "ping" }));
				};

				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(event.data);
						state.lastWsMessageAt = Date.now();
						if (msg.type === "state_snapshot" || msg.type === "state_update") {
							applyBountyData(msg);
						}
					} catch (e) {
						console.warn("[Bounty Target Finder] Invalid WS message:", e);
					}
				};

				ws.onerror = () => {
					state.wsConnected = false;
				};

				ws.onclose = () => {
					state.wsConnected = false;
					state.ws = null;
					if (state.apiKey) {
						setStatus("Reconnecting...", "ok");
						if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
						state.reconnectTimer = setTimeout(connectWebSocket, 5000);
					}
				};
			} catch (err) {
				console.warn(
					"[Bounty Target Finder] WebSocket connection failed:",
					err,
				);
				state.wsConnected = false;
			}
		}

		refreshBtn?.addEventListener("click", () => {
			if (state.ws && state.ws.readyState === WebSocket.OPEN) {
				state.ws.send(JSON.stringify({ type: "refresh" }));
			}
			fetchBounties();
		});

		// Save Settings
		btnSaveSettings?.addEventListener("click", () => {
			const newKey = (inputKey?.value || "").trim();

			if (!newKey) {
				setStatus("API key cannot be empty", "error");
				return;
			}

			state.apiKey = newKey;
			GM_setValue(STORAGE.apiKey, state.apiKey);

			setStatus("API key saved", "ok");
			switchTab("ready");
			fetchBounties();
			if (state.ws) {
				try {
					state.ws.close();
				} catch {}
				state.ws = null;
			}
			connectWebSocket();
		});

		// Setup draggable launcher
		let isDragging = false;
		let dragStartX = 0;
		let dragStartY = 0;
		let initLeft = 0;
		let initTop = 0;
		let pInitLeft = 0;
		let pInitTop = 0;

		launcher?.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			isDragging = false;
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			const rect = launcher.getBoundingClientRect();
			initLeft = rect.left;
			initTop = rect.top;

			// Capture modal position if open so it moves in tandem
			if (state.panelOpen && panel) {
				const pRect = panel.getBoundingClientRect();
				pInitLeft = pRect.left;
				pInitTop = pRect.top;
			}

			function onPointerMove(me) {
				const dx = me.clientX - dragStartX;
				const dy = me.clientY - dragStartY;
				if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
					isDragging = true;
				}
				const lWidth = launcher.offsetWidth || 120;
				const lHeight = launcher.offsetHeight || 38;
				const newLLeft = Math.max(
					10,
					Math.min(window.innerWidth - lWidth - 10, initLeft + dx),
				);
				const newLTop = Math.max(
					10,
					Math.min(window.innerHeight - lHeight - 10, initTop + dy),
				);
				launcher.style.left = `${newLLeft}px`;
				launcher.style.top = `${newLTop}px`;

				// When modal is open, move it with the button being dragged
				if (state.panelOpen && panel) {
					const actualDx = newLLeft - initLeft;
					const actualDy = newLTop - initTop;
					const pWidth = panel.offsetWidth || 420;
					const pHeight = panel.offsetHeight || 480;
					const newPLeft = Math.max(
						10,
						Math.min(window.innerWidth - pWidth - 10, pInitLeft + actualDx),
					);
					const newPTop = Math.max(
						10,
						Math.min(window.innerHeight - pHeight - 10, pInitTop + actualDy),
					);
					panel.style.left = `${newPLeft}px`;
					panel.style.top = `${newPTop}px`;
				}
			}

			function onPointerUp() {
				window.removeEventListener("pointermove", onPointerMove);
				window.removeEventListener("pointerup", onPointerUp);

				const finalLRect = launcher.getBoundingClientRect();
				GM_setValue(STORAGE.launcherPos, {
					x: finalLRect.left,
					y: finalLRect.top,
				});

				if (state.panelOpen && panel) {
					const finalPRect = panel.getBoundingClientRect();
					GM_setValue(STORAGE.panelPos, {
						x: finalPRect.left,
						y: finalPRect.top,
					});
				}

				if (isDragging) {
					setTimeout(() => {
						isDragging = false;
					}, 50);
				}
			}

			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});

		// Setup draggable panel
		dragHandle?.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || e.target?.closest("button")) return;
			const rect = panel.getBoundingClientRect();
			const pStartX = e.clientX;
			const pStartY = e.clientY;
			const pStartLeft = rect.left;
			const pStartTop = rect.top;

			function onPanelMove(me) {
				const dx = me.clientX - pStartX;
				const dy = me.clientY - pStartY;
				const pWidth = panel.offsetWidth || 420;
				const pHeight = panel.offsetHeight || 480;
				panel.style.left = `${Math.max(10, Math.min(window.innerWidth - pWidth - 10, pStartLeft + dx))}px`;
				panel.style.top = `${Math.max(10, Math.min(window.innerHeight - pHeight - 10, pStartTop + dy))}px`;
			}

			function onPanelUp() {
				window.removeEventListener("pointermove", onPanelMove);
				window.removeEventListener("pointerup", onPanelUp);
				const finalRect = panel.getBoundingClientRect();
				GM_setValue(STORAGE.panelPos, { x: finalRect.left, y: finalRect.top });
			}

			window.addEventListener("pointermove", onPanelMove);
			window.addEventListener("pointerup", onPanelUp);
		});

		// Restore saved launcher position if available
		const savedLauncherPos = GM_getValue(STORAGE.launcherPos, null);
		if (
			savedLauncherPos &&
			typeof savedLauncherPos.x === "number" &&
			typeof savedLauncherPos.y === "number"
		) {
			const clampedX = Math.max(
				10,
				Math.min(window.innerWidth - 120, savedLauncherPos.x),
			);
			const clampedY = Math.max(
				10,
				Math.min(window.innerHeight - 50, savedLauncherPos.y),
			);
			launcher.style.left = `${clampedX}px`;
			launcher.style.top = `${clampedY}px`;
		}

		// Restore saved panel position or position relative to launcher
		if (state.panelOpen) {
			panel?.classList.add("open");
			const savedPanelPos = GM_getValue(STORAGE.panelPos, null);
			if (
				savedPanelPos &&
				typeof savedPanelPos.x === "number" &&
				typeof savedPanelPos.y === "number"
			) {
				const clampedPX = Math.max(
					10,
					Math.min(window.innerWidth - 440, savedPanelPos.x),
				);
				const clampedPY = Math.max(
					10,
					Math.min(window.innerHeight - 200, savedPanelPos.y),
				);
				panel.style.left = `${clampedPX}px`;
				panel.style.top = `${clampedPY}px`;
			} else {
				positionPanelRelativeToLauncher();
			}
		}
		// Overhead Display & Attack Outcome Management
		function updateOverheadBar() {
			const overheadBar = root.getElementById("pbtf-overhead-bar");
			const overheadContent = root.getElementById("pbtf-overhead-content");
			if (!overheadBar || !overheadContent) return;

			const urlParams = new URLSearchParams(window.location.search);
			const isAttackPage = urlParams.get("sid") === "attack";
			const currentTargetId = Number(urlParams.get("user2ID"));

			if (
				!isAttackPage ||
				!currentTargetId ||
				!Number.isInteger(currentTargetId)
			) {
				overheadBar.classList.remove("visible");
				return;
			}

			overheadBar.classList.add("visible");

			const currentTargetIndex = state.readyTargets.findIndex(
				(t) => t.id === currentTargetId,
			);
			const currentTarget =
				currentTargetIndex !== -1
					? (state.readyTargets[currentTargetIndex] ?? null)
					: null;

			// Do not show HUD at all if target is not a bounty target
			if (!currentTarget) {
				overheadBar.classList.remove("visible");
				return;
			}

			overheadBar.classList.add("visible");

			let nextTarget = null;
			let prevTarget = null;

			if (state.readyTargets.length > 0) {
				const nextIdx = (currentTargetIndex + 1) % state.readyTargets.length;
				const prevIdx =
					(currentTargetIndex - 1 + state.readyTargets.length) %
					state.readyTargets.length;
				nextTarget = state.readyTargets[nextIdx] ?? null;
				prevTarget = state.readyTargets[prevIdx] ?? null;
			}

			const ffColor = getFFColor(currentTarget.fairFight);
			const ffText =
				currentTarget.fairFight !== null &&
				currentTarget.fairFight !== undefined
					? `FF ${currentTarget.fairFight.toFixed(2)}`
					: "FF ?";

			overheadContent.innerHTML = `
				<div class="pbtf-overhead-info">
					<span class="pbtf-overhead-tag bounty">Bounty</span>
					<span class="pbtf-overhead-name">${currentTarget.name} [lvl ${currentTarget.level}]</span>
					<span class="pbtf-overhead-reward">${formatMoney(currentTarget.reward)}</span>
					<span class="pbtf-ff-badge" style="color: ${ffColor}; border-color: ${ffColor}50; background: ${ffColor}18;">${ffText}</span>
				</div>
				<div class="pbtf-overhead-cycle">
					<button type="button" class="pbtf-overhead-btn" id="pbtf-cycle-prev" ${state.readyTargets.length <= 1 ? "disabled" : ""}>&lt; Prev</button>
					<span style="font-size:11px;color:var(--muted);">${currentTargetIndex + 1} of ${state.readyTargets.length}</span>
					<button type="button" class="pbtf-overhead-btn" id="pbtf-cycle-next" ${state.readyTargets.length <= 1 ? "disabled" : ""}>Next &gt;</button>
				</div>
			`;

			root.getElementById("pbtf-cycle-prev")?.addEventListener("click", () => {
				if (prevTarget && prevTarget.id !== currentTargetId) {
					window.location.href = prevTarget.attackUrl;
				} else if (state.readyTargets[0]) {
					window.location.href = state.readyTargets[0].attackUrl;
				}
			});

			root.getElementById("pbtf-cycle-next")?.addEventListener("click", () => {
				if (nextTarget && nextTarget.id !== currentTargetId) {
					window.location.href = nextTarget.attackUrl;
				} else if (state.readyTargets[0]) {
					window.location.href = state.readyTargets[0].attackUrl;
				}
			});
		}

		function handleTargetDefeated(targetId, outcomeText, isDefeat = true) {
			const targetIdx = state.readyTargets.findIndex((t) => t.id === targetId);
			let defeatedTarget = null;
			if (targetIdx !== -1) {
				const [removed] = state.readyTargets.splice(targetIdx, 1);
				defeatedTarget = removed ?? null;
			}

			if (defeatedTarget) {
				const nowSec = Math.floor(Date.now() / 1000);
				state.hospitalQueue.push({
					...defeatedTarget,
					status: {
						state: "Hospital",
						description: outcomeText,
						until: nowSec + 1800,
					},
					secondsRemaining: 1800,
				});
				state.hospitalQueue.sort(
					(a, b) => a.secondsRemaining - b.secondsRemaining,
				);
			}

			GM_setValue(STORAGE.cachedTargets, JSON.stringify(state.readyTargets));
			GM_setValue(STORAGE.cachedHospital, JSON.stringify(state.hospitalQueue));

			if (launcherCount) {
				launcherCount.textContent = String(state.readyTargets.length);
			}
			if (countReady) {
				countReady.textContent = String(state.readyTargets.length);
			}
			if (countHosp) {
				countHosp.textContent = String(state.hospitalQueue.length);
			}

			renderReadyTargets(state.readyTargets);
			renderHospitalQueue(state.hospitalQueue);

			// Update overhead bar to show status and prev/next controls
			const overheadBar = root.getElementById("pbtf-overhead-bar");
			const overheadContent = root.getElementById("pbtf-overhead-content");
			const nextBounty = state.readyTargets[0] ?? null;
			const tagText = isDefeat ? "Defeated" : "In Hospital";

			if (overheadBar && overheadContent) {
				overheadBar.classList.add("visible");
				overheadContent.innerHTML = `
					<div class="pbtf-overhead-info">
						<span class="pbtf-overhead-tag defeated">${tagText}</span>
						<span class="pbtf-overhead-name">${outcomeText}</span>
					</div>
					${
						state.readyTargets.length > 0
							? `<div class="pbtf-overhead-cycle">
						<button type="button" class="pbtf-overhead-btn" id="pbtf-cycle-prev">&lt; Prev</button>
						<span style="font-size:11px;color:var(--muted);">${state.readyTargets.length} ready</span>
						<button type="button" class="pbtf-overhead-btn" id="pbtf-cycle-next">Next &gt;</button>
					</div>`
							: '<span style="color:var(--muted);font-size:11px;margin-left:8px;">No more ready bounties</span>'
					}
				`;

				root
					.getElementById("pbtf-cycle-prev")
					?.addEventListener("click", () => {
						if (nextBounty) {
							window.location.href = nextBounty.attackUrl;
						}
					});

				root
					.getElementById("pbtf-cycle-next")
					?.addEventListener("click", () => {
						if (nextBounty) {
							window.location.href = nextBounty.attackUrl;
						}
					});
			}

			// Post defeat / hospital event to Sentinel backend
			apiRequest("/api/v1/personal/bounties/defeat", {
				method: "POST",
				body: {
					targetId,
					outcome: outcomeText,
				},
			}).catch((err) => {
				console.warn("[Bounty Target Finder] Failed to report defeat:", err);
			});
		}

		let lastHandledDefeatId = 0;
		let lastObservedUrl = window.location.href;

		function checkAttackPage() {
			const urlParams = new URLSearchParams(window.location.search);
			if (urlParams.get("sid") !== "attack") return;

			const currentTargetId =
				Number(urlParams.get("user2ID")) || Number(urlParams.get("ID"));
			if (!currentTargetId || !Number.isInteger(currentTargetId)) return;
			if (lastHandledDefeatId === currentTargetId) return;

			// Check all possible dialog, modal, popup, and status containers on Torn attack page
			const dialogEls = document.querySelectorAll(
				'[class*="dialogWrapper"], [class*="dialog"], [class*="custom-dialog"], [class*="popup"], [class*="modal"], [class*="confirmDialog"], [class*="alert"], .dialogWrapper___rzZgc, [class*="title___"], [class*="message___"]',
			);

			for (const el of dialogEls) {
				const text = el.textContent?.trim() || "";
				if (!text) continue;

				const isVictory =
					/\b(?:hospitalized|mugged|left|defeated)\b/i.test(text) &&
					/^You\s+(?:hospitalized|mugged|left|defeated)\b/i.test(text);

				const isAlreadyHospitalized =
					/\b(?:in hospital|cannot be attacked|is currently in hospital|currently in the hospital|someone else is attacking)\b/i.test(
						text,
					);

				if (isVictory) {
					lastHandledDefeatId = currentTargetId;
					handleTargetDefeated(currentTargetId, text, true);
					return;
				}
				if (isAlreadyHospitalized) {
					lastHandledDefeatId = currentTargetId;
					handleTargetDefeated(currentTargetId, text, false);
					return;
				}
			}
		}

		function checkProfilePage() {
			const url = window.location.href;
			if (!url.includes("profiles.php") && !url.includes("profile.php")) return;

			const urlParams = new URLSearchParams(window.location.search);
			const profileUserId =
				Number(urlParams.get("XID")) ||
				Number(urlParams.get("userId")) ||
				Number(urlParams.get("ID"));
			if (!profileUserId || !Number.isInteger(profileUserId)) return;
			if (lastHandledDefeatId === profileUserId) return;

			// Check if this profile is one of our ready targets
			const isReadyTarget = state.readyTargets.some(
				(t) => t.id === profileUserId,
			);
			if (!isReadyTarget) return;

			// Inspect profile container status elements
			const statusEls = document.querySelectorAll(
				'.profile-container [class*="status"], [class*="profile-header"] [class*="status"], .user-information [class*="status"], [class*="user-status"], [class*="status-desc"], [class*="profile-status"]',
			);

			for (const el of statusEls) {
				const text = el.textContent?.trim() || "";
				if (!text) continue;

				if (
					/\b(?:in hospital|hospitalized|federal jail|traveling|abroad)\b/i.test(
						text,
					)
				) {
					lastHandledDefeatId = profileUserId;
					handleTargetDefeated(profileUserId, text, false);
					return;
				}
			}
		}

		function handlePageOrUrlChange() {
			if (window.location.href !== lastObservedUrl) {
				lastObservedUrl = window.location.href;
				lastHandledDefeatId = 0; // reset defeat debounce for new page/target
			}
			updateOverheadBar();
			checkAttackPage();
			checkProfilePage();
		}

		// Intercept Torn SPA routing (pushState / replaceState / popstate)
		const originalPushState = history.pushState;
		history.pushState = function (...args) {
			originalPushState.apply(this, args);
			setTimeout(handlePageOrUrlChange, 50);
		};

		const originalReplaceState = history.replaceState;
		history.replaceState = function (...args) {
			originalReplaceState.apply(this, args);
			setTimeout(handlePageOrUrlChange, 50);
		};

		window.addEventListener("popstate", () =>
			setTimeout(handlePageOrUrlChange, 50),
		);
		window.addEventListener("hashchange", () =>
			setTimeout(handlePageOrUrlChange, 50),
		);

		// Continuous DOM MutationObserver to catch in-page dialogs and profile status changes
		const pageObserver = new MutationObserver(() => {
			if (window.location.href !== lastObservedUrl) {
				handlePageOrUrlChange();
			} else {
				checkAttackPage();
				checkProfilePage();
			}
		});

		pageObserver.observe(document.body, { childList: true, subtree: true });

		handlePageOrUrlChange();
		switchTab(state.activeTab);

		// Initial load: connect WebSocket and run initial HTTP fetch
		if (state.apiKey) {
			fetchBounties();
			connectWebSocket();
		} else {
			switchTab("settings");
		}

		// Fallback polling: polls every 30s only if WebSocket is disconnected or has not received an update in > 60s
		setInterval(() => {
			if (!state.apiKey) return;
			const isWsHealthy =
				state.wsConnected &&
				state.ws?.readyState === WebSocket.OPEN &&
				Date.now() - state.lastWsMessageAt < 60000;
			if (!isWsHealthy) {
				fetchBounties();
				if (!state.wsConnected) {
					connectWebSocket();
				}
			}
		}, 30000);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start);
	} else {
		start();
	}
})();
