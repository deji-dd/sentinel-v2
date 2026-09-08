import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	BarChart3,
	ChevronLeft,
	ChevronRight,
	RefreshCw,
	Search,
	ShieldCheck,
	Trash2,
	Users,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
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
import { useAuth } from "../contexts/AuthContext";
import { useElims } from "../contexts/ElimsContext";
import { api } from "../lib/api";

interface DiscordRoleItem {
	id: string;
	name: string;
	color: number;
}

interface FFScouterStatsData {
	player_id?: number;
	fair_fight?: number | null;
	bs_estimate?: number | null;
	bs_estimate_human?: string | null;
	bss_public?: number | null;
	distribution?: {
		distribution_human?: string;
		stats_percentage?: {
			strength?: number;
			speed?: number;
			defense?: number;
			dexterity?: number;
		};
	} | null;
}

interface MemberStatItem {
	id: string;
	discordId: string;
	discordNickname: string | null;
	roles: string[];
	tornId: number | null;
	tornName: string | null;
	tornLevel: number | null;
	bsEstimate: number | null;
	bsEstimateHuman: string | null;
	networth?: number | null;
	score?: number;
	attacks?: number;
	fairFight: number | null;
	ffScouterStats: FFScouterStatsData | null;
	lastFetchedAt: string;
}

interface TeamStatsResponse {
	members: MemberStatItem[];
	team?: {
		id: number;
		name: string;
		score: number;
		attacks: number;
		lives: number;
		position: number;
		wins: number;
		losses: number;
		eliminated: boolean;
	};
	summary: {
		totalMembers: number;
		totalBs: number;
		avgBs: number;
		estimatedMembers?: number;
	};
}

const STAT_BUCKETS = [
	{ label: "<1b", min: 0, max: 1e9, color: "#64748b" },
	{ label: "1b-2.5b", min: 1e9, max: 2.5e9, color: "#38bdf8" },
	{ label: "2.5b-5b", min: 2.5e9, max: 5e9, color: "#0ea5e9" },
	{ label: "5b-10b", min: 5e9, max: 10e9, color: "#3b82f6" },
	{ label: "10b-25b", min: 10e9, max: 25e9, color: "#6366f1" },
	{ label: "25b-50b", min: 25e9, max: 50e9, color: "#8b5cf6" },
	{ label: "50b-100b", min: 50e9, max: 100e9, color: "#a855f7" },
	{ label: "100b-250b", min: 100e9, max: 250e9, color: "#d946ef" },
	{ label: "250b-500b", min: 250e9, max: 500e9, color: "#ec4899" },
	{ label: "500b-1t", min: 500e9, max: 1e12, color: "#f43f5e" },
	{
		label: ">1t",
		min: 1e12,
		max: Number.POSITIVE_INFINITY,
		color: "#e11d48",
	},
] as const;

type SortField =
	| "name"
	| "level"
	| "bsEstimate"
	| "networth"
	| "score"
	| "attacks"
	| "discord"
	| "fairFight";
type SortOrder = "asc" | "desc";

const ROLE_STORAGE_KEY = "sentinel_elims_team_breakdown_role";

function formatStatNumber(num: number): string {
	if (num >= 1_000_000_000_000_000) {
		return `${(num / 1_000_000_000_000_000).toFixed(2)}q`;
	}
	if (num >= 1_000_000_000_000) {
		return `${(num / 1_000_000_000_000).toFixed(2)}t`;
	}
	if (num >= 1_000_000_000) {
		return `${(num / 1_000_000_000).toFixed(2)}b`;
	}
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(2)}m`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}k`;
	}
	return num.toLocaleString();
}

function formatCurrency(num: number): string {
	if (num >= 1_000_000_000_000_000) {
		return `$${(num / 1_000_000_000_000_000).toFixed(2)}q`;
	}
	if (num >= 1_000_000_000_000) {
		return `$${(num / 1_000_000_000_000).toFixed(2)}t`;
	}
	if (num >= 1_000_000_000) {
		return `$${(num / 1_000_000_000).toFixed(2)}b`;
	}
	if (num >= 1_000_000) {
		return `$${(num / 1_000_000).toFixed(2)}m`;
	}
	if (num >= 1_000) {
		return `$${(num / 1_000).toFixed(1)}k`;
	}
	return `$${num.toLocaleString()}`;
}

interface TooltipPayloadItem {
	payload: {
		range: string;
		count: number;
		percentage: number;
		color: string;
	};
}

interface CustomTooltipProps {
	active?: boolean;
	payload?: TooltipPayloadItem[];
}

function StatDistributionTooltip({ active, payload }: CustomTooltipProps) {
	if (active && payload && payload.length > 0) {
		const data = payload[0]?.payload;
		if (!data) return null;
		return (
			<div className="rounded-lg border border-border bg-card/95 p-3 shadow-xl backdrop-blur-md">
				<p className="font-mono text-xs font-semibold text-foreground">
					Tier: {data.range}
				</p>
				<p className="font-mono text-xs text-primary mt-1">
					{data.count} member{data.count === 1 ? "" : "s"} ({data.percentage}%)
				</p>
				<p className="text-[10px] font-mono text-muted-foreground mt-1">
					Click bar to toggle filter
				</p>
			</div>
		);
	}
	return null;
}

export function TeamBreakdownPage() {
	const { user } = useAuth();
	const { isOwner: isElimsOwner } = useElims();
	const isOwner =
		isElimsOwner ||
		user?.role === "owner" ||
		user?.discordId === "729432882166366218";

	const [roles, setRoles] = useState<DiscordRoleItem[]>([]);
	const [selectedRoleId, setSelectedRoleId] = useState<string>(() => {
		if (typeof window !== "undefined") {
			return localStorage.getItem(ROLE_STORAGE_KEY) || "all";
		}
		return "all";
	});
	const [search, setSearch] = useState("");
	const [selectedTier, setSelectedTier] = useState<string | null>(null);
	const [sortField, setSortField] = useState<SortField>("bsEstimate");
	const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
	const [statsData, setStatsData] = useState<TeamStatsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [fetchingStats, setFetchingStats] = useState(false);
	const [currentPage, setCurrentPage] = useState(1);
	const [pageSize, setPageSize] = useState(50);

	const [isStatRolesDialogOpen, setIsStatRolesDialogOpen] = useState(false);
	const [statRoleMappings, setStatRoleMappings] = useState<
		Record<string, string>
	>({});
	const [savingStatRoles, setSavingStatRoles] = useState(false);

	const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
	const [resettingMembers, setResettingMembers] = useState(false);

	const selectedRoleName = useMemo(() => {
		if (selectedRoleId === "all") return null;
		const found = roles.find((r) => r.id === selectedRoleId);
		return found ? found.name : selectedRoleId;
	}, [roles, selectedRoleId]);

	const handleRoleChange = (newRoleId: string) => {
		setSelectedRoleId(newRoleId);
		if (typeof window !== "undefined") {
			localStorage.setItem(ROLE_STORAGE_KEY, newRoleId);
		}
	};

	const fetchRoles = useCallback(async () => {
		try {
			const res = await api.api.v1.elims["guild-roles"].get();
			if (res.data && "roles" in res.data) {
				setRoles(res.data.roles as DiscordRoleItem[]);
			}
		} catch {}
	}, []);

	const fetchStatRoles = useCallback(async () => {
		try {
			const res = await api.api.v1.elims["team-stats"]["stat-roles"].get();
			if (res.data && "mappings" in res.data && res.data.mappings) {
				setStatRoleMappings(res.data.mappings as Record<string, string>);
			}
		} catch {}
	}, []);

	const fetchMembersStats = useCallback(async () => {
		try {
			const query: Record<string, string> = {};
			if (selectedRoleId !== "all") query.roleId = selectedRoleId;

			const res = await api.api.v1.elims["team-stats"].get({
				query,
			});

			if (res.data) {
				setStatsData(res.data as unknown as TeamStatsResponse);
			}
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to load team member stats.",
			);
		} finally {
			setLoading(false);
		}
	}, [selectedRoleId]);

	const [configuredTeamRoleId, setConfiguredTeamRoleId] = useState<
		string | null
	>(null);
	const [savingTeamRole, setSavingTeamRole] = useState(false);

	const fetchTeamStatsConfig = useCallback(async () => {
		try {
			const res = await api.api.v1.elims["team-stats"].config.get();
			if (res.data && "teamRoleId" in res.data) {
				const saved = res.data.teamRoleId;
				setConfiguredTeamRoleId(saved ?? null);
				if (saved && selectedRoleId === "all") {
					setSelectedRoleId(saved);
				}
			}
		} catch {}
	}, [selectedRoleId]);

	const handleSaveTeamRole = async () => {
		setSavingTeamRole(true);
		try {
			const nextRole = selectedRoleId === "all" ? null : selectedRoleId;
			const res = await api.api.v1.elims["team-stats"].config.put({
				teamRoleId: nextRole,
				autoSyncTeamStats: true,
			});
			if (res.data) {
				setConfiguredTeamRoleId(nextRole);
				toast.success(
					nextRole && selectedRoleName
						? `Set "${selectedRoleName}" as official team role. Background automated sync is active.`
						: "Cleared official team role.",
				);
			} else if (res.error) {
				toast.error("Failed to update team role configuration.");
			}
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to update team role configuration.",
			);
		} finally {
			setSavingTeamRole(false);
		}
	};

	useEffect(() => {
		if (isOwner) {
			fetchRoles();
			fetchStatRoles();
			fetchTeamStatsConfig();
		}
	}, [fetchRoles, fetchStatRoles, fetchTeamStatsConfig, isOwner]);

	useEffect(() => {
		fetchMembersStats();
	}, [fetchMembersStats]);

	const handleGetMembersStats = async (forceRefresh = false) => {
		setFetchingStats(true);
		try {
			const body: { roleId?: string; forceRefresh?: boolean } = {};
			if (selectedRoleId !== "all") body.roleId = selectedRoleId;
			if (forceRefresh) body.forceRefresh = true;
			const res = await api.api.v1.elims["team-stats"].fetch.post(body);

			if (res.data) {
				const result = res.data as {
					total: number;
					newProcessed: number;
					resolved: number;
					ffScouterHits: number;
					message?: string;
				};
				toast.success(
					result.message ??
						`Processed ${result.newProcessed} member(s) (${result.resolved} resolved, ${result.ffScouterHits} stat hits).`,
				);
				await fetchMembersStats();
			} else if (res.error) {
				toast.error("Member stats resolution failed.");
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to fetch member stats.",
			);
		} finally {
			setFetchingStats(false);
		}
	};

	const handleSaveAndAssignStatRoles = async () => {
		setSavingStatRoles(true);
		try {
			const res = await api.api.v1.elims["team-stats"]["assign-roles"].post({
				roleMappings: statRoleMappings,
			});

			if (res.data) {
				const result = res.data as {
					success: boolean;
					message?: string;
				};
				toast.success(
					result.message ?? "Stat roles saved and assignment started.",
				);
				setIsStatRolesDialogOpen(false);
			} else if (res.error) {
				toast.error("Failed to assign stat roles.");
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to assign stat roles.",
			);
		} finally {
			setSavingStatRoles(false);
		}
	};

	const handleResetMembers = async () => {
		setResettingMembers(true);
		try {
			const res = await api.api.v1.elims["team-stats"].reset.post({
				roleId: selectedRoleId !== "all" ? selectedRoleId : undefined,
			});

			if (res.data) {
				const result = res.data as {
					success: boolean;
					message?: string;
					deletedCount: number;
				};
				toast.success(
					result.message ?? `Removed ${result.deletedCount} member record(s).`,
				);
				setIsResetDialogOpen(false);
				await fetchMembersStats();
			} else if (res.error) {
				toast.error("Failed to reset member stats.");
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to reset member stats.",
			);
		} finally {
			setResettingMembers(false);
		}
	};

	const members = statsData?.members ?? [];
	const summary = statsData?.summary ?? {
		totalMembers: 0,
		totalBs: 0,
		avgBs: 0,
		estimatedMembers: 0,
	};
	const hasMissingStats =
		members.length > 0 && members.some((m) => !m.bsEstimate);

	// Calculate median, mean, and estimated member count
	const { medianBs, avgBs } = useMemo(() => {
		const validEstimates = members
			.map((m) => m.bsEstimate)
			.filter((bs): bs is number => typeof bs === "number" && bs > 0)
			.sort((a, b) => a - b);

		const count = validEstimates.length;
		if (count === 0) {
			return {
				medianBs: 0,
				avgBs: summary.avgBs || 0,
				estimatedCount: 0,
			};
		}

		const mid = Math.floor(count / 2);
		const median =
			count % 2 !== 0
				? (validEstimates[mid] ?? 0)
				: Math.round(
						((validEstimates[mid - 1] ?? 0) + (validEstimates[mid] ?? 0)) / 2,
					);

		const sum = validEstimates.reduce((acc, val) => acc + val, 0);
		const mean = Math.round(sum / count);

		return {
			medianBs: median,
			avgBs: mean || summary.avgBs,
			estimatedCount: count,
		};
	}, [members, summary.avgBs]);

	// Bucket data for stat breakdowns chart
	const bucketData = useMemo(() => {
		const counts = STAT_BUCKETS.map((b) => ({
			range: b.label,
			min: b.min,
			max: b.max,
			color: b.color,
			count: 0,
			percentage: 0,
		}));

		const estimatedMembers = members.filter(
			(m) => typeof m.bsEstimate === "number" && m.bsEstimate > 0,
		);
		const total = estimatedMembers.length;

		for (const m of estimatedMembers) {
			const bs = m.bsEstimate as number;
			const bucket = counts.find((b) => bs >= b.min && bs < b.max);
			if (bucket) {
				bucket.count += 1;
			}
		}

		for (const b of counts) {
			b.percentage = total > 0 ? Math.round((b.count / total) * 100) : 0;
		}

		return counts;
	}, [members]);

	const handleSort = (field: SortField) => {
		if (sortField === field) {
			setSortOrder(sortOrder === "asc" ? "desc" : "asc");
		} else {
			setSortField(field);
			setSortOrder(field === "name" || field === "discord" ? "asc" : "desc");
		}
	};

	const renderSortIcon = (field: SortField) => {
		if (sortField !== field) {
			return <ArrowUpDown className="size-3 opacity-30" />;
		}
		return sortOrder === "asc" ? (
			<ArrowUp className="size-3 text-primary" />
		) : (
			<ArrowDown className="size-3 text-primary" />
		);
	};

	// Filter and sort members
	const filteredAndSortedMembers = useMemo(() => {
		let result = members;

		// Filter by tier if selected
		if (selectedTier) {
			const bucket = STAT_BUCKETS.find((b) => b.label === selectedTier);
			if (bucket) {
				result = result.filter(
					(m) =>
						typeof m.bsEstimate === "number" &&
						m.bsEstimate >= bucket.min &&
						m.bsEstimate < bucket.max,
				);
			}
		}

		// Filter by search query
		const q = search.trim().toLowerCase();
		if (q) {
			result = result.filter((m) => {
				const discordNick = (m.discordNickname ?? "").toLowerCase();
				const tornName = (m.tornName ?? "").toLowerCase();
				const tornIdStr = m.tornId ? String(m.tornId) : "";
				const discordId = m.discordId.toLowerCase();
				return (
					discordNick.includes(q) ||
					tornName.includes(q) ||
					tornIdStr.includes(q) ||
					discordId.includes(q)
				);
			});
		}

		// Sort
		return [...result].sort((a, b) => {
			let cmp = 0;
			if (sortField === "name") {
				const nameA = (a.tornName ?? a.discordNickname ?? "").toLowerCase();
				const nameB = (b.tornName ?? b.discordNickname ?? "").toLowerCase();
				cmp = nameA.localeCompare(nameB);
			} else if (sortField === "level") {
				const lvlA = a.tornLevel ?? -1;
				const lvlB = b.tornLevel ?? -1;
				cmp = lvlA - lvlB;
			} else if (sortField === "bsEstimate") {
				const bsA = a.bsEstimate ?? -1;
				const bsB = b.bsEstimate ?? -1;
				cmp = bsA - bsB;
			} else if (sortField === "networth") {
				const nwA = a.networth ?? -1;
				const nwB = b.networth ?? -1;
				cmp = nwA - nwB;
			} else if (sortField === "score") {
				const sA = a.score ?? 0;
				const sB = b.score ?? 0;
				cmp = sA - sB;
			} else if (sortField === "attacks") {
				const attA = a.attacks ?? 0;
				const attB = b.attacks ?? 0;
				cmp = attA - attB;
			} else if (sortField === "discord") {
				const dscA = (a.discordNickname ?? a.discordId).toLowerCase();
				const dscB = (b.discordNickname ?? b.discordId).toLowerCase();
				cmp = dscA.localeCompare(dscB);
			} else if (sortField === "fairFight") {
				const ffA = a.fairFight ?? -1;
				const ffB = b.fairFight ?? -1;
				cmp = ffA - ffB;
			}
			return sortOrder === "asc" ? cmp : -cmp;
		});
	}, [members, selectedTier, search, sortField, sortOrder]);

	useEffect(() => {
		setCurrentPage(1);
	}, [search, selectedTier, selectedRoleId, sortField, sortOrder]);

	const totalPages = Math.max(
		1,
		Math.ceil(filteredAndSortedMembers.length / pageSize),
	);
	const paginatedMembers = useMemo(() => {
		const start = (currentPage - 1) * pageSize;
		return filteredAndSortedMembers.slice(start, start + pageSize);
	}, [filteredAndSortedMembers, currentPage, pageSize]);

	return (
		<div className="flex flex-col gap-6 p-6">
			{/* KPI Cards: Total Members, Median Stats, Mean Stats */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				{/* 1. Total Members */}
				<Card>
					<CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
						<CardTitle className="text-xs font-mono text-muted-foreground uppercase">
							Total Members
						</CardTitle>
						<Users className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold font-mono">
							{summary.totalMembers}
						</div>
					</CardContent>
				</Card>

				{/* 2. Median Stats */}
				<Card>
					<CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
						<CardTitle className="text-xs font-mono text-muted-foreground uppercase">
							Median Stats
						</CardTitle>
						<BarChart3 className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold font-mono text-primary">
							{medianBs > 0 ? formatStatNumber(medianBs) : "-"}
						</div>
					</CardContent>
				</Card>

				{/* 3. Mean Stats */}
				<Card>
					<CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
						<CardTitle className="text-xs font-mono text-muted-foreground uppercase">
							Mean Stats
						</CardTitle>
						<BarChart3 className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold font-mono">
							{avgBs > 0 ? formatStatNumber(avgBs) : "-"}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Stat Breakdowns Chart (<1b, 1b-2.5b, 2.5b-5b, 5b-10b, 10b-25b, 25b-50b, 50b-100b, >100b) */}
			<Card>
				<CardHeader className="pb-2 border-b border-border/40">
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<div className="flex items-center gap-3">
							<CardTitle className="text-sm font-bold font-mono uppercase tracking-wide">
								Battle Stat Distribution
							</CardTitle>
							{isOwner && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsStatRolesDialogOpen(true)}
									className="h-7 text-xs font-mono gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
								>
									<ShieldCheck className="size-3.5" />
									Auto-Assign Roles
								</Button>
							)}
						</div>
						{selectedTier && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setSelectedTier(null)}
								className="h-7 text-xs font-mono text-muted-foreground hover:text-foreground gap-1"
							>
								Clear tier filter ({selectedTier})
								<X className="size-3" />
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent className="pt-4">
					<div className="h-60 w-full">
						<ResponsiveContainer width="100%" height="100%">
							<BarChart
								data={bucketData}
								margin={{ top: 10, right: 10, left: -20, bottom: 10 }}
							>
								<CartesianGrid
									strokeDasharray="3 3"
									stroke="#1e293b"
									vertical={false}
								/>
								<XAxis
									dataKey="range"
									tick={{
										fill: "#94a3b8",
										fontSize: 11,
										fontFamily: "var(--font-mono)",
									}}
									interval={0}
									tickLine={false}
								/>
								<YAxis
									allowDecimals={false}
									tick={{
										fill: "#94a3b8",
										fontSize: 11,
										fontFamily: "var(--font-mono)",
									}}
									tickLine={false}
									axisLine={false}
								/>
								<Tooltip
									content={<StatDistributionTooltip />}
									cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
								/>
								<Bar dataKey="count" radius={[4, 4, 0, 0]}>
									{bucketData.map((entry) => (
										<Cell
											key={entry.range}
											fill={entry.color}
											opacity={
												selectedTier && selectedTier !== entry.range ? 0.35 : 1
											}
											stroke={
												selectedTier === entry.range ? "#ffffff" : "transparent"
											}
											strokeWidth={selectedTier === entry.range ? 2 : 0}
											className="cursor-pointer"
											onClick={() => {
												setSelectedTier((prev) =>
													prev === entry.range ? null : entry.range,
												);
											}}
										/>
									))}
								</Bar>
							</BarChart>
						</ResponsiveContainer>
					</div>
				</CardContent>
			</Card>

			{/* Merged Member Battle Stats Card (Toolbar & Sortable Table) */}
			<Card>
				<CardHeader className="flex flex-col gap-4 pb-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/40">
					<div className="flex flex-col gap-1">
						<p className="text-xs font-mono text-muted-foreground">
							{filteredAndSortedMembers.length} member
							{filteredAndSortedMembers.length === 1 ? "" : "s"} shown
							{selectedTier ? ` • Tier ${selectedTier}` : ""}
							{search.trim() ? ` • matching "${search}"` : ""} •{" "}
							{summary.totalMembers} total
						</p>
					</div>

					<div className="flex flex-wrap items-center gap-2.5">
						{/* Active Tier Chip */}
						{selectedTier && (
							<Badge
								variant="secondary"
								className="h-8 gap-1.5 px-2.5 text-xs font-mono cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors"
								onClick={() => setSelectedTier(null)}
							>
								Tier: {selectedTier}
								<X className="size-3" />
							</Badge>
						)}

						{/* Search Input */}
						<div className="relative w-full sm:w-64">
							<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
							<Input
								placeholder="Search nickname, Torn name, ID..."
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								className="pl-8 h-8 text-xs font-mono"
							/>
							{search && (
								<button
									type="button"
									onClick={() => setSearch("")}
									className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
								>
									<X className="size-3.5" />
								</button>
							)}
						</div>

						{/* Owner Action Controls (Role Select, Sync, and Reset/Prune Buttons) */}
						{isOwner && (
							<>
								<Select value={selectedRoleId} onValueChange={handleRoleChange}>
									<SelectTrigger className="w-44 h-8 text-xs font-mono">
										<SelectValue placeholder="All Server Members" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">All Server Members</SelectItem>
										{roles.map((r) => (
											<SelectItem key={r.id} value={r.id}>
												{r.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>

								{selectedRoleId !== "all" && (
									<Button
										variant={
											selectedRoleId === configuredTeamRoleId
												? "secondary"
												: "outline"
										}
										size="sm"
										onClick={handleSaveTeamRole}
										disabled={savingTeamRole}
										className="h-8 text-xs font-mono"
									>
										{selectedRoleId === configuredTeamRoleId
											? "Team Role (Auto-Sync)"
											: "Set as Team Role"}
									</Button>
								)}

								<Button
									onClick={() => handleGetMembersStats(false)}
									disabled={fetchingStats}
									size="sm"
									className="gap-1.5 h-8 text-xs font-mono"
								>
									<RefreshCw
										data-icon="inline-start"
										className={`size-3.5 ${fetchingStats ? "animate-spin" : ""}`}
									/>
									{hasMissingStats ? "Sync Missing Stats" : "Get Members Stats"}
								</Button>

								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsResetDialogOpen(true)}
									className="gap-1.5 h-8 text-xs font-mono text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
								>
									<Trash2 className="size-3.5" />
									{selectedRoleId !== "all"
										? "Reset to Role"
										: "Reset All Stats"}
								</Button>
							</>
						)}
					</div>
				</CardHeader>

				<CardContent className="p-0">
					{loading ? (
						<div className="flex flex-col gap-2 p-4">
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									{/* Name Column (Torn profile hyperlinked Name [ID]) - Sortable */}
									<TableHead
										onClick={() => handleSort("name")}
										className="font-mono text-xs cursor-pointer select-none hover:text-foreground min-w-48"
									>
										<div className="flex items-center gap-1">
											<span>Name</span>
											{renderSortIcon("name")}
										</div>
									</TableHead>

									{/* Level Column - Sortable */}
									<TableHead
										onClick={() => handleSort("level")}
										className="font-mono text-xs text-center cursor-pointer select-none hover:text-foreground w-20"
									>
										<div className="flex items-center justify-center gap-1">
											<span>Level</span>
											{renderSortIcon("level")}
										</div>
									</TableHead>

									{/* Estimated BS Column - Sortable */}
									<TableHead
										onClick={() => handleSort("bsEstimate")}
										className="font-mono text-xs cursor-pointer select-none hover:text-foreground min-w-36"
									>
										<div className="flex items-center gap-1">
											<span>Estimated BS</span>
											{renderSortIcon("bsEstimate")}
										</div>
									</TableHead>

									{/* Networth Column - Sortable */}
									<TableHead
										onClick={() => handleSort("networth")}
										className="font-mono text-xs cursor-pointer select-none hover:text-foreground min-w-32"
									>
										<div className="flex items-center gap-1">
											<span>Networth</span>
											{renderSortIcon("networth")}
										</div>
									</TableHead>

									{/* Score Column - Sortable */}
									<TableHead
										onClick={() => handleSort("score")}
										className="font-mono text-xs text-center cursor-pointer select-none hover:text-foreground min-w-28"
									>
										<div className="flex items-center justify-center gap-1">
											<span>Score</span>
											{renderSortIcon("score")}
										</div>
									</TableHead>

									{/* Attacks Column - Sortable */}
									<TableHead
										onClick={() => handleSort("attacks")}
										className="font-mono text-xs text-center cursor-pointer select-none hover:text-foreground min-w-28"
									>
										<div className="flex items-center justify-center gap-1">
											<span>Attacks</span>
											{renderSortIcon("attacks")}
										</div>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredAndSortedMembers.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={6}
											className="h-28 text-center text-xs font-mono text-muted-foreground"
										>
											{members.length === 0
												? "No member stats recorded yet. Click 'Get Members Stats' to begin."
												: "No members match the current search or tier filter."}
										</TableCell>
									</TableRow>
								) : (
									paginatedMembers.map((m) => {
										return (
											<TableRow key={m.id}>
												{/* Name with Torn profile hyperlink */}
												<TableCell className="font-mono text-xs">
													{m.tornId ? (
														<div className="flex flex-col">
															<a
																href={`https://www.torn.com/profiles.php?XID=${m.tornId}`}
																target="_blank"
																rel="noreferrer"
																className="text-primary font-medium hover:underline inline-flex items-center gap-1"
															>
																{m.tornName ?? "Unknown"} [{m.tornId}]
															</a>
															{m.discordNickname &&
																m.discordNickname !== m.tornName && (
																	<span className="text-[11px] text-muted-foreground">
																		{m.discordNickname}
																	</span>
																)}
														</div>
													) : (
														<div className="flex flex-col">
															<span className="text-muted-foreground">
																{m.discordNickname ?? m.discordId}
															</span>
															<Badge
																variant="outline"
																className="w-fit text-[9px] font-mono text-muted-foreground mt-0.5"
															>
																Unlinked
															</Badge>
														</div>
													)}
												</TableCell>

												{/* Level */}
												<TableCell className="text-center font-mono text-xs">
													{m.tornLevel ?? "-"}
												</TableCell>

												{/* Estimated BS */}
												<TableCell className="font-mono text-xs font-bold text-foreground">
													{m.bsEstimateHuman ??
														(m.bsEstimate
															? formatStatNumber(m.bsEstimate)
															: "-")}
												</TableCell>

												{/* Networth */}
												<TableCell className="font-mono text-xs font-semibold text-emerald-400">
													{typeof m.networth === "number" && m.networth > 0
														? formatCurrency(m.networth)
														: "-"}
												</TableCell>

												{/* Score */}
												<TableCell className="text-center font-mono text-xs font-semibold text-amber-400">
													{(m.score ?? 0).toLocaleString()}
												</TableCell>

												{/* Attacks */}
												<TableCell className="text-center font-mono text-xs font-medium text-foreground">
													{(m.attacks ?? 0).toLocaleString()}
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					)}

					{/* Pagination Controls Bar */}
					{filteredAndSortedMembers.length > 0 && (
						<div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-border/40 text-xs font-mono text-muted-foreground">
							<div>
								Showing {(currentPage - 1) * pageSize + 1} to{" "}
								{Math.min(
									currentPage * pageSize,
									filteredAndSortedMembers.length,
								)}{" "}
								of {filteredAndSortedMembers.length} member
								{filteredAndSortedMembers.length === 1 ? "" : "s"}
							</div>
							<div className="flex items-center gap-2">
								<div className="flex items-center gap-1.5 mr-2">
									<span className="text-[11px]">Rows:</span>
									<Select
										value={pageSize.toString()}
										onValueChange={(val) => {
											setPageSize(Number(val));
											setCurrentPage(1);
										}}
									>
										<SelectTrigger className="w-18 h-7 text-xs font-mono">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="25">25</SelectItem>
											<SelectItem value="50">50</SelectItem>
											<SelectItem value="100">100</SelectItem>
											<SelectItem value="200">200</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<Button
									variant="outline"
									size="sm"
									className="h-7 px-2 text-xs gap-1 font-mono"
									onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
									disabled={currentPage <= 1}
								>
									<ChevronLeft className="size-3.5" />
									Prev
								</Button>
								<span className="px-2 text-foreground font-semibold">
									Page {currentPage} of {totalPages}
								</span>
								<Button
									variant="outline"
									size="sm"
									className="h-7 px-2 text-xs gap-1 font-mono"
									onClick={() =>
										setCurrentPage((p) => Math.min(totalPages, p + 1))
									}
									disabled={currentPage >= totalPages}
								>
									Next
									<ChevronRight className="size-3.5" />
								</Button>
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Reset / Prune Members Confirmation Dialog */}
			<AlertDialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{selectedRoleId !== "all" && selectedRoleName
								? `Reset Members to "${selectedRoleName}"?`
								: "Reset All Member Stats?"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{selectedRoleId !== "all" && selectedRoleName
								? `This will remove all synced member stats records for users who do NOT have the "${selectedRoleName}" role. Only members possessing this role will be kept.`
								: "This will remove all synced member battle stats for this tournament guild. You will need to sync them again."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={resettingMembers}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								handleResetMembers();
							}}
							disabled={resettingMembers}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
						>
							{resettingMembers ? (
								<RefreshCw className="size-3.5 animate-spin" />
							) : (
								<Trash2 className="size-3.5" />
							)}
							{selectedRoleId !== "all"
								? "Remove Members Without Role"
								: "Reset All Members"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Stat Distribution Auto-Assign Roles Dialog */}
			<Dialog
				open={isStatRolesDialogOpen}
				onOpenChange={setIsStatRolesDialogOpen}
			>
				<DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<ShieldCheck className="size-5 text-primary" />
							Auto-Assign Discord Roles by Stat Tier
						</DialogTitle>
						<DialogDescription>
							Map each battle stat tier to a Discord role. When saved, the bot
							will automatically assign each member their corresponding tier
							role and remove obsolete tier roles.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-2.5 py-3">
						{STAT_BUCKETS.map((bucket) => {
							const currentRoleId = statRoleMappings[bucket.label] || "none";
							return (
								<div
									key={bucket.label}
									className="flex items-center justify-between p-2.5 rounded-md border border-border/50 bg-card/50"
								>
									<div className="flex items-center gap-2.5">
										<div
											className="size-3 rounded-full shrink-0"
											style={{ backgroundColor: bucket.color }}
										/>
										<div className="font-mono text-xs font-semibold">
											{bucket.label}
										</div>
									</div>

									<Select
										value={currentRoleId}
										onValueChange={(val) => {
											setStatRoleMappings((prev) => {
												const next = { ...prev };
												if (val === "none") {
													delete next[bucket.label];
												} else {
													next[bucket.label] = val;
												}
												return next;
											});
										}}
									>
										<SelectTrigger className="w-56 h-8 text-xs font-mono">
											<SelectValue placeholder="Select role..." />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">
												<span className="text-muted-foreground italic">
													None (Don't assign)
												</span>
											</SelectItem>
											{roles.map((r) => (
												<SelectItem key={r.id} value={r.id}>
													{r.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							);
						})}
					</div>

					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							variant="outline"
							onClick={() => setIsStatRolesDialogOpen(false)}
							disabled={savingStatRoles}
						>
							Cancel
						</Button>
						<Button
							onClick={handleSaveAndAssignStatRoles}
							disabled={savingStatRoles}
							className="gap-2 font-mono"
						>
							{savingStatRoles ? (
								<RefreshCw className="size-3.5 animate-spin" />
							) : (
								<ShieldCheck className="size-3.5" />
							)}
							Save & Assign Roles
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
