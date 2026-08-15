import {
	ChevronRight,
	Loader2,
	MapPin,
	ShieldAlert,
	Smile,
	UserCheck,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useRouter } from "../router";

interface Module {
	key: string;
	name: string;
	description: string;
	icon: React.ElementType;
	href: string;
}

export default function ModulesPage({
	guildId,
	enabledModules,
	onModulesChange,
}: {
	guildId: string;
	enabledModules: string[];
	onModulesChange: (modules: string[]) => void;
}) {
	const { toast } = useToast();
	const { user } = useAuth();
	const { navigate } = useRouter();
	const [saving, setSaving] = useState<string | null>(null);

	const isBotOwner = user?.role === "admin" || user?.role === "owner";

	const availableModules: Module[] = [
		{
			key: "verification",
			name: "Verification Engine",
			description:
				"Torn player verification, automated Discord role assignment, and nickname templates.",
			icon: UserCheck,
			href: `/guilds/${guildId}/verification`,
		},
		{
			key: "territory",
			name: "Territory Assaults",
			description:
				"Real-time territory wall notifications, war alerts, and faction target tracking.",
			icon: MapPin,
			href: `/guilds/${guildId}/territory`,
		},
		{
			key: "reaction_role",
			name: "Reaction Roles",
			description:
				"Self-assignable role menus managed through interactive emoji reactions.",
			icon: Smile,
			href: `/guilds/${guildId}/reaction-roles`,
		},
	];

	const handleToggle = async (moduleKey: string) => {
		if (!isBotOwner) {
			toast(
				"Enabling or disabling modules can only be performed by a Sentinel administrator.",
				"error",
			);
			return;
		}

		const isEnabled = enabledModules.includes(moduleKey);
		const next = isEnabled
			? enabledModules.filter((m) => m !== moduleKey)
			: [...enabledModules, moduleKey];

		setSaving(moduleKey);
		try {
			const res = await fetch(`/api/v1/guilds/${guildId}/config`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabledModules: next }),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(data.error ?? "Failed to update module settings");
			}
			onModulesChange(next);
			toast(
				`Module ${isEnabled ? "disabled" : "enabled"} successfully!`,
				"success",
			);
		} catch (err: unknown) {
			const msg =
				err instanceof Error
					? err.message
					: "Failed to update module settings.";
			toast(msg, "error");
		} finally {
			setSaving(null);
		}
	};

	return (
		<div className="space-y-8">
			{/* Page Header */}
			<div className="pb-6 border-b border-border/60">
				<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
					Module Manager
				</h1>
				<p className="text-muted-foreground text-sm mt-1">
					Enable or disable bot modules and active integrations for this server.
				</p>
			</div>

			{!isBotOwner && (
				<Alert className="border-amber-500/30 bg-amber-500/10 text-amber-200 rounded-2xl p-4">
					<div className="flex items-center gap-3">
						<ShieldAlert className="size-5 text-amber-400 shrink-0" />
						<AlertDescription className="text-xs text-amber-200/90 leading-relaxed">
							Module configuration (enabling or disabling integrations) can only
							be performed by a Sentinel administrator.
						</AlertDescription>
					</div>
				</Alert>
			)}

			<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
				{availableModules.map((mod) => {
					const Icon = mod.icon;
					const isEnabled = enabledModules.includes(mod.key);
					const isSaving = saving === mod.key;

					return (
						<Card
							key={mod.key}
							className={`border-border/80 shadow-lg bg-card/90 backdrop-blur-md rounded-2xl transition-all duration-200 flex flex-col justify-between ${
								isEnabled ? "hover:border-primary/40" : "opacity-75 bg-card/50"
							}`}
						>
							<CardHeader className="p-6 pb-4">
								<div className="flex items-center justify-between gap-4 mb-3">
									<div className="p-2.5 rounded-xl bg-primary/10 text-primary border border-primary/20 shrink-0">
										<Icon className="size-5" />
									</div>

									<div className="flex items-center gap-2">
										{isSaving && (
											<Loader2 className="size-4 animate-spin text-muted-foreground" />
										)}
										<Switch
											id={`module-toggle-${mod.key}`}
											checked={isEnabled}
											onCheckedChange={() => void handleToggle(mod.key)}
											disabled={!isBotOwner || isSaving}
											aria-label={`Toggle ${mod.name}`}
										/>
									</div>
								</div>

								<div className="space-y-1">
									<div className="flex items-center justify-between gap-2">
										<CardTitle className="text-base font-bold tracking-tight">
											{mod.name}
										</CardTitle>
										<Badge
											variant={isEnabled ? "default" : "secondary"}
											className="text-[9px] font-mono uppercase px-1.5 py-0"
										>
											{isEnabled ? "ACTIVE" : "OFF"}
										</Badge>
									</div>
									<CardDescription className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
										{mod.description}
									</CardDescription>
								</div>
							</CardHeader>

							<CardContent className="p-6 pt-2 border-t border-border/40 flex items-center justify-between">
								{isEnabled ? (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => navigate(mod.href)}
										className="text-xs font-semibold text-primary hover:text-primary hover:bg-primary/10 rounded-xl cursor-pointer p-0 h-auto gap-1"
									>
										Configure
										<ChevronRight className="size-3.5" data-icon="inline-end" />
									</Button>
								) : (
									<span className="text-xs text-muted-foreground font-mono">
										Module disabled
									</span>
								)}
							</CardContent>
						</Card>
					);
				})}
			</div>
		</div>
	);
}
