import { useEffect, useState } from "react";
import type { DashboardView } from "@/components/AppSidebar";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useElims } from "../contexts/ElimsContext";
import { useRouter } from "../router";
import { ElimsReportPage } from "./ElimsReportPage";
import { GiveawaysPage } from "./GiveawaysPage";
import { GuildConfigPage } from "./GuildConfigPage";
import { ItemRequestsPage } from "./ItemRequestsPage";
import { TeamBreakdownPage } from "./TeamBreakdownPage";

export function DashboardPage() {
	const { isOwner } = useElims();
	const { path, navigate } = useRouter();

	// Determine active view from URL path or default based on owner status
	const determineInitialView = (): DashboardView => {
		if (path === "/guild-config") {
			return "guild-config";
		}
		if (path === "/elims-report") {
			return "elims-report";
		}
		if (path === "/team-breakdown") {
			return "team-breakdown";
		}
		if (path === "/item-requests") {
			return "item-requests";
		}
		if (path === "/giveaways") {
			return "giveaways";
		}
		return isOwner ? "guild-config" : "item-requests";
	};

	const [activeView, setActiveView] =
		useState<DashboardView>(determineInitialView);

	// Synchronize URL hash with active view
	useEffect(() => {
		if (path === "/guild-config") {
			setActiveView("guild-config");
		} else if (path === "/elims-report") {
			setActiveView("elims-report");
		} else if (path === "/team-breakdown") {
			setActiveView("team-breakdown");
		} else if (path === "/item-requests") {
			setActiveView("item-requests");
		} else if (path === "/giveaways") {
			setActiveView("giveaways");
		} else if (path === "/overview") {
			navigate("/elims-report");
			setActiveView("elims-report");
		} else if (path === "/") {
			const target = isOwner ? "/guild-config" : "/item-requests";
			navigate(target);
			setActiveView(isOwner ? "guild-config" : "item-requests");
		}
	}, [path, isOwner, navigate]);

	const handleSelectView = (view: DashboardView) => {
		setActiveView(view);
		navigate(`/${view}`);
	};

	return (
		<DashboardLayout activeView={activeView} onSelectView={handleSelectView}>
			{activeView === "guild-config" ? (
				<GuildConfigPage />
			) : activeView === "elims-report" ? (
				<ElimsReportPage />
			) : activeView === "team-breakdown" ? (
				<TeamBreakdownPage />
			) : activeView === "giveaways" ? (
				<GiveawaysPage />
			) : (
				<ItemRequestsPage />
			)}
		</DashboardLayout>
	);
}
