import { useState } from "react";
import type { DashboardView } from "@/components/AppSidebar";
import { DashboardLayout } from "@/components/DashboardLayout";
import { RecruitmentPage } from "./RecruitmentPage";

export function DashboardPage() {
	const [activeView, setActiveView] = useState<DashboardView>("recruitment");

	return (
		<DashboardLayout
			activeView={activeView}
			onSelectView={(view) => setActiveView(view)}
		>
			<RecruitmentPage />
		</DashboardLayout>
	);
}
