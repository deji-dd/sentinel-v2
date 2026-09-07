import {
	Check,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	Hash,
	Key,
	Plus,
	RefreshCw,
	Save,
	Send,
	Server,
	Trash2,
	User,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatTctTimestamp } from "@/lib/utils";
import { useElims } from "../contexts/ElimsContext";
import { useRouter } from "../router";

interface GuildRole {
	id: string;
	name: string;
	color: number;
	position: number;
	managed: boolean;
}

interface DiscordChannel {
	id: string;
	name: string;
	type: number;
}

interface ElimsApiKey {
	id: string;
	tornId: number;
	tornName: string;
	isValid: boolean;
	invalidCount: number;
	donatedByDiscordId?: string | null;
	donatedByDiscordTag?: string | null;
	lastUsedAt: string | null;
	createdAt: string;
}

function formatRoleColor(color: number): string {
	if (color === 0) return "#94a3b8";
	return `#${color.toString(16).padStart(6, "0")}`;
}

export function GuildConfigPage() {
	const { guild, isOwner, adminRoleIds, refreshStatus } = useElims();
	const { navigate } = useRouter();

	const [roles, setRoles] = useState<GuildRole[]>([]);
	const [loadingRoles, setLoadingRoles] = useState(false);
	const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
		new Set(adminRoleIds),
	);
	const [roleSearch, setRoleSearch] = useState("");
	const [savingSettings, setSavingSettings] = useState(false);
	const [savingGeneral, setSavingGeneral] = useState(false);

	// API Keys state
	const [apiKeys, setApiKeys] = useState<ElimsApiKey[]>([]);
	const [loadingKeys, setLoadingKeys] = useState(false);
	const [newApiKey, setNewApiKey] = useState("");
	const [addingKey, setAddingKey] = useState(false);
	const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
	const [keysPage, setKeysPage] = useState(1);
	const KEYS_PER_PAGE = 6;
	const totalKeyPages = Math.max(1, Math.ceil(apiKeys.length / KEYS_PER_PAGE));
	const paginatedKeys = useMemo(() => {
		const start = (keysPage - 1) * KEYS_PER_PAGE;
		return apiKeys.slice(start, start + KEYS_PER_PAGE);
	}, [apiKeys, keysPage]);

	// Key Donation Channel state
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [loadingChannels, setLoadingChannels] = useState(false);
	const [donationChannelId, setDonationChannelId] = useState<string | null>(
		null,
	);
	const [originalDonationChannelId, setOriginalDonationChannelId] = useState<
		string | null
	>(null);
	const [savingChannel, setSavingChannel] = useState(false);
	const [syncingEmbed, setSyncingEmbed] = useState(false);

	// Fetch API keys and configured donation channel
	const fetchApiKeys = useCallback(async () => {
		setLoadingKeys(true);
		try {
			const res = await fetch("/api/v1/elims/api-keys");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				keys?: ElimsApiKey[];
				channelId?: string | null;
			};
			if (data?.keys && Array.isArray(data.keys)) {
				setApiKeys(data.keys);
			}
			if (data?.channelId !== undefined) {
				setDonationChannelId(data.channelId ?? null);
				setOriginalDonationChannelId(data.channelId ?? null);
			}
		} catch (err) {
			console.error("Failed to load elims API keys:", err);
			toast.error("Failed to load server API keys.");
		} finally {
			setLoadingKeys(false);
		}
	}, []);

	// Fetch Guild text channels
	const fetchChannels = useCallback(async () => {
		if (!guild?.id) return;
		setLoadingChannels(true);
		try {
			const res = await fetch(`/api/v1/elims/guild-channels/${guild.id}`);
			if (!res.ok) throw new Error("Failed to load guild channels");
			const data = (await res.json()) as { channels?: DiscordChannel[] };
			if (data?.channels && Array.isArray(data.channels)) {
				setChannels(data.channels.filter((c) => c.type === 0 || c.type === 5));
			}
		} catch (err) {
			console.error("Failed to load guild channels:", err);
		} finally {
			setLoadingChannels(false);
		}
	}, [guild?.id]);

	useEffect(() => {
		void fetchApiKeys();
		void fetchChannels();
	}, [fetchApiKeys, fetchChannels]);

	const handleSaveDonationChannel = async (): Promise<boolean> => {
		setSavingChannel(true);
		try {
			const res = await fetch("/api/v1/elims/api-keys/channel", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ channelId: donationChannelId }),
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Failed to save key donation channel.");
			}
			setOriginalDonationChannelId(donationChannelId);
			toast.success(
				donationChannelId
					? "Key donation channel updated! Persistent embed dispatched."
					: "Key donation channel disabled.",
			);
			return true;
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Error saving donation channel";
			toast.error(msg);
			return false;
		} finally {
			setSavingChannel(false);
		}
	};

	const handleSyncEmbed = async () => {
		setSyncingEmbed(true);
		try {
			const res = await fetch("/api/v1/elims/api-keys/channel/sync", {
				method: "POST",
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Failed to sync key donation embed.");
			}
			toast.success("Key donation embed synchronization triggered!");
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Error syncing donation embed";
			toast.error(msg);
		} finally {
			setSyncingEmbed(false);
		}
	};

	const handleAddApiKey = async (e?: React.FormEvent) => {
		if (e) e.preventDefault();
		const trimmed = newApiKey.trim();
		if (!trimmed) {
			toast.error("Please enter a Torn API key.");
			return;
		}
		if (trimmed.length !== 16) {
			toast.error("Torn API keys must be exactly 16 alphanumeric characters.");
			return;
		}

		setAddingKey(true);
		try {
			const res = await fetch("/api/v1/elims/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: trimmed }),
			});

			const data = (await res.json()) as {
				error?: string;
				success?: boolean;
				key?: ElimsApiKey;
			};

			if (!res.ok || !data.success) {
				throw new Error(data.error ?? "Failed to add API key.");
			}

			toast.success("API key verified and registered!");
			setNewApiKey("");
			await fetchApiKeys();
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Error registering API key";
			toast.error(msg);
		} finally {
			setAddingKey(false);
		}
	};

	const handleDeleteApiKey = async (keyId: string) => {
		setDeletingKeyId(keyId);
		try {
			const res = await fetch(`/api/v1/elims/api-keys/${keyId}`, {
				method: "DELETE",
			});

			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Failed to delete API key");
			}

			toast.success("API key deleted.");
			setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error deleting key";
			toast.error(msg);
		} finally {
			setDeletingKeyId(null);
		}
	};

	// Keep selected roles in sync with context
	useEffect(() => {
		setSelectedRoleIds(new Set(adminRoleIds));
	}, [adminRoleIds]);

	// Fetch guild roles on load
	useEffect(() => {
		if (!guild?.id) return;

		setLoadingRoles(true);
		fetch(`/api/v1/elims/guild-roles/${guild.id}`)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.then((data: unknown) => {
				if (
					data &&
					typeof data === "object" &&
					"roles" in data &&
					Array.isArray(data.roles)
				) {
					setRoles(data.roles as GuildRole[]);
				}
			})
			.catch((err) => {
				console.error("Failed to load roles:", err);
				toast.error("Failed to load Discord server roles.");
			})
			.finally(() => setLoadingRoles(false));
	}, [guild?.id]);

	const toggleRole = (roleId: string) => {
		setSelectedRoleIds((prev) => {
			const next = new Set(prev);
			if (next.has(roleId)) {
				next.delete(roleId);
			} else {
				next.add(roleId);
			}
			return next;
		});
	};

	const handleSaveRoles = async (): Promise<boolean> => {
		setSavingSettings(true);
		try {
			const res = await fetch("/api/v1/elims/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					adminRoleIds: Array.from(selectedRoleIds),
				}),
			});

			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Failed to update settings");
			}

			toast.success("Elims Admin roles updated successfully!");
			await refreshStatus();
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error saving settings";
			toast.error(msg);
			return false;
		} finally {
			setSavingSettings(false);
		}
	};

	const filteredRoles = roles.filter((r) =>
		r.name.toLowerCase().includes(roleSearch.toLowerCase().trim()),
	);

	const originalRoleIdsSet = useMemo(
		() => new Set(adminRoleIds),
		[adminRoleIds],
	);

	const hasRoleChanges = useMemo(() => {
		if (selectedRoleIds.size !== originalRoleIdsSet.size) return true;
		for (const id of selectedRoleIds) {
			if (!originalRoleIdsSet.has(id)) return true;
		}
		return false;
	}, [selectedRoleIds, originalRoleIdsSet]);

	const hasChannelChanges = donationChannelId !== originalDonationChannelId;

	const hasUnsavedChanges = hasRoleChanges || hasChannelChanges;

	const isSaving = savingGeneral || savingSettings || savingChannel;

	const handleSaveAll = async () => {
		if (!hasUnsavedChanges) {
			toast.info("No unsaved changes to save.");
			return;
		}

		setSavingGeneral(true);
		try {
			const tasks: Promise<boolean>[] = [];
			if (hasRoleChanges) {
				tasks.push(handleSaveRoles());
			}
			if (hasChannelChanges) {
				tasks.push(handleSaveDonationChannel());
			}
			await Promise.all(tasks);
		} finally {
			setSavingGeneral(false);
		}
	};

	const handleResetChanges = () => {
		setSelectedRoleIds(new Set(adminRoleIds));
		setDonationChannelId(originalDonationChannelId);
		toast.info("Unsaved changes discarded.");
	};

	return (
		<div className="flex flex-col gap-6 max-w-5xl w-full mx-auto pb-6">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-4">
				<div className="flex items-center gap-2">
					{isOwner && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => navigate("/setup")}
							className="text-xs cursor-pointer"
						>
							<Server className="size-3.5" data-icon="inline-start" />
							Reconfigure Server
						</Button>
					)}
					<Button
						variant="default"
						size="sm"
						onClick={handleSaveAll}
						disabled={isSaving || !hasUnsavedChanges}
						className="text-xs cursor-pointer font-medium"
					>
						{isSaving ? (
							<>
								<RefreshCw
									className="size-3.5 animate-spin"
									data-icon="inline-start"
								/>
								Saving Settings...
							</>
						) : (
							<>
								<Save className="size-3.5" data-icon="inline-start" />
								Save Settings
							</>
						)}
					</Button>
				</div>
			</div>

			{/* Role Management Section */}
			<Card className="border-border/80 shadow-xs">
				<CardHeader>
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<div>
							<CardTitle className="text-base flex items-center gap-2">
								Administrator Roles
							</CardTitle>
							<CardDescription className="text-xs mt-1">
								Users with any selected Discord role will be granted access to
								the Elims Dashboard.
							</CardDescription>
						</div>
						<Badge variant="outline" className="font-mono text-xs w-fit">
							{selectedRoleIds.size} selected
						</Badge>
					</div>
				</CardHeader>

				<CardContent className="flex flex-col gap-3">
					<Input
						placeholder="Filter server roles by name..."
						value={roleSearch}
						onChange={(e) => setRoleSearch(e.target.value)}
						className="h-9 text-xs"
					/>

					<div className="border border-border rounded-md max-h-[340px] overflow-y-auto p-2 flex flex-col gap-1.5 bg-background/30">
						{loadingRoles ? (
							<div className="flex flex-col gap-2 p-2">
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
							</div>
						) : filteredRoles.length === 0 ? (
							<div className="text-center py-8 text-xs text-muted-foreground">
								{roleSearch.trim()
									? "No roles match your search query."
									: "No Discord roles found for this server."}
							</div>
						) : (
							filteredRoles.map((role) => {
								const isChecked = selectedRoleIds.has(role.id);
								const colorHex = formatRoleColor(role.color);

								return (
									<button
										key={role.id}
										type="button"
										onClick={() => toggleRole(role.id)}
										className={`flex items-center justify-between p-2.5 rounded-md border text-left transition-all cursor-pointer ${
											isChecked
												? "border-primary/80 bg-primary/10 shadow-2xs"
												: "border-border/40 hover:bg-muted/40 hover:border-border"
										}`}
									>
										<div className="flex items-center gap-3 min-w-0">
											<span
												className="size-3.5 rounded-full shrink-0 border border-border shadow-2xs"
												style={{ backgroundColor: colorHex }}
											/>
											<div className="flex flex-col min-w-0">
												<span className="text-xs font-medium text-foreground truncate">
													{role.name}
												</span>
												<span className="text-[10px] font-mono text-muted-foreground">
													ID: {role.id}
												</span>
											</div>
										</div>

										{isChecked ? (
											<div className="flex items-center gap-1.5 text-primary">
												<span className="text-[10px] font-mono font-medium hidden sm:inline">
													Authorized
												</span>
												<Check className="size-4 shrink-0" />
											</div>
										) : (
											<span className="size-4 shrink-0 border rounded-xs border-muted-foreground/40" />
										)}
									</button>
								);
							})
						)}
					</div>
				</CardContent>
			</Card>

			{/* Tournament API Keys Section */}
			<Card className="border-border/80 shadow-xs">
				<CardHeader>
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<div>
							<CardTitle className="text-base flex items-center gap-2">
								API Keys
							</CardTitle>
						</div>
						<Badge variant="outline" className="font-mono text-xs w-fit">
							{apiKeys.length} {apiKeys.length === 1 ? "key" : "keys"}{" "}
							configured
						</Badge>
					</div>
				</CardHeader>

				<CardContent className="flex flex-col gap-4">
					{/* Add Key Form */}
					<form
						onSubmit={handleAddApiKey}
						className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
					>
						<div className="relative flex-1">
							<Input
								type="password"
								placeholder="Enter 16-character Torn API key..."
								value={newApiKey}
								onChange={(e) => setNewApiKey(e.target.value)}
								className="h-9 text-xs font-mono"
								maxLength={16}
								disabled={addingKey}
							/>
						</div>
						<Button
							type="submit"
							variant="default"
							size="sm"
							disabled={addingKey || newApiKey.trim().length !== 16}
							className="text-xs shrink-0 cursor-pointer"
						>
							{addingKey ? (
								<>
									<RefreshCw
										className="size-3.5 animate-spin"
										data-icon="inline-start"
									/>
									Verifying Key...
								</>
							) : (
								<>
									<Plus className="size-3.5" data-icon="inline-start" />
									Add Key
								</>
							)}
						</Button>
					</form>

					{/* Key Donation Channel Settings */}
					<div className="rounded-lg border border-border/70 bg-card/60 p-3.5 flex flex-col gap-3">
						<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
							<div className="flex flex-col gap-0.5">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="text-xs font-semibold">
										Torn API Donation Channel
									</span>
								</div>
							</div>

							{donationChannelId && (
								<Button
									variant="outline"
									size="sm"
									onClick={handleSyncEmbed}
									disabled={syncingEmbed || loadingChannels}
									className="text-xs h-7 px-2.5 shrink-0 cursor-pointer"
									title="Force the bot to refresh or repost the persistent embed in this channel"
								>
									{syncingEmbed ? (
										<>
											<RefreshCw
												className="size-3 animate-spin"
												data-icon="inline-start"
											/>
											Syncing Embed...
										</>
									) : (
										<>
											<Send className="size-3" data-icon="inline-start" />
											Refresh Embed
										</>
									)}
								</Button>
							)}
						</div>

						<Select
							value={donationChannelId ?? "none"}
							onValueChange={(val) =>
								setDonationChannelId(val === "none" ? null : val)
							}
							disabled={loadingChannels || isSaving}
						>
							<SelectTrigger className="h-9 w-full text-xs">
								<SelectValue placeholder="Select Discord text channel..." />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">
									<span className="text-muted-foreground">None (Disabled)</span>
								</SelectItem>
								{channels.map((ch) => (
									<SelectItem key={ch.id} value={ch.id}>
										<div className="flex items-center gap-1.5">
											<Hash className="size-3 text-muted-foreground" />
											<span>{ch.name}</span>
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Keys List (Paginated Table) */}
					<div className="border border-border rounded-md overflow-hidden bg-background/30">
						{loadingKeys ? (
							<div className="flex flex-col gap-2 p-3">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</div>
						) : apiKeys.length === 0 ? (
							<div className="text-center py-8 text-xs text-muted-foreground">
								No API keys configured. Add a Torn API key above or configure a
								donation channel to enable live tournament operations.
							</div>
						) : (
							<div className="flex flex-col">
								<Table>
									<TableHeader>
										<TableRow className="border-b border-border/50 hover:bg-transparent">
											<TableHead className="text-xs font-mono">
												Torn Member
											</TableHead>
											<TableHead className="text-xs font-mono">
												Status
											</TableHead>
											<TableHead className="text-xs font-mono">
												Origin / Donated By
											</TableHead>
											<TableHead className="text-xs font-mono">
												Added / Last Used
											</TableHead>
											<TableHead className="text-right text-xs font-mono">
												Action
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{paginatedKeys.map((k) => (
											<TableRow
												key={k.id}
												className="border-b border-border/40 hover:bg-muted/20 transition-colors text-xs"
											>
												<TableCell className="py-2.5 font-medium">
													<div className="flex items-center gap-2.5 min-w-0">
														<div className="size-7 rounded bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
															<Key className="size-3.5 text-primary" />
														</div>
														<a
															href={`https://www.torn.com/profiles.php?XID=${k.tornId}`}
															target="_blank"
															rel="noopener noreferrer"
															className="font-semibold text-primary hover:underline inline-flex items-center gap-1 truncate"
														>
															<span>
																{k.tornName} [{k.tornId}]
															</span>
															<ExternalLink className="size-2.5 opacity-70 shrink-0" />
														</a>
													</div>
												</TableCell>
												<TableCell className="py-2.5">
													<Badge
														variant="outline"
														className={`text-[9px] font-mono px-1.5 py-0 h-4 ${
															k.isValid
																? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
																: "bg-rose-500/10 text-rose-500 border-rose-500/30"
														}`}
													>
														{k.isValid ? "ACTIVE" : "INVALID"}
													</Badge>
												</TableCell>
												<TableCell className="py-2.5">
													{k.donatedByDiscordTag ? (
														<Badge
															variant="secondary"
															className="text-[9px] font-mono px-1.5 py-0 h-4 bg-primary/10 text-primary border-primary/20 flex items-center gap-1 w-fit"
															title={`Donated by Discord member: ${k.donatedByDiscordTag}${k.donatedByDiscordId ? ` (${k.donatedByDiscordId})` : ""}`}
														>
															<User className="size-2.5 opacity-80" />
															<span>@{k.donatedByDiscordTag}</span>
														</Badge>
													) : (
														<span className="text-[11px] text-muted-foreground font-mono">
															Direct Config
														</span>
													)}
												</TableCell>
												<TableCell className="py-2.5">
													<div className="flex flex-col text-[10px] text-muted-foreground font-mono">
														<span>Added {formatTctTimestamp(k.createdAt)}</span>
														{k.lastUsedAt && (
															<span className="text-[9px] opacity-80">
																Used {formatTctTimestamp(k.lastUsedAt)}
															</span>
														)}
													</div>
												</TableCell>
												<TableCell className="py-2.5 text-right">
													<Button
														variant="ghost"
														size="icon-xs"
														onClick={() => handleDeleteApiKey(k.id)}
														disabled={deletingKeyId === k.id}
														className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
														title="Delete API key"
													>
														{deletingKeyId === k.id ? (
															<RefreshCw className="size-3.5 animate-spin" />
														) : (
															<Trash2 className="size-3.5" />
														)}
													</Button>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>

								{/* Pagination Controls */}
								{totalKeyPages > 1 && (
									<div className="flex items-center justify-between px-3 py-2 border-t border-border/50 bg-muted/10 text-xs font-mono">
										<span className="text-[11px] text-muted-foreground">
											Showing {(keysPage - 1) * KEYS_PER_PAGE + 1}-
											{Math.min(keysPage * KEYS_PER_PAGE, apiKeys.length)} of{" "}
											{apiKeys.length} keys
										</span>
										<div className="flex items-center gap-1.5">
											<Button
												variant="outline"
												size="icon-xs"
												onClick={() => setKeysPage((p) => Math.max(1, p - 1))}
												disabled={keysPage <= 1}
												className="cursor-pointer"
												title="Previous page"
											>
												<ChevronLeft className="size-3.5" />
											</Button>
											<span className="text-[11px] font-medium px-2">
												Page {keysPage} of {totalKeyPages}
											</span>
											<Button
												variant="outline"
												size="icon-xs"
												onClick={() =>
													setKeysPage((p) => Math.min(totalKeyPages, p + 1))
												}
												disabled={keysPage >= totalKeyPages}
												className="cursor-pointer"
												title="Next page"
											>
												<ChevronRight className="size-3.5" />
											</Button>
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Floating unsaved changes bar */}
			{hasUnsavedChanges && (
				<div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 w-[calc(100%-2rem)] max-w-2xl bg-card/95 backdrop-blur-md border border-border shadow-xl rounded-xl p-3 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-3 duration-200">
					<div className="flex items-center gap-2.5 min-w-0">
						<div className="flex flex-col min-w-0">
							<span className="text-xs font-semibold text-foreground">
								Careful — you have unsaved changes!
							</span>
						</div>
					</div>

					<div className="flex items-center gap-2 shrink-0">
						<Button
							variant="ghost"
							size="sm"
							onClick={handleResetChanges}
							disabled={isSaving}
							className="text-xs h-8 cursor-pointer"
						>
							Discard
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={handleSaveAll}
							disabled={isSaving}
							className="text-xs h-8 cursor-pointer font-medium"
						>
							{isSaving ? (
								<>
									<RefreshCw
										className="size-3.5 animate-spin"
										data-icon="inline-start"
									/>
									Saving...
								</>
							) : (
								<>
									<Save className="size-3.5" data-icon="inline-start" />
									Save Settings
								</>
							)}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
