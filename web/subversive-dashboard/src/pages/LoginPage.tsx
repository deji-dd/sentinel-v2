import { AlertCircle, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { useAuth } from "../contexts/AuthContext";

export function LoginPage() {
	const { loginWithDiscord } = useAuth();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const search = window.location.search || window.location.hash;
		if (search.includes("error=access_denied")) {
			setError("Discord authorization was cancelled or denied.");
		} else if (search.includes("error=no_mutual_server")) {
			setError(
				"You must share a Discord server with Sentinel to access this dashboard.",
			);
		} else if (search.includes("error=token_exchange_failed")) {
			setError(
				"Failed to verify authorization with Discord. Please try again.",
			);
		} else if (search.includes("error=")) {
			setError("An unexpected error occurred during authentication.");
		}
	}, []);

	return (
		<div className="flex min-h-screen w-full items-center justify-center p-4 bg-background relative">
			<div className="absolute top-4 right-4">
				<ModeToggle />
			</div>
			<Card className="w-full max-w-md shadow-lg border-border">
				<CardHeader className="text-center flex flex-col items-center gap-2">
					<div className="p-3 rounded-xl bg-primary/10 border border-primary/20 text-primary">
						<Shield className="size-8" />
					</div>
					<div className="flex items-center gap-2">
						<CardTitle className="text-2xl font-bold tracking-tight">
							Subversive Alliance
						</CardTitle>
					</div>
				</CardHeader>

				<CardContent className="flex flex-col gap-4">
					{error ? (
						<Alert variant="destructive">
							<AlertCircle className="size-4" />
							<AlertTitle>Authentication Error</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<Button
						onClick={loginWithDiscord}
						className="w-full h-10 font-medium cursor-pointer"
						size="lg"
					>
						Connect with Discord
					</Button>
				</CardContent>

				<CardFooter className="flex justify-center border-t border-border pt-4">
					<p className="text-xs text-muted-foreground">Made by Blasted</p>
				</CardFooter>
			</Card>
		</div>
	);
}
