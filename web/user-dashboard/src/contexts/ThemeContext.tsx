import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

export type Theme = "dark" | "light";

interface ThemeContextValue {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	toggle: () => void;
}

const STORAGE_KEY = "sentinel-user-theme";

function getInitialTheme(): Theme {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark") return stored;
		if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
			return "light";
		}
	} catch {
		// ignore
	}
	return "dark";
}

function applyThemeToDom(theme: Theme) {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.setAttribute("data-theme", theme);
	if (theme === "dark") {
		root.classList.add("dark");
	} else {
		root.classList.remove("dark");
	}
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(() => {
		const initial = getInitialTheme();
		applyThemeToDom(initial);
		return initial;
	});

	const setTheme = useCallback((next: Theme) => {
		applyThemeToDom(next);
		setThemeState(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// ignore
		}
	}, []);

	useEffect(() => {
		applyThemeToDom(theme);
	}, [theme]);

	const toggle = useCallback(() => {
		setTheme(theme === "dark" ? "light" : "dark");
	}, [theme, setTheme]);

	return (
		<ThemeContext.Provider value={{ theme, setTheme, toggle }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return ctx;
}
