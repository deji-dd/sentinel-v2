import {
	Check,
	ExternalLink,
	Plus,
	RefreshCw,
	Server,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useSubversive } from "../contexts/SubversiveContext";
import { useRouter } from "../router";

interface GuildRole {
	id: string;
	name: string;
	color: number;
	position: number;
	managed: boolean;
}

interface SubversiveApiKey {
	id: string;
	tornId: number;
	tornName: string;
	isValid: boolean;
	invalidCount: number;
	donatedByDiscordId: string | null;
	donatedByDiscordTag: string | null;
	lastUsedAt: string | null;
	createdAt: string;
}

function formatRoleColor(color: number): string {
	if (color === 0) return "#94a3b8";
	return `#${color.toString(16).padStart(6, "0")}`;
}

export function GuildConfigPage() {
	const { guild, isOwner, refreshStatus } = useSubversive();
	const { navigate } = useRouter();

	// Guild Roles State
	const [roles, setRoles] = useState<GuildRole[]>([]);
	const [loadingRoles, setLoadingRoles] = useState(false);
	const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
		new Set(),
	);
	const [savingRoles, setSavingRoles] = useState(false);

	// API Keys State
	const [apiKeys, setApiKeys] = useState<SubversiveApiKey[]>([]);
	const [loadingKeys, setLoadingKeys] = useState(false);
	const [newApiKey, setNewApiKey] = useState("");
	const [addingKey, setAddingKey] = useState(false);
	const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
	const [keyToDelete, setKeyToDelete] = useState<SubversiveApiKey | null>(null);

	// Fetch Guild Config
	const fetchConfig = useCallback(async () => {
		try {
			const res = await fetch("/api/v1/subversive/guild-config");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				guild?: { adminRoleIds?: string[] } | null;
			};
			if (data.guild?.adminRoleIds) {
				setSelectedRoleIds(new Set(data.guild.adminRoleIds));
			}
		} catch (err) {
			console.error("Failed to load guild config:", err);
			toast.error("Failed to load guild configuration.");
		}
	}, []);

	// Fetch Roles
	const fetchRoles = useCallback(async () => {
		if (!guild?.id) return;
		setLoadingRoles(true);
		try {
			const res = await fetch(`/api/v1/subversive/guild-roles/${guild.id}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { roles: GuildRole[] };
			setRoles(data.roles ?? []);
		} catch (err) {
			console.error("Failed to fetch guild roles:", err);
		} finally {
			setLoadingRoles(false);
		}
	}, [guild?.id]);

	// Fetch API Keys
	const fetchApiKeys = useCallback(async () => {
		setLoadingKeys(true);
		try {
			const res = await fetch("/api/v1/subversive/api-keys");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { keys: SubversiveApiKey[] };
			setApiKeys(data.keys ?? []);
		} catch (err) {
			console.error("Failed to load API keys:", err);
			toast.error("Failed to load Subversive API keys.");
		} finally {
			setLoadingKeys(false);
		}
	}, []);

	useEffect(() => {
		fetchConfig();
		fetchRoles();
		fetchApiKeys();
	}, [fetchConfig, fetchRoles, fetchApiKeys]);

	// Toggle Role Selection
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

	// Save Admin Roles
	const handleSaveRoles = async () => {
		setSavingRoles(true);
		try {
			const res = await fetch("/api/v1/subversive/guild-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					adminRoleIds: Array.from(selectedRoleIds),
				}),
			});
			if (!res.ok) {
				const errData = (await res.json()) as { error?: string };
				throw new Error(errData.error ?? `HTTP ${res.status}`);
			}
			toast.success("Admin roles updated successfully.");
			await refreshStatus();
		} catch (err) {
			console.error("Failed to save admin roles:", err);
			toast.error(
				err instanceof Error ? err.message : "Failed to save admin roles.",
			);
		} finally {
			setSavingRoles(false);
		}
	};

	// Add API Key
	const handleAddApiKey = async (e: React.FormEvent) => {
		e.preventDefault();
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
			const res = await fetch("/api/v1/subversive/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: trimmed }),
			});
			const data = (await res.json()) as {
				success?: boolean;
				error?: string;
				key?: SubversiveApiKey;
			};
			if (!res.ok || !data.success) {
				throw new Error(data.error ?? "Failed to add API key.");
			}
			toast.success(
				`API key registered for ${data.key?.tornName ?? "Player"} [${data.key?.tornId ?? ""}]!`,
			);
			setNewApiKey("");
			await fetchApiKeys();
		} catch (err) {
			console.error("Error registering API key:", err);
			toast.error(
				err instanceof Error ? err.message : "Error registering API key.",
			);
		} finally {
			setAddingKey(false);
		}
	};

	// Delete API Key
	const confirmDeleteKey = async () => {
		if (!keyToDelete) return;
		setDeletingKeyId(keyToDelete.id);
		try {
			const res = await fetch(
				`/api/v1/subversive/api-keys/${encodeURIComponent(keyToDelete.id)}`,
				{
					method: "DELETE",
				},
			);
			const data = (await res.json()) as { success?: boolean; error?: string };
			if (!res.ok || !data.success) {
				throw new Error(data.error ?? "Failed to delete API key.");
			}
			toast.success("API key deleted.");
			setKeyToDelete(null);
			await fetchApiKeys();
		} catch (err) {
			console.error("Failed to delete key:", err);
			toast.error(
				err instanceof Error ? err.message : "Failed to delete API key.",
			);
		} finally {
			setDeletingKeyId(null);
		}
	};

	const sortedRoles = useMemo(() => {
		return [...roles].sort((a, b) => b.position - a.position);
	}, [roles]);

	return (
		<div className="flex flex-col gap-6 p-4 sm:p-6 max-w-6xl mx-auto w-full">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
				{isOwner && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => navigate("/setup")}
						className="gap-2 cursor-pointer self-start sm:self-auto"
					>
						<Server className="size-4" />
						Change Server
					</Button>
				)}
			</div>

			{/* Server & Roles Card */}
			<Card>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-semibold">Dashboard Admin Roles</span>
						<p className="text-xs text-muted-foreground">
							Users with any of these roles in Discord can view candidates and
							modify settings.
						</p>
					</div>

					{loadingRoles ? (
						<div className="flex flex-col gap-2">
							<Skeleton className="h-9 w-full" />
							<Skeleton className="h-9 w-full" />
						</div>
					) : sortedRoles.length === 0 ? (
						<p className="text-xs text-muted-foreground py-2">
							No roles found in the connected server.
						</p>
					) : (
						<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-60 overflow-y-auto p-1 border rounded-md">
							{sortedRoles.map((role) => {
								const isSelected = selectedRoleIds.has(role.id);
								const roleColor = formatRoleColor(role.color);
								return (
									<button
										key={role.id}
										type="button"
										onClick={() => toggleRole(role.id)}
										className={`flex items-center justify-between p-2 rounded text-xs text-left border transition-colors cursor-pointer ${
											isSelected
												? "border-primary bg-primary/10 text-foreground"
												: "border-border hover:bg-muted/50 text-muted-foreground"
										}`}
									>
										<div className="flex items-center gap-2 min-w-0">
											<span
												className="size-2.5 rounded-full shrink-0"
												style={{ backgroundColor: roleColor }}
											/>
											<span className="truncate font-medium text-foreground">
												{role.name}
											</span>
										</div>
										{isSelected && (
											<Check className="size-3.5 text-primary shrink-0" />
										)}
									</button>
								);
							})}
						</div>
					)}
				</CardContent>
				<CardFooter className="flex justify-end border-t pt-4">
					<Button
						size="sm"
						onClick={handleSaveRoles}
						disabled={savingRoles || loadingRoles}
						className="cursor-pointer"
					>
						{savingRoles ? (
							<>
								<RefreshCw
									className="size-3.5 animate-spin"
									data-icon="inline-start"
								/>
								Saving Roles...
							</>
						) : (
							"Save Admin Roles"
						)}
					</Button>
				</CardFooter>
			</Card>

			{/* API Keys Vault Card */}
			<Card>
				<CardHeader>
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<div>
							<CardTitle className="text-base flex items-center gap-2">
								Torn API Keys
							</CardTitle>
						</div>
						<div className="flex items-center gap-2">
							<Badge variant="outline" className="text-xs font-mono">
								{apiKeys.length} {apiKeys.length === 1 ? "Key" : "Keys"}
							</Badge>
						</div>
					</div>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{/* Add Key Form */}
					<form
						onSubmit={handleAddApiKey}
						className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
					>
						<Input
							type="password"
							placeholder="Enter 16-character Torn API key..."
							value={newApiKey}
							onChange={(e) => setNewApiKey(e.target.value)}
							className="h-9 text-xs font-mono"
							maxLength={16}
							disabled={addingKey}
						/>
						<Button
							type="submit"
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

					{/* API Keys Table */}
					<div className="border rounded-md overflow-hidden">
						{loadingKeys ? (
							<div className="flex flex-col gap-2 p-4">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</div>
						) : apiKeys.length === 0 ? (
							<div className="text-center py-8 text-xs text-muted-foreground">
								No API keys registered. Add a Torn API key above to empower
								Subversive recruitment scans.
							</div>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="text-xs">Torn Member</TableHead>
										<TableHead className="text-xs">Status</TableHead>
										<TableHead className="text-xs">Added By</TableHead>
										<TableHead className="text-xs">Registered At</TableHead>
										<TableHead className="text-right text-xs">Action</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{apiKeys.map((k) => (
										<TableRow key={k.id} className="text-xs">
											<TableCell className="font-medium">
												<a
													href={`https://www.torn.com/profiles.php?XID=${k.tornId}`}
													target="_blank"
													rel="noreferrer"
													className="inline-flex items-center gap-1.5 hover:underline text-primary"
												>
													{k.tornName} [{k.tornId}]
													<ExternalLink className="size-3" />
												</a>
											</TableCell>
											<TableCell>
												{k.isValid ? (
													<Badge
														variant="secondary"
														className="text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
													>
														Active
													</Badge>
												) : (
													<Badge variant="destructive" className="text-[10px]">
														Invalid ({k.invalidCount})
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{k.donatedByDiscordTag ?? "Dashboard Admin"}
											</TableCell>
											<TableCell className="text-muted-foreground font-mono">
												{new Date(k.createdAt).toLocaleDateString()}
											</TableCell>
											<TableCell className="text-right">
												<Button
													variant="ghost"
													size="icon"
													className="size-8 text-destructive hover:text-destructive hover:bg-destructive/10 cursor-pointer"
													onClick={() => setKeyToDelete(k)}
													disabled={deletingKeyId === k.id}
													title="Delete API key"
												>
													<Trash2 className="size-4" />
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Delete Key Confirmation Dialog */}
			<Dialog
				open={Boolean(keyToDelete)}
				onOpenChange={(open) => !open && setKeyToDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete API Key</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete the Torn API key for{" "}
							<strong>
								{keyToDelete?.tornName} [{keyToDelete?.tornId}]
							</strong>
							? It will no longer be used for background scans.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setKeyToDelete(null)}
							disabled={Boolean(deletingKeyId)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={confirmDeleteKey}
							disabled={Boolean(deletingKeyId)}
							className="cursor-pointer"
						>
							{deletingKeyId ? (
								<>
									<RefreshCw
										className="size-3.5 animate-spin"
										data-icon="inline-start"
									/>
									Deleting...
								</>
							) : (
								"Delete Key"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
