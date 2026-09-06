// import {
// 	Activity,
// 	ArrowRight,
// 	Crown,
// 	Server,
// 	Sliders,
// 	Swords,
// } from "lucide-react";
import type { DashboardView } from "@/components/AppSidebar";

// import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
// import { Badge } from "@/components/ui/badge";
// import { Button } from "@/components/ui/button";
// import {
// 	Card,
// 	CardContent,
// 	CardDescription,
// 	CardHeader,
// 	CardTitle,
// } from "@/components/ui/card";
// import { useAuth } from "../contexts/AuthContext";
// import { useElims } from "../contexts/ElimsContext";

interface OverviewPageProps {
	onSelectView?: (view: DashboardView) => void;
}

export function OverviewPage({
	onSelectView: _onSelectView,
}: OverviewPageProps) {
	// const { user } = useAuth();
	// const { guild, isOwner, adminRoleIds } = useElims();

	// const guildInitials = (guild?.name ?? "DS").slice(0, 2).toUpperCase();
	// const guildIconUrl =
	// 	guild?.id && guild?.icon
	// 		? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
	// 		: null;

	return (
		// <div className="flex flex-col gap-6 max-w-5xl w-full mx-auto pb-12">
		// 	Overview Header
		// 	<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
		// 		<div className="flex flex-col gap-1">
		// 			<div className="flex items-center gap-2">
		// 				<h1 className="text-2xl font-bold tracking-tight">
		// 					Tournament Operations Overview
		// 				</h1>
		// 				{isOwner && (
		// 					<Badge variant="outline" className="text-[10px] font-mono">
		// 						Owner Mode
		// 					</Badge>
		// 				)}
		// 			</div>
		// 			<p className="text-xs text-muted-foreground">
		// 				Live status and health metrics for the Elimination Tournament.
		// 			</p>
		// 		</div>

		// 		{isOwner && (
		// 			<Button
		// 				variant="outline"
		// 				size="sm"
		// 				onClick={() => onSelectView("guild-config")}
		// 				className="text-xs cursor-pointer"
		// 			>
		// 				<Sliders className="size-3.5" data-icon="inline-start" />
		// 				Guild Configuration
		// 			</Button>
		// 		)}
		// 	</div>

		// 	{/* Top Metric Cards */}
		// 	<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		// 		{/* Active Guild */}
		// 		<Card className="border-border/80 shadow-xs">
		// 			<CardHeader className="pb-2">
		// 				<CardDescription className="text-[11px] font-mono uppercase">
		// 					Active Server
		// 				</CardDescription>
		// 				<div className="flex items-center gap-2 pt-1">
		// 					<Avatar className="size-6 rounded-xs border border-border">
		// 						{guildIconUrl && (
		// 							<AvatarImage src={guildIconUrl} alt={guild?.name ?? ""} />
		// 						)}
		// 						<AvatarFallback className="font-mono text-[9px]">
		// 							{guildInitials}
		// 						</AvatarFallback>
		// 					</Avatar>
		// 					<CardTitle className="text-sm font-semibold truncate">
		// 						{guild?.name ?? "Configured Server"}
		// 					</CardTitle>
		// 				</div>
		// 			</CardHeader>
		// 			<CardContent className="pt-0">
		// 				<span className="text-[11px] text-muted-foreground font-mono">
		// 					ID: {guild?.id ?? "N/A"}
		// 				</span>
		// 			</CardContent>
		// 		</Card>

		// 		{/* Admin Roles */}
		// 		<Card className="border-border/80 shadow-xs">
		// 			<CardHeader className="pb-2">
		// 				<CardDescription className="text-[11px] font-mono uppercase">
		// 					Admin Roles
		// 				</CardDescription>
		// 				<CardTitle className="text-2xl font-bold font-mono">
		// 					{adminRoleIds.length}
		// 				</CardTitle>
		// 			</CardHeader>
		// 			<CardContent className="pt-0">
		// 				<span className="text-[11px] text-muted-foreground">
		// 					Designated server roles
		// 				</span>
		// 			</CardContent>
		// 		</Card>

		// 		{/* Bot Connection */}
		// 		<Card className="border-border/80 shadow-xs">
		// 			<CardHeader className="pb-2">
		// 				<CardDescription className="text-[11px] font-mono uppercase">
		// 					Discord Gateway
		// 				</CardDescription>
		// 				<CardTitle className="text-sm font-semibold text-emerald-500 flex items-center gap-1.5 pt-1">
		// 					<span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
		// 					Online & Ready
		// 				</CardTitle>
		// 			</CardHeader>
		// 			<CardContent className="pt-0">
		// 				<span className="text-[11px] text-muted-foreground">
		// 					Gateway listener synchronized
		// 				</span>
		// 			</CardContent>
		// 		</Card>

		// 		{/* User Status */}
		// 		<Card className="border-border/80 shadow-xs">
		// 			<CardHeader className="pb-2">
		// 				<CardDescription className="text-[11px] font-mono uppercase">
		// 					Session
		// 				</CardDescription>
		// 				<CardTitle className="text-sm font-semibold truncate pt-1">
		// 					{user?.username ?? "Authenticated"}
		// 				</CardTitle>
		// 			</CardHeader>
		// 			<CardContent className="pt-0">
		// 				<Badge
		// 					variant="outline"
		// 					className="text-[10px] font-mono uppercase text-primary border-primary/30"
		// 				>
		// 					{isOwner ? "Instance Owner" : "Elims Admin"}
		// 				</Badge>
		// 			</CardContent>
		// 		</Card>
		// 	</div>

		// 	{/* Owner Configuration Quick Action Banner */}
		// 	{isOwner && (
		// 		<Card className="border-primary/30 bg-primary/5 shadow-xs">
		// 			<CardContent className="p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
		// 				<div className="flex items-center gap-3">
		// 					<div className="size-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
		// 						<Crown className="size-5" />
		// 					</div>
		// 					<div className="flex flex-col gap-0.5">
		// 						<span className="text-sm font-semibold text-foreground">
		// 							Configure Elims Server Permissions
		// 						</span>
		// 						<p className="text-xs text-muted-foreground">
		// 							As server owner, designate Discord roles that can access this
		// 							dashboard or de-initialize this server if needed.
		// 						</p>
		// 					</div>
		// 				</div>

		// 				<Button
		// 					variant="default"
		// 					size="sm"
		// 					onClick={() => onSelectView("guild-config")}
		// 					className="text-xs shrink-0 cursor-pointer"
		// 				>
		// 					Open Guild Config
		// 					<ArrowRight className="size-3.5" data-icon="inline-end" />
		// 				</Button>
		// 			</CardContent>
		// 		</Card>
		// 	)}

		// 	{/* Operations Detail Cards */}
		// 	<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
		// 		<Card className="border-border/80 shadow-xs">
		// 			<CardHeader>
		// 				<CardTitle className="text-base flex items-center gap-2">
		// 					<Server className="size-4 text-primary" />
		// 					Server Architecture
		// 				</CardTitle>
		// 				<CardDescription className="text-xs">
		// 					Configured Discord guild linkage details
		// 				</CardDescription>
		// 			</CardHeader>
		// 			<CardContent className="flex flex-col gap-3 text-xs">
		// 				<div className="flex justify-between items-center py-1 border-b border-border/50">
		// 					<span className="text-muted-foreground">Guild Name</span>
		// 					<span className="font-medium text-foreground">
		// 						{guild?.name ?? "Unknown"}
		// 					</span>
		// 				</div>
		// 				<div className="flex justify-between items-center py-1 border-b border-border/50">
		// 					<span className="text-muted-foreground">Guild ID</span>
		// 					<span className="font-mono text-[11px]">
		// 						{guild?.id ?? "N/A"}
		// 					</span>
		// 				</div>
		// 				<div className="flex justify-between items-center py-1 border-b border-border/50">
		// 					<span className="text-muted-foreground">Admin Roles Active</span>
		// 					<span className="font-mono font-medium text-primary">
		// 						{adminRoleIds.length} roles assigned
		// 					</span>
		// 				</div>
		// 				<div className="flex justify-between items-center py-1">
		// 					<span className="text-muted-foreground">State Storage</span>
		// 					<Badge variant="secondary" className="font-mono text-[10px]">
		// 						systemStates (ELIMS_CONFIG_ID)
		// 					</Badge>
		// 				</div>
		// 			</CardContent>
		// 		</Card>

		// 		<Card className="border-border/80 shadow-xs">
		// 			<CardHeader>
		// 				<CardTitle className="text-base flex items-center gap-2">
		// 					<Swords className="size-4 text-primary" />
		// 					Tournament Lifecycle
		// 				</CardTitle>
		// 				<CardDescription className="text-xs">
		// 					Automated elimination tracking engine
		// 				</CardDescription>
		// 			</CardHeader>
		// 			<CardContent className="flex flex-col gap-3 text-xs text-muted-foreground leading-relaxed">
		// 				<p>
		// 					Elimination bracket calculations, attack log ingests, and player
		// 					status tracking run on top of the configured Discord guild.
		// 				</p>
		// 				<div className="rounded-md border border-border/50 bg-background/50 p-3 flex items-center gap-2 text-foreground">
		// 					<Activity className="size-4 text-primary shrink-0" />
		// 					<span className="text-xs">
		// 						Waiting for tournament roster announcement & bracket draw.
		// 					</span>
		// 				</div>
		// 			</CardContent>
		// 		</Card>
		// 	</div>
		// </div>
		<div></div>
	);
}
