import {
	ArrowLeft,
	ChevronRight,
	Hash,
	LogOut,
	MapPin,
	Moon,
	Settings,
	ShieldAlert,
	Smile,
	Sun,
	Target,
	UserCheck,
	UserPlus,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import logoImg from "../../public/logo.png";
import { APP_VERSION } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { api } from "../lib/api";
import type { ServerTypeMapping } from "../pages/ServerSelectorPage";
import { useRouter } from "../router";

interface NavItem {
	label: string;
	href: string;
	icon: React.ElementType;
	accent?: string;
	locked?: boolean;
}

interface NavSection {
	title: string;
	items: NavItem[];
}

interface GuildSidebarProps {
	guildId: string;
	activeServerType?: string | null;
	onNavigate?: () => void;
}

export function GuildSidebar({
	guildId,
	activeServerType,
	onNavigate,
}: GuildSidebarProps) {
	const { path, queryParams, navigate } = useRouter();
	const { user, authenticated, logout } = useAuth();
	const { theme, toggle } = useTheme();

	const [serverTypes, setServerTypes] = useState<ServerTypeMapping>({
		alliance: null,
		faction: null,
		elims: null,
		owner: null,
		merc: null,
	});

	useEffect(() => {
		let isMounted = true;
		api.v2.guilds["server-types"]
			.get()
			.then((res) => {
				if (isMounted && res.data && "serverTypes" in res.data) {
					setServerTypes(res.data.serverTypes as ServerTypeMapping);
				}
			})
			.catch(() => {});
		return () => {
			isMounted = false;
		};
	}, []);

	const effectiveType =
		activeServerType ??
		(queryParams.type as string | undefined) ??
		(typeof window !== "undefined"
			? sessionStorage.getItem(`sentinel_server_type_${guildId}`)
			: null);

	const isMerc =
		effectiveType === "merc" ||
		(!effectiveType &&
			Boolean(
				serverTypes.merc &&
					guildId === serverTypes.merc &&
					serverTypes.faction !== guildId,
			));
	const isFaction =
		effectiveType === "faction" ||
		(!effectiveType &&
			Boolean(
				serverTypes.faction &&
					guildId === serverTypes.faction &&
					serverTypes.merc !== guildId,
			));
	const isAlliance =
		effectiveType === "alliance" ||
		(!effectiveType &&
			Boolean(serverTypes.alliance && guildId === serverTypes.alliance));

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

	const makeHref = (subPath: string) => {
		const base =
			subPath === "" ? `/guilds/${guildId}` : `/guilds/${guildId}${subPath}`;
		return effectiveType ? `${base}?type=${effectiveType}` : base;
	};

	const featureItems: NavItem[] = isMerc
		? [
				{
					label: "Contracts",
					href: makeHref("/contracts"),
					icon: ShieldAlert,
					accent: "text-amber-600 dark:text-amber-400",
				},
				{
					label: "Channel Selections",
					href: makeHref("/channels"),
					icon: Hash,
					accent: "text-emerald-400",
				},
				{
					label: "Verification",
					href: makeHref("/verification"),
					icon: UserCheck,
					accent: "text-blue-400",
				},
			]
		: isFaction
			? [
					{
						label: "Territory",
						href: makeHref("/territory"),
						icon: MapPin,
						accent: "text-purple-400",
					},
					{
						label: "Verification",
						href: makeHref("/verification"),
						icon: UserCheck,
						accent: "text-blue-400",
					},
					{
						label: "Recruitment",
						href: makeHref("/recruitment"),
						icon: UserPlus,
						accent: "text-emerald-400",
					},
				]
			: isAlliance
				? [
						{
							label: "Territory",
							href: makeHref("/territory"),
							icon: MapPin,
							accent: "text-purple-400",
						},
						{
							label: "Verification",
							href: makeHref("/verification"),
							icon: UserCheck,
							accent: "text-blue-400",
						},
						{
							label: "Reaction Roles",
							href: makeHref("/reaction-roles"),
							icon: Smile,
							accent: "text-amber-400",
						},
					]
				: [
						{
							label: "Territory",
							href: makeHref("/territory"),
							icon: MapPin,
							accent: "text-purple-400",
						},
						{
							label: "Verification",
							href: makeHref("/verification"),
							icon: UserCheck,
							accent: "text-blue-400",
						},
						{
							label: "Reaction Roles",
							href: makeHref("/reaction-roles"),
							icon: Smile,
							accent: "text-amber-400",
						},
					];

	const sections: NavSection[] = [
		{
			title: "Core",
			items: [
				{
					label: "General Settings",
					href: makeHref(""),
					icon: Settings,
				},
			],
		},
		{
			title: isMerc
				? "Mercenary Features"
				: isFaction
					? "Faction Features"
					: isAlliance
						? "Alliance Features"
						: "Server Features",
			items: featureItems,
		},
	];

	// Ranked-war features are only meaningful on faction dashboards, where the
	// family factions (Subversive Alliance / SA Succession) run the script.
	if (isFaction) {
		sections.push({
			title: "RW Features",
			items: [
				{
					label: "Channel Selections",
					href: makeHref("/rw-channels"),
					icon: Hash,
					accent: "text-emerald-400",
				},
				{
					label: "Dibs",
					href: makeHref("/dibs"),
					icon: Target,
					accent: "text-amber-400",
				},
			],
		});
	}

	const isActive = (itemHref: string, exact?: boolean) => {
		const cleanItemPath = itemHref.split("?")[0] ?? itemHref;
		if (exact) return path === cleanItemPath;
		return path === cleanItemPath || path.startsWith(`${cleanItemPath}/`);
	};

	const handleNav = (href: string) => {
		navigate(href);
		onNavigate?.();
	};

	return (
		<aside className="w-64 lg:w-72 bg-card/70 backdrop-blur-xl border-r border-border/80 p-4 flex flex-col justify-between h-full shrink-0 select-none">
			{/* Top Branding & Server Selection */}
			<div className="flex flex-col gap-4 pb-4 border-b border-border/40">
				<div className="flex items-center justify-between gap-2">
					<button
						type="button"
						onClick={() => handleNav("/")}
						className="flex items-center gap-2.5 cursor-pointer border-0 bg-transparent p-0 group"
						aria-label="Go to home"
					>
						<Avatar className="size-8 border border-border shadow-xs bg-card">
							<AvatarImage
								src={logoImg}
								alt="Sentinel Logo"
								className="object-contain"
							/>
							<AvatarFallback className="font-mono text-xs">ST</AvatarFallback>
						</Avatar>
						<span className="font-bold text-base text-foreground tracking-tight font-mono uppercase group-hover:text-primary transition-colors">
							Sentinel
						</span>
						{isMerc ? (
							<Badge
								variant="outline"
								className="text-[9px] font-mono px-1.5 py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
							>
								MERCENARY
							</Badge>
						) : isFaction ? (
							<Badge
								variant="outline"
								className="text-[9px] font-mono px-1.5 py-0 bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30"
							>
								FACTION
							</Badge>
						) : isAlliance ? (
							<Badge
								variant="outline"
								className="text-[9px] font-mono px-1.5 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30"
							>
								ALLIANCE
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="text-[9px] font-mono px-1.5 py-0"
							>
								{APP_VERSION}
							</Badge>
						)}
					</button>
				</div>

				<Button
					variant="outline"
					size="sm"
					onClick={() => handleNav("/")}
					className="text-xs w-fit justify-start gap-2 rounded-xl text-muted-foreground hover:text-foreground cursor-pointer"
				>
					<ArrowLeft className="size-3.5" data-icon="inline-start" />
					All Servers
				</Button>
			</div>

			{/* Navigation List */}
			<div className="flex-1 overflow-y-auto py-4 space-y-6">
				{sections.map((sec) => (
					<div key={sec.title} className="flex flex-col gap-1.5">
						<div className="px-3 pt-1">
							<span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/70 font-bold">
								{sec.title}
							</span>
						</div>

						<nav className="flex flex-col gap-1">
							{sec.items.map((item) => {
								const Icon = item.icon;
								const cleanPath = item.href.split("?")[0] ?? item.href;
								const active = isActive(
									item.href,
									cleanPath === `/guilds/${guildId}`,
								);

								return (
									<Button
										key={item.href}
										type="button"
										variant={active ? "secondary" : "ghost"}
										onClick={() => handleNav(item.href)}
										className={`group w-full justify-between h-9 px-3 rounded-xl text-xs font-medium transition-all duration-150 cursor-pointer ${
											active
												? "bg-primary/15 text-primary border border-primary/30 shadow-xs font-semibold hover:bg-primary/20"
												: "text-muted-foreground hover:bg-accent/60 hover:text-foreground border border-transparent"
										}`}
										aria-current={active ? "page" : undefined}
									>
										<div className="flex items-center gap-2.5">
											<Icon
												className={`size-4 transition-colors ${
													active
														? "text-primary"
														: "text-muted-foreground group-hover:text-foreground"
												}`}
											/>
											<span>{item.label}</span>
										</div>
										<ChevronRight
											className={`size-3.5 transition-transform ${
												active
													? "text-primary translate-x-0.5"
													: "text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5"
											}`}
										/>
									</Button>
								);
							})}
						</nav>
					</div>
				))}
			</div>

			{/* Footer User & Theme Controls */}
			<div className="pt-3 border-t border-border/40 flex items-center justify-between gap-2">
				{authenticated && user ? (
					<div className="flex items-center gap-2 min-w-0 flex-1">
						<Avatar className="size-6 border border-border shrink-0">
							{avatarUrl ? (
								<AvatarImage src={avatarUrl} alt={user.username} />
							) : null}
							<AvatarFallback className="text-[9px] font-mono">
								{user.username.charAt(0).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<span className="text-xs font-medium text-foreground truncate min-w-0">
							{user.username}
						</span>
					</div>
				) : null}

				<div className="flex items-center gap-2 shrink-0">
					<Button
						variant="ghost"
						size="icon"
						onClick={toggle}
						aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						className="size-8 rounded-full cursor-pointer border border-border/60 bg-background/50 hover:bg-accent hover:text-foreground shadow-xs"
					>
						{theme === "dark" ? (
							<Sun className="size-3.5" />
						) : (
							<Moon className="size-3.5" />
						)}
					</Button>

					{authenticated && (
						<Button
							variant="ghost"
							size="icon"
							onClick={() => void logout()}
							title="Sign out"
							aria-label="Sign out"
							className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border/60 bg-background/50 rounded-full cursor-pointer shadow-xs"
						>
							<LogOut className="size-3.5" />
						</Button>
					)}
				</div>
			</div>
		</aside>
	);
}
