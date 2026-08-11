import { LogOut, Menu, Moon, Sun } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import logoImg from "../../public/logo.png";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useRouter } from "../router";

interface TopNavProps {
	onMenuToggle?: () => void;
}

export function TopNav({ onMenuToggle }: TopNavProps) {
	const { user, authenticated, logout } = useAuth();
	const { theme, toggle } = useTheme();
	const { navigate } = useRouter();

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
		<header className="sticky top-0 z-40 h-16 bg-background/80 backdrop-blur-xl border-b border-border/80 flex items-center px-6 justify-between gap-4 text-foreground">
			{/* Left: Logo + hamburger */}
			<div className="flex items-center gap-3">
				{onMenuToggle && (
					<Button
						variant="ghost"
						size="icon"
						onClick={onMenuToggle}
						className="lg:hidden size-9 rounded-full cursor-pointer"
						id="sidebar-menu-toggle"
						aria-label="Toggle sidebar"
					>
						<Menu className="size-4" />
					</Button>
				)}

				<button
					type="button"
					onClick={() => navigate("/")}
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
						className="text-[9px] font-mono px-1.5 py-0 hidden sm:inline-flex"
					>
						v2.4
					</Badge>
				</button>
			</div>

			{/* Right: Controls */}
			<div className="flex items-center gap-3">
				{/* User info */}
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

				{/* Theme toggle */}
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
		</header>
	);
}
