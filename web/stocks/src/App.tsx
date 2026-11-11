import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import { useAuth } from "./contexts/AuthContext";
import { Router, usePath } from "./router";

const LINKS = [
	{ href: "/", label: "Fund", ownerOnly: false },
	{ href: "/portfolio", label: "Portfolio", ownerOnly: false },
	{ href: "/paper", label: "Paper", ownerOnly: false },
	{ href: "/desk", label: "Desk", ownerOnly: true },
	{ href: "/desk/paper", label: "Paper desk", ownerOnly: true },
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

export function App() {
	const path = usePath();
	const { user, logout, loginWithDiscord } = useAuth();
	const owner = isOwnerRole(user?.role);
	const links = LINKS.filter((link) => !link.ownerOnly || owner);
	// Longest matching prefix wins: `/desk/paper` must not also light up `/desk`.
	const activeHref = links
		.filter((link) =>
			link.href === "/"
				? path === "/"
				: path === link.href || path.startsWith(`${link.href}/`),
		)
		.sort((a, b) => b.href.length - a.href.length)[0]?.href;

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="border-b border-border/60 bg-background/80 backdrop-blur">
				<div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6 lg:px-8">
					<a href="#/" className="mr-2 font-display text-lg font-bold">
						Blasted <span className="text-primary">Stocks</span>
					</a>
					<nav className="flex flex-1 flex-wrap items-center gap-1">
						{links.map((link) => {
							const active = link.href === activeHref;
							return (
								<a
									key={link.href}
									href={`#${link.href}`}
									aria-current={active ? "page" : undefined}
									className={
										active
											? "rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary"
											: "rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
									}
								>
									{link.label}
								</a>
							);
						})}
					</nav>
					<div className="flex items-center gap-2">
						<ThemeToggle />
						{user ? (
							<>
								<span className="hidden max-w-36 truncate text-xs text-muted-foreground sm:inline">
									{user.username}
								</span>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void logout()}
								>
									Sign out
								</Button>
							</>
						) : (
							<Button
								type="button"
								size="sm"
								onClick={() => loginWithDiscord("/portfolio")}
							>
								Sign in
							</Button>
						)}
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
