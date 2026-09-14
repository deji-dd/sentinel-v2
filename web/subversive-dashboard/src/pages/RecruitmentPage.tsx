import { UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardTitle,
} from "@/components/ui/card";

export function RecruitmentPage() {
	return (
		<div className="flex flex-col gap-6 max-w-6xl mx-auto">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight">Recruitment</h1>
						<Badge variant="secondary" className="font-mono text-xs">
							SUBVERSIVE
						</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						Manage faction recruitment pipelines, applicants, and roster
						intakes.
					</p>
				</div>
			</div>

			{/* Empty State Card */}
			<Card className="border-dashed border-2">
				<CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
					<div className="rounded-full bg-muted p-4 text-muted-foreground">
						<UserPlus className="size-8" />
					</div>
					<div className="flex flex-col gap-1">
						<CardTitle className="text-lg font-semibold">
							No Recruitment Data
						</CardTitle>
						<CardDescription className="max-w-sm text-sm text-muted-foreground">
							Recruitment tracking is not yet populated. New applicant
							submissions and intake logs will appear here.
						</CardDescription>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
