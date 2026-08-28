/**
 * Temporary diagnostic probe: connects to the telemetry WS endpoint,
 * sends pings every 3s, and prints a compact summary of each message.
 */
const ws = new WebSocket("ws://localhost:3000/api/ws/telemetry");

function summarize(msg: Record<string, unknown>) {
	const type = msg.type;
	if (type === "snapshot" || type === "pong") {
		const services = (msg.services ?? []) as Array<{
			id: string;
			status: string;
			cpuUsage?: number;
			latencyMs?: number;
			memory?: { rssBytes?: number };
			recentLogs?: unknown[];
			pid?: number | null;
			uptimeSeconds?: number;
		}>;
		console.log(
			`[${new Date().toISOString()}] ${type}:`,
			services
				.map(
					(s) =>
						`${s.id}(st=${s.status},pid=${s.pid},up=${s.uptimeSeconds}s,cpu=${s.cpuUsage},lat=${s.latencyMs},rss=${s.memory?.rssBytes ?? 0},logs=${s.recentLogs?.length ?? 0})`,
				)
				.join(" | "),
			`| fleetLogs=${(msg.recentLogs as unknown[])?.length ?? 0}`,
		);
	} else {
		console.log(`[${new Date().toISOString()}] other message:`, type);
	}
}

ws.onopen = () => {
	console.log("WS OPEN");
	ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
	setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
		}
	}, 3000);
};

ws.onmessage = (event) => {
	try {
		summarize(JSON.parse(event.data as string));
	} catch (e) {
		console.log("parse error", e);
	}
};

ws.onerror = (e) => console.log("WS ERROR", e);
ws.onclose = (e) => console.log("WS CLOSE", e.code, e.reason);

setTimeout(() => {
	console.log("--- probe done ---");
	process.exit(0);
}, 8000);
