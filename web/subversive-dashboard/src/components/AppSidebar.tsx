import { LogOut, UserPlus } from "lucide-react";
import type * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";
import { useAuth } from "../contexts/AuthContext";
import { useSubversive } from "../contexts/SubversiveContext";
import { useRouter } from "../router";

export type DashboardView = "recruitment";

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
	const { guild } = useSubversive();
	const { navigate } = useRouter();

	const userInitials = (user?.username ?? "U").slice(0, 2).toUpperCase();

	return (
		<Sidebar variant="inset" collapsible="icon" {...props}>
			{/* Brand and Guild Header */}
			<SidebarHeader className="border-b border-sidebar-border gap-3 p-3 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:py-2.5">
				<div className="flex items-center gap-2.5 px-1 py-0.5 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center">
					<Avatar className="size-8 rounded-lg border border-sidebar-border bg-sidebar-accent shrink-0">
						{guild?.icon ? (
							<AvatarImage src={guild.icon} alt={guild.name} />
						) : null}
						<AvatarFallback className="font-mono text-xs font-bold">
							SA
						</AvatarFallback>
					</Avatar>
					<div className="flex flex-col min-w-0 group-data-[collapsible=icon]:hidden">
						<div className="flex items-center gap-1.5">
							<span className="font-mono font-bold text-sm tracking-tight text-sidebar-foreground">
								Subversive Alliance
							</span>
						</div>
					</div>
				</div>
			</SidebarHeader>

			{/* Navigation Groups */}
			<SidebarContent className="p-2 gap-4 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:py-2 group-data-[collapsible=icon]:gap-1">
				<SidebarGroup>
					<SidebarGroupLabel className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground px-2">
						Operations
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={activeView === "recruitment"}
									onClick={() => {
										onSelectView("recruitment");
										navigate("/recruitment");
									}}
									tooltip="Recruitment"
									className="cursor-pointer"
								>
									<UserPlus data-icon="inline-start" />
									<span>Recruitment</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			{/* Footer: User Profile & Logout */}
			<SidebarFooter className="border-t border-sidebar-border p-3 group-data-[collapsible=icon]:p-2">
				<div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
					<div className="flex items-center gap-2.5 min-w-0">
						<Avatar className="size-8 rounded-full border border-sidebar-border shrink-0">
							{user?.avatar ? (
								<AvatarImage src={user.avatar} alt={user.username} />
							) : null}
							<AvatarFallback className="font-mono text-xs font-bold">
								{userInitials}
							</AvatarFallback>
						</Avatar>
						<div className="flex flex-col min-w-0 group-data-[collapsible=icon]:hidden">
							<span className="text-xs font-medium text-sidebar-foreground truncate">
								{user?.username ?? "Authenticated User"}
							</span>
							<span className="text-[10px] text-muted-foreground capitalize">
								{user?.role ?? "Member"}
							</span>
						</div>
					</div>

					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => void logout()}
						className="text-muted-foreground hover:text-destructive group-data-[collapsible=icon]:hidden cursor-pointer"
						title="Log out"
					>
						<LogOut className="size-4" />
					</Button>
				</div>
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}
