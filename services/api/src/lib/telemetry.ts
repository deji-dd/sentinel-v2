import net from "node:net";
import os from "node:os";
import { asc, db, gte, systemMetrics } from "@sentinel/database";
import type { LogEntry } from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS } from "@sentinel/utils/ipc";

export interface SingleServiceTelemetry {
	id: "api" | "bot" | "scheduler";
	name: string;
	packagePath: string;
	status: "online" | "offline" | "degraded";
	pid: number | null;
	uptimeSeconds: number;
	cpuUsage: number;
	latencyMs: number;
	memory: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		rssMb: number;
		heapUsedMb: number;
	};
	portOrTransport: string;
	protocol: string;
	description: string;
	recentLogs: LogEntry[];
}

export interface FleetTelemetrySnapshot {
	timestamp: string;
	uptime: number;
	host: string;
	platform: string;
	arch: string;
	bunVersion: string;
	environment: string;
	services: SingleServiceTelemetry[];
	healthyCount: number;
	totalServices: number;
	totalMemoryMb: number;
	totalRssMb: number;
	totalHeapUsedMb: number;
	recentLogs: LogEntry[];
}

export interface HistoricalTelemetryPoint {
	timestamp: string;
	timeValue: number;
	formattedTime: string;
	totalRssMb: number;
	totalHeapMb: number;
	apiRssMb: number;
	apiHeapMb: number;
	apiCpu: number;
	apiLatency: number;
	schedulerRssMb: number;
	schedulerHeapMb: number;
	schedulerCpu: number;
	schedulerLatency: number;
	botRssMb: number;
	botHeapMb: number;
	botCpu: number;
	botLatency: number;
}

const NUM_CORES = os.cpus()?.length || 1;
let lastCpuCheck = process.cpuUsage();
let lastCpuTime = performance.now();
let lastCalculatedPercent = 0.5;

function getProcessCpuUsage(): number {
	const currentTime = performance.now();
	const elapsedMs = currentTime - lastCpuTime;
	if (elapsedMs < 250) {
		return lastCalculatedPercent;
	}

	const currentCpu = process.cpuUsage(lastCpuCheck);
	lastCpuCheck = process.cpuUsage();
	lastCpuTime = currentTime;

	const totalMicrosec = currentCpu.user + currentCpu.system;
	const rawPercent = (totalMicrosec / (elapsedMs * 1000 * NUM_CORES)) * 100;
	lastCalculatedPercent = Number(
		Math.max(0.1, Math.min(100, rawPercent)).toFixed(1),
	);
	return lastCalculatedPercent;
}

/**
 * Pings an IPC Unix domain socket service with `action: get_telemetry` and returns its live stats & logs.
 */
function queryIpcService(
	socketPath: string,
	timeoutMs = 600,
): Promise<{
	pid: number | null;
	status: "online" | "offline";
	uptimeSeconds: number;
	latencyMs: number;
	cpuUsage: number;
	memory: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
	};
	recentLogs: LogEntry[];
}> {
	return new Promise((resolve) => {
		const client = net.createConnection(socketPath);
		let resolved = false;
		let buffer = "";
		let startTime = performance.now();

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				client.destroy();
				resolve({
					pid: null,
					status: "offline",
					uptimeSeconds: 0,
					latencyMs: 0,
					cpuUsage: 0,
					memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
					recentLogs: [],
				});
			}
		}, timeoutMs);

		client.on("connect", () => {
			startTime = performance.now();
			const reqId = `telemetry-${Date.now()}`;
			client.write(
				`${JSON.stringify({ action: "get_telemetry", requestId: reqId })}\n`,
			);
		});

		client.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				if (line) {
					try {
						const parsed = JSON.parse(line) as {
							action?: string;
							data?: {
								pid?: number;
								status?: string;
								uptimeSeconds?: number;
								cpuUsage?: number;
								memory?: {
									rssBytes?: number;
									heapUsedBytes?: number;
									heapTotalBytes?: number;
								};
								recentLogs?: LogEntry[];
							};
						};

						if (parsed.action === "get_telemetry_response" && parsed.data) {
							if (!resolved) {
								resolved = true;
								clearTimeout(timeout);
								const latencyMs = Math.max(
									1,
									Math.round(performance.now() - startTime),
								);
								client.end();
								resolve({
									pid: parsed.data.pid ?? null,
									status:
										parsed.data.status === "online" ? "online" : "offline",
									uptimeSeconds: parsed.data.uptimeSeconds ?? 0,
									latencyMs,
									cpuUsage: parsed.data.cpuUsage ?? 1.5,
									memory: {
										rssBytes: parsed.data.memory?.rssBytes ?? 0,
										heapUsedBytes: parsed.data.memory?.heapUsedBytes ?? 0,
										heapTotalBytes: parsed.data.memory?.heapTotalBytes ?? 0,
									},
									recentLogs: Array.isArray(parsed.data.recentLogs)
										? parsed.data.recentLogs
										: [],
								});
							}
						}
					} catch {
						// wait for complete frame
					}
				}
			}
		});

		client.on("error", () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				client.destroy();
				resolve({
					pid: null,
					status: "offline",
					uptimeSeconds: 0,
					latencyMs: 0,
					cpuUsage: 0,
					memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
					recentLogs: [],
				});
			}
		});
	});
}

/**
 * Persists a telemetry snapshot for all services into SQLite system_metrics.
 */
export async function persistTelemetrySnapshot(
	services: SingleServiceTelemetry[],
): Promise<void> {
	try {
		const now = new Date();
		for (const s of services) {
			await db.insert(systemMetrics).values({
				serviceId: s.id,
				serviceName: s.name,
				status: s.status,
				cpuUsage: s.cpuUsage,
				memoryRssBytes: s.memory.rssBytes,
				memoryHeapUsedBytes: s.memory.heapUsedBytes,
				memoryHeapTotalBytes: s.memory.heapTotalBytes,
				latencyMs: s.latencyMs,
				uptimeSeconds: s.uptimeSeconds,
				createdAt: now,
			});
		}
	} catch {
		// Non-blocking telemetry persistence error
	}
}

/**
 * Gathers real-time telemetry across all 3 Sentinel core services:
 * 1. API (local process)
 * 2. Discord Bot (via bot.sock IPC)
 * 3. Scheduler (via worker.sock IPC)
 */
export async function getFleetTelemetry(): Promise<FleetTelemetrySnapshot> {
	const platformName =
		process.platform === "darwin"
			? "MAC"
			: process.platform === "linux"
				? "LINUX"
				: process.platform.toUpperCase();
	const arch = process.arch.toUpperCase();
	const bunVersion =
		typeof Bun !== "undefined" && Bun.version ? Bun.version : process.version;

	// 1. API service stats (in-process)
	const apiMem = process.memoryUsage();
	const apiLogs = Logger.getRecentLogs(30);
	const apiRssMb = Number((apiMem.rss / 1024 / 1024).toFixed(1));
	const apiHeapUsedMb = Number((apiMem.heapUsed / 1024 / 1024).toFixed(1));

	const apiService: SingleServiceTelemetry = {
		id: "api",
		name: "API Gateway",
		packagePath: "services/api",
		status: "online",
		pid: process.pid,
		uptimeSeconds: Math.round(process.uptime()),
		cpuUsage: getProcessCpuUsage(),
		latencyMs: 1,
		memory: {
			rssBytes: apiMem.rss,
			heapUsedBytes: apiMem.heapUsed,
			heapTotalBytes: apiMem.heapTotal,
			rssMb: apiRssMb,
			heapUsedMb: apiHeapUsedMb,
		},
		portOrTransport: "Port 3000",
		protocol: "HTTP/2 • Elysia REST & WebSockets",
		description:
			"High-speed Elysia REST API & WebSockets gateway serving dashboard clients and telemetry streams.",
		recentLogs: apiLogs,
	};

	// 2. Query Bot and Scheduler via IPC in parallel
	const [botIpc, schedulerIpc] = await Promise.all([
		queryIpcService(IPC_SOCKET_PATHS.bot),
		queryIpcService(IPC_SOCKET_PATHS.worker),
	]);

	const botRssMb = Number((botIpc.memory.rssBytes / 1024 / 1024).toFixed(1));
	const botHeapUsedMb = Number(
		(botIpc.memory.heapUsedBytes / 1024 / 1024).toFixed(1),
	);

	const botService: SingleServiceTelemetry = {
		id: "bot",
		name: "Discord Bot",
		packagePath: "services/bot",
		status: botIpc.status,
		pid: botIpc.pid,
		uptimeSeconds: botIpc.uptimeSeconds,
		cpuUsage: botIpc.status === "online" ? botIpc.cpuUsage : 0,
		latencyMs: botIpc.status === "online" ? botIpc.latencyMs : 0,
		memory: {
			...botIpc.memory,
			rssMb: botRssMb,
			heapUsedMb: botHeapUsedMb,
		},
		portOrTransport: "sentinel_bot.sock",
		protocol: "WSS Discord Gateway v10 + IPC",
		description:
			"Discord.js multi-guild gateway engine orchestrating slash commands, territory tracking, and verification workflows.",
		recentLogs: botIpc.recentLogs,
	};

	const schedRssMb = Number(
		(schedulerIpc.memory.rssBytes / 1024 / 1024).toFixed(1),
	);
	const schedHeapUsedMb = Number(
		(schedulerIpc.memory.heapUsedBytes / 1024 / 1024).toFixed(1),
	);

	const schedulerService: SingleServiceTelemetry = {
		id: "scheduler",
		name: "Task Scheduler",
		packagePath: "services/scheduler",
		status: schedulerIpc.status,
		pid: schedulerIpc.pid,
		uptimeSeconds: schedulerIpc.uptimeSeconds,
		cpuUsage: schedulerIpc.status === "online" ? schedulerIpc.cpuUsage : 0,
		latencyMs: schedulerIpc.status === "online" ? schedulerIpc.latencyMs : 0,
		memory: {
			...schedulerIpc.memory,
			rssMb: schedRssMb,
			heapUsedMb: schedHeapUsedMb,
		},
		portOrTransport: "sentinel_worker.sock",
		protocol: "BullMQ • Redis Streams & Cron",
		description:
			"High-reliability distributed job scheduler managing alliance data sync, territory timer alerts, and Torn poller crons.",
		recentLogs: schedulerIpc.recentLogs,
	};

	const services = [apiService, botService, schedulerService];
	const healthyCount = services.filter((s) => s.status === "online").length;
	const totalRssBytes = services.reduce((acc, s) => acc + s.memory.rssBytes, 0);
	const totalHeapBytes = services.reduce(
		(acc, s) => acc + s.memory.heapUsedBytes,
		0,
	);
	const totalMemoryMb = Number((totalRssBytes / 1024 / 1024).toFixed(1));
	const totalRssMb = totalMemoryMb;
	const totalHeapUsedMb = Number((totalHeapBytes / 1024 / 1024).toFixed(1));

	// Combine and sort logs chronologically
	const combinedLogs = [
		...apiService.recentLogs,
		...botService.recentLogs,
		...schedulerService.recentLogs,
	]
		.sort((a, b) => (a.id > b.id ? 1 : -1))
		.slice(-60);

	return {
		timestamp: new Date().toISOString(),
		uptime: Math.round(os.uptime()),
		host: `${platformName}-${arch}`,
		platform: process.platform,
		arch: process.arch,
		bunVersion,
		environment: process.env.NODE_ENV ?? "development",
		services,
		healthyCount,
		totalServices: services.length,
		totalMemoryMb,
		totalRssMb,
		totalHeapUsedMb,
		recentLogs: combinedLogs,
	};
}

/**
 * Retrieves historical telemetry timeseries bucketed for charting.
 */
export async function getHistoricalTelemetry(
	range: "1h" | "6h" | "24h" | "7d" = "24h",
): Promise<HistoricalTelemetryPoint[]> {
	const now = Date.now();
	const durationMs =
		range === "1h"
			? 60 * 60 * 1000
			: range === "6h"
				? 6 * 60 * 60 * 1000
				: range === "7d"
					? 7 * 24 * 60 * 60 * 1000
					: 24 * 60 * 60 * 1000;

	const startTime = new Date(now - durationMs);

	const records = await db
		.select()
		.from(systemMetrics)
		.where(gte(systemMetrics.createdAt, startTime))
		.orderBy(asc(systemMetrics.createdAt));

	// If no records or very few, generate an initial point from live snapshot
	if (records.length === 0) {
		const live = await getFleetTelemetry();
		await persistTelemetrySnapshot(live.services);
		const api = live.services.find((s) => s.id === "api");
		const sched = live.services.find((s) => s.id === "scheduler");
		const bot = live.services.find((s) => s.id === "bot");

		const pt: HistoricalTelemetryPoint = {
			timestamp: live.timestamp,
			timeValue: now,
			formattedTime: new Date(now).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			}),
			totalRssMb: live.totalRssMb,
			totalHeapMb: live.totalHeapUsedMb,
			apiRssMb: api?.memory.rssMb ?? 0,
			apiHeapMb: api?.memory.heapUsedMb ?? 0,
			apiCpu: api?.cpuUsage ?? 0,
			apiLatency: api?.latencyMs ?? 0,
			schedulerRssMb: sched?.memory.rssMb ?? 0,
			schedulerHeapMb: sched?.memory.heapUsedMb ?? 0,
			schedulerCpu: sched?.cpuUsage ?? 0,
			schedulerLatency: sched?.latencyMs ?? 0,
			botRssMb: bot?.memory.rssMb ?? 0,
			botHeapMb: bot?.memory.heapUsedMb ?? 0,
			botCpu: bot?.cpuUsage ?? 0,
			botLatency: bot?.latencyMs ?? 0,
		};
		return [pt];
	}

	// Bucket points to avoid rendering tens of thousands of chart SVG points
	const bucketIntervalMs =
		range === "1h"
			? 60 * 1000 // 1 min bucket
			: range === "6h"
				? 5 * 60 * 1000 // 5 min bucket
				: range === "7d"
					? 2 * 60 * 60 * 1000 // 2 hour bucket
					: 15 * 60 * 1000; // 15 min bucket

	// Group records by bucket time window
	const bucketMap = new Map<
		number,
		{
			timestamp: string;
			timeValue: number;
			services: Map<
				string,
				{
					rssMb: number;
					heapMb: number;
					cpu: number;
					latency: number;
					count: number;
				}
			>;
		}
	>();

	for (const r of records) {
		const rTime = r.createdAt.getTime();
		const bucketKey = Math.floor(rTime / bucketIntervalMs) * bucketIntervalMs;

		let bucket = bucketMap.get(bucketKey);
		if (!bucket) {
			bucket = {
				timestamp: new Date(bucketKey).toISOString(),
				timeValue: bucketKey,
				services: new Map(),
			};
			bucketMap.set(bucketKey, bucket);
		}

		let sData = bucket.services.get(r.serviceId);
		if (!sData) {
			sData = { rssMb: 0, heapMb: 0, cpu: 0, latency: 0, count: 0 };
			bucket.services.set(r.serviceId, sData);
		}

		sData.rssMb += r.memoryRssBytes / 1024 / 1024;
		sData.heapMb += r.memoryHeapUsedBytes / 1024 / 1024;
		sData.cpu += r.cpuUsage;
		sData.latency += r.latencyMs;
		sData.count += 1;
	}

	const points: HistoricalTelemetryPoint[] = [];
	const sortedBucketKeys = Array.from(bucketMap.keys()).sort((a, b) => a - b);

	for (const key of sortedBucketKeys) {
		const bucket = bucketMap.get(key);
		if (!bucket) continue;

		const d = new Date(key);
		const formattedTime =
			range === "7d"
				? `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
				: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

		const getAvg = (sId: string) => {
			const s = bucket.services.get(sId);
			if (!s || s.count === 0) {
				return { rssMb: 0, heapMb: 0, cpu: 0, latency: 0 };
			}
			return {
				rssMb: Number((s.rssMb / s.count).toFixed(1)),
				heapMb: Number((s.heapMb / s.count).toFixed(1)),
				cpu: Number((s.cpu / s.count).toFixed(1)),
				latency: Math.round(s.latency / s.count),
			};
		};

		const api = getAvg("api");
		const scheduler = getAvg("scheduler");
		const bot = getAvg("bot");

		const totalRssMb = Number(
			(api.rssMb + scheduler.rssMb + bot.rssMb).toFixed(1),
		);
		const totalHeapMb = Number(
			(api.heapMb + scheduler.heapMb + bot.heapMb).toFixed(1),
		);

		points.push({
			timestamp: bucket.timestamp,
			timeValue: bucket.timeValue,
			formattedTime,
			totalRssMb,
			totalHeapMb,
			apiRssMb: api.rssMb,
			apiHeapMb: api.heapMb,
			apiCpu: api.cpu,
			apiLatency: api.latency,
			schedulerRssMb: scheduler.rssMb,
			schedulerHeapMb: scheduler.heapMb,
			schedulerCpu: scheduler.cpu,
			schedulerLatency: scheduler.latency,
			botRssMb: bot.rssMb,
			botHeapMb: bot.heapMb,
			botCpu: bot.cpu,
			botLatency: bot.latency,
		});
	}

	return points;
}

/**
 * Starts continuous background sampling of Sentinel fleet telemetry.
 */
let samplerInterval: ReturnType<typeof setInterval> | null = null;

export function startTelemetrySampler(intervalMs = 30_000): void {
	if (samplerInterval) return;

	// Initial immediate capture
	void (async () => {
		try {
			const fleet = await getFleetTelemetry();
			await persistTelemetrySnapshot(fleet.services);
		} catch {
			// ignore boot capture error
		}
	})();

	samplerInterval = setInterval(async () => {
		try {
			const fleet = await getFleetTelemetry();
			await persistTelemetrySnapshot(fleet.services);
		} catch {
			// ignore sampling error
		}
	}, intervalMs);
}
