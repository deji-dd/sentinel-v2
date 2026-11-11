import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

import { api, apiBaseUrl } from "../lib/api";

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
	loginWithDiscord: (redirectTo?: string) => void;
}

const AuthContext = createContext<AuthContextValue>({
	user: null,
	authenticated: false,
	loading: true,
	refresh: async () => {},
	logout: async () => {},
	loginWithDiscord: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			// Development cross-port login returns the session as a token in the
			// URL because cookies are host-scoped locally. Consume it into a
			// cookie and strip it before the API call.
			const url = new URL(window.location.href);
			let token =
				url.searchParams.get("token") ?? url.searchParams.get("session");
			if (!token && window.location.hash.includes("token=")) {
				const hashParams = new URLSearchParams(
					window.location.hash.split("?")[1] || "",
				);
				token = hashParams.get("token") ?? hashParams.get("session");
			}
			if (token) {
				document.cookie = `session=${token}; path=/; max-age=${7 * 86400}; SameSite=Lax`;
				const cleanHash = window.location.hash.split("?")[0] || "#/";
				window.history.replaceState(
					null,
					"",
					`${window.location.pathname}${cleanHash}`,
				);
			}

			const res = await api.v2.auth.me.get();
			if (res.data && typeof res.data === "object" && "user" in res.data) {
				const data = res.data as {
					authenticated: boolean;
					user: AuthUser | null;
				};
				setUser(data.user);
			} else {
				setUser(null);
			}
		} catch {
			setUser(null);
		} finally {
			setLoading(false);
		}
	}, []);

	const logout = useCallback(async () => {
		try {
			await api.v2.auth.logout.post();
		} catch {
			// ignore
		}
		setUser(null);
		window.location.hash = "#/";
	}, []);

	const loginWithDiscord = useCallback((redirectTo = "/portfolio") => {
		const target = encodeURIComponent(
			`${window.location.origin}/#${redirectTo}`,
		);
		window.location.href = `${apiBaseUrl}/v2/auth/discord?redirect_to=${target}`;
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
				loginWithDiscord,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextValue {
	return useContext(AuthContext);
}
