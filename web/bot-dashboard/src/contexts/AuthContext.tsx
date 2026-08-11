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
