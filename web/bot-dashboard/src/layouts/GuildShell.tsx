import { Loader2, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "../contexts/AuthContext";
import AdminKeysPage from "../pages/AdminKeysPage";
import GeneralSettingsPage from "../pages/GuildSettingsPage";
import ReactionRolesPage from "../pages/ReactionRolesPage";
import TerritoryPage from "../pages/TerritoryPage";
import VerificationPage from "../pages/VerificationPage";
import { useRouter } from "../router";
import { GuildSidebar } from "./GuildSidebar";

function PageFallback() {
	return (
		<div className="flex flex-col items-center justify-center h-screen w-screen gap-3 text-muted-foreground text-sm font-sans bg-background relative overflow-hidden">
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[500px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
			<Loader2 className="size-7 animate-spin text-primary relative z-10" />
			<div className="flex items-center gap-2 relative z-10 font-mono text-xs">
				<span className="font-bold text-foreground tracking-widest uppercase">
					SENTINEL
				</span>
				<span className="text-muted-foreground uppercase tracking-wider">
					• Loading Server Config...
				</span>
			</div>
		</div>
	);
}

function extractGuildId(path: string): string | null {
	const match = path.match(/^\/guilds\/([^/]+)/);
	return match ? (match[1] ?? null) : null;
}

function extractSubPath(path: string, guildId: string): string {
	const prefix = `/guilds/${guildId}`;
	if (!path.startsWith(prefix)) return "/";
	const sub = path.slice(prefix.length);
	return sub === "" ? "/" : sub;
}

export default function GuildShell() {
	const { path, navigate } = useRouter();
	const { authenticated, loading: authLoading } = useAuth();

	const guildId = extractGuildId(path);
	const subPath = guildId ? extractSubPath(path, guildId) : "/";

	const [sidebarOpen, setSidebarOpen] = useState(false);

	// Auth guard
	useEffect(() => {
		if (!authLoading && !authenticated) {
			navigate("/login");
		}
	}, [authLoading, authenticated, navigate]);

	if (authLoading || !authenticated || !guildId) {
		return <PageFallback />;
	}

	const renderPage = () => {
		if (subPath === "/" || subPath === "")
			return <GeneralSettingsPage guildId={guildId} />;
		if (subPath === "/verification")
			return <VerificationPage guildId={guildId} />;
		if (subPath === "/territory") return <TerritoryPage guildId={guildId} />;
		if (subPath === "/reaction-roles")
			return <ReactionRolesPage guildId={guildId} />;
		if (
			subPath === "/keys" ||
			subPath === "/admin/keys" ||
			subPath === "/admin"
		)
			return <AdminKeysPage isInsideShell={true} />;

		return <div className="p-8 text-muted-foreground">Page not found.</div>;
	};

	return (
		<div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans relative">
			{/* Subtle Background Radial Glow */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

			{/* Mobile Overlay */}
			{sidebarOpen && (
				<button
					type="button"
					aria-label="Close sidebar overlay"
					onClick={() => setSidebarOpen(false)}
					className="fixed inset-0 bg-black/50 z-30 block lg:hidden border-0 p-0 cursor-pointer"
				/>
			)}

			{/* Sidebar Container */}
			<div
				className={`fixed lg:relative inset-y-0 left-0 z-40 h-full w-64 lg:w-72 shrink-0 transition-transform duration-200 ease-in-out ${
					sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
				}`}
			>
				<GuildSidebar
					guildId={guildId}
					onNavigate={() => setSidebarOpen(false)}
				/>
			</div>

			{/* Main Scrollable Content Area */}
			<div className="flex-1 flex flex-col h-full overflow-hidden relative z-10 min-w-0">
				{/* Mobile Menu Bar Toggle */}
				<div className="lg:hidden p-4 border-b border-border/80 flex items-center justify-between bg-card/60 backdrop-blur-md">
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setSidebarOpen((o) => !o)}
						aria-label="Toggle sidebar menu"
						className="size-9 rounded-full cursor-pointer"
					>
						<Menu className="size-4" />
					</Button>
					<span className="font-bold text-sm font-mono uppercase tracking-tight">
						Sentinel
					</span>
				</div>

				<main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
					<div className="max-w-4xl mx-auto">{renderPage()}</div>
				</main>
			</div>
		</div>
	);
}
