import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import logoImg from "../../public/logo.png";
import { useAuth } from "../contexts/AuthContext";

export function LoginPage() {
	const { loginWithDiscord } = useAuth();

	const errorMessage = useMemo(() => {
		const rawQuery =
			window.location.search ||
			(window.location.hash.includes("?")
				? window.location.hash.split("?")[1]
				: "");
		const params = new URLSearchParams(rawQuery);
		const err = params.get("error");

		if (err === "no_mutual_server") {
			return "Access Restricted: Your Discord account does not share any servers with Sentinel. You must be a member of a server where Sentinel is installed to access TT-Selector.";
		}
		if (err === "access_denied") {
			return "Discord authorization was denied or cancelled.";
		}
		if (err === "token_exchange_failed" || err === "user_fetch_failed") {
			return "Failed to complete Discord authorization. Please try again.";
		}
		return null;
	}, []);

	return (
		<div className="w-screen h-screen flex flex-col items-center justify-center bg-[#07090e] text-zinc-100 p-4 relative overflow-hidden bg-tactical-grid">
			{/* Ambient Glowing Orbs */}
			<div className="absolute top-1/4 -left-32 size-96 rounded-full bg-amber-500/10 blur-[120px] pointer-events-none" />
			<div className="absolute bottom-1/4 -right-32 size-96 rounded-full bg-blue-500/10 blur-[120px] pointer-events-none" />

			{/* Login Card */}
			<div className="w-full max-w-md rounded-3xl border border-border/80 bg-[#0d1117]/95 backdrop-blur-xl p-8 shadow-2xl space-y-6 relative z-10">
				{/* Brand Icon & Heading */}
				<div className="text-center space-y-2">
					<img
						src={logoImg}
						alt="Sentinel Logo"
						className="size-16 mx-auto rounded-2xl object-contain drop-shadow"
					/>
					<h1 className="text-2xl font-extrabold tracking-tight text-zinc-100 font-sans">
						TT Selector
					</h1>
				</div>

				{/* Access Restricted Error Alert */}
				{errorMessage && (
					<div className="p-3.5 rounded-2xl bg-destructive/15 border border-destructive/40 flex items-start gap-3 text-left animate-in fade-in zoom-in-95 duration-200">
						<AlertTriangle className="size-5 text-destructive shrink-0 mt-0.5" />
						<div className="space-y-1">
							<h4 className="text-xs font-bold text-red-300 font-sans">
								Access Restricted
							</h4>
							<p className="text-[11px] text-zinc-300 leading-relaxed font-sans">
								{errorMessage}
							</p>
						</div>
					</div>
				)}

				{/* Discord SSO Action */}
				<div className="space-y-3 pt-2">
					<button
						type="button"
						onClick={loginWithDiscord}
						className="w-full py-3.5 px-5 rounded-2xl bg-[#5865F2] hover:bg-[#4752c4] text-white font-bold text-sm flex items-center justify-center gap-3 transition-all cursor-pointer shadow-lg shadow-[#5865F2]/25 font-sans"
					>
						<svg
							className="size-5 fill-current"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.893.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
						</svg>
						<span>Continue with Discord</span>
					</button>
				</div>
			</div>
		</div>
	);
}
