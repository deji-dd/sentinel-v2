import { useEffect, useState } from "react";

import { useAuth } from "./contexts/AuthContext";
import { DeskPage } from "./pages/DeskPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { PublicPage } from "./pages/PublicPage";

export function getPath(): string {
	const hash = window.location.hash;
	if (hash.startsWith("#")) return hash.slice(1) || "/";
	return window.location.pathname === "/" ? "/" : window.location.pathname;
}

export function usePath(): string {
	const [path, setPath] = useState(getPath);
	useEffect(() => {
		const update = () => setPath(getPath());
		window.addEventListener("hashchange", update);
		window.addEventListener("popstate", update);
		return () => {
			window.removeEventListener("hashchange", update);
			window.removeEventListener("popstate", update);
		};
	}, []);
	return path;
}

export function LoginPage() {
	const { loginWithDiscord, authenticated } = useAuth();
	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-4 text-center">
			<p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
				Sentinel Capital
			</p>
			<h1 className="mt-2 font-display text-3xl font-bold">
				Sign in to your portfolio
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Discord is used only to identify your account. The public fund page
				never requires login.
			</p>
			<button
				type="button"
				onClick={() => loginWithDiscord("/portfolio")}
				className="mt-5 inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
			>
				{authenticated ? "Open portfolio" : "Continue with Discord"}
			</button>
			<a
				href="#/"
				className="mt-4 text-xs text-muted-foreground underline-offset-4 hover:underline"
			>
				Back to the public fund page
			</a>
		</div>
	);
}

export function Router({ path }: { path: string }) {
	if (path === "/portfolio") return <PortfolioPage />;
	if (path === "/desk" || path === "/desk/") return <DeskPage book="live" />;
	if (path === "/desk/paper") return <DeskPage book="paper" />;
	if (path === "/login") return <LoginPage />;
	return <PublicPage />;
}
