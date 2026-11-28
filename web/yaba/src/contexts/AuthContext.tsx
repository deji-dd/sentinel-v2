import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

import { api, getApiBaseUrl } from "@/lib/api";
import type { AuthUser } from "@/lib/types";

interface AuthContextValue {
	user: AuthUser | null;
	authenticated: boolean;
	isAdmin: boolean;
	loading: boolean;
	loginUrl: string;
	refresh: () => Promise<void>;
	logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
	user: null,
	authenticated: false,
	isAdmin: false,
	loading: true,
	loginUrl: "#",
	refresh: async () => {},
	logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const res = await api.v2.auth.me.get();
			if (res.data && typeof res.data === "object" && "user" in res.data) {
				setUser(res.data.user ?? null);
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
			// The local state is cleared either way.
		}
		setUser(null);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const loginUrl = `${getApiBaseUrl()}/v2/auth/discord?redirect_to=${encodeURIComponent(window.location.href)}`;
	const role = user?.role;

	return (
		<AuthContext.Provider
			value={{
				user,
				authenticated: Boolean(user),
				isAdmin: role === "admin" || role === "owner",
				loading,
				loginUrl,
				refresh,
				logout,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextValue {
	return useContext(AuthContext);
}
