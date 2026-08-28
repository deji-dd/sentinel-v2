import { useCallback, useEffect, useRef, useState } from "react";

export type HostStatus = "connecting" | "online" | "degraded" | "offline";

export interface LogEntry {
	id: string;
	timestamp: string;
	service: "api" | "bot" | "scheduler";
	context: string;
	subContext?: string;
	level: "info" | "warn" | "error" | "debug";
	message: string;
}

export interface ServiceTelemetry {
	id: "api" | "bot" | "scheduler";
	name: string;
	packagePath: string;
	status: "online" | "offline" | "degraded";
	pid: number | null;
	uptimeSeconds: number;
	cpuUsage?: number;
	latencyMs?: number;
	memory: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		rssMb?: number;
		heapUsedMb?: number;
	};
	portOrTransport: string;
	protocol: string;
	description: string;
	recentLogs: LogEntry[];
}

export interface HostTelemetry {
	host: string | null;
	bunVersion: string | null;
	rtt: number | null;
	uptime: number | null;
	status: HostStatus;
	environment: string | null;
	lastChecked: Date | null;
	transport: "ws" | "http" | "none";
	services: ServiceTelemetry[];
	healthyCount: number;
	totalServices: number;
	totalMemoryMb: number;
	totalRssMb: number;
	totalHeapUsedMb: number;
	recentLogs: LogEntry[];
	refresh: () => void;
}

const INITIAL_SERVICES: ServiceTelemetry[] = [
	{
		id: "api",
		name: "API Gateway",
		packagePath: "services/api",
		status: "online",
		pid: null,
		uptimeSeconds: 0,
		memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
		portOrTransport: "Port 3000",
		protocol: "HTTP/2 • Elysia REST & WebSockets",
		description:
			"High-speed Elysia REST API & WebSockets gateway serving dashboard clients and telemetry streams.",
		recentLogs: [],
	},
	{
		id: "bot",
		name: "Discord Bot",
		packagePath: "services/bot",
		status: "offline",
		pid: null,
		uptimeSeconds: 0,
		memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
		portOrTransport: "sentinel_bot.sock",
		protocol: "WSS Discord Gateway v10 + IPC",
		description:
			"Discord.js multi-guild gateway engine orchestrating slash commands, territory tracking, and verification workflows.",
		recentLogs: [],
	},
	{
		id: "scheduler",
		name: "Task Scheduler",
		packagePath: "services/scheduler",
		status: "offline",
		pid: null,
		uptimeSeconds: 0,
		memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
		portOrTransport: "sentinel_worker.sock",
		protocol: "BullMQ • Redis Streams & Cron",
		description:
			"High-reliability distributed job scheduler managing alliance data sync, territory timer alerts, and Torn poller crons.",
		recentLogs: [],
	},
];

const INITIAL_TELEMETRY: HostTelemetry = {
	host: null,
	bunVersion: null,
	rtt: null,
	uptime: null,
	status: "connecting",
	environment: null,
	lastChecked: null,
	transport: "none",
	services: INITIAL_SERVICES,
	healthyCount: 1,
	totalServices: 3,
	totalMemoryMb: 0,
	totalRssMb: 0,
	totalHeapUsedMb: 0,
	recentLogs: [],
	refresh: () => {},
};

/** Interval between client pings while the WebSocket is open. */
const WS_PING_INTERVAL_MS = 3000;
/**
 * If no message arrives over an OPEN socket within this window, assume the
 * stream is silently dead, tear it down, and fall back to HTTP polling.
 */
const WS_STALE_TIMEOUT_MS = 10_000;
/** Polling cadence for the HTTP fallback transport. */
const HTTP_POLL_INTERVAL_MS = 5000;
/** Delay before retrying a WebSocket connection after it closes. */
const WS_RECONNECT_DELAY_MS = 3000;

interface FleetPayload {
	type?: string;
	success?: boolean;
	host?: string;
	bunVersion?: string;
	uptime?: number;
	environment?: string;
	services?: ServiceTelemetry[];
	healthyCount?: number;
	totalServices?: number;
	totalMemoryMb?: number;
	totalRssMb?: number;
	totalHeapUsedMb?: number;
	recentLogs?: LogEntry[];
}

export function useHostTelemetry(): HostTelemetry {
	const [telemetry, setTelemetry] = useState<HostTelemetry>(INITIAL_TELEMETRY);
	const wsRef = useRef<WebSocket | null>(null);
	const pingStartRef = useRef<number>(0);
	const lastMessageAtRef = useRef<number>(0);
	const httpPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const immediatePollRef = useRef<(() => Promise<void>) | null>(null);

	const triggerRefresh = useCallback(() => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "refresh" }));
			return;
		}
		// Not on WS — force an immediate HTTP poll instead of waiting a cycle.
		void immediatePollRef.current?.();
	}, []);

	useEffect(() => {
		let isMounted = true;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let pingInterval: ReturnType<typeof setInterval> | null = null;
		let watchdogInterval: ReturnType<typeof setInterval> | null = null;

		async function pollHttpOnce() {
			if (!isMounted) return;
			const startTime = performance.now();
			try {
				const res = await fetch("/api/telemetry", {
					headers: { "X-Client-App": "user-dashboard" },
					cache: "no-store",
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as FleetPayload;
				if (!isMounted) return;

				const rtt = Math.max(1, Math.round(performance.now() - startTime));
				setTelemetry((prev) => ({
					...mergeTarget(prev, data),
					rtt,
					status: "online",
					transport: "http",
					lastChecked: new Date(),
				}));
			} catch {
				if (!isMounted) return;
				setTelemetry((prev) => ({
					...prev,
					status: prev.transport === "none" ? "offline" : "degraded",
					transport: "http",
					lastChecked: new Date(),
				}));
			}
		}

		function mergeTarget(
			prev: HostTelemetry,
			data: FleetPayload,
		): HostTelemetry {
			return {
				...prev,
				host: typeof data.host === "string" ? data.host : prev.host,
				bunVersion:
					typeof data.bunVersion === "string"
						? data.bunVersion
						: prev.bunVersion,
				uptime: typeof data.uptime === "number" ? data.uptime : prev.uptime,
				environment:
					typeof data.environment === "string"
						? data.environment
						: prev.environment,
				services: Array.isArray(data.services) ? data.services : prev.services,
				healthyCount:
					typeof data.healthyCount === "number"
						? data.healthyCount
						: prev.healthyCount,
				totalServices:
					typeof data.totalServices === "number"
						? data.totalServices
						: prev.totalServices,
				totalMemoryMb:
					typeof data.totalMemoryMb === "number"
						? data.totalMemoryMb
						: prev.totalMemoryMb,
				totalRssMb:
					typeof data.totalRssMb === "number"
						? data.totalRssMb
						: typeof data.totalMemoryMb === "number"
							? data.totalMemoryMb
							: prev.totalRssMb,
				totalHeapUsedMb:
					typeof data.totalHeapUsedMb === "number"
						? data.totalHeapUsedMb
						: prev.totalHeapUsedMb,
				recentLogs: Array.isArray(data.recentLogs)
					? data.recentLogs
					: prev.recentLogs,
			};
		}

		immediatePollRef.current = pollHttpOnce;

		function startHttpPolling() {
			if (httpPollTimerRef.current || !isMounted) return;
			void pollHttpOnce();
			httpPollTimerRef.current = setInterval(() => {
				if (!isMounted) return;
				void pollHttpOnce();
			}, HTTP_POLL_INTERVAL_MS);
		}

		function stopHttpPolling() {
			if (httpPollTimerRef.current) {
				clearInterval(httpPollTimerRef.current);
				httpPollTimerRef.current = null;
			}
		}

		function connectWs() {
			if (!isMounted) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const host = window.location.host;
			const wsUrl = `${protocol}//${host}/api/ws/telemetry`;

			try {
				const ws = new WebSocket(wsUrl);
				wsRef.current = ws;

				ws.onopen = () => {
					if (!isMounted) return;
					stopHttpPolling();

					lastMessageAtRef.current = Date.now();
					pingStartRef.current = performance.now();
					ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));

					if (pingInterval) clearInterval(pingInterval);
					pingInterval = setInterval(() => {
						if (ws.readyState === WebSocket.OPEN) {
							pingStartRef.current = performance.now();
							ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
						}
					}, WS_PING_INTERVAL_MS);

					// Watchdog: detect a silently dead stream (open but mute).
					if (watchdogInterval) clearInterval(watchdogInterval);
					watchdogInterval = setInterval(() => {
						if (
							ws.readyState === WebSocket.OPEN &&
							Date.now() - lastMessageAtRef.current > WS_STALE_TIMEOUT_MS
						) {
							ws.close(); // triggers onclose -> HTTP fallback + reconnect
						}
					}, 1000);
				};

				ws.onmessage = (event) => {
					if (!isMounted) return;
					lastMessageAtRef.current = Date.now();
					try {
						const data = JSON.parse(event.data as string) as FleetPayload & {
							type: string;
						};

						if (data.type === "snapshot") {
							setTelemetry((prev) => ({
								...mergeTarget(prev, data),
								status: "online",
								transport: "ws",
								lastChecked: new Date(),
							}));
						} else if (data.type === "pong") {
							const computedRtt = Math.round(
								performance.now() - pingStartRef.current,
							);
							setTelemetry((prev) => ({
								...mergeTarget(prev, data),
								rtt: Math.max(1, computedRtt),
								status: "online",
								transport: "ws",
								lastChecked: new Date(),
							}));
						}
					} catch {
						// ignore parse error
					}
				};

				ws.onerror = () => {
					// onclose handles fallback + reconnect
				};

				ws.onclose = () => {
					if (!isMounted) return;
					if (pingInterval) clearInterval(pingInterval);
					if (watchdogInterval) clearInterval(watchdogInterval);

					// Sustained HTTP polling until the next successful WS open.
					startHttpPolling();

					if (!reconnectTimer) {
						reconnectTimer = setTimeout(() => {
							reconnectTimer = null;
							connectWs();
						}, WS_RECONNECT_DELAY_MS);
					}
				};
			} catch {
				startHttpPolling();
				if (!reconnectTimer) {
					reconnectTimer = setTimeout(() => {
						reconnectTimer = null;
						connectWs();
					}, WS_RECONNECT_DELAY_MS);
				}
			}
		}

		connectWs();

		return () => {
			isMounted = false;
			immediatePollRef.current = null;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (pingInterval) clearInterval(pingInterval);
			if (watchdogInterval) clearInterval(watchdogInterval);
			stopHttpPolling();
			if (wsRef.current) {
				wsRef.current.onclose = null;
				wsRef.current.close();
				wsRef.current = null;
			}
		};
	}, []);

	return {
		...telemetry,
		refresh: triggerRefresh,
	};
}
