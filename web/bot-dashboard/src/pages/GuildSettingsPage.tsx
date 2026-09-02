import { Loader2, Plus, RotateCcw, Save, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import NotInitializedView from "../components/NotInitializedView";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface Channel {
	id: string;
	name: string;
	type: number;
}
interface Role {
	id: string;
	name: string;
	color: number;
}

interface GuildSettingsPageProps {
	guildId: string;
}

export default function GuildSettingsPage({ guildId }: GuildSettingsPageProps) {
	const { toast } = useToast();

	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	// Discord Data
	const [channels, setChannels] = useState<Channel[]>([]);
	const [roles, setRoles] = useState<Role[]>([]);

	// Form state
	const [logChannelId, setLogChannelId] = useState<string>("");
	const [initialLogChannel, setInitialLogChannel] = useState<string>("");
	const [adminRoles, setAdminRoles] = useState<string[]>([]);
	const [initialAdminRoles, setInitialAdminRoles] = useState<string[]>([]);
	const [roleInput, setRoleInput] = useState("");

	const isDirty =
		logChannelId !== initialLogChannel ||
		JSON.stringify(adminRoles) !== JSON.stringify(initialAdminRoles);

	const fetchConfig = useCallback(async () => {
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const [configRes, channelsRes, rolesRes] = await Promise.all([
				guildRoute.config.get(),
				guildRoute.channels.get(),
				guildRoute.roles.get(),
			]);

			if (configRes.data) {
				const data = configRes.data;
				if (!data.initialized || !data.config) {
					setIsInitialized(false);
					setLoading(false);
					return;
				}

				setIsInitialized(true);
				const config = data.config;
				setLogChannelId(config.logChannelId ?? "");
				setInitialLogChannel(config.logChannelId ?? "");
				setAdminRoles(config.adminRoleIds ?? []);
				setInitialAdminRoles(config.adminRoleIds ?? []);
			}

			if (channelsRes.data && "channels" in channelsRes.data) {
				setChannels(channelsRes.data.channels);
			}

			if (rolesRes.data && "roles" in rolesRes.data) {
				setRoles(rolesRes.data.roles);
			}
		} catch {
			toast("Failed to load guild settings.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			await guildRoute.config.put({
				logChannelId: logChannelId || null,
				adminRoleIds: adminRoles,
			} as never);
			toast("Settings saved successfully!", "success");
			await fetchConfig();
		} catch {
			toast("Failed to save settings.", "error");
		} finally {
			setIsSaving(false);
		}
	};

	const handleDiscard = () => {
		setLogChannelId(initialLogChannel);
		setAdminRoles(initialAdminRoles);
		toast("Unsaved changes discarded.", "info");
	};

	const handleAddRole = () => {
		if (!roleInput) return;
		if (adminRoles.includes(roleInput)) {
			toast("Role already added.", "info");
			return;
		}
		setAdminRoles([...adminRoles, roleInput]);
		setRoleInput("");
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3 py-4 border-b border-border/60">
					<Loader2 className="size-5 animate-spin text-primary" />
					<span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
						Loading General Settings...
					</span>
				</div>
				{[1, 2, 3].map((i) => (
					<Card
						key={`skeleton-${i}`}
						className="p-6 border-border/60 bg-card/60"
					>
						<Skeleton className="h-6 w-1/3 mb-4" />
						<Skeleton className="h-10 w-full rounded-xl mb-2" />
						<Skeleton className="h-4 w-1/2" />
					</Card>
				))}
			</div>
		);
	}

	if (!isInitialized) {
		return <NotInitializedView guildId={guildId} />;
	}

	return (
		<div className="space-y-8 pb-12">
			<div className="pb-6 border-b border-border/60">
				<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
					General Settings
				</h1>
			</div>

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<div className="flex items-center gap-2.5">
						<div>
							<CardTitle className="text-lg font-semibold tracking-tight">
								Audit Log Channel
							</CardTitle>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 flex flex-col max-w-md">
						<label
							className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
							htmlFor="log-channel-select"
						>
							Target Discord Channel
						</label>
						{channels.length > 0 ? (
							<Select
								value={logChannelId}
								onValueChange={(val) =>
									setLogChannelId(val === "none" ? "" : val)
								}
							>
								<SelectTrigger
									id="log-channel-select"
									className="w-xs h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Audit Log Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground">
									<SelectGroup>
										<SelectItem value="none">
											-- No Audit Log Channel Selected --
										</SelectItem>
										{channels
											.filter((c) => c.type === 0)
											.map((ch) => (
												<SelectItem key={ch.id} value={ch.id}>
													#{ch.name}
												</SelectItem>
											))}
									</SelectGroup>
								</SelectContent>
							</Select>
						) : (
							<Input
								id="log-channel-select"
								type="text"
								value={logChannelId}
								onChange={(e) => setLogChannelId(e.target.value)}
								placeholder="Enter Discord Channel ID (e.g. 109624361368...)"
								className="font-mono text-xs rounded-xl"
							/>
						)}
						{logChannelId && (
							<div className="mt-2 w-fit inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground">SELECTED:</span>
								<span className="text-primary font-semibold">
									{channels.find((c) => c.id === logChannelId)?.name
										? `#${channels.find((c) => c.id === logChannelId)?.name}`
										: logChannelId}
								</span>
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<div className="flex items-center gap-2.5">
						<div>
							<CardTitle className="text-lg font-semibold tracking-tight">
								Administrator Roles
							</CardTitle>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex gap-2.5 max-w-md items-center">
						{roles.length > 0 ? (
							<Select
								value={roleInput}
								onValueChange={(val) => setRoleInput(val)}
							>
								<SelectTrigger
									id="admin-role-select"
									className="flex-1 h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- Select Role to Add --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
									<SelectGroup>
										{roles.map((r) => (
											<SelectItem key={r.id} value={r.id}>
												@{r.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						) : (
							<Input
								id="admin-role-input"
								type="text"
								value={roleInput}
								onChange={(e) => setRoleInput(e.target.value)}
								placeholder="Enter Discord Role ID"
								className="flex-1 font-mono text-xs rounded-xl"
							/>
						)}
						<Button
							type="button"
							onClick={handleAddRole}
							className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
						>
							<Plus className="size-4" data-icon="inline-start" />
							Add Role
						</Button>
					</div>

					<div className="flex flex-wrap gap-2">
						{adminRoles.length === 0 ? (
							<p className="text-xs text-muted-foreground italic">
								No admin roles configured. Server owners and bot administrators
								always have full access.
							</p>
						) : (
							adminRoles.map((roleId) => {
								const roleObj = roles.find((r) => r.id === roleId);
								return (
									<Badge
										key={roleId}
										variant="secondary"
										className="pl-3 pr-1.5 py-1 rounded-xl text-xs font-medium flex items-center gap-1.5 border border-border"
									>
										<span>{roleObj ? `@${roleObj.name}` : roleId}</span>
										<button
											type="button"
											onClick={() =>
												setAdminRoles((prev) =>
													prev.filter((id) => id !== roleId),
												)
											}
											className="size-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors"
											aria-label={`Remove role ${roleObj?.name ?? roleId}`}
										>
											<X className="size-3" />
										</button>
									</Badge>
								);
							})
						)}
					</div>
				</CardContent>
			</Card>

			<div className="pt-6 border-t border-border/60 flex items-center justify-between gap-4">
				<div className="text-xs text-muted-foreground font-mono">
					{isDirty ? (
						<span className="text-amber-500 flex items-center gap-2 font-medium">
							<span className="size-2 rounded-full bg-amber-500 animate-pulse" />
							Unsaved changes pending
						</span>
					) : (
						<span className="text-muted-foreground">All settings saved</span>
					)}
				</div>

				<div className="flex items-center gap-3">
					{isDirty && (
						<Button
							type="button"
							variant="outline"
							onClick={handleDiscard}
							disabled={isSaving}
							className="h-10 px-4 rounded-xl text-xs font-semibold cursor-pointer"
						>
							<RotateCcw className="size-3.5" data-icon="inline-start" />
							Discard Changes
						</Button>
					)}

					<Button
						type="button"
						onClick={() => void handleSave()}
						disabled={isSaving || !isDirty}
						className="h-10 px-6 rounded-xl text-xs font-semibold cursor-pointer"
					>
						{isSaving ? (
							<>
								<Loader2
									className="size-4 animate-spin"
									data-icon="inline-start"
								/>
								Saving Changes...
							</>
						) : (
							<>
								<Save className="size-4" data-icon="inline-start" />
								Save Changes
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
