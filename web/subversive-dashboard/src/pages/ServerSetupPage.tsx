import {
	AlertCircle,
	Check,
	ChevronRight,
	ExternalLink,
	LogOut,
	RefreshCw,
	Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ModeToggle } from "@/components/mode-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { useSubversive } from "../contexts/SubversiveContext";
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
	if (color === 0) return "#94a3b8";
	return `#${color.toString(16).padStart(6, "0")}`;
}

export function ServerSetupPage() {
	const { logout } = useAuth();
	const { refreshStatus } = useSubversive();
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

	const fetchAvailableGuilds = async (forceFresh = false) => {
		setLoadingGuilds(true);
		setError(null);
		try {
			const url = forceFresh
				? "/api/v1/subversive/available-guilds?fresh=true"
				: "/api/v1/subversive/available-guilds";
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
				const res = await fetch("/api/v1/subversive/available-guilds");
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

	const handleSelectGuild = async (guild: AvailableGuild) => {
		setSelectedGuild(guild);
		setSelectedRoleIds(new Set());
		setRoleSearch("");
		setLoadingRoles(true);
		setError(null);

		try {
			const res = await fetch(`/api/v1/subversive/guild-roles/${guild.id}`);
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

	const handleConfirmSetup = async () => {
		if (!selectedGuild) return;

		setSaving(true);
		setError(null);

		try {
			const res = await fetch("/api/v1/subversive/setup", {
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
				`Successfully initialized Subversive server for ${selectedGuild.name}!`,
			);
			await refreshStatus();
			navigate("/recruitment");
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
		<div className="min-h-screen w-full flex flex-col bg-background text-foreground">
			{/* Header */}
			<header className="border-b border-border bg-card/60 backdrop-blur-md sticky top-0 z-20">
				<div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						<Avatar className="size-8 border border-border bg-card">
							<AvatarFallback className="text-[10px] font-mono">
								SA
							</AvatarFallback>
						</Avatar>
						<span className="font-mono font-bold tracking-tight text-sm">
							Subversive Alliance
						</span>
					</div>

					<div className="flex items-center gap-2">
						<ModeToggle />
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void logout()}
							className="gap-2 cursor-pointer text-muted-foreground hover:text-foreground"
						>
							<LogOut className="size-4" />
							<span className="hidden sm:inline">Log out</span>
						</Button>
					</div>
				</div>
			</header>

			{/* Main Content */}
			<main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-6 flex flex-col gap-6">
				<div>
					<h1 className="text-2xl font-bold tracking-tight">
						Select Subversive Alliance Faction Server
					</h1>
				</div>

				{error ? (
					<Alert variant="destructive">
						<AlertCircle className="size-4" />
						<AlertTitle>Setup Error</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
					{/* Step 1: Guild Picker */}
					<Card className="flex flex-col">
						<CardHeader>
							<div className="flex items-center justify-between gap-2">
								<CardTitle className="text-base">1. Choose Server</CardTitle>
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => void fetchAvailableGuilds(true)}
									disabled={loadingGuilds}
									title="Refresh Discord servers"
									className="cursor-pointer"
								>
									<RefreshCw
										className={`size-3.5 ${loadingGuilds ? "animate-spin" : ""}`}
									/>
								</Button>
							</div>

							<div className="pt-2">
								<div className="relative">
									<Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
									<Input
										placeholder="Search servers..."
										value={guildSearch}
										onChange={(e) => setGuildSearch(e.target.value)}
										className="pl-9 h-8 text-xs"
									/>
								</div>
							</div>
						</CardHeader>

						<CardContent className="flex-1 overflow-y-auto max-h-[380px] flex flex-col gap-2 p-4 pt-0">
							{loadingGuilds ? (
								<div className="flex flex-col gap-2">
									<Skeleton className="h-12 w-full" />
									<Skeleton className="h-12 w-full" />
									<Skeleton className="h-12 w-full" />
								</div>
							) : filteredGuilds.length === 0 ? (
								<div className="text-center py-8 text-muted-foreground text-sm flex flex-col items-center gap-3">
									<p>No servers found matching your query.</p>
									{botInviteUrl ? (
										<Button
											variant="outline"
											size="sm"
											asChild
											className="gap-1.5"
										>
											<a
												href={botInviteUrl}
												target="_blank"
												rel="noopener noreferrer"
											>
												<ExternalLink className="size-3.5" />
												Invite Sentinel to Server
											</a>
										</Button>
									) : null}
								</div>
							) : (
								filteredGuilds.map((g) => {
									const isSelected = selectedGuild?.id === g.id;
									return (
										<button
											key={g.id}
											type="button"
											onClick={() => void handleSelectGuild(g)}
											className={`flex items-center justify-between p-3 rounded-lg border text-left transition-colors cursor-pointer ${
												isSelected
													? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
													: "border-border hover:bg-accent/50 text-foreground"
											}`}
										>
											<div className="flex items-center gap-3 min-w-0">
												<Avatar className="size-9 rounded-md border border-border">
													{g.icon ? (
														<AvatarImage src={g.icon} alt={g.name} />
													) : null}
													<AvatarFallback className="font-mono text-xs">
														{g.name.slice(0, 2).toUpperCase()}
													</AvatarFallback>
												</Avatar>
												<div className="flex flex-col min-w-0">
													<span className="font-medium text-sm truncate">
														{g.name}
													</span>
													<span className="text-[10px] text-muted-foreground font-mono">
														{g.id}
													</span>
												</div>
											</div>
											<ChevronRight
												className={`size-4 shrink-0 transition-transform ${
													isSelected
														? "text-primary translate-x-0.5"
														: "text-muted-foreground"
												}`}
											/>
										</button>
									);
								})
							)}
						</CardContent>
					</Card>

					{/* Step 2: Role Permissions & Confirm */}
					<Card className="flex flex-col">
						<CardHeader>
							<CardTitle className="text-base">
								2. Designate Admin Roles
							</CardTitle>
							<CardDescription>
								Users holding selected roles will have admin access to the
								dashboard.
							</CardDescription>
							{selectedGuild ? (
								<div className="pt-2">
									<div className="relative">
										<Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
										<Input
											placeholder="Search roles..."
											value={roleSearch}
											onChange={(e) => setRoleSearch(e.target.value)}
											className="pl-9 h-8 text-xs"
										/>
									</div>
								</div>
							) : null}
						</CardHeader>

						<CardContent className="flex-1 overflow-y-auto max-h-[380px] flex flex-col gap-2 p-4 pt-0">
							{!selectedGuild ? (
								<div className="h-full flex flex-col items-center justify-center text-center p-6 text-muted-foreground text-sm gap-2">
									<p>Select a Discord server on the left to view roles.</p>
								</div>
							) : loadingRoles ? (
								<div className="flex flex-col gap-2">
									<Skeleton className="h-10 w-full" />
									<Skeleton className="h-10 w-full" />
									<Skeleton className="h-10 w-full" />
								</div>
							) : filteredRoles.length === 0 ? (
								<div className="text-center py-8 text-muted-foreground text-sm">
									No roles found.
								</div>
							) : (
								filteredRoles.map((r) => {
									const isChecked = selectedRoleIds.has(r.id);
									return (
										<button
											key={r.id}
											type="button"
											onClick={() => toggleRole(r.id)}
											className={`flex items-center justify-between p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
												isChecked
													? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
													: "border-border hover:bg-accent/50 text-foreground"
											}`}
										>
											<div className="flex items-center gap-2.5 min-w-0">
												<span
													className="size-3 rounded-full shrink-0"
													style={{ backgroundColor: formatRoleColor(r.color) }}
												/>
												<span className="font-medium text-sm truncate">
													{r.name}
												</span>
											</div>
											<div
												className={`size-4 rounded border flex items-center justify-center transition-colors ${
													isChecked
														? "border-primary bg-primary text-primary-foreground"
														: "border-muted-foreground/30"
												}`}
											>
												{isChecked ? <Check className="size-3" /> : null}
											</div>
										</button>
									);
								})
							)}
						</CardContent>

						<Separator />

						<CardFooter className="pt-4 flex items-center justify-between">
							<div className="text-xs text-muted-foreground">
								{selectedGuild ? (
									<span>
										{selectedRoleIds.size} role
										{selectedRoleIds.size === 1 ? "" : "s"} selected
									</span>
								) : (
									"No server selected"
								)}
							</div>

							<Button
								disabled={!selectedGuild || saving}
								onClick={() => void handleConfirmSetup()}
								className="cursor-pointer"
							>
								{saving ? "Initializing..." : "Complete Setup"}
							</Button>
						</CardFooter>
					</Card>
				</div>
			</main>
		</div>
	);
}
