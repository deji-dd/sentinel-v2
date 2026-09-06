import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { toast } from "sonner";
import { useAuth } from "./AuthContext";

export interface ElimsGuildSummary {
	id: string;
	name: string;
	icon: string | null;
}

export interface ElimsContextValue {
	configured: boolean;
	isOwner: boolean;
	hasAdminAccess: boolean;
	reason: string;
	guild: ElimsGuildSummary | null;
	adminRoleIds: string[];
	loading: boolean;
	refreshStatus: () => Promise<void>;
	recheckAccess: () => Promise<{ success: boolean; hasAdminAccess: boolean }>;
}

const ElimsContext = createContext<ElimsContextValue>({
	configured: false,
	isOwner: false,
	hasAdminAccess: false,
	reason: "loading",
	guild: null,
	adminRoleIds: [],
	loading: true,
	refreshStatus: async () => {},
	recheckAccess: async () => ({ success: false, hasAdminAccess: false }),
});

export function ElimsProvider({ children }: { children: ReactNode }) {
	const { authenticated, loading: authLoading } = useAuth();
	const [configured, setConfigured] = useState(false);
	const [isOwner, setIsOwner] = useState(false);
	const [hasAdminAccess, setHasAdminAccess] = useState(false);
	const [reason, setReason] = useState("loading");
	const [guild, setGuild] = useState<ElimsGuildSummary | null>(null);
	const [adminRoleIds, setAdminRoleIds] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);

	const refreshStatus = useCallback(async () => {
		if (!authenticated) {
			setConfigured(false);
			setIsOwner(false);
			setHasAdminAccess(false);
			setReason("unauthenticated");
			setGuild(null);
			setAdminRoleIds([]);
			setLoading(false);
			return;
		}

		try {
			const res = await fetch("/api/v1/elims/status");
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				configured: boolean;
				isOwner: boolean;
				hasAdminAccess: boolean;
				reason: string;
				guild: ElimsGuildSummary | null;
				adminRoleIds?: string[];
			};

			setConfigured(data.configured);
			setIsOwner(data.isOwner);
			setHasAdminAccess(data.hasAdminAccess);
			setReason(data.reason);
			setGuild(data.guild);
			setAdminRoleIds(data.adminRoleIds ?? []);
		} catch (err) {
			console.error("Failed to fetch elims status:", err);
			setReason("network_error");
		} finally {
			setLoading(false);
		}
	}, [authenticated]);

	const recheckAccess = useCallback(async () => {
		try {
			const res = await fetch("/api/v1/elims/verify-access", {
				method: "POST",
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				success: boolean;
				configured: boolean;
				hasAdminAccess: boolean;
				reason: string;
			};

			setConfigured(data.configured);
			setHasAdminAccess(data.hasAdminAccess);
			setReason(data.reason);

			if (data.hasAdminAccess) {
				toast.success("Permissions verified! Access granted.");
				await refreshStatus();
			} else {
				toast.error("Role check complete: Admin access not yet granted.");
			}

			return { success: true, hasAdminAccess: data.hasAdminAccess };
		} catch (err) {
			console.error("Failed to verify access:", err);
			toast.error("Failed to verify permissions. Please try again.");
			return { success: false, hasAdminAccess: false };
		}
	}, [refreshStatus]);

	useEffect(() => {
		if (!authLoading) {
			void refreshStatus();
		}
	}, [authLoading, refreshStatus]);

	return (
		<ElimsContext.Provider
			value={{
				configured,
				isOwner,
				hasAdminAccess,
				reason,
				guild,
				adminRoleIds,
				loading: authLoading || loading,
				refreshStatus,
				recheckAccess,
			}}
		>
			{children}
		</ElimsContext.Provider>
	);
}

export function useElims() {
	return useContext(ElimsContext);
}
