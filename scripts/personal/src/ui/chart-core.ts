/**
 * One line chart, rendered once.
 *
 * The drawer had three ~200-line chart renderers (crimes, battlestats, company)
 * that were the same function written three times: identical padding and scaling,
 * identical grid and axis labels, identical path assembly, and three copies of the
 * same mouse/touch scrubber. They had already drifted apart — one computed its
 * scrubber's Y position from a differently-scaled maximum, so the dot floated at a
 * meaningless height — and every fix had to be made three times.
 *
 * This is the single implementation. Each dashboard maps its payload onto a
 * `LineChartOptions` and keeps its own readout formatting.
 *
 * Accessibility: the chart is a focusable `role="img"` with a description, and the
 * scrubber can be driven with the arrow keys, Home, End and Escape — the values a
 * pointer user reads from the strip are reachable without a mouse.
 */

export interface ChartSeries {
	key: string;
	/** Shown in the legend and the accessible description. */
	label: string;
	color: string;
	values: readonly number[];
	/** Fill under this series down to the baseline. */
	area?: boolean;
	/** Dash the stroke, for a series measured on the other axis. */
	dashed?: boolean;
	/** Which axis scales this series. Defaults to "primary". */
	axis?: "primary" | "secondary";
	/** Draw a scrub dot for this series. Defaults to true. */
	dot?: boolean;
}

export interface LineChartOptions {
	series: readonly ChartSeries[];
	/** One X label per data point, already formatted. */
	labels: readonly string[];
	/** What this chart shows, for screen readers. */
	ariaLabel: string;
	emptyMessage: string;
	width?: number;
	height?: number;
	/** Formats a value on the left axis, for its grid labels. */
	formatPrimary?: (value: number) => string;
	/** Formats a value on the right axis. Only used when a series uses it. */
	formatSecondary?: (value: number) => string;
	/** Let the primary axis dip below zero (profit can be negative). */
	allowNegative?: boolean;
	/** Draw a solid line at zero when the primary axis spans it. */
	zeroLine?: boolean;
	/** Stretch the viewBox to the container width, as the older charts did. */
	stretch?: boolean;
	/** Called with the data index under the pointer or caret, null when released. */
	onScrub?: (index: number | null) => void;
}

const PADDING = { top: 20, right: 20, rightAxis: 55, bottom: 35, left: 55 };
const GRID_STEPS = 4;
/** Below this width the axis gets fewer labels rather than overlapping ones. */
const COMPACT_WIDTH = 460;

let chartInstance = 0;

/** Maximum of a list, without spreading it into an argument list. */
export function maxOf(values: readonly number[], fallback: number): number {
	let max = fallback;
	for (const value of values) {
		if (Number.isFinite(value) && value > max) max = value;
	}
	return max;
}

/** Minimum of a list, using the same non-spreading form as `maxOf`. */
export function minOf(values: readonly number[], fallback: number): number {
	let min = fallback;
	for (const value of values) {
		if (Number.isFinite(value) && value < min) min = value;
	}
	return min;
}

function pathFromPoints(points: readonly { x: number; y: number }[]): string {
	let path = "";
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		if (!point) continue;
		path +=
			i === 0
				? `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
				: ` L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
	}
	return path;
}

export function renderLineChart(
	container: HTMLElement,
	options: LineChartOptions,
): void {
	const {
		series,
		labels,
		ariaLabel,
		emptyMessage,
		height = 220,
		formatPrimary = (value) => String(Math.round(value)),
		formatSecondary = (value) => String(Math.round(value)),
		allowNegative = false,
		zeroLine = false,
		stretch = false,
		onScrub,
	} = options;

	container.innerHTML = "";

	const pointCount = labels.length;
	if (pointCount === 0 || series.length === 0) {
		container.innerHTML = `
			<div class="chart-empty" style="height: ${height}px;">
				${emptyMessage}
			</div>
		`;
		return;
	}

	const measured = container.clientWidth;
	const width =
		options.width && options.width > 0 ? options.width : measured || 600;
	const compact = width < COMPACT_WIDTH;

	const usesSecondaryAxis = series.some((s) => s.axis === "secondary");
	const padding = {
		top: PADDING.top,
		right: usesSecondaryAxis ? PADDING.rightAxis : PADDING.right,
		bottom: PADDING.bottom,
		left: PADDING.left,
	};
	const chartW = Math.max(1, width - padding.left - padding.right);
	const chartH = Math.max(1, height - padding.top - padding.bottom);
	const baselineY = padding.top + chartH;

	const primaryValues = series
		.filter((s) => s.axis !== "secondary")
		.flatMap((s) => [...s.values]);
	const secondaryValues = series
		.filter((s) => s.axis === "secondary")
		.flatMap((s) => [...s.values]);

	const primaryMin = allowNegative ? Math.min(0, minOf(primaryValues, 0)) : 0;
	const primaryMax = Math.max(
		allowNegative ? primaryMin + 1 : 1,
		maxOf(primaryValues, 1),
	);
	const primaryRange = primaryMax - primaryMin || 1;
	const secondaryMin = 0;
	const secondaryMax = maxOf(secondaryValues, 1);
	const secondaryRange = secondaryMax - secondaryMin || 1;

	const getX = (index: number) =>
		padding.left + (index / Math.max(pointCount - 1, 1)) * chartW;
	const getY = (value: number, axis: "primary" | "secondary") =>
		axis === "secondary"
			? padding.top +
				chartH -
				((value - secondaryMin) / secondaryRange) * chartH
			: padding.top + chartH - ((value - primaryMin) / primaryRange) * chartH;

	// ── Grid, axes and zero line ─────────────────────────────────────────────
	let grid = "";
	for (let step = 0; step <= GRID_STEPS; step++) {
		const y = padding.top + (step / GRID_STEPS) * chartH;
		const primaryValue = primaryMax - (step / GRID_STEPS) * primaryRange;
		grid += `
			<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${(padding.left + chartW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#334155" stroke-dasharray="3,3" stroke-width="1" />
			<text x="${padding.left - 8}" y="${(y + 4).toFixed(1)}" fill="#94a3b8" font-size="${compact ? 9 : 10}" text-anchor="end" font-family="monospace">${formatPrimary(primaryValue)}</text>
		`;
		if (usesSecondaryAxis) {
			const secondaryValue =
				secondaryMax - (step / GRID_STEPS) * secondaryRange;
			grid += `
				<text x="${(padding.left + chartW + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="#f59e0b" font-size="${compact ? 9 : 10}" text-anchor="start" font-family="monospace">${formatSecondary(secondaryValue)}</text>
			`;
		}
	}

	if ((zeroLine || allowNegative) && primaryMin < 0) {
		const zeroY = getY(0, "primary");
		grid += `
			<line x1="${padding.left}" y1="${zeroY.toFixed(1)}" x2="${(padding.left + chartW).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="#475569" stroke-width="1.5" />
		`;
	}

	// ── X labels ─────────────────────────────────────────────────────────────
	const labelCount = compact ? 3 : 6;
	const labelStep = Math.max(1, Math.floor(pointCount / labelCount));
	let xLabels = "";
	for (let i = 0; i < pointCount; i += labelStep) {
		const label = labels[i];
		if (label === undefined) continue;
		xLabels += `
			<text x="${getX(i).toFixed(1)}" y="${baselineY + 18}" fill="#94a3b8" font-size="${compact ? 9 : 10}" text-anchor="middle" font-family="monospace">${label}</text>
		`;
	}

	// ── Series ───────────────────────────────────────────────────────────────
	const instance = ++chartInstance;
	const gradients: string[] = [];
	const painted: string[] = [];
	const dotCircleIds: Array<{
		key: string;
		color: string;
		axis: "primary" | "secondary";
	}> = [];

	for (const spec of series) {
		const axis = spec.axis ?? "primary";
		const points = spec.values.map((value, index) => ({
			x: getX(index),
			y: getY(value, axis),
		}));

		if (spec.area) {
			const gradientId = `chart-grad-${instance}-${spec.key}`;
			gradients.push(`
				<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="${spec.color}" stop-opacity="0.32" />
					<stop offset="100%" stop-color="${spec.color}" stop-opacity="0.0" />
				</linearGradient>
			`);
			const floor = getY(allowNegative ? 0 : primaryMin, axis);
			const first = points[0];
			const last = points[points.length - 1];
			if (first && last) {
				const areaPath = `${pathFromPoints(points)} L ${last.x.toFixed(1)} ${floor.toFixed(1)} L ${first.x.toFixed(1)} ${floor.toFixed(1)} Z`;
				painted.push(`<path d="${areaPath}" fill="url(#${gradientId})" />`);
			}
		}

		painted.push(`
			<path d="${pathFromPoints(points)}" fill="none" stroke="${spec.color}" stroke-width="2"
				stroke-linecap="round" stroke-linejoin="round"
				${spec.dashed ? 'stroke-dasharray="4,3"' : ""} />
		`);

		if (spec.dot !== false) {
			dotCircleIds.push({ key: spec.key, color: spec.color, axis });
		}
	}

	const dots = dotCircleIds
		.map(
			(dot) => `
			<circle class="chart-scrub-dot" data-series="${dot.key}" r="4.5" fill="${dot.color}"
				stroke="#0f172a" stroke-width="1.5" style="display: none; pointer-events: none;" />
		`,
		)
		.join("");

	const svgId = `chart-svg-${instance}`;
	const svgHtml = `
		<svg id="${svgId}" viewBox="0 0 ${width} ${height}" class="chart-svg chart-focusable"
			${stretch ? 'preserveAspectRatio="none"' : ""}
			role="img" aria-label="${ariaLabel}" tabindex="0">
			<defs>${gradients.join("")}</defs>
			${grid}
			${painted.join("")}
			${xLabels}
			<line class="chart-scrub-line" x1="0" y1="${padding.top}" x2="0" y2="${baselineY}"
				stroke="#ffffff" stroke-width="1.5" stroke-dasharray="2,2" style="display: none; pointer-events: none;" />
			${dots}
		</svg>
	`;

	container.innerHTML = svgHtml;

	const svg = container.querySelector("svg");
	if (!svg) return;

	const scrubLine = svg.querySelector<SVGLineElement>(".chart-scrub-line");
	const dotElements = new Map<string, SVGCircleElement>();
	svg
		.querySelectorAll<SVGCircleElement>(".chart-scrub-dot")
		.forEach((circle) => {
			const key = circle.getAttribute("data-series");
			if (key) dotElements.set(key, circle);
		});

	let activeIndex: number | null = null;

	const showIndex = (index: number): void => {
		const clamped = Math.max(0, Math.min(pointCount - 1, index));
		const x = getX(clamped);
		activeIndex = clamped;

		if (scrubLine) {
			scrubLine.setAttribute("x1", x.toFixed(1));
			scrubLine.setAttribute("x2", x.toFixed(1));
			scrubLine.style.display = "block";
		}

		for (const spec of series) {
			const circle = dotElements.get(spec.key);
			if (!circle) continue;
			const value = spec.values[clamped];
			if (value === undefined) {
				circle.style.display = "none";
				continue;
			}
			circle.setAttribute("cx", x.toFixed(1));
			circle.setAttribute("cy", getY(value, spec.axis ?? "primary").toFixed(1));
			circle.style.display = "block";
		}

		onScrub?.(clamped);
	};

	const clear = (): void => {
		activeIndex = null;
		if (scrubLine) scrubLine.style.display = "none";
		for (const circle of dotElements.values()) {
			circle.style.display = "none";
		}
		onScrub?.(null);
	};

	/** Maps a pointer position onto the nearest data point. */
	const indexFromClientX = (clientX: number): number => {
		const rect = svg.getBoundingClientRect();
		if (rect.width <= 0) return 0;
		const svgX = ((clientX - rect.left) / rect.width) * width;
		const normalized = (svgX - padding.left) / chartW;
		return Math.round(normalized * (pointCount - 1));
	};

	svg.addEventListener("mousemove", (event) => {
		showIndex(indexFromClientX(event.clientX));
	});
	svg.addEventListener("mouseleave", clear);
	svg.addEventListener(
		"touchmove",
		(event) => {
			const touch = event.touches[0];
			if (touch) showIndex(indexFromClientX(touch.clientX));
		},
		{ passive: true },
	);
	svg.addEventListener("touchend", clear);
	svg.addEventListener("blur", clear);

	// Keyboard scrubbing: the same readout, without a pointer.
	svg.addEventListener("keydown", (event) => {
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const step = event.key === "ArrowRight" ? 1 : -1;
			const base = activeIndex ?? (step > 0 ? -1 : pointCount);
			showIndex(base + step);
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			showIndex(0);
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			showIndex(pointCount - 1);
			return;
		}
		if (event.key === "Escape") {
			clear();
		}
	});
}
