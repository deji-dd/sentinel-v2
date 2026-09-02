import { Loader2, RotateCcw, Save, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import NotInitializedView from "../components/NotInitializedView";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface ModulesPageProps {
	guildId: string;
}

export default function ModulesPage({ guildId }: ModulesPageProps) {
	const { toast } = useToast();
	const { user } = useAuth();

	const isAdmin = user?.role === "owner" || user?.role === "admin";

	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	// Module States
	const [moduleVerification, setModuleVerification] = useState(true);
	const [initialModuleVerification, setInitialModuleVerification] =
		useState(true);
	const [moduleTerritory, setModuleTerritory] = useState(true);
	const [initialModuleTerritory, setInitialModuleTerritory] = useState(true);
	const [moduleReactionRoles, setModuleReactionRoles] = useState(true);
	const [initialModuleReactionRoles, setInitialModuleReactionRoles] =
		useState(true);
	const [moduleMonitoring, setModuleMonitoring] = useState(false);
	const [initialModuleMonitoring, setInitialModuleMonitoring] = useState(false);

	const isDirty =
		moduleVerification !== initialModuleVerification ||
		moduleTerritory !== initialModuleTerritory ||
		moduleReactionRoles !== initialModuleReactionRoles ||
		moduleMonitoring !== initialModuleMonitoring;

	const fetchConfig = useCallback(async () => {
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const configRes = await guildRoute.config.get();

			if (configRes.data) {
				const data = configRes.data;
				if (!data.initialized || !data.config) {
					setIsInitialized(false);
					setLoading(false);
					return;
				}

				setIsInitialized(true);
				const config = data.config as typeof data.config & {
					moduleVerification?: boolean;
					moduleTerritory?: boolean;
					moduleReactionRoles?: boolean;
					moduleMonitoring?: boolean;
				};

				const mv = config.moduleVerification ?? true;
				const mt = config.moduleTerritory ?? true;
				const mrr = config.moduleReactionRoles ?? true;
				const mm = config.moduleMonitoring ?? false;

				setModuleVerification(mv);
				setInitialModuleVerification(mv);
				setModuleTerritory(mt);
				setInitialModuleTerritory(mt);
				setModuleReactionRoles(mrr);
				setInitialModuleReactionRoles(mrr);
				setModuleMonitoring(mm);
				setInitialModuleMonitoring(mm);
			}
		} catch {
			toast("Failed to load module configuration.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	const handleSave = async () => {
		if (!isAdmin) return;
		setIsSaving(true);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.modules.patch({
				moduleVerification,
				moduleTerritory,
				moduleReactionRoles,
				moduleMonitoring,
			});

			if (res.error) {
				const err = res.error as { value?: { error?: string } };
				toast(err.value?.error || "Failed to update modules.", "error");
				return;
			}

			toast("Server modules updated successfully!", "success");
			await fetchConfig();
		} catch {
			toast("An unexpected error occurred while saving modules.", "error");
		} finally {
			setIsSaving(false);
		}
	};

	const handleDiscard = () => {
		setModuleVerification(initialModuleVerification);
		setModuleTerritory(initialModuleTerritory);
		setModuleReactionRoles(initialModuleReactionRoles);
		setModuleMonitoring(initialModuleMonitoring);
		toast("Unsaved changes discarded.", "info");
	};

	if (loading) {
		return (
			<div className="space-y-6 max-w-4xl mx-auto p-6">
				<Skeleton className="h-12 w-64 rounded-xl" />
				<Skeleton className="h-96 w-full rounded-2xl" />
			</div>
		);
	}

	if (!isInitialized) {
		return <NotInitializedView guildId={guildId} />;
	}

	if (!isAdmin) {
		return (
			<div className="max-w-md mx-auto my-24 p-8 rounded-2xl border border-border/80 bg-card/80 backdrop-blur-xl text-center space-y-4">
				<div className="size-12 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center mx-auto">
					<ShieldAlert className="size-6" />
				</div>
				<h2 className="text-lg font-bold text-foreground">Access Restricted</h2>
				<p className="text-xs text-muted-foreground leading-relaxed">
					Server module activation is managed exclusively by Sentinel
					administrators.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-8 max-w-4xl mx-auto p-6 pb-24">
			{/* Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-6">
				<div className="space-y-1">
					<div className="flex items-center gap-2.5">
						<h1 className="text-2xl font-bold tracking-tight text-foreground">
							Server Modules
						</h1>
					</div>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{isDirty && (
						<Button
							variant="ghost"
							size="sm"
							onClick={handleDiscard}
							disabled={isSaving}
							className="rounded-xl text-xs gap-1.5"
						>
							<RotateCcw className="size-3.5" />
							Discard
						</Button>
					)}
					<Button
						onClick={handleSave}
						disabled={!isDirty || isSaving}
						className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-xs gap-1.5 shadow-lg shadow-primary/20"
					>
						{isSaving ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Save className="size-3.5" />
						)}
						Save Changes
					</Button>
				</div>
			</div>

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl overflow-hidden">
				<CardContent className="p-6 space-y-4">
					{/* Verification Module */}
					<div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-border/60 bg-background/50 gap-4">
						<div className="flex items-start gap-3.5">
							<div className="space-y-1">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="font-semibold text-sm text-foreground">
										Verification
									</span>
									<span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
										/verify
									</span>
									<span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
										/verifyall
									</span>
								</div>
							</div>
						</div>
						<div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
							<Switch
								id="module-verification-switch"
								checked={moduleVerification}
								onCheckedChange={setModuleVerification}
							/>
							<Badge
								variant={moduleVerification ? "secondary" : "outline"}
								className={`text-xs font-mono w-18 justify-center ${
									moduleVerification
										? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
										: "text-muted-foreground"
								}`}
							>
								{moduleVerification ? "Active" : "Disabled"}
							</Badge>
						</div>
					</div>

					{/* Territory Module */}
					<div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-border/60 bg-background/50 gap-4">
						<div className="flex items-start gap-3.5">
							<div className="space-y-1">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="font-semibold text-sm text-foreground">
										Territory
									</span>
									<span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
										/tt-selector
									</span>
									<span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
										/assault-check
									</span>
									<span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
										/alliance-map
									</span>
									<span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
										/burn-map
									</span>
								</div>
							</div>
						</div>
						<div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
							<Switch
								id="module-territory-switch"
								checked={moduleTerritory}
								onCheckedChange={setModuleTerritory}
							/>
							<Badge
								variant={moduleTerritory ? "secondary" : "outline"}
								className={`text-xs font-mono w-18 justify-center ${
									moduleTerritory
										? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
										: "text-muted-foreground"
								}`}
							>
								{moduleTerritory ? "Active" : "Disabled"}
							</Badge>
						</div>
					</div>

					{/* Reaction Roles Module */}
					<div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-border/60 bg-background/50 gap-4">
						<div className="flex items-start gap-3.5">
							<div className="space-y-1">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="font-semibold text-sm text-foreground">
										Reaction Roles
									</span>
								</div>
							</div>
						</div>
						<div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
							<Switch
								id="module-reaction-roles-switch"
								checked={moduleReactionRoles}
								onCheckedChange={setModuleReactionRoles}
							/>
							<Badge
								variant={moduleReactionRoles ? "secondary" : "outline"}
								className={`text-xs font-mono w-18 justify-center ${
									moduleReactionRoles
										? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
										: "text-muted-foreground"
								}`}
							>
								{moduleReactionRoles ? "Active" : "Disabled"}
							</Badge>
						</div>
					</div>

					{/* Faction Monitoring Module */}
					<div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-border/60 bg-background/50 gap-4">
						<div className="flex items-start gap-3.5">
							<div className="space-y-1">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="font-semibold text-sm text-foreground">
										Faction Monitoring
									</span>
								</div>
							</div>
						</div>
						<div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
							<Switch
								id="module-monitoring-switch"
								checked={moduleMonitoring}
								onCheckedChange={setModuleMonitoring}
							/>
							<Badge
								variant={moduleMonitoring ? "secondary" : "outline"}
								className={`text-xs font-mono w-18 justify-center ${
									moduleMonitoring
										? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
										: "text-muted-foreground"
								}`}
							>
								{moduleMonitoring ? "Active" : "Disabled"}
							</Badge>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
