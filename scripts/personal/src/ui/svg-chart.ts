import { formatCompactNumber, formatMoney, formatNumber } from "../config";
import type {
	CompanyHistoryEntry,
	DailyBattlestatsTimeline,
	DailyCrimeTimeline,
} from "../types";

export interface ChartRenderOptions {
	data: DailyCrimeTimeline[];
	metricMode: "financials" | "activity";
	width?: number;
	height?: number;
	onScrub?: (item: DailyCrimeTimeline | null) => void;
}

export function renderSvgChart(
	container: HTMLElement,
	options: ChartRenderOptions,
): void {
	const { data, metricMode, width = 600, height = 220, onScrub } = options;

	container.innerHTML = "";

	if (!data || data.length === 0) {
		container.innerHTML = `
			<div style="height: ${height}px; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 12px;">
				No timeline data recorded for this timeframe.
			</div>
		`;
		return;
	}

	const padding = { top: 20, right: 20, bottom: 35, left: 55 };
	const chartW = width - padding.left - padding.right;
	const chartH = height - padding.top - padding.bottom;

	// Determine primary and secondary metrics
	const isFinancial = metricMode === "financials";

	const primaryVals = data.map((d) => (isFinancial ? d.value : d.count));
	const secondaryVals = data.map((d) => (isFinancial ? d.efficiency : d.nerve));

	const maxPrimary = Math.max(...primaryVals, 1);
	const minPrimary = 0;

	const maxSecondary = Math.max(...secondaryVals, 1);
	const minSecondary = 0;

	// Scale functions
	const getX = (i: number) =>
		padding.left + (i / Math.max(data.length - 1, 1)) * chartW;
	const getYPrimary = (val: number) =>
		padding.top +
		chartH -
		((val - minPrimary) / (maxPrimary - minPrimary)) * chartH;
	const getYSecondary = (val: number) =>
		padding.top +
		chartH -
		((val - minSecondary) / (maxSecondary - minSecondary)) * chartH;

	// Build SVG paths
	let primaryPathD = "";
	let primaryAreaD = "";
	let secondaryPathD = "";

	for (let i = 0; i < data.length; i++) {
		const item = data[i];
		if (!item) continue;
		const x = getX(i);
		const yPri = getYPrimary(isFinancial ? item.value : item.count);
		const ySec = getYSecondary(isFinancial ? item.efficiency : item.nerve);

		if (i === 0) {
			primaryPathD += `M ${x.toFixed(1)} ${yPri.toFixed(1)}`;
			primaryAreaD += `M ${x.toFixed(1)} ${(padding.top + chartH).toFixed(1)} L ${x.toFixed(1)} ${yPri.toFixed(1)}`;
			secondaryPathD += `M ${x.toFixed(1)} ${ySec.toFixed(1)}`;
		} else {
			primaryPathD += ` L ${x.toFixed(1)} ${yPri.toFixed(1)}`;
			primaryAreaD += ` L ${x.toFixed(1)} ${yPri.toFixed(1)}`;
			secondaryPathD += ` L ${x.toFixed(1)} ${ySec.toFixed(1)}`;
		}
	}

	const lastX = getX(data.length - 1);
	const baselineY = padding.top + chartH;
	primaryAreaD += ` L ${lastX.toFixed(1)} ${baselineY.toFixed(1)} Z`;

	// Horizontal grid lines & Y labels (Primary axis on left)
	let gridLines = "";
	const steps = 4;
	for (let i = 0; i <= steps; i++) {
		const y = padding.top + (i / steps) * chartH;
		const val = maxPrimary - (i / steps) * (maxPrimary - minPrimary);
		const label = isFinancial ? formatMoney(val) : formatNumber(val);

		gridLines += `
			<line x1="${padding.left}" y1="${y}" x2="${padding.left + chartW}" y2="${y}" stroke="#334155" stroke-dasharray="3,3" stroke-width="1" />
			<text x="${padding.left - 8}" y="${y + 4}" fill="#64748b" font-size="9" text-anchor="end" font-family="monospace">${label}</text>
		`;
	}

	// X-axis date labels (limit labels to avoid overlapping on mobile)
	const isMobile = window.innerWidth < 500;
	const labelStep = Math.max(1, Math.floor(data.length / (isMobile ? 3 : 6)));
	let xLabels = "";

	for (let i = 0; i < data.length; i += labelStep) {
		const item = data[i];
		if (!item) continue;
		const x = getX(i);
		const dateObj = new Date(item.date);
		const dateStr = !Number.isNaN(dateObj.getTime())
			? dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" })
			: item.date;

		xLabels += `
			<text x="${x}" y="${baselineY + 18}" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="monospace">${dateStr}</text>
		`;
	}

	const primaryColor = isFinancial ? "#38bdf8" : "#38bdf8"; // Sky
	const secondaryColor = isFinancial ? "#34d399" : "#fbbf24"; // Emerald or Amber

	const svgHtml = `
		<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none" style="overflow: visible;">
			<defs>
				<linearGradient id="primaryGrad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="${primaryColor}" stop-opacity="0.35" />
					<stop offset="100%" stop-color="${primaryColor}" stop-opacity="0.0" />
				</linearGradient>
			</defs>

			<!-- Grid Lines -->
			${gridLines}

			<!-- Primary Area & Line -->
			<path d="${primaryAreaD}" fill="url(#primaryGrad)" />
			<path d="${primaryPathD}" fill="none" stroke="${primaryColor}" stroke-width="2" stroke-linejoin="round" />

			<!-- Secondary Line -->
			<path d="${secondaryPathD}" fill="none" stroke="${secondaryColor}" stroke-width="2" stroke-linejoin="round" stroke-dasharray="4,3" />

			<!-- X Labels -->
			${xLabels}

			<!-- Scrubber Line (Hidden by default) -->
			<line id="scrub-line" x1="0" y1="${padding.top}" x2="0" y2="${baselineY}" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="2,2" style="display: none; pointer-events: none;" />
			<circle id="scrub-dot-pri" r="4.5" fill="${primaryColor}" stroke="#ffffff" stroke-width="1.5" style="display: none; pointer-events: none;" />
			<circle id="scrub-dot-sec" r="4.5" fill="${secondaryColor}" stroke="#ffffff" stroke-width="1.5" style="display: none; pointer-events: none;" />
		</svg>
	`;

	container.innerHTML = svgHtml;

	const svg = container.querySelector("svg");
	if (!svg) return;

	const scrubLine = svg.querySelector<SVGLineElement>("#scrub-line");
	const dotPri = svg.querySelector<SVGCircleElement>("#scrub-dot-pri");
	const dotSec = svg.querySelector<SVGCircleElement>("#scrub-dot-sec");

	function handleInteraction(clientX: number) {
		if (!svg || !scrubLine || !dotPri || !dotSec) return;
		const rect = svg.getBoundingClientRect();
		const relX = clientX - rect.left;
		const svgX = (relX / rect.width) * width;

		// Find closest data point
		const normalizedX = (svgX - padding.left) / chartW;
		const index = Math.max(
			0,
			Math.min(data.length - 1, Math.round(normalizedX * (data.length - 1))),
		);
		const item = data[index];
		if (!item) return;

		const ptX = getX(index);
		const ptYPri = getYPrimary(isFinancial ? item.value : item.count);
		const ptYSec = getYSecondary(isFinancial ? item.efficiency : item.nerve);

		scrubLine.setAttribute("x1", ptX.toFixed(1));
		scrubLine.setAttribute("x2", ptX.toFixed(1));
		scrubLine.style.display = "block";

		dotPri.setAttribute("cx", ptX.toFixed(1));
		dotPri.setAttribute("cy", ptYPri.toFixed(1));
		dotPri.style.display = "block";

		dotSec.setAttribute("cx", ptX.toFixed(1));
		dotSec.setAttribute("cy", ptYSec.toFixed(1));
		dotSec.style.display = "block";

		if (onScrub) {
			onScrub(item);
		}
	}

	function resetInteraction() {
		if (!scrubLine || !dotPri || !dotSec) return;
		scrubLine.style.display = "none";
		dotPri.style.display = "none";
		dotSec.style.display = "none";
		if (onScrub) {
			onScrub(null);
		}
	}

	svg.addEventListener("mousemove", (e) => handleInteraction(e.clientX));
	svg.addEventListener("mouseleave", resetInteraction);
	svg.addEventListener(
		"touchmove",
		(e) => {
			const touch = e.touches[0];
			if (touch) handleInteraction(touch.clientX);
		},
		{ passive: true },
	);
	svg.addEventListener("touchend", resetInteraction);
}

export interface BattlestatsChartRenderOptions {
	data: DailyBattlestatsTimeline[];
	mode: "stats" | "energy";
	width?: number;
	height?: number;
	onScrub?: (item: DailyBattlestatsTimeline | null) => void;
}

export function renderBattlestatsSvgChart(
	container: HTMLElement,
	options: BattlestatsChartRenderOptions,
): void {
	const { data, mode, width = 600, height = 220, onScrub } = options;

	container.innerHTML = "";

	if (!data || data.length === 0) {
		container.innerHTML = `
			<div style="height: ${height}px; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 12px; font-family: monospace;">
				No battlestats training timeline recorded for this timeframe.
			</div>
		`;
		return;
	}

	const padding = {
		top: 20,
		right: mode === "energy" ? 55 : 20,
		bottom: 35,
		left: 55,
	};
	const chartW = width - padding.left - padding.right;
	const chartH = height - padding.top - padding.bottom;

	const getX = (i: number) =>
		padding.left + (i / Math.max(data.length - 1, 1)) * chartW;

	let svgContent = "";

	if (mode === "stats") {
		// Multi-series lines for Strength, Defense, Speed, Dexterity
		const maxStat = Math.max(
			...data.flatMap((d) => [d.strength, d.defense, d.speed, d.dexterity]),
			1,
		);
		const getY = (val: number) =>
			padding.top + chartH - (val / maxStat) * chartH;

		// Build grid lines
		for (let i = 0; i <= 4; i++) {
			const y = padding.top + (i / 4) * chartH;
			const val = maxStat - (i / 4) * maxStat;
			svgContent += `
				<line x1="${padding.left}" y1="${y}" x2="${padding.left + chartW}" y2="${y}" stroke="#334155" stroke-dasharray="3,3" stroke-width="1" />
				<text x="${padding.left - 8}" y="${y + 4}" fill="#64748b" font-size="9" text-anchor="end" font-family="monospace">${formatNumber(val)}</text>
			`;
		}

		// Build paths for each stat
		const statsConfig = [
			{ key: "strength" as const, color: "#f97316" },
			{ key: "defense" as const, color: "#06b6d4" },
			{ key: "speed" as const, color: "#10b981" },
			{ key: "dexterity" as const, color: "#a855f7" },
		];

		statsConfig.forEach((cfg) => {
			let pathD = "";
			for (let i = 0; i < data.length; i++) {
				const item = data[i];
				if (!item) continue;
				const x = getX(i);
				const y = getY(item[cfg.key]);
				if (i === 0) pathD += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
				else pathD += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
			}
			svgContent += `<path d="${pathD}" fill="none" stroke="${cfg.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
		});
	} else {
		// Gains vs Energy mode (dual axis)
		const maxGain = Math.max(...data.map((d) => d.totalGained), 1);
		const maxEnergy = Math.max(...data.map((d) => d.energyUsed), 1);

		const getYGain = (val: number) =>
			padding.top + chartH - (val / maxGain) * chartH;
		const getYEnergy = (val: number) =>
			padding.top + chartH - (val / maxEnergy) * chartH;

		// Horizontal grid lines
		for (let i = 0; i <= 4; i++) {
			const y = padding.top + (i / 4) * chartH;
			const gainVal = maxGain - (i / 4) * maxGain;
			const energyVal = maxEnergy - (i / 4) * maxEnergy;
			svgContent += `
				<line x1="${padding.left}" y1="${y}" x2="${padding.left + chartW}" y2="${y}" stroke="#334155" stroke-dasharray="3,3" stroke-width="1" />
				<text x="${padding.left - 8}" y="${y + 4}" fill="#38bdf8" font-size="9" text-anchor="end" font-family="monospace">${formatNumber(gainVal)}</text>
				<text x="${padding.left + chartW + 8}" y="${y + 4}" fill="#f59e0b" font-size="9" text-anchor="start" font-family="monospace">${Math.round(energyVal)}E</text>
			`;
		}

		let gainAreaD = "";
		let gainLineD = "";
		let energyLineD = "";

		for (let i = 0; i < data.length; i++) {
			const item = data[i];
			if (!item) continue;
			const x = getX(i);
			const yG = getYGain(item.totalGained);
			const yE = getYEnergy(item.energyUsed);

			if (i === 0) {
				gainLineD += `M ${x.toFixed(1)} ${yG.toFixed(1)}`;
				gainAreaD += `M ${x.toFixed(1)} ${(padding.top + chartH).toFixed(1)} L ${x.toFixed(1)} ${yG.toFixed(1)}`;
				energyLineD += `M ${x.toFixed(1)} ${yE.toFixed(1)}`;
			} else {
				gainLineD += ` L ${x.toFixed(1)} ${yG.toFixed(1)}`;
				gainAreaD += ` L ${x.toFixed(1)} ${yG.toFixed(1)}`;
				energyLineD += ` L ${x.toFixed(1)} ${yE.toFixed(1)}`;
			}
		}

		const lastX = getX(data.length - 1);
		gainAreaD += ` L ${lastX.toFixed(1)} ${(padding.top + chartH).toFixed(1)} Z`;

		svgContent += `
			<defs>
				<linearGradient id="battlestats-gain-grad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3" />
					<stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0" />
				</linearGradient>
			</defs>
			<path d="${gainAreaD}" fill="url(#battlestats-gain-grad)" />
			<path d="${gainLineD}" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" />
			<path d="${energyLineD}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4,3" stroke-linecap="round" />
		`;
	}

	// X-axis date labels
	const isMobile = window.innerWidth < 500;
	const labelStep = Math.max(1, Math.floor(data.length / (isMobile ? 3 : 6)));
	for (let i = 0; i < data.length; i += labelStep) {
		const item = data[i];
		if (!item) continue;
		const x = getX(i);
		const y = padding.top + chartH + 18;
		const rawDate = item.date;
		const parts = rawDate.split("-");
		const dateLabel = parts.length >= 3 ? `${parts[1]}/${parts[2]}` : rawDate;

		svgContent += `
			<text x="${x}" y="${y}" fill="#64748b" font-size="9" text-anchor="middle" font-family="monospace">${dateLabel}</text>
		`;
	}

	// Dynamic scrubber overlay elements
	svgContent += `
		<line id="bs-scrub-line" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + chartH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,2" style="display: none;" />
		<circle id="bs-dot-active" cx="0" cy="0" r="4" fill="#38bdf8" stroke="#0f172a" stroke-width="2" style="display: none;" />
	`;

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("width", "100%");
	svg.setAttribute("height", "100%");
	svg.style.overflow = "visible";
	svg.style.userSelect = "none";
	svg.innerHTML = svgContent;

	container.appendChild(svg);

	const scrubLine = svg.querySelector<SVGLineElement>("#bs-scrub-line");
	const dotActive = svg.querySelector<SVGCircleElement>("#bs-dot-active");

	function handleInteraction(clientX: number) {
		if (!scrubLine || !dotActive) return;
		const rect = svg.getBoundingClientRect();
		const svgX = ((clientX - rect.left) / rect.width) * width;
		const clampedX = Math.max(
			padding.left,
			Math.min(padding.left + chartW, svgX),
		);

		const index = Math.round(
			((clampedX - padding.left) / chartW) * (data.length - 1),
		);
		const item = data[index];
		if (!item) return;

		const ptX = getX(index);
		scrubLine.setAttribute("x1", ptX.toFixed(1));
		scrubLine.setAttribute("x2", ptX.toFixed(1));
		scrubLine.style.display = "block";

		const maxTotal = Math.max(...data.map((d) => d.totalGained), 1);
		const ptY = padding.top + chartH - (item.totalGained / maxTotal) * chartH;
		dotActive.setAttribute("cx", ptX.toFixed(1));
		dotActive.setAttribute("cy", ptY.toFixed(1));
		dotActive.style.display = "block";

		if (onScrub) {
			onScrub(item);
		}
	}

	function resetInteraction() {
		if (!scrubLine || !dotActive) return;
		scrubLine.style.display = "none";
		dotActive.style.display = "none";
		if (onScrub) {
			onScrub(null);
		}
	}

	svg.addEventListener("mousemove", (e) => handleInteraction(e.clientX));
	svg.addEventListener("mouseleave", resetInteraction);
	svg.addEventListener(
		"touchmove",
		(e) => {
			const touch = e.touches[0];
			if (touch) handleInteraction(touch.clientX);
		},
		{ passive: true },
	);
	svg.addEventListener("touchend", resetInteraction);
}

export interface CompanyChartRenderOptions {
	data: CompanyHistoryEntry[];
	mode: "financials" | "production";
	width?: number;
	height?: number;
	onScrub?: (item: CompanyHistoryEntry | null) => void;
}

export function renderCompanySvgChart(
	container: HTMLElement,
	options: CompanyChartRenderOptions,
): void {
	const { data, mode, width = 600, height = 220, onScrub } = options;

	container.innerHTML = "";

	if (!data || data.length === 0) {
		container.innerHTML = `
			<div style="height: ${height}px; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 12px; font-family: monospace;">
				No historical company snapshots recorded yet.
			</div>
		`;
		return;
	}

	const padding = { top: 20, right: 20, bottom: 35, left: 55 };
	const chartW = width - padding.left - padding.right;
	const chartH = height - padding.top - padding.bottom;
	const baselineY = padding.top + chartH;

	const isFinancial = mode === "financials";

	let minVal = 0;
	let maxVal = 1;

	if (isFinancial) {
		const allVals = data.flatMap((d) => [d.income, d.expenses, d.profit]);
		minVal = Math.min(0, ...allVals);
		maxVal = Math.max(1, ...allVals);
	} else {
		const allVals = data.flatMap((d) => [d.stock, d.produced, d.sold]);
		minVal = 0;
		maxVal = Math.max(1, ...allVals);
	}

	const range = maxVal - minVal || 1;

	const getX = (i: number) =>
		padding.left + (i / Math.max(data.length - 1, 1)) * chartW;
	const getY = (val: number) =>
		padding.top + chartH - ((val - minVal) / range) * chartH;

	// Grid lines & Y labels
	let gridLines = "";
	const steps = 4;
	for (let i = 0; i <= steps; i++) {
		const y = padding.top + (i / steps) * chartH;
		const val = maxVal - (i / steps) * range;
		const label = isFinancial ? formatMoney(val) : formatCompactNumber(val, 0);

		gridLines += `
			<line x1="${padding.left}" y1="${y}" x2="${padding.left + chartW}" y2="${y}" stroke="#334155" stroke-dasharray="3,3" stroke-width="1" />
			<text x="${padding.left - 8}" y="${y + 4}" fill="#64748b" font-size="9" text-anchor="end" font-family="monospace">${label}</text>
		`;
	}

	// Zero line if minVal < 0
	if (minVal < 0) {
		const zeroY = getY(0);
		gridLines += `
			<line x1="${padding.left}" y1="${zeroY}" x2="${padding.left + chartW}" y2="${zeroY}" stroke="#475569" stroke-width="1.5" />
		`;
	}

	// Paths
	let path1D = "";
	let path2D = "";
	let path3D = "";
	let areaProfitD = "";

	for (let i = 0; i < data.length; i++) {
		const item = data[i];
		if (!item) continue;
		const x = getX(i);

		if (isFinancial) {
			const yInc = getY(item.income);
			const yExp = getY(item.expenses);
			const yProf = getY(item.profit);

			if (i === 0) {
				path1D += `M ${x.toFixed(1)} ${yInc.toFixed(1)}`;
				path2D += `M ${x.toFixed(1)} ${yExp.toFixed(1)}`;
				path3D += `M ${x.toFixed(1)} ${yProf.toFixed(1)}`;
				areaProfitD += `M ${x.toFixed(1)} ${getY(0).toFixed(1)} L ${x.toFixed(1)} ${yProf.toFixed(1)}`;
			} else {
				path1D += ` L ${x.toFixed(1)} ${yInc.toFixed(1)}`;
				path2D += ` L ${x.toFixed(1)} ${yExp.toFixed(1)}`;
				path3D += ` L ${x.toFixed(1)} ${yProf.toFixed(1)}`;
				areaProfitD += ` L ${x.toFixed(1)} ${yProf.toFixed(1)}`;
			}
		} else {
			const yStock = getY(item.stock);
			const ySold = getY(item.sold);
			const yProd = getY(item.produced);

			if (i === 0) {
				path1D += `M ${x.toFixed(1)} ${yStock.toFixed(1)}`;
				path2D += `M ${x.toFixed(1)} ${ySold.toFixed(1)}`;
				path3D += `M ${x.toFixed(1)} ${yProd.toFixed(1)}`;
			} else {
				path1D += ` L ${x.toFixed(1)} ${yStock.toFixed(1)}`;
				path2D += ` L ${x.toFixed(1)} ${ySold.toFixed(1)}`;
				path3D += ` L ${x.toFixed(1)} ${yProd.toFixed(1)}`;
			}
		}
	}

	if (isFinancial && data.length > 0) {
		const lastX = getX(data.length - 1);
		const zeroY = getY(0);
		areaProfitD += ` L ${lastX.toFixed(1)} ${zeroY.toFixed(1)} Z`;
	}

	// Date labels along X axis
	const isMobile = typeof window !== "undefined" && window.innerWidth < 500;
	const labelStep = Math.max(1, Math.floor(data.length / (isMobile ? 3 : 6)));
	let xLabels = "";
	for (let i = 0; i < data.length; i += labelStep) {
		const item = data[i];
		if (!item) continue;
		const x = getX(i);
		const dateObj = new Date(
			item.isoDate.length === 10 ? `${item.isoDate}T00:00:00` : item.isoDate,
		);
		const dateStr = !Number.isNaN(dateObj.getTime())
			? dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" })
			: item.isoDate.slice(5);
		xLabels += `
			<text x="${x}" y="${baselineY + 18}" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="monospace">${dateStr}</text>
		`;
	}

	const color1 = isFinancial ? "#10b981" : "#a855f7"; // Income (green) or Stock (purple)
	const color2 = isFinancial ? "#f43f5e" : "#f59e0b"; // Expenses (rose) or Sold (amber)
	const color3 = isFinancial ? "#38bdf8" : "#38bdf8"; // Profit (sky) or Produced (sky)

	const svgHtml = `
		<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none" style="overflow: visible;">
			<defs>
				<linearGradient id="comp-profit-grad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3" />
					<stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0" />
				</linearGradient>
			</defs>

			<!-- Grid Lines -->
			${gridLines}

			<!-- Area under profit (financials only) -->
			${isFinancial ? `<path d="${areaProfitD}" fill="url(#comp-profit-grad)" />` : ""}

			<!-- Series Lines -->
			<path d="${path1D}" fill="none" stroke="${color1}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			<path d="${path2D}" fill="none" stroke="${color2}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${isFinancial ? "4,3" : "none"}" />
			<path d="${path3D}" fill="none" stroke="${color3}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />

			<!-- X Labels -->
			${xLabels}

			<!-- Scrubber Line and Dots (matching Crimes chart) -->
			<line id="comp-scrub-line" x1="0" y1="${padding.top}" x2="0" y2="${baselineY}" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="2,2" style="display: none; pointer-events: none;" />
			<circle id="comp-dot-1" r="4.5" fill="${color1}" stroke="#ffffff" stroke-width="1.5" style="display: none; pointer-events: none;" />
			<circle id="comp-dot-2" r="4.5" fill="${color2}" stroke="#ffffff" stroke-width="1.5" style="display: none; pointer-events: none;" />
			<circle id="comp-dot-3" r="4.5" fill="${color3}" stroke="#ffffff" stroke-width="1.5" style="display: none; pointer-events: none;" />
		</svg>
	`;

	container.innerHTML = svgHtml;

	const svg = container.querySelector("svg");
	if (!svg) return;

	const scrubLine = svg.querySelector<SVGLineElement>("#comp-scrub-line");
	const dot1 = svg.querySelector<SVGCircleElement>("#comp-dot-1");
	const dot2 = svg.querySelector<SVGCircleElement>("#comp-dot-2");
	const dot3 = svg.querySelector<SVGCircleElement>("#comp-dot-3");

	function handleInteraction(clientX: number) {
		if (!svg || !scrubLine || !dot1 || !dot2 || !dot3) return;
		const rect = svg.getBoundingClientRect();
		const relX = clientX - rect.left;
		const svgX = (relX / rect.width) * width;

		// Find closest data point
		const normalizedX = (svgX - padding.left) / chartW;
		const index = Math.max(
			0,
			Math.min(data.length - 1, Math.round(normalizedX * (data.length - 1))),
		);
		const item = data[index];
		if (!item) return;

		const ptX = getX(index);
		scrubLine.setAttribute("x1", ptX.toFixed(1));
		scrubLine.setAttribute("x2", ptX.toFixed(1));
		scrubLine.style.display = "block";

		if (isFinancial) {
			dot1.setAttribute("cx", ptX.toFixed(1));
			dot1.setAttribute("cy", getY(item.income).toFixed(1));
			dot1.style.display = "block";

			dot2.setAttribute("cx", ptX.toFixed(1));
			dot2.setAttribute("cy", getY(item.expenses).toFixed(1));
			dot2.style.display = "block";

			dot3.setAttribute("cx", ptX.toFixed(1));
			dot3.setAttribute("cy", getY(item.profit).toFixed(1));
			dot3.style.display = "block";
		} else {
			dot1.setAttribute("cx", ptX.toFixed(1));
			dot1.setAttribute("cy", getY(item.stock).toFixed(1));
			dot1.style.display = "block";

			dot2.setAttribute("cx", ptX.toFixed(1));
			dot2.setAttribute("cy", getY(item.sold).toFixed(1));
			dot2.style.display = "block";

			dot3.setAttribute("cx", ptX.toFixed(1));
			dot3.setAttribute("cy", getY(item.produced).toFixed(1));
			dot3.style.display = "block";
		}

		if (onScrub) {
			onScrub(item);
		}
	}

	function resetInteraction() {
		if (!scrubLine || !dot1 || !dot2 || !dot3) return;
		scrubLine.style.display = "none";
		dot1.style.display = "none";
		dot2.style.display = "none";
		dot3.style.display = "none";
		if (onScrub) {
			onScrub(null);
		}
	}

	svg.addEventListener("mousemove", (e) => handleInteraction(e.clientX));
	svg.addEventListener("mouseleave", resetInteraction);
	svg.addEventListener(
		"touchmove",
		(e) => {
			const touch = e.touches[0];
			if (touch) handleInteraction(touch.clientX);
		},
		{ passive: true },
	);
	svg.addEventListener("touchend", resetInteraction);
}
