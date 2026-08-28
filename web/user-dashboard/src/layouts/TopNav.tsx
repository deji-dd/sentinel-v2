import { Menu, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";

interface TopNavProps {
	onMenuToggle?: () => void;
	onToggleCollapse?: () => void;
	isCollapsed?: boolean;
	onSearchClick?: () => void;
}

export function TopNav({
	onMenuToggle,
	onToggleCollapse,
	isCollapsed,
}: TopNavProps) {
	const { theme, toggle } = useTheme();

	return (
		<header className="sticky top-0 z-40 h-15 bg-background/80 backdrop-blur-xl border-b border-border/80 flex items-center px-4 lg:pe-8 lg:ps-2 justify-between gap-4 text-foreground">
			{/* Left: Mobile trigger & Desktop Collapse toggle */}
			<div className="flex items-center gap-2">
				{onMenuToggle && (
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onMenuToggle}
						className="lg:hidden cursor-pointer"
						aria-label="Toggle mobile sidebar navigation"
					>
						<Menu className="size-4" />
					</Button>
				)}

				{onToggleCollapse && (
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onToggleCollapse}
						className="hidden lg:flex cursor-pointer text-muted-foreground hover:text-foreground"
						aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
						title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
					>
						{isCollapsed ? (
							<PanelLeftOpen className="size-4" />
						) : (
							<PanelLeftClose className="size-4" />
						)}
					</Button>
				)}
			</div>

			{/* Right: Search, Theme Switcher & Profile */}
			<div className="flex items-center gap-2.5">
				{/* Theme Toggle Button */}
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={toggle}
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					className="cursor-pointer border border-border/70 bg-card/60 hover:bg-accent hover:border-primary/40 rounded-xl"
				>
					{theme === "dark" ? (
						<Sun className="size-4 text-amber-400 transition-transform hover:rotate-45" />
					) : (
						<Moon className="size-4 text-sky-500 transition-transform hover:-rotate-12" />
					)}
				</Button>
			</div>
		</header>
	);
}
