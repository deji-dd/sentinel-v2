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

export interface LogEntry {
	id: string;
	timestamp: string;
	service: "api" | "bot" | "scheduler";
	context: string;
	subContext?: string;
	level: LogLevel;
	message: string;
}

let logCounter = 0;
const MAX_RECENT_LOGS = 100;
const ringBuffer: LogEntry[] = [];
const logSinks = new Set<(entry: LogEntry) => void>();

function inferService(context: string): "api" | "bot" | "scheduler" {
	const c = context.toLowerCase();
	if (
		c.includes("bot") ||
		c.includes("reaction") ||
		c.includes("guild") ||
		c.includes("discord") ||
		c.includes("alert")
	) {
		return "bot";
	}
	if (
		c.includes("worker") ||
		c.includes("scheduler") ||
		c.includes("cron") ||
		c.includes("alliances") ||
		c.includes("stock") ||
		c.includes("territory") ||
		c.includes("verification") ||
		c.includes("job")
	) {
		return "scheduler";
	}
	return "api";
}

export class Logger {
	readonly context: string;
	readonly subContext?: string;
	private parentColor: string;
	private childColor?: string;

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

	private recordLog(
		level: LogLevel,
		rawMessage: string,
		...meta: unknown[]
	): void {
		const now = new Date();
		const timestamp = now.toLocaleTimeString("en-US", { hour12: false });
		let message = rawMessage;

		if (meta.length > 0) {
			const metaStrings = meta.map((m) =>
				typeof m === "object" && m !== null ? JSON.stringify(m) : String(m),
			);
			message = `${rawMessage} ${metaStrings.join(" ")}`;
		}

		const entry: LogEntry = {
			id: `log-${Date.now()}-${++logCounter}`,
			timestamp,
			service: inferService(this.context),
			context: this.context,
			subContext: this.subContext,
			level,
			message,
		};

		if (ringBuffer.length >= MAX_RECENT_LOGS) {
			ringBuffer.shift();
		}
		ringBuffer.push(entry);

		for (const sink of logSinks) {
			try {
				sink(entry);
			} catch {
				// sink listener errors should never break main execution
			}
		}
	}

	private formatMessage(level: string, message: string): string {
		const timestamp = new Date().toLocaleString();
		const LEVEL_COLOR = LEVEL_COLORS[level] ?? RESET;
		const subTag =
			this.subContext && this.childColor
				? `${this.childColor}[${this.subContext}] ${RESET}`
				: "";
		return `[${timestamp}] ${LEVEL_COLOR}[${level}] ${RESET}${this.parentColor}[${this.context}] ${subTag}${RESET}${message}`;
	}

	info(message: string, ...meta: unknown[]): void {
		this.recordLog("info", message, ...meta);
		console.log(this.formatMessage("INFO", message), ...meta);
	}

	warn(message: string, ...meta: unknown[]): void {
		this.recordLog("warn", message, ...meta);
		console.warn(this.formatMessage("WARN", message), ...meta);
	}

	error(message: string, error?: unknown): void {
		this.recordLog("error", message, error);
		if (error !== undefined) {
			console.error(this.formatMessage("ERROR", message), error);
		} else {
			console.error(this.formatMessage("ERROR", message));
		}
	}

	debug(message: string, ...meta: unknown[]): void {
		if (process.env.NODE_ENV !== "production") {
			this.recordLog("debug", message, ...meta);
			console.debug(this.formatMessage("DEBUG", message), ...meta);
		}
	}

	time(): () => void {
		this.warn("Starting");
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

	static addLogSink(sink: (entry: LogEntry) => void): () => void {
		logSinks.add(sink);
		return () => logSinks.delete(sink);
	}

	static getRecentLogs(limit = 40): LogEntry[] {
		return ringBuffer.slice(-limit);
	}
}
