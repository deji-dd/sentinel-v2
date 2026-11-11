import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuth } from "./contexts/AuthContext";
import { getPath, Router, usePath } from "./router";

const LINKS = [
	{ href: "/", label: "Fund" },
	{ href: "/portfolio", label: "Portfolio" },
	{ href: "/desk", label: "Desk" },
	{ href: "/desk/paper", label: "Paper" },
];

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
		<button
			type="button"
			onClick={() => setLight((value) => !value)}
			aria-label="Toggle theme"
			className="inline-flex size-9 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
		>
			{light ? <Moon className="size-4" /> : <Sun className="size-4" />}
		</button>
	);
}

export function App() {
	const path = usePath();
	const { user, logout, loginWithDiscord } = useAuth();

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="border-b border-border/60 bg-background/80 backdrop-blur">
				<div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6 lg:px-8">
					<a href="#/" className="mr-2 font-display text-lg font-bold">
						Sentinel <span className="text-primary">Capital</span>
					</a>
					<nav className="flex flex-1 flex-wrap items-center gap-1">
						{LINKS.map((link) => {
							const active =
								link.href === "/"
									? path === "/"
									: path === link.href || path.startsWith(`${link.href}/`);
							return (
								<a
									key={link.href}
									href={`#${link.href}`}
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
								<button
									type="button"
									onClick={() => void logout()}
									className="inline-flex h-9 items-center rounded-lg border border-border/60 px-2.5 text-xs font-semibold hover:bg-accent"
								>
									Sign out
								</button>
							</>
						) : (
							<button
								type="button"
								onClick={() => loginWithDiscord("/portfolio")}
								className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
							>
								Sign in
							</button>
						)}
					</div>
				</div>
			</header>
			<main>
				<Router path={path === "/" ? "/" : getPath()} />
			</main>
			<footer className="border-t border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">
				Sentinel Capital is a game fund. Not financial advice. Capital is held
				in Torn City and payouts are executed manually.
			</footer>
		</div>
	);
}
