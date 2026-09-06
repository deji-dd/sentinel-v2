import { Gift, LayoutDashboard, LogOut, Package, Sliders } from "lucide-react";
import type * as React from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";
import { useAuth } from "../contexts/AuthContext";
import { useElims } from "../contexts/ElimsContext";
import { useRouter } from "../router";

export type DashboardView =
	| "overview"
	| "guild-config"
	| "item-requests"
	| "giveaways";

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
	activeView: DashboardView;
	onSelectView: (view: DashboardView) => void;
}

export function AppSidebar({
	activeView,
	onSelectView,
	...props
}: AppSidebarProps) {
	const { user, logout } = useAuth();
	const { isOwner } = useElims();
	const { navigate } = useRouter();

	const userInitials = (user?.username ?? "U").slice(0, 2).toUpperCase();

	return (
		<Sidebar variant="inset" collapsible="icon" {...props}>
			{/* Brand and Guild Header */}
			<SidebarHeader className="border-b border-sidebar-border gap-3 p-3 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:py-2.5">
				{/* Sentinel Logo & Title */}
				<div className="flex items-center gap-2.5 px-1 py-0.5 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center">
					<Avatar className="size-8 rounded-lg border border-sidebar-border bg-sidebar-accent shrink-0">
						<AvatarImage src="/logo.png" alt="Sentinel Logo" />
						<AvatarFallback className="font-mono text-xs font-bold">
							SE
						</AvatarFallback>
					</Avatar>
					<div className="flex flex-col min-w-0 group-data-[collapsible=icon]:hidden">
						<div className="flex items-center gap-1.5">
							<span className="font-mono font-bold text-sm tracking-tight text-sidebar-foreground">
								SENTINEL
							</span>
							<Badge
								variant="secondary"
								className="text-[9px] font-mono px-1 py-0 h-4"
							>
								ELIMS
							</Badge>
						</div>
					</div>
				</div>
			</SidebarHeader>

			{/* Navigation Groups */}
			<SidebarContent className="p-2 gap-4 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:py-2 group-data-[collapsible=icon]:gap-1">
				{/* Administration */}
				<SidebarGroup>
					<SidebarGroupLabel className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground px-2">
						Server Administration
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={activeView === "guild-config"}
									onClick={() => {
										onSelectView("guild-config");
										navigate("/guild-config");
									}}
									tooltip="Guild Configuration"
									className="cursor-pointer"
								>
									<Sliders data-icon="inline-start" />
									<span>Guild Configuration</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>

				{/* Tournament Operations */}
				<SidebarGroup>
					<SidebarGroupLabel className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground px-2">
						Tournament Operations
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={activeView === "item-requests"}
									onClick={() => {
										onSelectView("item-requests");
										navigate("/item-requests");
									}}
									tooltip="Item Requests"
									className="cursor-pointer"
								>
									<Package data-icon="inline-start" />
									<span>Item Requests</span>
								</SidebarMenuButton>
							</SidebarMenuItem>

							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={activeView === "giveaways"}
									onClick={() => {
										onSelectView("giveaways");
										navigate("/giveaways");
									}}
									tooltip="Giveaways"
									className="cursor-pointer"
								>
									<Gift data-icon="inline-start" />
									<span>Giveaways</span>
								</SidebarMenuButton>
							</SidebarMenuItem>

							<SidebarMenuItem>
								<SidebarMenuButton
									disabled
									tooltip="Operations Overview (Coming Soon)"
									className="opacity-60 cursor-not-allowed pointer-events-none"
								>
									<LayoutDashboard data-icon="inline-start" />
									<span>Overview</span>
									<SidebarMenuBadge className="text-[9px] font-mono font-normal">
										Soon
									</SidebarMenuBadge>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			{/* User & Action Footer */}
			<SidebarFooter className="border-t border-sidebar-border p-3 gap-2 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:py-2.5">
				{/* User Profile Bar */}
				<div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:w-full">
					<div className="flex items-center gap-2 min-w-0 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center">
						<Avatar className="size-8 rounded-full border border-sidebar-border shrink-0">
							{user?.avatar && (
								<AvatarImage src={user.avatar} alt={user.username} />
							)}
							<AvatarFallback className="text-[10px] font-mono">
								{userInitials}
							</AvatarFallback>
						</Avatar>
						<div className="flex flex-col min-w-0 group-data-[collapsible=icon]:hidden">
							<span className="text-xs font-medium text-sidebar-foreground truncate">
								{user?.username}
							</span>
							<div className="flex items-center gap-1">
								{isOwner ? (
									<span className="text-[10px] font-mono text-primary font-semibold">
										Owner
									</span>
								) : (
									<span className="text-[10px] font-mono text-muted-foreground">
										Elims Admin
									</span>
								)}
							</div>
						</div>
					</div>

					<div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
						<ThemeToggle />
						<Button
							variant="ghost"
							size="icon-xs"
							onClick={logout}
							title="Sign Out"
							className="text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<LogOut className="size-3.5" data-icon="inline-start" />
						</Button>
					</div>
				</div>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
