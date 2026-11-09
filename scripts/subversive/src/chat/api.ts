// Talks to the Sentinel chat API. Everything goes through GM_xmlhttpRequest:
// Torn's Content-Security-Policy blocks fetch and WebSocket to other hosts,
// even from Tampermonkey's sandbox, while GM requests run in the extension.
import { state } from "../state";
import {
	CHAT_LIMITS,
	type ChatPollResponse,
	type ChatServerEvent,
} from "./protocol";

export class ChatApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ChatApiError";
	}
}

function base(): string {
	return state.apiUrl.replace(/\/+$/, "");
}

/** The player logged in to Torn in this tab, from Torn's own page data (used only to pick Torn's chat settings). */
export function pageUserId(): number | null {
	try {
		const input = document.getElementById(
			"torn-user",
		) as HTMLInputElement | null;
		const id = Number(JSON.parse(input?.value ?? "{}").id);
		if (id > 0) return id;
	} catch {
		// Fall through to the sidebar link.
	}
	const link = document
		.querySelector('#sidebar a[href*="profiles.php?XID="]')
		?.getAttribute("href");
	const id = Number(/XID=(\d+)/.exec(link ?? "")?.[1]);
	return id > 0 ? id : null;
}

function request(
	method: string,
	path: string,
	body?: unknown,
	token?: string,
): Promise<{ status: number; data: unknown }> {
	return new Promise((resolve, reject) => {
		GM_xmlhttpRequest({
			method,
			url: base() + path,
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			data: body === undefined ? undefined : JSON.stringify(body),
			timeout: 20_000,
			onload: (response) => {
				let data: unknown = null;
				try {
					data = JSON.parse(response.responseText);
				} catch {
					const text = response.responseText.trim();
					data = {
						error: text.startsWith("<")
							? "The chat server returned an error page. Try again in a moment."
							: text.slice(0, 200),
					};
				}
				resolve({ status: response.status, data });
			},
			onerror: () =>
				reject(new ChatApiError(0, "Cannot reach the Subversive chat server")),
			ontimeout: () =>
				reject(new ChatApiError(0, "The chat server took too long to answer")),
		});
	});
}

function errorMessage(data: unknown, fallback: string): string {
	if (typeof data !== "object" || data === null) return fallback;
	const record = data as Record<string, unknown>;
	const message = record.error ?? record.message ?? record.reason;
	if (typeof message !== "string" || !message) return fallback;
	// A proxy/WAF can answer with an HTML page; never show that wall of markup
	// in the chat status line.
	if (/^\s*<(!doctype|html)/i.test(message)) {
		return "The chat server returned an error page. Try again in a moment.";
	}
	return message;
}

export function hasToken(): boolean {
	return Boolean(state.token);
}

export async function api<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	if (!state.token) throw new ChatApiError(401, "Not connected");
	const response = await request(method, path, body, state.token);
	const record =
		typeof response.data === "object" && response.data !== null
			? (response.data as Record<string, unknown>)
			: null;
	const failed =
		response.status < 200 ||
		response.status >= 300 ||
		record?.success === false ||
		(record !== null && "error" in record && !("success" in record));
	if (failed) {
		throw new ChatApiError(
			response.status,
			errorMessage(response.data, `Request failed (${response.status})`),
		);
	}
	return response.data as T;
}

export type ConnState = "connecting" | "live" | "offline";

/**
 * Keeps a Server-Sent Events stream open, reconnecting with backoff. Returns a
 * stop function. Every connection starts with a hello event, so a page load or
 * a reconnect needs no other request.
 */
export function openEvents(
	openRooms: () => string[],
	onEvent: (event: ChatServerEvent) => void,
	onState: (state: ConnState) => void,
): () => void {
	if (!canStream()) return pollEvents(openRooms, onEvent, onState);
	let stopped = false;
	let current: { abort(): void } | null = null;
	let delay = 1000;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watchdog: ReturnType<typeof setTimeout> | null = null;
	let streamed = false;
	let polling: (() => void) | null = null;

	// Script managers without streaming (only Tampermonkey is known to stream)
	// hand back no readable body, or nothing until the response ends: poll
	// instead, as on Torn PDA.
	const fallBack = () => {
		if (stopped) return;
		stopped = true;
		if (timer) clearTimeout(timer);
		if (watchdog) clearTimeout(watchdog);
		current?.abort();
		polling = pollEvents(openRooms, onEvent, onState);
	};

	const retry = () => {
		if (stopped) return;
		onState("offline");
		timer = setTimeout(connect, delay);
		delay = Math.min(delay * 2, 30_000);
	};

	function connect(): void {
		if (stopped) return;
		onState("connecting");
		if (!state.token) {
			onState("offline");
			return;
		}
		let ended = false;
		let replaced = false;
		const end = () => {
			if (ended) return;
			ended = true;
			if (!replaced) return retry();
			// Too many Torn tabs: a newer one took this stream. Come back when this
			// tab is looked at again (which in turn replaces the oldest).
			onState("offline");
			const resume = () => {
				if (document.visibilityState !== "visible") return;
				document.removeEventListener("visibilitychange", resume);
				connect();
			};
			document.addEventListener("visibilitychange", resume);
		};
		// The server's first event arrives at once; a first stream that shows
		// nothing for 20 seconds never will.
		if (!streamed && !watchdog) {
			watchdog = setTimeout(() => {
				if (!streamed) fallBack();
			}, 20_000);
		}
		current = GM_xmlhttpRequest({
			method: "GET",
			url: `${base()}/v2/chat/events?open=${openRooms().map(encodeURIComponent).join(",")}`,
			headers: {
				Authorization: `Bearer ${state.token}`,
				Accept: "text/event-stream",
			},
			responseType: "stream",
			onloadstart: (response) => {
				if (response.status && response.status !== 200) {
					if (response.status === 403) {
						// Banned: retrying cannot help.
						ended = true;
						return onState("offline");
					}
					return end();
				}
				const body = response.response;
				if (!body || typeof body.getReader !== "function") return fallBack();
				const reader = body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				delay = 1000;
				onState("live");
				void (async () => {
					try {
						for (;;) {
							const { value, done } = await reader.read();
							if (done) break;
							buffer += decoder.decode(value, { stream: true });
							let index = buffer.indexOf("\n\n");
							while (index >= 0) {
								const frame = buffer.slice(0, index);
								buffer = buffer.slice(index + 2);
								const lines = frame.split("\n");
								const event = lines
									.find((line) => line.startsWith("event: "))
									?.slice(7);
								const data = lines.find((line) => line.startsWith("data: "));
								if (data) streamed = true;
								if (!event && data) {
									try {
										onEvent(JSON.parse(data.slice(6)) as ChatServerEvent);
									} catch {
										// A malformed frame must not kill the stream.
									}
								}
								index = buffer.indexOf("\n\n");
							}
						}
					} catch {
						// Stream broke; reconnect below.
					}
					end();
				})();
			},
			onerror: end,
			onabort: () => {
				ended = true;
			},
		});
	}

	connect();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		if (watchdog) clearTimeout(watchdog);
		current?.abort();
		polling?.();
	};
}

/**
 * Only Tampermonkey is known to stream GM_xmlhttpRequest responses;
 * Violentmonkey and others hand back nothing until a response ends, so a stream
 * that never ends never arrives. Torn PDA routes requests through its native
 * HTTP handler with the same limit. Everyone else polls.
 */
function canStream(): boolean {
	if (GM_getValue<boolean>("satf_chat_force_poll", false)) return false;
	if (
		typeof (window as { flutter_inappwebview?: unknown })
			.flutter_inappwebview !== "undefined"
	) {
		return false;
	}
	return (
		typeof GM_info !== "undefined" && GM_info?.scriptHandler === "Tampermonkey"
	);
}

/** The stream's events from GET /v2/chat/poll: a hello first, then the room list and new messages. */
function pollEvents(
	openRooms: () => string[],
	onEvent: (event: ChatServerEvent) => void,
	onState: (state: ConnState) => void,
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let cursor: number | null = null;
	let reactionCursor: number | null = null;
	let failures = 0;
	let busy = false;
	const visible = () => document.visibilityState === "visible";

	// No polling in the background: nothing there is seen, and the first poll
	// back catches up from the cursor.
	const schedule = () => {
		if (stopped || !visible()) return;
		const interval = openRooms().length
			? CHAT_LIMITS.pollMs
			: CHAT_LIMITS.pollIdleMs;
		timer = setTimeout(tick, Math.min(interval * 2 ** failures, 60_000));
	};
	const onVisible = () => {
		if (!visible() || stopped || busy) return;
		if (timer) clearTimeout(timer);
		void tick();
	};
	document.addEventListener("visibilitychange", onVisible);

	async function tick(): Promise<void> {
		timer = null;
		if (stopped || !visible()) return;
		busy = true;
		try {
			const open = openRooms().map(encodeURIComponent).join(",");
			const after = cursor === null ? "" : `&after=${cursor}`;
			const reactionsAfter =
				reactionCursor === null ? "" : `&reactionsAfter=${reactionCursor}`;
			const response = await api<ChatPollResponse>(
				"GET",
				`/v2/chat/poll?open=${open}${after}${reactionsAfter}`,
			);
			if (stopped) return;
			onEvent({
				t: "hello",
				me: response.me,
				gif: response.gif,
				rooms: response.rooms,
				history: response.history,
			});
			for (const msg of response.messages) onEvent({ t: "msg", msg });
			for (const update of response.reactions ?? []) {
				onEvent({ t: "reactions", ...update });
			}
			for (const [roomId, users] of Object.entries(response.typing ?? {})) {
				onEvent({ t: "typing", roomId, users });
			}
			cursor = response.cursor;
			reactionCursor = response.reactionCursor ?? null;
			failures = 0;
			onState("live");
		} catch (error) {
			if (error instanceof ChatApiError && error.status === 403) {
				stopped = true;
				return onState("offline");
			}
			failures = Math.min(failures + 1, 4);
			onState("offline");
		}
		busy = false;
		schedule();
	}

	onState("connecting");
	void tick();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		document.removeEventListener("visibilitychange", onVisible);
	};
}
