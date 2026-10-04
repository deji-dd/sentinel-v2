import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "sentinel-theme";

/**
 * The theme lives outside React (a module-level store) so every mounted
 * consumer — the sidebar, the top nav, the login screen — always agrees on the
 * current value, even when several of them are rendered at once.
 */
const listeners = new Set<() => void>();

function readStoredTheme(): Theme {
	if (typeof document === "undefined") return "dark";
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// localStorage can be unavailable (private mode / blocked cookies).
	}
	return "dark";
}

let currentTheme: Theme = readStoredTheme();

function applyTheme(theme: Theme) {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.setAttribute("data-theme", theme);
	root.classList.toggle("dark", theme === "dark");
	root.style.colorScheme = theme;
}

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot() {
	return currentTheme;
}

export function setTheme(next: Theme) {
	currentTheme = next;
	applyTheme(next);
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// ignore
	}
	emit();
}

// Keep multiple tabs / windows of the dashboard in sync.
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key !== STORAGE_KEY) return;
		currentTheme = readStoredTheme();
		applyTheme(currentTheme);
		emit();
	});
}

export function useTheme() {
	const theme = useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => "dark" as const,
	);

	const toggle = useCallback(() => {
		setTheme(currentTheme === "dark" ? "light" : "dark");
	}, []);

	return { theme, toggle, setTheme };
}

/** Imperative initialisation, called once from `main.tsx`. */
export function initTheme() {
	applyTheme(currentTheme);
}
