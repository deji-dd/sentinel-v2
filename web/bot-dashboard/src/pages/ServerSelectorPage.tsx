import {
	AlertCircle,
	ArrowRight,
	ExternalLink,
	KeyRound,
	Loader2,
	LogOut,
	Moon,
	Plus,
	RotateCw,
	Search,
	Server,
	ShieldCheck,
	Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
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
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import logoImg from "../../public/logo.png";
import { APP_VERSION } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { api } from "../lib/api";
import { useRouter } from "../router";

interface DiscordGuild {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
	features: string[];
	botInGuild?: boolean;
	authorized?: boolean;
	manageable?: boolean;
	userInGuild?: boolean;
}

function guildIconUrl(guild: DiscordGuild): string | null {
	if (!guild.icon) return null;
	return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`;
}

export default function ServerSelectorPage() {
	const { authenticated, loading: authLoading, user, logout } = useAuth();
	const { theme, toggle } = useTheme();
	const { navigate } = useRouter();
	const [guilds, setGuilds] = useState<DiscordGuild[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");

	const [dialogOpen, setDialogOpen] = useState(false);
	const [selectedGuildToAuthorize, setSelectedGuildToAuthorize] = useState("");
	const [customGuildId, setCustomGuildId] = useState("");
	const [authorizing, setAuthorizing] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const handleAuthorizeAndInvite = async (guildIdToAuth: string) => {
		const targetId = guildIdToAuth.trim();
		if (!targetId || !/^\d{17,20}$/.test(targetId)) {
			setActionError("Please provide a valid 17-20 digit Discord Guild ID.");
			return;
		}

		setAuthorizing(true);
		setActionError(null);
		try {
			const res = await fetch("/api/v1/guilds/authorize", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ guildId: targetId }),
			});
			const data = (await res.json()) as {
				success?: boolean;
				inviteUrl?: string;
				error?: string;
			};
			if (!res.ok || !data.success) {
				setActionError(data.error || "Failed to authorize server.");
				return;
			}

			if (data.inviteUrl) {
				window.open(data.inviteUrl, "_blank", "noopener,noreferrer");
			}

			setDialogOpen(false);
			setSelectedGuildToAuthorize("");
			setCustomGuildId("");
			await fetchGuilds();
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : "Failed to authorize server.",
			);
		} finally {
			setAuthorizing(false);
		}
	};

	const uninstalledGuilds = guilds.filter((g) => g.botInGuild === false);

	useEffect(() => {
		if (!authLoading && !authenticated) {
			navigate("/login");
		}
	}, [authLoading, authenticated, navigate]);

	const fetchGuilds = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await api.api.v1.guilds.get();
			if (res.data && typeof res.data === "object" && "guilds" in res.data) {
				const data = res.data as unknown as {
					guilds: DiscordGuild[];
					error?: string;
				};
				setGuilds(data.guilds);
				if (data.error) setError(data.error);
			}
		} catch {
			setError(
				"Failed to load servers. Make sure you're logged in with Discord.",
			);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!authenticated) return;
		void fetchGuilds();
	}, [authenticated]);

	const filtered = guilds.filter(
		(g) =>
			g.name.toLowerCase().includes(search.toLowerCase()) ||
			g.id.includes(search),
	);

	const avatarUrl = (() => {
		try {
			const meta = document.cookie.match(/discord_meta=([^;]+)/)?.[1];
			if (meta) {
				const parsed = JSON.parse(decodeURIComponent(meta)) as {
					avatar?: string;
				};
				return parsed.avatar ?? null;
			}
		} catch {
			// ignore
		}
		return null;
	})();

	return (
		<div className="min-h-screen w-full flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground font-sans relative overflow-hidden">
			{/* Top Header Bar: User Profile & Theme Switcher */}
			<div className="absolute top-4 right-4 z-20 flex items-center gap-2">
				{authenticated && user && (
					<div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-card/80 backdrop-blur-md border border-border shadow-xs text-xs">
						<Avatar className="size-6 border border-border">
							{avatarUrl ? (
								<AvatarImage src={avatarUrl} alt={user.username} />
							) : null}
							<AvatarFallback className="font-mono text-[10px] bg-primary/10 text-primary">
								{user.username.slice(0, 2).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<span className="font-medium text-foreground max-w-[120px] truncate">
							{user.username}
						</span>
						<Badge
							variant="outline"
							className="text-[10px] font-mono px-1.5 py-0 uppercase"
						>
							{user.role}
						</Badge>
						<Button
							variant="ghost"
							size="icon"
							onClick={logout}
							title="Log out"
							className="size-6 text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<LogOut className="size-3" />
						</Button>
					</div>
				)}

				<Button
					variant="ghost"
					size="icon"
					onClick={toggle}
					aria-label="Toggle theme"
					className="size-9 rounded-full bg-card/80 backdrop-blur-md border border-border cursor-pointer shadow-xs"
				>
					{theme === "dark" ? (
						<Sun className="size-4" />
					) : (
						<Moon className="size-4" />
					)}
				</Button>
			</div>

			{/* Subtle Radial Glow */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

			<div className="w-full max-w-4xl flex flex-col gap-6 relative z-10 py-8">
				{/* Top App Branding with Shadcn Avatar */}
				<div className="flex flex-col items-center gap-3 text-center">
					<Avatar
						size="lg"
						className="size-14 border border-border shadow-lg bg-card cursor-pointer"
						onClick={() => navigate("/")}
					>
						<AvatarImage
							src={logoImg}
							alt="Sentinel Logo"
							className="object-contain"
						/>
						<AvatarFallback className="font-mono font-bold text-xs">
							ST
						</AvatarFallback>
					</Avatar>
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight text-foreground font-mono uppercase">
							Sentinel
						</h1>
						<Badge
							variant="outline"
							className="text-[10px] font-mono px-2 py-0.5"
						>
							{APP_VERSION}
						</Badge>
					</div>
				</div>

				{/* Single Simple Shadcn Card */}
				<Card className="border-border/80 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl overflow-hidden">
					<CardHeader className="p-6 pb-4 border-b border-border/40">
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
							<div>
								<CardTitle className="text-xl font-semibold tracking-tight">
									Server Selection
								</CardTitle>
								<CardDescription className="text-xs text-muted-foreground mt-1">
									Select an authorized Discord server to configure and manage
								</CardDescription>
							</div>

							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => void fetchGuilds()}
									disabled={loading}
									className="h-9 px-3 text-xs gap-1.5 cursor-pointer rounded-xl"
									title="Refresh server list"
								>
									<RotateCw
										className={`size-3.5 ${loading ? "animate-spin" : ""}`}
										data-icon="inline-start"
									/>
									Refresh
								</Button>

								{(user?.role === "admin" || user?.role === "owner") && (
									<>
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												setActionError(null);
												setSelectedGuildToAuthorize(
													uninstalledGuilds[0]?.id || "",
												);
												setCustomGuildId("");
												setDialogOpen(true);
											}}
											className="h-9 px-3 text-xs gap-1.5 cursor-pointer rounded-xl font-medium border-primary/30 hover:border-primary text-primary"
											title="Authorize and invite Sentinel to a new server"
										>
											<Plus className="size-3.5" data-icon="inline-start" />
											Add Server
										</Button>

										<Button
											size="sm"
											onClick={() => {
												const targetGuild = guilds[0]?.id;
												navigate(
													targetGuild
														? `/guilds/${targetGuild}/keys`
														: "/admin/keys",
												);
											}}
											className="h-9 px-3 text-xs gap-1.5 cursor-pointer rounded-xl font-medium"
											title="Manage System API Keys"
										>
											<KeyRound className="size-3.5" data-icon="inline-start" />
											System Keys
										</Button>
									</>
								)}
							</div>
						</div>

						{/* Search & Count Filter Bar */}
						<div className="flex items-center justify-between gap-3 mt-4">
							<div className="relative flex-1 max-w-sm">
								<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
								<Input
									id="guild-search"
									type="text"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search server name or ID..."
									className="pl-9 h-9 text-xs rounded-xl bg-background/50"
									aria-label="Search servers"
								/>
							</div>
							{!loading && (
								<Badge
									variant="secondary"
									className="font-mono text-[11px] px-2.5 py-1"
								>
									{filtered.length} / {guilds.length} Servers
								</Badge>
							)}
						</div>
					</CardHeader>

					<CardContent className="p-6">
						{/* Error Alert using shadcn Alert */}
						{error && (
							<Alert variant="destructive" className="mb-6">
								<AlertCircle className="size-4" />
								<AlertTitle>Server Loading Issue</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}

						{/* Loading state with animated spinner and skeletons */}
						{loading && (
							<div className="space-y-4">
								<div className="flex items-center justify-center gap-2 py-3 text-xs font-mono text-muted-foreground">
									<Loader2 className="size-4 animate-spin text-primary" />
									<span>Fetching shared Discord servers...</span>
								</div>
								<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
									{Array.from({ length: 6 }).map((_, i) => (
										<Card
											key={`skeleton-${i + 1}`}
											className="p-4 flex items-center gap-3 border-border/50 bg-background/30"
										>
											<Skeleton className="size-11 rounded-xl shrink-0" />
											<div className="flex-1 space-y-2">
												<Skeleton className="h-4 w-3/4" />
												<Skeleton className="h-3 w-1/2" />
											</div>
										</Card>
									))}
								</div>
							</div>
						)}

						{/* Empty state */}
						{!loading && filtered.length === 0 && (
							<div className="flex flex-col items-center justify-center p-12 text-center gap-4 rounded-xl border border-dashed border-border/60 bg-background/30">
								<div className="size-12 rounded-2xl bg-muted/50 border border-border flex items-center justify-center text-muted-foreground">
									<Server className="size-6" />
								</div>
								<div className="space-y-1">
									<h3 className="text-base font-semibold tracking-tight text-foreground">
										No Servers Found
									</h3>
									<p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
										{search
											? `No mutual servers match "${search}". Try another search query.`
											: "You don't share any authorized target servers with Sentinel."}
									</p>
								</div>
							</div>
						)}

						{/* Guild Grid */}
						{!loading && filtered.length > 0 && (
							<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
								{filtered.map((guild) => {
									const isInstalled = guild.botInGuild !== false;
									return isInstalled ? (
										<button
											type="button"
											key={guild.id}
											id={`guild-card-${guild.id}`}
											onClick={() => navigate(`/guilds/${guild.id}`)}
											className="group p-4 rounded-xl border shadow-xs transition-all duration-200 flex flex-col justify-between gap-4 text-left bg-background/50 hover:bg-accent/40 border-border/60 hover:border-primary/40 hover:shadow-md cursor-pointer"
										>
											<div className="flex items-center gap-3">
												<Avatar className="size-11 border border-border shadow-xs shrink-0 rounded-xl">
													{guildIconUrl(guild) ? (
														<AvatarImage
															src={guildIconUrl(guild) ?? ""}
															alt={guild.name}
															className="object-cover"
														/>
													) : null}
													<AvatarFallback className="font-mono font-bold text-sm bg-muted text-muted-foreground">
														{guild.name.charAt(0).toUpperCase()}
													</AvatarFallback>
												</Avatar>

												<div className="min-w-0 flex-1">
													<p
														className="font-semibold text-sm text-foreground truncate group-hover:text-primary transition-colors"
														title={guild.name}
													>
														{guild.name}
													</p>
													<p className="text-[11px] text-muted-foreground font-mono truncate">
														ID: {guild.id}
													</p>
												</div>
											</div>

											<div className="pt-3 border-t border-border/40 flex items-center justify-between text-xs">
												<div className="flex items-center gap-1.5">
													<Badge
														variant={guild.owner ? "default" : "secondary"}
														className="text-[9px] font-mono px-1.5 py-0 uppercase font-semibold"
													>
														{guild.owner ? "OWNER" : "ADMIN"}
													</Badge>
													<Badge
														variant="outline"
														className="text-[9px] font-mono px-1.5 py-0 text-emerald-400 border-emerald-500/30"
													>
														ACTIVE
													</Badge>
												</div>

												<span className="text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors flex items-center gap-1">
													Manage
													<ArrowRight className="size-3.5 group-hover:translate-x-0.5 transition-transform" />
												</span>
											</div>
										</button>
									) : (
										<div
											key={guild.id}
											id={`guild-card-${guild.id}`}
											className="group p-4 rounded-xl border shadow-xs transition-all duration-200 flex flex-col justify-between gap-4 text-left bg-background/30 border-dashed border-border/60 hover:border-amber-500/40"
										>
											<div className="flex items-center gap-3">
												<Avatar className="size-11 border border-border shadow-xs shrink-0 rounded-xl">
													{guildIconUrl(guild) ? (
														<AvatarImage
															src={guildIconUrl(guild) ?? ""}
															alt={guild.name}
															className="object-cover"
														/>
													) : null}
													<AvatarFallback className="font-mono font-bold text-sm bg-muted text-muted-foreground">
														{guild.name.charAt(0).toUpperCase()}
													</AvatarFallback>
												</Avatar>

												<div className="min-w-0 flex-1">
													<p
														className="font-semibold text-sm text-foreground truncate group-hover:text-amber-400 transition-colors"
														title={guild.name}
													>
														{guild.name}
													</p>
													<p className="text-[11px] text-muted-foreground font-mono truncate">
														ID: {guild.id}
													</p>
												</div>
											</div>

											<div className="pt-3 border-t border-border/40 flex items-center justify-between text-xs">
												<div className="flex items-center gap-1.5">
													<Badge
														variant={guild.owner ? "default" : "secondary"}
														className="text-[9px] font-mono px-1.5 py-0 uppercase font-semibold"
													>
														{guild.owner ? "OWNER" : "ADMIN"}
													</Badge>
													<Badge
														variant="outline"
														className="text-[9px] font-mono px-1.5 py-0 text-amber-400 border-amber-500/30"
													>
														NOT INSTALLED
													</Badge>
												</div>

												<Button
													size="xs"
													variant="secondary"
													onClick={() =>
														void handleAuthorizeAndInvite(guild.id)
													}
													className="h-6 px-2 text-[11px] gap-1 cursor-pointer font-medium"
												>
													<ExternalLink className="size-3" />
													Invite Bot
												</Button>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Authorize & Invite Server Dialog Modal */}
				<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2">
								<ShieldCheck className="size-5 text-primary" />
								Authorize & Invite Server
							</DialogTitle>
							<DialogDescription className="text-xs">
								Authorize a Discord guild in Sentinel and generate an OAuth
								invite link with full slash command permissions.
							</DialogDescription>
						</DialogHeader>

						<div className="space-y-4 py-2">
							{actionError && (
								<Alert variant="destructive" className="py-2">
									<AlertCircle className="size-4" />
									<AlertDescription className="text-xs">
										{actionError}
									</AlertDescription>
								</Alert>
							)}

							{uninstalledGuilds.length > 0 && (
								<div className="space-y-1.5">
									<span className="text-xs font-medium text-muted-foreground block">
										Select from your manageable servers
									</span>
									<Select
										value={selectedGuildToAuthorize}
										onValueChange={(val) => {
											setSelectedGuildToAuthorize(val);
											setCustomGuildId("");
										}}
									>
										<SelectTrigger className="w-full h-9 text-xs">
											<SelectValue placeholder="Choose a server..." />
										</SelectTrigger>
										<SelectContent>
											{uninstalledGuilds.map((g) => (
												<SelectItem key={g.id} value={g.id} className="text-xs">
													{g.name} ({g.id})
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}

							<div className="space-y-1.5">
								<span className="text-xs font-medium text-muted-foreground block">
									Or enter Discord Guild ID manually
								</span>
								<Input
									id="custom-guild-id-input"
									value={customGuildId}
									onChange={(e) => {
										setCustomGuildId(e.target.value);
										if (e.target.value) setSelectedGuildToAuthorize("");
									}}
									placeholder="e.g. 1096243613681332328"
									className="h-9 text-xs font-mono"
								/>
							</div>
						</div>

						<DialogFooter className="gap-2 sm:gap-0">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setDialogOpen(false)}
								disabled={authorizing}
								className="text-xs"
							>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={() =>
									handleAuthorizeAndInvite(
										selectedGuildToAuthorize || customGuildId,
									)
								}
								disabled={
									authorizing || (!selectedGuildToAuthorize && !customGuildId)
								}
								className="text-xs gap-1.5"
							>
								{authorizing ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<ExternalLink className="size-3.5" />
								)}
								Authorize & Open Invite
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				{/* Bottom Credits */}
				<div className="text-center text-xs text-muted-foreground font-mono">
					Made by Blasted
				</div>
			</div>
		</div>
	);
}
