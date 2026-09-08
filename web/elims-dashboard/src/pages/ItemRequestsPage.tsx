import {
	Check,
	CheckCircle2,
	Clock,
	Copy,
	Download,
	ExternalLink,
	FileText,
	Loader2,
	MoreHorizontal,
	Package,
	RefreshCw,
	Save,
	Search,
	ShieldAlert,
	SlidersHorizontal,
	Trash2,
	User,
	Users,
	UserX,
	X,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTctTimestamp } from "@/lib/utils";
import { useElims } from "../contexts/ElimsContext";

export interface WhitelistedItem {
	id: string;
	name: string;
	category: string;
	marketPrice?: number;
	image?: string;
	maxRequestable?: number;
	disabled?: boolean;
}

export interface GuildMemberSummary {
	id: string;
	username: string;
	displayName: string;
	avatar: string | null;
}

export interface ItemStock {
	itemId: string;
	itemName: string;
	category?: string;
	deposited: number;
	consumed: number;
	available: number;
	image?: string;
	marketPrice?: number;
}

export interface DiscordChannel {
	id: string;
	name: string;
	type: number;
}

export interface GuildRole {
	id: string;
	name: string;
	color: number;
	position: number;
	managed: boolean;
}

export interface ItemRequestLog {
	id: string;
	guildId: string;
	discordUserId: string;
	discordUsername: string;
	tornId: number | null;
	tornName: string | null;
	itemId: string;
	itemName: string;
	itemCategory: string;
	quantity: number;
	status: "pending" | "accepted" | "rejected";
	verificationStatus?: "pending_verification" | "verified" | "bypassed" | null;
	isTest: boolean;
	reason: string | null;
	handledByDiscordId: string | null;
	handledByUsername: string | null;
	handledByTornId?: number | null;
	handledByTornName?: string | null;
	handledAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ArmoryDeposit {
	id: string;
	discordUserId: string;
	discordUsername: string;
	tornId: number | null;
	tornName: string | null;
	itemId: string;
	itemName: string;
	itemCategory: string;
	quantity: number;
	rawLog: string | null;
	logTimestamp?: string | null;
	logMessage?: string | null;
	isTest: boolean;
	status: string;
	createdAt: string;
}

function formatCurrency(val?: number): string {
	if (val === undefined || Number.isNaN(val)) return "$0";
	return `$${val.toLocaleString()}`;
}

function formatRoleColor(color: number): string {
	if (color === 0) return "#94a3b8";
	return `#${color.toString(16).padStart(6, "0")}`;
}

interface ItemRequestsConfigSnapshot {
	requestChannelId: string | null;
	grantingChannelId: string | null;
	storageChannelId: string | null;
	stockHoldersChannelId: string | null;
	requesterRoleIds: string[];
	managerRoleIds: string[];
	blacklistedUserIds: string[];
	allowedItems: WhitelistedItem[];
}

export function ItemRequestsPage() {
	const { guild, hasAdminAccess, isOwner } = useElims();

	// ─── Settings State ────────────────────────────────────────────────────────
	const [requestChannelId, setRequestChannelId] = useState<string | null>(null);
	const [grantingChannelId, setGrantingChannelId] = useState<string | null>(
		null,
	);
	const [storageChannelId, setStorageChannelId] = useState<string | null>(null);
	const [stockHoldersChannelId, setStockHoldersChannelId] = useState<
		string | null
	>(null);
	const [requesterRoleIds, setRequesterRoleIds] = useState<string[]>([]);
	const [managerRoleIds, setManagerRoleIds] = useState<string[]>([]);
	const [blacklistedUserIds, setBlacklistedUserIds] = useState<string[]>([]);
	const [allowedItems, setAllowedItems] = useState<WhitelistedItem[]>([]);
	const [stockHolders, setStockHolders] = useState<
		Array<{
			id: string;
			discordUserId: string;
			discordUsername: string;
			itemId: string;
			itemName: string;
			quantity: number;
			updatedAt: string;
		}>
	>([]);
	const [loadingStockHolders, setLoadingStockHolders] = useState(false);
	const [initialConfig, setInitialConfig] =
		useState<ItemRequestsConfigSnapshot | null>(null);
	const [loadingConfig, setLoadingConfig] = useState(true);
	const [savingConfig, setSavingConfig] = useState(false);

	// ─── Server Members for Blacklist Search ─────────────────────────────────
	const [guildMembers, setGuildMembers] = useState<GuildMemberSummary[]>([]);
	const [loadingMembers, setLoadingMembers] = useState(false);
	const [memberSearchQuery, setMemberSearchQuery] = useState("");
	const [isMemberDropdownOpen, setIsMemberDropdownOpen] = useState(false);
	const memberSearchRef = useRef<HTMLDivElement | null>(null);

	// ─── Armory Stock Inventory State ──────────────────────────────────────────
	const [stockInventory, setStockInventory] = useState<ItemStock[]>([]);
	const stockInventoryRef = useRef<ItemStock[]>([]);
	const [loadingStock, setLoadingStock] = useState(false);

	// Channels and Roles options from Discord
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [roles, setRoles] = useState<GuildRole[]>([]);
	const [loadingChannels, setLoadingChannels] = useState(false);
	const [loadingRoles, setLoadingRoles] = useState(false);

	// ─── In-Stock Requestable Items Filter State ──────────────────────────────
	const [itemFilterQuery, setItemFilterQuery] = useState("");
	const [itemStatusFilter, setItemStatusFilter] = useState<
		"all" | "in-stock" | "enabled" | "disabled"
	>("all");

	// ─── Logs & History State ──────────────────────────────────────────────────
	const [logs, setLogs] = useState<ItemRequestLog[]>([]);
	const [logsLoading, setLogsLoading] = useState(false);
	const [initialLogsLoading, setInitialLogsLoading] = useState(true);
	const [logsPage, setLogsPage] = useState(1);
	const [logsTotalPages, setLogsTotalPages] = useState(1);
	const [logsTotalCount, setLogsTotalCount] = useState(0);
	const [statusFilter, setStatusFilter] = useState("all");
	const [logsSearch, setLogsSearch] = useState("");
	const [debouncedLogsSearch, setDebouncedLogsSearch] = useState("");
	const logsAbortControllerRef = useRef<AbortController | null>(null);

	// ─── Depositor History State ───────────────────────────────────────────────
	const [deposits, setDeposits] = useState<ArmoryDeposit[]>([]);
	const [depositsLoading, setDepositsLoading] = useState(false);
	const [initialDepositsLoading, setInitialDepositsLoading] = useState(true);
	const [depositsPage, setDepositsPage] = useState(1);
	const [depositsTotalPages, setDepositsTotalPages] = useState(1);
	const [depositsTotalCount, setDepositsTotalCount] = useState(0);
	const [depositsSearch, setDepositsSearch] = useState("");
	const [debouncedDepositsSearch, setDebouncedDepositsSearch] = useState("");
	const [selectedRejectionLog, setSelectedRejectionLog] =
		useState<ItemRequestLog | null>(null);
	const [isClearLogsDialogOpen, setIsClearLogsDialogOpen] = useState(false);
	const [isClearingLogs, setIsClearingLogs] = useState(false);
	const [selectedRawLog, setSelectedRawLog] = useState<{
		title: string;
		rawLog: string | null;
	} | null>(null);
	const depositsAbortControllerRef = useRef<AbortController | null>(null);

	// ─── Stock Inventory Merger Helper ────────────────────────────────────────
	const mergeStockWithAllowedItems = useCallback(
		(
			stockList: ItemStock[],
			existingAllowed: WhitelistedItem[],
		): WhitelistedItem[] => {
			const existingMap = new Map<string, WhitelistedItem>();
			for (const item of existingAllowed) {
				if (item.id) existingMap.set(item.id, item);
				if (item.name) existingMap.set(item.name.trim().toLowerCase(), item);
			}

			const merged: WhitelistedItem[] = [];
			const seenKeys = new Set<string>();

			// 1. Add all items from stockList (excluding money)
			for (const s of stockList) {
				const lowerName = s.itemName.trim().toLowerCase();
				if (s.itemId === "money" || lowerName === "money") continue;
				const key = s.itemId || lowerName;
				if (seenKeys.has(key)) continue;
				seenKeys.add(key);

				const existing =
					existingMap.get(s.itemId) ?? existingMap.get(lowerName);
				if (existing) {
					merged.push({
						...existing,
						name: s.itemName,
						category: s.category || existing.category || "General",
						image: s.image ?? existing.image,
						marketPrice: s.marketPrice ?? existing.marketPrice,
						disabled: existing.disabled ?? false,
					});
				} else {
					merged.push({
						id: s.itemId || s.itemName,
						name: s.itemName,
						category: s.category || "General",
						image: s.image,
						marketPrice: s.marketPrice,
						maxRequestable: undefined,
						disabled: false, // Default enabled!
					});
				}
			}

			// 2. Retain any previously configured items in existingAllowed (if not in stockList)
			for (const item of existingAllowed) {
				const lowerName = item.name.trim().toLowerCase();
				if (item.id === "money" || lowerName === "money") continue;
				const key = item.id || lowerName;
				if (!seenKeys.has(key)) {
					seenKeys.add(key);
					merged.push({
						...item,
						disabled: item.disabled ?? false,
					});
				}
			}

			return merged;
		},
		[],
	);

	// ─── Fetch Stock Inventory ────────────────────────────────────────────────
	const fetchStock = useCallback(async () => {
		setLoadingStock(true);
		try {
			const res = await fetch("/api/v1/elims/item-requests/storage/inventory");
			if (!res.ok) return null;
			const raw = (await res.json()) as unknown;
			const data =
				raw && typeof raw === "object" && "inventory" in raw
					? (raw as { inventory: unknown }).inventory
					: raw;
			if (
				data &&
				typeof data === "object" &&
				"live" in data &&
				Array.isArray(data.live)
			) {
				const liveList = data.live as ItemStock[];
				stockInventoryRef.current = liveList;
				setStockInventory(liveList);
				setAllowedItems((prev) => mergeStockWithAllowedItems(liveList, prev));
				setInitialConfig((prev) => {
					if (!prev) return prev;
					return {
						...prev,
						allowedItems: mergeStockWithAllowedItems(
							liveList,
							prev.allowedItems,
						),
					};
				});
				return data;
			}
			return null;
		} catch (err) {
			console.error("Failed to load armory stock:", err);
			return null;
		} finally {
			setLoadingStock(false);
		}
	}, [mergeStockWithAllowedItems]);

	// ─── Fetch Channels ───────────────────────────────────────────────────────
	const fetchChannels = useCallback(async () => {
		if (!guild?.id) return [];
		setLoadingChannels(true);
		try {
			const res = await fetch(`/api/v1/elims/guild-channels/${guild.id}`);
			if (!res.ok) throw new Error("Failed to load guild channels");
			const data = (await res.json()) as unknown;
			if (
				data &&
				typeof data === "object" &&
				"channels" in data &&
				Array.isArray(data.channels)
			) {
				const chs = data.channels as DiscordChannel[];
				setChannels(chs);
				return chs;
			}
			return [];
		} catch (err) {
			console.error("Failed to load guild channels:", err);
			return [];
		} finally {
			setLoadingChannels(false);
		}
	}, [guild?.id]);

	// ─── Fetch Roles ──────────────────────────────────────────────────────────
	const fetchRoles = useCallback(async () => {
		if (!guild?.id) return [];
		setLoadingRoles(true);
		try {
			const res = await fetch(`/api/v1/elims/guild-roles/${guild.id}`);
			if (!res.ok) throw new Error("Failed to load guild roles");
			const data = (await res.json()) as unknown;
			if (
				data &&
				typeof data === "object" &&
				"roles" in data &&
				Array.isArray(data.roles)
			) {
				const rls = data.roles as GuildRole[];
				setRoles(rls);
				return rls;
			}
			return [];
		} catch (err) {
			console.error("Failed to load guild roles:", err);
			return [];
		} finally {
			setLoadingRoles(false);
		}
	}, [guild?.id]);

	// ─── Fetch Members ────────────────────────────────────────────────────────
	const fetchMembers = useCallback(
		async (fresh = false) => {
			if (!guild?.id) return [];
			setLoadingMembers(true);
			try {
				const queryParam = fresh ? "?fresh=true" : "";
				const res = await fetch(
					`/api/v1/elims/guild-members/${guild.id}${queryParam}`,
				);
				if (!res.ok) throw new Error("Failed to load guild members");
				const data = (await res.json()) as unknown;
				if (
					data &&
					typeof data === "object" &&
					"members" in data &&
					Array.isArray(data.members)
				) {
					const mbrs = data.members as GuildMemberSummary[];
					setGuildMembers(mbrs);
					return mbrs;
				}
				return [];
			} catch (err) {
				console.error("Failed to load guild members:", err);
				return [];
			} finally {
				setLoadingMembers(false);
			}
		},
		[guild?.id],
	);

	// ─── Fetch Stock Holders ──────────────────────────────────────────────────
	const fetchStockHolders = useCallback(async () => {
		if (!guild?.id) return [];
		setLoadingStockHolders(true);
		try {
			const res = await fetch("/api/v1/elims/item-requests/stock-holders");
			if (!res.ok) throw new Error("Failed to load stock holders");
			const data = (await res.json()) as unknown;
			if (
				data &&
				typeof data === "object" &&
				"holders" in data &&
				Array.isArray(data.holders)
			) {
				const hlds = data.holders as Array<{
					id: string;
					discordUserId: string;
					discordUsername: string;
					itemId: string;
					itemName: string;
					quantity: number;
					updatedAt: string;
				}>;
				setStockHolders(hlds);
				return hlds;
			}
			return [];
		} catch (err) {
			console.error("Failed to load stock holders:", err);
			return [];
		} finally {
			setLoadingStockHolders(false);
		}
	}, [guild?.id]);

	// ─── Fetch Config ─────────────────────────────────────────────────────────
	const fetchConfig = useCallback(async () => {
		setLoadingConfig(true);
		try {
			const res = await fetch("/api/v1/elims/item-requests/config");
			if (!res.ok) throw new Error("Failed to load item request config");
			const data = (await res.json()) as unknown;
			if (
				data &&
				typeof data === "object" &&
				"config" in data &&
				data.config &&
				typeof data.config === "object"
			) {
				const cfg = data.config as Record<string, unknown>;
				const cfgAllowed = (cfg.allowedItems as WhitelistedItem[]) ?? [];
				const mergedAllowed = mergeStockWithAllowedItems(
					stockInventoryRef.current,
					cfgAllowed,
				);
				const snapshot: ItemRequestsConfigSnapshot = {
					requestChannelId: (cfg.requestChannelId as string) ?? null,
					grantingChannelId: (cfg.grantingChannelId as string) ?? null,
					storageChannelId: (cfg.storageChannelId as string) ?? null,
					stockHoldersChannelId: (cfg.stockHoldersChannelId as string) ?? null,
					requesterRoleIds: (cfg.requesterRoleIds as string[]) ?? [],
					managerRoleIds: (cfg.managerRoleIds as string[]) ?? [],
					blacklistedUserIds: (cfg.blacklistedUserIds as string[]) ?? [],
					allowedItems: mergedAllowed,
				};
				setRequestChannelId(snapshot.requestChannelId);
				setGrantingChannelId(snapshot.grantingChannelId);
				setStorageChannelId(snapshot.storageChannelId);
				setStockHoldersChannelId(snapshot.stockHoldersChannelId);
				setRequesterRoleIds(snapshot.requesterRoleIds);
				setManagerRoleIds(snapshot.managerRoleIds);
				setBlacklistedUserIds(snapshot.blacklistedUserIds);
				setAllowedItems(mergedAllowed);
				setInitialConfig(snapshot);
				return cfg;
			}
			return null;
		} catch (err) {
			console.error("Failed to load item request config:", err);
			return null;
		} finally {
			setLoadingConfig(false);
		}
	}, [mergeStockWithAllowedItems]);

	// ─── 1. Load Config & Channels & Roles & Stock & Members on Mount ─────────
	useEffect(() => {
		if (!guild?.id) return;
		void fetchConfig();
		void fetchStock();
		void fetchStockHolders();
		void fetchChannels();
		void fetchRoles();
		void fetchMembers(false);
	}, [
		guild?.id,
		fetchConfig,
		fetchStock,
		fetchStockHolders,
		fetchChannels,
		fetchRoles,
		fetchMembers,
	]);

	// Close member search dropdown on click outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				memberSearchRef.current &&
				!memberSearchRef.current.contains(e.target as Node)
			) {
				setIsMemberDropdownOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	// Debounce logsSearch to prevent request storm and layout flicker on every keystroke
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedLogsSearch(logsSearch);
		}, 300);
		return () => clearTimeout(timer);
	}, [logsSearch]);

	const logsPageRef = useRef(logsPage);
	logsPageRef.current = logsPage;

	// ─── 3. Fetch Request Logs ────────────────────────────────────────────────
	const fetchLogs = useCallback(
		(page?: number, search = debouncedLogsSearch) => {
			const targetPage = page ?? logsPageRef.current;
			if (logsAbortControllerRef.current) {
				logsAbortControllerRef.current.abort();
			}
			const abortController = new AbortController();
			logsAbortControllerRef.current = abortController;

			setLogsLoading(true);
			const params = new URLSearchParams({
				page: String(targetPage),
				limit: "15",
			});
			if (statusFilter !== "all") params.set("status", statusFilter);
			if (search.trim()) params.set("search", search.trim());

			fetch(`/api/v1/elims/item-requests/logs?${params.toString()}`, {
				signal: abortController.signal,
			})
				.then((res) => (res.ok ? res.json() : null))
				.then((data: unknown) => {
					if (
						data &&
						typeof data === "object" &&
						"logs" in data &&
						Array.isArray(data.logs) &&
						"pagination" in data
					) {
						setLogs(data.logs as ItemRequestLog[]);
						const pagination = data.pagination as {
							page: number;
							totalPages: number;
							total: number;
						};
						setLogsPage(pagination.page);
						setLogsTotalPages(pagination.totalPages);
						setLogsTotalCount(pagination.total);
					}
				})
				.catch((err: unknown) => {
					if (err instanceof Error && err.name === "AbortError") {
						return;
					}
					console.error("Failed to fetch logs:", err);
				})
				.finally(() => {
					if (logsAbortControllerRef.current === abortController) {
						setLogsLoading(false);
						setInitialLogsLoading(false);
					}
				});
		},
		[statusFilter, debouncedLogsSearch],
	);

	useEffect(() => {
		fetchLogs(1, debouncedLogsSearch);
	}, [statusFilter, debouncedLogsSearch, fetchLogs]);

	// ─── Debounce Depositor Search ─────────────────────────────────────────────
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedDepositsSearch(depositsSearch);
		}, 300);
		return () => clearTimeout(timer);
	}, [depositsSearch]);

	const depositsPageRef = useRef(depositsPage);
	depositsPageRef.current = depositsPage;

	// ─── Fetch Depositor History ──────────────────────────────────────────────
	const fetchDeposits = useCallback(
		(page?: number, search = debouncedDepositsSearch) => {
			const targetPage = page ?? depositsPageRef.current;
			if (depositsAbortControllerRef.current) {
				depositsAbortControllerRef.current.abort();
			}
			const abortController = new AbortController();
			depositsAbortControllerRef.current = abortController;

			setDepositsLoading(true);
			const params = new URLSearchParams({
				page: String(targetPage),
				limit: "15",
			});
			if (search.trim()) params.set("search", search.trim());

			fetch(`/api/v1/elims/item-requests/deposits?${params.toString()}`, {
				signal: abortController.signal,
			})
				.then((res) => (res.ok ? res.json() : null))
				.then((data: unknown) => {
					if (
						data &&
						typeof data === "object" &&
						"deposits" in data &&
						Array.isArray(data.deposits) &&
						"pagination" in data
					) {
						setDeposits(data.deposits as ArmoryDeposit[]);
						const pagination = data.pagination as {
							page: number;
							totalPages: number;
							total: number;
						};
						setDepositsPage(pagination.page);
						setDepositsTotalPages(pagination.totalPages);
						setDepositsTotalCount(pagination.total);
					}
				})
				.catch((err: unknown) => {
					if (err instanceof Error && err.name === "AbortError") {
						return;
					}
					console.error("Failed to fetch deposits:", err);
				})
				.finally(() => {
					if (depositsAbortControllerRef.current === abortController) {
						setDepositsLoading(false);
						setInitialDepositsLoading(false);
					}
				});
		},
		[debouncedDepositsSearch],
	);

	useEffect(() => {
		fetchDeposits(1, debouncedDepositsSearch);
	}, [debouncedDepositsSearch, fetchDeposits]);

	// ─── CSV Export ───────────────────────────────────────────────────────────
	const [isExporting, setIsExporting] = useState(false);

	const handleDownloadCsv = async (exportAll = false) => {
		setIsExporting(true);
		try {
			const params = new URLSearchParams();
			if (!exportAll) {
				if (statusFilter !== "all") params.set("status", statusFilter);
				if (logsSearch.trim()) params.set("search", logsSearch.trim());
			}

			const res = await fetch(
				`/api/v1/elims/item-requests/logs/export?${params.toString()}`,
			);
			if (!res.ok) {
				throw new Error(`Export request failed with status: ${res.status}`);
			}
			const blob = await res.blob();
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.style.display = "none";
			a.href = url;
			const timestamp = new Date().toISOString().slice(0, 10);
			a.download = exportAll
				? `elims-item-requests-all-${timestamp}.csv`
				: `elims-item-requests-filtered-${timestamp}.csv`;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
			document.body.removeChild(a);
			toast.success(
				exportAll
					? "All item request logs exported to CSV successfully."
					: "Filtered item request logs exported to CSV successfully.",
			);
		} catch (err) {
			console.error("CSV export error:", err);
			toast.error("Failed to export logs as CSV.");
		} finally {
			setIsExporting(false);
		}
	};

	// ─── Toggle In-Stock Item Status & Actions ────────────────────────────────
	const handleToggleItemEnabled = (itemId: string, enabled: boolean) => {
		setAllowedItems((prev) =>
			prev.map((i) => (i.id === itemId ? { ...i, disabled: !enabled } : i)),
		);
	};

	const handleEnableAll = () => {
		setAllowedItems((prev) => prev.map((i) => ({ ...i, disabled: false })));
		toast.success("All stock items enabled for requests.");
	};

	const handleDisableAll = () => {
		setAllowedItems((prev) => prev.map((i) => ({ ...i, disabled: true })));
		toast.info("All stock items disabled for requests.");
	};

	// ─── Toggle Roles ─────────────────────────────────────────────────────────
	const toggleRole = (roleId: string, type: "requester" | "manager") => {
		if (type === "requester") {
			setRequesterRoleIds((prev) =>
				prev.includes(roleId)
					? prev.filter((id) => id !== roleId)
					: [...prev, roleId],
			);
		} else {
			setManagerRoleIds((prev) =>
				prev.includes(roleId)
					? prev.filter((id) => id !== roleId)
					: [...prev, roleId],
			);
		}
	};

	// ─── Whitelisted Item Max Requestable ─────────────────────────────────────
	const handleUpdateMaxRequestable = (itemId: string, max?: number) => {
		setAllowedItems((prev) =>
			prev.map((i) => (i.id === itemId ? { ...i, maxRequestable: max } : i)),
		);
	};

	// ─── Blacklist Member Search & Handlers ──────────────────────────────────
	const filteredMembers = useMemo(() => {
		const q = memberSearchQuery.trim().toLowerCase();
		if (!q) return guildMembers.slice(0, 30);
		return guildMembers
			.filter(
				(m) =>
					m.displayName.toLowerCase().includes(q) ||
					m.username.toLowerCase().includes(q) ||
					m.id.includes(q),
			)
			.slice(0, 30);
	}, [guildMembers, memberSearchQuery]);

	const memberMap = useMemo(() => {
		const map = new Map<string, GuildMemberSummary>();
		for (const m of guildMembers) {
			map.set(m.id, m);
		}
		return map;
	}, [guildMembers]);

	const handleSelectMemberToBlacklist = (member: GuildMemberSummary) => {
		if (blacklistedUserIds.includes(member.id)) {
			toast.info(`${member.displayName} is already blacklisted.`);
			return;
		}
		setBlacklistedUserIds((prev) => [...prev, member.id]);
		setMemberSearchQuery("");
		setIsMemberDropdownOpen(false);
	};

	const handleAddBlacklist = () => {
		const trimmed = memberSearchQuery.trim();
		if (!trimmed) return;
		if (blacklistedUserIds.includes(trimmed)) {
			toast.info("User is already blacklisted.");
			return;
		}
		setBlacklistedUserIds((prev) => [...prev, trimmed]);
		setMemberSearchQuery("");
		setIsMemberDropdownOpen(false);
	};

	const handleRemoveBlacklist = (userId: string) => {
		setBlacklistedUserIds((prev) => prev.filter((id) => id !== userId));
	};

	// ─── Computed Stock Map ───────────────────────────────────────────────────
	const currentStockMap = useMemo(() => {
		const map = new Map<string, ItemStock>();
		for (const s of stockInventory) {
			if (s.itemId) {
				map.set(s.itemId, s);
			}
			if (s.itemName) {
				map.set(s.itemName.trim().toLowerCase(), s);
			}
		}
		return map;
	}, [stockInventory]);

	const armoryCash = useMemo(() => {
		const moneyItem = stockInventory.find(
			(s) =>
				s.itemId === "money" || s.itemName.trim().toLowerCase() === "money",
		);
		return (
			moneyItem ?? {
				itemId: "money",
				itemName: "Money",
				category: "Currency",
				deposited: 0,
				consumed: 0,
				available: 0,
			}
		);
	}, [stockInventory]);

	// ─── Save Configuration ───────────────────────────────────────────────────
	const handleSaveConfig = async () => {
		setSavingConfig(true);
		try {
			const res = await fetch("/api/v1/elims/item-requests/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestChannelId: requestChannelId || null,
					grantingChannelId: grantingChannelId || null,
					storageChannelId: storageChannelId || null,
					stockHoldersChannelId: stockHoldersChannelId || null,
					requesterRoleIds,
					managerRoleIds,
					blacklistedUserIds,
					allowedItems,
				}),
			});

			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Failed to save configuration");
			}

			setInitialConfig({
				requestChannelId: requestChannelId || null,
				grantingChannelId: grantingChannelId || null,
				storageChannelId: storageChannelId || null,
				stockHoldersChannelId: stockHoldersChannelId || null,
				requesterRoleIds: [...requesterRoleIds],
				managerRoleIds: [...managerRoleIds],
				blacklistedUserIds: [...blacklistedUserIds],
				allowedItems: [...allowedItems],
			});

			toast.success("Item Requests configuration saved successfully!");
			fetchStock();
			fetchStockHolders();
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Error saving configuration";
			toast.error(msg);
		} finally {
			setSavingConfig(false);
		}
	};

	const hasUnsavedChanges = useMemo(() => {
		if (!initialConfig) return false;
		if ((requestChannelId || null) !== initialConfig.requestChannelId)
			return true;
		if ((grantingChannelId || null) !== initialConfig.grantingChannelId)
			return true;
		if ((storageChannelId || null) !== initialConfig.storageChannelId)
			return true;
		if ((stockHoldersChannelId || null) !== initialConfig.stockHoldersChannelId)
			return true;

		// Requester roles
		if (requesterRoleIds.length !== initialConfig.requesterRoleIds.length)
			return true;
		const reqSet = new Set(initialConfig.requesterRoleIds);
		if (requesterRoleIds.some((id) => !reqSet.has(id))) return true;

		// Manager roles
		if (managerRoleIds.length !== initialConfig.managerRoleIds.length)
			return true;
		const mgrSet = new Set(initialConfig.managerRoleIds);
		if (managerRoleIds.some((id) => !mgrSet.has(id))) return true;

		// Blacklist
		if (blacklistedUserIds.length !== initialConfig.blacklistedUserIds.length)
			return true;
		const blSet = new Set(initialConfig.blacklistedUserIds);
		if (blacklistedUserIds.some((id) => !blSet.has(id))) return true;

		// Allowed items
		if (allowedItems.length !== initialConfig.allowedItems.length) return true;
		const allowedMap = new Map(
			initialConfig.allowedItems.map((i) => [i.id, i]),
		);
		for (const item of allowedItems) {
			const init = allowedMap.get(item.id);
			if (!init) return true;
			if (item.maxRequestable !== init.maxRequestable) return true;
			if (Boolean(item.disabled) !== Boolean(init.disabled)) return true;
		}

		return false;
	}, [
		initialConfig,
		requestChannelId,
		grantingChannelId,
		storageChannelId,
		stockHoldersChannelId,
		requesterRoleIds,
		managerRoleIds,
		blacklistedUserIds,
		allowedItems,
	]);

	const handleResetChanges = () => {
		if (!initialConfig) return;
		setRequestChannelId(initialConfig.requestChannelId);
		setGrantingChannelId(initialConfig.grantingChannelId);
		setStorageChannelId(initialConfig.storageChannelId);
		setStockHoldersChannelId(initialConfig.stockHoldersChannelId);
		setRequesterRoleIds(initialConfig.requesterRoleIds);
		setManagerRoleIds(initialConfig.managerRoleIds);
		setBlacklistedUserIds(initialConfig.blacklistedUserIds);
		setAllowedItems(initialConfig.allowedItems);
		toast.info("Unsaved changes discarded.");
	};

	// ─── Clear All Logs (Owner Only) ──────────────────────────────────────────
	const handleClearLogs = async () => {
		setIsClearingLogs(true);
		try {
			const res = await fetch("/api/v1/elims/item-requests/clear-logs", {
				method: "POST",
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error || "Failed to clear logs");
			}
			const data = (await res.json()) as {
				success: boolean;
				clearedRequests: number;
				clearedDeposits: number;
				message?: string;
			};
			toast.success(
				data.message ||
					"All request logs and armory deposits have been cleared.",
			);
			setIsClearLogsDialogOpen(false);
			void fetchStock();
			void fetchLogs(1);
			void fetchDeposits(1);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Error clearing tournament logs",
			);
		} finally {
			setIsClearingLogs(false);
		}
	};

	// ─── Refresh All Dashboard Data ───────────────────────────────────────────
	const [isRefreshing, setIsRefreshing] = useState(false);

	const handleRefreshAll = useCallback(async () => {
		if (isRefreshing) return;
		setIsRefreshing(true);
		const toastId = toast.loading(
			"Refreshing channels, server members, armory stock, and logs...",
		);

		try {
			const [_] = await Promise.all([
				fetchChannels(),
				fetchMembers(true),
				fetchRoles(),
				fetchStock(),
				fetchStockHolders(),
				fetchConfig(),
				fetchLogs(logsPage, debouncedLogsSearch),
				fetchDeposits(depositsPage, debouncedDepositsSearch),
			]);

			toast.success(`Successfully refreshed.`, { id: toastId });
		} catch (err) {
			console.error("Dashboard refresh error:", err);
			toast.error("Failed to refresh some dashboard data.", { id: toastId });
		} finally {
			setIsRefreshing(false);
		}
	}, [
		isRefreshing,
		fetchChannels,
		fetchMembers,
		fetchRoles,
		fetchStock,
		fetchStockHolders,
		fetchConfig,
		fetchLogs,
		fetchDeposits,
		logsPage,
		debouncedLogsSearch,
		depositsPage,
		debouncedDepositsSearch,
	]);

	// Filtered allowed items based on search and status filters
	const filteredAllowedItems = useMemo(() => {
		const q = itemFilterQuery.trim().toLowerCase();
		return allowedItems.filter((item) => {
			const stock =
				currentStockMap.get(item.id)?.available ??
				currentStockMap.get(item.name.trim().toLowerCase())?.available ??
				0;

			if (itemStatusFilter === "enabled" && item.disabled) return false;
			if (itemStatusFilter === "disabled" && !item.disabled) return false;
			if (itemStatusFilter === "in-stock" && stock <= 0) return false;

			if (
				q &&
				!item.name.toLowerCase().includes(q) &&
				!item.category?.toLowerCase().includes(q)
			) {
				return false;
			}

			return true;
		});
	}, [allowedItems, currentStockMap, itemFilterQuery, itemStatusFilter]);

	// Group filtered allowed items by category
	const itemsByCategory = useMemo(() => {
		const groups: Record<string, WhitelistedItem[]> = {};
		for (const item of filteredAllowedItems) {
			const cat = item.category || "General";
			if (!groups[cat]) groups[cat] = [];
			groups[cat].push(item);
		}
		return groups;
	}, [filteredAllowedItems]);

	const enabledCount = useMemo(
		() => allowedItems.filter((i) => !i.disabled).length,
		[allowedItems],
	);
	const disabledCount = useMemo(
		() => allowedItems.filter((i) => Boolean(i.disabled)).length,
		[allowedItems],
	);
	const inStockCount = useMemo(() => {
		return allowedItems.filter((item) => {
			const stock =
				currentStockMap.get(item.id)?.available ??
				currentStockMap.get(item.name.trim().toLowerCase())?.available ??
				0;
			return stock > 0;
		}).length;
	}, [allowedItems, currentStockMap]);

	if (!hasAdminAccess && !isOwner) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[400px] text-center p-6 gap-4">
				<div className="size-12 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center text-destructive">
					<ShieldAlert className="size-6" />
				</div>
				<div className="flex flex-col gap-1 max-w-md">
					<h2 className="text-lg font-bold tracking-tight">
						Access Restricted
					</h2>
					<p className="text-xs text-muted-foreground">
						You must hold a designated Elims Admin or Manager role to configure
						item requests and inspect distribution logs.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6 max-w-7xl mx-auto w-full pb-16">
			{/* Page Header & System Status */}
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/60 pb-5">
				<div className="flex items-center gap-3">
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-xl font-bold tracking-tight text-foreground">
								Stock
							</h1>
						</div>
					</div>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{isOwner && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setIsClearLogsDialogOpen(true)}
							className="cursor-pointer gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
							title="Clear all request and deposit history (Sentinel Owner only)"
						>
							<Trash2 className="size-3.5" />
							<span>Clear Logs</span>
						</Button>
					)}

					<Button
						variant="outline"
						size="sm"
						onClick={handleRefreshAll}
						disabled={
							isRefreshing ||
							logsLoading ||
							loadingStock ||
							loadingStockHolders ||
							depositsLoading ||
							loadingChannels ||
							loadingMembers ||
							loadingRoles
						}
						className="cursor-pointer gap-1.5 min-w-[92px]"
						title="Refresh all dashboard data, Discord channels, server members, and logs"
					>
						<RefreshCw
							className={`size-3.5 ${
								isRefreshing ||
								logsLoading ||
								loadingStock ||
								loadingStockHolders ||
								depositsLoading ||
								loadingChannels ||
								loadingMembers
									? "animate-spin"
									: ""
							}`}
						/>
						<span>{isRefreshing ? "Refreshing..." : "Refresh"}</span>
					</Button>
					<Button
						variant="default"
						size="sm"
						onClick={handleSaveConfig}
						disabled={savingConfig || loadingConfig || !hasUnsavedChanges}
						className="cursor-pointer gap-1.5 font-medium"
					>
						{savingConfig ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Save className="size-3.5" />
						)}
						<span>Save Settings</span>
					</Button>
				</div>
			</div>

			{/* Armory Cash Balance Summary */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 rounded-xl border border-border/70 bg-card/50 backdrop-blur-sm shadow-xs">
				<div className="flex flex-col gap-1">
					<span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
						Armory Cash Balance
					</span>
					<div className="flex items-baseline gap-2">
						<span
							className={`text-2xl font-bold font-mono tracking-tight ${
								armoryCash.available < 0
									? "text-destructive"
									: armoryCash.available > 0
										? "text-foreground"
										: "text-muted-foreground"
							}`}
						>
							{armoryCash.available < 0 ? "-$" : "$"}
							{Math.abs(armoryCash.available).toLocaleString()}
						</span>
					</div>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
						Total Deposited
					</span>
					<span className="text-xl font-bold font-mono text-foreground">
						${armoryCash.deposited.toLocaleString()}
					</span>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
						Total Spent on Buys
					</span>
					<span className="text-xl font-bold font-mono text-foreground">
						${armoryCash.consumed.toLocaleString()}
					</span>
				</div>
			</div>

			{/* Main Tabs */}
			<Tabs defaultValue="settings" className="w-full">
				<TabsList className="grid w-full grid-cols-4 max-w-2xl mb-2">
					<TabsTrigger value="settings" className="cursor-pointer gap-2">
						<SlidersHorizontal className="size-3.5" />
						<span>Configuration</span>
					</TabsTrigger>
					<TabsTrigger value="stockholders" className="cursor-pointer gap-2">
						<Users className="size-3.5" />
						<span>Stock Holders</span>
					</TabsTrigger>
					<TabsTrigger value="deposits" className="cursor-pointer gap-2">
						<span>Depositor History</span>
					</TabsTrigger>
					<TabsTrigger value="logs" className="cursor-pointer gap-2">
						<Clock className="size-3.5" />
						<span>Requests History</span>
					</TabsTrigger>
				</TabsList>

				{/* ─── TAB 1: Configuration & Whitelist ──────────────────────────────── */}
				<TabsContent value="settings" className="flex flex-col gap-6 mt-4">
					<div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
						{/* Channels & Roles Configuration */}
						<div className="lg:col-span-5 flex flex-col gap-6">
							{/* Channel Settings Card */}
							<Card className="border-border/80 shadow-xs">
								<CardHeader className="pb-3">
									<CardTitle className="text-base font-semibold flex items-center gap-2">
										Channels
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col gap-4">
									{/* Item Request Channel */}
									<div className="flex flex-col gap-1.5">
										<label
											htmlFor="request-channel-select"
											className="text-xs font-semibold text-foreground flex items-center justify-between"
										>
											<span>Item Requests Channel</span>
										</label>
										<Select
											value={requestChannelId ?? "none"}
											onValueChange={(val) =>
												setRequestChannelId(val === "none" ? null : val)
											}
											disabled={loadingChannels || loadingConfig}
										>
											<SelectTrigger
												id="request-channel-select"
												className="w-full font-mono text-xs cursor-pointer"
											>
												<SelectValue placeholder="Select a channel..." />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectLabel className="text-[10px] uppercase font-mono tracking-wider">
														Text Channels
													</SelectLabel>
													<SelectItem value="none" className="text-xs">
														-- None Selected --
													</SelectItem>
													{channels.map((ch) => (
														<SelectItem
															key={ch.id}
															value={ch.id}
															className="text-xs font-mono"
														>
															#{ch.name}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
									</div>

									{/* Requests Granting Channel */}
									<div className="flex flex-col gap-1.5">
										<label
											htmlFor="granting-channel-select"
											className="text-xs font-semibold text-foreground flex items-center justify-between"
										>
											<span>Requests Granting Channel</span>
										</label>
										<Select
											value={grantingChannelId ?? "none"}
											onValueChange={(val) =>
												setGrantingChannelId(val === "none" ? null : val)
											}
											disabled={loadingChannels || loadingConfig}
										>
											<SelectTrigger
												id="granting-channel-select"
												className="w-full font-mono text-xs cursor-pointer"
											>
												<SelectValue placeholder="Select a channel..." />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectLabel className="text-[10px] uppercase font-mono tracking-wider">
														Text Channels
													</SelectLabel>
													<SelectItem value="none" className="text-xs">
														-- None Selected --
													</SelectItem>
													{channels.map((ch) => (
														<SelectItem
															key={ch.id}
															value={ch.id}
															className="text-xs font-mono"
														>
															#{ch.name}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
									</div>

									{/* Armory Depositor & Storage Channel */}
									<div className="flex flex-col gap-1.5">
										<label
											htmlFor="storage-channel-select"
											className="text-xs font-semibold text-foreground flex items-center justify-between"
										>
											<span>Item Deposit Channel</span>
										</label>
										<Select
											value={storageChannelId ?? "none"}
											onValueChange={(val) =>
												setStorageChannelId(val === "none" ? null : val)
											}
											disabled={loadingChannels || loadingConfig}
										>
											<SelectTrigger
												id="storage-channel-select"
												className="w-full font-mono text-xs cursor-pointer"
											>
												<SelectValue placeholder="Select a channel..." />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectLabel className="text-[10px] uppercase font-mono tracking-wider">
														Text Channels
													</SelectLabel>
													<SelectItem value="none" className="text-xs">
														-- None Selected --
													</SelectItem>
													{channels.map((ch) => (
														<SelectItem
															key={ch.id}
															value={ch.id}
															className="text-xs font-mono"
														>
															#{ch.name}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
									</div>

									{/* Stock Holders Distribution Channel */}
									<div className="flex flex-col gap-1.5">
										<label
											htmlFor="stock-holders-channel-select"
											className="text-xs font-semibold text-foreground flex items-center justify-between"
										>
											<span>Stock Holders Channel</span>
										</label>
										<Select
											value={stockHoldersChannelId ?? "none"}
											onValueChange={(val) =>
												setStockHoldersChannelId(val === "none" ? null : val)
											}
											disabled={loadingChannels || loadingConfig}
										>
											<SelectTrigger
												id="stock-holders-channel-select"
												className="w-full font-mono text-xs cursor-pointer"
											>
												<SelectValue placeholder="Select a channel..." />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectLabel className="text-[10px] uppercase font-mono tracking-wider">
														Text Channels
													</SelectLabel>
													<SelectItem value="none" className="text-xs">
														-- None Selected --
													</SelectItem>
													{channels.map((ch) => (
														<SelectItem
															key={ch.id}
															value={ch.id}
															className="text-xs font-mono"
														>
															#{ch.name}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
									</div>
								</CardContent>
							</Card>

							{/* Role Restrictions Card */}
							<Card className="border-border/80 shadow-xs">
								<CardHeader className="pb-3">
									<CardTitle className="text-base font-semibold flex items-center gap-2">
										Role Permissions
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col gap-5">
									{/* Requester Roles */}
									<div className="flex flex-col gap-2">
										<div className="flex items-center justify-between">
											<span className="text-xs font-semibold text-foreground">
												Allowed Requester Roles
											</span>
											<span className="text-[10px] text-muted-foreground">
												{requesterRoleIds.length === 0
													? "Open to all server members"
													: `${requesterRoleIds.length} role(s) selected`}
											</span>
										</div>

										<Select
											value={
												requesterRoleIds.length === 1
													? (requesterRoleIds[0] ?? "none")
													: "none"
											}
											onValueChange={(val) => {
												if (val === "none") {
													setRequesterRoleIds([]);
												} else if (!requesterRoleIds.includes(val)) {
													setRequesterRoleIds((prev) => [...prev, val]);
												}
											}}
											disabled={loadingRoles || loadingConfig}
										>
											<SelectTrigger
												id="requester-roles-select"
												className="w-full font-mono text-xs cursor-pointer"
											>
												<SelectValue
													placeholder={
														requesterRoleIds.length === 0
															? "-- None (Open to all members) --"
															: `${requesterRoleIds.length} role(s) selected`
													}
												>
													{requesterRoleIds.length === 0
														? "-- None (Open to all members) --"
														: requesterRoleIds.length === 1
															? (roles.find((r) => r.id === requesterRoleIds[0])
																	?.name ?? "1 role selected")
															: `${requesterRoleIds.length} roles selected`}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectLabel className="text-[10px] uppercase font-mono tracking-wider">
														Server Roles
													</SelectLabel>
													<SelectItem
														value="none"
														className="text-xs font-mono"
													>
														-- None (Open to all members) --
													</SelectItem>
													{roles.map((r) => {
														const isAdded = requesterRoleIds.includes(r.id);
														return (
															<SelectItem
																key={r.id}
																value={r.id}
																className="text-xs font-mono"
															>
																<div className="flex items-center gap-2">
																	<span
																		className="size-2 rounded-full shrink-0"
																		style={{
																			backgroundColor: formatRoleColor(r.color),
																		}}
																	/>
																	<span>{r.name}</span>
																	{isAdded && (
																		<span className="text-[10px] text-primary ml-1">
																			(Selected)
																		</span>
																	)}
																</div>
															</SelectItem>
														);
													})}
												</SelectGroup>
											</SelectContent>
										</Select>

										{/* Selected Requester Roles Badges */}
										{requesterRoleIds.length > 0 && (
											<div className="flex flex-wrap gap-1.5 pt-1">
												{requesterRoleIds.map((id) => {
													const r = roles.find((role) => role.id === id);
													return (
														<Badge
															key={id}
															variant="secondary"
															className="gap-1.5 text-xs font-mono py-0.5 px-2 border border-border/80 bg-background/80"
														>
															<span
																className="size-2 rounded-full shrink-0"
																style={{
																	backgroundColor: r
																		? formatRoleColor(r.color)
																		: "#94a3b8",
																}}
															/>
															<span>{r?.name ?? id}</span>
															<button
																type="button"
																onClick={() => toggleRole(id, "requester")}
																title="Remove role"
																className="text-muted-foreground hover:text-foreground cursor-pointer ml-0.5"
															>
																<X className="size-3" />
															</button>
														</Badge>
													);
												})}
											</div>
										)}
									</div>

									{/* Manager / Approver Roles */}
									<div className="flex flex-col gap-2">
										<div className="flex items-center justify-between">
											<span className="text-xs font-semibold text-foreground">
												Granting & Manager Roles
											</span>
											<span className="text-[10px] text-muted-foreground">
												{managerRoleIds.length === 0
													? "Server Admins only"
													: `${managerRoleIds.length} role(s) selected`}
											</span>
										</div>

										<Select
											value={
												managerRoleIds.length === 1
													? (managerRoleIds[0] ?? "none")
													: "none"
											}
											onValueChange={(val) => {
												if (val === "none") {
													setManagerRoleIds([]);
												} else if (!managerRoleIds.includes(val)) {
													setManagerRoleIds((prev) => [...prev, val]);
												}
											}}
											disabled={loadingRoles || loadingConfig}
										>
											<SelectTrigger
												id="manager-roles-select"
												className="w-full font-mono text-xs cursor-pointer"
											>
												<SelectValue
													placeholder={
														managerRoleIds.length === 0
															? "-- None (Admins only) --"
															: `${managerRoleIds.length} role(s) selected`
													}
												>
													{managerRoleIds.length === 0
														? "-- None (Admins only) --"
														: managerRoleIds.length === 1
															? (roles.find((r) => r.id === managerRoleIds[0])
																	?.name ?? "1 role selected")
															: `${managerRoleIds.length} roles selected`}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectLabel className="text-[10px] uppercase font-mono tracking-wider">
														Server Roles
													</SelectLabel>
													<SelectItem
														value="none"
														className="text-xs font-mono"
													>
														-- None (Admins only) --
													</SelectItem>
													{roles.map((r) => {
														const isAdded = managerRoleIds.includes(r.id);
														return (
															<SelectItem
																key={r.id}
																value={r.id}
																className="text-xs font-mono"
															>
																<div className="flex items-center gap-2">
																	<span
																		className="size-2 rounded-full shrink-0"
																		style={{
																			backgroundColor: formatRoleColor(r.color),
																		}}
																	/>
																	<span>{r.name}</span>
																	{isAdded && (
																		<span className="text-[10px] text-primary ml-1">
																			(Selected)
																		</span>
																	)}
																</div>
															</SelectItem>
														);
													})}
												</SelectGroup>
											</SelectContent>
										</Select>

										{/* Selected Manager Roles Badges */}
										{managerRoleIds.length > 0 && (
											<div className="flex flex-wrap gap-1.5 pt-1">
												{managerRoleIds.map((id) => {
													const r = roles.find((role) => role.id === id);
													return (
														<Badge
															key={id}
															variant="secondary"
															className="gap-1.5 text-xs font-mono py-0.5 px-2 border border-border/80 bg-background/80"
														>
															<span
																className="size-2 rounded-full shrink-0"
																style={{
																	backgroundColor: r
																		? formatRoleColor(r.color)
																		: "#94a3b8",
																}}
															/>
															<span>{r?.name ?? id}</span>
															<button
																type="button"
																onClick={() => toggleRole(id, "manager")}
																title="Remove role"
																className="text-muted-foreground hover:text-foreground cursor-pointer ml-0.5"
															>
																<X className="size-3" />
															</button>
														</Badge>
													);
												})}
											</div>
										)}
									</div>
								</CardContent>
							</Card>

							{/* Blacklist Card */}
							<Card className="border-border/80 shadow-xs">
								<CardHeader className="pb-3">
									<div className="flex items-center justify-between">
										<CardTitle className="text-base font-semibold flex items-center gap-2">
											<span>Blacklist</span>
										</CardTitle>
										<Badge
											variant="outline"
											className="font-mono text-xs text-destructive border-destructive/30"
										>
											{blacklistedUserIds.length} blocked
										</Badge>
									</div>
								</CardHeader>
								<CardContent className="flex flex-col gap-4">
									{/* Member Search Bar & Dropdown */}
									<div ref={memberSearchRef} className="relative">
										<div className="flex items-center gap-2">
											<div className="relative flex-1">
												<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
												<Input
													type="text"
													placeholder={
														loadingMembers
															? "Loading server members..."
															: "Search by name, username, or ID..."
													}
													value={memberSearchQuery}
													onFocus={() => setIsMemberDropdownOpen(true)}
													onChange={(e) => {
														setMemberSearchQuery(e.target.value);
														setIsMemberDropdownOpen(true);
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															e.preventDefault();
															if (
																filteredMembers[0] &&
																memberSearchQuery.trim().length > 0
															) {
																handleSelectMemberToBlacklist(
																	filteredMembers[0],
																);
															} else {
																handleAddBlacklist();
															}
														}
													}}
													className="pl-8 text-xs font-mono"
												/>
												{loadingMembers && (
													<Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 animate-spin text-muted-foreground" />
												)}
											</div>
											<Button
												variant="destructive"
												size="sm"
												onClick={handleAddBlacklist}
												disabled={!memberSearchQuery.trim()}
												className="cursor-pointer gap-1.5 shrink-0 text-xs"
											>
												<UserX className="size-3.5" />
												<span>Block</span>
											</Button>
										</div>

										{/* Search Dropdown */}
										{isMemberDropdownOpen && (
											<div className="absolute left-0 right-0 top-full mt-1.5 z-50 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg flex flex-col gap-1">
												<div className="flex items-center justify-between px-2 py-1 text-[10px] font-mono text-muted-foreground uppercase border-b border-border/50">
													<span>
														{memberSearchQuery.trim()
															? `Matching Members (${filteredMembers.length})`
															: `Server Members (${guildMembers.length})`}
													</span>
													{loadingMembers && (
														<span className="flex items-center gap-1">
															<Loader2 className="size-2.5 animate-spin" />
															Loading...
														</span>
													)}
												</div>

												{filteredMembers.length === 0 ? (
													<div className="p-3 text-center text-xs text-muted-foreground">
														{memberSearchQuery.trim()
															? "No matching server members found. Click 'Block' to block this raw ID."
															: "No server members loaded."}
													</div>
												) : (
													filteredMembers.map((member) => {
														const isBlocked = blacklistedUserIds.includes(
															member.id,
														);
														return (
															<button
																key={member.id}
																type="button"
																onClick={() => {
																	if (!isBlocked) {
																		handleSelectMemberToBlacklist(member);
																	}
																}}
																disabled={isBlocked}
																className={`flex items-center justify-between gap-2 p-1.5 rounded-md text-left transition-colors w-full ${
																	isBlocked
																		? "opacity-50 cursor-not-allowed bg-muted/20"
																		: "hover:bg-muted/60 cursor-pointer"
																}`}
															>
																<div className="flex items-center gap-2 min-w-0">
																	{member.avatar ? (
																		<img
																			src={member.avatar}
																			alt={member.displayName}
																			className="size-6 rounded-full object-cover shrink-0"
																		/>
																	) : (
																		<div className="size-6 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0">
																			<User className="size-3.5" />
																		</div>
																	)}
																	<div className="flex flex-col min-w-0">
																		<span className="text-xs font-medium text-foreground truncate">
																			{member.displayName}
																		</span>
																		<span className="text-[10px] font-mono text-muted-foreground truncate">
																			@{member.username}
																		</span>
																	</div>
																</div>

																<Badge
																	variant={isBlocked ? "outline" : "secondary"}
																	className={`text-[9px] font-mono shrink-0 ${
																		isBlocked
																			? "border-destructive/40 text-destructive bg-destructive/10"
																			: "text-muted-foreground"
																	}`}
																>
																	{isBlocked ? "Blocked" : "Select"}
																</Badge>
															</button>
														);
													})
												)}
											</div>
										)}
									</div>

									{blacklistedUserIds.length > 0 && (
										<div className="flex flex-wrap gap-1.5 pt-1">
											{blacklistedUserIds.map((userId) => {
												const member = guildMembers.find(
													(m) => m.id === userId,
												);
												return (
													<Badge
														key={userId}
														variant="outline"
														className="gap-1.5 text-xs font-mono py-1 px-2 border border-destructive/40 bg-destructive/10 text-destructive flex items-center"
													>
														{member?.avatar ? (
															<img
																src={member.avatar}
																alt={member.displayName}
																className="size-3.5 rounded-full object-cover shrink-0"
															/>
														) : (
															<UserX className="size-3 shrink-0" />
														)}
														<span className="font-sans font-medium text-foreground">
															{member?.displayName ??
																member?.username ??
																"User"}
														</span>

														<button
															type="button"
															onClick={() => handleRemoveBlacklist(userId)}
															title="Remove from blacklist"
															className="text-destructive/70 hover:text-destructive cursor-pointer ml-1"
														>
															<X className="size-3" />
														</button>
													</Badge>
												);
											})}
										</div>
									)}
								</CardContent>
							</Card>
						</div>

						{/* In-Stock Requestable Items Curator */}
						<div className="lg:col-span-7 flex flex-col h-full">
							<Card className="border-border/80 shadow-xs flex flex-col h-full min-h-[600px] lg:min-h-0">
								<CardHeader className="pb-3 shrink-0">
									<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
										<div>
											<CardTitle className="text-base font-semibold flex items-center gap-2">
												<span>Requestable Items (In Stock)</span>
											</CardTitle>
										</div>
									</div>
								</CardHeader>

								<CardContent className="flex flex-col gap-3 flex-1 min-h-0">
									{/* Search Filter & Status Controls */}
									<div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0">
										<div className="relative flex-1">
											<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
											<Input
												type="text"
												placeholder="Filter in-stock items by name or category..."
												value={itemFilterQuery}
												onChange={(e) => setItemFilterQuery(e.target.value)}
												className="pl-8 pr-7 text-xs font-mono h-8"
											/>
											{itemFilterQuery && (
												<button
													type="button"
													onClick={() => setItemFilterQuery("")}
													className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
													title="Clear filter"
												>
													<X className="size-3" />
												</button>
											)}
										</div>

										{/* Quick Status Filters */}
										<div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/60 shrink-0">
											<Button
												type="button"
												variant={
													itemStatusFilter === "all" ? "secondary" : "ghost"
												}
												size="xs"
												onClick={() => setItemStatusFilter("all")}
												className="text-[11px] h-7 px-2 font-mono cursor-pointer"
											>
												All ({allowedItems.length})
											</Button>
											<Button
												type="button"
												variant={
													itemStatusFilter === "in-stock"
														? "secondary"
														: "ghost"
												}
												size="xs"
												onClick={() => setItemStatusFilter("in-stock")}
												className="text-[11px] h-7 px-2 font-mono cursor-pointer"
											>
												In Stock ({inStockCount})
											</Button>
											<Button
												type="button"
												variant={
													itemStatusFilter === "enabled" ? "secondary" : "ghost"
												}
												size="xs"
												onClick={() => setItemStatusFilter("enabled")}
												className="text-[11px] h-7 px-2 font-mono cursor-pointer"
											>
												Enabled ({enabledCount})
											</Button>
											<Button
												type="button"
												variant={
													itemStatusFilter === "disabled"
														? "secondary"
														: "ghost"
												}
												size="xs"
												onClick={() => setItemStatusFilter("disabled")}
												className="text-[11px] h-7 px-2 font-mono cursor-pointer"
											>
												Disabled ({disabledCount})
											</Button>
										</div>
									</div>

									{/* Quick Action Toolbar */}
									<div className="flex items-center justify-between text-xs text-muted-foreground px-0.5 shrink-0">
										<span className="text-[10px] font-mono">
											Showing {filteredAllowedItems.length} of{" "}
											{allowedItems.length} items
										</span>
										<div className="flex items-center gap-1.5">
											<Button
												type="button"
												variant="outline"
												size="xs"
												onClick={handleEnableAll}
												className="h-6 text-[10px] font-mono cursor-pointer gap-1"
											>
												<Check className="size-3 text-emerald-500" />
												Enable All
											</Button>
											<Button
												type="button"
												variant="outline"
												size="xs"
												onClick={handleDisableAll}
												className="h-6 text-[10px] font-mono cursor-pointer text-muted-foreground gap-1"
											>
												<X className="size-3 text-destructive" />
												Disable All
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="xs"
												onClick={() => void fetchStock()}
												disabled={loadingStock}
												className="h-6 text-[10px] font-mono cursor-pointer gap-1"
												title="Refresh live armory inventory"
											>
												<RefreshCw
													className={`size-3 ${loadingStock ? "animate-spin" : ""}`}
												/>
												Sync Stock
											</Button>
										</div>
									</div>

									{/* In-Stock Items List Grouped by Category */}
									<div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-1">
										{allowedItems.length === 0 ? (
											<div className="flex flex-col items-center justify-center p-8 border border-dashed border-border/80 rounded-lg text-center gap-2.5 text-muted-foreground my-auto">
												<Package className="size-8 stroke-[1.2] text-muted-foreground/60" />
												<div className="flex flex-col gap-1">
													<p className="text-xs font-semibold text-foreground">
														No items currently in armory stock
													</p>
													<p className="text-[11px] text-muted-foreground max-w-sm">
														Items deposited into armory storage will
														automatically appear here as requestable items
														(enabled by default).
													</p>
												</div>
												<Button
													type="button"
													variant="outline"
													size="xs"
													onClick={() => void fetchStock()}
													disabled={loadingStock}
													className="mt-1 cursor-pointer gap-1 text-xs"
												>
													<RefreshCw
														className={`size-3 ${loadingStock ? "animate-spin" : ""}`}
													/>
													<span>Refresh Inventory</span>
												</Button>
											</div>
										) : filteredAllowedItems.length === 0 ? (
											<div className="flex flex-col items-center justify-center p-8 border border-dashed border-border/80 rounded-lg text-center gap-2 text-muted-foreground my-auto">
												<Search className="size-6 stroke-[1.5] text-muted-foreground/60" />
												<p className="text-xs font-medium">
													No items match your filter criteria
												</p>
												<Button
													type="button"
													variant="ghost"
													size="xs"
													onClick={() => {
														setItemFilterQuery("");
														setItemStatusFilter("all");
													}}
													className="text-xs text-primary cursor-pointer"
												>
													Reset filters
												</Button>
											</div>
										) : (
											Object.entries(itemsByCategory).map(
												([category, catItems]) => (
													<div
														key={category}
														className="flex flex-col gap-2 p-3 rounded-lg border border-border/60 bg-muted/10"
													>
														<div className="flex items-center justify-between">
															<span className="text-xs font-semibold tracking-tight text-foreground flex items-center gap-1.5">
																<Badge
																	variant="secondary"
																	className="text-[10px] font-mono px-1.5 py-0"
																>
																	{category}
																</Badge>
																<span className="text-xs text-muted-foreground font-normal">
																	({catItems.length})
																</span>
															</span>
														</div>

														<div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
															{catItems.map((item) => {
																const stock =
																	currentStockMap.get(item.id)?.available ??
																	currentStockMap.get(
																		item.name.trim().toLowerCase(),
																	)?.available ??
																	0;
																const isItemDisabled = Boolean(item.disabled);

																return (
																	<div
																		key={item.id}
																		className={`flex items-center justify-between gap-3 p-2.5 rounded-lg border transition-all ${
																			isItemDisabled
																				? "bg-muted/20 border-border/40 opacity-60"
																				: "bg-background border-border/70 hover:border-border shadow-xs"
																		}`}
																	>
																		{/* Left: Item Thumbnail & Info */}
																		<div className="flex items-center gap-2.5 min-w-0 flex-1">
																			{item.image ? (
																				<img
																					src={item.image}
																					alt={item.name}
																					className={`size-8 object-contain rounded shrink-0 bg-muted/40 p-0.5 border border-border/40 ${
																						isItemDisabled
																							? "grayscale opacity-50"
																							: ""
																					}`}
																				/>
																			) : (
																				<div className="size-8 rounded bg-muted/60 flex items-center justify-center text-[10px] font-mono shrink-0">
																					IT
																				</div>
																			)}
																			<div className="flex flex-col min-w-0">
																				<div className="flex items-center gap-1.5">
																					<span
																						className={`text-xs font-semibold truncate ${
																							isItemDisabled
																								? "text-muted-foreground line-through decoration-muted-foreground/40"
																								: "text-foreground"
																						}`}
																					>
																						{item.name}
																					</span>
																					{isItemDisabled && (
																						<Badge
																							variant="outline"
																							className="text-[9px] font-mono px-1 py-0 text-muted-foreground border-border/60"
																						>
																							Disabled
																						</Badge>
																					)}
																				</div>
																				<div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground flex-wrap">
																					{item.marketPrice !== undefined &&
																						item.marketPrice > 0 && (
																							<>
																								<span>
																									{formatCurrency(
																										item.marketPrice,
																									)}
																								</span>
																								<span>•</span>
																							</>
																						)}
																					<span
																						className={`font-semibold ${
																							stock > 0
																								? "text-emerald-600 dark:text-emerald-400"
																								: "text-amber-500/90"
																						}`}
																					>
																						{stock > 0
																							? `${stock.toLocaleString()} in stock`
																							: "0 in stock"}
																					</span>
																				</div>
																			</div>
																		</div>

																		{/* Right: Controls (Option to disable/enable & Max limit) */}
																		<div className="flex items-center gap-2 shrink-0">
																			{/* Max Limit Input */}
																			<div
																				className={`flex items-center gap-1 bg-muted/40 px-2 py-1 rounded border border-border/60 transition-opacity ${
																					isItemDisabled
																						? "opacity-30 pointer-events-none"
																						: ""
																				}`}
																			>
																				<label
																					htmlFor={`max-${item.id}`}
																					className="text-[10px] font-mono text-muted-foreground whitespace-nowrap"
																					title="Maximum quantity allowed per single request"
																				>
																					Max:
																				</label>
																				<Input
																					id={`max-${item.id}`}
																					type="number"
																					min="1"
																					max="10000"
																					placeholder="∞"
																					disabled={isItemDisabled}
																					value={item.maxRequestable ?? ""}
																					onKeyDown={(e) => {
																						if (
																							[
																								"-",
																								"+",
																								"e",
																								"E",
																								".",
																							].includes(e.key)
																						) {
																							e.preventDefault();
																						}
																					}}
																					onChange={(e) => {
																						const raw = e.target.value.replace(
																							/[^0-9]/g,
																							"",
																						);
																						const val = raw
																							? parseInt(raw, 10)
																							: undefined;
																						handleUpdateMaxRequestable(
																							item.id,
																							val !== undefined &&
																								!Number.isNaN(val)
																								? Math.max(1, val)
																								: undefined,
																						);
																					}}
																					className="w-12 h-6 text-[10px] font-mono px-1 py-0 text-center bg-background [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
																					title="Maximum requestable quantity (Leave blank for unlimited)"
																				/>
																			</div>

																			{/* Option to Disable/Enable Toggle */}
																			<div className="flex items-center gap-1 pl-1">
																				<Switch
																					id={`toggle-${item.id}`}
																					size="sm"
																					checked={!isItemDisabled}
																					onCheckedChange={(checked) =>
																						handleToggleItemEnabled(
																							item.id,
																							checked,
																						)
																					}
																					title={
																						isItemDisabled
																							? "Click to enable requests for this item"
																							: "Click to disable requests for this item"
																					}
																					aria-label={`Enable or disable requests for ${item.name}`}
																				/>
																			</div>
																		</div>
																	</div>
																);
															})}
														</div>
													</div>
												),
											)
										)}
									</div>
								</CardContent>

								<CardFooter className="pt-3 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground shrink-0">
									<span className="font-mono text-[11px]">
										{enabledCount} of {allowedItems.length} items requestable
									</span>
									<div className="flex items-center gap-2">
										<Button
											type="button"
											variant="ghost"
											size="xs"
											onClick={handleDisableAll}
											className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
										>
											Disable All
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="xs"
											onClick={handleEnableAll}
											className="text-primary hover:text-primary/80 cursor-pointer text-xs font-medium"
										>
											Enable All
										</Button>
									</div>
								</CardFooter>
							</Card>
						</div>
					</div>
				</TabsContent>

				{/* ─── TAB: Stock Holders ──────────────────────────────────────────────── */}
				<TabsContent value="stockholders" className="flex flex-col gap-4 mt-4">
					<Card className="border-border/80 shadow-xs">
						<CardHeader className="pb-3">
							<CardTitle className="text-base font-semibold flex items-center gap-2">
								<span>Item Stock Holders</span>
							</CardTitle>
						</CardHeader>

						<CardContent className="p-0">
							<div className="relative overflow-x-auto">
								<Table>
									<TableHeader className="bg-muted/30">
										<TableRow className="text-[11px] font-mono uppercase tracking-wider">
											<TableHead>Holder Member</TableHead>
											<TableHead>Discord User ID</TableHead>
											<TableHead>Item Name</TableHead>
											<TableHead className="text-right">
												Quantity Held
											</TableHead>
											<TableHead className="text-right">Last Updated</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{loadingStockHolders ? (
											["sh-1", "sh-2", "sh-3"].map((key) => (
												<TableRow key={key}>
													<TableCell colSpan={5}>
														<Skeleton className="h-9 w-full" />
													</TableCell>
												</TableRow>
											))
										) : stockHolders.length === 0 ? (
											<TableRow>
												<TableCell
													colSpan={5}
													className="text-center py-10 text-xs text-muted-foreground"
												>
													No members currently hold items. Use the Discord Stock
													Holders channel to assign stock.
												</TableCell>
											</TableRow>
										) : (
											stockHolders.map((sh) => (
												<TableRow key={sh.id}>
													<TableCell className="font-medium text-xs">
														@{sh.discordUsername}
													</TableCell>
													<TableCell className="font-mono text-xs text-muted-foreground">
														{sh.discordUserId}
													</TableCell>
													<TableCell className="font-medium text-xs">
														{sh.itemName}
													</TableCell>
													<TableCell className="text-right font-mono font-bold text-xs">
														{sh.quantity.toLocaleString()}x
													</TableCell>
													<TableCell className="text-right font-mono text-xs text-muted-foreground">
														{formatTctTimestamp(sh.updatedAt)}
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</div>
						</CardContent>
					</Card>
				</TabsContent>

				{/* ─── TAB 2: Depositor History ──────────────────────────────────────── */}
				<TabsContent value="deposits" className="flex flex-col gap-4 mt-4">
					<Card className="border-border/80 shadow-xs">
						<CardHeader className="pb-3">
							<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
								<div>
									<CardTitle className="text-base font-semibold flex items-center gap-2">
										<span>Depositor History</span>
									</CardTitle>
								</div>

								{/* Toolbar */}
								<div className="flex flex-wrap items-center gap-2">
									<div className="relative min-w-[200px]">
										{depositsLoading && !initialDepositsLoading ? (
											<Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 animate-spin text-muted-foreground" />
										) : (
											<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
										)}
										<Input
											type="text"
											placeholder="Search name or item..."
											value={depositsSearch}
											onChange={(e) => setDepositsSearch(e.target.value)}
											className="pl-8 h-8 text-xs font-mono"
										/>
									</div>
								</div>
							</div>
						</CardHeader>

						<CardContent className="p-0">
							<div className="relative overflow-x-auto">
								<Table>
									<TableHeader className="bg-muted/30">
										<TableRow className="text-[11px] font-mono uppercase tracking-wider">
											<TableHead>Donor (Torn)</TableHead>
											<TableHead>Item & Quantity</TableHead>
											<TableHead>Pasted By (Discord)</TableHead>
											<TableHead>Log Time (TCT)</TableHead>
											<TableHead>Pasted In Chat</TableHead>
											<TableHead className="w-[80px] text-right text-xs">
												Action
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody
										className={
											depositsLoading && !initialDepositsLoading
												? "opacity-50 pointer-events-none transition-opacity duration-150"
												: "transition-opacity duration-150"
										}
									>
										{initialDepositsLoading ? (
											["dep-1", "dep-2", "dep-3", "dep-4", "dep-5"].map(
												(skKey) => (
													<TableRow key={skKey}>
														<TableCell colSpan={6}>
															<Skeleton className="h-9 w-full" />
														</TableCell>
													</TableRow>
												),
											)
										) : deposits.length === 0 ? (
											<TableRow>
												<TableCell
													colSpan={6}
													className="text-center py-10 text-xs text-muted-foreground"
												>
													No deposits found matching your criteria.
												</TableCell>
											</TableRow>
										) : (
											deposits.map((dep) => (
												<TableRow key={dep.id}>
													{/* Donor (Torn) */}
													<TableCell>
														<div className="flex flex-col gap-0.5">
															{dep.tornId ? (
																<a
																	href={`https://www.torn.com/profiles.php?XID=${dep.tornId}`}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1 w-fit"
																	title={`View Torn Profile for ${dep.tornName ?? dep.tornId}`}
																>
																	<span>
																		{dep.tornName
																			? `${dep.tornName} [${dep.tornId}]`
																			: `[${dep.tornId}]`}
																	</span>
																	<ExternalLink className="size-3 opacity-70 shrink-0" />
																</a>
															) : (
																<span className="text-xs font-semibold text-foreground">
																	{dep.tornName || "Unknown"}
																</span>
															)}
															{dep.logMessage && (
																<span
																	className="text-[11px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded w-fit italic truncate max-w-[220px]"
																	title={dep.logMessage}
																>
																	"{dep.logMessage}"
																</span>
															)}
														</div>
													</TableCell>

													{/* Item & Quantity */}
													<TableCell>
														<div className="flex items-center gap-2">
															{dep.itemId === "money" ||
															dep.itemName.trim().toLowerCase() === "money" ? (
																dep.status === "spent" ? (
																	<Badge
																		variant="outline"
																		className="font-mono text-xs px-2 py-0.5 font-bold text-destructive border-destructive/40 bg-destructive/10"
																	>
																		-${dep.quantity.toLocaleString()}
																	</Badge>
																) : (
																	<Badge
																		variant="secondary"
																		className="font-mono text-xs px-2 py-0.5 font-bold text-emerald-500 bg-emerald-500/10 border-emerald-500/20"
																	>
																		+${dep.quantity.toLocaleString()}
																	</Badge>
																)
															) : (
																<Badge
																	variant="secondary"
																	className="font-mono text-xs px-2 py-0.5 font-bold"
																>
																	+{dep.quantity.toLocaleString()}
																</Badge>
															)}
															<div className="flex flex-col">
																<span className="text-xs font-medium text-foreground">
																	{dep.itemName}
																</span>
																<span className="text-[10px] font-mono text-muted-foreground">
																	{dep.itemCategory}
																</span>
															</div>
														</div>
													</TableCell>

													{/* Pasted By (Discord) */}
													<TableCell>
														<div className="flex items-center gap-1.5">
															<User className="size-3.5 text-muted-foreground shrink-0" />
															<span className="text-xs font-medium text-foreground">
																@{dep.discordUsername}
															</span>
														</div>
													</TableCell>

													{/* Log Time (TCT) */}
													<TableCell>
														<div className="flex items-center gap-1 text-xs font-mono text-foreground">
															<Clock className="size-3 text-muted-foreground shrink-0" />
															<span>{dep.logTimestamp || "—"}</span>
														</div>
													</TableCell>

													{/* Pasted In Chat */}
													<TableCell>
														<span className="text-xs font-mono text-muted-foreground">
															{formatTctTimestamp(dep.createdAt)}
														</span>
													</TableCell>

													{/* Actions */}
													<TableCell className="text-right">
														<DropdownMenu>
															<DropdownMenuTrigger asChild>
																<Button
																	variant="ghost"
																	size="icon"
																	className="size-7 hover:bg-muted/80 cursor-pointer"
																>
																	<MoreHorizontal className="size-3.5" />
																	<span className="sr-only">Open menu</span>
																</Button>
															</DropdownMenuTrigger>
															<DropdownMenuContent align="end" className="w-48">
																<DropdownMenuLabel className="text-[10px] font-mono uppercase text-muted-foreground">
																	Deposit Actions
																</DropdownMenuLabel>
																{dep.rawLog && (
																	<DropdownMenuItem
																		onClick={() =>
																			setSelectedRawLog({
																				title: `Deposit Log — ${dep.itemName} (+${dep.quantity})`,
																				rawLog: dep.rawLog,
																			})
																		}
																		className="cursor-pointer text-xs flex items-center gap-2"
																	>
																		<FileText className="size-3.5" />
																		<span>View Raw Log</span>
																	</DropdownMenuItem>
																)}
																{dep.tornId && (
																	<DropdownMenuItem
																		asChild
																		className="cursor-pointer text-xs flex items-center gap-2"
																	>
																		<a
																			href={`https://www.torn.com/profiles.php?XID=${dep.tornId}`}
																			target="_blank"
																			rel="noopener noreferrer"
																		>
																			<ExternalLink className="size-3.5" />
																			<span>View Torn Profile</span>
																		</a>
																	</DropdownMenuItem>
																)}
																<DropdownMenuItem
																	onClick={() => {
																		navigator.clipboard.writeText(dep.id);
																		toast.success(
																			"Deposit ID copied to clipboard",
																		);
																	}}
																	className="cursor-pointer text-xs flex items-center gap-2"
																>
																	<Copy className="size-3.5" />
																	<span>Copy Deposit ID</span>
																</DropdownMenuItem>
															</DropdownMenuContent>
														</DropdownMenu>
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</div>
						</CardContent>

						{/* Pagination Controls */}
						{depositsTotalPages > 1 && (
							<CardFooter className="flex items-center justify-between p-4 border-t border-border/80">
								<div className="text-xs text-muted-foreground font-mono">
									Page {depositsPage} of {depositsTotalPages} (
									{depositsTotalCount} total deposits)
								</div>
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											const prev = Math.max(1, depositsPage - 1);
											setDepositsPage(prev);
											fetchDeposits(prev, debouncedDepositsSearch);
										}}
										disabled={depositsPage <= 1 || depositsLoading}
										className="h-8 text-xs cursor-pointer"
									>
										Previous
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											const next = Math.min(
												depositsTotalPages,
												depositsPage + 1,
											);
											setDepositsPage(next);
											fetchDeposits(next, debouncedDepositsSearch);
										}}
										disabled={
											depositsPage >= depositsTotalPages || depositsLoading
										}
										className="h-8 text-xs cursor-pointer"
									>
										Next
									</Button>
								</div>
							</CardFooter>
						)}
					</Card>
				</TabsContent>

				{/* ─── TAB 3: Requests History & Audit Logs ──────────────────────────── */}
				<TabsContent value="logs" className="flex flex-col gap-4 mt-4">
					<Card className="border-border/80 shadow-xs">
						<CardHeader className="pb-3">
							<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
								<div>
									<CardTitle className="text-base font-semibold flex items-center gap-2">
										Requests History
									</CardTitle>
								</div>

								{/* Filters Toolbar */}
								<div className="flex flex-wrap items-center gap-2">
									{/* Keyword Search */}
									<div className="relative min-w-[200px]">
										{logsLoading && !initialLogsLoading ? (
											<Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 animate-spin text-muted-foreground" />
										) : (
											<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
										)}
										<Input
											type="text"
											placeholder="Search user or item..."
											value={logsSearch}
											onChange={(e) => setLogsSearch(e.target.value)}
											className="pl-8 h-8 text-xs font-mono"
										/>
									</div>

									{/* Status Filter */}
									<Select
										value={statusFilter}
										onValueChange={(v) => setStatusFilter(v)}
									>
										<SelectTrigger className="h-8 text-xs font-mono w-[130px] cursor-pointer">
											<SelectValue placeholder="Status" />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="all" className="text-xs font-mono">
													All Status
												</SelectItem>
												<SelectItem
													value="pending"
													className="text-xs font-mono"
												>
													Pending
												</SelectItem>
												<SelectItem
													value="accepted"
													className="text-xs font-mono"
												>
													Accepted
												</SelectItem>
												<SelectItem
													value="rejected"
													className="text-xs font-mono"
												>
													Rejected
												</SelectItem>
											</SelectGroup>
										</SelectContent>
									</Select>

									{/* Export CSV Dropdown Menu */}
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												disabled={isExporting || logsLoading}
												className="h-8 text-xs font-mono gap-1.5 cursor-pointer hover:bg-muted/80 shrink-0"
											>
												{isExporting ? (
													<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
												) : (
													<Download className="size-3.5 text-primary" />
												)}
												<span>Export CSV</span>
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="end"
											className="w-56 font-mono text-xs"
										>
											<DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
												Export Options
											</DropdownMenuLabel>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onClick={() => handleDownloadCsv(true)}
												className="cursor-pointer text-xs flex items-center justify-between"
											>
												<span className="flex items-center gap-2">
													<Download className="size-3.5 text-primary" />
													Download All Logs
												</span>
												<Badge
													variant="secondary"
													className="text-[10px] h-4 px-1 font-mono"
												>
													{logsTotalCount}
												</Badge>
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() => handleDownloadCsv(false)}
												className="cursor-pointer text-xs flex items-center gap-2"
											>
												<Download className="size-3.5 text-muted-foreground" />
												Download Filtered View
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
						</CardHeader>

						<CardContent className="p-0">
							<div className="relative overflow-x-auto">
								<Table>
									<TableHeader className="bg-muted/30">
										<TableRow className="text-[11px] font-mono uppercase tracking-wider">
											<TableHead>Requester</TableHead>
											<TableHead>Item & Amount</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Date (TCT) / Handled</TableHead>
											<TableHead className="text-right">Actions</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody
										className={
											logsLoading && !initialLogsLoading
												? "opacity-50 pointer-events-none transition-opacity duration-150"
												: "transition-opacity duration-150"
										}
									>
										{initialLogsLoading ? (
											["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((skKey) => (
												<TableRow key={skKey}>
													<TableCell colSpan={5}>
														<Skeleton className="h-9 w-full" />
													</TableCell>
												</TableRow>
											))
										) : logs.length === 0 ? (
											<TableRow>
												<TableCell
													colSpan={5}
													className="text-center py-10 text-xs text-muted-foreground"
												>
													No item requests found matching your filter criteria.
												</TableCell>
											</TableRow>
										) : (
											logs.map((log) => {
												const isPending = log.status === "pending";
												const isAccepted = log.status === "accepted";
												const isRejected = log.status === "rejected";

												const member = memberMap.get(log.discordUserId);
												const nickMatch = member?.displayName?.match(
													/^(?:\[[^\]]*\]\s*)?(.+?)\s*\[(\d+)\]$/,
												);
												const effectiveTornId =
													log.tornId ??
													(nickMatch?.[2] ? Number(nickMatch[2]) : null);
												const effectiveTornName =
													log.tornName ??
													(nickMatch?.[1]
														? nickMatch[1].trim()
														: (member?.displayName ?? log.discordUsername));

												const handlerMember = log.handledByDiscordId
													? memberMap.get(log.handledByDiscordId)
													: null;
												const handlerNickMatch =
													handlerMember?.displayName?.match(
														/^(?:\[[^\]]*\]\s*)?(.+?)\s*\[(\d+)\]$/,
													);
												const effectiveHandlerTornId =
													log.handledByTornId ??
													(handlerNickMatch?.[2]
														? Number(handlerNickMatch[2])
														: null);
												const effectiveHandlerTornName =
													log.handledByTornName ??
													(handlerNickMatch?.[1]
														? handlerNickMatch[1].trim()
														: (handlerMember?.displayName ??
															log.handledByUsername));

												return (
													<TableRow key={log.id}>
														{/* Requester */}
														<TableCell>
															{effectiveTornId ? (
																<a
																	href={`https://www.torn.com/profiles.php?XID=${effectiveTornId}`}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
																	title={`View Torn Profile for ${effectiveTornName} [${effectiveTornId}]`}
																>
																	<span>
																		{effectiveTornName} [{effectiveTornId}]
																	</span>
																	<ExternalLink className="size-3 opacity-70 shrink-0" />
																</a>
															) : (
																<span className="text-xs text-muted-foreground">
																	{member?.displayName || log.discordUsername}
																</span>
															)}
														</TableCell>

														{/* Item */}
														<TableCell>
															<div className="flex items-center gap-2">
																<Badge
																	variant="secondary"
																	className="font-mono text-xs px-2 py-0.5 font-bold"
																>
																	x{log.quantity}
																</Badge>
																<div className="flex flex-col">
																	<span className="text-xs font-medium text-foreground">
																		{log.itemName}
																	</span>
																	<span className="text-[10px] font-mono text-muted-foreground">
																		{log.itemCategory}
																	</span>
																</div>
															</div>
														</TableCell>

														{/* Status */}
														<TableCell>
															<div className="flex items-center gap-1.5 flex-wrap">
																{isPending && (
																	<Badge
																		variant="outline"
																		className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px] font-mono flex items-center gap-1 w-fit"
																	>
																		<Clock className="size-2.5" />
																		PENDING
																	</Badge>
																)}
																{isAccepted && (
																	<Badge
																		variant="outline"
																		className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px] font-mono flex items-center gap-1 w-fit"
																	>
																		<CheckCircle2 className="size-2.5" />
																		ACCEPTED
																	</Badge>
																)}
																{isAccepted &&
																	log.verificationStatus ===
																		"pending_verification" && (
																		<Badge
																			variant="outline"
																			className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[9px] font-mono flex items-center gap-1 w-fit"
																			title="Approver must paste Torn send log in DM to verify delivery"
																		>
																			<Clock className="size-2.5" />
																			AWAITING SEND LOG
																		</Badge>
																	)}
																{isAccepted &&
																	log.verificationStatus === "verified" && (
																		<Badge
																			variant="outline"
																			className="bg-sky-500/10 text-sky-500 border-sky-500/30 text-[9px] font-mono flex items-center gap-1 w-fit"
																		>
																			<Check className="size-2.5" />
																			VERIFIED
																		</Badge>
																	)}
																{isAccepted &&
																	log.verificationStatus === "bypassed" && (
																		<Badge
																			variant="outline"
																			className="bg-purple-500/10 text-purple-500 border-purple-500/30 text-[9px] font-mono flex items-center gap-1 w-fit"
																		>
																			<Check className="size-2.5" />
																			TEST BYPASSED
																		</Badge>
																	)}
																{isRejected && (
																	<Badge
																		variant="outline"
																		className="bg-rose-500/10 text-rose-500 border-rose-500/30 text-[10px] font-mono flex items-center gap-1 w-fit cursor-pointer hover:bg-rose-500/20 transition-colors"
																		onClick={() => setSelectedRejectionLog(log)}
																		title="Click to view rejection reason"
																	>
																		<XCircle className="size-2.5" />
																		<span>REJECTED</span>
																		<FileText className="size-2.5 opacity-70" />
																	</Badge>
																)}
															</div>
														</TableCell>

														{/* Date & Handled by */}
														<TableCell>
															<div className="flex flex-col text-xs font-mono">
																<span>{formatTctTimestamp(log.createdAt)}</span>
																{(log.handledByUsername ||
																	effectiveHandlerTornId) && (
																	<div className="text-[10px] text-muted-foreground inline-flex items-center gap-1 flex-wrap">
																		<span>by</span>
																		{effectiveHandlerTornId ? (
																			<a
																				href={`https://www.torn.com/profiles.php?XID=${effectiveHandlerTornId}`}
																				target="_blank"
																				rel="noopener noreferrer"
																				className="font-semibold text-primary hover:underline inline-flex items-center gap-0.5"
																				title={`View Torn Profile for ${effectiveHandlerTornName ?? effectiveHandlerTornId}`}
																			>
																				<span>
																					{effectiveHandlerTornName
																						? `${effectiveHandlerTornName} [${effectiveHandlerTornId}]`
																						: `[${effectiveHandlerTornId}]`}
																				</span>
																				<ExternalLink className="size-2.5 opacity-70 shrink-0" />
																			</a>
																		) : (
																			<span>
																				{handlerMember?.displayName ||
																					log.handledByUsername}
																			</span>
																		)}
																	</div>
																)}
															</div>
														</TableCell>

														{/* Actions */}
														<TableCell className="text-right">
															<DropdownMenu>
																<DropdownMenuTrigger asChild>
																	<Button
																		variant="ghost"
																		size="icon-xs"
																		className="cursor-pointer hover:bg-muted"
																	>
																		<MoreHorizontal className="size-3.5" />
																		<span className="sr-only">Open menu</span>
																	</Button>
																</DropdownMenuTrigger>
																<DropdownMenuContent
																	align="end"
																	className="w-48"
																>
																	<DropdownMenuLabel className="text-[10px] font-mono uppercase text-muted-foreground">
																		Log Actions
																	</DropdownMenuLabel>
																	{log.status === "rejected" && (
																		<>
																			<DropdownMenuItem
																				onClick={() =>
																					setSelectedRejectionLog(log)
																				}
																				className="cursor-pointer text-xs flex items-center gap-2 text-rose-500 focus:text-rose-500"
																			>
																				<FileText className="size-3.5" />
																				<span>View Rejection Reason</span>
																			</DropdownMenuItem>
																			<DropdownMenuSeparator />
																		</>
																	)}
																	{log.tornId && (
																		<DropdownMenuItem
																			asChild
																			className="cursor-pointer text-xs flex items-center gap-2"
																		>
																			<a
																				href={`https://www.torn.com/profiles.php?XID=${log.tornId}`}
																				target="_blank"
																				rel="noopener noreferrer"
																			>
																				<ExternalLink className="size-3.5" />
																				<span>View Torn Profile</span>
																			</a>
																		</DropdownMenuItem>
																	)}
																	<DropdownMenuItem
																		onClick={() => {
																			navigator.clipboard.writeText(log.id);
																			toast.success(
																				"Request ID copied to clipboard",
																			);
																		}}
																		className="cursor-pointer text-xs flex items-center gap-2"
																	>
																		<Copy className="size-3.5" />
																		<span>Copy Request ID</span>
																	</DropdownMenuItem>
																	<DropdownMenuItem
																		onClick={() => {
																			navigator.clipboard.writeText(
																				log.discordUserId,
																			);
																			toast.success(
																				"Discord ID copied to clipboard",
																			);
																		}}
																		className="cursor-pointer text-xs flex items-center gap-2"
																	>
																		<Copy className="size-3.5" />
																		<span>Copy Discord ID</span>
																	</DropdownMenuItem>
																</DropdownMenuContent>
															</DropdownMenu>
														</TableCell>
													</TableRow>
												);
											})
										)}
									</TableBody>
								</Table>
							</div>
						</CardContent>

						{/* Pagination Controls */}
						<CardFooter className="py-3 px-4 border-t border-border/60 flex items-center justify-between text-xs">
							<span className="text-muted-foreground font-mono text-[11px]">
								Showing page {logsPage} of {logsTotalPages} ({logsTotalCount}{" "}
								total logs)
							</span>
							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="xs"
									disabled={logsPage <= 1 || logsLoading}
									onClick={() => fetchLogs(logsPage - 1)}
									className="cursor-pointer"
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="xs"
									disabled={logsPage >= logsTotalPages || logsLoading}
									onClick={() => fetchLogs(logsPage + 1)}
									className="cursor-pointer"
								>
									Next
								</Button>
							</div>
						</CardFooter>
					</Card>
				</TabsContent>
			</Tabs>

			{/* Rejection Details Modal */}
			<Dialog
				open={!!selectedRejectionLog}
				onOpenChange={(open) => !open && setSelectedRejectionLog(null)}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-destructive">
							<XCircle className="size-5" />
							Rejection Details
						</DialogTitle>
						<DialogDescription className="text-xs">
							Request by{" "}
							<strong className="text-foreground">
								{selectedRejectionLog?.discordUsername}
							</strong>{" "}
							for{" "}
							<strong className="text-foreground">
								{selectedRejectionLog?.quantity}x{" "}
								{selectedRejectionLog?.itemName}
							</strong>
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-3 py-2 text-xs">
						<div className="flex justify-between items-center text-muted-foreground border-b border-border/60 pb-2">
							<span>Handled By</span>
							<span className="font-semibold text-foreground font-mono">
								{selectedRejectionLog?.handledByUsername ||
									(selectedRejectionLog?.handledByDiscordId
										? `<@${selectedRejectionLog.handledByDiscordId}>`
										: "Manager")}
							</span>
						</div>
						{selectedRejectionLog?.handledAt && (
							<div className="flex justify-between items-center text-muted-foreground border-b border-border/60 pb-2">
								<span>Handled At</span>
								<span className="font-mono text-foreground">
									{formatTctTimestamp(selectedRejectionLog.handledAt)}
								</span>
							</div>
						)}
						<div className="space-y-1.5">
							<span className="font-medium text-muted-foreground">
								Rejection Reason
							</span>
							<div className="p-3 bg-destructive/5 border border-destructive/20 text-foreground font-mono text-xs rounded-lg whitespace-pre-wrap max-h-48 overflow-y-auto">
								{selectedRejectionLog?.reason ||
									"No explicit reason was provided."}
							</div>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setSelectedRejectionLog(null)}
							className="cursor-pointer"
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Clear All Logs Dialog (Owner Only) */}
			<Dialog
				open={isClearLogsDialogOpen}
				onOpenChange={setIsClearLogsDialogOpen}
			>
				<DialogContent className="sm:max-w-[440px]">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-destructive">
							<Trash2 className="size-5" />
							<span>Clear Tournament Logs?</span>
						</DialogTitle>
						<DialogDescription className="pt-2 text-xs leading-relaxed text-muted-foreground">
							Are you sure you want to permanently clear{" "}
							<strong>all item request history</strong> and{" "}
							<strong>armory deposit records</strong> for this server?
							<br />
							<br />
							This will reset tournament armory inventory levels to zero and
							re-synchronize the storage channel. This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2 sm:gap-0 pt-4">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setIsClearLogsDialogOpen(false)}
							disabled={isClearingLogs}
							className="cursor-pointer"
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={handleClearLogs}
							disabled={isClearingLogs}
							className="cursor-pointer gap-1.5"
						>
							{isClearingLogs ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Trash2 className="size-3.5" />
							)}
							<span>Clear Everything</span>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* View Raw Log Dialog */}
			<Dialog
				open={!!selectedRawLog}
				onOpenChange={(open) => !open && setSelectedRawLog(null)}
			>
				<DialogContent className="sm:max-w-[500px]">
					<DialogHeader>
						<DialogTitle className="text-sm font-semibold flex items-center gap-2">
							<FileText className="size-4 text-primary" />
							<span>{selectedRawLog?.title || "Raw Event Log"}</span>
						</DialogTitle>
						<DialogDescription className="text-xs text-muted-foreground">
							The exact Torn event log text as pasted by the player into
							Discord.
						</DialogDescription>
					</DialogHeader>
					<div className="p-3 bg-muted/50 rounded-lg border border-border/80 font-mono text-xs break-all select-all whitespace-pre-wrap">
						{selectedRawLog?.rawLog}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								if (selectedRawLog?.rawLog) {
									navigator.clipboard.writeText(selectedRawLog.rawLog);
									toast.success("Copied raw log to clipboard");
								}
							}}
							className="cursor-pointer gap-1.5"
						>
							<Copy className="size-3.5" />
							<span>Copy Log Text</span>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Floating unsaved changes bar */}
			{hasUnsavedChanges && (
				<div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 w-[calc(100%-2rem)] max-w-2xl bg-card/95 backdrop-blur-md border border-border shadow-xl rounded-xl p-3 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-3 duration-200">
					<div className="flex items-center gap-2.5 min-w-0">
						<div className="flex flex-col min-w-0">
							<span className="text-xs font-semibold text-foreground">
								Careful — you have unsaved changes!
							</span>
						</div>
					</div>

					<div className="flex items-center gap-2 shrink-0">
						<Button
							variant="ghost"
							size="sm"
							onClick={handleResetChanges}
							disabled={savingConfig}
							className="text-xs h-8 cursor-pointer"
						>
							Discard
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={handleSaveConfig}
							disabled={savingConfig}
							className="text-xs h-8 cursor-pointer font-medium"
						>
							{savingConfig ? (
								<>
									<Loader2 className="size-3.5 animate-spin" />
									Saving...
								</>
							) : (
								<>
									<Save className="size-3.5" />
									Save Settings
								</>
							)}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
