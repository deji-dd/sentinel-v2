import {
	AlertCircle,
	ArrowRight,
	Check,
	ChevronRight,
	ExternalLink,
	LogOut,
	Plus,
	RefreshCw,
	Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "../contexts/AuthContext";
import { useElims } from "../contexts/ElimsContext";
import { useRouter } from "../router";

interface AvailableGuild {
	id: string;
	name: string;
	icon: string | null;
	botInGuild: boolean;
	owner: boolean;
	userInGuild: boolean;
}

interface GuildRole {
	id: string;
	name: string;
	color: number;
	position: number;
	managed: boolean;
}

function formatRoleColor(color: number): string {
	if (color === 0) return "#94a3b8"; // slate-400 default
	return `#${color.toString(16).padStart(6, "0")}`;
}

export function GuildSetupPage() {
	const { logout } = useAuth();
	const { refreshStatus } = useElims();
	const { navigate } = useRouter();

	const [guilds, setGuilds] = useState<AvailableGuild[]>([]);
	const [botInviteUrl, setBotInviteUrl] = useState<string>("");
	const [loadingGuilds, setLoadingGuilds] = useState(true);
	const [guildSearch, setGuildSearch] = useState("");

	const [selectedGuild, setSelectedGuild] = useState<AvailableGuild | null>(
		null,
	);
	const [roles, setRoles] = useState<GuildRole[]>([]);
	const [loadingRoles, setLoadingRoles] = useState(false);
	const [roleSearch, setRoleSearch] = useState("");
	const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
		new Set(),
	);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Fetch available guilds where Sentinel is present
	const fetchAvailableGuilds = async (forceFresh = false) => {
		setLoadingGuilds(true);
		setError(null);
		try {
			const url = forceFresh
				? "/api/v1/elims/available-guilds?fresh=true"
				: "/api/v1/elims/available-guilds";
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				guilds: AvailableGuild[];
				botInviteUrl: string;
			};
			setGuilds(data.guilds ?? []);
			setBotInviteUrl(data.botInviteUrl);
		} catch (err) {
			console.error("Failed to load available guilds:", err);
			setError("Failed to fetch available Discord servers. Please try again.");
		} finally {
			setLoadingGuilds(false);
		}
	};

	useEffect(() => {
		let isMounted = true;
		const init = async () => {
			setLoadingGuilds(true);
			setError(null);
			try {
				const res = await fetch("/api/v1/elims/available-guilds");
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const data = (await res.json()) as {
					guilds: AvailableGuild[];
					botInviteUrl: string;
				};
				if (isMounted) {
					setGuilds(data.guilds ?? []);
					setBotInviteUrl(data.botInviteUrl);
				}
			} catch (err) {
				console.error("Failed to load available guilds:", err);
				if (isMounted) {
					setError(
						"Failed to fetch available Discord servers. Please try again.",
					);
				}
			} finally {
				if (isMounted) {
					setLoadingGuilds(false);
				}
			}
		};

		void init();

		return () => {
			isMounted = false;
		};
	}, []);

	// Fetch roles when a guild is selected
	const handleSelectGuild = async (guild: AvailableGuild) => {
		setSelectedGuild(guild);
		setSelectedRoleIds(new Set());
		setRoleSearch("");
		setLoadingRoles(true);
		setError(null);

		try {
			const res = await fetch(`/api/v1/elims/guild-roles/${guild.id}`);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = (await res.json()) as { roles: GuildRole[] };
			setRoles(data.roles ?? []);
		} catch (err) {
			console.error("Failed to load guild roles:", err);
			setError(
				"Could not fetch server roles. Ensure Sentinel has permission to view roles.",
			);
		} finally {
			setLoadingRoles(false);
		}
	};

	const toggleRole = (roleId: string) => {
		setSelectedRoleIds((prev) => {
			const next = new Set(prev);
			if (next.has(roleId)) {
				next.delete(roleId);
			} else {
				next.add(roleId);
			}
			return next;
		});
	};

	// Save and initialize the elims tournament server
	const handleConfirmSetup = async () => {
		if (!selectedGuild) return;

		setSaving(true);
		setError(null);

		try {
			const res = await fetch("/api/v1/elims/setup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					guildId: selectedGuild.id,
					adminRoleIds: Array.from(selectedRoleIds),
				}),
			});

			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? `Setup failed (HTTP ${res.status})`);
			}

			toast.success(
				`Successfully initialized Elims Server for ${selectedGuild.name}!`,
			);
			await refreshStatus();
			navigate("/guild-config");
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to save setup.";
			setError(msg);
			toast.error(msg);
		} finally {
			setSaving(false);
		}
	};

	const filteredGuilds = useMemo(() => {
		const q = guildSearch.toLowerCase().trim();
		if (!q) return guilds;
		return guilds.filter(
			(g) => g.name.toLowerCase().includes(q) || g.id.includes(q),
		);
	}, [guilds, guildSearch]);

	const filteredRoles = useMemo(() => {
		const q = roleSearch.toLowerCase().trim();
		if (!q) return roles;
		return roles.filter((r) => r.name.toLowerCase().includes(q));
	}, [roles, roleSearch]);

	return (
		<div className="min-h-screen w-full flex flex-col bg-background text-foreground relative overflow-hidden">
			{/* Ambient background accent */}
			<div className="absolute top-0 right-1/4 size-[500px] bg-primary/5 rounded-full blur-[140px] pointer-events-none" />

			{/* Header */}
			<header className="border-b border-border bg-card/60 backdrop-blur-md sticky top-0 z-20">
				<div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						<Avatar size="sm" className="size-8 border border-border bg-card">
							<AvatarImage src="/logo.png" alt="Sentinel Logo" />
							<AvatarFallback className="text-[10px] font-mono">
								EL
							</AvatarFallback>
						</Avatar>
						<span className="font-mono font-bold tracking-tight text-sm">
							SENTINEL
						</span>
					</div>

					<div className="flex items-center gap-2">
						{botInviteUrl && (
							<Button
								variant="outline"
								size="sm"
								className="text-xs cursor-pointer"
								asChild
							>
								<a href={botInviteUrl} target="_blank" rel="noreferrer">
									<Plus className="size-3.5" data-icon="inline-start" />
									Invite Bot
									<ExternalLink
										className="size-3 text-muted-foreground ml-0.5"
										data-icon="inline-end"
									/>
								</a>
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							className="text-xs cursor-pointer"
							onClick={() => void fetchAvailableGuilds(true)}
							disabled={loadingGuilds}
						>
							<RefreshCw
								className={loadingGuilds ? "size-3.5 animate-spin" : "size-3.5"}
								data-icon="inline-start"
							/>
							Refresh
						</Button>
						<Separator orientation="vertical" className="h-4" />
						<ThemeToggle />
						<Separator orientation="vertical" className="h-4" />
						<Button
							variant="ghost"
							size="sm"
							onClick={logout}
							className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<LogOut className="size-3.5" data-icon="inline-start" />
							Sign Out
						</Button>
					</div>
				</div>
			</header>

			{/* Main Content */}
			<main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6 relative z-10">
				{/* Title Section */}
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight">Guild Setup</h1>
					</div>
				</div>

				{error && (
					<Alert variant="destructive">
						<AlertCircle className="size-4" />
						<AlertTitle>Configuration Notice</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}

				<div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
					{/* Left Column: Server Selection (7 cols) */}
					<Card className="lg:col-span-7 border-border/80 bg-card/90 shadow-sm">
						<CardHeader className="pb-3">
							<div className="flex items-center justify-between">
								<CardTitle className="text-base flex items-center gap-2">
									1. Select Discord Server
								</CardTitle>
								<Badge variant="secondary" className="text-[11px] font-mono">
									{filteredGuilds.length} Available
								</Badge>
							</div>
							<CardDescription className="text-xs">
								Choose a Discord server where Sentinel is installed.
							</CardDescription>
							<div className="pt-2">
								<div className="relative">
									<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
									<Input
										placeholder="Search servers by name or ID..."
										value={guildSearch}
										onChange={(e) => setGuildSearch(e.target.value)}
										className="pl-9 h-9 text-xs"
									/>
								</div>
							</div>
						</CardHeader>

						<CardContent className="flex flex-col gap-2 max-h-[380px] overflow-y-auto pr-1">
							{loadingGuilds ? (
								<div className="flex flex-col gap-2 py-2">
									<Skeleton className="h-14 w-full" />
									<Skeleton className="h-14 w-full" />
									<Skeleton className="h-14 w-full" />
								</div>
							) : filteredGuilds.length === 0 ? (
								<div className="text-center py-8 flex flex-col items-center gap-2">
									<p className="text-xs text-muted-foreground">
										No mutual servers found where Sentinel is present.
									</p>
									{botInviteUrl && (
										<Button
											variant="outline"
											size="sm"
											className="mt-2 text-xs"
											asChild
										>
											<a href={botInviteUrl} target="_blank" rel="noreferrer">
												<Plus className="size-3.5" data-icon="inline-start" />
												Invite Sentinel Bot
											</a>
										</Button>
									)}
								</div>
							) : (
								filteredGuilds.map((g) => {
									const isSelected = selectedGuild?.id === g.id;
									const iconUrl = g.icon
										? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`
										: null;

									return (
										<button
											key={g.id}
											type="button"
											onClick={() => handleSelectGuild(g)}
											className={`flex items-center justify-between p-3 rounded-lg border text-left transition-all cursor-pointer ${
												isSelected
													? "border-primary bg-primary/10 shadow-xs"
													: "border-border/60 hover:border-border hover:bg-muted/40"
											}`}
										>
											<div className="flex items-center gap-3 min-w-0">
												<Avatar className="size-9 border border-border shrink-0">
													{iconUrl && (
														<AvatarImage src={iconUrl} alt={g.name} />
													)}
													<AvatarFallback className="font-mono text-xs">
														{g.name.slice(0, 2).toUpperCase()}
													</AvatarFallback>
												</Avatar>
												<div className="flex flex-col min-w-0">
													<span className="font-medium text-sm text-foreground truncate">
														{g.name}
													</span>
													<span className="font-mono text-[11px] text-muted-foreground truncate">
														ID: {g.id}
													</span>
												</div>
											</div>

											<div className="flex items-center gap-2 shrink-0">
												{isSelected ? (
													<Badge
														variant="default"
														className="text-[10px] font-mono gap-1"
													>
														<Check className="size-3" /> Selected
													</Badge>
												) : (
													<ChevronRight className="size-4 text-muted-foreground" />
												)}
											</div>
										</button>
									);
								})
							)}
						</CardContent>
					</Card>

					{/* Right Column: Role Designation & Confirm (5 cols) */}
					<Card className="lg:col-span-5 border-border/80 bg-card/90 shadow-sm flex flex-col">
						<CardHeader className="pb-3">
							<div className="flex items-center justify-between">
								<CardTitle className="text-base flex items-center gap-2">
									2. Dashboard Admins
								</CardTitle>
								{selectedGuild && (
									<Badge variant="outline" className="text-[10px] font-mono">
										{selectedRoleIds.size} Selected
									</Badge>
								)}
							</div>
							<CardDescription className="text-xs">
								Pick server roles that can view and administer the tournament.
							</CardDescription>

							{selectedGuild && (
								<div className="pt-2">
									<div className="relative">
										<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
										<Input
											placeholder="Filter roles..."
											value={roleSearch}
											onChange={(e) => setRoleSearch(e.target.value)}
											className="pl-9 h-8 text-xs"
										/>
									</div>
								</div>
							)}
						</CardHeader>

						<CardContent className="flex-1 flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-1">
							{!selectedGuild ? (
								<div className="text-center py-12 flex flex-col items-center gap-2 text-muted-foreground">
									<p className="text-xs">Select a server on the left first.</p>
								</div>
							) : loadingRoles ? (
								<div className="flex flex-col gap-2 py-2">
									<Skeleton className="h-9 w-full" />
									<Skeleton className="h-9 w-full" />
									<Skeleton className="h-9 w-full" />
								</div>
							) : filteredRoles.length === 0 ? (
								<div className="text-center py-8 text-xs text-muted-foreground">
									No roles found.
								</div>
							) : (
								filteredRoles.map((role) => {
									const isChecked = selectedRoleIds.has(role.id);
									const colorHex = formatRoleColor(role.color);

									return (
										<button
											key={role.id}
											type="button"
											onClick={() => toggleRole(role.id)}
											className={`flex items-center justify-between p-2 rounded-md border text-left transition-all cursor-pointer ${
												isChecked
													? "border-primary/80 bg-primary/10 shadow-xs"
													: "border-border/50 hover:bg-muted/30"
											}`}
										>
											<div className="flex items-center gap-2.5 min-w-0">
												<span
													className="size-3 rounded-full shrink-0 border border-border"
													style={{ backgroundColor: colorHex }}
												/>
												<span className="text-xs font-medium truncate text-foreground">
													{role.name}
												</span>
											</div>
											{isChecked ? (
												<Check className="size-3.5 text-primary shrink-0" />
											) : (
												<span className="size-3.5 shrink-0 border rounded-xs border-muted-foreground/40" />
											)}
										</button>
									);
								})
							)}
						</CardContent>

						<Separator />

						<CardFooter className="flex flex-col gap-3 p-4">
							{selectedGuild && (
								<div className="w-full text-xs flex justify-between items-center text-muted-foreground">
									<span>Selected Server:</span>
									<span className="font-medium text-foreground font-mono truncate max-w-[160px]">
										{selectedGuild.name}
									</span>
								</div>
							)}

							<Button
								variant="default"
								className="w-full cursor-pointer"
								disabled={!selectedGuild || saving}
								onClick={handleConfirmSetup}
							>
								{saving ? (
									<>
										<RefreshCw
											className="size-4 animate-spin"
											data-icon="inline-start"
										/>
										Initializing Server...
									</>
								) : (
									<>
										Confirm & Launch Elims Server
										<ArrowRight className="size-4" data-icon="inline-end" />
									</>
								)}
							</Button>
						</CardFooter>
					</Card>
				</div>
			</main>
		</div>
	);
}
