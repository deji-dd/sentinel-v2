const RESET = "\x1b[0m";

// Distinct fixed colors for the 3 core parent services
const PARENT_COLORS: Record<string, string> = {
	api: "\x1b[38;5;51m", // Bright Cyan
	"discord bot": "\x1b[38;5;75m", // Vibrant Blue
	scheduler: "\x1b[38;5;141m", // Rich Purple
};
const FALLBACK_PARENT_COLOR = "\x1b[97m"; // Bright White

// Vibrant child palette (allocated independently per parent)
const CHILD_PALETTE = [
	"\x1b[38;5;214m", // Amber / Orange
	"\x1b[38;5;120m", // Bright Mint Green
	"\x1b[38;5;213m", // Neon Pink
	"\x1b[38;5;87m", // Soft Cyan / Turquoise
	"\x1b[38;5;221m", // Warm Gold
	"\x1b[38;5;177m", // Lavender / Soft Violet
	"\x1b[38;5;203m", // Coral Red
	"\x1b[38;5;153m", // Ice Blue
	"\x1b[38;5;190m", // Lime Yellow
	"\x1b[38;5;209m", // Salmon Peach
] as const;

// Per-parent registry so children under the same parent never share colors,
// but children across different parents can use the palette independently.
const parentChildColorRegistry = new Map<string, Map<string, string>>();
const parentChildIndex = new Map<string, number>();

function getParentColor(context: string): string {
	const key = context.toLowerCase();
	for (const [parentName, color] of Object.entries(PARENT_COLORS)) {
		if (key.includes(parentName)) {
			return color;
		}
	}
	return FALLBACK_PARENT_COLOR;
}

function getChildColor(parentContext: string, subContext: string): string {
	const parentKey = parentContext.toLowerCase();
	let childMap = parentChildColorRegistry.get(parentKey);
	if (!childMap) {
		childMap = new Map<string, string>();
		parentChildColorRegistry.set(parentKey, childMap);
	}

	const existing = childMap.get(subContext);
	if (existing) {
		return existing;
	}

	const currentIndex = parentChildIndex.get(parentKey) ?? 0;
	const fallbackColor = CHILD_PALETTE[0];
	const color =
		CHILD_PALETTE[currentIndex % CHILD_PALETTE.length] ?? fallbackColor;
	parentChildIndex.set(parentKey, currentIndex + 1);
	childMap.set(subContext, color);
	return color;
}

const LEVEL_COLORS: Record<string, string> = {
	INFO: "\x1b[32m", // Green
	WARN: "\x1b[33m", // Yellow
	ERROR: "\x1b[31m", // Red
	DEBUG: "\x1b[35m", // Magenta
};

export type LogLevel = "info" | "warn" | "error" | "debug";

const pad2 = (value: number): string =>
	value < 10 ? `0${value}` : String(value);

/**
 * Builds a sortable `YYYY-MM-DD HH:MM:SS` wall-clock timestamp.
 *
 * Deliberately manual rather than `toLocaleString`/`toLocaleTimeString`: the
 * `Intl` path costs ~64us per call for the options-object form and ~2us without,
 * against ~0.3us here, and it is paid on every log line of every service.
 * The timestamp is only ever displayed, never parsed.
 */
function formatTimestamp(now: Date): string {
	return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
		now.getDate(),
	)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

export class Logger {
	readonly context: string;
	readonly subContext?: string;
	private parentColor: string;
	private childColor?: string;
	/** Precomputed ANSI prefix for the context/sub-context tags. */
	private readonly tagPrefix: string;

	constructor(
		context: string,
		subContextOrColor?: string,
		processColor?: string,
	) {
		this.context = context;

		if (subContextOrColor?.startsWith("\x1b")) {
			this.subContext = undefined;
			this.parentColor = subContextOrColor;
		} else {
			this.subContext = subContextOrColor;
			this.parentColor = processColor ?? getParentColor(context);
			if (this.subContext) {
				this.childColor = getChildColor(this.context, this.subContext);
			}
		}

		const subTag =
			this.subContext && this.childColor
				? `${this.childColor}[${this.subContext}] ${RESET}`
				: "";
		this.tagPrefix = `${this.parentColor}[${this.context}] ${subTag}`;
	}

	/**
	 * Creates a child logger with a dedicated sub-context (e.g. `logger.child("AbroadStocks")`).
	 */
	child(subContext: string, customChildColor?: string): Logger {
		const childLogger = new Logger(this.context, subContext, this.parentColor);
		if (customChildColor) {
			childLogger.childColor = customChildColor;
		}
		return childLogger;
	}

	private formatMessage(level: string, message: string): string {
		const LEVEL_COLOR = LEVEL_COLORS[level] ?? RESET;
		return `[${formatTimestamp(new Date())}] ${LEVEL_COLOR}[${level}] ${RESET}${this.tagPrefix}${RESET}${message}`;
	}

	info(message: string, ...meta: unknown[]): void {
		console.log(this.formatMessage("INFO", message), ...meta);
	}

	warn(message: string, ...meta: unknown[]): void {
		console.warn(this.formatMessage("WARN", message), ...meta);
	}

	error(message: string, error?: unknown): void {
		if (error !== undefined) {
			console.error(this.formatMessage("ERROR", message), error);
		} else {
			console.error(this.formatMessage("ERROR", message));
		}
	}

	debug(message: string, ...meta: unknown[]): void {
		if (process.env.NODE_ENV !== "production") {
			console.debug(this.formatMessage("DEBUG", message), ...meta);
		}
	}

	/**
	 * Times a unit of work and logs a single completion line.
	 *
	 * The start line is `debug` so production emits one line per timed cycle
	 * rather than a spurious WARN followed by an INFO.
	 */
	time(label = "Starting"): () => void {
		this.debug(label);
		const start = performance.now();
		return () => {
			const durationMs = performance.now() - start;
			let formattedDuration = "";

			if (durationMs >= 60000) {
				formattedDuration = `${(durationMs / 60000).toFixed(2)}m`;
			} else if (durationMs >= 1000) {
				formattedDuration = `${(durationMs / 1000).toFixed(2)}s`;
			} else {
				formattedDuration = `${durationMs.toFixed(2)}ms`;
			}

			this.info(`Completed in ${formattedDuration}`);
		};
	}
}
