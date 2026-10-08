import { ArrowLeft, ChevronRight, LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import logoImg from "../../public/logo.png";
import { APP_VERSION } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { api } from "../lib/api";
import { getNavSections, type NavSection, navHref } from "../lib/navigation";
import { cn } from "../lib/utils";
import type { ServerTypeMapping } from "../pages/ServerSelectorPage";
import { useRouter } from "../router";

interface GuildSidebarProps {
	guildId: string;
	activeServerType?: string | null;
	onNavigate?: () => void;
	className?: string;
}

/** The server-type badge shown next to the wordmark. */
function ServerTypeBadge({
	isMerc,
	isFaction,
	isAlliance,
	isElims,
}: {
	isMerc: boolean;
	isFaction: boolean;
	isAlliance: boolean;
	isElims: boolean;
}) {
	if (isMerc) {
		return (
			<Badge
				variant="outline"
				className="border-success/30 bg-success/10 px-1.5 py-0 text-[9px] font-mono text-success"
			>
				MERCENARY
			</Badge>
		);
	}
	if (isFaction) {
		return (
			<Badge
				variant="outline"
				className="border-warning/30 bg-warning/10 px-1.5 py-0 text-[9px] font-mono text-warning"
			>
				FACTION
			</Badge>
		);
	}
	if (isAlliance) {
		return (
			<Badge
				variant="outline"
				className="border-info/30 bg-info/10 px-1.5 py-0 text-[9px] font-mono text-info"
			>
				ALLIANCE
			</Badge>
		);
	}
	if (isElims) {
		return (
			<Badge
				variant="outline"
				className="border-rose-500/30 bg-rose-500/10 px-1.5 py-0 text-[9px] font-mono text-rose-400"
			>
				ELIMS
			</Badge>
		);
	}
	return (
		<Badge
			variant="outline"
			className="px-1.5 py-0 text-[9px] font-mono text-muted-foreground"
		>
			{APP_VERSION}
		</Badge>
	);
}

function NavList({
	sections,
	guildId,
	effectiveType,
	onNavigate,
}: {
	sections: NavSection[];
	guildId: string;
	effectiveType: string | null;
	onNavigate?: () => void;
}) {
	const { path, navigate } = useRouter();

	const isActive = (subPath: string) => {
		const target = `/guilds/${guildId}${subPath}`;
		if (subPath === "") {
			return path === target || path === `/guilds/${guildId}/guild-config`;
		}
		return path === target || path.startsWith(`${target}/`);
	};

	return (
		<nav className="flex flex-col gap-6">
			{sections.map((section) => (
				<div key={section.title} className="flex flex-col gap-1.5">
					<div className="px-3 pt-1">
						<span className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/70 uppercase">
							{section.title}
						</span>
					</div>

					<div className="flex flex-col gap-1">
						{section.items.map((item) => {
							const Icon = item.icon;
							const active = isActive(item.subPath);
							const href = navHref(guildId, item.subPath, effectiveType);

							return (
								<Button
									key={item.subPath || "root"}
									type="button"
									variant="ghost"
									onClick={() => {
										navigate(href);
										onNavigate?.();
									}}
									aria-current={active ? "page" : undefined}
									className={cn(
										"group h-10 w-full justify-between rounded-xl px-3 text-xs font-medium transition-colors lg:h-9",
										active
											? "border border-primary/30 bg-primary/15 font-semibold text-primary shadow-xs hover:bg-primary/20"
											: "border border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
									)}
								>
									<span className="flex min-w-0 items-center gap-2.5">
										<Icon
											className={cn(
												"size-4 shrink-0 transition-colors",
												active
													? "text-primary"
													: (item.accent ??
															"text-muted-foreground group-hover:text-foreground"),
											)}
										/>
										<span className="truncate">{item.label}</span>
									</span>
									<ChevronRight
										className={cn(
											"size-3.5 shrink-0 transition-transform",
											active
												? "translate-x-0.5 text-primary"
												: "text-muted-foreground opacity-0 group-hover:translate-x-0.5 group-hover:opacity-100",
										)}
									/>
								</Button>
							);
						})}
					</div>
				</div>
			))}
		</nav>
	);
}

/**
 * Guild navigation.
 *
 * Rendered inside the fixed desktop rail and inside the mobile `Sheet` drawer —
 * one component so both breakpoints share identical navigation.
 */
export function GuildSidebar({
	guildId,
	activeServerType,
	onNavigate,
	className,
}: GuildSidebarProps) {
	const { navigate } = useRouter();
	const { user, authenticated, logout } = useAuth();
	const { theme, toggle } = useTheme();

	const [serverTypes, setServerTypes] = useState<ServerTypeMapping>({
		alliance: null,
		faction: null,
		elims: null,
		owner: null,
		merc: null,
	});

	useEffect(() => {
		let isMounted = true;
		api.v2.guilds["server-types"]
			.get()
			.then((res) => {
				if (isMounted && res.data && "serverTypes" in res.data) {
					setServerTypes(res.data.serverTypes as ServerTypeMapping);
				}
			})
			.catch(() => {});
		return () => {
			isMounted = false;
		};
	}, []);

	const effectiveType =
		activeServerType ??
		(typeof window !== "undefined"
			? sessionStorage.getItem(`sentinel_server_type_${guildId}`)
			: null);

	const isMerc =
		effectiveType === "merc" ||
		(!effectiveType &&
			Boolean(
				serverTypes.merc &&
					guildId === serverTypes.merc &&
					serverTypes.faction !== guildId,
			));
	const isFaction =
		effectiveType === "faction" ||
		(!effectiveType &&
			Boolean(
				serverTypes.faction &&
					guildId === serverTypes.faction &&
					serverTypes.merc !== guildId,
			));
	const isAlliance =
		effectiveType === "alliance" ||
		(!effectiveType &&
			Boolean(serverTypes.alliance && guildId === serverTypes.alliance));
	const isElims =
		effectiveType === "elims" ||
		(!effectiveType &&
			Boolean(serverTypes.elims && guildId === serverTypes.elims));

	const avatarUrl = (() => {
		try {
			const meta = document.cookie.match(/discord_meta=([^;]+)/)?.[1];
			if (meta) {
				const parsed = JSON.parse(decodeURIComponent(meta)) as {
					avatar?: string;
				};
				return parsed.avatar ?? null;
			}
		} catch {
			// ignore
		}
		return null;
	})();

	const sections = getNavSections({
		guildId,
		effectiveType,
		isMerc,
		isFaction,
		isAlliance,
		isElims,
	});

	return (
		<aside
			className={cn(
				"flex h-full min-h-0 w-full flex-col justify-between gap-4 border-border/80 bg-card/70 p-4 backdrop-blur-xl select-none",
				className,
			)}
		>
			{/* Branding + server switcher */}
			<div className="flex shrink-0 flex-col gap-4 border-b border-border/40 pb-4">
				<div className="flex items-center justify-between gap-2">
					<button
						type="button"
						onClick={() => {
							navigate("/");
							onNavigate?.();
						}}
						className="group flex min-w-0 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0"
						aria-label="Go to server list"
					>
						<Avatar className="size-8 shrink-0 border border-border bg-card shadow-xs">
							<AvatarImage src={logoImg} alt="" className="object-contain" />
							<AvatarFallback className="font-mono text-xs">ST</AvatarFallback>
						</Avatar>
						<span className="truncate font-mono text-base font-bold tracking-tight text-foreground uppercase transition-colors group-hover:text-primary">
							Sentinel
						</span>
					</button>
					<ServerTypeBadge
						isMerc={isMerc}
						isFaction={isFaction}
						isAlliance={isAlliance}
						isElims={isElims}
					/>
				</div>

				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						navigate("/");
						onNavigate?.();
					}}
					className="w-fit justify-start gap-2 rounded-xl text-xs text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" />
					All Servers
				</Button>
			</div>

			{/* Navigation — the only scrollable region of the rail */}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
				<NavList
					sections={sections}
					guildId={guildId}
					effectiveType={effectiveType}
					onNavigate={onNavigate}
				/>
			</div>

			{/* Account + theme */}
			<div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/40 pt-3">
				{authenticated && user ? (
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<Avatar className="size-7 shrink-0 border border-border">
							{avatarUrl ? (
								<AvatarImage src={avatarUrl} alt={user.username} />
							) : null}
							<AvatarFallback className="font-mono text-[9px]">
								{user.username.charAt(0).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<span className="min-w-0 truncate text-xs font-medium text-foreground">
							{user.username}
						</span>
					</div>
				) : (
					<div />
				)}

				<div className="flex shrink-0 items-center gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={toggle}
						aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						className="rounded-full border border-border/60 bg-background/50 shadow-xs"
					>
						{theme === "dark" ? (
							<Sun className="size-3.5" />
						) : (
							<Moon className="size-3.5" />
						)}
					</Button>

					{authenticated ? (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => void logout()}
							title="Sign out"
							aria-label="Sign out"
							className="rounded-full border border-border/60 bg-background/50 text-muted-foreground shadow-xs hover:bg-destructive/10 hover:text-destructive"
						>
							<LogOut className="size-3.5" />
						</Button>
					) : null}
				</div>
			</div>
		</aside>
	);
}

export default GuildSidebar;
