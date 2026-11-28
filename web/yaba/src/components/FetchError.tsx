import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export function FetchError({ message }: { message: string }) {
	return (
		<Alert variant="destructive">
			<TriangleAlert className="size-4 shrink-0" />
			<AlertDescription className="min-w-0 break-anywhere">
				{message}
			</AlertDescription>
		</Alert>
	);
}
