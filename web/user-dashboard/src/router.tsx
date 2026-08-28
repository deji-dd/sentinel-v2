import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

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

export function useRouter(): RouterContextValue {
	return useContext(RouterContext);
}
