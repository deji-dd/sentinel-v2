import { type ReactNode, useEffect, useRef, useState } from "react";
import { GlobalLoadingScreen } from "@/components/GlobalLoadingScreen";
import {
	SidebarInset,
	SidebarProvider,
	useSidebar,
} from "@/components/ui/sidebar";
import { useRouter } from "@/router";
import { Sidebar } from "./Sidebar";
import { TopNav } from "./TopNav";

interface DashboardLayoutProps {
	children: ReactNode;
	onSearchClick?: () => void;
}

const STORAGE_COLLAPSE_KEY = "sentinel-sidebar-collapsed";

function DashboardShell({ children, onSearchClick }: DashboardLayoutProps) {
	const { state, toggleSidebar } = useSidebar();
	const isCollapsed = state === "collapsed";
	const { path } = useRouter();
	const mainRef = useRef<HTMLElement>(null);

	useEffect(() => {
		mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
	}, [path]);

	return (
		<>
			<Sidebar />
			<SidebarInset className="h-svh overflow-hidden bg-background">
				<TopNav
					onMenuToggle={toggleSidebar}
					onToggleCollapse={toggleSidebar}
					isCollapsed={isCollapsed}
					onSearchClick={onSearchClick}
				/>
				<div className="relative flex-1 overflow-hidden">
					<main
						ref={mainRef}
						className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8 matrix-grid"
					>
						<div className="mx-auto max-w-7xl space-y-6">{children}</div>
					</main>
					<GlobalLoadingScreen />
				</div>
			</SidebarInset>
		</>
	);
}

export function DashboardLayout(props: DashboardLayoutProps) {
	const [open, setOpen] = useState<boolean>(() => {
		try {
			return localStorage.getItem(STORAGE_COLLAPSE_KEY) !== "true";
		} catch {
			return true;
		}
	});

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		try {
			localStorage.setItem(STORAGE_COLLAPSE_KEY, String(!next));
		} catch {
			// ignore
		}
	};

	return (
		<SidebarProvider open={open} onOpenChange={handleOpenChange}>
			<div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
				<DashboardShell {...props} />
			</div>
		</SidebarProvider>
	);
}
