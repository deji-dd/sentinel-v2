import { AlertTriangle, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { useAuth } from "../contexts/AuthContext";
import { useSubversive } from "../contexts/SubversiveContext";

export function UnauthorizedPage() {
	const { logout } = useAuth();
	const { recheckAccess, reason } = useSubversive();
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
		<main className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background text-foreground relative">
			<div className="absolute top-4 right-4">
				<ModeToggle />
			</div>
			<div className="w-full max-w-lg flex flex-col gap-6">
				{/* App Branding */}
				<div className="flex flex-col items-center gap-3 text-center">
					<Avatar className="size-16 border border-border shadow-md bg-card">
						<AvatarFallback className="font-mono font-bold text-xs">
							SB
						</AvatarFallback>
					</Avatar>
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight text-foreground font-mono uppercase">
							Subversive
						</h1>
						<Badge
							variant="outline"
							className="text-[10px] font-mono px-2 py-0.5"
						>
							FACTION
						</Badge>
					</div>
				</div>

				{/* Access Restricted Card */}
				<Card className="border-border shadow-lg">
					<CardContent className="flex flex-col gap-4 px-6 pt-6 pb-2">
						<Alert variant="destructive">
							<AlertTriangle className="size-4" />
							<AlertTitle className="text-xs font-semibold">
								Admin Role Required
							</AlertTitle>
							<AlertDescription className="text-xs mt-1">
								{reasonText} Only designated Guild Admins can view and manage
								the Subversive faction dashboard.
							</AlertDescription>
						</Alert>

						<p className="text-xs text-muted-foreground leading-relaxed px-1">
							If you were recently granted the Subversive Admin role in Discord,
							click{" "}
							<span className="font-medium text-foreground">
								Re-check Permissions
							</span>{" "}
							below to sync your access immediately.
						</p>
					</CardContent>

					<CardFooter className="flex flex-col sm:flex-row gap-2.5 px-6 pb-6 pt-2">
						<Button
							variant="default"
							className="w-full sm:flex-1 cursor-pointer"
							onClick={() => void handleRecheck()}
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
