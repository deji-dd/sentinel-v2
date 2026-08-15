import {
	AlertCircle,
	CheckCircle2,
	Loader2,
	Plus,
	RotateCcw,
	Save,
	Trash2,
	X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { useAuth } from "../contexts/AuthContext";
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
interface ApiKey {
	id: string;
	providedBy: string | null;
	isValid: boolean;
	createdAt: string;
}

interface GuildSettingsPageProps {
	guildId: string;
}

export default function GuildSettingsPage({ guildId }: GuildSettingsPageProps) {
	const { toast } = useToast();
	const { user } = useAuth();

	const [channels, setChannels] = useState<Channel[]>([]);
	const [roles, setRoles] = useState<Role[]>([]);
	const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);

	const [logChannelId, setLogChannelId] = useState("");
	const [initialLogChannel, setInitialLogChannel] = useState("");
	const [adminRoles, setAdminRoles] = useState<string[]>([]);
	const [initialAdminRoles, setInitialAdminRoles] = useState<string[]>([]);
	const [roleInput, setRoleInput] = useState("");
	const [newApiKey, setNewApiKey] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [isAddingKey, setIsAddingKey] = useState(false);
	const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

	const isDirty =
		logChannelId !== initialLogChannel ||
		JSON.stringify(adminRoles) !== JSON.stringify(initialAdminRoles);

	const fetchConfig = useCallback(async () => {
		try {
			const guildRoute = api.api.v1.guilds[guildId];
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
				setApiKeys(
					(data.apiKeys ?? []).map((k) => ({
						id: k.id,
						providedBy: k.providedBy,
						isValid: k.isValid,
						createdAt: k.createdAt ? new Date(k.createdAt).toISOString() : "",
					})),
				);
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
			const guildRoute = api.api.v1.guilds[guildId];
			if (!guildRoute) return;

			await guildRoute.config.put({
				logChannelId: logChannelId || null,
				adminRoleIds: adminRoles,
			});
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

	const handleAddApiKey = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = newApiKey.trim();
		if (!trimmed) {
			toast("Please enter a Torn API key.", "error");
			return;
		}
		if (trimmed.length !== 16) {
			toast(
				"Invalid Torn API key format. Key must be a 16-character string.",
				"error",
			);
			return;
		}
		setIsAddingKey(true);
		try {
			const guildRoute = api.api.v1.guilds[guildId];
			if (!guildRoute) return;

			const res = await guildRoute["api-keys"].post({
				apiKey: trimmed,
				providedBy: user?.username ? `@${user.username}` : "Dashboard Admin",
			});

			if (res.error) {
				const errObj = res.error as unknown;
				let errMsg = "Failed to register API key.";
				if (typeof errObj === "object" && errObj !== null) {
					if (
						"value" in errObj &&
						typeof (errObj as { value: unknown }).value === "object"
					) {
						const val = (errObj as { value: Record<string, unknown> }).value;
						if (val && typeof val.error === "string") errMsg = val.error;
						else if (val && typeof val.message === "string")
							errMsg = val.message;
					} else if (
						"error" in errObj &&
						typeof (errObj as { error: unknown }).error === "string"
					) {
						errMsg = (errObj as { error: string }).error;
					}
				}
				toast(errMsg, "error");
				return;
			}

			toast("API key verified & registered!", "success");
			setNewApiKey("");
			await fetchConfig();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to add API key.";
			toast(msg, "error");
		} finally {
			setIsAddingKey(false);
		}
	};

	const handleDeleteKey = async (keyId: string) => {
		setDeletingKeyId(keyId);
		try {
			const guildRoute = api.api.v1.guilds[guildId];
			const apiKeysRoute = guildRoute?.["api-keys"];
			const keyRoute = apiKeysRoute?.[keyId];
			if (!keyRoute) return;

			await keyRoute.delete();
			toast("API key deleted.", "success");
			await fetchConfig();
		} catch {
			toast("Failed to delete API key.", "error");
		} finally {
			setDeletingKeyId(null);
		}
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

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<div className="flex items-center gap-2.5">
						<div>
							<CardTitle className="text-lg font-semibold tracking-tight">
								API Credentials
							</CardTitle>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-6">
					<form
						onSubmit={(e) => void handleAddApiKey(e)}
						className="flex gap-2.5 max-w-md items-center"
					>
						<Input
							id="api-key-input"
							type="password"
							value={newApiKey}
							onChange={(e) => setNewApiKey(e.target.value)}
							maxLength={16}
							disabled={isAddingKey}
							placeholder="Enter 16-character Torn API Key..."
							className="flex-1 font-mono text-xs rounded-xl"
						/>
						<Button
							type="submit"
							disabled={isAddingKey || !newApiKey.trim()}
							className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer gap-1.5"
						>
							{isAddingKey ? (
								<>
									<Loader2
										className="size-4 animate-spin"
										data-icon="inline-start"
									/>
									<span>Verifying...</span>
								</>
							) : (
								<>
									<Plus className="size-4" data-icon="inline-start" />
									<span>Register Key</span>
								</>
							)}
						</Button>
					</form>

					<div className="space-y-3">
						{apiKeys.length === 0 ? (
							<Alert className="border-border/60 bg-background/50 text-xs">
								<AlertDescription className="text-muted-foreground text-center">
									No Torn API keys registered for this server yet.
								</AlertDescription>
							</Alert>
						) : (
							apiKeys.map((key) => (
								<div
									key={key.id}
									className="p-4 rounded-xl bg-background/60 border border-border/80 flex items-center justify-between gap-4 text-xs"
								>
									<div className="flex items-center gap-3.5 min-w-0">
										{key.isValid ? (
											<div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shrink-0">
												<CheckCircle2 className="size-4" />
											</div>
										) : (
											<div className="p-2 rounded-xl bg-destructive/10 text-destructive border border-destructive/20 shrink-0">
												<AlertCircle className="size-4" />
											</div>
										)}

										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<span className="font-mono text-foreground font-semibold block tracking-widest text-xs">
													••••••••••••••••
												</span>
												<Badge
													variant={key.isValid ? "default" : "destructive"}
													className="text-[9px] font-mono px-1.5 py-0 uppercase font-semibold"
												>
													{key.isValid ? "VALID" : "INVALID"}
												</Badge>
											</div>
											<span className="text-muted-foreground text-[11px] block mt-0.5 truncate">
												Provided by: {key.providedBy ?? "System Admin"} • Added{" "}
												{new Date(key.createdAt).toLocaleDateString()}
											</span>
										</div>
									</div>

									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												disabled={deletingKeyId === key.id}
												className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl cursor-pointer shrink-0"
												title="Delete API Key"
											>
												{deletingKeyId === key.id ? (
													<Loader2 className="size-4 animate-spin" />
												) : (
													<Trash2 className="size-4" />
												)}
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent className="rounded-2xl border-border bg-card">
											<AlertDialogHeader>
												<AlertDialogTitle className="text-lg font-bold">
													Delete API Key?
												</AlertDialogTitle>
												<AlertDialogDescription className="text-xs text-muted-foreground">
													Are you sure you want to remove this Torn API key from
													this server? Background sync operations relying on
													this key will be interrupted.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter className="mt-4 flex gap-2">
												<AlertDialogCancel className="rounded-xl text-xs font-semibold">
													Cancel
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() => void handleDeleteKey(key.id)}
													className="rounded-xl text-xs font-semibold bg-destructive text-white hover:bg-destructive/90"
												>
													Delete Key
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								</div>
							))
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
