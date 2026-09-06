import {
	ExternalLink,
	Hash,
	Loader2,
	RefreshCw,
	Save,
	Search,
	User,
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
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTctTimestamp } from "@/lib/utils";
import { useElims } from "../contexts/ElimsContext";

interface DiscordChannel {
	id: string;
	name: string;
	type: number;
	position: number;
}

interface GuildMemberSummary {
	id: string;
	username: string;
	displayName: string;
	roles: string[];
	avatar: string | null;
}

interface GiveawayWinner {
	discordUserId: string;
	discordUsername: string;
	tornId?: number | null;
	tornName?: string | null;
	selectedAt: string;
}

interface GiveawayItem {
	id: string;
	guildId: string;
	channelId: string;
	messageId: string;
	createdByDiscordId: string;
	createdByUsername: string;
	itemId: string;
	itemName: string;
	itemCategory: string;
	itemCount: number;
	winnerCount: number;
	durationStr: string;
	status: "active" | "ended" | "cancelled";
	endsAt: string;
	winners: GiveawayWinner[];
	entriesCount: number;
	createdAt: string;
}

interface GiveawayConfig {
	announcementChannelId: string | null;
	managerChannelId: string | null;
	managerRoleIds: string[];
	blacklistedUserIds?: string[];
}

export function GiveawaysPage() {
	const { guild } = useElims();

	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [loadingChannels, setLoadingChannels] = useState(false);

	const [config, setConfig] = useState<GiveawayConfig>({
		announcementChannelId: null,
		managerChannelId: null,
		managerRoleIds: [],
		blacklistedUserIds: [],
	});
	const [loadingConfig, setLoadingConfig] = useState(false);
	const [savingConfig, setSavingConfig] = useState(false);

	const [giveaways, setGiveaways] = useState<GiveawayItem[]>([]);
	const [loadingGiveaways, setLoadingGiveaways] = useState(false);
	const [activeTab, setActiveTab] = useState<string>("all");
	const [cancellingId, setCancellingId] = useState<string | null>(null);

	const [guildMembers, setGuildMembers] = useState<GuildMemberSummary[]>([]);
	const [blacklistedUserIds, setBlacklistedUserIds] = useState<string[]>([]);
	const [memberSearchQuery, setMemberSearchQuery] = useState("");
	const [isMemberDropdownOpen, setIsMemberDropdownOpen] = useState(false);
	const memberSearchRef = useRef<HTMLDivElement>(null);

	// Fetch Channels
	const fetchChannels = useCallback(async () => {
		if (!guild?.id) return;
		setLoadingChannels(true);
		try {
			const res = await fetch(`/api/v1/elims/guild-channels/${guild.id}`);
			if (!res.ok) throw new Error("Failed to load guild channels");
			const data = (await res.json()) as { channels?: DiscordChannel[] };
			if (data.channels && Array.isArray(data.channels)) {
				// Filter to guild text channels (type 0)
				const textChannels = data.channels.filter((ch) => ch.type === 0);
				setChannels(textChannels);
			}
		} catch (err) {
			console.error("Failed to load channels:", err);
		} finally {
			setLoadingChannels(false);
		}
	}, [guild?.id]);

	// Fetch Guild Members
	const fetchGuildMembers = useCallback(async () => {
		if (!guild?.id) return;
		try {
			const res = await fetch(`/api/v1/elims/guild-members/${guild.id}`);
			if (!res.ok) return;
			const data = (await res.json()) as { members?: GuildMemberSummary[] };
			if (data.members && Array.isArray(data.members)) {
				setGuildMembers(data.members);
			}
		} catch (err) {
			console.error("Failed to load guild members:", err);
		}
	}, [guild?.id]);

	// Fetch Giveaway Config
	const fetchConfig = useCallback(async () => {
		setLoadingConfig(true);
		try {
			const res = await fetch("/api/v1/elims/giveaways/config");
			if (!res.ok) throw new Error("Failed to load giveaway configuration");
			const data = (await res.json()) as { config?: GiveawayConfig };
			if (data.config) {
				setConfig({
					announcementChannelId: data.config.announcementChannelId ?? null,
					managerChannelId: data.config.managerChannelId ?? null,
					managerRoleIds: data.config.managerRoleIds ?? [],
					blacklistedUserIds: data.config.blacklistedUserIds ?? [],
				});
				setBlacklistedUserIds(data.config.blacklistedUserIds ?? []);
			}
		} catch (err) {
			console.error("Failed to load giveaway config:", err);
		} finally {
			setLoadingConfig(false);
		}
	}, []);

	// Fetch Giveaways List
	const fetchGiveaways = useCallback(async () => {
		setLoadingGiveaways(true);
		try {
			const res = await fetch(
				`/api/v1/elims/giveaways?status=${activeTab}&limit=50`,
			);
			if (!res.ok) throw new Error("Failed to load giveaways");
			const data = (await res.json()) as { giveaways?: GiveawayItem[] };
			if (data.giveaways && Array.isArray(data.giveaways)) {
				setGiveaways(data.giveaways);
			}
		} catch (err) {
			console.error("Failed to load giveaways:", err);
		} finally {
			setLoadingGiveaways(false);
		}
	}, [activeTab]);

	useEffect(() => {
		void fetchChannels();
		void fetchConfig();
		void fetchGuildMembers();
	}, [fetchChannels, fetchConfig, fetchGuildMembers]);

	useEffect(() => {
		void fetchGiveaways();
	}, [fetchGiveaways]);

	const memberMap = useMemo(() => {
		const map = new Map<string, GuildMemberSummary>();
		for (const m of guildMembers) {
			map.set(m.id, m);
		}
		return map;
	}, [guildMembers]);

	const renderUserLink = (
		discordUserId: string,
		fallbackUsername: string,
		tornIdOverride?: number | null,
		tornNameOverride?: string | null,
		textSizeClass = "text-xs",
	) => {
		const member = memberMap.get(discordUserId);
		const nickMatch = member?.displayName?.match(
			/^(?:\[[^\]]*\]\s*)?(.+?)\s*\[(\d+)\]$/,
		);
		const effectiveTornId =
			tornIdOverride ?? (nickMatch?.[2] ? Number(nickMatch[2]) : null);
		const effectiveTornName =
			tornNameOverride ??
			(nickMatch?.[1]
				? nickMatch[1].trim()
				: (member?.displayName ?? fallbackUsername));

		if (effectiveTornId) {
			return (
				<a
					href={`https://www.torn.com/profiles.php?XID=${effectiveTornId}`}
					target="_blank"
					rel="noopener noreferrer"
					className={`${textSizeClass} font-semibold text-primary hover:underline inline-flex items-center gap-1`}
					title={`View Torn Profile for ${effectiveTornName} [${effectiveTornId}]`}
				>
					<span>
						{effectiveTornName} [{effectiveTornId}]
					</span>
					<ExternalLink className="size-3 opacity-70 shrink-0" />
				</a>
			);
		}

		return (
			<span className={`${textSizeClass} text-muted-foreground font-mono`}>
				{member?.displayName || fallbackUsername}
			</span>
		);
	};

	// Click outside listener for member dropdown
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

	const filteredMembers = useMemo(() => {
		if (!memberSearchQuery.trim()) {
			return guildMembers.slice(0, 30);
		}
		const q = memberSearchQuery.toLowerCase().trim();
		return guildMembers
			.filter(
				(m) =>
					m.displayName.toLowerCase().includes(q) ||
					m.username.toLowerCase().includes(q) ||
					m.id.includes(q),
			)
			.slice(0, 30);
	}, [guildMembers, memberSearchQuery]);

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

	const handleSaveConfig = async () => {
		setSavingConfig(true);

		try {
			const res = await fetch("/api/v1/elims/giveaways/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...config,
					blacklistedUserIds,
				}),
			});

			if (!res.ok) {
				const errorData = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(errorData.error ?? "Failed to save configuration");
			}

			toast.success("Giveaway settings updated successfully.");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save configuration.",
			);
		} finally {
			setSavingConfig(false);
		}
	};

	const handleCancelGiveaway = async (id: string) => {
		if (
			!window.confirm(
				"Are you sure you want to cancel this giveaway? No winners will be selected.",
			)
		) {
			return;
		}

		setCancellingId(id);
		try {
			const res = await fetch(`/api/v1/elims/giveaways/${id}/cancel`, {
				method: "POST",
			});
			if (!res.ok) {
				const errorData = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(errorData.error ?? "Failed to cancel giveaway");
			}
			toast.success("Giveaway cancelled successfully.");
			await fetchGiveaways();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to cancel giveaway.",
			);
		} finally {
			setCancellingId(null);
		}
	};

	return (
		<div className="flex-1 space-y-6 p-6 max-w-7xl mx-auto">
			{/* Page Header */}
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h1 className="text-2xl font-bold font-sans tracking-tight text-foreground flex items-center gap-2.5">
						Giveaways
					</h1>
				</div>
				<div className="flex items-center gap-2 self-start sm:self-auto">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void fetchChannels();
							void fetchConfig();
							void fetchGiveaways();
						}}
						disabled={loadingChannels || loadingConfig || loadingGiveaways}
						className="h-9 gap-1.5 cursor-pointer"
					>
						<RefreshCw
							className={`size-3.5 ${
								loadingChannels || loadingConfig || loadingGiveaways
									? "animate-spin"
									: ""
							}`}
						/>
						Refresh
					</Button>
					<Button
						variant="default"
						size="sm"
						onClick={() => void handleSaveConfig()}
						disabled={savingConfig || loadingConfig || loadingChannels}
						className="h-9 gap-1.5 font-medium cursor-pointer"
					>
						{savingConfig ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Save className="size-3.5" />
						)}
						Save Settings
					</Button>
				</div>
			</div>

			{/* Section 1: Configuration Grid (Channels & Blacklist) */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Section 1a: Channel Configuration */}
				<Card className="border-border shadow-xs bg-card">
					<CardHeader className="pb-4">
						<CardTitle className="text-base font-semibold">
							Giveaway Channels
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-4">
							{/* Announcement Channel */}
							<div className="space-y-1.5">
								<label
									htmlFor="announcement-channel"
									className="text-xs font-medium text-foreground flex items-center gap-1.5"
								>
									<Hash className="size-3.5 text-muted-foreground" />
									Announcement Channel (Public)
								</label>
								<Select
									value={config.announcementChannelId ?? "none"}
									onValueChange={(val) =>
										setConfig((prev) => ({
											...prev,
											announcementChannelId: val === "none" ? null : val,
										}))
									}
									disabled={loadingChannels || loadingConfig}
								>
									<SelectTrigger
										id="announcement-channel"
										className="h-9 w-full"
									>
										<SelectValue placeholder="Select announcement channel..." />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">
											<span className="text-muted-foreground">
												None (Disabled)
											</span>
										</SelectItem>
										{channels.map((ch) => (
											<SelectItem key={ch.id} value={ch.id}>
												#{ch.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-[11px] text-muted-foreground">
									The channel where the bot publishes active giveaways and
									member entry buttons.
								</p>
							</div>

							{/* Manager Channel */}
							<div className="space-y-1.5">
								<label
									htmlFor="manager-channel"
									className="text-xs font-medium text-foreground flex items-center gap-1.5"
								>
									<Hash className="size-3.5 text-muted-foreground" />
									Management Channel
								</label>
								<Select
									value={config.managerChannelId ?? "none"}
									onValueChange={(val) =>
										setConfig((prev) => ({
											...prev,
											managerChannelId: val === "none" ? null : val,
										}))
									}
									disabled={loadingChannels || loadingConfig}
								>
									<SelectTrigger id="manager-channel" className="h-9 w-full">
										<SelectValue placeholder="Select control panel channel..." />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">
											<span className="text-muted-foreground">
												Same as announcement channel
											</span>
										</SelectItem>
										{channels.map((ch) => (
											<SelectItem key={ch.id} value={ch.id}>
												#{ch.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-[11px] text-muted-foreground">
									Channel where the bot maintains the persistent "Create
									Giveaway" button.
								</p>
							</div>
						</div>
					</CardContent>
				</Card>

				{/* Section 1b: Member Blacklist */}
				<Card className="border-border shadow-xs bg-card">
					<CardHeader className="pb-4">
						<div className="flex items-center justify-between">
							<CardTitle className="text-base font-semibold flex items-center gap-2">
								<span>Member Blacklist</span>
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
						<p className="text-[11px] text-muted-foreground">
							Search and select server members to block from creating giveaways.
						</p>

						{/* Member Search Bar & Dropdown */}
						<div ref={memberSearchRef} className="relative">
							<div className="flex items-center gap-2">
								<div className="relative flex-1">
									<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
									<Input
										type="text"
										placeholder="Search member by name, username, or ID..."
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
													handleSelectMemberToBlacklist(filteredMembers[0]);
												} else {
													handleAddBlacklist();
												}
											}
										}}
										className="pl-8 text-xs font-mono"
									/>
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
									</div>

									{filteredMembers.length === 0 ? (
										<div className="p-3 text-center text-xs text-muted-foreground">
											{memberSearchQuery.trim()
												? "No matching server members found. Click 'Block' to block this raw ID."
												: "No server members loaded."}
										</div>
									) : (
										filteredMembers.map((member) => {
											const isBlocked = blacklistedUserIds.includes(member.id);
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

						{/* Blocked Members List */}
						{blacklistedUserIds.length > 0 ? (
							<div className="flex flex-wrap gap-1.5 pt-1 max-h-40 overflow-y-auto">
								{blacklistedUserIds.map((userId) => {
									const member = guildMembers.find((m) => m.id === userId);
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
												{member?.displayName ?? member?.username ?? userId}
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
						) : (
							<p className="text-xs text-muted-foreground italic">
								No members are currently blacklisted. All server members can
								create giveaways.
							</p>
						)}
					</CardContent>
				</Card>
			</div>

			{/* Section 2: Giveaway History */}
			<Card className="border-border shadow-xs bg-card">
				<CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
					<div>
						<CardTitle className="text-base font-semibold">
							Giveaway History
						</CardTitle>
						<CardDescription className="text-xs">
							View active, ended, and cancelled giveaways.
						</CardDescription>
					</div>
					<Tabs
						value={activeTab}
						onValueChange={setActiveTab}
						className="w-auto"
					>
						<TabsList className="h-8">
							<TabsTrigger value="all" className="text-xs px-2.5">
								All
							</TabsTrigger>
							<TabsTrigger value="active" className="text-xs px-2.5">
								Active
							</TabsTrigger>
							<TabsTrigger value="ended" className="text-xs px-2.5">
								Ended
							</TabsTrigger>
							<TabsTrigger value="cancelled" className="text-xs px-2.5">
								Cancelled
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</CardHeader>
				<CardContent className="p-0">
					{loadingGiveaways ? (
						<div className="py-16 flex flex-col items-center justify-center gap-2 text-muted-foreground">
							<Loader2 className="size-6 animate-spin text-primary" />
							<p className="text-xs">Loading giveaway records...</p>
						</div>
					) : giveaways.length === 0 ? (
						<div className="py-16 text-center text-muted-foreground text-xs">
							No giveaways found matching the selected filter.
						</div>
					) : (
						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										<TableHead className="w-[200px] text-xs">Item</TableHead>
										<TableHead className="text-xs">Category</TableHead>
										<TableHead className="text-xs">Winners Target</TableHead>
										<TableHead className="text-xs">Entries</TableHead>
										<TableHead className="text-xs">Status</TableHead>
										<TableHead className="text-xs">Ends / Ended</TableHead>
										<TableHead className="text-xs">Winner(s)</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{giveaways.map((gw) => {
										const isEnded = gw.status === "ended";
										const isActive = gw.status === "active";
										const isCancelled = gw.status === "cancelled";

										return (
											<TableRow key={gw.id} className="text-xs">
												<TableCell className="font-medium">
													<div className="flex flex-col gap-0.5">
														<span className="font-semibold text-foreground">
															{gw.itemCount}x {gw.itemName}
														</span>
														<div className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
															<span>By</span>
															{renderUserLink(
																gw.createdByDiscordId,
																gw.createdByUsername,
																null,
																null,
																"text-[11px]",
															)}
														</div>
													</div>
												</TableCell>
												<TableCell>
													<Badge
														variant="outline"
														className="text-[10px] font-normal"
													>
														{gw.itemCategory}
													</Badge>
												</TableCell>
												<TableCell>{gw.winnerCount}</TableCell>
												<TableCell>
													<Badge
														variant="secondary"
														className="text-[11px] font-mono"
													>
														{gw.entriesCount}
													</Badge>
												</TableCell>
												<TableCell>
													{isActive && (
														<Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30 text-[10px] gap-1 font-normal">
															<span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
															Active
														</Badge>
													)}
													{isEnded && (
														<Badge
															variant="secondary"
															className="text-[10px] font-normal"
														>
															Ended
														</Badge>
													)}
													{isCancelled && (
														<Badge
															variant="destructive"
															className="text-[10px] font-normal"
														>
															Cancelled
														</Badge>
													)}
												</TableCell>
												<TableCell className="text-muted-foreground whitespace-nowrap font-mono text-xs">
													{formatTctTimestamp(gw.endsAt)}
												</TableCell>
												<TableCell className="max-w-[250px]">
													{gw.winners && gw.winners.length > 0 ? (
														<div className="flex flex-wrap gap-1 items-center">
															{gw.winners.map((w, idx) => (
																<span
																	key={w.discordUserId}
																	className="inline-flex items-center"
																>
																	{renderUserLink(
																		w.discordUserId,
																		w.discordUsername,
																		w.tornId,
																		w.tornName,
																		"text-xs",
																	)}
																	{idx < gw.winners.length - 1 && (
																		<span className="text-muted-foreground mr-1">
																			,
																		</span>
																	)}
																</span>
															))}
														</div>
													) : (
														<span className="text-muted-foreground text-[11px]">
															None
														</span>
													)}
												</TableCell>
												<TableCell className="text-right">
													{isActive && (
														<Button
															variant="ghost"
															size="sm"
															onClick={() => void handleCancelGiveaway(gw.id)}
															disabled={cancellingId === gw.id}
															className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer gap-1"
														>
															{cancellingId === gw.id ? (
																<Loader2 className="size-3 animate-spin" />
															) : (
																<XCircle className="size-3" />
															)}
															Cancel
														</Button>
													)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
