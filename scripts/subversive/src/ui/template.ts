import { state } from "../state";
import { formatMoney, formatStats } from "../utils/formatters";

export function getPanelHtml(): string {
	return `
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
				padding: 5px 6px;
				font-size: 11px;
				font-weight: 600;
				color: var(--muted);
				cursor: pointer;
				text-align: center;
				white-space: nowrap;
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

			/* Bounty finder styles */
			.satf-bounty-controls {
				display: flex;
				justify-content: space-between;
				align-items: center;
				margin-bottom: 10px;
				gap: 8px;
			}
			.satf-bounty-subtabs {
				display: flex;
				background: #09090b;
				padding: 2px;
				border-radius: 6px;
				border: 1px solid var(--border);
				gap: 2px;
			}
			.satf-bounty-subtab-btn {
				background: transparent;
				border: none;
				border-radius: 4px;
				padding: 3px 8px;
				font-size: 11px;
				font-weight: 600;
				color: var(--muted);
				cursor: pointer;
				transition: all 0.15s;
			}
			.satf-bounty-subtab-btn.active {
				background: var(--card);
				color: #fff;
				border: 1px solid var(--border);
			}
			.satf-bounty-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
				max-height: 400px;
				overflow-y: auto;
			}
			.satf-bounty-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 9px 12px;
				border-radius: 8px;
				background: var(--card);
				border: 1px solid var(--border);
				cursor: pointer;
				transition: background 0.15s, border-color 0.15s;
			}
			.satf-bounty-row:hover {
				background: var(--card-hover);
				border-color: #3f3f46;
			}
			.satf-bounty-left {
				display: flex;
				flex-direction: column;
				gap: 3px;
			}
			.satf-bounty-name-row {
				display: flex;
				align-items: center;
				gap: 6px;
				font-size: 13px;
				font-weight: 700;
				color: var(--text);
			}
			.satf-bounty-id {
				font-size: 11px;
				color: var(--muted);
				font-weight: 500;
			}
			.satf-bounty-sub {
				display: flex;
				align-items: center;
				gap: 8px;
				font-size: 11px;
				color: var(--muted);
			}
			.satf-bounty-right {
				display: flex;
				align-items: center;
				gap: 10px;
			}
			.satf-bounty-reward {
				font-size: 13px;
				font-weight: 800;
				color: #34d399;
			}
			.satf-bounty-hit-btn {
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
			.satf-bounty-hit-btn:hover {
				background: var(--accent-hover);
			}
			.satf-bounty-check-btn {
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
			.satf-bounty-check-btn:hover {
				color: var(--text);
				border-color: var(--accent);
			}
			.satf-bounty-empty {
				text-align: center;
				padding: 24px 0;
				color: var(--muted);
				font-size: 12px;
				font-weight: 500;
			}
			.satf-bounty-refresh-btn {
				padding: 3px 8px;
				font-size: 10px;
				font-weight: 700;
				border-radius: 5px;
				border: 1px solid var(--border);
				background: var(--card);
				color: var(--muted);
				cursor: pointer;
				transition: all 0.15s;
			}
			.satf-bounty-refresh-btn:hover {
				color: var(--text);
				border-color: var(--accent);
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
				gap: 10px;
			}
			.satf-score-box {
				flex: 1;
				display: flex;
				flex-direction: column;
				min-width: 0;
			}
			.satf-score-box.is-opponent {
				text-align: right;
			}
			.satf-score-vs {
				flex: 0 0 auto;
				font-size: 10px;
				font-weight: 800;
				color: var(--muted);
				letter-spacing: 1px;
			}
			.satf-score-lbl {
				font-size: 12px;
				color: #fff;
				font-weight: 800;
				text-transform: uppercase;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}
			.satf-retal-badge {
				display: inline-block;
				margin-left: 6px;
				padding: 1px 6px;
				border-radius: 4px;
				font-size: 10px;
				font-weight: 800;
				text-transform: uppercase;
				letter-spacing: 0.4px;
				background: rgba(239, 68, 68, 0.15);
				color: #f87171;
				border: 1px solid rgba(239, 68, 68, 0.35);
			}
			.satf-war-details {
				display: flex;
				justify-content: center;
				margin-top: 8px;
			}
			.satf-hitcount {
				font-size: 10px;
				font-weight: 700;
				text-transform: uppercase;
				letter-spacing: 0.4px;
				color: var(--muted);
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
			.satf-queue-right {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.satf-dibs-btn {
				padding: 3px 8px;
				font-size: 11px;
				font-weight: 600;
				border-radius: 4px;
				border: 1px solid var(--accent);
				background: rgba(59, 130, 246, 0.15);
				color: var(--accent);
				cursor: pointer;
				transition: background 0.15s, color 0.15s, border-color 0.15s;
			}
			.satf-dibs-btn:hover {
				background: var(--accent);
				color: #fff;
			}
			.satf-dibs-btn.satf-dibs-release {
				border-color: var(--muted);
				background: rgba(255, 255, 255, 0.05);
				color: var(--muted);
			}
			.satf-dibs-btn.satf-dibs-release:hover {
				border-color: var(--danger);
				color: var(--danger);
				background: rgba(239, 68, 68, 0.1);
			}
			.satf-dibs-btn.satf-dibs-attack {
				border-color: #10b981;
				background: rgba(16, 185, 129, 0.2);
				color: #10b981;
				font-weight: 700;
			}
			.satf-dibs-btn.satf-dibs-attack:hover {
				background: #10b981;
				color: #fff;
			}
			.satf-dibs-claimed-label {
				font-size: 10px;
				font-weight: 700;
				text-transform: uppercase;
				letter-spacing: 0.03em;
				padding: 2px 6px;
				border-radius: 4px;
				background: rgba(245, 158, 11, 0.15);
				color: #f59e0b;
				border: 1px solid rgba(245, 158, 11, 0.3);
			}
			.satf-dibs-claimed-label.you {
				background: rgba(16, 185, 129, 0.15);
				color: #10b981;
				border-color: rgba(16, 185, 129, 0.3);
			}
			.satf-dibs-countdown {
				font-size: 11px;
				font-family: var(--font-mono, monospace);
				font-weight: 600;
				color: var(--muted);
				background: rgba(255, 255, 255, 0.05);
				border: 1px solid rgba(255, 255, 255, 0.1);
				padding: 2px 7px;
				border-radius: 4px;
				white-space: nowrap;
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

			.satf-action-bar {
				display: flex;
				align-items: center;
				justify-content: center;
				padding: 8px 12px;
				background: #141417;
				border-bottom: 1px solid var(--border);
			}
			.satf-btn-get-target {
				width: 100%;
				background: #10b981;
				color: #000;
				font-weight: 700;
				font-size: 12px;
				padding: 7px 16px;
				border: none;
				border-radius: 6px;
				cursor: pointer;
				transition: background 0.15s;
				text-align: center;
			}
			.satf-btn-get-target:hover:not(:disabled) {
				background: #059669;
			}
			.satf-btn-get-target:disabled {
				background: #27272a;
				color: #71717a;
				cursor: not-allowed;
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
				<div class="satf-action-bar">
					<button id="satf-btn-get-target" class="satf-btn-get-target" type="button">Get Chain Target</button>
				</div>
				<div class="satf-tabs">
					<button class="satf-tab-btn active" data-tab="war">Ranked War</button>
					<button class="satf-tab-btn" data-tab="bounties">Bounties (<span id="satf-bounties-tab-count">0</span>)</button>
					<button class="satf-tab-btn" data-tab="settings">Settings</button>
				</div>
			</div>

			<!-- RANKED WAR VIEW -->
			<div id="satf-view-war" style="display: none;">
				<div id="satf-war-empty" style="display: none; text-align: center; padding: 30px 16px; color: var(--muted); font-size: 12px;">
					No active or scheduled ranked war.
				</div>

				<div id="satf-war-active-content" style="display: none;">
					<!-- WAR SCORECARD BANNER -->
					<div id="satf-war-banner" class="satf-war-banner">
						<div class="satf-war-header-row">
							<span id="satf-war-title">RANKED WAR</span>
							<span id="satf-war-lead" class="satf-lead-badge lead-pos" style="display: none;">LEAD +0</span>
						</div>
						<div class="satf-score-row">
							<div class="satf-score-box">
								<span id="satf-own-faction-lbl" class="satf-score-lbl">Subversive Alliance</span>
							</div>
							<span class="satf-score-vs">VS</span>
							<div class="satf-score-box is-opponent">
								<span id="satf-opp-name" class="satf-score-lbl">Opponent</span>
							</div>
						</div>
						<!-- Future scorecard detail rows land here. The wrapper starts
						     hidden; the span inside must NOT carry its own inline
						     display:none or it stays invisible once the wrapper opens. -->
						<div id="satf-war-details" class="satf-war-details" style="display: none;">
							<span id="satf-user-hit-count" class="satf-hitcount"></span>
						</div>
					</div>

					<!-- TRAVEL LOCK WARNING -->
					<div id="satf-travel-lock" class="satf-travel-lock">
						[TRAVEL LOCK] Attacker is traveling or abroad. Target dispatch locked.
					</div>

					<!-- WAR SUBTABS -->
					<div class="satf-bounty-controls" style="margin-bottom: 8px;">
						<div class="satf-bounty-subtabs">
							<button type="button" class="satf-bounty-subtab-btn active" data-subtab="targets" id="satf-war-subtab-targets">
								Targets (<span id="satf-war-targets-count">0</span>)
							</button>
							<button type="button" class="satf-bounty-subtab-btn" data-subtab="hosp" id="satf-war-subtab-hosp">
								Hosp Queue (<span id="satf-war-hosp-count">0</span>)
							</button>
						</div>
					</div>

					<!-- TARGETS SUB-PANE -->
					<div id="satf-war-pane-targets">
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

					<!-- HOSP QUEUE SUB-PANE -->
					<div id="satf-war-pane-hosp" style="display: none;">
						<div id="satf-hosp-container" class="satf-queue-list">
							<div style="text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px;">
								Loading hospital queue...
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- BOUNTIES VIEW -->
			<div id="satf-view-bounties" style="display: none;">
				<div class="satf-bounty-controls" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
					<span style="font-size: 11px; font-weight: 700; color: #fff;">Available Bounties (<span id="satf-bounty-ready-count">0</span>)</span>
					<span id="satf-bounties-status" style="font-size: 11px; color: var(--muted); font-weight: 600;">Ready</span>
				</div>

				<!-- Bounties list -->
				<div id="satf-bounties-pane-ready" class="satf-bounty-list"></div>
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

				<div style="margin-bottom: 12px; padding: 10px; background: #09090b; border: 1px solid var(--border); border-radius: 8px;">
					<div style="font-size: 11px; font-weight: 700; color: #fff; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Chain Target Fair Fight Range</div>
					<div style="font-size: 10px; color: var(--muted); margin-bottom: 8px;">Fair fight bounds applied when acquiring targets via "Get Chain Target".</div>
					<div style="display: flex; gap: 12px;">
						<div class="satf-field" style="flex: 1; margin-bottom: 0;">
							<label style="font-size: 10px; color: var(--muted); margin-bottom: 4px; display: block;">Min FF</label>
							<input type="number" id="satf-input-min-ff" min="1.0" max="3.0" step="0.1" value="${state.minFFThreshold.toFixed(1)}" style="width: 100%; padding: 6px 8px; background: #18181b; border: 1px solid var(--border); border-radius: 4px; color: #fff; font-size: 12px; text-align: center;">
						</div>
						<div class="satf-field" style="flex: 1; margin-bottom: 0;">
							<label style="font-size: 10px; color: var(--muted); margin-bottom: 4px; display: block;">Max FF</label>
							<input type="number" id="satf-input-max-ff" min="1.0" max="3.0" step="0.1" value="${state.maxFFThreshold.toFixed(1)}" style="width: 100%; padding: 6px 8px; background: #18181b; border: 1px solid var(--border); border-radius: 4px; color: #fff; font-size: 12px; text-align: center;">
						</div>
					</div>
				</div>

				<div style="margin-bottom: 12px; padding: 10px; background: #09090b; border: 1px solid var(--border); border-radius: 8px;">
					<div style="font-size: 11px; font-weight: 700; color: #fff; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Bounty Reward Range</div>
					<div style="font-size: 10px; color: var(--muted); margin-bottom: 8px;">Filter bounties by reward amount (e.g. 500k, 2M, or leave Max empty for no limit).</div>
					<div style="display: flex; gap: 12px;">
						<div class="satf-field" style="flex: 1; margin-bottom: 0;">
							<label style="font-size: 10px; color: var(--muted); margin-bottom: 4px; display: block;">Min Reward</label>
							<input type="text" id="satf-input-bounty-min" placeholder="e.g. 100k" value="${state.bountyMinReward > 0 ? formatMoney(state.bountyMinReward) : ""}" style="width: 100%; padding: 6px 8px; background: #18181b; border: 1px solid var(--border); border-radius: 4px; color: #fff; font-size: 12px; text-align: center;">
						</div>
						<div class="satf-field" style="flex: 1; margin-bottom: 0;">
							<label style="font-size: 10px; color: var(--muted); margin-bottom: 4px; display: block;">Max Reward</label>
							<input type="text" id="satf-input-bounty-max" placeholder="Any" value="${state.bountyMaxReward > 0 ? formatMoney(state.bountyMaxReward) : ""}" style="width: 100%; padding: 6px 8px; background: #18181b; border: 1px solid var(--border); border-radius: 4px; color: #fff; font-size: 12px; text-align: center;">
						</div>
					</div>
				</div>

				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 11px; color: var(--muted);">
					<span id="satf-ignored-count">${state.ignoredTargets.length} ignored targets</span>
					<button id="satf-btn-clear-ignored" class="satf-btn satf-btn-secondary satf-btn-sm">Reset Ignored</button>
				</div>

				<div style="margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px;">
					<label style="font-size: 11px; color: var(--muted); cursor: pointer; display: flex; align-items: center; gap: 6px;">
						<input type="checkbox" id="satf-chk-attack-new-tab">
						<span>Attack in new tab</span>
					</label>
					<label style="font-size: 11px; color: var(--muted); cursor: pointer; display: flex; align-items: center; gap: 6px;">
						<input type="checkbox" id="satf-chk-disable-hud">
						<span>Disable attack HUD</span>
					</label>
					<label style="font-size: 11px; color: var(--muted); cursor: pointer; display: flex; align-items: center; gap: 6px;">
						<input type="checkbox" id="satf-chk-persist-open">
						<span>Remember open window across page loads</span>
					</label>
				</div>

				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 11px; color: var(--muted);">
					<span>Launcher Position</span>
					<button id="satf-btn-reset-pos" class="satf-btn satf-btn-secondary satf-btn-sm">Reset Position</button>
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
}
