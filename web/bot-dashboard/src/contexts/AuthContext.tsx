import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { api } from "../lib/api";

export interface AuthUser {
	id: number;
	discordId: string | null;
	tornId: number | null;
	username: string;
	avatar?: string | null;
	role: string;
}

interface AuthContextValue {
	user: AuthUser | null;
	authenticated: boolean;
	loading: boolean;
	refresh: () => Promise<void>;
	logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
	user: null,
	authenticated: false,
	loading: true,
	refresh: async () => {},
	logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			// Check if token was passed in URL hash/search during dev cross-subdomain redirect
			const urlObj = new URL(window.location.href);
			let token =
				urlObj.searchParams.get("token") || urlObj.searchParams.get("session");

			if (!token && window.location.hash.includes("token=")) {
				const hashParams = new URLSearchParams(
					window.location.hash.split("?")[1] || "",
				);
				token = hashParams.get("token") || hashParams.get("session");
			}

			if (token) {
				// biome-ignore lint/suspicious/noDocumentCookie: client session token handover across dev subdomains
				document.cookie = `session=${token}; path=/; max-age=${7 * 86400}; SameSite=Lax`;
				const cleanPath = window.location.pathname;

				window.history.replaceState(
					null,
					"",
					cleanPath === "/login" ? "/" : cleanPath,
				);
			}

			const res = await api.api.v1.auth.me.get();
			if (res.data && typeof res.data === "object" && "user" in res.data) {
				const data = res.data as {
					authenticated: boolean;
					user: AuthUser | null;
				};
				setUser(data.user);
			}
		} catch {
			setUser(null);
		} finally {
			setLoading(false);
		}
	}, []);

	const logout = useCallback(async () => {
		try {
			await api.api.v1.auth.logout.post();
		} catch {
			// ignore
		}
		setUser(null);
		window.history.pushState(null, "", "/login");
		window.dispatchEvent(new Event("popstate"));
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<AuthContext.Provider
			value={{
				user,
				authenticated: Boolean(user),
				loading,
				refresh,
				logout,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	return useContext(AuthContext);
}
