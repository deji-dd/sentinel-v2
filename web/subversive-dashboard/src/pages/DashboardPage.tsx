import { useEffect, useState } from "react";
import type { DashboardView } from "@/components/AppSidebar";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useRouter } from "../router";
import { GuildConfigPage } from "./GuildConfigPage";
import { RecruitmentPage } from "./RecruitmentPage";

export function DashboardPage() {
	const { path, navigate } = useRouter();

	const determineInitialView = (): DashboardView => {
		if (path === "/guild-config") {
			return "guild-config";
		}
		return "recruitment";
	};

	const [activeView, setActiveView] =
		useState<DashboardView>(determineInitialView);

	useEffect(() => {
		if (path === "/guild-config") {
			setActiveView("guild-config");
		} else if (path === "/recruitment") {
			setActiveView("recruitment");
		} else if (path === "/") {
			navigate("/recruitment");
			setActiveView("recruitment");
		}
	}, [path, navigate]);

	return (
		<DashboardLayout
			activeView={activeView}
			onSelectView={(view) => {
				setActiveView(view);
				navigate(`/${view}`);
			}}
		>
			{activeView === "guild-config" ? (
				<GuildConfigPage />
			) : (
				<RecruitmentPage />
			)}
		</DashboardLayout>
	);
}
