import { BarChart3, LogIn, LogOut, Moon, Sun } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/hooks/useTheme";
import { NAV_ITEMS, type RouteKey } from "@/lib/navigation";
import { cn } from "@/lib/utils";

import { ScrollX } from "./ScrollX";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";

interface AppHeaderProps {
	route: RouteKey;
}

function initials(name: string | undefined): string {
	if (!name) return "Y";
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.charAt(0) ?? "";
	const second =
		parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
	return `${first}${second}`.toUpperCase() || "Y";
}

export function AppHeader({ route }: AppHeaderProps) {
	const { user, isAdmin, loginUrl, logout } = useAuth();
	const { theme, toggle } = useTheme();

	const avatarUrl =
		user?.discordId && user.avatar
			? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=64`
			: undefined;

	return (
		<header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/95 backdrop-blur">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6">
				<div className="flex min-w-0 items-center justify-between gap-3">
					<a
						href="#/"
						className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-primary">
							<BarChart3 className="size-4" />
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="truncate text-sm font-bold tracking-widest uppercase">
								YABA
							</span>
							<span className="truncate text-[10px] text-muted-foreground uppercase tracking-wider">
								Faction activity report
							</span>
						</span>
					</a>

					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={toggle}
							aria-label={
								theme === "dark" ? "Use light theme" : "Use dark theme"
							}
						>
							{theme === "dark" ? (
								<Sun className="size-4" />
							) : (
								<Moon className="size-4" />
							)}
						</Button>

						{user ? (
							<div className="flex min-w-0 items-center gap-2">
								<Avatar size="sm" className="shrink-0">
									{avatarUrl ? (
										<AvatarImage src={avatarUrl} alt={user.username} />
									) : null}
									<AvatarFallback>{initials(user.username)}</AvatarFallback>
								</Avatar>
								<span className="hidden max-w-32 truncate text-xs text-muted-foreground sm:inline">
									{user.username}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => void logout()}
									aria-label="Sign out"
								>
									<LogOut className="size-4" />
								</Button>
							</div>
						) : (
							<Button asChild size="sm" className="h-9">
								<a href={loginUrl}>
									<LogIn className="size-4 shrink-0" />
									<span className="sm:hidden">Sign in</span>
									<span className="hidden sm:inline">Sign in with Discord</span>
								</a>
							</Button>
						)}
					</div>
				</div>

				<ScrollX>
					<nav
						aria-label="Report sections"
						className="flex w-max items-center gap-1"
					>
						{NAV_ITEMS.filter((item) => item.key !== "admin" || isAdmin).map(
							(item) => (
								<Button
									asChild
									key={item.key}
									variant={route === item.key ? "secondary" : "ghost"}
									size="sm"
									className={cn("h-9", route === item.key && "text-primary")}
								>
									<a
										href={item.hash}
										aria-current={route === item.key ? "page" : undefined}
									>
										{item.label}
									</a>
								</Button>
							),
						)}
					</nav>
				</ScrollX>
			</div>
		</header>
	);
}
