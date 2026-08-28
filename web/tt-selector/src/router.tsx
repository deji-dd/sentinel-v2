import { Loader2 } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useAuth } from "./contexts/AuthContext";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";

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
		return (
			<div className="flex flex-col items-center justify-center h-screen w-screen gap-3 text-zinc-400 text-sm font-sans bg-[#07090e]">
				<Loader2 className="size-8 animate-spin text-amber-500" />
				<div className="flex items-center gap-2 font-mono text-xs text-zinc-400">
					<span className="font-bold text-amber-400 tracking-widest uppercase">
						TT-SELECTOR
					</span>
				</div>
			</div>
		);
	}

	if (!authenticated || path === "/login") {
		return <LoginPage />;
	}

	return <DashboardPage />;
}
