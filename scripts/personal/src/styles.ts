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
/* Keyboard focus must be visible: the launcher, the tabs, sortable headers and the
   charts are all reachable with Tab, and none of them are links. */
.blasted-launcher:focus-visible,
.drawer-tab:focus-visible,
.btn-icon:focus-visible,
.btn-pill:focus-visible,
.btn-chip:focus-visible,
.btn-paginator:focus-visible,
.btn-primary:focus-visible,
.input-text:focus-visible,
.sortable-table th.sortable:focus-visible,
.chart-focusable:focus-visible {
	outline: 2px solid #38bdf8;
	outline-offset: 2px;
}

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

/* ─── Sortable Tables ─── */
.table-header-meta {
	font-size: 11px;
	font-weight: 400;
	color: #94a3b8;
}

.table-filter-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 12px 10px;
}

.table-filter {
	flex: 1;
	min-width: 0;
}

.table-filter .input-text {
	width: 100%;
	font-size: 12px;
	padding: 6px 8px;
}

.sortable-table th.sortable {
	cursor: pointer;
	user-select: none;
	white-space: nowrap;
}

.sortable-table th.sortable:hover {
	color: #e2e8f0;
}

.sortable-table th.sorted {
	color: #38bdf8;
}

.sort-hint,
.sort-active {
	opacity: 0.55;
	font-size: 9px;
	margin-left: 2px;
}

.sort-active {
	opacity: 1;
}

/* ─── Chart Affordances ─── */
.chart-focusable {
	cursor: crosshair;
}

.chart-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	color: #94a3b8;
	font-size: 12px;
	font-family: ui-monospace, monospace;
	text-align: center;
	padding: 0 12px;
}

.blasted-launcher {
	position: fixed;
	width: 44px;
	height: 44px;
	padding: 0;
	border-radius: 50%;
	appearance: none;
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

/* While the edge is dragged the width must follow the pointer exactly: no width
   transition, and the panel's own drag affordance stays lit. */
.blasted-drawer.resizing {
	transition: none;
}

.drawer-resize {
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 7px;
	z-index: 5;
	cursor: col-resize;
	touch-action: none;
	background: transparent;
	transition: background 0.15s ease;
}

.drawer-resize::after {
	content: "";
	position: absolute;
	top: 50%;
	left: 2px;
	width: 3px;
	height: 46px;
	transform: translateY(-50%);
	border-radius: 3px;
	background: #475569;
	opacity: 0;
	transition: opacity 0.15s ease;
}

.blasted-drawer:hover .drawer-resize::after,
.drawer-resize:hover::after {
	opacity: 1;
}

.drawer-resize:hover,
.blasted-drawer.resizing .drawer-resize {
	background: rgba(56, 189, 248, 0.22);
}

/* On a phone the drawer is the full width, so there is nothing to drag. */
@media (max-width: 699px) {
	.drawer-resize {
		display: none;
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
	/* The container every inner layout query measures. Without this the @container
	   rules below have no container to match, and a 580px drawer on a wide screen
	   keeps the narrow two-column layout. */
	container-type: inline-size;
	container-name: blasted-drawer;
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

@container blasted-drawer (min-width: 470px) {
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
	color: #94a3b8;
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
	overflow: visible;
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
	color: #94a3b8;
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

@container blasted-drawer (min-width: 470px) {
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
	color: #94a3b8;
}

/* ─── Company Directives & Action Items ─── */
.directives-card {
	background: #1e293b;
	border: 1px solid #334155;
	border-radius: 8px;
	padding: 12px 14px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.directives-card.optimal {
	background: rgba(16, 185, 129, 0.08);
	border-color: rgba(16, 185, 129, 0.3);
}

.directives-card.warning {
	background: rgba(245, 158, 11, 0.08);
	border-color: rgba(245, 158, 11, 0.35);
}

.directives-header {
	display: flex;
	align-items: center;
	gap: 8px;
}

.status-indicator-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	display: inline-block;
}

.dot-green {
	background: #10b981;
	box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);
}

.dot-amber {
	background: #f59e0b;
	box-shadow: 0 0 6px rgba(245, 158, 11, 0.6);
}

.directives-title {
	font-size: 13px;
	font-weight: 700;
	color: #f8fafc;
}

.directive-row {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 4px;
	font-size: 12px;
}

.directive-tag {
	font-size: 9px;
	font-weight: 800;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	padding: 2px 6px;
	border-radius: 4px;
	white-space: nowrap;
	font-family: ui-monospace, SFMono-Regular, monospace;
}

.tag-role {
	background: rgba(56, 189, 248, 0.15);
	color: #38bdf8;
	border: 1px solid rgba(56, 189, 248, 0.3);
}

.tag-price {
	background: rgba(168, 85, 247, 0.15);
	color: #c084fc;
	border: 1px solid rgba(168, 85, 247, 0.3);
}

.tag-ad {
	background: rgba(245, 158, 11, 0.15);
	color: #fbbf24;
	border: 1px solid rgba(245, 158, 11, 0.3);
}

.tag-rehab {
	background: rgba(239, 68, 68, 0.15);
	color: #f87171;
	border: 1px solid rgba(239, 68, 68, 0.3);
}

.tag-rehab-sub {
	background: rgba(251, 146, 60, 0.15);
	color: #fb923c;
	border: 1px solid rgba(251, 146, 60, 0.3);
}

.tag-capacity {
	background: rgba(16, 185, 129, 0.15);
	color: #34d399;
	border: 1px solid rgba(16, 185, 129, 0.3);
}

.tag-structural {
	background: rgba(244, 63, 94, 0.15);
	color: #fb7185;
	border: 1px solid rgba(244, 63, 94, 0.3);
}

.tag-insight {
	background: rgba(148, 163, 184, 0.15);
	color: #cbd5e1;
	border: 1px solid rgba(148, 163, 184, 0.3);
}

.directive-text {
	color: #cbd5e1;
	font-size: 12px;
}

.kpi-value.positive {
	color: #10b981;
}

.kpi-value.negative {
	color: #f43f5e;
}

/* ─── Company Weekly Ledger Table ─── */
.weekly-table-card {
	background: #1e293b;
	border: 1px solid #334155;
	border-radius: 8px;
	overflow: hidden;
}

.weekly-paginator {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 14px;
	background: rgba(15, 23, 42, 0.6);
	border-bottom: 1px solid #334155;
}

.paginator-title {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.paginator-title span:first-child {
	font-size: 12px;
	font-weight: 700;
	color: #f8fafc;
}

.paginator-range {
	font-size: 10.5px;
	font-family: ui-monospace, SFMono-Regular, monospace;
	color: #94a3b8;
}

.paginator-controls {
	display: flex;
	align-items: center;
	gap: 6px;
}

.btn-paginator {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	font-size: 11px;
	font-weight: 600;
	background: #0f172a;
	color: #cbd5e1;
	border: 1px solid #334155;
	border-radius: 4px;
	cursor: pointer;
	transition: all 0.15s ease;
}

.btn-paginator:hover:not(:disabled) {
	background: #334155;
	color: #f8fafc;
	border-color: #475569;
}

.btn-paginator.active {
	background: #0284c7;
	color: #ffffff;
	border-color: #38bdf8;
}

.btn-paginator:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.weekly-table-scroll {
	width: 100%;
	overflow-x: auto;
}

.company-ledger-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 11px;
	text-align: left;
	font-family: ui-monospace, SFMono-Regular, monospace;
}

.company-ledger-table th {
	background: rgba(15, 23, 42, 0.4);
	color: #94a3b8;
	font-weight: 600;
	padding: 8px 10px;
	border-bottom: 1px solid #334155;
	text-transform: uppercase;
	font-size: 10px;
	letter-spacing: 0.5px;
}

.company-ledger-table td {
	padding: 7px 10px;
	border-bottom: 1px solid rgba(51, 65, 85, 0.5);
	color: #e2e8f0;
	white-space: nowrap;
}

.company-ledger-table tbody tr:hover {
	background: rgba(255, 255, 255, 0.03);
}

.td-day {
	font-weight: 700;
	color: #38bdf8;
}

.td-date {
	color: #94a3b8;
}

.td-num {
	text-align: right;
}

.company-ledger-table th:nth-child(n+3) {
	text-align: right;
}

.profit-pos {
	color: #10b981;
	font-weight: 700;
}

.profit-neg {
	color: #f43f5e;
	font-weight: 700;
}

.tfoot-totals {
	background: rgba(15, 23, 42, 0.85);
	font-weight: 700;
	border-top: 1px solid #475569;
}

.tfoot-totals td {
	padding: 8px 10px;
	border-bottom: none;
	color: #f8fafc;
}

.td-total-label {
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: #94a3b8;
	font-size: 10px;
}

/* ─── Stocks Tab ─── */

.stock-toolbar {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 10px;
	margin-bottom: 12px;
}

.stock-toolbar-meta {
	min-width: 0;
}

.stock-toolbar-title {
	font-size: 14px;
	font-weight: 700;
	color: #f8fafc;
}

.stock-toolbar-sub {
	font-size: 11px;
	color: #94a3b8;
	margin-top: 2px;
	line-height: 1.45;
}

.btn-stocks-sync {
	width: auto;
	flex-shrink: 0;
	padding: 7px 12px;
	font-size: 11.5px;
	border-radius: 6px;
}

.kpi-grid-stocks {
	grid-template-columns: 1fr 1fr;
	margin-top: 4px;
}

.stock-next-payout {
	display: flex;
	align-items: center;
	gap: 7px;
	margin-top: 10px;
	padding: 8px 10px;
	border-radius: 6px;
	background: rgba(15, 23, 42, 0.6);
	border: 1px solid #334155;
	font-size: 11.5px;
	color: #cbd5e1;
	line-height: 1.45;
}

.stock-next-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: #64748b;
	flex-shrink: 0;
}

.stock-next-dot.ready {
	background: #34d399;
	box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.18);
}

.stock-table {
	min-width: 560px;
}

.stock-catalog-table {
	min-width: 620px;
}

.stock-table th[data-sort],
.stock-table th[data-block-sort] {
	cursor: pointer;
	user-select: none;
}

.stock-table th.sorted {
	color: #38bdf8;
}

.stock-row {
	cursor: pointer;
}

.stock-row.open {
	background: rgba(56, 189, 248, 0.08);
}

.stock-owned .stock-acronym {
	color: #34d399;
}

.stock-name {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.stock-acronym {
	font-weight: 700;
	color: #38bdf8;
}

.stock-full {
	font-size: 10px;
	color: #94a3b8;
	white-space: normal;
}

.stock-flags {
	display: flex;
	flex-wrap: wrap;
	gap: 3px;
	margin-top: 3px;
}

.stock-chip {
	display: inline-block;
	padding: 1px 5px;
	border-radius: 3px;
	font-size: 9px;
	font-weight: 700;
	letter-spacing: 0.3px;
	text-transform: uppercase;
	background: rgba(148, 163, 184, 0.14);
	color: #cbd5e1;
	border: 1px solid rgba(148, 163, 184, 0.25);
	white-space: nowrap;
}

.stock-chip.passive {
	background: rgba(168, 85, 247, 0.14);
	border-color: rgba(168, 85, 247, 0.35);
	color: #d8b4fe;
}

.stock-chip.owned {
	background: rgba(52, 211, 153, 0.14);
	border-color: rgba(52, 211, 153, 0.35);
	color: #6ee7b7;
}

.stock-chip.ready {
	background: rgba(52, 211, 153, 0.2);
	border-color: rgba(52, 211, 153, 0.45);
	color: #a7f3d0;
}

.stock-chip.warn {
	background: rgba(251, 191, 36, 0.12);
	border-color: rgba(251, 191, 36, 0.32);
	color: #fcd34d;
}

.stock-detail-row td {
	background: rgba(2, 6, 23, 0.55);
	padding: 12px 10px 14px;
	white-space: normal;
}

.stock-detail-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
	margin-bottom: 10px;
}

.stock-detail-stat {
	min-width: 0;
}

.stock-detail-label {
	font-size: 9.5px;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	color: #94a3b8;
}

.stock-detail-value {
	font-size: 12px;
	font-weight: 700;
	color: #f1f5f9;
}

.stock-detail-line {
	font-size: 11.5px;
	color: #cbd5e1;
	line-height: 1.5;
	margin-bottom: 6px;
}

.stock-detail-sub {
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: #94a3b8;
	margin: 10px 0 5px;
}

.stock-benefit-block {
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 9px 10px;
	background: rgba(15, 23, 42, 0.5);
}

.stock-benefit-head {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.stock-benefit-desc {
	font-size: 11.5px;
	color: #e2e8f0;
}

.stock-benefit-meta {
	font-size: 11px;
	color: #94a3b8;
	line-height: 1.55;
	margin-top: 6px;
}

.stock-progress {
	margin-top: 8px;
}

.stock-progress-track {
	height: 5px;
	border-radius: 3px;
	background: rgba(148, 163, 184, 0.18);
	overflow: hidden;
}

.stock-progress-fill {
	height: 100%;
	background: #38bdf8;
	border-radius: 3px;
}

.stock-progress-fill.ready {
	background: #34d399;
}

.stock-progress-label {
	font-size: 10.5px;
	color: #94a3b8;
	margin-top: 5px;
	line-height: 1.45;
}

.stock-mini-row {
	display: flex;
	justify-content: space-between;
	gap: 10px;
	font-size: 11px;
	color: #cbd5e1;
	padding: 3px 0;
	border-bottom: 1px solid rgba(51, 65, 85, 0.4);
}

.stock-mini-what {
	flex: 1;
	min-width: 0;
	color: #94a3b8;
}

.stock-warning-list {
	margin: 0;
	padding-left: 16px;
}

.stock-warning-list li {
	font-size: 11px;
	color: #fcd34d;
	line-height: 1.5;
	margin-bottom: 3px;
}

.stock-catalog-note {
	font-size: 11px;
	color: #94a3b8;
	line-height: 1.5;
	padding: 0 12px 10px;
}

.stock-benefit-cell {
	white-space: normal;
	font-size: 11px;
	color: #e2e8f0;
	min-width: 150px;
}

.stock-unpriced-note {
	display: block;
	font-size: 10px;
	color: #94a3b8;
	margin-top: 3px;
	line-height: 1.4;
}

/* ─── Stock block table ─── */

.stock-cell-sub {
	display: block;
	font-size: 10px;
	color: #94a3b8;
	margin-top: 2px;
	line-height: 1.35;
}

.stock-dash {
	color: #64748b;
	cursor: help;
}

.stock-dash-muted {
	color: #475569;
}

.stock-held-mark {
	font-size: 10.5px;
	color: #34d399;
	text-transform: uppercase;
	letter-spacing: 0.4px;
}

.stock-chip.own-partial {
	background: rgba(56, 189, 248, 0.14);
	color: #7dd3fc;
	border-color: rgba(56, 189, 248, 0.4);
}

.stock-chip.next-buy {
	background: rgba(52, 211, 153, 0.16);
	color: #6ee7b7;
	border-color: rgba(52, 211, 153, 0.45);
}

.stock-block-filters {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px;
	padding: 8px 12px;
	border-bottom: 1px solid #334155;
	background: rgba(15, 23, 42, 0.35);
}

.stock-apr-filter {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 10.5px;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	color: #94a3b8;
}

.stock-apr-filter input {
	width: 60px;
	padding: 3px 6px;
	font-size: 11px;
}

.stock-apr-filter select {
	width: auto;
	padding: 3px 6px;
	font-size: 11px;
}

.stock-block-paginator {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 9px 12px;
	border-top: 1px solid #334155;
	background: rgba(15, 23, 42, 0.5);
}

.stock-page-size {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 10.5px;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	color: #94a3b8;
}

.stock-page-size select {
	width: auto;
	padding: 3px 6px;
	font-size: 11px;
}

.tos-table {
	margin-top: 12px;
	border: 1px solid #334155;
	border-radius: 6px;
	overflow: hidden;
}

.tos-title {
	font-size: 11px;
	font-weight: 700;
	color: #f1f5f9;
	padding: 7px 10px;
	background: rgba(15, 23, 42, 0.7);
	border-bottom: 1px solid #334155;
}

.tos-table table {
	width: 100%;
	border-collapse: collapse;
}

.tos-table th {
	text-align: left;
	vertical-align: top;
	width: 34%;
	padding: 6px 10px;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	color: #94a3b8;
	background: rgba(15, 23, 42, 0.35);
	border-bottom: 1px solid rgba(51, 65, 85, 0.5);
}

.tos-table td {
	padding: 6px 10px;
	font-size: 11px;
	color: #cbd5e1;
	line-height: 1.5;
	border-bottom: 1px solid rgba(51, 65, 85, 0.5);
}

/* Touch targets: 21px pills were below every recommended minimum. */
.btn-pill {
	min-height: 28px;
	padding: 6px 10px;
}

.btn-icon {
	min-width: 30px;
	min-height: 30px;
}

.drawer-tab {
	min-height: 32px;
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
	color: #94a3b8;
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

/* ─── Company In-Page Row Badges ─── */
.blasted-role-badge {
	display: inline-block;
	margin-left: 6px;
	padding: 2px 6px;
	border-radius: 4px;
	background: rgba(56, 189, 248, 0.15) !important;
	border: 1px solid #0284c7 !important;
	color: #38bdf8 !important;
	font-size: 10px !important;
	font-family: ui-monospace, SFMono-Regular, monospace !important;
	font-weight: 700 !important;
	line-height: 1.2 !important;
	vertical-align: middle;
}
`;
