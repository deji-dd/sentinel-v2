import {
	AlertCircle,
	ArrowRight,
	ExternalLink,
	Loader2,
	LogOut,
	Moon,
	Plus,
	RotateCw,
	Search,
	Server,
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
import { Input } from "@/components/ui/input";
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
				const data = res.data as { guilds: DiscordGuild[]; error?: string };
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

	const DISCORD_CLIENT_ID = "1465437709693747280";
	const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=8&integration_type=0&scope=bot`;

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
					<div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border/80 bg-card/80 backdrop-blur-md shadow-xs">
						<Avatar className="size-5 border border-border">
							{avatarUrl ? (
								<AvatarImage src={avatarUrl} alt={user.username} />
							) : null}
							<AvatarFallback className="text-[9px] font-mono">
								{user.username.charAt(0).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<span className="text-xs font-medium text-foreground">
							{user.username}
						</span>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => void logout()}
							title="Sign out"
							aria-label="Sign out"
							className="size-6 text-muted-foreground hover:text-foreground rounded-full cursor-pointer ml-0.5"
						>
							<LogOut className="size-3.5" />
						</Button>
					</div>
				)}

				<Button
					variant="ghost"
					size="icon"
					onClick={toggle}
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					className="size-9 rounded-full cursor-pointer shadow-xs border border-border/60 bg-card/60 backdrop-blur-md"
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
								<Button
									asChild
									size="sm"
									className="h-9 px-3 text-xs gap-1.5 bg-[#5865f2] hover:bg-[#4752c4] text-white shadow-xs cursor-pointer rounded-xl font-medium"
								>
									<a href={inviteUrl} target="_blank" rel="noopener noreferrer">
										<Plus className="size-3.5" data-icon="inline-start" />
										Add to Server
										<ExternalLink className="size-3 text-white/80 ml-0.5" />
									</a>
								</Button>
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
											: "You don't share any authorized servers with Sentinel yet. Invite the bot to get started."}
									</p>
								</div>
								{!search && (
									<Button
										asChild
										size="sm"
										className="mt-2 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded-xl"
									>
										<a
											href={inviteUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											<Plus className="size-4" data-icon="inline-start" />
											Invite Sentinel
										</a>
									</Button>
								)}
							</div>
						)}

						{/* Guild Grid */}
						{!loading && filtered.length > 0 && (
							<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
								{filtered.map((guild) => (
									<button
										key={guild.id}
										type="button"
										id={`guild-card-${guild.id}`}
										onClick={() => navigate(`/guilds/${guild.id}`)}
										className="group p-4 rounded-xl bg-background/50 hover:bg-accent/40 border border-border/60 hover:border-primary/40 shadow-xs hover:shadow-md transition-all duration-200 flex flex-col justify-between gap-4 text-left cursor-pointer"
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
											<Badge
												variant={guild.owner ? "default" : "secondary"}
												className="text-[9px] font-mono px-1.5 py-0 uppercase font-semibold"
											>
												{guild.owner ? "OWNER" : "ADMIN"}
											</Badge>
											<span className="text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors flex items-center gap-1">
												Manage
												<ArrowRight className="size-3.5 group-hover:translate-x-0.5 transition-transform" />
											</span>
										</div>
									</button>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Bottom Credits */}
				<div className="text-center text-xs text-muted-foreground font-mono">
					Made by Blasted
				</div>
			</div>
		</div>
	);
}
