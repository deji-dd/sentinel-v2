import {
	AlertCircle,
	ArrowRight,
	Check,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	Clock,
	Copy,
	ExternalLink,
	Filter,
	History,
	RefreshCw,
	Search,
	ShieldAlert,
	User,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
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
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface Role {
	id: string;
	name: string;
	color: number;
}

interface VerificationLogItem {
	id: string;
	guildId: string;
	discordId: string;
	status: string;
	triggeredBy: string;
	rolesAdded: string[];
	rolesRemoved: string[];
	oldNickname: string | null;
	newNickname: string | null;
	error: string | null;
	createdAt: string | Date;
	tornId: number | null;
	tornName: string | null;
	factionTag: string | null;
}

interface VerificationLogsHistoryProps {
	guildId: string;
	roles: Role[];
}

function roleColor(color: number): string {
	if (!color) return "#64748b";
	return `#${color.toString(16).padStart(6, "0")}`;
}

function formatTimestamp(dateValue: string | Date): {
	relative: string;
	full: string;
} {
	const date = new Date(dateValue);
	if (Number.isNaN(date.getTime())) {
		return { relative: "Unknown", full: "Unknown date" };
	}

	const now = new Date();
	const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

	let relative: string;
	if (diffSec < 60) {
		relative = "just now";
	} else if (diffSec < 3600) {
		const mins = Math.max(1, Math.floor(diffSec / 60));
		relative = `${mins}m ago`;
	} else if (diffSec < 86400) {
		const hrs = Math.floor(diffSec / 3600);
		relative = `${hrs}h ago`;
	} else if (diffSec < 604800) {
		const days = Math.floor(diffSec / 86400);
		relative = `${days}d ago`;
	} else {
		relative = date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	}

	const full = date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

	return { relative, full };
}

export default function VerificationLogsHistory({
	guildId,
	roles,
}: VerificationLogsHistoryProps) {
	const { toast } = useToast();

	const [logs, setLogs] = useState<VerificationLogItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);

	// Filter states
	const [searchInput, setSearchInput] = useState("");
	const [activeSearch, setActiveSearch] = useState("");
	const [statusFilter, setStatusFilter] = useState("all");
	const [triggerFilter, setTriggerFilter] = useState("all");

	// Pagination states
	const [currentPage, setCurrentPage] = useState(1);
	const [totalPages, setTotalPages] = useState(1);
	const [totalCount, setTotalCount] = useState(0);
	const limit = 15;

	// Cached copy feedback
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const handleCopy = (text: string) => {
		navigator.clipboard.writeText(text);
		setCopiedId(text);
		toast(`Copied ${text} to clipboard.`, "info");
		setTimeout(() => setCopiedId(null), 2000);
	};

	const fetchLogs = useCallback(
		async (silent = false) => {
			if (!silent) setLoading(true);
			setIsRefreshing(true);
			try {
				const guildRoute = api.api.v1.guilds({ guildId });
				if (!guildRoute) return;

				const res = await guildRoute["verification-logs"].get({
					query: {
						page: String(currentPage),
						limit: String(limit),
						status: statusFilter === "all" ? undefined : statusFilter,
						trigger: triggerFilter === "all" ? undefined : triggerFilter,
						search: activeSearch.trim() ? activeSearch.trim() : undefined,
					},
				});

				if (res.data) {
					const data = res.data;
					setLogs((data.logs ?? []) as VerificationLogItem[]);
					if (data.pagination) {
						setTotalPages(data.pagination.totalPages || 1);
						setTotalCount(data.pagination.total || 0);
					}
				}
			} catch {
				toast("Failed to load verification logs.", "error");
			} finally {
				setLoading(false);
				setIsRefreshing(false);
			}
		},
		[guildId, currentPage, statusFilter, triggerFilter, activeSearch, toast],
	);

	useEffect(() => {
		void fetchLogs();
	}, [fetchLogs]);

	const handleSearchSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setCurrentPage(1);
		setActiveSearch(searchInput);
	};

	const handleClearSearch = () => {
		setSearchInput("");
		setActiveSearch("");
		setCurrentPage(1);
	};

	const getRoleMeta = (roleId: string) => {
		const r = roles.find((role) => role.id === roleId);
		return {
			name: r ? `@${r.name}` : `@${roleId}`,
			color: r ? roleColor(r.color) : "#64748b",
		};
	};

	const renderTriggerBadge = (trigger: string) => {
		switch (trigger) {
			case "cron":
				return (
					<Badge
						variant="outline"
						className="border-blue-500/30 bg-blue-500/10 text-blue-400 text-[10px] font-mono px-2 py-0.5 rounded-md"
					>
						Cron Sweep
					</Badge>
				);
			case "admin":
				return (
					<Badge
						variant="outline"
						className="border-purple-500/30 bg-purple-500/10 text-purple-300 text-[10px] font-mono px-2 py-0.5 rounded-md"
					>
						Admin Bulk
					</Badge>
				);
			case "join":
				return (
					<Badge
						variant="outline"
						className="border-amber-500/30 bg-amber-500/10 text-amber-300 text-[10px] font-mono px-2 py-0.5 rounded-md"
					>
						Join Event
					</Badge>
				);
			default:
				return (
					<Badge
						variant="outline"
						className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[10px] font-mono px-2 py-0.5 rounded-md"
					>
						User Command
					</Badge>
				);
		}
	};

	return (
		<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
			<CardHeader className="border-b border-border/40 pb-4">
				<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<div className="size-9 rounded-xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center shrink-0">
							<History className="size-4.5" />
						</div>
						<div>
							<div className="flex items-center gap-2 flex-wrap">
								<CardTitle className="text-lg font-semibold tracking-tight">
									Verification Logs History
								</CardTitle>
								<Badge
									variant="secondary"
									className="text-xs font-mono font-medium px-2 py-0.5 rounded-full"
								>
									{totalCount.toLocaleString()}{" "}
									{totalCount === 1 ? "log" : "logs"}
								</Badge>
							</div>
							<p className="text-xs text-muted-foreground mt-0.5">
								Audit trail of member verification sweeps, role changes, and
								nickname updates.
							</p>
						</div>
					</div>

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void fetchLogs(true)}
						disabled={isRefreshing}
						className="h-9 px-3 rounded-xl text-xs font-semibold gap-1.5 cursor-pointer shrink-0 self-start sm:self-center"
					>
						<RefreshCw
							className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
							data-icon="inline-start"
						/>
						Refresh Logs
					</Button>
				</div>
			</CardHeader>

			<CardContent className="space-y-4 pt-4">
				{/* Filter & Search Bar */}
				<div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
					{/* Search Form */}
					<form
						onSubmit={handleSearchSubmit}
						className="flex items-center gap-2 flex-1 max-w-md relative"
					>
						<div className="relative flex-1">
							<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
							<Input
								type="text"
								value={searchInput}
								onChange={(e) => setSearchInput(e.target.value)}
								placeholder="Search Discord ID, Torn Name..."
								className="h-9 pl-8.5 pr-8 text-xs font-sans rounded-xl bg-background border-input"
							/>
							{searchInput && (
								<button
									type="button"
									onClick={handleClearSearch}
									className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground hover:text-foreground flex items-center justify-center cursor-pointer"
								>
									<X className="size-3" />
								</button>
							)}
						</div>
						<Button
							type="submit"
							variant="secondary"
							size="sm"
							className="h-9 px-3 text-xs font-semibold rounded-xl cursor-pointer shrink-0"
						>
							Search
						</Button>
					</form>

					{/* Filters */}
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
							<Filter className="size-3.5" />
							<span>Filters:</span>
						</div>

						{/* Status Filter */}
						<Select
							value={statusFilter}
							onValueChange={(val) => {
								setStatusFilter(val);
								setCurrentPage(1);
							}}
						>
							<SelectTrigger className="h-9 w-[130px] rounded-xl text-xs bg-background border-input">
								<SelectValue placeholder="Status" />
							</SelectTrigger>
							<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground">
								<SelectGroup>
									<SelectItem value="all">All Statuses</SelectItem>
									<SelectItem value="success">Success</SelectItem>
									<SelectItem value="failure">Failure</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>

						{/* Trigger Filter */}
						<Select
							value={triggerFilter}
							onValueChange={(val) => {
								setTriggerFilter(val);
								setCurrentPage(1);
							}}
						>
							<SelectTrigger className="h-9 w-[150px] rounded-xl text-xs bg-background border-input">
								<SelectValue placeholder="Trigger" />
							</SelectTrigger>
							<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground">
								<SelectGroup>
									<SelectItem value="all">All Triggers</SelectItem>
									<SelectItem value="cron">Cron Sweep</SelectItem>
									<SelectItem value="admin">Admin Bulk</SelectItem>
									<SelectItem value="user">User Command</SelectItem>
									<SelectItem value="join">Join Event</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
				</div>

				{/* Table */}
				<div className="rounded-xl border border-border/60 overflow-hidden bg-background/50">
					<Table>
						<TableHeader>
							<TableRow className="border-b border-border/60 bg-muted/40 hover:bg-muted/40">
								<TableHead className="w-[140px] text-xs font-semibold text-muted-foreground">
									Timestamp
								</TableHead>
								<TableHead className="w-[180px] text-xs font-semibold text-muted-foreground">
									Member
								</TableHead>
								<TableHead className="w-[110px] text-xs font-semibold text-muted-foreground">
									Trigger
								</TableHead>
								<TableHead className="w-[100px] text-xs font-semibold text-muted-foreground">
									Status
								</TableHead>
								<TableHead className="text-xs font-semibold text-muted-foreground">
									Actions & Changes
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{loading ? (
								Array.from({ length: 5 }).map((_, i) => (
									<TableRow
										key={`skeleton-log-${i}`}
										className="border-b border-border/40"
									>
										<TableCell>
											<Skeleton className="h-4 w-20 mb-1" />
											<Skeleton className="h-3 w-16" />
										</TableCell>
										<TableCell>
											<Skeleton className="h-4 w-24 mb-1" />
											<Skeleton className="h-3 w-28" />
										</TableCell>
										<TableCell>
											<Skeleton className="h-5 w-16 rounded-md" />
										</TableCell>
										<TableCell>
											<Skeleton className="h-5 w-14 rounded-md" />
										</TableCell>
										<TableCell>
											<Skeleton className="h-4 w-48" />
										</TableCell>
									</TableRow>
								))
							) : logs.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={5}
										className="h-48 text-center text-muted-foreground"
									>
										<div className="flex flex-col items-center justify-center gap-2">
											<History className="size-8 text-muted-foreground/40 stroke-1" />
											<p className="text-sm font-medium text-foreground">
												No verification logs found
											</p>
											<p className="text-xs text-muted-foreground max-w-sm">
												{activeSearch ||
												statusFilter !== "all" ||
												triggerFilter !== "all"
													? "No logs matched the selected filters. Try clearing your search or filter parameters."
													: "Verification events triggered by user slash commands, member joins, or scheduled cron sweeps will appear here."}
											</p>
										</div>
									</TableCell>
								</TableRow>
							) : (
								logs.map((log) => {
									const { relative, full } = formatTimestamp(log.createdAt);
									const hasRolesAdded =
										log.rolesAdded && log.rolesAdded.length > 0;
									const hasRolesRemoved =
										log.rolesRemoved && log.rolesRemoved.length > 0;
									const hasNicknameChange = Boolean(log.newNickname);
									const isFailed = log.status === "failure";

									return (
										<TableRow
											key={log.id}
											className="border-b border-border/40 hover:bg-muted/30 transition-colors"
										>
											{/* Timestamp */}
											<TableCell className="align-top py-3">
												<div
													className="space-y-0.5 cursor-default"
													title={full}
												>
													<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
														<Clock className="size-3 text-muted-foreground shrink-0" />
														<span>{relative}</span>
													</div>
													<div className="text-[10px] text-muted-foreground font-mono">
														{full.split(",")[1]?.trim() ?? full}
													</div>
												</div>
											</TableCell>

											{/* Member Identity */}
											<TableCell className="align-top py-3">
												<div className="space-y-1">
													{log.tornName ? (
														<div className="flex items-center gap-1.5 flex-wrap">
															{log.factionTag && (
																<span className="text-[10px] font-mono text-muted-foreground font-semibold">
																	[{log.factionTag}]
																</span>
															)}
															<span className="text-xs font-semibold text-foreground">
																{log.tornName}
															</span>
															{log.tornId && (
																<a
																	href={`https://www.torn.com/profiles.php?XID=${log.tornId}`}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="inline-flex items-center gap-0.5 text-[10px] font-mono text-primary hover:underline"
																	title={`View Torn Profile #${log.tornId}`}
																>
																	[{log.tornId}]
																	<ExternalLink className="size-2.5" />
																</a>
															)}
														</div>
													) : (
														<div className="flex items-center gap-1 text-xs text-muted-foreground">
															<User className="size-3" />
															<span>Unlinked / Unknown</span>
														</div>
													)}

													{/* Discord ID with copy */}
													<button
														type="button"
														onClick={() => handleCopy(log.discordId)}
														className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground bg-muted/50 px-1.5 py-0.5 rounded cursor-pointer transition-colors"
														title="Click to copy Discord ID"
													>
														<span>{log.discordId}</span>
														{copiedId === log.discordId ? (
															<Check className="size-2.5 text-emerald-400" />
														) : (
															<Copy className="size-2.5 opacity-60" />
														)}
													</button>
												</div>
											</TableCell>

											{/* Trigger */}
											<TableCell className="align-top py-3">
												{renderTriggerBadge(log.triggeredBy)}
											</TableCell>

											{/* Status */}
											<TableCell className="align-top py-3">
												{isFailed ? (
													<Badge
														variant="outline"
														className="border-rose-500/30 bg-rose-500/10 text-rose-400 text-[10px] font-mono px-2 py-0.5 rounded-md flex items-center gap-1 w-fit"
													>
														<AlertCircle className="size-2.5" />
														Failed
													</Badge>
												) : (
													<Badge
														variant="outline"
														className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-[10px] font-mono px-2 py-0.5 rounded-md flex items-center gap-1 w-fit"
													>
														<CheckCircle2 className="size-2.5" />
														Success
													</Badge>
												)}
											</TableCell>

											{/* Actions & Details */}
											<TableCell className="align-top py-3">
												{isFailed ? (
													<div className="flex items-start gap-1.5 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2 rounded-lg max-w-md">
														<ShieldAlert className="size-3.5 shrink-0 mt-0.5" />
														<span className="break-words font-mono text-[11px]">
															{log.error ||
																"Verification failed without specific error message."}
														</span>
													</div>
												) : (
													<div className="space-y-1.5 text-xs">
														{/* Roles Added */}
														{hasRolesAdded && (
															<div className="flex items-center gap-1.5 flex-wrap">
																<span className="text-[10px] uppercase font-mono font-semibold text-emerald-400">
																	Added:
																</span>
																{log.rolesAdded.map((roleId) => {
																	const meta = getRoleMeta(roleId);
																	return (
																		<Badge
																			key={`added-${roleId}`}
																			variant="outline"
																			className="text-[10px] font-mono px-1.5 py-0 rounded border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
																		>
																			{meta.name}
																		</Badge>
																	);
																})}
															</div>
														)}

														{/* Roles Removed */}
														{hasRolesRemoved && (
															<div className="flex items-center gap-1.5 flex-wrap">
																<span className="text-[10px] uppercase font-mono font-semibold text-rose-400">
																	Removed:
																</span>
																{log.rolesRemoved.map((roleId) => {
																	const meta = getRoleMeta(roleId);
																	return (
																		<Badge
																			key={`removed-${roleId}`}
																			variant="outline"
																			className="text-[10px] font-mono px-1.5 py-0 rounded border-rose-500/30 bg-rose-500/10 text-rose-300 line-through"
																		>
																			{meta.name}
																		</Badge>
																	);
																})}
															</div>
														)}

														{/* Nickname Changed */}
														{hasNicknameChange && (
															<div className="flex items-center gap-1.5 flex-wrap text-[11px]">
																<span className="text-[10px] uppercase font-mono font-semibold text-blue-400">
																	Nickname:
																</span>
																{log.oldNickname && (
																	<span className="text-muted-foreground line-through font-mono">
																		{log.oldNickname}
																	</span>
																)}
																<ArrowRight className="size-2.5 text-muted-foreground" />
																<span className="text-foreground font-mono font-medium">
																	{log.newNickname}
																</span>
															</div>
														)}

														{/* No diffs required */}
														{!hasRolesAdded &&
															!hasRolesRemoved &&
															!hasNicknameChange && (
																<span className="text-muted-foreground text-[11px] italic">
																	No changes required (already up to date)
																</span>
															)}
													</div>
												)}
											</TableCell>
										</TableRow>
									);
								})
							)}
						</TableBody>
					</Table>
				</div>

				{/* Pagination Controls */}
				<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
					<div className="text-xs text-muted-foreground font-mono">
						Showing page{" "}
						<span className="font-semibold text-foreground">{currentPage}</span>{" "}
						of{" "}
						<span className="font-semibold text-foreground">{totalPages}</span>{" "}
						({totalCount} total events)
					</div>

					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
							disabled={currentPage <= 1 || loading}
							className="h-8 px-3 rounded-lg text-xs font-semibold cursor-pointer gap-1"
						>
							<ChevronLeft className="size-3.5" data-icon="inline-start" />
							Previous
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
							disabled={currentPage >= totalPages || loading}
							className="h-8 px-3 rounded-lg text-xs font-semibold cursor-pointer gap-1"
						>
							Next
							<ChevronRight className="size-3.5" data-icon="inline-end" />
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
