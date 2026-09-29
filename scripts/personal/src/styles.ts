export const SHADOW_STYLES = `
:host {
	all: initial;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	font-size: 13px;
	color: #e2e8f0;
	line-height: 1.4;
	box-sizing: border-box;
}

*, *::before, *::after {
	box-sizing: border-box;
}

/* ─── Floating Launcher ─── */
.blasted-launcher {
	position: fixed;
	width: 44px;
	height: 44px;
	border-radius: 50%;
	background: linear-gradient(135deg, #0ea5e9, #6366f1);
	box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45), 0 0 12px rgba(99, 102, 241, 0.35);
	cursor: grab;
	z-index: 999999;
	display: flex;
	align-items: center;
	justify-content: center;
	user-select: none;
	touch-action: none;
	transition: transform 0.15s ease, box-shadow 0.15s ease;
	border: 2px solid rgba(255, 255, 255, 0.2);
}

.blasted-launcher:active {
	cursor: grabbing;
	transform: scale(0.95);
}

.blasted-launcher:hover {
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6), 0 0 16px rgba(14, 165, 233, 0.6);
}

.blasted-launcher svg {
	width: 22px;
	height: 22px;
	fill: none;
	stroke: #ffffff;
	stroke-width: 2;
	stroke-linecap: round;
	stroke-linejoin: round;
	pointer-events: none;
}

/* ─── Slide-out Drawer ─── */
.blasted-drawer-overlay {
	position: fixed;
	top: 0;
	left: 0;
	width: 100vw;
	height: 100vh;
	background: rgba(0, 0, 0, 0.5);
	backdrop-filter: blur(4px);
	z-index: 999998;
	opacity: 0;
	pointer-events: none;
	transition: opacity 0.25s ease;
}

.blasted-drawer-overlay.open {
	opacity: 1;
	pointer-events: auto;
}

.blasted-drawer {
	position: fixed;
	top: 0;
	right: 0;
	width: 580px;
	max-width: 100vw;
	height: 100vh;
	background: #0f172a;
	color: #e2e8f0;
	box-shadow: -8px 0 28px rgba(0, 0, 0, 0.65);
	z-index: 999999;
	display: flex;
	flex-direction: column;
	transform: translateX(100%);
	transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
	border-left: 1px solid #1e293b;
	overflow: hidden;
}

.blasted-drawer.open {
	transform: translateX(0);
}

@media (max-width: 640px) {
	.blasted-drawer {
		width: 100vw;
	}
}

/* ─── Drawer Header ─── */
.drawer-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 14px;
	background: #1e293b;
	border-bottom: 1px solid #334155;
	flex-shrink: 0;
	height: 46px;
}

.drawer-actions {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
}

.drawer-footer {
	padding: 6px 14px;
	background: #0b1120;
	border-top: 1px solid #1e293b;
	display: flex;
	align-items: center;
	justify-content: flex-end;
	flex-shrink: 0;
}

.status-badge {
	font-size: 9.5px;
	padding: 1px 6px;
	border-radius: 999px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.status-badge.ok {
	background: rgba(16, 185, 129, 0.2);
	color: #34d399;
	border: 1px solid rgba(16, 185, 129, 0.3);
}

.status-badge.error {
	background: rgba(239, 68, 68, 0.2);
	color: #f87171;
	border: 1px solid rgba(239, 68, 68, 0.3);
}

.status-badge.loading {
	background: rgba(56, 189, 248, 0.2);
	color: #38bdf8;
	border: 1px solid rgba(56, 189, 248, 0.3);
}

.btn-icon {
	background: transparent;
	border: none;
	color: #94a3b8;
	cursor: pointer;
	padding: 6px;
	border-radius: 6px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.15s, color 0.15s;
}

.btn-icon:hover {
	background: #334155;
	color: #f8fafc;
}

.btn-icon svg {
	width: 18px;
	height: 18px;
	stroke-width: 2;
}

/* ─── Navigation Tabs ─── */
.drawer-tabs {
	display: flex;
	background: transparent;
	padding: 0;
	border-bottom: none;
	overflow-x: auto;
	gap: 4px;
	flex: 1;
	scrollbar-width: none;
	height: 100%;
	align-items: flex-end;
}

.drawer-tabs::-webkit-scrollbar {
	display: none;
}

.drawer-tab {
	padding: 10px 12px;
	font-size: 13px;
	font-weight: 600;
	color: #94a3b8;
	background: transparent;
	border: none;
	border-bottom: 2px solid transparent;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 6px;
	white-space: nowrap;
	transition: color 0.15s, border-color 0.15s;
}

.drawer-tab:hover:not(.disabled) {
	color: #cbd5e1;
}

.drawer-tab.active {
	color: #38bdf8;
	border-bottom-color: #38bdf8;
}

.drawer-tab.disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.tab-badge {
	font-size: 9px;
	font-weight: 700;
	padding: 1px 5px;
	border-radius: 4px;
	background: #334155;
	color: #94a3b8;
	text-transform: uppercase;
}

/* ─── Drawer Content Area ─── */
.drawer-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 18px;
	display: flex;
	flex-direction: column;
	gap: 18px;
	-webkit-overflow-scrolling: touch;
	overscroll-behavior: contain;
	scrollbar-width: thin;
	scrollbar-color: #334155 #0b1120;
}

.drawer-body > * {
	flex-shrink: 0;
}

.drawer-body::-webkit-scrollbar {
	width: 6px;
}

.drawer-body::-webkit-scrollbar-track {
	background: #0b1120;
}

.drawer-body::-webkit-scrollbar-thumb {
	background: #334155;
	border-radius: 3px;
}

.drawer-body::-webkit-scrollbar-thumb:hover {
	background: #475569;
}

/* ─── KPI Cards Grid ─── */
.kpi-grid {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 10px;
}

@media (min-width: 480px) {
	.kpi-grid {
		grid-template-columns: repeat(3, 1fr);
	}
}

.kpi-card {
	background: #1e293b;
	border: 1px solid #334155;
	border-radius: 8px;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}



.kpi-label {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	color: #94a3b8;
	letter-spacing: 0.04em;
}

.kpi-value {
	font-size: 18px;
	font-weight: 700;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	color: #f8fafc;
}

.kpi-sub {
	font-size: 11px;
	color: #64748b;
}

.val-green { color: #34d399 !important; }
.val-emerald { color: #34d399 !important; }
.val-amber { color: #fbbf24 !important; }
.val-blue { color: #38bdf8 !important; }
.val-sky { color: #38bdf8 !important; }
.val-purple { color: #a855f7 !important; }

/* ─── Chart Container ─── */
.chart-card {
	background: #1e293b;
	border: 1px solid #334155;
	border-radius: 8px;
	padding: 14px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.chart-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
}

.chart-title {
	font-size: 13px;
	font-weight: 700;
	color: #f1f5f9;
}

.chart-controls {
	display: flex;
	align-items: center;
	gap: 8px;
}

.btn-pill-group {
	display: flex;
	background: #0f172a;
	padding: 2px;
	border-radius: 6px;
	border: 1px solid #334155;
}

.btn-pill {
	background: transparent;
	border: none;
	color: #94a3b8;
	font-size: 11px;
	font-weight: 600;
	padding: 4px 8px;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.15s, color 0.15s;
}

.btn-pill.active {
	background: #38bdf8;
	color: #0f172a;
}

.chart-scrub-strip {
	background: #0f172a;
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 8px 12px;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	font-size: 11px;
	font-family: ui-monospace, monospace;
}

.chart-svg-wrap {
	position: relative;
	width: 100%;
	overflow: hidden;
}

.chart-svg {
	width: 100%;
	height: auto;
	display: block;
	user-select: none;
}

/* ─── Category Breakdown Table ─── */
.table-card {
	background: #1e293b;
	border: 1px solid #334155;
	border-radius: 8px;
	overflow: hidden;
}

.table-header-title {
	padding: 12px 14px;
	font-size: 13px;
	font-weight: 700;
	color: #f1f5f9;
	border-bottom: 1px solid #334155;
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.table-wrap {
	overflow-x: auto;
	-webkit-overflow-scrolling: touch;
	width: 100%;
}

table {
	width: 100%;
	min-width: 500px;
	border-collapse: collapse;
	text-align: left;
	font-size: 12px;
}

th {
	background: #131d31;
	color: #94a3b8;
	font-weight: 600;
	padding: 8px 12px;
	text-transform: uppercase;
	font-size: 10px;
	letter-spacing: 0.05em;
	position: sticky;
	top: 0;
	z-index: 2;
}

td {
	padding: 9px 12px;
	border-bottom: 1px solid #233149;
	color: #cbd5e1;
	font-family: ui-monospace, monospace;
}

tr:hover td {
	background: rgba(255, 255, 255, 0.03);
}

.text-left { text-align: left; }
.text-right { text-align: right; }

/* ─── Settings Tab ─── */
.settings-group {
	display: flex;
	flex-direction: column;
	gap: 12px;
	background: #1e293b;
	border: 1px solid #334155;
	border-radius: 8px;
	padding: 16px;
}

.settings-label {
	font-size: 12px;
	font-weight: 600;
	color: #cbd5e1;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.input-text {
	background: #0f172a;
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 8px 10px;
	color: #f8fafc;
	font-size: 12px;
	font-family: ui-monospace, monospace;
	outline: none;
	width: 100%;
}

.input-text:focus {
	border-color: #38bdf8;
	box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
}

.btn-primary {
	background: #0284c7;
	color: #ffffff;
	border: none;
	border-radius: 6px;
	padding: 8px 14px;
	font-weight: 600;
	cursor: pointer;
	transition: background 0.15s;
}

.btn-primary:hover {
	background: #0369a1;
}

.checkbox-row {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	font-size: 13px;
	color: #cbd5e1;
}

/* --- Battlestats Target Ratio Bar Styles --- */
.stat-ratio-bars {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-top: 4px;
}

.ratio-stat-row {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.ratio-stat-meta {
	display: flex;
	justify-content: space-between;
	font-size: 11px;
	font-family: ui-monospace, SFMono-Regular, monospace;
}

.ratio-stat-meta .stat-name {
	font-weight: 700;
	text-transform: capitalize;
}

.ratio-stat-meta .stat-name.strength { color: #f97316; }
.ratio-stat-meta .stat-name.defense { color: #06b6d4; }
.ratio-stat-meta .stat-name.speed { color: #10b981; }
.ratio-stat-meta .stat-name.dexterity { color: #a855f7; }

.ratio-stat-meta .stat-diff.deficit { color: #f87171; }
.ratio-stat-meta .stat-diff.surplus { color: #34d399; }

.ratio-bar-track {
	position: relative;
	height: 6px;
	background: #1e293b;
	border-radius: 3px;
	overflow: visible;
}

.ratio-bar-fill {
	height: 100%;
	border-radius: 3px;
	transition: width 0.3s ease;
}

.ratio-bar-fill.strength { background: #f97316; }
.ratio-bar-fill.defense { background: #06b6d4; }
.ratio-bar-fill.speed { background: #10b981; }
.ratio-bar-fill.dexterity { background: #a855f7; }

.ratio-bar-target {
	position: absolute;
	top: -2px;
	bottom: -2px;
	width: 2px;
	background: #f8fafc;
	box-shadow: 0 0 4px #ffffff;
	z-index: 2;
}

/* ─── Goal Prediction Section ─── */
.goal-input-row {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.goal-input-wrap {
	display: flex;
	align-items: center;
	background: #0f172a;
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 5px 10px;
	flex: 1;
	min-width: 180px;
}

.goal-input-wrap:focus-within {
	border-color: #38bdf8;
}

.goal-input-wrap .goal-prefix {
	font-size: 11px;
	font-weight: 700;
	color: #64748b;
	margin-right: 6px;
	text-transform: uppercase;
}

.goal-input-field {
	background: transparent;
	border: none;
	outline: none;
	color: #f8fafc;
	font-size: 13px;
	font-weight: 600;
	font-family: ui-monospace, SFMono-Regular, monospace;
	width: 100%;
}

.goal-quick-chips {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
}

.btn-chip {
	background: #1e293b;
	border: 1px solid #334155;
	color: #94a3b8;
	font-size: 11px;
	font-weight: 600;
	padding: 4px 8px;
	border-radius: 4px;
	cursor: pointer;
	transition: all 0.15s ease;
}

.btn-chip:hover {
	background: #334155;
	color: #f8fafc;
	border-color: #475569;
}

.prediction-results-grid {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 10px;
	margin-top: 10px;
}

@media (min-width: 480px) {
	.prediction-results-grid {
		grid-template-columns: repeat(3, 1fr);
	}
}

.prediction-card {
	background: #0f172a;
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 10px 12px;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.prediction-label {
	font-size: 10px;
	font-weight: 700;
	color: #94a3b8;
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.prediction-value {
	font-size: 16px;
	font-weight: 700;
	font-family: ui-monospace, SFMono-Regular, monospace;
	color: #f8fafc;
}

.prediction-sub {
	font-size: 11px;
	color: #64748b;
}
`;

export const IN_PAGE_BADGE_STYLES = `
.blasted-crime-badge {
	position: absolute;
	bottom: 50px;
	left: 50%;
	transform: translateX(-50%);
	display: inline-flex;
	align-items: center;
	gap: 5px;
	background: rgba(15, 23, 42, 0.92);
	backdrop-filter: blur(6px);
	border: 1px solid rgba(56, 189, 248, 0.4);
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
	color: #f8fafc;
	font-size: 10.5px;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-weight: 700;
	padding: 2px 8px;
	border-radius: 999px;
	cursor: pointer;
	transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
	user-select: none;
	z-index: 10;
	white-space: nowrap;
}

.blasted-crime-badge:hover {
	transform: translateX(-50%) scale(1.05);
	border-color: #38bdf8;
	background: rgba(15, 23, 42, 0.98);
}

.blasted-crime-badge.blasted-mobile-badge {
	position: static;
	transform: none;
	display: inline-flex;
	font-size: 9.5px;
	padding: 1px 6px;
	margin-left: 8px;
	vertical-align: middle;
	background: rgba(15, 23, 42, 0.95);
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}

.blasted-crime-badge.blasted-mobile-badge:hover {
	transform: scale(1.05);
}

.blasted-crime-badge .badge-roi {
	color: #34d399;
}

.blasted-crime-badge .badge-profit {
	color: #38bdf8;
}

.blasted-crime-badge .badge-sep {
	color: #64748b;
}

/* --- Torn Gym In-Page Styles --- */
#blasted-gym-hud {
	display: flex;
	align-items: center;
	background: rgba(15, 23, 42, 0.85);
	border: 1px solid rgba(56, 189, 248, 0.35);
	border-radius: 6px;
	padding: 6px 12px;
	margin: 8px 0 10px 0;
	backdrop-filter: blur(8px);
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.blasted-hud-metrics {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 11.5px;
	color: #cbd5e1;
	flex-wrap: wrap;
}

.blasted-hud-item .hud-label {
	color: #94a3b8;
	margin-right: 4px;
}

.blasted-hud-item .hud-value {
	font-weight: 600;
}

.blasted-hud-divider {
	color: #475569;
}

/* Priority Card Highlight */
.blasted-gym-card-priority {
	position: relative;
	box-shadow: inset 0 0 0 2px #38bdf8 !important;
	border-color: #38bdf8 !important;
}

/* Stat Card Live Efficiency Pill */
.blasted-stat-efficiency-pill {
	background: rgba(15, 23, 42, 0.85);
	border: 1px solid rgba(56, 189, 248, 0.25);
	border-radius: 4px;
	padding: 5px 8px;
	margin: 6px 0 8px 0;
	display: flex;
	flex-direction: column;
	gap: 3px;
	font-size: 11px;
	font-family: ui-monospace, SFMono-Regular, monospace;
}

.blasted-pill-target-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	border-bottom: 1px solid rgba(56, 189, 248, 0.3);
	padding-bottom: 3px;
	margin-bottom: 3px;
}

.blasted-pill-target-label {
	font-size: 9px;
	font-weight: 800;
	color: #38bdf8;
	letter-spacing: 0.5px;
}

.blasted-pill-target-tag {
	font-size: 9px;
	font-weight: 700;
	color: #f87171;
}

.blasted-pill-target-tag.surplus {
	color: #34d399;
}

.blasted-pill-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
}

.blasted-pill-label {
	color: #94a3b8;
}

.blasted-pill-val.gain {
	font-weight: 700;
	color: #38bdf8;
}

.blasted-pill-val.deficit {
	font-weight: 600;
	color: #f87171;
}

.blasted-pill-val.surplus {
	font-weight: 600;
	color: #34d399;
}

@media screen and (max-width: 386px) {
	.blasted-stat-efficiency-pill {
		font-size: 9px;
		padding: 3px 4px;
	}
}
`;
