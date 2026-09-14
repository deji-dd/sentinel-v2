import { Loader2 } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useAuth } from "./contexts/AuthContext";
import { useSubversive } from "./contexts/SubversiveContext";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { ServerSetupPage } from "./pages/ServerSetupPage";
import { UnauthorizedPage } from "./pages/UnauthorizedPage";
import { UnconfiguredPage } from "./pages/UnconfiguredPage";

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
		return (hash.slice(1).split("?")[0] ?? "/") || "/";
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
		window.location.hash = targetHash;
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

function PageFallback() {
	return (
		<div className="flex flex-col items-center justify-center h-screen w-screen gap-3 text-muted-foreground text-sm font-sans bg-background relative overflow-hidden">
			<Loader2 className="size-7 animate-spin text-primary relative z-10" />
			<div className="flex items-center gap-2 relative z-10 font-mono text-xs">
				<span className="font-bold text-foreground tracking-widest uppercase">
					SUBVERSIVE
				</span>
				<span className="text-muted-foreground uppercase tracking-wider">
					• Loading...
				</span>
			</div>
		</div>
	);
}

export function Router() {
	const { path, navigate } = useRouter();
	const { authenticated, loading: authLoading } = useAuth();
	const {
		configured,
		isOwner,
		hasAdminAccess,
		loading: subversiveLoading,
	} = useSubversive();

	const loading = authLoading || subversiveLoading;

	useEffect(() => {
		if (loading) return;

		if (!authenticated) {
			if (path !== "/login") {
				navigate("/login");
			}
			return;
		}

		// When authenticated:
		if (path === "/login") {
			if (!configured) {
				navigate(isOwner ? "/setup" : "/unconfigured");
			} else if (!hasAdminAccess) {
				navigate("/unauthorized");
			} else {
				navigate("/recruitment");
			}
		} else if (!configured) {
			if (isOwner && path !== "/setup") {
				navigate("/setup");
			} else if (!isOwner && path !== "/unconfigured") {
				navigate("/unconfigured");
			}
		} else if (!hasAdminAccess && path !== "/unauthorized") {
			navigate("/unauthorized");
		} else if (
			hasAdminAccess &&
			(path === "/unauthorized" || path === "/unconfigured")
		) {
			navigate("/recruitment");
		}
	}, [
		loading,
		authenticated,
		configured,
		isOwner,
		hasAdminAccess,
		path,
		navigate,
	]);

	if (loading) {
		return <PageFallback />;
	}

	if (!authenticated || path === "/login") {
		return <LoginPage />;
	}

	// Server not configured yet
	if (!configured) {
		if (isOwner) {
			return <ServerSetupPage />;
		}
		return <UnconfiguredPage />;
	}

	// Server configured, but user lacks admin role
	if (!hasAdminAccess) {
		return <UnauthorizedPage />;
	}

	// Owner can explicitly visit /setup to reconfigure
	if (isOwner && path === "/setup") {
		return <ServerSetupPage />;
	}

	return <DashboardPage />;
}
