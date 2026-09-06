import {
	Check,
	CheckCircle2,
	Clock,
	Copy,
	Download,
	ExternalLink,
	FlaskConical,
	Loader2,
	MoreHorizontal,
	Package,
	Plus,
	RefreshCw,
	Search,
	ShieldAlert,
	SlidersHorizontal,
	Trash2,
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useElims } from "../contexts/ElimsContext";

export interface WhitelistedItem {
	id: string;
	name: string;
	category: string;
	marketPrice?: number;
	image?: string;
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

function formatCurrency(val?: number): string {
	if (val === undefined || Number.isNaN(val)) return "$0";
	return `$${val.toLocaleString()}`;
}

function formatRoleColor(color: number): string {
	if (color === 0) return "#94a3b8";
	return `#${color.toString(16).padStart(6, "0")}`;
}

export function ItemRequestsPage() {
	const { guild, hasAdminAccess, isOwner } = useElims();

	// ─── Settings State ────────────────────────────────────────────────────────
	const [requestChannelId, setRequestChannelId] = useState<string | null>(null);
	const [grantingChannelId, setGrantingChannelId] = useState<string | null>(
		null,
	);
	const [requesterRoleIds, setRequesterRoleIds] = useState<string[]>([]);
	const [managerRoleIds, setManagerRoleIds] = useState<string[]>([]);
	const [allowedItems, setAllowedItems] = useState<WhitelistedItem[]>([]);
	const [loadingConfig, setLoadingConfig] = useState(true);
	const [savingConfig, setSavingConfig] = useState(false);

	// Channels and Roles options from Discord
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [roles, setRoles] = useState<GuildRole[]>([]);
	const [loadingChannels, setLoadingChannels] = useState(false);
	const [loadingRoles, setLoadingRoles] = useState(false);

	// ─── Whitelist Search State ────────────────────────────────────────────────
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<WhitelistedItem[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ─── Logs & History State ──────────────────────────────────────────────────
	const [logs, setLogs] = useState<ItemRequestLog[]>([]);
	const [logsLoading, setLogsLoading] = useState(false);
	const [initialLogsLoading, setInitialLogsLoading] = useState(true);
	const [logsPage, setLogsPage] = useState(1);
	const [logsTotalPages, setLogsTotalPages] = useState(1);
	const [logsTotalCount, setLogsTotalCount] = useState(0);
	const [statusFilter, setStatusFilter] = useState("all");
	const [testFilter, setTestFilter] = useState("all");
	const [logsSearch, setLogsSearch] = useState("");
	const [debouncedLogsSearch, setDebouncedLogsSearch] = useState("");
	const [togglingTestId, setTogglingTestId] = useState<string | null>(null);
	const logsAbortControllerRef = useRef<AbortController | null>(null);

	// ─── 1. Load Config & Channels & Roles ────────────────────────────────────
	useEffect(() => {
		if (!guild?.id) return;

		setLoadingConfig(true);
		fetch("/api/v1/elims/item-requests/config")
			.then((res) => (res.ok ? res.json() : null))
			.then((data: unknown) => {
				if (
					data &&
					typeof data === "object" &&
					"config" in data &&
					data.config &&
					typeof data.config === "object"
				) {
					const cfg = data.config as Record<string, unknown>;
					setRequestChannelId((cfg.requestChannelId as string) ?? null);
					setGrantingChannelId((cfg.grantingChannelId as string) ?? null);
					setRequesterRoleIds((cfg.requesterRoleIds as string[]) ?? []);
					setManagerRoleIds((cfg.managerRoleIds as string[]) ?? []);
					setAllowedItems((cfg.allowedItems as WhitelistedItem[]) ?? []);
				}
			})
			.catch((err) => console.error("Failed to load item request config:", err))
			.finally(() => setLoadingConfig(false));

		setLoadingChannels(true);
		fetch(`/api/v1/elims/guild-channels/${guild.id}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data: unknown) => {
				if (
					data &&
					typeof data === "object" &&
					"channels" in data &&
					Array.isArray(data.channels)
				) {
					setChannels(data.channels as DiscordChannel[]);
				}
			})
			.catch((err) => console.error("Failed to load guild channels:", err))
			.finally(() => setLoadingChannels(false));

		setLoadingRoles(true);
		fetch(`/api/v1/elims/guild-roles/${guild.id}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data: unknown) => {
				if (
					data &&
					typeof data === "object" &&
					"roles" in data &&
					Array.isArray(data.roles)
				) {
					setRoles(data.roles as GuildRole[]);
				}
			})
			.catch((err) => console.error("Failed to load guild roles:", err))
			.finally(() => setLoadingRoles(false));
	}, [guild?.id]);

	// ─── 2. Debounced Item Search ─────────────────────────────────────────────
	useEffect(() => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}

		if (!searchQuery.trim()) {
			setSearchResults([]);
			setIsSearching(false);
			return;
		}

		setIsSearching(true);
		debounceTimerRef.current = setTimeout(() => {
			fetch(
				`/api/v1/elims/item-requests/items/search?q=${encodeURIComponent(searchQuery.trim())}`,
			)
				.then((res) => (res.ok ? res.json() : null))
				.then((data: unknown) => {
					if (
						data &&
						typeof data === "object" &&
						"items" in data &&
						Array.isArray(data.items)
					) {
						setSearchResults(data.items as WhitelistedItem[]);
					}
				})
				.catch((err) => console.error("Search items error:", err))
				.finally(() => setIsSearching(false));
		}, 300);

		return () => {
			if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
		};
	}, [searchQuery]);

	// Debounce logsSearch to prevent request storm and layout flicker on every keystroke
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedLogsSearch(logsSearch);
		}, 300);
		return () => clearTimeout(timer);
	}, [logsSearch]);

	// ─── 3. Fetch Request Logs ────────────────────────────────────────────────
	const fetchLogs = useCallback(
		(page = logsPage, search = debouncedLogsSearch) => {
			if (logsAbortControllerRef.current) {
				logsAbortControllerRef.current.abort();
			}
			const abortController = new AbortController();
			logsAbortControllerRef.current = abortController;

			setLogsLoading(true);
			const params = new URLSearchParams({
				page: String(page),
				limit: "15",
			});
			if (statusFilter !== "all") params.set("status", statusFilter);
			if (testFilter !== "all") params.set("isTest", testFilter);
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
		[logsPage, statusFilter, testFilter, debouncedLogsSearch],
	);

	useEffect(() => {
		fetchLogs(1, debouncedLogsSearch);
	}, [statusFilter, testFilter, debouncedLogsSearch, fetchLogs]);

	// ─── CSV Export ───────────────────────────────────────────────────────────
	const [isExporting, setIsExporting] = useState(false);

	const handleDownloadCsv = async (exportAll = false) => {
		setIsExporting(true);
		try {
			const params = new URLSearchParams();
			if (!exportAll) {
				if (statusFilter !== "all") params.set("status", statusFilter);
				if (testFilter !== "all") params.set("isTest", testFilter);
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

	// ─── Toggle Whitelisted Item ──────────────────────────────────────────────
	const handleAddItem = (item: WhitelistedItem) => {
		if (allowedItems.some((i) => i.id === item.id)) {
			toast.info(`${item.name} is already whitelisted.`);
			return;
		}
		setAllowedItems((prev) => [...prev, item]);
		toast.success(`Added ${item.name} to whitelisted items.`);
	};

	const handleRemoveItem = (itemId: string) => {
		setAllowedItems((prev) => prev.filter((i) => i.id !== itemId));
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
					requesterRoleIds,
					managerRoleIds,
					allowedItems,
				}),
			});

			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Failed to save configuration");
			}

			toast.success("Item Requests configuration saved successfully!");
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Error saving configuration";
			toast.error(msg);
		} finally {
			setSavingConfig(false);
		}
	};

	// ─── Toggle Test Flag on Log ──────────────────────────────────────────────
	const handleToggleTest = async (logId: string) => {
		setTogglingTestId(logId);
		try {
			const res = await fetch(
				`/api/v1/elims/item-requests/logs/${logId}/test`,
				{
					method: "PATCH",
				},
			);
			if (!res.ok) throw new Error("Failed to update test flag");
			const data = (await res.json()) as {
				success: boolean;
				item: ItemRequestLog;
			};

			setLogs((prev) =>
				prev.map((item) => (item.id === logId ? data.item : item)),
			);
			toast.success(
				data.item.isTest
					? "Marked request as test log."
					: "Unmarked request as test log.",
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Error updating log");
		} finally {
			setTogglingTestId(null);
		}
	};

	// Group allowed items by category
	const itemsByCategory = useMemo(() => {
		const groups: Record<string, WhitelistedItem[]> = {};
		for (const item of allowedItems) {
			const cat = item.category || "General";
			if (!groups[cat]) groups[cat] = [];
			groups[cat].push(item);
		}
		return groups;
	}, [allowedItems]);

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
			{/* Page Header */}
			<div className="flex flex-col md:flex-row md:items-center md:justify-end gap-4 border-b border-border/60 pb-5">
				<div className="flex items-center gap-2 shrink-0">
					<Button
						variant="outline"
						size="sm"
						onClick={() => fetchLogs(logsPage)}
						disabled={logsLoading}
						className="cursor-pointer gap-1.5"
					>
						<RefreshCw
							className={`size-3.5 ${logsLoading ? "animate-spin" : ""}`}
						/>
						<span>Refresh Logs</span>
					</Button>
					<Button
						variant="default"
						size="sm"
						onClick={handleSaveConfig}
						disabled={savingConfig || loadingConfig}
						className="cursor-pointer gap-1.5 font-medium"
					>
						{savingConfig ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Check className="size-3.5" />
						)}
						<span>Save Settings</span>
					</Button>
				</div>
			</div>

			{/* Main Tabs */}
			<Tabs defaultValue="settings" className="w-full">
				<TabsList className="grid w-full grid-cols-2 max-w-md mb-2">
					<TabsTrigger value="settings" className="cursor-pointer gap-2">
						<SlidersHorizontal className="size-3.5" />
						<span>Configuration & Items</span>
					</TabsTrigger>
					<TabsTrigger value="logs" className="cursor-pointer gap-2">
						<Clock className="size-3.5" />
						<span>Requests History</span>
						{logsTotalCount > 0 && (
							<Badge
								variant="secondary"
								className="text-[10px] font-mono px-1 py-0 ml-1"
							>
								{logsTotalCount}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>

				{/* ─── TAB 1: Configuration & Whitelist ──────────────────────────────── */}
				<TabsContent value="settings" className="flex flex-col gap-6 mt-4">
					<div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
						{/* Channels & Roles Configuration */}
						<div className="lg:col-span-6 flex flex-col gap-6">
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
											<span className="text-[10px] text-muted-foreground font-normal">
												Bot maintains interactive embed here
											</span>
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
											<span className="text-[10px] text-muted-foreground font-normal">
												Review embeds sent here with accept/reject buttons
											</span>
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
										<p className="text-[11px] text-muted-foreground">
											Leave empty to allow all members in the server to request
											items. If specified, only members with any of these roles
											can open requests.
										</p>
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
										<p className="text-[11px] text-muted-foreground">
											Roles authorized to click Accept / Reject buttons in the
											granting channel. (Server Administrators always have
											permission).
										</p>
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
						</div>

						{/* Whitelisted Items Curator */}
						<div className="lg:col-span-6 flex flex-col gap-6">
							<Card className="border-border/80 shadow-xs flex flex-col h-full">
								<CardHeader className="pb-3">
									<div className="flex items-center justify-between">
										<CardTitle className="text-base font-semibold flex items-center gap-2">
											Items Whitelist
										</CardTitle>
										<Badge variant="outline" className="font-mono text-xs">
											{allowedItems.length} whitelisted
										</Badge>
									</div>
								</CardHeader>

								<CardContent className="flex flex-col gap-4 flex-1">
									{/* Debounced Search Input */}
									<div className="relative">
										<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
										<Input
											type="text"
											placeholder="Search Torn items by name..."
											value={searchQuery}
											onChange={(e) => setSearchQuery(e.target.value)}
											className="pl-8 text-xs font-mono"
										/>
										{isSearching && (
											<Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 size-3.5 animate-spin text-muted-foreground" />
										)}
									</div>

									{/* Search Results Dropdown/Box */}
									{searchQuery.trim().length > 0 && (
										<div className="flex flex-col gap-1.5 p-2 rounded-lg border border-border/80 bg-background shadow-md max-h-56 overflow-y-auto">
											<span className="text-[10px] font-mono text-muted-foreground uppercase px-1">
												Search Results ({searchResults.length})
											</span>
											{searchResults.length === 0 && !isSearching ? (
												<div className="text-xs text-muted-foreground p-3 text-center">
													No matching Torn items found.
												</div>
											) : (
												searchResults.map((item) => {
													const alreadyAdded = allowedItems.some(
														(i) => i.id === item.id,
													);
													return (
														<div
															key={item.id}
															className="flex items-center justify-between gap-3 p-1.5 rounded-md hover:bg-muted/50 transition-colors"
														>
															<div className="flex items-center gap-2.5 min-w-0">
																{item.image ? (
																	<img
																		src={item.image}
																		alt={item.name}
																		className="size-7 object-contain rounded bg-muted/40 p-0.5 border border-border/40 shrink-0"
																	/>
																) : (
																	<div className="size-7 rounded bg-muted flex items-center justify-center text-[10px] font-mono shrink-0">
																		IT
																	</div>
																)}
																<div className="flex flex-col min-w-0">
																	<span className="text-xs font-medium text-foreground truncate">
																		{item.name}
																	</span>
																	<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
																		<span>{item.category}</span>
																		<span>•</span>
																		<span>
																			{formatCurrency(item.marketPrice)}
																		</span>
																	</div>
																</div>
															</div>

															<Button
																variant={alreadyAdded ? "secondary" : "default"}
																size="xs"
																disabled={alreadyAdded}
																onClick={() => handleAddItem(item)}
																className="cursor-pointer gap-1 shrink-0"
															>
																{alreadyAdded ? (
																	<>
																		<Check className="size-3" />
																		<span>Added</span>
																	</>
																) : (
																	<>
																		<Plus className="size-3" />
																		<span>Add</span>
																	</>
																)}
															</Button>
														</div>
													);
												})
											)}
										</div>
									)}

									{/* Currently Whitelisted Items List Grouped by Category */}
									<div className="flex flex-col gap-3 flex-1 overflow-y-auto max-h-[440px] pr-1">
										{allowedItems.length === 0 ? (
											<div className="flex flex-col items-center justify-center p-8 border border-dashed border-border/80 rounded-lg text-center gap-2 text-muted-foreground my-auto">
												<Package className="size-8 stroke-[1.2]" />
												<p className="text-xs font-medium">
													No items whitelisted yet
												</p>
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

														<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
															{catItems.map((item) => (
																<div
																	key={item.id}
																	className="flex items-center justify-between gap-2 p-2 rounded-md bg-background border border-border/60"
																>
																	<div className="flex items-center gap-2 min-w-0">
																		{item.image ? (
																			<img
																				src={item.image}
																				alt={item.name}
																				className="size-6 object-contain rounded shrink-0"
																			/>
																		) : (
																			<div className="size-6 rounded bg-muted/60 flex items-center justify-center text-[9px] font-mono shrink-0">
																				IT
																			</div>
																		)}
																		<div className="flex flex-col min-w-0">
																			<span className="text-xs font-medium text-foreground truncate">
																				{item.name}
																			</span>
																			<span className="text-[10px] font-mono text-muted-foreground">
																				{formatCurrency(item.marketPrice)}
																			</span>
																		</div>
																	</div>

																	<Button
																		variant="ghost"
																		size="icon-xs"
																		onClick={() => handleRemoveItem(item.id)}
																		title="Remove Item"
																		className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer shrink-0"
																	>
																		<Trash2 className="size-3" />
																	</Button>
																</div>
															))}
														</div>
													</div>
												),
											)
										)}
									</div>
								</CardContent>

								<CardFooter className="pt-3 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground">
									{allowedItems.length > 0 && (
										<Button
											variant="ghost"
											size="xs"
											onClick={() => setAllowedItems([])}
											className="text-destructive hover:bg-destructive/10 cursor-pointer"
										>
											Clear All
										</Button>
									)}
								</CardFooter>
							</Card>
						</div>
					</div>
				</TabsContent>

				{/* ─── TAB 2: Requests History & Audit Logs ──────────────────────────── */}
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

									{/* Test Filter */}
									<Select
										value={testFilter}
										onValueChange={(v) => setTestFilter(v)}
									>
										<SelectTrigger className="h-8 text-xs font-mono w-[130px] cursor-pointer">
											<SelectValue placeholder="Type" />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="all" className="text-xs font-mono">
													All Logs
												</SelectItem>
												<SelectItem value="false" className="text-xs font-mono">
													Live Requests
												</SelectItem>
												<SelectItem value="true" className="text-xs font-mono">
													Test Logs Only
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
											<TableHead>Date / Handled</TableHead>
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

												return (
													<TableRow
														key={log.id}
														className={
															log.isTest
																? "bg-amber-500/5 hover:bg-amber-500/10"
																: ""
														}
													>
														{/* Requester */}
														<TableCell
															className={
																log.isTest
																	? "border-l-2 border-l-amber-500"
																	: ""
															}
														>
															{log.tornId ? (
																<a
																	href={`https://www.torn.com/profiles.php?XID=${log.tornId}`}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
																	title={`View Torn Profile for ${log.tornName ?? log.tornId}`}
																>
																	<span>
																		{log.tornName
																			? `${log.tornName} [${log.tornId}]`
																			: `[${log.tornId}]`}
																	</span>
																	<ExternalLink className="size-3 opacity-70 shrink-0" />
																</a>
															) : (
																<span className="text-xs text-muted-foreground">
																	{log.discordUsername}
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
																{isRejected && (
																	<Badge
																		variant="outline"
																		className="bg-rose-500/10 text-rose-500 border-rose-500/30 text-[10px] font-mono flex items-center gap-1 w-fit"
																	>
																		<XCircle className="size-2.5" />
																		REJECTED
																	</Badge>
																)}
																{log.isTest && (
																	<Badge
																		variant="outline"
																		className="bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400 font-mono text-[9px] font-bold tracking-wider flex items-center gap-1 px-1.5"
																	>
																		<FlaskConical className="size-2.5" />
																		TEST
																	</Badge>
																)}
															</div>
														</TableCell>

														{/* Date & Handled by */}
														<TableCell>
															<div className="flex flex-col text-xs font-mono">
																<span>
																	{new Date(log.createdAt).toLocaleDateString()}{" "}
																	{new Date(log.createdAt).toLocaleTimeString(
																		[],
																		{ hour: "2-digit", minute: "2-digit" },
																	)}
																</span>
																{(log.handledByUsername ||
																	log.handledByTornId) && (
																	<div className="text-[10px] text-muted-foreground inline-flex items-center gap-1 flex-wrap">
																		<span>by</span>
																		{log.handledByTornId ? (
																			<a
																				href={`https://www.torn.com/profiles.php?XID=${log.handledByTornId}`}
																				target="_blank"
																				rel="noopener noreferrer"
																				className="font-semibold text-primary hover:underline inline-flex items-center gap-0.5"
																				title={`View Torn Profile for ${log.handledByTornName ?? log.handledByTornId}`}
																			>
																				<span>
																					{log.handledByTornName
																						? `${log.handledByTornName} [${log.handledByTornId}]`
																						: `[${log.handledByTornId}]`}
																				</span>
																				<ExternalLink className="size-2.5 opacity-70 shrink-0" />
																			</a>
																		) : (
																			<span>{log.handledByUsername}</span>
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
																		disabled={togglingTestId === log.id}
																	>
																		{togglingTestId === log.id ? (
																			<Loader2 className="size-3.5 animate-spin" />
																		) : (
																			<MoreHorizontal className="size-3.5" />
																		)}
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
																	<DropdownMenuItem
																		onClick={() => handleToggleTest(log.id)}
																		className="cursor-pointer text-xs flex items-center gap-2"
																	>
																		<FlaskConical className="size-3.5" />
																		<span>
																			{log.isTest
																				? "Unmark as Test"
																				: "Mark as Test"}
																		</span>
																	</DropdownMenuItem>
																	<DropdownMenuSeparator />
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
		</div>
	);
}
