import { state as appState } from "../state";
import { openPanel, switchTab } from "../ui/panel";
import { api, ChatApiError, openEvents } from "./api";
import type { ChatGifConfig, ChatMe } from "./protocol";
import {
	applyMe,
	changed,
	handleEvent,
	setError,
	state,
	subscribe,
	syncChatStyle,
} from "./store";
import { Layout } from "./ui/layout";

import extraCss from "./styles/extra.css" with { type: "text" };
// Torn Rooms-style chat inside Torn's chat bar, backed by the Sentinel API.
import tornCss from "./styles/torn-chat.css" with { type: "text" };

let stopEvents: (() => void) | null = null;
let layout: Layout | null = null;
let initialized = false;
let starting = false;
let lastToken = "";
let checkTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function openSubversiveSettings(): void {
	openPanel();
	switchTab("settings");
}

function waitForChat(): Promise<void> {
	return new Promise((resolve) => {
		const ready = () => document.getElementById("chatRoot");
		if (ready()) {
			resolve();
			return;
		}
		const observer = new MutationObserver(() => {
			if (ready()) {
				observer.disconnect();
				resolve();
			}
		});
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	});
}

async function start(): Promise<void> {
	if (starting) return;
	starting = true;
	lastToken = appState.token;
	try {
		if (!appState.token) {
			state.me = null;
			stopEvents?.();
			stopEvents = null;
			changed();
			return;
		}
		const response = await api<{ me: ChatMe; gif: ChatGifConfig }>(
			"GET",
			"/v2/chat/me",
		);
		applyMe(response.me, response.gif);
		setError(null);
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		stopEvents?.();
		stopEvents = openEvents(
			() => [...state.expanded],
			handleEvent,
			(connection) => {
				state.conn = connection;
				changed();
			},
		);
	} catch (error) {
		stopEvents?.();
		stopEvents = null;
		state.me = null;
		const status = error instanceof ChatApiError ? error.status : 0;
		setError(
			error instanceof ChatApiError
				? error.message
				: error instanceof Error
					? error.message
					: "Could not connect to Subversive chat",
		);
		// A network blip or a restarting API is worth retrying; a refused
		// session is not (the member has to reconnect their key).
		if (status !== 401 && status !== 403 && !retryTimer) {
			retryTimer = setTimeout(() => {
				retryTimer = null;
				if (appState.token) void start();
			}, 15_000);
		}
	} finally {
		starting = false;
		changed();
	}
}

function stop(): void {
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	stopEvents?.();
	stopEvents = null;
	state.me = null;
	state.rooms.clear();
	state.messages.clear();
	changed();
}

/** Called by the panel when the API key is connected or forgotten. */
export function refreshChatAuth(): void {
	if (!initialized) return;
	if (!appState.token) {
		lastToken = "";
		stop();
		return;
	}
	if (appState.token !== lastToken || !state.me) void start();
}

/** Boot the chat layer. Safe to call more than once. */
export async function initChat(): Promise<void> {
	if (initialized) return;
	await waitForChat();
	if (initialized) return;
	initialized = true;

	if (!document.getElementById("sc-chat-styles")) {
		const style = document.createElement("style");
		style.id = "sc-chat-styles";
		style.textContent = `${tornCss}\n${extraCss}`;
		document.head.append(style);
	}

	// Follow the player's Torn chat styling, also when they change it in Torn's
	// chat settings. Read only while the Torn tab is actively viewed, like
	// everything taken from the page.
	const syncIfActive = () => {
		if (document.visibilityState === "visible" && document.hasFocus()) {
			syncChatStyle();
		}
	};
	syncIfActive();
	window.addEventListener("focus", syncIfActive);
	setInterval(syncIfActive, 2000);

	layout = new Layout(openSubversiveSettings);
	subscribe(() => layout?.render());
	layout.render();
	await start();

	// The panel can connect or forget the key in another module; storage is
	// shared but does not emit an event, so watch the token cheaply.
	checkTimer = setInterval(() => {
		if (appState.token === lastToken) return;
		if (!appState.token) {
			lastToken = "";
			stop();
		} else {
			void start();
		}
	}, 2000);
}

/** Stop the token watcher (used when the page unloads, mostly for tidiness). */
export function destroyChat(): void {
	if (checkTimer) clearInterval(checkTimer);
	checkTimer = null;
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	stopEvents?.();
	stopEvents = null;
	layout = null;
	initialized = false;
}
