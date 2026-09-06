import type { ReactNode } from "react";
import { AppSidebar, type DashboardView } from "@/components/AppSidebar";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";

interface DashboardLayoutProps {
	activeView: DashboardView;
	onSelectView: (view: DashboardView) => void;
	children: ReactNode;
}

export function DashboardLayout({
	activeView,
	onSelectView,
	children,
}: DashboardLayoutProps) {
	return (
		<SidebarProvider className="h-svh overflow-hidden">
			<AppSidebar activeView={activeView} onSelectView={onSelectView} />
			<SidebarInset className="h-[calc(100svh-1rem)] overflow-hidden flex flex-col">
				{/* Top Inset Header */}
				<header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
					<div className="flex items-center gap-2">
						<SidebarTrigger className="-ml-1 cursor-pointer" />
					</div>
				</header>

				{/* Inset Content Area - scrollable within fixed inset */}
				<div className="flex-1 overflow-y-auto p-4 md:p-6 bg-background/50">
					{children}
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
