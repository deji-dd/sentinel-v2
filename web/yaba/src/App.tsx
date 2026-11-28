import type { ReactNode } from "react";
import { useEffect } from "react";

import { AppHeader } from "@/components/AppHeader";
import { PageShell } from "@/components/PageShell";
import { AuthProvider } from "@/contexts/AuthContext";
import { useHashRoute } from "@/hooks/useHashRoute";
import type { RouteKey } from "@/lib/navigation";
import { AdminPage } from "@/pages/AdminPage";
import { CombatOverviewPage } from "@/pages/CombatOverviewPage";
import { FactionsPage } from "@/pages/FactionsPage";
import { MembersPage } from "@/pages/MembersPage";
import { MethodologyPage } from "@/pages/MethodologyPage";
import { ProspectivePage } from "@/pages/ProspectivePage";
import { RankingBuilderPage } from "@/pages/RankingBuilderPage";
import { ReviveOverviewPage } from "@/pages/ReviveOverviewPage";

function renderPage(route: RouteKey): ReactNode {
	switch (route) {
		case "combat":
			return <CombatOverviewPage />;
		case "revive":
			return <ReviveOverviewPage />;
		case "members":
			return <MembersPage />;
		case "builder":
			return <RankingBuilderPage />;
		case "prospective":
			return <ProspectivePage />;
		case "methodology":
			return <MethodologyPage />;
		case "admin":
			return <AdminPage />;
		case "factions":
		default:
			return <FactionsPage />;
	}
}

function Report() {
	const route = useHashRoute();

	useEffect(() => {
		window.scrollTo({ top: 0, behavior: "smooth" });
	}, [route]);

	return (
		<div className="min-h-dvh w-full bg-background text-foreground">
			<AppHeader route={route} />
			<PageShell
				key={`${route}:${window.location.hash}`}
				className="px-4 pt-6 sm:px-6 sm:pt-8"
			>
				{renderPage(route)}
				<footer className="border-t border-border/60 pt-4 text-xs text-muted-foreground">
					YABA faction activity report - Blasted Labs
				</footer>
			</PageShell>
		</div>
	);
}

export function App() {
	return (
		<AuthProvider>
			<Report />
		</AuthProvider>
	);
}
