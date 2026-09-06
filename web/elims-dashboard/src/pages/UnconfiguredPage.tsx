import { AlertTriangle, LogOut, RefreshCw, ServerOff } from "lucide-react";
import { useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "../contexts/AuthContext";
import { useElims } from "../contexts/ElimsContext";

export function UnconfiguredPage() {
	const { user, logout } = useAuth();
	const { refreshStatus } = useElims();
	const [checking, setChecking] = useState(false);

	const handleCheckAgain = async () => {
		setChecking(true);
		try {
			await refreshStatus();
		} finally {
			setChecking(false);
		}
	};

	const initials = (user?.username ?? "U").slice(0, 2).toUpperCase();

	return (
		<main className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background text-foreground relative overflow-hidden">
			{/* Theme Switcher in Top Right */}
			<div className="absolute top-4 right-4 z-20">
				<ThemeToggle />
			</div>

			{/* Ambient background glow */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[500px] bg-amber-500/5 rounded-full blur-[140px] pointer-events-none" />

			<div className="w-full max-w-lg flex flex-col gap-6 relative z-10">
				{/* App Branding */}
				<div className="flex flex-col items-center gap-3 text-center">
					<Avatar className="size-16 border border-border shadow-md bg-card">
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
					<p className="text-xs text-muted-foreground font-mono">
						Tournament Operations Center
					</p>
				</div>

				{/* Notice Card */}
				<Card className="border-border/80 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardHeader className="text-center flex flex-col gap-2 px-6 pt-6 pb-2">
						<div className="mx-auto size-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 mb-1">
							<ServerOff className="size-6" />
						</div>
						<CardTitle className="text-xl font-semibold tracking-tight">
							Server Setup Pending
						</CardTitle>
						<CardDescription className="text-xs text-muted-foreground max-w-sm mx-auto">
							The Elimination tournament Discord server has not been configured
							yet by the Sentinel administrator.
						</CardDescription>
					</CardHeader>

					<CardContent className="flex flex-col gap-4 px-6 py-4">
						<Alert
							variant="default"
							className="border-amber-500/30 bg-amber-500/5 text-foreground"
						>
							<AlertTriangle className="size-4 text-amber-500" />
							<AlertTitle className="text-xs font-semibold text-amber-500">
								Waiting for Setup
							</AlertTitle>
							<AlertDescription className="text-xs text-muted-foreground mt-1">
								Tournament operations are temporarily unavailable while the bot
								owner designates the active server and assigns dashboard
								administrator roles.
							</AlertDescription>
						</Alert>

						<div className="rounded-lg border border-border/70 bg-muted/30 p-3 flex flex-col gap-2">
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground">Connected Account</span>
								<div className="flex items-center gap-1.5">
									<Avatar className="size-5 border border-border">
										{user?.avatar && (
											<AvatarImage src={user.avatar} alt={user.username} />
										)}
										<AvatarFallback className="text-[9px] font-mono">
											{initials}
										</AvatarFallback>
									</Avatar>
									<span className="font-medium font-mono text-foreground">
										{user?.username}
									</span>
								</div>
							</div>
							<Separator />
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground">Discord ID</span>
								<span className="font-mono text-muted-foreground text-[11px]">
									{user?.discordId ?? "N/A"}
								</span>
							</div>
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground">Status</span>
								<Badge
									variant="secondary"
									className="text-[10px] font-mono uppercase"
								>
									Unconfigured
								</Badge>
							</div>
						</div>
					</CardContent>

					<CardFooter className="flex flex-col sm:flex-row gap-2.5 px-6 pb-6 pt-2">
						<Button
							variant="default"
							className="w-full sm:flex-1 cursor-pointer"
							onClick={handleCheckAgain}
							disabled={checking}
						>
							<RefreshCw
								className={checking ? "size-4 animate-spin" : "size-4"}
								data-icon="inline-start"
							/>
							{checking ? "Checking Status..." : "Check Again"}
						</Button>
						<Button
							variant="outline"
							className="w-full sm:w-auto cursor-pointer"
							onClick={logout}
						>
							<LogOut className="size-4" data-icon="inline-start" />
							Sign Out
						</Button>
					</CardFooter>
				</Card>
			</div>
		</main>
	);
}
