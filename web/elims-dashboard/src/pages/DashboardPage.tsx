import { useEffect, useState } from "react";
import type { DashboardView } from "@/components/AppSidebar";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useElims } from "../contexts/ElimsContext";
import { useRouter } from "../router";
import { GuildConfigPage } from "./GuildConfigPage";
import { ItemRequestsPage } from "./ItemRequestsPage";

export function DashboardPage() {
	const { isOwner } = useElims();
	const { path, navigate } = useRouter();

	// Determine active view from URL path or default based on owner status
	const determineInitialView = (): DashboardView => {
		if (path === "/guild-config") {
			return "guild-config";
		}
		if (path === "/item-requests") {
			return "item-requests";
		}
		return isOwner ? "guild-config" : "item-requests";
	};

	const [activeView, setActiveView] =
		useState<DashboardView>(determineInitialView);

	// Synchronize URL hash with active view
	useEffect(() => {
		if (path === "/guild-config") {
			setActiveView("guild-config");
		} else if (path === "/item-requests") {
			setActiveView("item-requests");
		} else if (path === "/overview") {
			// Overview is disabled & inaccessible, redirect to item-requests
			navigate("/item-requests");
			setActiveView("item-requests");
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
			) : (
				<ItemRequestsPage />
			)}
		</DashboardLayout>
	);
}
