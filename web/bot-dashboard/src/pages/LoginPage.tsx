import { AlertCircle, ArrowRight, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import logoImg from "../../public/logo.png";
import { APP_VERSION } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useRouter } from "../router";

export default function LoginPage() {
	const { authenticated, loading } = useAuth();
	const { theme, toggle } = useTheme();
	const { navigate } = useRouter();

	const error = (() => {
		const searchParams = new URLSearchParams(window.location.search);
		if (searchParams.has("error")) return searchParams.get("error");
		const hash = window.location.hash;
		const qIdx = hash.indexOf("?");
		if (qIdx !== -1) {
			const params = new URLSearchParams(hash.slice(qIdx + 1));
			return params.get("error");
		}
		return null;
	})();

	const redirectTo = (() => {
		const searchParams = new URLSearchParams(window.location.search);
		if (searchParams.has("redirect_to")) return searchParams.get("redirect_to");
		const hash = window.location.hash;
		const qIdx = hash.indexOf("?");
		if (qIdx !== -1) {
			const params = new URLSearchParams(hash.slice(qIdx + 1));
			if (params.has("redirect_to")) return params.get("redirect_to");
		}
		const stored = sessionStorage.getItem("sentinel_redirect_to");
		if (stored && stored !== "/login") return stored;
		return "/";
	})();

	const loginUrl =
		redirectTo && redirectTo !== "/"
			? `/api/v1/auth/discord?redirect_to=${encodeURIComponent(redirectTo)}`
			: "/api/v1/auth/discord";

	useEffect(() => {
		if (!loading && authenticated) {
			const destination = redirectTo && redirectTo !== "/" ? redirectTo : "/";
			sessionStorage.removeItem("sentinel_redirect_to");
			navigate(destination);
		}
	}, [loading, authenticated, navigate, redirectTo]);

	return (
		<div className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background text-foreground font-sans relative overflow-hidden">
			{/* Theme Switcher in Top Right */}
			<div className="absolute top-4 right-4 z-20">
				<Button
					variant="ghost"
					size="icon"
					onClick={toggle}
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					className="size-9 rounded-full cursor-pointer shadow-sm"
				>
					{theme === "dark" ? (
						<Sun className="size-4" />
					) : (
						<Moon className="size-4" />
					)}
				</Button>
			</div>

			{/* Subtle Radial Glow */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

			<div className="w-full max-w-md flex flex-col gap-6 relative z-10">
				{/* Top App Branding with Shadcn Avatar */}
				<div className="flex flex-col items-center gap-3 text-center">
					<Avatar
						size="lg"
						className="size-14 border border-border shadow-lg bg-card"
					>
						<AvatarImage
							src={logoImg}
							alt="Sentinel Logo"
							className="object-contain"
						/>
						<AvatarFallback className="font-mono font-bold text-xs">
							ST
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
							{APP_VERSION}
						</Badge>
					</div>
				</div>

				{/* Error Alert using shadcn Alert */}
				{error && (
					<Alert variant="destructive">
						<AlertCircle className="size-4" />
						<AlertTitle>Authentication Error</AlertTitle>
						<AlertDescription>
							{error === "access_denied"
								? "Authorization request was cancelled."
								: error === "token_exchange_failed"
									? "Failed to complete Discord OAuth exchange."
									: `Error details: ${error}`}
						</AlertDescription>
					</Alert>
				)}

				{/* Single Simple Shadcn Card */}
				<Card className="border-border/80 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardHeader className="text-center gap-1.5 p-6 pb-2">
						<CardTitle className="text-xl font-semibold tracking-tight">
							Sign In to The Dashboard
						</CardTitle>
						<CardDescription className="text-xs text-muted-foreground">
							Connect your Discord account to configure managed servers
						</CardDescription>
					</CardHeader>

					<CardContent className="flex flex-col gap-4 p-6">
						{/* Primary Action Button */}
						<Button
							asChild
							size="lg"
							className="w-full h-12 text-sm font-semibold bg-[#5865f2] hover:bg-[#4752c4] text-white shadow-lg cursor-pointer rounded-xl transition-all"
						>
							<a href={loginUrl} id="discord-login-btn">
								<svg
									width="20"
									height="20"
									viewBox="0 0 71 55"
									fill="none"
									xmlns="http://www.w3.org/2000/svg"
									className="shrink-0"
									data-icon="inline-start"
								>
									<title>Discord Logo</title>
									<path
										d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.44077 45.4204 0.52529C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.52529C25.5141 0.44334 25.4218 0.40108 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C7.41288 50.6966 14.2185 53.8778 20.8956 55.9609C20.9879 55.9892 21.0858 55.9554 21.1419 55.8794C22.7862 53.5924 24.2524 51.1714 25.512 48.6239C25.5708 48.5056 25.5148 48.3646 25.3925 48.3181C23.018 47.4235 20.7526 46.3148 18.5743 45.0515C18.4391 44.9739 18.4278 44.7794 18.5519 44.6878C19.0071 44.3488 19.4621 43.9971 19.897 43.6424C19.9589 43.5927 20.0434 43.5815 20.1162 43.6145C31.3928 48.5794 43.5358 48.5794 54.6875 43.6145C54.7602 43.579 54.8448 43.5902 54.9095 43.6398C55.3444 43.9944 55.7994 44.3488 56.2573 44.6878C56.3815 44.7794 56.3729 44.9739 56.2376 45.0515C54.0594 46.3399 51.7939 47.4235 49.4166 48.3154C49.2943 48.3619 49.241 48.5056 49.2998 48.6239C50.5821 51.168 52.0483 53.5866 53.6618 55.8738C53.7151 55.9554 53.8158 55.9892 53.9081 55.9609C60.6135 53.8778 67.4191 50.6966 74.4462 45.5576C74.4994 45.5182 74.533 45.459 74.5386 45.3942C76.0434 30.0791 72.0125 16.7774 60.1819 4.9823C60.1623 4.9429 60.1287 4.9147 60.1045 4.8978ZM25.0283 37.4279C21.5754 37.4279 18.7359 34.2591 18.7359 30.3576C18.7359 26.456 21.5193 23.2872 25.0283 23.2872C28.5651 23.2872 31.3763 26.484 31.3206 30.3576C31.3206 34.2591 28.5372 37.4279 25.0283 37.4279ZM49.0124 37.4279C45.5595 37.4279 42.72 34.2591 42.72 30.3576C42.72 26.456 45.5033 23.2872 49.0124 23.2872C52.5491 23.2872 55.3604 26.484 55.3046 30.3576C55.3046 34.2591 52.5491 37.4279 49.0124 37.4279Z"
										fill="white"
									/>
								</svg>
								Continue with Discord
								<ArrowRight className="size-4" data-icon="inline-end" />
							</a>
						</Button>
					</CardContent>
				</Card>

				{/* Bottom Credits */}
				<div className="text-center text-xs text-muted-foreground font-mono">
					Made by Blasted
				</div>
			</div>
		</div>
	);
}
