// ==UserScript==
// @name         Subversive Alliance
// @namespace    subversive.torn
// @version      2.3.5
// @description  Userscript for Subversive Alliance Ranked War & Target Engine
// @author       Blasted [1934909]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @connect      subversive.blasted-labs.tech
// @connect      localhost
// @connect      *
// @downloadURL  https://subversive.blasted-labs.tech/api/v1/target-finder/script.user.js
// @updateURL    https://subversive.blasted-labs.tech/api/v1/target-finder/script.user.js
// @run-at       document-idle
// ==/UserScript==

(() => {
	const STORAGE = {
		apiUrl: "satf_api_url",
		token: "satf_auth_token",
		user: "satf_user_data",
		position: "satf_launcher_position",
		panelOpen: "satf_panel_open",
		persistOpen: "satf_persist_open",
		activeTab: "satf_active_tab",
		maxFFThreshold: "satf_max_ff_threshold",
		maxBSThreshold: "satf_max_bs_threshold",
		cachedTargets: "satf_cached_targets",
		directAttack: "satf_direct_attack",
		hideHighFF: "satf_hide_high_ff",
		hideHighBS: "satf_hide_high_bs",
		targetSortBy: "satf_target_sort_by",
		targetSortOrder: "satf_target_sort_order",
		ignoredTargets: "satf_ignored_targets",
		currentTarget: "satf_current_target",
		warOpponentIds: "satf_war_opponent_ids",
		warState: "satf_war_state",
	};

	const DEFAULTS = {
		apiUrl: "https://subversive.blasted-labs.tech",
		maxFFThreshold: 3.0,
		maxBSThreshold: 5e9,
		directAttack: true,
		persistOpen: false,
	};

	const state = {
		apiUrl: (
			GM_getValue(STORAGE.apiUrl, DEFAULTS.apiUrl) || DEFAULTS.apiUrl
		).replace(/\/+$/, ""),
		token: GM_getValue(STORAGE.token, "") || "",
		user: GM_getValue(STORAGE.user, null),
		panelOpen:
			GM_getValue(STORAGE.panelOpen, false) === true ||
			GM_getValue(STORAGE.panelOpen, false) === "true",
		persistOpen:
			GM_getValue(STORAGE.persistOpen, DEFAULTS.persistOpen) === true ||
			GM_getValue(STORAGE.persistOpen, DEFAULTS.persistOpen) === "true",
		maxFFThreshold:
			Number(GM_getValue(STORAGE.maxFFThreshold, DEFAULTS.maxFFThreshold)) ||
			3.0,
		maxBSThreshold:
			Number(GM_getValue(STORAGE.maxBSThreshold, DEFAULTS.maxBSThreshold)) ||
			5e9,
		directAttack:
			GM_getValue(STORAGE.directAttack, DEFAULTS.directAttack) !== false &&
			GM_getValue(STORAGE.directAttack, DEFAULTS.directAttack) !== "false",
		hideHighFF: Boolean(GM_getValue(STORAGE.hideHighFF, false)),
		hideHighBS: Boolean(GM_getValue(STORAGE.hideHighBS, false)),
		ignoredTargets: GM_getValue(STORAGE.ignoredTargets, []) || [],
		war: null,
		warState: GM_getValue(STORAGE.warState, "no_war"),
		warOpponentIds: GM_getValue(STORAGE.warOpponentIds, []) || [],
		currentTarget: null,
		allTargets: GM_getValue(STORAGE.cachedTargets, []) || [],
		availableTargets: [],
		targetSortBy:
			GM_getValue(STORAGE.targetSortBy, "ff") === "level"
				? "ff"
				: GM_getValue(STORAGE.targetSortBy, "ff"), // 'ff' | 'online' | 'bs'
		targetSortOrder: GM_getValue(STORAGE.targetSortOrder, "desc"), // 'asc' | 'desc'
		hospitalQueue: [],
		hospLastSynced: null,
		hospTimer: null,
		ws: null,
		loading: false,
		statusText: "Ready",
		statusType: "ok",
		activeTab: GM_getValue(STORAGE.activeTab, "target") || "target", // 'target' | 'hosp' | 'settings'
		excludeIds: [],
	};

	function isWarEngaged() {
		const s = state.war ? state.war.state : state.warState;
		return s === "active" || s === "scheduled";
	}

	function formatStats(num) {
		if (!num || !Number.isFinite(num)) return "Unknown";
		if (num >= 1e15) return `${(num / 1e15).toFixed(2)}Q`;
		if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
		if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
		if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
		if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
		return Math.round(num).toLocaleString();
	}

	function parseStatsInput(str) {
		if (!str) return null;
		const clean = String(str).trim().toLowerCase();
		const match = clean.match(/^([\d.]+)\s*([kmbtq])?$/);
		if (!match) return null;
		const val = Number.parseFloat(match[1]);
		if (Number.isNaN(val) || val <= 0) return null;
		const unit = match[2];
		const mults = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
		return Math.round(val * (mults[unit] || 1));
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

	function getFFTier(ff) {
		if (typeof ff !== "number" || Number.isNaN(ff)) return "white";
		if (ff > 4.0) return "red";
		if (ff > 3.5) return "yellow";
		if (ff > 3.0) return "blue";
		if (ff > 2.0) return "green";
		return "white";
	}

	function getFFColor(ff) {
		const tier = getFFTier(ff);
		if (tier === "red") return "#ef4444";
		if (tier === "yellow") return "#eab308";
		if (tier === "blue") return "#3b82f6";
		if (tier === "green") return "#10b981";
		return "#f4f4f5";
	}

	function getNextTargetCandidate(excludeId) {
		if (!isWarEngaged()) return null;

		const excludes = new Set([
			...state.excludeIds.slice(-20),
			...state.ignoredTargets,
			...(excludeId ? [excludeId] : []),
		]);

		const pool = (state.allTargets || []).filter((t) => {
			if (excludes.has(t.id)) return false;
			if (state.hideHighFF && t.fairFight > state.maxFFThreshold) return false;
			if (state.hideHighBS && t.estimatedBs > state.maxBSThreshold)
				return false;
			if (t.statusCategory === "early_discharge" || t.hasEarlyDischarge)
				return false;
			const st = (t.status?.state || "").toLowerCase();
			if (st === "hospital") return false;
			return true;
		});

		if (pool.length === 0) return null;

		const multiplier = state.targetSortOrder === "asc" ? 1 : -1;
		const sorted = [...pool];
		if (state.targetSortBy === "ff") {
			sorted.sort((a, b) => (a.fairFight - b.fairFight) * multiplier);
		} else if (state.targetSortBy === "online") {
			sorted.sort(
				(a, b) => ((a.isOnline ? 1 : 0) - (b.isOnline ? 1 : 0)) * multiplier,
			);
		} else if (state.targetSortBy === "bs") {
			sorted.sort((a, b) => (a.estimatedBs - b.estimatedBs) * multiplier);
		}
		return sorted[0] || null;
	}

	function detectAttackerFlightState() {
		const href = window.location.href.toLowerCase();
		if (href.includes("travelagency") || href.includes("page=travel")) {
			return "traveling";
		}
		if (href.includes("index.php?page=abroad") || href.includes("/abroad")) {
			return "abroad";
		}
		const body = document.body;
		if (
			body &&
			(body.classList.contains("travel") || body.classList.contains("abroad"))
		) {
			return "traveling";
		}
		return "okay";
	}

	function apiRequest(endpoint, options = {}) {
		const url = `${state.apiUrl}${endpoint}`;
		const headers = {
			Accept: "application/json",
			"Content-Type": "application/json",
			...(options.headers || {}),
		};

		if (state.token) {
			headers.Authorization = `Bearer ${state.token}`;
		}

		const attackerState = detectAttackerFlightState();
		if (attackerState !== "okay") {
			headers["X-Attacker-State"] = attackerState;
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
						data = JSON.parse(res.responseText || "{}");
					} catch {
						return reject(new Error(`Server error (${res.status})`));
					}
					if (res.status >= 200 && res.status < 300 && data.success !== false) {
						resolve(data);
					} else {
						const errMessage =
							data.error ||
							data.message ||
							data.reason ||
							`Request failed (${res.status})`;
						const err = new Error(errMessage);
						err.data = data;
						reject(err);
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
			document.getElementById("subversive-target-finder-host")
		)
			return;

		const host = document.createElement("div");
		host.id = "subversive-target-finder-host";
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
				--danger: #ef4444;
				--warning: #f59e0b;
			}
			*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
			button, input { font: inherit; color: inherit; }

			#satf-launcher {
				position: fixed;
				z-index: 2147483646;
				width: 48px;
				height: 48px;
				left: calc(100vw - 64px);
				top: calc(100vh - 84px);
				display: grid;
				place-items: center;
				border-radius: 12px;
				border: 1px solid var(--border);
				background: var(--bg);
				box-shadow: 0 4px 20px rgba(0,0,0,0.5);
				cursor: grab;
				user-select: none;
				touch-action: none;
				transition: transform 0.15s, border-color 0.15s;
			}
			#satf-launcher:hover {
				border-color: var(--accent);
				transform: translateY(-2px);
			}
			#satf-launcher:active { cursor: grabbing; transform: translateY(0); }
			.satf-badge {
				font-size: 13px;
				font-weight: 800;
				color: var(--accent);
				letter-spacing: 0.5px;
			}

			#satf-panel {
				position: fixed;
				z-index: 2147483645;
				width: 430px;
				max-width: calc(100vw - 24px);
				max-height: calc(100vh - 24px);
				display: none;
				padding: 16px;
				border-radius: 16px;
				border: 1px solid var(--border);
				background: rgba(15, 15, 18, 0.97);
				backdrop-filter: blur(18px);
				color: var(--text);
				box-shadow: 0 12px 48px rgba(0,0,0,0.75);
				overflow-y: auto;
			}
			#satf-panel.open { display: block; }

			.satf-header {
				display: flex;
				flex-direction: column;
				gap: 10px;
				margin-bottom: 12px;
				padding-bottom: 10px;
				border-bottom: 1px solid var(--border);
			}
			.satf-header-top {
				display: flex;
				align-items: center;
				justify-content: space-between;
			}
			.satf-title {
				font-size: 14px;
				font-weight: 800;
				color: #fff;
				letter-spacing: 0.3px;
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.satf-btn-close {
				background: transparent;
				border: none;
				color: var(--muted);
				font-size: 16px;
				font-weight: 700;
				cursor: pointer;
				padding: 2px 6px;
				border-radius: 4px;
				line-height: 1;
				transition: color 0.15s;
			}
			.satf-btn-close:hover {
				color: #fff;
			}

			.satf-tabs {
				display: flex;
				background: #09090b;
				padding: 3px;
				border-radius: 8px;
				border: 1px solid var(--border);
				gap: 2px;
			}
			.satf-tab-btn {
				flex: 1;
				background: transparent;
				border: none;
				border-radius: 6px;
				padding: 5px 8px;
				font-size: 11px;
				font-weight: 600;
				color: var(--muted);
				cursor: pointer;
				text-align: center;
				transition: all 0.15s;
			}
			.satf-tab-btn.active {
				color: #fff;
				background: var(--card);
				border: 1px solid var(--border);
				box-shadow: 0 2px 6px rgba(0,0,0,0.3);
			}
			.satf-tab-btn:hover:not(.active) {
				color: var(--text);
			}

			.satf-war-banner {
				background: var(--card);
				border: 1px solid var(--border);
				border-radius: 10px;
				padding: 10px 12px;
				margin-bottom: 12px;
			}
			.satf-war-header-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				font-size: 11px;
				font-weight: 700;
				margin-bottom: 8px;
			}
			.satf-score-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				gap: 8px;
			}
			.satf-score-box {
				flex: 1;
				display: flex;
				flex-direction: column;
			}
			.satf-score-lbl {
				font-size: 10px;
				color: var(--muted);
				font-weight: 700;
				text-transform: uppercase;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}
			.satf-score-val {
				font-size: 14px;
				font-weight: 800;
				color: #fff;
			}
			.satf-lead-badge {
				font-size: 11px;
				font-weight: 800;
				padding: 2px 7px;
				border-radius: 4px;
			}
			.satf-lead-badge.lead-pos {
				background: rgba(16, 185, 129, 0.15);
				color: #34d399;
				border: 1px solid rgba(16, 185, 129, 0.3);
			}
			.satf-lead-badge.lead-neg {
				background: rgba(239, 68, 68, 0.15);
				color: #f87171;
				border: 1px solid rgba(239, 68, 68, 0.3);
			}

			.satf-travel-lock {
				display: none;
				background: rgba(245, 158, 11, 0.15);
				border: 1px solid rgba(245, 158, 11, 0.3);
				color: #fbbf24;
				border-radius: 8px;
				padding: 8px 10px;
				font-size: 11px;
				font-weight: 600;
				margin-bottom: 10px;
				text-align: center;
			}

			.satf-warning-banner {
				display: none;
				background: rgba(239, 68, 68, 0.15);
				border: 1px solid rgba(239, 68, 68, 0.4);
				color: #fca5a5;
				border-radius: 8px;
				padding: 8px 10px;
				font-size: 11px;
				font-weight: 700;
				margin-bottom: 10px;
				line-height: 1.3;
			}

			.satf-target-card {
				background: var(--card);
				border: 1px solid var(--border);
				border-radius: 12px;
				padding: 14px;
				margin-bottom: 10px;
			}
			.satf-target-title-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
			}
			.satf-target-name {
				font-size: 15px;
				font-weight: 700;
				color: #fff;
				text-decoration: none;
			}
			.satf-target-name:hover { text-decoration: underline; color: var(--accent); }
			.satf-btn-ignore {
				background: transparent;
				border: none;
				color: var(--muted);
				font-size: 11px;
				cursor: pointer;
				padding: 2px 4px;
				border-radius: 4px;
				transition: color 0.15s;
			}
			.satf-btn-ignore:hover {
				color: var(--danger);
			}

			.satf-meta-row {
				display: flex;
				flex-wrap: wrap;
				gap: 6px;
				margin: 8px 0;
			}
			.satf-badge-pill {
				font-size: 10px;
				font-weight: 700;
				padding: 2px 7px;
				border-radius: 4px;
				background: #27272a;
				color: var(--muted);
				text-transform: uppercase;
				display: inline-flex;
				align-items: center;
				gap: 4px;
			}
			.satf-badge-pill.status-online {
				background: rgba(16, 185, 129, 0.2);
				color: #34d399;
				border: 1px solid rgba(16, 185, 129, 0.4);
			}
			.satf-badge-pill.status-ready {
				background: rgba(16, 185, 129, 0.15);
				color: #34d399;
				border: 1px solid rgba(16, 185, 129, 0.3);
			}
			.satf-badge-pill.status-discharge {
				background: rgba(245, 158, 11, 0.2);
				color: #fbbf24;
				border: 1px solid rgba(245, 158, 11, 0.4);
			}
			.satf-badge-pill.status-hosp {
				background: rgba(239, 68, 68, 0.15);
				color: #f87171;
				border: 1px solid rgba(239, 68, 68, 0.3);
			}
			.satf-dot-online {
				width: 6px;
				height: 6px;
				border-radius: 50%;
				background: #10b981;
				box-shadow: 0 0 6px #10b981;
			}

			.satf-stats-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				margin-top: 10px;
				padding-top: 10px;
				border-top: 1px dashed var(--border);
			}
			.satf-stat-label { font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; }
			.satf-stat-val { font-size: 13px; font-weight: 700; color: #fff; }
			.satf-ff-badge {
				font-size: 15px;
				font-weight: 800;
			}
			.ff-white { color: #f4f4f5 !important; }
			.ff-green { color: #10b981 !important; }
			.ff-blue { color: #3b82f6 !important; }
			.ff-yellow { color: #eab308 !important; }
			.ff-red { color: #ef4444 !important; }

			.satf-actions {
				display: flex;
				gap: 8px;
			}
			.satf-btn {
				padding: 8px 12px;
				border-radius: 8px;
				border: 1px solid var(--border);
				font-size: 12px;
				font-weight: 700;
				cursor: pointer;
				text-align: center;
				transition: all 0.15s;
			}
			.satf-actions .satf-btn {
				flex: 1;
				padding: 10px 12px;
			}
			.satf-btn-primary {
				background: var(--accent);
				color: #000;
				border: none;
				text-decoration: none;
				display: grid;
				place-items: center;
			}
			.satf-btn-primary:hover { background: var(--accent-hover); }
			.satf-btn-primary.disabled {
				opacity: 0.5;
				pointer-events: none;
			}
			.satf-btn-secondary {
				background: var(--card);
				color: var(--text);
			}
			.satf-btn-secondary:hover { background: var(--card-hover); }
			.satf-btn-sm {
				flex: none;
				width: auto;
				padding: 4px 10px;
				font-size: 11px;
			}

			.satf-direct-toggle-row {
				display: flex;
				align-items: center;
				justify-content: space-between;
				margin-top: 8px;
				margin-bottom: 12px;
				font-size: 11px;
				color: var(--muted);
				padding: 0 4px;
			}
			.satf-direct-toggle-row label {
				cursor: pointer;
				display: flex;
				align-items: center;
				gap: 6px;
			}

			/* AVAILABLE TARGETS ROSTER */
			.satf-roster-section {
				margin-top: 8px;
				border-top: 1px solid var(--border);
				padding-top: 10px;
			}
			.satf-roster-header {
				display: flex;
				justify-content: space-between;
				align-items: center;
				margin-bottom: 8px;
				font-size: 11px;
				font-weight: 700;
				color: var(--text);
			}
			.satf-sort-pills {
				display: flex;
				gap: 4px;
			}
			.satf-sort-pill {
				background: #09090b;
				border: 1px solid var(--border);
				color: var(--muted);
				font-size: 10px;
				padding: 2px 6px;
				border-radius: 4px;
				cursor: pointer;
				transition: all 0.15s;
			}
			.satf-sort-pill.active, .satf-sort-pill:hover {
				color: #fff;
				border-color: var(--accent);
			}
			.satf-roster-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
				max-height: 340px;
				overflow-y: auto;
			}
			.satf-roster-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 8px 10px;
				background: var(--card);
				border: 1px solid var(--border);
				border-radius: 8px;
				font-size: 12px;
				cursor: pointer;
				transition: border-color 0.15s, background 0.15s;
			}
			.satf-roster-row:hover {
				border-color: var(--accent);
				background: var(--card-hover);
			}
			.satf-roster-left {
				display: flex;
				flex-direction: column;
				gap: 2px;
			}
			.satf-roster-name {
				font-weight: 700;
				color: #fff;
				display: flex;
				align-items: center;
				gap: 6px;
			}
			.satf-roster-sub {
				font-size: 10px;
				color: var(--muted);
			}
			.satf-roster-right {
				display: flex;
				align-items: center;
				gap: 8px;
			}

			.satf-queue-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
				max-height: 340px;
				overflow-y: auto;
			}
			.satf-queue-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 8px 10px;
				background: var(--card);
				border: 1px solid var(--border);
				border-radius: 8px;
				font-size: 12px;
				cursor: pointer;
				transition: border-color 0.15s;
			}
			.satf-queue-row:hover {
				border-color: var(--accent);
			}
			.satf-queue-time {
				font-weight: 700;
				color: #f59e0b;
			}
			.satf-queue-time.ready {
				color: #10b981;
			}

			.satf-status {
				margin-top: 12px;
				font-size: 11px;
				padding: 6px 10px;
				border-radius: 6px;
				background: var(--card);
				color: var(--muted);
				display: flex;
				align-items: center;
				justify-content: space-between;
			}
			.satf-status.error { color: var(--danger); background: rgba(239, 68, 68, 0.1); }
			.satf-status.ok { color: var(--accent); }

			.satf-field {
				margin-bottom: 10px;
			}
			.satf-field label {
				display: block;
				font-size: 11px;
				color: var(--muted);
				margin-bottom: 4px;
				font-weight: 600;
			}
			.satf-field input[type="text"],
			.satf-field input[type="number"] {
				width: 100%;
				padding: 8px 10px;
				background: #09090b;
				border: 1px solid var(--border);
				border-radius: 8px;
				font-size: 12px;
				color: #fff;
			}
			.satf-field-row {
				display: flex;
				gap: 8px;
			}
			.satf-field-row .satf-field {
				flex: 1;
			}

			.satf-auth-connected-box {
				background: #09090b;
				border: 1px solid var(--border);
				border-radius: 8px;
				padding: 10px 12px;
				margin-bottom: 12px;
			}
		</style>

		<div id="satf-launcher">
			<span class="satf-badge">SA</span>
		</div>

		<div id="satf-panel">
			<div class="satf-header">
				<div class="satf-header-top">
					<div class="satf-title">
						<span>Subversive Alliance</span>
					</div>
					<button id="satf-btn-close" class="satf-btn-close" title="Close Panel">X</button>
				</div>
				<div class="satf-tabs">
					<button class="satf-tab-btn active" data-tab="target">Target</button>
					<button class="satf-tab-btn" data-tab="hosp">Hosp Queue</button>
					<button class="satf-tab-btn" data-tab="settings">Settings</button>
				</div>
			</div>

			<!-- WAR SCOREBOARD BANNER -->
			<div id="satf-war-banner" class="satf-war-banner">
				<div class="satf-war-header-row">
					<span id="satf-war-title">RANKED WAR</span>
					<span id="satf-war-lead" class="satf-lead-badge lead-pos" style="display: none;">LEAD +0</span>
				</div>
				<div class="satf-score-row">
					<div class="satf-score-box">
						<span class="satf-score-lbl">Subversive Alliance</span>
						<span id="satf-score-sa" class="satf-score-val">--</span>
					</div>
					<div class="satf-score-box" style="text-align:center;">
						<span class="satf-score-lbl">Target</span>
						<span id="satf-score-target" class="satf-score-val" style="color:var(--muted);">--</span>
					</div>
					<div class="satf-score-box" style="text-align:right;">
						<span id="satf-opp-name" class="satf-score-lbl">Opponent</span>
						<span id="satf-score-opp" class="satf-score-val">--</span>
					</div>
				</div>
			</div>

			<!-- TRAVEL LOCK WARNING -->
			<div id="satf-travel-lock" class="satf-travel-lock">
				[TRAVEL LOCK] Attacker is traveling or abroad. Target dispatch locked.
			</div>


			<!-- TARGET VIEW -->
			<div id="satf-view-target">
				<div class="satf-direct-toggle-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
					<label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; color: var(--muted);">
						<input type="checkbox" id="satf-chk-direct">
						<span>Direct Attack</span>
					</label>
					<button id="satf-btn-modal-next" class="satf-btn satf-btn-primary satf-btn-sm" style="padding: 3px 10px; font-size: 11px;">Next Target →</button>
				</div>
				<div class="satf-filter-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; padding: 6px 8px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 6px; font-size: 11px; color: var(--muted);">
					<div style="display: flex; align-items: center; gap: 5px;">
						<label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
							<input type="checkbox" id="satf-chk-hide-high-ff">
							<span>Max FF</span>
						</label>
						<input type="number" id="satf-input-hide-ff" min="1.0" max="10.0" step="0.1" value="${state.maxFFThreshold.toFixed(1)}" style="width: 44px; padding: 2px 4px; background: #18181b; border: 1px solid var(--border); border-radius: 4px; color: #fff; font-size: 11px; text-align: center;">
					</div>
					<div style="display: flex; align-items: center; gap: 5px;">
						<label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
							<input type="checkbox" id="satf-chk-hide-high-bs">
							<span>Max BS</span>
						</label>
						<input type="text" id="satf-input-hide-bs" placeholder="e.g. 5B" value="${formatStats(state.maxBSThreshold)}" title="${state.maxBSThreshold.toLocaleString()}" style="width: 60px; padding: 2px 4px; background: #18181b; border: 1px solid var(--border); border-radius: 4px; color: #fff; font-size: 11px; text-align: center;">
					</div>
				</div>

				<!-- SCROLLABLE AVAILABLE TARGETS ROSTER -->
				<div class="satf-roster-section">
					<div class="satf-roster-header">
						<span>Available Opponents (<span id="satf-avail-count">0</span>)</span>
						<div class="satf-sort-pills">
							<span class="satf-sort-pill" data-sort="ff">FF</span>
							<span class="satf-sort-pill" data-sort="online">Online</span>
							<span class="satf-sort-pill" data-sort="bs">BS</span>
						</div>
					</div>
					<div id="satf-avail-list" class="satf-roster-list">
						<div style="text-align: center; padding: 16px 0; color: var(--muted); font-size: 11px;">
							No available targets currently in ready state.
						</div>
					</div>
				</div>
			</div>

			<!-- HOSPITAL QUEUE VIEW -->
			<div id="satf-view-hosp" style="display: none;">
				<div id="satf-hosp-container" class="satf-queue-list">
					<div style="text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px;">
						Loading hospital queue...
					</div>
				</div>
			</div>

			<!-- SETTINGS VIEW -->
			<div id="satf-view-settings" style="display: none;">
				<!-- CONNECTED PLAYER STATUS -->
				<div id="satf-auth-connected" class="satf-auth-connected-box" style="display: none;">
					<div style="display: flex; justify-content: space-between; align-items: center;">
						<div>
							<div style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700;">Connected Member</div>
							<div id="satf-auth-name-id" style="font-size: 13px; font-weight: 700; color: #fff;">--</div>
						</div>
						<button id="satf-btn-toggle-key-input" class="satf-btn satf-btn-secondary satf-btn-sm">Change Key</button>
					</div>
				</div>

				<div id="satf-key-input-container">
					<div class="satf-field">
						<label>Torn Public API Key</label>
						<input type="text" id="satf-input-key" placeholder="Enter 16-character Torn API key...">
					</div>
					<button id="satf-btn-auth" class="satf-btn satf-btn-primary" style="width: 100%; margin-bottom: 12px;">Connect Key</button>
				</div>

				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 11px; color: var(--muted);">
					<span id="satf-ignored-count">${state.ignoredTargets.length} ignored targets</span>
					<button id="satf-btn-clear-ignored" class="satf-btn satf-btn-secondary satf-btn-sm">Reset Ignored</button>
				</div>

				<div style="margin-bottom: 12px;">
					<label style="font-size: 11px; color: var(--muted); cursor: pointer; display: flex; align-items: center; gap: 6px;">
						<input type="checkbox" id="satf-chk-persist-open">
						<span>Remember open window across page loads</span>
					</label>
				</div>

				<div style="display: flex; gap: 8px; margin-top: 10px;">
					<button id="satf-btn-refresh-stats" class="satf-btn satf-btn-secondary" style="flex: 1;">Refresh Stats</button>
					<button id="satf-btn-logout" class="satf-btn satf-btn-secondary satf-btn-sm" style="color: var(--danger);">Logout</button>
				</div>
			</div>

			<div id="satf-status" class="satf-status">
				<span id="satf-status-text">Ready</span>
				<span id="satf-user-badge" style="font-weight:700;"></span>
			</div>
		</div>
		`;

		const launcher = root.getElementById("satf-launcher");
		const panel = root.getElementById("satf-panel");
		const statusText = root.getElementById("satf-status-text");
		const userBadge = root.getElementById("satf-user-badge");
		const btnClose = root.getElementById("satf-btn-close");
		const travelLock = root.getElementById("satf-travel-lock");
		const warLead = root.getElementById("satf-war-lead");
		const scoreSa = root.getElementById("satf-score-sa");
		const scoreTarget = root.getElementById("satf-score-target");
		const oppName = root.getElementById("satf-opp-name");
		const scoreOpp = root.getElementById("satf-score-opp");
		const warTitle = root.getElementById("satf-war-title");
		const hospContainer = root.getElementById("satf-hosp-container");
		const chkDirect = root.getElementById("satf-chk-direct");
		const btnModalNext = root.getElementById("satf-btn-modal-next");
		const chkHideHighFf = root.getElementById("satf-chk-hide-high-ff");
		const inputHideFf = root.getElementById("satf-input-hide-ff");
		const chkHideHighBs = root.getElementById("satf-chk-hide-high-bs");
		const inputHideBs = root.getElementById("satf-input-hide-bs");
		const chkPersistOpen = root.getElementById("satf-chk-persist-open");
		const ignoredCount = root.getElementById("satf-ignored-count");
		const availList = root.getElementById("satf-avail-list");
		const availCount = root.getElementById("satf-avail-count");
		const authConnectedBox = root.getElementById("satf-auth-connected");
		const authNameId = root.getElementById("satf-auth-name-id");
		const keyInputContainer = root.getElementById("satf-key-input-container");
		const btnToggleKeyInput = root.getElementById("satf-btn-toggle-key-input");

		chkDirect.checked = state.directAttack;
		chkHideHighFf.checked = state.hideHighFF;
		chkHideHighBs.checked = state.hideHighBS;
		chkPersistOpen.checked = state.persistOpen;

		function setStatus(text, type = "ok") {
			statusText.textContent = text;
			const statusBox = root.getElementById("satf-status");
			statusBox.className = `satf-status ${type}`;
		}

		function updateUserBadge() {
			if (state.user) {
				userBadge.textContent = `${state.user.tornName} [${state.user.tornId}]`;
				authConnectedBox.style.display = "block";
				authNameId.textContent = `${state.user.tornName} [${state.user.tornId}]`;
				keyInputContainer.style.display = "none";
			} else {
				userBadge.textContent = "Not Connected";
				authConnectedBox.style.display = "none";
				keyInputContainer.style.display = "block";
			}
		}

		function updateTravelLock() {
			const flightState = detectAttackerFlightState();
			if (flightState !== "okay") {
				travelLock.style.display = "block";
				travelLock.textContent =
					flightState === "traveling"
						? "[FLIGHT LOCK] Attacker is traveling. Target dispatch locked until arrival."
						: "[ABROAD LOCK] Attacker is abroad. Target dispatch locked until return to Torn.";
			} else {
				travelLock.style.display = "none";
			}
		}

		function renderWarBanner(war) {
			if (!war || war.state === "no_war") {
				warTitle.textContent = "STANDBY · NO ACTIVE WAR";
				warLead.style.display = "none";
				scoreSa.textContent = "--";
				scoreTarget.textContent = "--";
				scoreTarget.style.color = "var(--muted)";
				oppName.textContent = "Opponent";
				scoreOpp.textContent = "--";

				// Clear local targets and storage when war ends
				state.allTargets = [];
				state.availableTargets = [];
				state.hospitalQueue = [];
				state.warOpponentIds = [];
				try {
					GM_setValue(STORAGE.cachedTargets, []);
					GM_setValue(STORAGE.warOpponentIds, []);
				} catch {}
				renderAvailableTargets([]);
				renderHospitalQueue([]);
				return;
			}

			if (war.state === "scheduled") {
				const nowSec = Math.floor(Date.now() / 1000);
				const remaining = Math.max(0, (war.start || nowSec) - nowSec);
				warTitle.textContent = `STARTS IN ${formatSeconds(remaining)}`;
				warLead.style.display = "none";
				scoreSa.textContent = "0";
				scoreTarget.textContent = war.target
					? Number(war.target).toLocaleString()
					: "--";
				scoreTarget.style.color = war.target ? "var(--text)" : "var(--muted)";
				oppName.textContent = war.opponent ? war.opponent.name : "Opponent";
				scoreOpp.textContent = "0";
				return;
			}

			if (war.state === "active") {
				warTitle.textContent = "RANKED WAR ACTIVE";
				warLead.style.display = "inline-block";

				const saScore = war.subversive ? war.subversive.score : 0;
				const oppScore = war.opponent ? war.opponent.score : 0;
				const lead = saScore - oppScore;

				if (lead >= 0) {
					warLead.textContent = `LEAD +${lead.toLocaleString()}`;
					warLead.className = "satf-lead-badge lead-pos";
				} else {
					warLead.textContent = `DEFICIT ${lead.toLocaleString()}`;
					warLead.className = "satf-lead-badge lead-neg";
				}

				scoreSa.textContent = saScore.toLocaleString();
				scoreTarget.textContent = war.target
					? Number(war.target).toLocaleString()
					: "--";
				scoreTarget.style.color = war.target ? "var(--text)" : "var(--muted)";
				oppName.textContent = war.opponent ? war.opponent.name : "Opponent";
				scoreOpp.textContent = oppScore.toLocaleString();
			}
		}

		function updateSortPillVisuals() {
			root.querySelectorAll(".satf-sort-pill").forEach((p) => {
				const sortField = p.dataset.sort;
				const isActive = sortField === state.targetSortBy;
				p.classList.toggle("active", isActive);
				const baseLabel =
					sortField === "ff" ? "FF" : sortField === "online" ? "Online" : "BS";
				if (isActive) {
					const arrow = state.targetSortOrder === "asc" ? " ↑" : " ↓";
					p.textContent = `${baseLabel}${arrow}`;
				} else {
					p.textContent = baseLabel;
				}
			});
		}

		function renderAvailableTargets(targets) {
			if (Array.isArray(targets)) {
				state.allTargets = targets;
				try {
					GM_setValue(STORAGE.cachedTargets, targets);
				} catch {}
			}

			if (!isWarEngaged()) {
				state.availableTargets = [];
				availCount.textContent = "0";
				availList.innerHTML = `
					<div style="text-align: center; padding: 16px 0; color: var(--muted); font-size: 11px;">
						No active or scheduled ranked war. Opponent tracking on standby.
					</div>
				`;
				return;
			}

			const source = state.allTargets || [];
			state.availableTargets = source.filter((t) => {
				if (state.ignoredTargets.includes(t.id)) return false;
				if (state.hideHighFF && t.fairFight > state.maxFFThreshold)
					return false;
				if (state.hideHighBS && t.estimatedBs > state.maxBSThreshold)
					return false;
				if (t.statusCategory === "early_discharge" || t.hasEarlyDischarge)
					return false;
				const st = (t.status?.state || "").toLowerCase();
				if (st === "hospital") return false;
				return true;
			});
			availCount.textContent = String(state.availableTargets.length);

			if (state.availableTargets.length === 0) {
				const activeFilters = [];
				if (state.hideHighFF)
					activeFilters.push(`FF <= ${state.maxFFThreshold.toFixed(1)}`);
				if (state.hideHighBS)
					activeFilters.push(`BS <= ${formatStats(state.maxBSThreshold)}`);
				const filterDesc =
					activeFilters.length > 0
						? ` (within ${activeFilters.join(" & ")})`
						: "";
				availList.innerHTML = `
					<div style="text-align: center; padding: 16px 0; color: var(--muted); font-size: 11px;">
						No opponents currently ready${filterDesc}. Check Hospital Queue.
					</div>
				`;
				return;
			}

			const sorted = [...state.availableTargets];
			const multiplier = state.targetSortOrder === "asc" ? 1 : -1;
			if (state.targetSortBy === "ff") {
				sorted.sort((a, b) => (a.fairFight - b.fairFight) * multiplier);
			} else if (state.targetSortBy === "online") {
				sorted.sort(
					(a, b) => ((a.isOnline ? 1 : 0) - (b.isOnline ? 1 : 0)) * multiplier,
				);
			} else if (state.targetSortBy === "bs") {
				sorted.sort((a, b) => (a.estimatedBs - b.estimatedBs) * multiplier);
			}

			availList.innerHTML = sorted
				.map((t) => {
					const onlineDot = t.isOnline
						? `<span class="satf-dot-online"></span>`
						: "";

					return `
						<div class="satf-roster-row" data-id="${t.id}" data-url="${t.attackUrl}">
							<div class="satf-roster-left">
								<div class="satf-roster-name">
									${onlineDot}
									<span>${t.name}</span>
									<span style="color:var(--muted); font-size:11px;">[${t.id}]</span>
								</div>
								<div class="satf-roster-sub">
									Lvl ${t.level} · BS ${formatStats(t.estimatedBs)}
								</div>
							</div>
							<div class="satf-roster-right">
								<span class="satf-ff-badge ff-${getFFTier(t.fairFight)}" style="font-size:12px; color:${getFFColor(t.fairFight)};">FF: ${t.fairFight.toFixed(2)}</span>
								<a class="satf-btn satf-btn-primary satf-btn-sm" href="${t.attackUrl}" target="_blank" style="text-decoration:none;">Hit</a>
							</div>
						</div>
					`;
				})
				.join("");

			availList.querySelectorAll(".satf-roster-row").forEach((row) => {
				row.addEventListener("click", (e) => {
					const id = Number.parseInt(row.getAttribute("data-id") || "", 10);
					const targetObj = state.availableTargets.find((t) => t.id === id);
					if (!targetObj) return;

					if (state.directAttack) {
						window.location.href = targetObj.attackUrl;
						return;
					}

					if (e.target && !e.target.closest("a")) {
						window.open(
							`https://www.torn.com/profiles.php?XID=${targetObj.id}`,
							"_blank",
						);
					}
				});
			});
		}

		async function fetchAvailableTargets() {
			if (!state.token) return;
			try {
				const params = new URLSearchParams({
					maxFF: state.hideHighFF ? String(state.maxFFThreshold) : "10.0",
				});
				if (state.hideHighBS) {
					params.set("maxBS", String(state.maxBSThreshold));
				}
				const res = await apiRequest(
					`/api/v1/target-finder/war/targets/available?${params.toString()}`,
				);
				if (res?.war) {
					state.war = res.war;
					state.warState = res.war.state;
					try {
						GM_setValue(STORAGE.warState, res.war.state);
					} catch {}
					renderWarBanner(res.war);
				}
				if (Array.isArray(res?.targets)) {
					renderAvailableTargets(res.targets);
				}
			} catch (err) {
				console.debug(
					"[Subversive Alliance] Failed to fetch available targets:",
					err.message,
				);
			}
		}

		async function fetchWarStatus() {
			if (!state.token) return;
			try {
				const res = await apiRequest("/api/v1/target-finder/war/status");
				if (res?.war) {
					state.war = res.war;
					state.warState = res.war.state;
					try {
						GM_setValue(STORAGE.warState, res.war.state);
					} catch {}
					renderWarBanner(res.war);
				}
				if (Array.isArray(res?.opponentIds)) {
					state.warOpponentIds = res.opponentIds;
					try {
						GM_setValue(STORAGE.warOpponentIds, res.opponentIds);
					} catch {}
				}
			} catch (err) {
				console.debug(
					"[Subversive Alliance] Failed to fetch war status:",
					err.message,
				);
			}
		}

		async function fetchNextTarget(options = { directLaunch: false }) {
			if (!state.token) {
				switchTab("settings");
				setStatus("Enter Torn API Key in Settings to connect.", "error");
				return;
			}

			const flightState = detectAttackerFlightState();
			if (flightState !== "okay") {
				updateTravelLock();
				setStatus("Target dispatch locked while traveling or abroad.", "error");
				return;
			}

			if (!isWarEngaged()) {
				setStatus("No active or scheduled ranked war.", "error");
				return;
			}

			setStatus("Acquiring optimal war target...", "ok");

			// 1. Try local sorted & filtered candidates matching active target list settings
			const candidate = getNextTargetCandidate();
			if (candidate) {
				state.currentTarget = candidate;
				GM_setValue(STORAGE.currentTarget, candidate);
				state.excludeIds.push(candidate.id);
				renderAvailableTargets();
				setStatus(
					`Target acquired · ${candidate.name} [${candidate.id}] · FF: ${candidate.fairFight.toFixed(2)}`,
					"ok",
				);
				if (options.directLaunch || state.directAttack) {
					window.location.href = candidate.attackUrl;
				} else {
					window.open(
						`https://www.torn.com/profiles.php?XID=${candidate.id}`,
						"_blank",
					);
				}
				return;
			}

			// 2. Query backend war target dispatch with matching maxFF/maxBS filter
			try {
				const combinedExcludes = Array.from(
					new Set([...state.excludeIds.slice(-20), ...state.ignoredTargets]),
				);

				const params = new URLSearchParams({
					exclude: combinedExcludes.join(","),
					attackerState: flightState,
					maxFF: state.hideHighFF ? String(state.maxFFThreshold) : "10.0",
				});
				if (state.hideHighBS) {
					params.set("maxBS", String(state.maxBSThreshold));
				}

				const res = await apiRequest(
					`/api/v1/target-finder/war/targets/next?${params.toString()}`,
				);

				if (res.war) {
					state.war = res.war;
					renderWarBanner(res.war);
				}

				if (res.target) {
					if (state.hideHighFF && res.target.fairFight > state.maxFFThreshold) {
						setStatus(
							`No opponents available within FF <= ${state.maxFFThreshold.toFixed(1)}`,
							"error",
						);
						return;
					}
					if (
						state.hideHighBS &&
						res.target.estimatedBs > state.maxBSThreshold
					) {
						setStatus(
							`No opponents available within BS <= ${formatStats(state.maxBSThreshold)}`,
							"error",
						);
						return;
					}
					state.currentTarget = res.target;
					GM_setValue(STORAGE.currentTarget, res.target);
					state.excludeIds.push(res.target.id);
					renderAvailableTargets();
					setStatus(
						`Target acquired · ${res.target.name} [${res.target.id}] · FF: ${res.target.fairFight.toFixed(2)}`,
						"ok",
					);

					if (options.directLaunch || state.directAttack) {
						window.location.href = res.target.attackUrl;
					} else {
						window.open(
							`https://www.torn.com/profiles.php?XID=${res.target.id}`,
							"_blank",
						);
					}
				} else {
					setStatus(
						res.message || res.reason || "No targets available.",
						"error",
					);
				}
			} catch (err) {
				if (err?.data?.war) {
					state.war = err.data.war;
					renderWarBanner(err.data.war);
				}
				setStatus(err.message, "error");
			} finally {
				updateTravelLock();
			}
		}

		// Client-side Live Hospital Queue Countdown
		function updateHospCountdowns() {
			const nowSec = Math.floor(Date.now() / 1000);
			const rows = hospContainer.querySelectorAll(".satf-queue-row");
			rows.forEach((row) => {
				const until = Number.parseInt(row.getAttribute("data-until"), 10);
				const timeElem = row.querySelector(".satf-queue-time");
				if (!timeElem || Number.isNaN(until)) return;

				const remaining = Math.max(0, until - nowSec);
				if (remaining > 0) {
					timeElem.textContent = formatSeconds(remaining);
					timeElem.classList.remove("ready");
				} else {
					timeElem.textContent = "READY";
					timeElem.classList.add("ready");
				}
			});
		}

		function startHospTimer() {
			stopHospTimer();
			state.hospTimer = setInterval(updateHospCountdowns, 1000);
		}

		function stopHospTimer() {
			if (state.hospTimer) {
				clearInterval(state.hospTimer);
				state.hospTimer = null;
			}
		}

		function renderHospitalQueue(queue = []) {
			if (!isWarEngaged()) {
				state.hospitalQueue = [];
				hospContainer.innerHTML = `
					<div style="text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px;">
						No active or scheduled ranked war. Hospital queue on standby.
					</div>
				`;
				stopHospTimer();
				return;
			}

			const nowSec = Math.floor(Date.now() / 1000);
			state.hospitalQueue = queue.map((item) => {
				const ff =
					typeof item.fairFight === "number" && !Number.isNaN(item.fairFight)
						? item.fairFight
						: 1.0;
				return {
					...item,
					fairFight: ff,
					until:
						item.status?.until ||
						nowSec + Math.max(0, item.secondsRemaining || 0),
				};
			});

			if (state.hospitalQueue.length === 0) {
				hospContainer.innerHTML = `
					<div style="text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px;">
						No opponents currently in hospital.
					</div>
				`;
				stopHospTimer();
				return;
			}

			hospContainer.innerHTML = state.hospitalQueue
				.map((item) => {
					const dischargePill = item.hasEarlyDischarge
						? `<span class="satf-badge-pill status-discharge">[DISCHARGE]</span>`
						: "";
					const remaining = Math.max(0, item.until - nowSec);

					return `
						<div class="satf-queue-row" data-id="${item.id}" data-until="${item.until}">
							<div class="satf-roster-left">
								<div class="satf-roster-name">
									<span style="font-weight:700;">${item.name}</span>
									<span style="color:var(--muted); font-size:11px;">[${item.id}] Lvl ${item.level}</span>
									${dischargePill}
								</div>
								<div class="satf-roster-sub">
									BS ${formatStats(item.estimatedBs)} · <span class="ff-${getFFTier(item.fairFight)}" style="font-weight:700; color:${getFFColor(item.fairFight)};">FF: ${item.fairFight.toFixed(2)}</span>
								</div>
							</div>
							<div class="satf-queue-time ${remaining === 0 ? "ready" : ""}">${remaining === 0 ? "READY" : formatSeconds(remaining)}</div>
						</div>
					`;
				})
				.join("");

			hospContainer.querySelectorAll(".satf-queue-row").forEach((row) => {
				row.addEventListener("click", () => {
					const id = row.getAttribute("data-id");
					if (id) {
						window.open(
							`https://www.torn.com/profiles.php?XID=${id}`,
							"_blank",
						);
					}
				});
			});

			startHospTimer();
		}

		async function fetchHospitalQueue() {
			if (!state.token) return;

			if (!isWarEngaged()) {
				renderHospitalQueue([]);
				return;
			}

			try {
				const res = await apiRequest(
					"/api/v1/target-finder/war/hospital-queue?limit=25",
				);
				renderHospitalQueue(res.queue || []);
			} catch (err) {
				hospContainer.innerHTML = `
					<div style="text-align: center; padding: 20px 0; color: var(--danger); font-size: 12px;">
						Failed to load queue: ${err.message}
					</div>
				`;
				stopHospTimer();
			}
		}

		// ─── WEBSOCKET LIVE STREAM ──────────────────────────────────────────
		function connectWebSocket() {
			if (state.ws || !state.token) return;

			try {
				const wsProto = state.apiUrl.startsWith("https") ? "wss://" : "ws://";
				const cleanHost = state.apiUrl.replace(/^https?:\/\//, "");
				const wsUrl = `${wsProto}${cleanHost}/api/ws/subversive-war?token=${encodeURIComponent(state.token)}`;

				const socket = new WebSocket(wsUrl);
				state.ws = socket;

				socket.onopen = () => {
					setStatus("Live (Connected)", "ok");
				};

				socket.onmessage = (event) => {
					try {
						const data = JSON.parse(event.data);
						if (data.war) {
							state.war = data.war;
							state.warState = data.war.state;
							try {
								GM_setValue(STORAGE.warState, data.war.state);
							} catch {}
							renderWarBanner(data.war);
						}
						if (Array.isArray(data.opponentIds)) {
							state.warOpponentIds = data.opponentIds;
							try {
								GM_setValue(STORAGE.warOpponentIds, data.opponentIds);
							} catch {}
						}
						if (Array.isArray(data.targets)) {
							renderAvailableTargets(data.targets);
						}
						if (Array.isArray(data.hospitalQueue)) {
							renderHospitalQueue(data.hospitalQueue);
						}
					} catch {
						// Ignored parsing error
					}
				};

				socket.onerror = () => {
					console.debug(
						"[Subversive Alliance] WebSocket stream unavailable, running on HTTP sync mode",
					);
				};

				socket.onclose = () => {
					state.ws = null;
				};
			} catch {
				state.ws = null;
			}
		}

		function disconnectWebSocket() {
			if (state.ws) {
				try {
					state.ws.close();
				} catch {}
				state.ws = null;
			}
		}

		async function handleAuth() {
			const keyInput = root.getElementById("satf-input-key");
			const apiKey = keyInput.value.trim();
			if (!apiKey) {
				setStatus("Please enter a valid API key.", "error");
				return;
			}

			setStatus("Connecting API key...", "ok");
			try {
				const res = await apiRequest("/api/v1/target-finder/auth", {
					method: "POST",
					body: { apiKey },
				});

				state.token = res.token;
				state.user = res.user;
				GM_setValue(STORAGE.token, state.token);
				GM_setValue(STORAGE.user, state.user);

				keyInput.value = "";
				updateUserBadge();
				setStatus("Connected! Ready for Ranked War.", "ok");
				switchTab("target");
				connectWebSocket();
				fetchWarStatus();
				fetchAvailableTargets();
			} catch (err) {
				setStatus(err.message, "error");
			}
		}

		function switchTab(tab) {
			state.activeTab = tab;
			GM_setValue(STORAGE.activeTab, tab);
			root.querySelectorAll(".satf-tab-btn").forEach((btn) => {
				btn.classList.toggle("active", btn.dataset.tab === tab);
			});
			root.getElementById("satf-view-target").style.display =
				tab === "target" ? "block" : "none";
			root.getElementById("satf-view-hosp").style.display =
				tab === "hosp" ? "block" : "none";
			root.getElementById("satf-view-settings").style.display =
				tab === "settings" ? "block" : "none";

			if (tab === "target") {
				renderAvailableTargets();
				fetchAvailableTargets();
				stopHospTimer();
			} else if (tab === "hosp") {
				fetchHospitalQueue();
			} else {
				stopHospTimer();
			}
		}

		// Drag & Drop
		let isDragging = false;
		let dragStartX = 0;
		let dragStartY = 0;
		let initialLeft = 0;
		let initialTop = 0;

		const savedPos = GM_getValue(STORAGE.position, null);
		if (savedPos) {
			launcher.style.left = `${savedPos.x}px`;
			launcher.style.top = `${savedPos.y}px`;
		}

		function positionPanel() {
			const isMobile = window.innerWidth <= 480;
			if (isMobile) {
				panel.style.left = "12px";
				panel.style.right = "12px";
				panel.style.width = "calc(100vw - 24px)";
				panel.style.top = "12px";
				return;
			}
			panel.style.right = "";
			panel.style.width = "430px";
			const rect = launcher.getBoundingClientRect();
			let launcherX = rect.left;
			let launcherY = rect.top;
			if ((!launcherX && !launcherY) || (launcherX === 0 && launcherY === 0)) {
				const saved = GM_getValue(STORAGE.position, null);
				if (saved && typeof saved.x === "number") {
					launcherX = saved.x;
					launcherY = saved.y;
				} else {
					launcherX = Math.max(10, window.innerWidth - 64);
					launcherY = Math.max(10, window.innerHeight - 84);
				}
			}
			let left = launcherX - 440;
			let top = launcherY;
			if (left < 10) left = (rect.right > 0 ? rect.right : launcherX + 48) + 10;
			if (left + 440 > window.innerWidth)
				left = Math.max(10, window.innerWidth - 442);
			if (top + 500 > window.innerHeight)
				top = Math.max(10, window.innerHeight - 510);
			if (top < 10) top = 10;
			panel.style.left = `${left}px`;
			panel.style.top = `${top}px`;
		}

		function updateWarCountdown() {
			if (state.war && state.war.state === "scheduled") {
				const nowSec = Math.floor(Date.now() / 1000);
				const remaining = Math.max(0, (state.war.start || nowSec) - nowSec);
				if (remaining > 0) {
					warTitle.textContent = `STARTS IN ${formatSeconds(remaining)}`;
				} else {
					warTitle.textContent = "STARTING...";
					fetchWarStatus();
				}
			}
		}

		function stopCountdownTimer() {
			if (state.countdownTimer) {
				clearInterval(state.countdownTimer);
				state.countdownTimer = null;
			}
		}

		function startAutoSync() {
			stopAutoSync();
			state.syncTimer = setInterval(() => {
				if (!state.panelOpen) return;
				fetchWarStatus();
				if (state.activeTab === "target") {
					fetchAvailableTargets();
				} else if (state.activeTab === "hosp") {
					fetchHospitalQueue();
				}
			}, 3000);

			stopCountdownTimer();
			state.countdownTimer = setInterval(() => {
				if (!state.panelOpen) return;
				updateWarCountdown();
			}, 1000);
		}

		function stopAutoSync() {
			if (state.syncTimer) {
				clearInterval(state.syncTimer);
				state.syncTimer = null;
			}
			stopCountdownTimer();
		}

		function openPanel() {
			state.panelOpen = true;
			panel.classList.add("open");
			if (state.persistOpen) {
				GM_setValue(STORAGE.panelOpen, true);
			} else {
				GM_setValue(STORAGE.panelOpen, false);
			}
			positionPanel();
			updateTravelLock();
			connectWebSocket();
			fetchWarStatus();
			renderAvailableTargets();
			switchTab(state.activeTab || "target");
			startAutoSync();
		}

		function closePanel() {
			state.panelOpen = false;
			panel.classList.remove("open");
			GM_setValue(STORAGE.panelOpen, false);
			stopHospTimer();
			stopAutoSync();
			disconnectWebSocket();
		}

		launcher.addEventListener("pointerdown", (e) => {
			isDragging = false;
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			const rect = launcher.getBoundingClientRect();
			initialLeft = rect.left;
			initialTop = rect.top;

			const onMove = (moveEvt) => {
				const dx = moveEvt.clientX - dragStartX;
				const dy = moveEvt.clientY - dragStartY;
				if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDragging = true;
				launcher.style.left = `${initialLeft + dx}px`;
				launcher.style.top = `${initialTop + dy}px`;
				if (state.panelOpen) {
					positionPanel();
				}
			};

			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				if (isDragging) {
					const finalRect = launcher.getBoundingClientRect();
					GM_setValue(STORAGE.position, {
						x: finalRect.left,
						y: finalRect.top,
					});
					if (state.panelOpen) {
						positionPanel();
					}
				} else {
					if (state.panelOpen) {
						closePanel();
					} else {
						openPanel();
					}
				}
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		});

		btnClose.addEventListener("click", closePanel);

		// Events
		root.querySelectorAll(".satf-tab-btn").forEach((btn) => {
			btn.addEventListener("click", () => switchTab(btn.dataset.tab));
		});

		updateSortPillVisuals();

		root.querySelectorAll(".satf-sort-pill").forEach((pill) => {
			pill.addEventListener("click", () => {
				const sortField = pill.dataset.sort || "ff";
				if (state.targetSortBy === sortField) {
					state.targetSortOrder =
						state.targetSortOrder === "asc" ? "desc" : "asc";
				} else {
					state.targetSortBy = sortField;
					state.targetSortOrder = "desc";
				}
				GM_setValue(STORAGE.targetSortBy, state.targetSortBy);
				GM_setValue(STORAGE.targetSortOrder, state.targetSortOrder);
				updateSortPillVisuals();
				renderAvailableTargets();
			});
		});

		chkDirect.addEventListener("change", (e) => {
			state.directAttack = e.target.checked;
			GM_setValue(STORAGE.directAttack, state.directAttack);
		});

		btnModalNext?.addEventListener("click", () => {
			fetchNextTarget({ directLaunch: state.directAttack });
		});

		chkHideHighFf.addEventListener("change", (e) => {
			state.hideHighFF = e.target.checked;
			GM_setValue(STORAGE.hideHighFF, state.hideHighFF);
			renderAvailableTargets();
		});

		inputHideFf?.addEventListener("change", (e) => {
			const val = Number.parseFloat(e.target.value) || 3.0;
			state.maxFFThreshold = Math.max(1.0, val);
			GM_setValue(STORAGE.maxFFThreshold, state.maxFFThreshold);
			renderAvailableTargets();
		});

		chkHideHighBs.addEventListener("change", (e) => {
			state.hideHighBS = e.target.checked;
			GM_setValue(STORAGE.hideHighBS, state.hideHighBS);
			renderAvailableTargets();
		});

		function commitBsInput(targetElem) {
			const parsed = parseStatsInput(targetElem.value);
			if (parsed !== null) {
				state.maxBSThreshold = parsed;
				GM_setValue(STORAGE.maxBSThreshold, state.maxBSThreshold);
				targetElem.value = formatStats(parsed);
				targetElem.title = parsed.toLocaleString();
			} else {
				targetElem.value = formatStats(state.maxBSThreshold);
			}
			renderAvailableTargets();
		}

		inputHideBs?.addEventListener("change", (e) => {
			commitBsInput(e.target);
		});

		inputHideBs?.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commitBsInput(e.target);
				e.target.blur();
			}
		});

		chkPersistOpen.addEventListener("change", (e) => {
			state.persistOpen = e.target.checked;
			GM_setValue(STORAGE.persistOpen, state.persistOpen);
			if (state.persistOpen) {
				GM_setValue(STORAGE.panelOpen, state.panelOpen);
			} else {
				GM_setValue(STORAGE.panelOpen, false);
			}
		});

		root
			.getElementById("satf-btn-clear-ignored")
			.addEventListener("click", () => {
				state.ignoredTargets = [];
				GM_setValue(STORAGE.ignoredTargets, []);
				ignoredCount.textContent = "0 ignored targets";
				renderAvailableTargets();
				setStatus("Cleared ignored targets blacklist.", "ok");
			});

		btnToggleKeyInput.addEventListener("click", () => {
			const isVisible = keyInputContainer.style.display !== "none";
			keyInputContainer.style.display = isVisible ? "none" : "block";
			if (!isVisible) {
				const keyInput = root.getElementById("satf-input-key");
				keyInput?.focus();
			}
		});

		root.getElementById("satf-btn-auth").addEventListener("click", handleAuth);

		root
			.getElementById("satf-btn-refresh-stats")
			.addEventListener("click", async () => {
				if (!state.token) return;
				setStatus("Refreshing battle stats...", "ok");
				try {
					const res = await apiRequest("/api/v1/target-finder/refresh-stats", {
						method: "POST",
					});
					if (state.user) {
						state.user.bsScore = res.bsScore;
						GM_setValue(STORAGE.user, state.user);
						updateUserBadge();
					}
					setStatus("Battle stats refreshed.", "ok");
				} catch (err) {
					setStatus(err.message, "error");
				}
			});

		root.getElementById("satf-btn-logout").addEventListener("click", () => {
			state.token = "";
			state.user = null;
			state.currentTarget = null;
			GM_setValue(STORAGE.token, "");
			GM_setValue(STORAGE.user, null);
			disconnectWebSocket();
			updateUserBadge();
			renderAvailableTargets([]);
			setStatus("Logged out. Please connect your API key.", "ok");
		});

		updateUserBadge();
		updateTravelLock();

		// Immediately populate cached targets
		renderAvailableTargets();

		// Auto-open if remember open window is enabled AND panel was open on last page
		if (state.persistOpen && state.panelOpen) {
			openPanel();
			requestAnimationFrame(positionPanel);
			setTimeout(positionPanel, 50);
			setTimeout(positionPanel, 200);
			setTimeout(positionPanel, 600);
		}

		window.addEventListener("resize", () => {
			if (state.panelOpen) {
				positionPanel();
			}
		});

		if (state.token) {
			setStatus("Connected", "ok");
			fetchWarStatus();
			if (state.panelOpen) {
				connectWebSocket();
			}
		} else {
			setStatus("Not connected. Enter key in Settings.", "error");
		}
	}

	// ─── IN-PAGE ATTACK HUD (Shown on Torn Attack Page for Ranked War Targets Only)
	function initAttackPageHud() {
		const href = window.location.href;
		const isAttackPage =
			/sid=(attack|getInAttack)/i.test(href) ||
			/page=attack/i.test(href) ||
			href.includes("loader.php?sid=attack") ||
			href.includes("loader2.php?sid=attack") ||
			href.includes("page.php?sid=attack");

		const existingHost = document.getElementById("satf-attack-hud-host");

		if (!isAttackPage) {
			if (existingHost) existingHost.remove();
			return;
		}

		const match = href.match(/[?&#]user2id=(\d+)/i);
		const user2Id = match ? Number.parseInt(match[1], 10) : 0;
		const token = state.token || GM_getValue(STORAGE.token, "");

		if (!user2Id || !token) {
			if (existingHost) existingHost.remove();
			return;
		}

		// Clean up host if attached to a different target
		if (existingHost && existingHost.dataset.targetId !== String(user2Id)) {
			existingHost.remove();
		}

		function isKnownWarTarget(id) {
			if (!isWarEngaged()) {
				return false;
			}

			// 1. Check cached opponent IDs from backend
			if (
				Array.isArray(state.warOpponentIds) &&
				state.warOpponentIds.includes(id)
			) {
				return true;
			}

			// 2. Check currentTarget in memory or GM storage
			const curTarget =
				(state.currentTarget && state.currentTarget.id === id
					? state.currentTarget
					: null) || GM_getValue(STORAGE.currentTarget, null);
			if (curTarget && curTarget.id === id && curTarget.isWarTarget !== false) {
				return true;
			}

			// 3. Check client war target list or hospital queue
			const inAvailable = (state.allTargets || []).some(
				(t) => t.id === id && t.isWarTarget !== false,
			);
			const inHosp = (state.hospitalQueue || []).some((t) => t.id === id);
			if (inAvailable || inHosp) {
				return true;
			}

			// 4. Check Torn DOM: If defender faction link matches opponent faction ID
			if (state.war?.opponent?.id) {
				const oppFacId = String(state.war.opponent.id);
				const factionLink = document.querySelector(
					`a[href*="factions.php?step=profile&ID=${oppFacId}"], a[href*="factions.php?step=profile&id=${oppFacId}"]`,
				);
				if (factionLink) return true;
			}

			return false;
		}

		function applyHudDetails(hudRoot, t) {
			if (!t || !hudRoot) return;
			const hudName = hudRoot.getElementById("satf-hud-name");
			const hudBs = hudRoot.getElementById("satf-hud-bs");
			const hudFf = hudRoot.getElementById("satf-hud-ff");
			if (hudName) {
				hudName.textContent = t.name
					? `${t.name} [${user2Id}]`
					: `[${user2Id}]`;
			}
			if (hudBs) {
				hudBs.textContent = formatStats(t.estimatedBs);
			}
			if (hudFf && typeof t.fairFight === "number") {
				hudFf.textContent = t.fairFight.toFixed(2);
				hudFf.style.color = getFFColor(t.fairFight);
			}
		}

		function mountHud(initialData) {
			let host = document.getElementById("satf-attack-hud-host");
			if (host) {
				if (host.dataset.targetId === String(user2Id)) {
					if (initialData && host.shadowRoot) {
						applyHudDetails(host.shadowRoot, initialData);
					}
					return host;
				}
				host.remove();
			}

			host = document.createElement("div");
			host.id = "satf-attack-hud-host";
			host.dataset.targetId = String(user2Id);
			(document.body || document.documentElement).appendChild(host);
			const hudRoot = host.attachShadow({ mode: "open" });

			hudRoot.innerHTML = `
			<style>
				:host {
					all: initial;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
				}
				#satf-attack-bar {
					position: fixed;
					top: 10px;
					left: 50%;
					transform: translateX(-50%);
					z-index: 2147483647 !important;
					background: rgba(15, 15, 18, 0.96);
					backdrop-filter: blur(14px);
					border: 1px solid #27272a;
					border-radius: 12px;
					padding: 6px 14px;
					display: flex;
					align-items: center;
					justify-content: center;
					flex-wrap: wrap;
					gap: 8px 12px;
					max-width: calc(100vw - 20px);
					color: #f4f4f5;
					box-shadow: 0 8px 30px rgba(0,0,0,0.8);
					font-size: 12px;
					pointer-events: auto;
				}
				.satf-hud-badge {
					font-weight: 800;
					color: #10b981;
					font-size: 11px;
					letter-spacing: 0.5px;
				}
				.satf-hud-stat {
					display: flex;
					align-items: center;
					gap: 6px;
				}
				.satf-hud-val {
					font-weight: 800;
					color: #fff;
				}
				.satf-hud-ff {
					font-weight: 800;
					color: #f4f4f5;
				}
				.ff-white { color: #f4f4f5 !important; }
				.ff-green { color: #10b981 !important; }
				.ff-blue { color: #3b82f6 !important; }
				.ff-yellow { color: #eab308 !important; }
				.ff-red { color: #ef4444 !important; }
				.satf-hud-btn {
					background: #27272a;
					border: 1px solid #3f3f46;
					color: #fff;
					border-radius: 6px;
					padding: 4px 8px;
					font-size: 11px;
					font-weight: 700;
					cursor: pointer;
					transition: all 0.15s;
				}
				.satf-hud-btn:hover {
					background: #3f3f46;
					border-color: #10b981;
				}
				.satf-hud-btn-danger:hover {
					border-color: #ef4444;
					color: #f87171;
				}
			</style>
			<div id="satf-attack-bar">
				<span class="satf-hud-badge">[SA]</span>
				<div class="satf-hud-stat">
					<span id="satf-hud-name" class="satf-hud-val">${user2Id}</span>
				</div>
				<div class="satf-hud-stat">
					<span style="color:#a1a1aa;">BS:</span>
					<span id="satf-hud-bs" class="satf-hud-val">Loading...</span>
				</div>
				<div class="satf-hud-stat">
					<span style="color:#a1a1aa;">FF:</span>
					<span id="satf-hud-ff" class="satf-hud-ff">--</span>
				</div>
				<button id="satf-hud-ignore" class="satf-hud-btn satf-hud-btn-danger" title="Ignore target and get next">Ignore</button>
				<button id="satf-hud-next" class="satf-hud-btn">Next Target</button>
			</div>
			`;

			const btnHudIgnore = hudRoot.getElementById("satf-hud-ignore");
			const btnHudNext = hudRoot.getElementById("satf-hud-next");

			btnHudIgnore?.addEventListener("click", () => {
				if (!state.ignoredTargets.includes(user2Id)) {
					state.ignoredTargets.push(user2Id);
					GM_setValue(STORAGE.ignoredTargets, state.ignoredTargets);
				}
				loadNextTargetDirectly(hudRoot);
			});

			btnHudNext?.addEventListener("click", () => {
				loadNextTargetDirectly(hudRoot);
			});

			if (initialData) {
				applyHudDetails(hudRoot, initialData);
			}
			return host;
		}

		// 1. Instant check: Only mount immediately if target is known to be in active RW
		const isKnown = isKnownWarTarget(user2Id);
		if (isKnown) {
			const currentTarget =
				(state.currentTarget && state.currentTarget.id === user2Id
					? state.currentTarget
					: null) ||
				GM_getValue(STORAGE.currentTarget, null) ||
				(state.allTargets || []).find((t) => t.id === user2Id) ||
				(state.hospitalQueue || []).find((t) => t.id === user2Id);
			mountHud(
				currentTarget && currentTarget.id === user2Id ? currentTarget : null,
			);
		}

		// 2. Query backend for target intel & ranked war verification
		apiRequest(`/api/v1/target-finder/war/targets/${user2Id}`)
			.then((res) => {
				const isWarTarget =
					res?.isWarTarget === true || res?.target?.isWarTarget === true;

				if (isWarTarget) {
					// Add to known war opponent cache
					if (!state.warOpponentIds.includes(user2Id)) {
						state.warOpponentIds.push(user2Id);
						try {
							GM_setValue(STORAGE.warOpponentIds, state.warOpponentIds);
						} catch {}
					}

					const host = mountHud(res.target);
					if (res.target) {
						state.currentTarget = res.target;
						GM_setValue(STORAGE.currentTarget, res.target);
						if (host?.shadowRoot) {
							applyHudDetails(host.shadowRoot, res.target);
						}
					}
				} else {
					// Not in RW: Remove overhead display if present
					const host = document.getElementById("satf-attack-hud-host");
					if (host && host.dataset.targetId === String(user2Id)) {
						host.remove();
					}
				}
			})
			.catch(() => {
				const host = document.getElementById("satf-attack-hud-host");
				if (isKnown && host?.shadowRoot) {
					const hudBs = host.shadowRoot.getElementById("satf-hud-bs");
					if (hudBs && hudBs.textContent === "Loading...") {
						hudBs.textContent = "Unscouted";
					}
				} else if (
					!isKnown &&
					host &&
					host.dataset.targetId === String(user2Id)
				) {
					host.remove();
				}
			});

		async function loadNextTargetDirectly(hudRoot) {
			const btnHudNext = hudRoot?.getElementById("satf-hud-next");
			if (btnHudNext) {
				btnHudNext.textContent = "Loading...";
				btnHudNext.disabled = true;
			}
			try {
				// 1. First pick candidate from client target list respecting active sort & hideHighFF filter
				const candidate = getNextTargetCandidate(user2Id);
				if (candidate?.attackUrl) {
					state.currentTarget = candidate;
					GM_setValue(STORAGE.currentTarget, candidate);
					state.excludeIds.push(candidate.id);
					window.location.href = candidate.attackUrl;
					return;
				}

				// 2. Query backend war target dispatch with matching maxFF/maxBS filter
				const combinedExcludes = Array.from(
					new Set([
						...state.excludeIds.slice(-20),
						...state.ignoredTargets,
						user2Id,
					]),
				);
				const params = new URLSearchParams({
					exclude: combinedExcludes.join(","),
					maxFF: state.hideHighFF ? String(state.maxFFThreshold) : "10.0",
				});
				if (state.hideHighBS) {
					params.set("maxBS", String(state.maxBSThreshold));
				}
				const res = await apiRequest(
					`/api/v1/target-finder/war/targets/next?${params.toString()}`,
				);
				if (res.target?.attackUrl) {
					if (state.hideHighFF && res.target.fairFight > state.maxFFThreshold) {
						alert(
							`No opponents available within FF <= ${state.maxFFThreshold.toFixed(1)}`,
						);
						if (btnHudNext) {
							btnHudNext.textContent = "Next Target";
							btnHudNext.disabled = false;
						}
						return;
					}
					if (
						state.hideHighBS &&
						res.target.estimatedBs > state.maxBSThreshold
					) {
						alert(
							`No opponents available within BS <= ${formatStats(state.maxBSThreshold)}`,
						);
						if (btnHudNext) {
							btnHudNext.textContent = "Next Target";
							btnHudNext.disabled = false;
						}
						return;
					}
					state.currentTarget = res.target;
					GM_setValue(STORAGE.currentTarget, res.target);
					state.excludeIds.push(res.target.id);
					window.location.href = res.target.attackUrl;
				} else {
					alert(res.message || "No alternative war targets available.");
					if (btnHudNext) {
						btnHudNext.textContent = "Next Target";
						btnHudNext.disabled = false;
					}
				}
			} catch (err) {
				alert(`Failed to acquire next target: ${err.message}`);
				if (btnHudNext) {
					btnHudNext.textContent = "Next Target";
					btnHudNext.disabled = false;
				}
			}
		}
	}

	function boot() {
		if (!document.body) {
			window.addEventListener("DOMContentLoaded", boot, { once: true });
			return;
		}
		start();
		initAttackPageHud();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}

	// Periodic check for attack pages & SPA navigations
	window.addEventListener("popstate", initAttackPageHud);
	window.addEventListener("hashchange", initAttackPageHud);
	setInterval(initAttackPageHud, 800);
})();
