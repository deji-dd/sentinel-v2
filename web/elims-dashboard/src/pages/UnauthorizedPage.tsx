import { AlertTriangle, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { useAuth } from "../contexts/AuthContext";
import { useElims } from "../contexts/ElimsContext";

export function UnauthorizedPage() {
	const { logout } = useAuth();
	const { recheckAccess, reason } = useElims();
	const [rechecking, setRechecking] = useState(false);

	const handleRecheck = async () => {
		setRechecking(true);
		try {
			await recheckAccess();
		} finally {
			setRechecking(false);
		}
	};

	const reasonText =
		reason === "not_in_guild"
			? "Your account is not currently a member of this Discord server."
			: "You do not hold any of the designated Administrator roles in this server.";

	return (
		<main className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background text-foreground relative overflow-hidden">
			{/* Theme Switcher in Top Right */}
			<div className="absolute top-4 right-4 z-20">
				<ThemeToggle />
			</div>

			{/* Ambient background glow */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[500px] bg-destructive/5 rounded-full blur-[140px] pointer-events-none" />

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
				</div>

				{/* Access Restricted Card */}
				<Card className="border-border/80 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardContent className="flex flex-col gap-4 px-6 pt-4 pb-0">
						<Alert variant="destructive">
							<AlertTriangle className="size-4" />
							<AlertTitle className="text-xs font-semibold">
								Admin Role Required
							</AlertTitle>
							<AlertDescription className="text-xs mt-1">
								{reasonText} Only designated Guild Admins can view and manage
								the Elimination tournament.
							</AlertDescription>
						</Alert>

						<p className="text-[11px] text-muted-foreground leading-relaxed px-1">
							If you were recently granted the Elims Admin role in Discord,
							click{" "}
							<span className="font-medium text-foreground">
								Re-check Permissions
							</span>{" "}
							below to sync your access immediately.
						</p>
					</CardContent>

					<CardFooter className="flex flex-col sm:flex-row gap-2.5 px-6 pb-2 pt-0">
						<Button
							variant="default"
							className="w-full sm:flex-1 cursor-pointer"
							onClick={handleRecheck}
							disabled={rechecking}
						>
							<RefreshCw
								className={rechecking ? "size-4 animate-spin" : "size-4"}
								data-icon="inline-start"
							/>
							{rechecking ? "Verifying..." : "Re-check Permissions"}
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
