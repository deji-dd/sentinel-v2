import { Loader2 } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useAuth } from "./contexts/AuthContext";
import GuildShell from "./layouts/GuildShell";
import LoginPage from "./pages/LoginPage";
import ServerSelectorPage from "./pages/ServerSelectorPage";

// ─── Router Context ───────────────────────────────────────────────────────────
interface RouterContextValue {
	path: string;
	navigate: (to: string) => void;
}

const RouterContext = createContext<RouterContextValue>({
	path: "/",
	navigate: () => {},
});

function getCurrentPath(): string {
	const hash = window.location.hash;
	if (hash.startsWith("#")) {
		return hash.slice(1) || "/";
	}
	const pathname = window.location.pathname;
	return pathname && pathname !== "/" ? pathname : "/";
}

export function RouterProvider({ children }: { children: ReactNode }) {
	const [path, setPath] = useState<string>(getCurrentPath);

	useEffect(() => {
		const onLocationChange = () => setPath(getCurrentPath());
		window.addEventListener("hashchange", onLocationChange);
		window.addEventListener("popstate", onLocationChange);
		return () => {
			window.removeEventListener("hashchange", onLocationChange);
			window.removeEventListener("popstate", onLocationChange);
		};
	}, []);

	const navigate = (to: string) => {
		const targetHash = `#${to.startsWith("/") ? to : `/${to}`}`;
		if (window.location.pathname !== "/") {
			window.history.replaceState(null, "", `/${targetHash}`);
		} else {
			window.location.hash = targetHash;
		}
		setPath(to.startsWith("/") ? to : `/${to}`);
	};

	return (
		<RouterContext.Provider value={{ path, navigate }}>
			{children}
		</RouterContext.Provider>
	);
}

export function useRouter() {
	return useContext(RouterContext);
}

// ─── Route Matching ───────────────────────────────────────────────────────────
function matchRoute(
	pattern: string,
	path: string,
): { matched: boolean; params: Record<string, string> } {
	const patternParts = pattern.split("/").filter(Boolean);
	const pathParts = path.split("/").filter(Boolean);

	if (patternParts.length !== pathParts.length && !pattern.endsWith("*")) {
		return { matched: false, params: {} };
	}

	const params: Record<string, string> = {};

	for (let i = 0; i < patternParts.length; i++) {
		const pp = patternParts[i];
		const pathPart = pathParts[i];

		if (pp === undefined || pathPart === undefined) {
			return { matched: false, params: {} };
		}

		if (pp === "*") break;

		if (pp.startsWith(":")) {
			params[pp.slice(1)] = pathPart;
		} else if (pp !== pathPart) {
			return { matched: false, params: {} };
		}
	}

	return { matched: true, params };
}

// ─── Page Fallback ────────────────────────────────────────────────────────────
export function PageFallback() {
	return (
		<div className="flex flex-col items-center justify-center h-screen w-screen gap-3 text-muted-foreground text-sm font-sans bg-background relative overflow-hidden">
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[500px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
			<Loader2 className="size-7 animate-spin text-primary relative z-10" />
			<div className="flex items-center gap-2 relative z-10 font-mono text-xs">
				<span className="font-bold text-foreground tracking-widest uppercase">
					SENTINEL
				</span>
				<span className="text-muted-foreground uppercase tracking-wider">
					• Loading...
				</span>
			</div>
		</div>
	);
}

// ─── Router ───────────────────────────────────────────────────────────────────
export function Router() {
	const { path, navigate } = useRouter();
	const { authenticated, loading } = useAuth();

	useEffect(() => {
		if (!loading) {
			if (!authenticated && path !== "/login") {
				navigate("/login");
			} else if (authenticated && path === "/login") {
				navigate("/");
			}
		}
	}, [loading, authenticated, path, navigate]);

	if (loading) {
		return <PageFallback />;
	}

	if (!authenticated) {
		return <LoginPage />;
	}

	const isGuildRoute =
		matchRoute("/guilds/:guildId*", path).matched ||
		path.startsWith("/guilds/");

	if (path === "/login") {
		return <LoginPage />;
	}

	if (isGuildRoute) {
		return <GuildShell />;
	}

	// default → server selector / home
	return <ServerSelectorPage />;
}
