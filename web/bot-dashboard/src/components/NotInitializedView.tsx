import { ArrowLeft, Send, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { useToast } from "../contexts/ToastContext";
import { useRouter } from "../router";

interface NotInitializedViewProps {
	guildId: string;
	guildName?: string;
}

export default function NotInitializedView({
	guildId,
	guildName,
}: NotInitializedViewProps) {
	const { toast } = useToast();
	const { navigate } = useRouter();
	const [requested, setRequested] = useState(false);
	const [loading, setLoading] = useState(false);

	const handleRequestInit = async () => {
		setLoading(true);
		try {
			await new Promise((res) => setTimeout(res, 600));
			setRequested(true);
			toast(
				"Initialization request submitted to Sentinel administrator!",
				"success",
			);
		} catch {
			toast("Failed to submit request.", "error");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex flex-col items-center justify-center min-h-[70vh] p-4 font-sans">
			<Card className="max-w-md w-full border-amber-500/30 shadow-2xl bg-card/90 backdrop-blur-md rounded-2xl p-6 sm:p-8 text-center space-y-6">
				<CardHeader className="p-0 space-y-4">
					<div className="size-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto shadow-inner">
						<ShieldAlert className="size-8" />
					</div>

					<div className="space-y-1.5">
						<CardTitle className="text-2xl font-extrabold tracking-tight text-foreground">
							Sentinel Not Initialized
						</CardTitle>
						<CardDescription className="text-xs text-muted-foreground leading-relaxed">
							This server exists on Discord, but its Sentinel configuration
							database has not been initialized yet. Initialization can only be
							performed by a Sentinel administrator.
						</CardDescription>
					</div>
				</CardHeader>

				<CardContent className="p-0 space-y-5">
					<div className="p-4 rounded-xl bg-background/60 border border-border/80 text-xs font-mono space-y-2.5 text-left">
						{guildName && (
							<div className="flex justify-between items-center gap-2">
								<span className="text-muted-foreground text-[11px]">
									SERVER NAME:
								</span>
								<span className="font-bold text-foreground truncate max-w-[180px]">
									{guildName}
								</span>
							</div>
						)}
						<div className="flex justify-between items-center gap-2">
							<span className="text-muted-foreground text-[11px]">
								GUILD ID:
							</span>
							<span className="text-foreground">{guildId}</span>
						</div>
						<div className="flex justify-between items-center gap-2">
							<span className="text-muted-foreground text-[11px]">STATUS:</span>
							<Badge
								variant="outline"
								className="border-amber-500/40 bg-amber-500/10 text-amber-400 text-[10px] font-mono font-bold uppercase"
							>
								UNINITIALIZED
							</Badge>
						</div>
					</div>

					<div className="flex items-center gap-3 pt-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => navigate("/")}
							className="flex-1 h-10 rounded-xl text-xs font-semibold gap-2 cursor-pointer"
						>
							<ArrowLeft className="size-4" />
							Dashboard
						</Button>

						<Button
							type="button"
							onClick={() => void handleRequestInit()}
							disabled={loading || requested}
							className="flex-1 h-10 rounded-xl text-xs font-semibold gap-2 cursor-pointer"
						>
							<Send className="size-4" />
							{requested
								? "Request Sent"
								: loading
									? "Sending..."
									: "Request Init"}
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
