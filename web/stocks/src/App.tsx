import { Menu, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import {
	Button,
	Sheet,
	SheetContent,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "./components/ui";
import { useAuth } from "./contexts/AuthContext";
import { Router, usePath } from "./router";

const LINKS = [
	{ href: "/", label: "Fund", ownerOnly: false },
	{ href: "/portfolio", label: "Portfolio", ownerOnly: false },
	{ href: "/desk", label: "Desk", ownerOnly: true },
];

export function isOwnerRole(role: string | null | undefined): boolean {
	return role === "owner" || role === "admin";
}

function ThemeToggle() {
	const [light, setLight] = useState(
		() => document.documentElement.getAttribute("data-theme") === "light",
	);
	useEffect(() => {
		const theme = light ? "light" : "dark";
		document.documentElement.classList.toggle("dark", !light);
		document.documentElement.setAttribute("data-theme", theme);
		localStorage.setItem("sentinel-theme", theme);
	}, [light]);
	return (
		<Button
			type="button"
			variant="outline"
			size="icon"
			onClick={() => setLight((value) => !value)}
			aria-label="Toggle theme"
		>
			{light ? <Moon className="size-4" /> : <Sun className="size-4" />}
		</Button>
	);
}

function linkClass(active: boolean, mobile = false): string {
	const base = mobile
		? "flex w-full items-center rounded-lg px-3 py-2.5 text-sm font-semibold"
		: "rounded-lg px-2.5 py-1.5 text-xs font-semibold";
	return active
		? `${base} bg-primary/10 text-primary`
		: `${base} text-muted-foreground hover:bg-accent hover:text-foreground`;
}

export function App() {
	const path = usePath();
	const { user, logout, loginWithDiscord } = useAuth();
	const [menuOpen, setMenuOpen] = useState(false);
	const owner = isOwnerRole(user?.role);
	const links = LINKS.filter((link) => !link.ownerOnly || owner);
	// `/paper` and `/desk/paper` were merged into tabs; keep old links on their
	// parent nav entry.
	const navPath =
		path === "/paper" ? "/" : path === "/desk/paper" ? "/desk" : path;
	// Longest matching prefix wins: `/desk/paper` must not also light up `/desk`.
	const activeHref = links
		.filter((link) =>
			link.href === "/"
				? navPath === "/"
				: navPath === link.href || navPath.startsWith(`${link.href}/`),
		)
		.sort((a, b) => b.href.length - a.href.length)[0]?.href;

	const isActive = (href: string) => href === activeHref;

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="border-b border-border/60 bg-background/80 backdrop-blur">
				<div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-4 py-3 sm:px-6 lg:px-8">
					<a href="#/" className="mr-2 shrink-0 font-display text-lg font-bold">
						Blasted <span className="text-primary">Stocks</span>
					</a>
					<nav className="ml-2 hidden flex-1 items-center gap-1 md:flex">
						{links.map((link) => (
							<a
								key={link.href}
								href={`#${link.href}`}
								aria-current={isActive(link.href) ? "page" : undefined}
								className={linkClass(isActive(link.href))}
							>
								{link.label}
							</a>
						))}
					</nav>
					<div className="ml-auto flex shrink-0 items-center gap-2">
						<ThemeToggle />
						{user ? (
							<>
								<span className="hidden max-w-36 truncate text-xs text-muted-foreground lg:inline">
									{user.username}
								</span>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="hidden md:inline-flex"
									onClick={() => void logout()}
								>
									Sign out
								</Button>
							</>
						) : (
							<Button
								type="button"
								size="sm"
								className="hidden md:inline-flex"
								onClick={() => loginWithDiscord("/portfolio")}
							>
								Sign in
							</Button>
						)}
						<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
							<SheetTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="md:hidden"
									aria-label="Open navigation"
								>
									<Menu className="size-4" />
								</Button>
							</SheetTrigger>
							<SheetContent side="right" className="w-72">
								<SheetHeader>
									<SheetTitle>Navigation</SheetTitle>
								</SheetHeader>
								<nav className="flex flex-col gap-1 px-4">
									{links.map((link) => (
										<a
											key={link.href}
											href={`#${link.href}`}
											aria-current={isActive(link.href) ? "page" : undefined}
											className={linkClass(isActive(link.href), true)}
											onClick={() => setMenuOpen(false)}
										>
											{link.label}
										</a>
									))}
								</nav>
								<SheetFooter>
									{user ? (
										<>
											<p className="truncate text-xs text-muted-foreground">
												Signed in as {user.username}
											</p>
											<Button
												type="button"
												variant="outline"
												onClick={() => {
													setMenuOpen(false);
													void logout();
												}}
											>
												Sign out
											</Button>
										</>
									) : (
										<Button
											type="button"
											onClick={() => {
												setMenuOpen(false);
												loginWithDiscord("/portfolio");
											}}
										>
											Sign in with Discord
										</Button>
									)}
								</SheetFooter>
							</SheetContent>
						</Sheet>
					</div>
				</div>
			</header>
			<main>
				<Router path={path} isOwner={owner} />
			</main>
			<footer className="border-t border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">
				Made with {"<"}3 by{" "}
				<a
					href="https://www.torn.com/profiles.php?XID=1934909"
					className="text-primary underline"
				>
					Blasted
				</a>{" "}
				<br />
			</footer>
		</div>
	);
}
