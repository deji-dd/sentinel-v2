import {
	Activity,
	ArrowUpRight,
	Coins,
	Dumbbell,
	FileText,
	Fingerprint,
	LayoutDashboard,
	ShieldCheck,
	Sparkles,
	TrendingUp,
} from "lucide-react";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { useGlobalLoading } from "@/contexts/LoadingContext";
import { useRouter } from "@/router";

const ACTIVE_MODULES = [
	{
		title: "Wealth Tracker",
		description:
			"Multi-source net worth analytics, automated balance snapshots, and wealth trajectories.",
		href: "/wealth",
		icon: Coins,
		accent:
			"from-amber-500/20 to-amber-500/5 text-amber-400 border-amber-500/30",
		badge: "Active",
	},
	{
		title: "Activity Logs",
		description:
			"Categorized audit trails, real-time log ingestion, and Torn API event timelines.",
		href: "/logs",
		icon: FileText,
		accent: "from-blue-500/20 to-blue-500/5 text-blue-400 border-blue-500/30",
		badge: "Active",
	},
	{
		title: "Crime Ledger",
		description:
			"Crimes 2.0 payout tracking, success rates, progressive payouts, and historical analytics.",
		href: "/crimes",
		icon: Fingerprint,
		accent: "from-red-500/20 to-red-500/5 text-red-400 border-red-500/30",
		badge: "Active",
	},
	{
		title: "Battlestats & Gym",
		description:
			"Strength, speed, defense, and dexterity growth tracking with stat projection matrices.",
		href: "/battlestats",
		icon: Dumbbell,
		accent:
			"from-emerald-500/20 to-emerald-500/5 text-emerald-400 border-emerald-500/30",
		badge: "Active",
	},
	{
		title: "Stocks & Portfolio",
		description:
			"Portfolio dividends, share price histories, benefit accruals, and market forecasts.",
		href: "/stocks",
		icon: TrendingUp,
		accent:
			"from-purple-500/20 to-purple-500/5 text-purple-400 border-purple-500/30",
		badge: "Active",
	},
];

export function OverviewPage() {
	const { path, navigate } = useRouter();
	const { setPageReady } = useGlobalLoading();

	useEffect(() => {
		setPageReady(path);
	}, [path, setPageReady]);

	return (
		<div className="container max-w-6xl mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-in fade-in duration-300">
			{/* Hero / Header Card */}
			<div className="relative overflow-hidden rounded-3xl border border-border/80 bg-gradient-to-b from-card/90 via-card/50 to-background/90 p-6 sm:p-8 shadow-xl backdrop-blur-xl">
				<div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:32px_32px] pointer-events-none" />
				<div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
					<div className="space-y-2">
						<div className="flex items-center gap-2.5">
							<Badge
								variant="outline"
								className="gap-1.5 px-3 py-1 text-xs font-mono font-medium border-primary/40 bg-primary/10 text-primary rounded-full shadow-xs"
							>
								<Sparkles className="size-3 text-primary animate-pulse" />
								Sentinel V2 Core
							</Badge>
							<Badge
								variant="secondary"
								className="text-[11px] font-mono rounded-full px-2.5 py-0.5"
							>
								Overview Placeholder
							</Badge>
						</div>
						<h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold font-display tracking-tight text-foreground">
							System Overview
						</h1>
						<p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
							The system overview and live host metrics panel is currently
							undergoing a planned overhaul. Core ledgers and automation modules
							continue running normally.
						</p>
					</div>

					<div className="flex items-center gap-3 self-stretch md:self-auto shrink-0">
						<div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/60 backdrop-blur-md px-4 py-2.5 shadow-xs">
							<ShieldCheck className="size-5 text-emerald-500 shrink-0" />
							<div className="text-left">
								<p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
									Ledger Engines
								</p>
								<p className="text-xs font-bold text-foreground">Operational</p>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Placeholder Notice & Active Modules Section */}
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-lg font-bold font-display tracking-tight text-foreground flex items-center gap-2">
							<LayoutDashboard className="size-4 text-primary" />
							Active Dashboard Modules
						</h2>
						<p className="text-xs text-muted-foreground">
							Access personal data tracking and analytics ledgers below
						</p>
					</div>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{ACTIVE_MODULES.map((module) => {
						const Icon = module.icon;
						return (
							<Card
								key={module.href}
								onClick={() => navigate(module.href)}
								className="group relative overflow-hidden border border-border/70 hover:border-primary/50 transition-all duration-300 hover:shadow-lg bg-card/60 hover:bg-card/90 cursor-pointer rounded-2xl"
							>
								<CardHeader className="p-5 pb-3">
									<div className="flex items-center justify-between">
										<div
											className={`size-10 rounded-xl border flex items-center justify-center bg-gradient-to-br transition-transform group-hover:scale-105 ${module.accent}`}
										>
											<Icon className="size-5" />
										</div>
										<div className="flex items-center gap-1.5 text-muted-foreground group-hover:text-primary transition-colors">
											<span className="text-[11px] font-mono font-medium">
												Open
											</span>
											<ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
										</div>
									</div>
									<CardTitle className="text-base font-bold font-display pt-3 text-foreground group-hover:text-primary transition-colors">
										{module.title}
									</CardTitle>
								</CardHeader>
								<CardContent className="p-5 pt-0">
									<CardDescription className="text-xs leading-relaxed text-muted-foreground">
										{module.description}
									</CardDescription>
								</CardContent>
							</Card>
						);
					})}

					{/* Information Card */}
					<Card className="border border-dashed border-border/80 bg-background/40 rounded-2xl flex flex-col justify-center p-5">
						<div className="flex items-center gap-3 mb-2">
							<div className="size-9 rounded-xl border border-border/60 bg-muted/30 flex items-center justify-center text-muted-foreground">
								<Activity className="size-4" />
							</div>
							<div>
								<p className="text-xs font-semibold text-foreground">
									Overview Redesign
								</p>
								<p className="text-[10px] text-muted-foreground font-mono">
									Phase 2 In Progress
								</p>
							</div>
						</div>
						<p className="text-xs text-muted-foreground leading-relaxed">
							A streamlined command center will replace this view with
							consolidated personal analytics, automated notifications, and
							quick actions.
						</p>
					</Card>
				</div>
			</div>
		</div>
	);
}
