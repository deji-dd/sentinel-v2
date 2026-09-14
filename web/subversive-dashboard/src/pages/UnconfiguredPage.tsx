import { AlertTriangle, LogOut, RefreshCw, ServerOff } from "lucide-react";
import { useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";
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
import { useSubversive } from "../contexts/SubversiveContext";

export function UnconfiguredPage() {
	const { user, logout } = useAuth();
	const { refreshStatus } = useSubversive();
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
		<main className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background text-foreground relative">
			<div className="absolute top-4 right-4">
				<ModeToggle />
			</div>
			<div className="w-full max-w-lg flex flex-col gap-6">
				{/* Notice Card */}
				<Card className="border-border shadow-lg">
					<CardHeader className="text-center flex flex-col gap-2 px-6 pt-6 pb-2">
						<div className="mx-auto size-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 mb-1">
							<ServerOff className="size-6" />
						</div>
						<div className="flex items-center justify-center gap-2">
							<CardTitle className="text-xl font-semibold tracking-tight">
								Subversive Server Pending
							</CardTitle>
							<Badge variant="secondary" className="font-mono text-xs">
								FACTION
							</Badge>
						</div>
						<CardDescription className="text-xs text-muted-foreground max-w-sm mx-auto">
							The Subversive faction Discord server has not been configured yet
							by the bot owner.
						</CardDescription>
					</CardHeader>

					<CardContent className="flex flex-col gap-4 px-6 py-4">
						<Alert className="border-amber-500/30 bg-amber-500/5 text-foreground">
							<AlertTriangle className="size-4 text-amber-500" />
							<AlertTitle className="text-xs font-semibold text-amber-500">
								Waiting for Setup
							</AlertTitle>
							<AlertDescription className="text-xs text-muted-foreground mt-1">
								Faction operations are temporarily unavailable while the bot
								owner designates the active server and assigns dashboard
								administrator roles.
							</AlertDescription>
						</Alert>

						<div className="rounded-lg border border-border bg-muted/30 p-3 flex flex-col gap-2">
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground">Connected Account</span>
								<div className="flex items-center gap-1.5">
									<Avatar className="size-5 border border-border">
										{user?.avatar ? (
											<AvatarImage src={user.avatar} alt={user.username} />
										) : null}
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
							onClick={() => void handleCheckAgain()}
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
							onClick={() => void logout()}
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
