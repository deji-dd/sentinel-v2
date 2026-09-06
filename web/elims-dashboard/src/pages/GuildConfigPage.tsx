import {
	Check,
	ExternalLink,
	Key,
	Plus,
	RefreshCw,
	Server,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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

interface ElimsApiKey {
	id: string;
	tornId: number;
	tornName: string;
	isValid: boolean;
	invalidCount: number;
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

	// API Keys state
	const [apiKeys, setApiKeys] = useState<ElimsApiKey[]>([]);
	const [loadingKeys, setLoadingKeys] = useState(false);
	const [newApiKey, setNewApiKey] = useState("");
	const [addingKey, setAddingKey] = useState(false);
	const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

	// Fetch API keys
	const fetchApiKeys = useCallback(async () => {
		setLoadingKeys(true);
		try {
			const res = await fetch("/api/v1/elims/api-keys");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { keys?: ElimsApiKey[] };
			if (data?.keys && Array.isArray(data.keys)) {
				setApiKeys(data.keys);
			}
		} catch (err) {
			console.error("Failed to load elims API keys:", err);
			toast.error("Failed to load server API keys.");
		} finally {
			setLoadingKeys(false);
		}
	}, []);

	useEffect(() => {
		void fetchApiKeys();
	}, [fetchApiKeys]);

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

	const handleSaveRoles = async () => {
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error saving settings";
			toast.error(msg);
		} finally {
			setSavingSettings(false);
		}
	};

	const filteredRoles = roles.filter((r) =>
		r.name.toLowerCase().includes(roleSearch.toLowerCase().trim()),
	);

	const hasUnsavedChanges =
		selectedRoleIds.size !== adminRoleIds.length ||
		Array.from(selectedRoleIds).some((id) => !adminRoleIds.includes(id));

	return (
		<div className="flex flex-col gap-6 max-w-5xl w-full mx-auto pb-6">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight">
							Guild Configuration
						</h1>
					</div>
					<p className="text-xs text-muted-foreground">
						Configure server roles and tournament API keys for member
						verification and operations.
					</p>
				</div>

				{isOwner && (
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => navigate("/setup")}
							className="text-xs cursor-pointer"
						>
							<Server className="size-3.5" data-icon="inline-start" />
							Reconfigure Server
						</Button>
					</div>
				)}
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

				<CardFooter className="flex items-center justify-between border-t border-border/60 pt-4">
					<span className="text-[11px] text-muted-foreground font-mono">
						{hasUnsavedChanges
							? "Unsaved role modifications pending."
							: "Roles up to date."}
					</span>

					<Button
						variant="default"
						size="sm"
						onClick={handleSaveRoles}
						disabled={savingSettings || !hasUnsavedChanges}
						className="text-xs cursor-pointer"
					>
						{savingSettings ? (
							<>
								<RefreshCw
									className="size-3.5 animate-spin"
									data-icon="inline-start"
								/>
								Saving Roles...
							</>
						) : (
							<>
								<Check className="size-3.5" data-icon="inline-start" />
								Save Role Settings
							</>
						)}
					</Button>
				</CardFooter>
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

					{/* Keys List */}
					<div className="border border-border rounded-md overflow-hidden bg-background/30">
						{loadingKeys ? (
							<div className="flex flex-col gap-2 p-3">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</div>
						) : apiKeys.length === 0 ? (
							<div className="text-center py-8 text-xs text-muted-foreground">
								No API keys configured. Add a Torn API key above to enable live
								member verification.
							</div>
						) : (
							<div className="divide-y divide-border/50">
								{apiKeys.map((k) => (
									<div
										key={k.id}
										className="flex items-center justify-between p-3 text-xs gap-3 hover:bg-muted/20 transition-colors"
									>
										<div className="flex items-center gap-3 min-w-0">
											<div className="size-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
												<Key className="size-4 text-primary" />
											</div>
											<div className="flex flex-col min-w-0">
												<div className="flex items-center gap-1.5">
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
													<Badge
														variant="outline"
														className={`text-[9px] font-mono px-1 py-0 h-4 ${
															k.isValid
																? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
																: "bg-rose-500/10 text-rose-500 border-rose-500/30"
														}`}
													>
														{k.isValid ? "ACTIVE" : "INVALID"}
													</Badge>
												</div>
												<span className="text-[10px] text-muted-foreground font-mono">
													Added {formatTctTimestamp(k.createdAt)}
													{k.lastUsedAt &&
														` • Last used ${formatTctTimestamp(k.lastUsedAt)}`}
												</span>
											</div>
										</div>

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
									</div>
								))}
							</div>
						)}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
