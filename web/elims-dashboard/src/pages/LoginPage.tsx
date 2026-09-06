import { AlertTriangle, ArrowRight } from "lucide-react";
import { useEffect, useMemo } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "../contexts/AuthContext";
import { useRouter } from "../router";

export function LoginPage() {
	const { authenticated, loading, loginWithDiscord, refresh } = useAuth();
	const { navigate } = useRouter();

	const handleDemoLogin = async (username: string, role: string) => {
		try {
			if (role === "owner") {
				// Reset any configured elims guild so owner always enters the guild setup/init page
				await fetch("/api/v1/elims/reset", { method: "POST" });
			}

			const res = await fetch("/api/v1/auth/demo-login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, role }),
			});
			const data = (await res.json()) as {
				success: boolean;
				sessionId?: string;
			};
			if (data.success && data.sessionId) {
				// biome-ignore lint/suspicious/noDocumentCookie: client session token handover across dev
				document.cookie = `session=${data.sessionId}; path=/; max-age=${7 * 86400}; SameSite=Lax`;
				await refresh();
			}
		} catch (err) {
			console.error("Demo login failed:", err);
		}
	};

	const errorMessage = useMemo(() => {
		const rawQuery =
			window.location.search ||
			(window.location.hash.includes("?")
				? (window.location.hash.split("?")[1] ?? "")
				: "");
		const params = new URLSearchParams(rawQuery);
		const err = params.get("error");

		if (err === "no_mutual_server") {
			return "Access Restricted: Your Discord account does not share any servers with Sentinel. You must be a member of a server where Sentinel is installed to access the Elims Dashboard.";
		}
		if (err === "access_denied") {
			return "Discord authorization was denied or cancelled.";
		}
		if (err === "token_exchange_failed" || err === "user_fetch_failed") {
			return "Failed to complete Discord authorization. Please try again.";
		}
		if (err) {
			return `Authentication failed: ${err}`;
		}
		return null;
	}, []);

	useEffect(() => {
		if (!loading && authenticated) {
			navigate("/");
		}
	}, [loading, authenticated, navigate]);

	return (
		<main className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background text-foreground relative overflow-hidden">
			{/* Theme Switcher in Top Right */}
			<div className="absolute top-4 right-4 z-20">
				<ThemeToggle />
			</div>

			{/* Ambient background accent */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[500px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

			<div className="w-full max-w-md flex flex-col gap-6 relative z-10">
				{/* App Branding */}
				<div className="flex flex-col items-center gap-3 text-center">
					<Avatar
						size="lg"
						className="size-16 border border-border shadow-md bg-card"
					>
						<AvatarImage
							src="/logo.png"
							alt="Sentinel Logo"
							className="object-contain"
						/>
						<AvatarFallback className="font-mono font-bold text-xs">
							EL
						</AvatarFallback>
					</Avatar>
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight text-foreground font-mono uppercase">
							Sentinel
						</h1>
						<Badge
							variant="outline"
							className="text-[10px] font-mono px-2 py-0.5"
						>
							Elims
						</Badge>
					</div>
					<p className="text-xs text-muted-foreground">Nine Lives</p>
				</div>

				{/* Error Alert */}
				{errorMessage && (
					<Alert variant="destructive">
						<AlertTriangle className="size-4" />
						<AlertTitle>Access Notice</AlertTitle>
						<AlertDescription>{errorMessage}</AlertDescription>
					</Alert>
				)}

				{/* Login Card */}
				<Card className="border-border/80 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardHeader className="text-center gap-1.5 px-6 py-0">
						<CardTitle className="text-xl font-semibold tracking-tight">
							Sign In
						</CardTitle>
					</CardHeader>

					<CardContent className="flex flex-col gap-4 p-6 pt-0">
						<Button
							size="lg"
							onClick={loginWithDiscord}
							className="w-full h-12 text-sm font-semibold bg-[#5865f2] hover:bg-[#4752c4] text-white shadow-lg cursor-pointer rounded-xl transition-all"
						>
							<svg
								className="size-5 fill-current shrink-0"
								viewBox="0 0 24 24"
								aria-hidden="true"
								data-icon="inline-start"
							>
								<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.893.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
							</svg>
							Continue with Discord
							<ArrowRight className="size-4" data-icon="inline-end" />
						</Button>

						{import.meta.env.DEV && (
							<div className="flex flex-col gap-2 pt-3 border-t border-border/60">
								<p className="text-[10px] uppercase font-mono tracking-wider text-muted-foreground text-center">
									Dev Quick Sign-in
								</p>
								<div className="grid grid-cols-2 gap-2">
									<Button
										variant="outline"
										size="sm"
										id="demo-login-owner"
										className="text-xs cursor-pointer"
										onClick={() => handleDemoLogin("Owner_Dev", "owner")}
									>
										Owner (Admin)
									</Button>
									<Button
										variant="outline"
										size="sm"
										id="demo-login-user"
										className="text-xs cursor-pointer"
										onClick={() => handleDemoLogin("Player_Dev", "user")}
									>
										Standard User
									</Button>
								</div>
							</div>
						)}
					</CardContent>
				</Card>

				{/* Footer */}
				<footer className="text-center text-xs text-muted-foreground font-mono">
					Property of Blasted
				</footer>
			</div>
		</main>
	);
}
