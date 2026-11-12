import type {
	CapitalBook,
	CapitalLiveSnapshot,
	CapitalLiveView,
} from "@sentinel/schemas";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "./api";

const MAX_RECONNECT_MS = 15_000;

function streamUrl(view: CapitalLiveView, book: CapitalBook): string {
	const url = new URL(apiBaseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/api/ws/capital";
	url.search = new URLSearchParams({ view, book }).toString();
	return url.toString();
}

interface UseCapitalLiveOptions<T> {
	view: CapitalLiveView;
	book?: CapitalBook;
	enabled?: boolean;
	onSnapshot: (data: T, updatedAt: number) => void;
}

/**
 * Keeps a page in sync with the capital WebSocket stream. The socket reconnects
 * with backoff; the page keeps its initial REST snapshot as the offline
 * fallback, so there is no manual refresh control.
 */
export function useCapitalLive<T>({
	view,
	book = "live",
	enabled = true,
	onSnapshot,
}: UseCapitalLiveOptions<T>) {
	const [connected, setConnected] = useState(false);
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
	const onSnapshotRef = useRef(onSnapshot);
	onSnapshotRef.current = onSnapshot;

	const markUpdated = useCallback(() => setLastUpdatedAt(Date.now()), []);

	useEffect(() => {
		if (!enabled) {
			setConnected(false);
			return;
		}

		let socket: WebSocket | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let attempts = 0;
		let stopped = false;

		const scheduleReconnect = () => {
			if (stopped) return;
			attempts += 1;
			const delay = Math.min(
				MAX_RECONNECT_MS,
				1_000 * 2 ** Math.min(attempts, 4),
			);
			reconnectTimer = setTimeout(connect, delay);
		};

		function connect() {
			if (stopped) return;
			try {
				socket = new WebSocket(streamUrl(view, book));
			} catch {
				setConnected(false);
				scheduleReconnect();
				return;
			}

			socket.onopen = () => {
				attempts = 0;
				setConnected(true);
			};

			socket.onmessage = (event) => {
				if (typeof event.data !== "string") return;
				try {
					const message = JSON.parse(event.data) as Partial<
						CapitalLiveSnapshot<T>
					>;
					if (
						message.type !== "capital_snapshot" ||
						message.data === undefined
					) {
						return;
					}
					const stamp =
						message.updatedAtIso &&
						Number.isFinite(Date.parse(message.updatedAtIso))
							? Date.parse(message.updatedAtIso)
							: Date.now();
					onSnapshotRef.current(message.data, stamp);
					setLastUpdatedAt(stamp);
				} catch {
					// Ignore malformed frames; the next snapshot will replace this one.
				}
			};

			socket.onerror = () => setConnected(false);
			socket.onclose = () => {
				setConnected(false);
				socket = null;
				scheduleReconnect();
			};
		}

		connect();

		return () => {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.close();
			socket = null;
		};
	}, [view, book, enabled]);

	return { connected, lastUpdatedAt, markUpdated };
}
