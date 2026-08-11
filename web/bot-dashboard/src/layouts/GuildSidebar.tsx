import {
	ArrowLeft,
	ChevronRight,
	Lock,
	LogOut,
	MapPin,
	Moon,
	Settings,
	Sliders,
	Smile,
	Sun,
	UserCheck,
} from "lucide-react";
import type React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import logoImg from "../../public/logo.png";
import { APP_VERSION } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
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
	enabledModules: string[];
	isBotOwner: boolean;
	onNavigate?: () => void;
}

export function GuildSidebar({
	guildId,
	enabledModules,
	isBotOwner,
	onNavigate,
}: GuildSidebarProps) {
	const { path, navigate } = useRouter();
	const { user, authenticated, logout } = useAuth();
	const { theme, toggle } = useTheme();

	const isModuleEnabled = (key: string) => enabledModules.includes(key);

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

	const sections: NavSection[] = [
		{
			title: "Core",
			items: [
				{
					label: "General Settings",
					href: `/guilds/${guildId}`,
					icon: Settings,
				},
			],
		},
		{
			title: "Modules",
			items: [
				{
					label: "Verification",
					href: `/guilds/${guildId}/verification`,
					icon: UserCheck,
					accent: "text-blue-400",
					locked: !isModuleEnabled("verification"),
				},
				{
					label: "Territory",
					href: `/guilds/${guildId}/territory`,
					icon: MapPin,
					accent: "text-purple-400",
					locked: !isModuleEnabled("territory"),
				},
				{
					label: "Reaction Roles",
					href: `/guilds/${guildId}/reaction-roles`,
					icon: Smile,
					accent: "text-amber-400",
					locked: !isModuleEnabled("reaction_role"),
				},
			],
		},
		...(isBotOwner
			? [
					{
						title: "System Administration",
						items: [
							{
								label: "Module Manager",
								href: `/guilds/${guildId}/modules`,
								icon: Sliders,
							},
						],
					},
				]
			: []),
	];

	const isActive = (href: string, exact?: boolean) => {
		const hashPath = path;
		if (exact) return hashPath === href;
		return hashPath === href || hashPath.startsWith(`${href}/`);
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
						<Badge
							variant="outline"
							className="text-[9px] font-mono px-1.5 py-0"
						>
							{APP_VERSION}
						</Badge>
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
								const active = isActive(
									item.href,
									item.href === `/guilds/${guildId}`,
								);

								if (item.locked) {
									return (
										<Button
											key={item.href}
											variant="ghost"
											disabled
											title="Module disabled for this server"
											className="w-full justify-between h-9 px-3 rounded-xl text-xs font-medium text-muted-foreground/50 cursor-not-allowed select-none bg-background/30 border border-transparent opacity-60"
										>
											<div className="flex items-center gap-2.5">
												<Icon className="size-4 text-muted-foreground/50" />
												<span>{item.label}</span>
											</div>
											<Lock className="size-3.5 text-muted-foreground/50" />
										</Button>
									);
								}

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
