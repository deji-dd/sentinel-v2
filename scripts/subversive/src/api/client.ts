import { state } from "../state";

export function detectAttackerFlightState(): "traveling" | "abroad" | "okay" {
	const href = window.location.href.toLowerCase();
	if (href.includes("travelagency") || href.includes("page=travel")) {
		return "traveling";
	}
	if (href.includes("index.php?page=abroad") || href.includes("/abroad")) {
		return "abroad";
	}
	const body = document.body;
	if (
		body &&
		(body.classList.contains("travel") || body.classList.contains("abroad"))
	) {
		return "traveling";
	}
	return "okay";
}

export interface ApiRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
}

export function apiRequest<T = Record<string, unknown>>(
	endpoint: string,
	options: ApiRequestOptions = {},
): Promise<T> {
	const url = `${state.apiUrl}${endpoint}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		...(options.headers || {}),
	};

	if (state.token) {
		headers.Authorization = `Bearer ${state.token}`;
	}

	const attackerState = detectAttackerFlightState();
	if (attackerState !== "okay") {
		headers["X-Attacker-State"] = attackerState;
	}

	return new Promise<T>((resolve, reject) => {
		GM_xmlhttpRequest({
			method: options.method || "GET",
			url,
			headers,
			data: options.body ? JSON.stringify(options.body) : undefined,
			timeout: 15000,
			onload: (res) => {
				let data: Record<string, unknown> = {};
				try {
					data = JSON.parse(res.responseText || "{}");
				} catch {
					return reject(new Error(`Server error (${res.status})`));
				}
				if (res.status >= 200 && res.status < 300 && data.success !== false) {
					resolve(data as T);
				} else {
					const errMessage =
						(data.error as string) ||
						(data.message as string) ||
						(data.reason as string) ||
						`Request failed (${res.status})`;
					const err = new Error(errMessage) as Error & { data?: unknown };
					err.data = data;
					reject(err);
				}
			},
			onerror: () =>
				reject(new Error("Could not connect to Sentinel API server.")),
			ontimeout: () => reject(new Error("Request timed out.")),
		});
	});
}
