import { Menu, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { PageLoader } from "@/components/PageLoader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { api } from "../lib/api";
import { getNavSections, getPageLabel } from "../lib/navigation";
import { DibsConfigPage } from "../pages/DibsConfigPage";
import GeneralSettingsPage from "../pages/GuildSettingsPage";
import { MercChannelsPage } from "../pages/MercChannelsPage";
import { MercContractsPage } from "../pages/MercContractsPage";
import ReactionRolesPage from "../pages/ReactionRolesPage";
import { RecruitmentPage } from "../pages/RecruitmentPage";
import { RwChannelsPage } from "../pages/RwChannelsPage";
import { StocksPage } from "../pages/StocksPage";
import TerritoryPage from "../pages/TerritoryPage";
import VerificationPage from "../pages/VerificationPage";
import { useRouter } from "../router";
import { GuildSidebar } from "./GuildSidebar";

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
	const { path, queryParams, navigate } = useRouter();
	const { authenticated, loading: authLoading } = useAuth();
	const { theme, toggle } = useTheme();

	const guildId = extractGuildId(path);
	const subPath = guildId ? extractSubPath(path, guildId) : "/";

	const [sidebarOpen, setSidebarOpen] = useState(false);

	// Close the drawer whenever the route changes (e.g. deep links / back button).
	useEffect(() => {
		setSidebarOpen(false);
	}, [path]);

	const [serverTypes, setServerTypes] = useState<{
		faction?: string | null;
		merc?: string | null;
		alliance?: string | null;
	}>({});

	useEffect(() => {
		let isMounted = true;
		api.v2.guilds["server-types"]
			.get()
			.then((res) => {
				if (isMounted && res.data && "serverTypes" in res.data) {
					setServerTypes(
						res.data.serverTypes as {
							faction?: string | null;
							merc?: string | null;
							alliance?: string | null;
						},
					);
				}
			})
			.catch(() => {});
		return () => {
			isMounted = false;
		};
	}, []);

	const paramType =
		(queryParams.type as "faction" | "merc" | "alliance" | undefined) ?? null;

	const [storedType, setStoredType] = useState<string | null>(() => {
		if (!guildId) return null;
		try {
			return sessionStorage.getItem(`sentinel_server_type_${guildId}`);
		} catch {
			return null;
		}
	});

	useEffect(() => {
		if (guildId && paramType) {
			try {
				sessionStorage.setItem(`sentinel_server_type_${guildId}`, paramType);
			} catch {}
			setStoredType(paramType);
		}
	}, [guildId, paramType]);

	const activeServerType =
		paramType ??
		storedType ??
		(serverTypes.faction === guildId && serverTypes.merc !== guildId
			? "faction"
			: serverTypes.merc === guildId && serverTypes.faction !== guildId
				? "merc"
				: serverTypes.alliance === guildId
					? "alliance"
					: null);

	const isMerc =
		activeServerType === "merc" ||
		(!activeServerType &&
			Boolean(
				serverTypes.merc &&
					guildId === serverTypes.merc &&
					serverTypes.faction !== guildId,
			));
	const isFaction =
		activeServerType === "faction" ||
		(!activeServerType &&
			Boolean(
				serverTypes.faction &&
					guildId === serverTypes.faction &&
					serverTypes.merc !== guildId,
			));
	const isAlliance =
		activeServerType === "alliance" ||
		(!activeServerType &&
			Boolean(serverTypes.alliance && guildId === serverTypes.alliance));

	// Auth guard
	useEffect(() => {
		if (!authLoading && !authenticated) {
			navigate("/login");
		}
	}, [authLoading, authenticated, navigate]);

	if (authLoading || !authenticated || !guildId) {
		return <PageLoader label="Loading Server Config..." />;
	}

	const renderPage = () => {
		if (subPath === "/" || subPath === "")
			return (
				<GeneralSettingsPage
					guildId={guildId}
					isMerc={isMerc}
					activeServerType={activeServerType}
				/>
			);
		if (subPath === "/verification")
			return (
				<VerificationPage
					guildId={guildId}
					activeServerType={activeServerType}
				/>
			);
		if (
			subPath === "/channels" ||
			subPath === "/channel-selections" ||
			subPath === "/contract-channels"
		)
			return <MercChannelsPage guildId={guildId} />;
		if (subPath === "/contracts")
			return <MercContractsPage guildId={guildId} />;
		if (isMerc) {
			return <NotFound />;
		}
		if (subPath === "/territory") return <TerritoryPage guildId={guildId} />;
		if (subPath === "/recruitment")
			return <RecruitmentPage guildId={guildId} />;
		if (subPath === "/rw-channels") return <RwChannelsPage guildId={guildId} />;
		if (subPath === "/dibs") return <DibsConfigPage guildId={guildId} />;
		if (subPath === "/stocks") {
			// Stock alerts are routed per Subversive family faction, which only
			// exists on the faction server.
			if (!isFaction) return <NotFound />;
			return <StocksPage guildId={guildId} />;
		}
		if (subPath === "/reaction-roles") {
			if (isFaction) return <NotFound />;
			return <ReactionRolesPage guildId={guildId} />;
		}

		return <NotFound />;
	};

	const sections = getNavSections({
		guildId,
		effectiveType: activeServerType,
		isMerc,
		isFaction,
		isAlliance,
	});
	const pageLabel = getPageLabel(subPath, sections) ?? "Dashboard";

	return (
		<div className="relative flex h-dvh w-full overflow-hidden bg-background font-sans text-foreground">
			{/* Decorative background glow — hidden from screen readers, behind content */}
			<div className="app-glow" aria-hidden="true" />

			{/* ── Desktop rail ─────────────────────────────────────────────── */}
			<div className="relative z-20 hidden shrink-0 border-r border-border/80 lg:block lg:w-72">
				<GuildSidebar guildId={guildId} activeServerType={activeServerType} />
			</div>

			{/* ── Mobile drawer ────────────────────────────────────────────── */}
			<Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
				<SheetContent
					side="left"
					showCloseButton={false}
					className="w-[86vw] max-w-xs border-r border-border/80 bg-card/95 p-0 backdrop-blur-xl lg:hidden"
				>
					<SheetHeader className="sr-only">
						<SheetTitle>Server navigation</SheetTitle>
						<SheetDescription>
							Choose a section of this server's dashboard.
						</SheetDescription>
					</SheetHeader>
					<GuildSidebar
						guildId={guildId}
						activeServerType={activeServerType}
						onNavigate={() => setSidebarOpen(false)}
					/>
				</SheetContent>
			</Sheet>

			{/* ── Main column ──────────────────────────────────────────────── */}
			<div className="relative z-10 flex min-w-0 flex-1 flex-col">
				{/* App bar — the only chrome on mobile, sticky on desktop too. */}
				<header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border/80 bg-background/85 px-3 backdrop-blur-xl sm:h-16 sm:px-4 lg:px-6">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setSidebarOpen(true)}
						aria-label="Open navigation"
						className="shrink-0 rounded-full lg:hidden"
					>
						<Menu className="size-4" />
					</Button>

					{/* Mobile: current page. Desktop: brand mark. */}
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<span className="truncate text-sm font-semibold tracking-tight lg:hidden">
							{pageLabel}
						</span>
						<span className="hidden font-mono text-sm font-bold tracking-widest text-foreground uppercase lg:inline">
							Sentinel
						</span>
						<Badge
							variant="outline"
							className="hidden shrink-0 px-1.5 py-0 text-[9px] font-mono text-muted-foreground sm:inline-flex"
						>
							{isMerc
								? "MERCENARY"
								: isFaction
									? "FACTION"
									: isAlliance
										? "ALLIANCE"
										: "SERVER"}
						</Badge>
					</div>

					<Button
						variant="ghost"
						size="icon-sm"
						onClick={toggle}
						aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						className="shrink-0 rounded-full border border-border/60 bg-card/60"
					>
						{theme === "dark" ? (
							<Sun className="size-4" />
						) : (
							<Moon className="size-4" />
						)}
					</Button>
				</header>

				{/* Scroll container. `min-h-0` is what actually lets it scroll
				    inside a flex column on mobile Safari. */}
				<main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<div className="px-3 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-8">
						{renderPage()}
					</div>
				</main>
			</div>
		</div>
	);
}

function NotFound() {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
			<h2 className="text-base font-semibold">Page not found</h2>
			<p className="text-sm text-muted-foreground">
				This section is not available for this server type.
			</p>
		</div>
	);
}
