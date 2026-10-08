import {
	AlertCircle,
	ArrowRight,
	Crosshair,
	Crown,
	ExternalLink,
	Loader2,
	LogOut,
	Moon,
	Plus,
	RotateCw,
	ShieldCheck,
	Sun,
	Swords,
	Trophy,
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
import { Skeleton } from "@/components/ui/skeleton";
import logoImg from "../../public/logo.png";
import { APP_VERSION } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useTheme } from "../hooks/useTheme";
import { api } from "../lib/api";
import { useRouter } from "../router";

export type ServerType = "alliance" | "faction" | "elims" | "owner" | "merc";

export interface ServerTypeMapping {
	alliance: string | null;
	faction: string | null;
	elims: string | null;
	owner: string | null;
	merc: string | null;
}

interface DiscordGuild {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
	features?: string[];
	botInGuild?: boolean;
	authorized?: boolean;
	manageable?: boolean;
	userInGuild?: boolean;
	serverType?: ServerType | null;
}

function guildIconUrl(guild: DiscordGuild): string | null {
	if (!guild.icon) return null;
	return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`;
}

interface ServerTypeMeta {
	type: ServerType;
	label: string;
	title: string;
	badgeClass: string;
	icon: React.ComponentType<{ className?: string }>;
	actionLabel: string;
	getDestination: (guildId: string) => string;
	isExternal?: boolean;
}

const SERVER_TYPE_CONFIGS: ServerTypeMeta[] = [
	{
		type: "alliance",
		label: "Alliance",
		title: "Alliance Server",
		badgeClass: "bg-blue-500/10 text-blue-400 border-blue-500/30",
		icon: ShieldCheck,
		actionLabel: "Open Dashboard",
		getDestination: (guildId) => `/guilds/${guildId}?type=alliance`,
	},
	{
		type: "faction",
		label: "Faction",
		title: "Faction Server",
		badgeClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
		icon: Swords,
		actionLabel: "Open Dashboard",
		getDestination: (guildId) => `/guilds/${guildId}?type=faction`,
	},
	{
		type: "merc",
		label: "Mercenary",
		title: "Mercenary Guild",
		badgeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
		icon: Crosshair,
		actionLabel: "Open Dashboard",
		getDestination: (guildId) => `/guilds/${guildId}?type=merc`,
	},
	{
		type: "elims",
		label: "Elims",
		title: "Eliminations Server",
		badgeClass: "bg-rose-500/10 text-rose-400 border-rose-500/30",
		icon: Trophy,
		actionLabel: "Open Dashboard",
		getDestination: (guildId) => `/guilds/${guildId}?type=elims`,
	},
	{
		type: "owner",
		label: "Owner",
		title: "Owner / Dev Server",
		badgeClass: "bg-purple-500/10 text-purple-400 border-purple-500/30",
		icon: Crown,
		actionLabel: "Open Dashboard",
		getDestination: (guildId) => `/guilds/${guildId}?type=owner`,
	},
];

// Fixed default server type mappings
const FIXED_SERVER_TYPES: ServerTypeMapping = {
	alliance: null,
	faction: null,
	elims: null,
	owner: null,
	merc: null,
};

export default function ServerSelectorPage() {
	const { authenticated, loading: authLoading, user, logout } = useAuth();
	const { theme, toggle } = useTheme();
	const { navigate } = useRouter();
	const { toast } = useToast();

	const isOwner = user?.role === "owner" || user?.role === "admin";

	const [guilds, setGuilds] = useState<DiscordGuild[]>([]);
	const [serverTypes, setServerTypes] =
		useState<ServerTypeMapping>(FIXED_SERVER_TYPES);
	const [botClientId, setBotClientId] = useState<string>("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!authLoading && !authenticated) {
			navigate("/login");
		}
	}, [authLoading, authenticated, navigate]);

	const fetchGuilds = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await api.v2.guilds.get();
			if (res.data && typeof res.data === "object") {
				const data = res.data as {
					guilds?: DiscordGuild[];
					serverTypes?: ServerTypeMapping;
					botClientId?: string;
					error?: string;
				};
				if (data.guilds) setGuilds(data.guilds);
				if (data.serverTypes) {
					setServerTypes({
						alliance: data.serverTypes.alliance ?? FIXED_SERVER_TYPES.alliance,
						faction: data.serverTypes.faction ?? FIXED_SERVER_TYPES.faction,
						elims: data.serverTypes.elims ?? FIXED_SERVER_TYPES.elims,
						owner: data.serverTypes.owner ?? FIXED_SERVER_TYPES.owner,
						merc: data.serverTypes.merc ?? FIXED_SERVER_TYPES.merc,
					});
				}
				if (data.botClientId) setBotClientId(data.botClientId);
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

	const handleInviteToServer = async (guildId: string) => {
		const targetId = guildId.trim();
		const fallbackClientId = botClientId || "1409581500453748837";
		const fallbackUrl = `https://discord.com/oauth2/authorize?client_id=${fallbackClientId}&permissions=8&scope=bot%20applications.commands&guild_id=${targetId}&disable_guild_select=true`;

		try {
			const res = await api.v2.guilds.authorize.post({ guildId: targetId });
			const data = res.data as { inviteUrl?: string } | undefined;
			const inviteUrl = data?.inviteUrl || fallbackUrl;
			window.open(inviteUrl, "_blank", "noopener,noreferrer");
			toast("Opened bot invite for server.", "info");
		} catch {
			window.open(fallbackUrl, "_blank", "noopener,noreferrer");
		}
	};

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

	const guildMap = new Map(guilds.map((g) => [g.id, g]));

	return (
		<div className="min-h-dvh w-full flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground font-sans relative overflow-hidden">
			{/* Top Header Bar: User Profile & Controls */}
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

			{/* Subtle Radial Background Glow */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[650px] bg-primary/5 rounded-full blur-[130px] pointer-events-none" />

			<div className="w-full max-w-4xl flex flex-col gap-6 relative z-10 py-8">
				{/* App Branding */}
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

				{/* Primary Card */}
				<Card className="border-border/80 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl overflow-hidden">
					<CardHeader className="p-6 pb-4 border-b border-border/40">
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
							<div>
								<CardTitle className="text-xl font-semibold tracking-tight">
									Server Selection
								</CardTitle>
								<CardDescription className="text-xs text-muted-foreground mt-1">
									Select a designated server environment to monitor and manage.
								</CardDescription>
							</div>

							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="icon"
									onClick={fetchGuilds}
									disabled={loading}
									title="Refresh server status"
									className="size-9 border-border bg-background/50 cursor-pointer shadow-xs"
								>
									<RotateCw
										className={`size-4 text-muted-foreground ${loading ? "animate-spin" : ""}`}
									/>
								</Button>
							</div>
						</div>
					</CardHeader>

					<CardContent className="p-6">
						{/* Error Alert */}
						{error && (
							<Alert variant="destructive" className="mb-6">
								<AlertCircle className="size-4" />
								<AlertTitle>Server Loading Issue</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}

						{/* Loading State */}
						{loading && (
							<div className="space-y-4">
								<div className="flex items-center justify-center gap-2 py-6 text-xs font-mono text-muted-foreground">
									<Loader2 className="size-4 animate-spin text-primary" />
									<span>Fetching server types & telemetry...</span>
								</div>
								<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
									{Array.from({ length: 4 }).map((_, i) => (
										<Card
											key={`skeleton-${i + 1}`}
											className="p-5 flex items-start gap-4 border-border/50 bg-background/30"
										>
											<Skeleton className="size-12 rounded-full shrink-0" />
											<div className="flex-1 space-y-2">
												<Skeleton className="h-4 w-3/4" />
												<Skeleton className="h-3 w-1/2" />
												<Skeleton className="h-8 w-24 mt-2" />
											</div>
										</Card>
									))}
								</div>
							</div>
						)}

						{/* 4 Dedicated Server Type Cards */}
						{!loading && (
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								{SERVER_TYPE_CONFIGS.map((config) => {
									const assignedId = serverTypes[config.type];
									const guild = assignedId ? guildMap.get(assignedId) : null;
									const IconComponent = config.icon;
									const isConfigured = Boolean(assignedId);

									// Bot is in server if guild exists and botInGuild is true
									const botInServer = Boolean(
										guild && guild.botInGuild === true,
									);

									const isMember = isOwner || Boolean(guild?.userInGuild);
									const canManage = isOwner || Boolean(guild?.manageable);
									const hasAccess =
										isConfigured && botInServer && isMember && canManage;

									const displayName =
										guild?.name &&
										!guild.name.startsWith("Authorized Server (") &&
										!guild.name.startsWith("Server (")
											? guild.name
											: config.title;

									return (
										<div
											key={config.type}
											className="p-5 rounded-xl border border-border/60 bg-background/40 hover:bg-background/70 hover:border-border transition-all duration-200 flex flex-col justify-between gap-4 group"
										>
											<div className="flex items-start justify-between gap-3">
												<div className="flex items-center gap-3">
													{isConfigured && guild && (hasAccess || isMember) ? (
														<Avatar className="size-12 border border-border shadow-xs shrink-0 rounded-full">
															{guildIconUrl(guild) ? (
																<AvatarImage
																	src={guildIconUrl(guild) ?? ""}
																	alt={displayName}
																	className="object-cover"
																/>
															) : null}
															<AvatarFallback className="font-mono font-bold text-sm bg-muted text-muted-foreground">
																{displayName.charAt(0).toUpperCase()}
															</AvatarFallback>
														</Avatar>
													) : (
														<div className="size-12 rounded-full border border-border/60 bg-muted/30 flex items-center justify-center text-muted-foreground shrink-0">
															<IconComponent className="size-6 opacity-70" />
														</div>
													)}

													<div className="min-w-0">
														<div className="flex items-center gap-2">
															<span
																className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-md border font-semibold ${config.badgeClass}`}
															>
																{config.label}
															</span>
															{!assignedId ? (
																<Badge
																	variant="outline"
																	className="text-[9px] font-mono text-muted-foreground border-border/40 px-1.5 py-0"
																>
																	Unassigned
																</Badge>
															) : !botInServer ? (
																<Badge
																	variant="outline"
																	className="text-[9px] font-mono text-amber-400 border-amber-500/30 bg-amber-500/10 px-1.5 py-0"
																>
																	Bot Not in Server
																</Badge>
															) : !isMember ? (
																<Badge
																	variant="outline"
																	className="text-[9px] font-mono text-muted-foreground border-border/60 px-1.5 py-0"
																>
																	Not in Server
																</Badge>
															) : !canManage ? (
																<Badge
																	variant="outline"
																	className="text-[9px] font-mono text-amber-400 border-amber-500/30 bg-amber-500/10 px-1.5 py-0"
																>
																	Role Required
																</Badge>
															) : null}
														</div>
														<h3
															className="font-semibold text-base text-foreground mt-1 truncate"
															title={displayName}
														>
															{displayName}
														</h3>
													</div>
												</div>
											</div>

											{/* Bottom Action */}
											<div className="flex items-center justify-end pt-2 border-t border-border/30 mt-1">
												<div>
													{assignedId && !botInServer ? (
														<Button
															size="sm"
															variant="outline"
															onClick={() => handleInviteToServer(assignedId)}
															className="h-8 px-3 gap-1.5 text-xs font-medium cursor-pointer border-primary/40 text-primary hover:bg-primary/10"
														>
															<Plus className="size-3.5" />
															<span>Invite to Server</span>
														</Button>
													) : hasAccess && assignedId ? (
														<Button
															size="sm"
															onClick={() => {
																const dest = config.getDestination(assignedId);
																if (
																	config.isExternal &&
																	dest.startsWith("http")
																) {
																	window.open(dest, "_blank");
																} else {
																	navigate(dest);
																}
															}}
															className="h-8 px-3 gap-1.5 text-xs font-medium cursor-pointer"
														>
															<span>{config.actionLabel}</span>
															{config.isExternal ? (
																<ExternalLink className="size-3.5" />
															) : (
																<ArrowRight className="size-3.5" />
															)}
														</Button>
													) : isConfigured && !isMember ? (
														<Button
															size="sm"
															variant="outline"
															disabled
															className="h-8 px-3 text-xs opacity-50 cursor-not-allowed"
														>
															<span>Not in Server</span>
														</Button>
													) : isConfigured && isMember && !canManage ? (
														<Button
															size="sm"
															variant="outline"
															disabled
															className="h-8 px-3 text-xs opacity-60 text-amber-500 border-amber-500/30 cursor-not-allowed"
														>
															<span>Role Required</span>
														</Button>
													) : config.type === "elims" && isOwner ? (
														<Button
															size="sm"
															onClick={() =>
																navigate("/guilds/elims/setup?type=elims")
															}
															className="h-8 px-3 gap-1.5 text-xs font-medium cursor-pointer"
														>
															<span>Setup Elims</span>
															<ArrowRight className="size-3.5" />
														</Button>
													) : (
														<Badge
															variant="secondary"
															className="text-[10px] font-mono opacity-70"
														>
															Pending Setup
														</Badge>
													)}
												</div>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
