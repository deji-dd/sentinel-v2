import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

interface ThemeContextValue {
	theme: Theme;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
	toggle: () => void;
}

const STORAGE_KEY = "sentinel-theme";

function getSystemTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function getInitialTheme(): Theme {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") {
			return stored;
		}
	} catch {
		// Ignore local storage read errors
	}
	return "dark";
}

function resolveTheme(theme: Theme): ResolvedTheme {
	if (theme === "system") {
		return getSystemTheme();
	}
	return theme;
}

function applyThemeToDom(resolved: ResolvedTheme) {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.setAttribute("data-theme", resolved);
	if (resolved === "dark") {
		root.classList.add("dark");
		root.classList.remove("light");
	} else {
		root.classList.remove("dark");
		root.classList.add("light");
	}
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
	children,
	defaultTheme = "dark",
	storageKey = STORAGE_KEY,
}: {
	children: ReactNode;
	defaultTheme?: Theme;
	storageKey?: string;
}) {
	const [theme, setThemeState] = useState<Theme>(() => {
		const initial = getInitialTheme() || defaultTheme;
		const resolved = resolveTheme(initial);
		applyThemeToDom(resolved);
		return initial;
	});

	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

	useEffect(() => {
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => {
			const nextSystem = e.matches ? "dark" : "light";
			setSystemTheme(nextSystem);
			if (theme === "system") {
				applyThemeToDom(nextSystem);
			}
		};

		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	}, [theme]);

	const resolvedTheme: ResolvedTheme = useMemo(() => {
		return theme === "system" ? systemTheme : theme;
	}, [theme, systemTheme]);

	useEffect(() => {
		applyThemeToDom(resolvedTheme);
	}, [resolvedTheme]);

	const setTheme = useCallback(
		(next: Theme) => {
			setThemeState(next);
			const resolved = resolveTheme(next);
			applyThemeToDom(resolved);
			try {
				localStorage.setItem(storageKey, next);
			} catch {
				// Ignore local storage write errors
			}
		},
		[storageKey],
	);

	const toggle = useCallback(() => {
		setTheme(resolvedTheme === "dark" ? "light" : "dark");
	}, [resolvedTheme, setTheme]);

	const value = useMemo(
		() => ({
			theme,
			resolvedTheme,
			setTheme,
			toggle,
		}),
		[theme, resolvedTheme, setTheme, toggle],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
