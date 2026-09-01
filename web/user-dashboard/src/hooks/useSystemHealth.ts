import { useEffect, useState } from "react";

export type SystemHealthStatus =
	| "connecting"
	| "online"
	| "degraded"
	| "offline";

export interface SystemHealth {
	host: string | null;
	bunVersion: string | null;
	rtt: number | null;
	status: SystemHealthStatus;
}

const INITIAL_HEALTH: SystemHealth = {
	host: null,
	bunVersion: null,
	rtt: null,
	status: "connecting",
};

interface HealthApiResponse {
	status?: string;
	host?: string;
	bunVersion?: string;
}

export function useSystemHealth(): SystemHealth {
	const [health, setHealth] = useState<SystemHealth>(INITIAL_HEALTH);

	useEffect(() => {
		let isMounted = true;

		async function checkHealth() {
			const start = performance.now();
			try {
				const res = await fetch("/api/health", {
					headers: { "X-Client-App": "user-dashboard" },
					cache: "no-store",
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as HealthApiResponse;
				if (!isMounted) return;

				const rtt = Math.max(1, Math.round(performance.now() - start));
				setHealth({
					host: typeof data.host === "string" ? data.host : "MAC-ARM64",
					bunVersion:
						typeof data.bunVersion === "string" ? data.bunVersion : "1.4",
					rtt,
					status: "online",
				});
			} catch {
				if (!isMounted) return;
				setHealth((prev) => ({
					...prev,
					status: "offline",
				}));
			}
		}

		void checkHealth();
		const interval = setInterval(checkHealth, 15_000);

		return () => {
			isMounted = false;
			clearInterval(interval);
		};
	}, []);

	return health;
}
