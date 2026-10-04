import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { PageLoader } from "./components/PageLoader";
import { useAuth } from "./contexts/AuthContext";
import GuildShell from "./layouts/GuildShell";
import ClientContractCreatePage from "./pages/ClientContractCreatePage";
import ClientContractReceiptPage from "./pages/ClientContractReceiptPage";
import LoginPage from "./pages/LoginPage";
import ServerSelectorPage from "./pages/ServerSelectorPage";

// ─── Router Context ───────────────────────────────────────────────────────────
export interface RouterContextValue {
	path: string;
	search: string;
	queryParams: Record<string, string>;
	navigate: (to: string) => void;
}

const RouterContext = createContext<RouterContextValue>({
	path: "/",
	search: "",
	queryParams: {},
	navigate: () => {},
});

function parseLocation(): {
	path: string;
	search: string;
	queryParams: Record<string, string>;
} {
	let raw = "/";
	const hash = window.location.hash;
	if (hash.startsWith("#")) {
		raw = hash.slice(1) || "/";
	} else if (window.location.pathname && window.location.pathname !== "/") {
		raw = `${window.location.pathname}${window.location.search}`;
	}

	const [pathPart = "/", searchPart = ""] = raw.split("?");
	const normalizedPath = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
	const search = searchPart ? `?${searchPart}` : window.location.search || "";
	const queryParams: Record<string, string> = {};

	if (window.location.search) {
		const winSp = new URLSearchParams(window.location.search);
		for (const [key, value] of winSp.entries()) {
			queryParams[key] = value;
		}
	}
	if (searchPart) {
		const sp = new URLSearchParams(searchPart);
		for (const [key, value] of sp.entries()) {
			queryParams[key] = value;
		}
	}

	return {
		path: normalizedPath,
		search,
		queryParams,
	};
}

export function RouterProvider({ children }: { children: ReactNode }) {
	const [route, setRoute] = useState(parseLocation);

	useEffect(() => {
		const onLocationChange = () => setRoute(parseLocation());
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
		setRoute(parseLocation());
	};

	return (
		<RouterContext.Provider
			value={{
				path: route.path,
				search: route.search,
				queryParams: route.queryParams,
				navigate,
			}}
		>
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
	return <PageLoader label="Loading..." />;
}

// ─── Router ───────────────────────────────────────────────────────────────────
export function Router() {
	const { path, navigate } = useRouter();
	const { authenticated, loading } = useAuth();

	const isClientMercRoute =
		path === "/merc/create" || path.startsWith("/merc/receipt/");

	useEffect(() => {
		if (!loading && !isClientMercRoute) {
			if (!authenticated && path !== "/login") {
				if (path !== "/") {
					sessionStorage.setItem("sentinel_redirect_to", path);
				}
				navigate("/login");
			} else if (authenticated && path === "/login") {
				navigate("/");
			}
		}
	}, [loading, authenticated, path, navigate, isClientMercRoute]);

	if (isClientMercRoute) {
		if (path === "/merc/create") {
			return <ClientContractCreatePage />;
		}
		const receiptMatch = matchRoute("/merc/receipt/:contractId", path);
		if (receiptMatch.matched && receiptMatch.params.contractId) {
			return (
				<ClientContractReceiptPage
					contractId={receiptMatch.params.contractId}
				/>
			);
		}
	}

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
