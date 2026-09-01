import {
	Coins,
	Dumbbell,
	FileText,
	Fingerprint,
	LayoutDashboard,
	Moon,
	Sun,
	TrendingUp,
} from "lucide-react";
import type React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	Sidebar as SidebarPrimitive,
	SidebarRail,
} from "@/components/ui/sidebar";
import { useSystemHealth } from "@/hooks/useSystemHealth";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import { useRouter } from "@/router";
import logoImg from "../../public/logo.png";

interface NavItem {
	label: string;
	href: string;
	icon: React.ElementType;
	exact?: boolean;
}

interface NavGroup {
	title: string;
	items: NavItem[];
}

const navGroups: NavGroup[] = [
	{
		title: "Core",
		items: [
			{
				label: "System Overview",
				href: "/",
				icon: LayoutDashboard,
				exact: true,
			},
			{
				label: "Wealth",
				href: "/wealth",
				icon: Coins,
				exact: true,
			},
			{
				label: "Logs",
				href: "/logs",
				icon: FileText,
			},
			{
				label: "Crimes",
				href: "/crimes",
				icon: Fingerprint,
			},
			{
				label: "Battlestats",
				href: "/battlestats",
				icon: Dumbbell,
			},
			{
				label: "Stocks",
				href: "/stocks",
				icon: TrendingUp,
			},
		],
	},
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
	const { path, navigate } = useRouter();
	const { theme, toggle } = useTheme();
	const health = useSystemHealth();

	const isActive = (item: NavItem) => {
		if (item.exact) {
			return path === item.href;
		}
		return (
			path === item.href || (item.href !== "/" && path.startsWith(item.href))
		);
	};

	const handleNav = (href: string) => {
		navigate(href);
		onNavigate?.();
	};

	return (
		<SidebarPrimitive
			collapsible="icon"
			className="border-r border-sidebar-border/80 bg-sidebar/80 backdrop-blur-2xl select-none [&>[data-slot=sidebar-inner]]:bg-transparent"
		>
			{/* Top Branding */}
			<SidebarHeader className="border-b border-sidebar-border/60">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							onClick={() => handleNav("/")}
							className="group-data-[collapsible=icon]:p-0! data-[active=true]:bg-transparent hover:bg-accent/40 rounded-xl h-12"
							tooltip="Sentinel Dashboard"
							aria-label="Sentinel Dashboard Home"
						>
							<div className="size-8 shrink-0 flex items-center justify-center">
								<Avatar className="size-7 border border-border shadow-xs bg-card">
									<AvatarImage
										src={logoImg}
										alt="Sentinel Logo"
										className="object-contain"
									/>
									<AvatarFallback className="font-mono text-xs">
										ST
									</AvatarFallback>
								</Avatar>
							</div>
							<div className="flex items-center gap-1.5 leading-none">
								<span className="font-display font-bold text-sm tracking-tight group-hover/menu-button:text-primary transition-colors">
									SENTINEL
								</span>
								<span className="text-[10px] font-mono font-bold text-primary">
									v2
								</span>
							</div>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			{/* Navigation Groups */}
			<SidebarContent className="gap-3 px-2 py-2">
				{navGroups.map((group) => (
					<SidebarGroup key={group.title} className="p-0">
						<SidebarGroupLabel className="text-[10px] font-mono font-semibold uppercase tracking-widest text-muted-foreground/70 h-6">
							{group.title}
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{group.items.map((item) => {
									const Icon = item.icon;
									const active = isActive(item);

									return (
										<SidebarMenuItem key={item.href}>
											<SidebarMenuButton
												isActive={active}
												onClick={() => handleNav(item.href)}
												tooltip={item.label}
												className={cn(
													"h-10 rounded-xl text-xs font-medium border transition-colors cursor-pointer",
													active
														? "bg-primary/15 border-primary/35 text-primary font-semibold shadow-xs hover:bg-primary/20"
														: "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
												)}
												aria-current={active ? "page" : undefined}
											>
												<Icon
													className={cn(
														active
															? "text-primary"
															: "text-muted-foreground group-hover/menu-button:text-foreground",
													)}
												/>
												<span>{item.label}</span>
											</SidebarMenuButton>
										</SidebarMenuItem>
									);
								})}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>

			{/* Bottom Controls & Telemetry Card */}
			<SidebarFooter className="border-t border-sidebar-border/60">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							onClick={toggle}
							tooltip={
								theme === "dark"
									? "Switch to Light Mode"
									: "Switch to Dark Mode"
							}
							className="h-10 rounded-xl text-xs font-medium border border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors cursor-pointer"
							aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						>
							{theme === "dark" ? (
								<Sun className="size-4 text-amber-400 transition-transform duration-300 group-hover/menu-button:rotate-45" />
							) : (
								<Moon className="size-4 text-sky-500 transition-transform duration-300 group-hover/menu-button:-rotate-12" />
							)}
							<span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
						</SidebarMenuButton>
					</SidebarMenuItem>

					<SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
						<div
							className="flex h-10 w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-border/60 bg-background/50 backdrop-blur-md px-2.5 cursor-default"
							title={
								health.status === "online"
									? `HOST: ${health.host} (RTT ${health.rtt}ms • Bun v${health.bunVersion})`
									: health.status === "connecting"
										? "Connecting to /api/health..."
										: "API Service Offline"
							}
						>
							<div className="flex min-w-0 flex-col">
								<span className="truncate font-mono text-[10px] font-semibold text-foreground">
									{health.status === "online"
										? `HOST: ${health.host ?? "MAC-ARM64"}`
										: health.status === "connecting"
											? "HOST: CONNECTING..."
											: health.status === "degraded"
												? `HOST: ${health.host ?? "DEGRADED"}`
												: "HOST: UNREACHABLE"}
								</span>
								<span className="truncate font-mono text-[9px] text-muted-foreground">
									{health.status === "online"
										? `RTT ${health.rtt}ms • Bun v${health.bunVersion}`
										: health.status === "connecting"
											? "Probing /api/health..."
											: health.status === "degraded"
												? `${health.rtt !== null ? `RTT ${health.rtt}ms • ` : ""}API Degraded`
												: "API Service Offline"}
								</span>
							</div>
						</div>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>

			{/* Drag rail to toggle collapse */}
			<SidebarRail />
		</SidebarPrimitive>
	);
}
