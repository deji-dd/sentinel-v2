import {
	Clock,
	Database,
	KeyRound,
	Radio,
	Settings as SettingsIcon,
	Terminal,
} from "lucide-react";
import { type ElementType, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { LoadingProvider, useGlobalLoading } from "@/contexts/LoadingContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { DashboardLayout } from "@/layouts/DashboardLayout";
import { BattlestatsLedgerPage } from "@/pages/BattlestatsLedgerPage";
import { CrimeLedgerPage } from "@/pages/CrimeLedgerPage";
import { LogManagerPage } from "@/pages/LogManagerPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { StocksLedgerPage } from "@/pages/StocksLedgerPage";
import { WealthPage } from "@/pages/WealthPage";
import { RouterProvider, useRouter } from "@/router";

function PlaceholderView({
	title,
	icon: Icon,
	description,
}: {
	title: string;
	icon: ElementType;
	description: string;
}) {
	const { path, navigate } = useRouter();
	const { setPageReady } = useGlobalLoading();

	useEffect(() => {
		setPageReady(path);
	}, [path, setPageReady]);

	return (
		<div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 space-y-4">
			<div className="size-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-[0_0_20px_rgba(56,189,248,0.2)]">
				<Icon className="size-7" />
			</div>
			<div className="space-y-1 max-w-md">
				<h2 className="text-xl font-bold font-display text-foreground">
					{title}
				</h2>
				<p className="text-xs text-muted-foreground leading-relaxed">
					{description}
				</p>
			</div>
			<div className="flex items-center gap-2 pt-2">
				<Button
					variant="outline"
					size="sm"
					onClick={() => navigate("/")}
					className="rounded-xl text-xs cursor-pointer"
				>
					Return to Overview
				</Button>
			</div>
		</div>
	);
}

function MainRouter() {
	const { path } = useRouter();

	if (path === "/" || path === "/overview" || path === "") {
		return <OverviewPage />;
	}

	if (
		path === "/log-manager" ||
		path === "/personal-logs" ||
		path === "/logs"
	) {
		return <LogManagerPage />;
	}

	if (
		path === "/crime-ledger" ||
		path === "/crimes" ||
		path === "/personal-crimes"
	) {
		return <CrimeLedgerPage />;
	}

	if (
		path === "/battlestats-ledger" ||
		path === "/battlestats" ||
		path === "/gym-ledger" ||
		path === "/gym" ||
		path === "/personal-gym" ||
		path === "/personal-battlestats"
	) {
		return <BattlestatsLedgerPage />;
	}

	if (
		path === "/stocks-ledger" ||
		path === "/stocks" ||
		path === "/stock-ledger" ||
		path === "/personal-stocks"
	) {
		return <StocksLedgerPage />;
	}

	if (path === "/wealth") {
		return <WealthPage />;
	}

	if (path === "/services") {
		return <OverviewPage />;
	}

	if (path === "/scheduler") {
		return (
			<PlaceholderView
				title="Task Scheduler & Job Telemetry"
				icon={Clock}
				description="Manage and inspect BullMQ recurring workers, territory timers, and periodic alliance refresh intervals."
			/>
		);
	}

	if (path === "/torn-api") {
		return (
			<PlaceholderView
				title="Torn API Key Pool & Rate Limits"
				icon={KeyRound}
				description="Manage active Torn OpenAPI v2 keyring, inspect quota usage per key, and configure sliding window rate limiters."
			/>
		);
	}

	if (path === "/database") {
		return (
			<PlaceholderView
				title="Database Engine & WAL Journal"
				icon={Database}
				description="Inspect SQLite WAL checkpoint logs, table schemas, migrations, and active query execution telemetry."
			/>
		);
	}

	if (path === "/ipc") {
		return (
			<PlaceholderView
				title="Unix Domain Socket Daemon"
				icon={Radio}
				description="Low-level inter-process communication diagnostics, binary frame throughput, and peer handshake states."
			/>
		);
	}

	if (path === "/system-logs") {
		return (
			<PlaceholderView
				title="Aggregated System Logs"
				icon={Terminal}
				description="Unified streaming stdout/stderr buffer across Sentinel API, Bot Gateway, and Cron Scheduler."
			/>
		);
	}

	if (path === "/settings") {
		return (
			<PlaceholderView
				title="System & Fleet Configuration"
				icon={SettingsIcon}
				description="Cluster environment variables, encryption keys, and webhook notification destinations."
			/>
		);
	}

	return <OverviewPage />;
}

export function App() {
	return (
		<ThemeProvider>
			<RouterProvider>
				<LoadingProvider>
					<DashboardLayout>
						<MainRouter />
					</DashboardLayout>
					<Toaster richColors position="top-right" />
				</LoadingProvider>
			</RouterProvider>
		</ThemeProvider>
	);
}
