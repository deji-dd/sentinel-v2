import {
	AlertCircle,
	ArrowLeft,
	CheckCircle2,
	ExternalLink,
	KeyRound,
	Loader2,
	LogOut,
	Moon,
	Plus,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
	Sun,
	Trash2,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useTheme } from "../hooks/useTheme";
import { api } from "../lib/api";
import { useRouter } from "../router";

interface SystemApiKey {
	id: string;
	userId: number;
	keyType: string;
	isValid: boolean;
	invalidCount: number;
	lastInvalidAt: string | Date | null;
	lastUsedAt: string | Date | null;
	createdAt: string | Date;
}

interface AdminKeysPageProps {
	isInsideShell?: boolean;
}

export default function AdminKeysPage({
	isInsideShell = false,
}: AdminKeysPageProps) {
	const { user, authenticated, logout } = useAuth();
	const { navigate } = useRouter();
	const { toast } = useToast();
	const { theme, toggle } = useTheme();

	const [keys, setKeys] = useState<SystemApiKey[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const [newKey, setNewKey] = useState("");
	const [keyType, setKeyType] = useState<"system" | "personal">("system");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
	const [togglingKeyId, setTogglingKeyId] = useState<string | null>(null);

	const isAdmin = user?.role === "admin" || user?.role === "owner";

	const fetchKeys = useCallback(async () => {
		try {
			setError(null);
			const res = await api.api.v1.system.keys.get();
			if (res.error) {
				const errObj = res.error as unknown;
				let errMsg = "Failed to load system API keys.";
				if (typeof errObj === "object" && errObj !== null) {
					if (
						"value" in errObj &&
						typeof (errObj as { value: { error?: string } }).value?.error ===
							"string"
					) {
						errMsg = (errObj as { value: { error: string } }).value.error;
					} else if (
						"error" in errObj &&
						typeof (errObj as { error: string }).error === "string"
					) {
						errMsg = (errObj as { error: string }).error;
					}
				}
				setError(errMsg);
				return;
			}

			if (res.data && "keys" in res.data) {
				setKeys((res.data.keys as SystemApiKey[]) ?? []);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to load keys.";
			setError(msg);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (authenticated && isAdmin) {
			void fetchKeys();
		} else if (authenticated && !isAdmin) {
			setLoading(false);
		}
	}, [authenticated, isAdmin, fetchKeys]);

	const handleAddKey = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = newKey.trim();
		if (!trimmed) {
			toast("Please enter a Torn API key.", "error");
			return;
		}
		if (trimmed.length !== 16) {
			toast("API key must be exactly 16 characters.", "error");
			return;
		}

		setIsSubmitting(true);
		try {
			const res = await api.api.v1.system.keys.post({
				apiKey: trimmed,
				keyType,
			});

			if (res.error) {
				const errObj = res.error as unknown;
				let errMsg = "Failed to register API key.";
				if (typeof errObj === "object" && errObj !== null) {
					if (
						"value" in errObj &&
						typeof (errObj as { value: { error?: string } }).value?.error ===
							"string"
					) {
						errMsg = (errObj as { value: { error: string } }).value.error;
					} else if (
						"error" in errObj &&
						typeof (errObj as { error: string }).error === "string"
					) {
						errMsg = (errObj as { error: string }).error;
					}
				}
				toast(errMsg, "error");
				return;
			}

			const playerName =
				res.data && "playerName" in res.data
					? (res.data as { playerName?: string }).playerName
					: "";
			toast(
				`API key registered successfully${playerName ? ` for ${playerName}` : ""}!`,
				"success",
			);
			setNewKey("");
			await fetchKeys();
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed to register key.";
			toast(msg, "error");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleDeleteKey = async (keyId: string) => {
		setDeletingKeyId(keyId);
		try {
			const keyRoute = api.api.v1.system.keys[keyId];
			if (!keyRoute) return;

			const res = await keyRoute.delete();
			if (res.error) {
				toast("Failed to delete API key.", "error");
				return;
			}

			toast("API key deleted from system pool.", "success");
			await fetchKeys();
		} catch {
			toast("Failed to delete API key.", "error");
		} finally {
			setDeletingKeyId(null);
		}
	};

	const handleToggleValidity = async (keyId: string, currentValid: boolean) => {
		setTogglingKeyId(keyId);
		try {
			const keyRoute = api.api.v1.system.keys[keyId];
			if (!keyRoute) return;

			const res = await keyRoute.patch({
				isValid: !currentValid,
			});
			if (res.error) {
				toast("Failed to update key status.", "error");
				return;
			}

			toast(`API key ${!currentValid ? "activated" : "disabled"}.`, "success");
			await fetchKeys();
		} catch {
			toast("Failed to update key status.", "error");
		} finally {
			setTogglingKeyId(null);
		}
	};

	const handleResetErrors = async (keyId: string) => {
		try {
			const keyRoute = api.api.v1.system.keys[keyId];
			if (!keyRoute) return;

			const res = await keyRoute.patch({
				resetErrors: true,
				isValid: true,
			});
			if (res.error) {
				toast("Failed to reset key errors.", "error");
				return;
			}

			toast("Error counter reset and key reactivated.", "success");
			await fetchKeys();
		} catch {
			toast("Failed to reset errors.", "error");
		}
	};

	const avatarUrl = (() => {
		try {
			const meta = document.cookie.match(/discord_meta=([^;]+)/)?.[1];
			if (meta) {
				const parsed = JSON.parse(decodeURIComponent(meta)) as {
					avatar?: string;
				};
				return parsed.avatar ?? null;
			}
		} catch {
			// ignore
		}
		return null;
	})();

	if (!isAdmin && !loading) {
		return (
			<div className="min-h-screen w-full flex flex-col items-center justify-center p-6 bg-background text-foreground font-sans">
				<Card className="max-w-md w-full p-6 text-center border-destructive/40 bg-destructive/5 space-y-4">
					<div className="size-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto">
						<ShieldAlert className="size-6" />
					</div>
					<h2 className="text-lg font-bold">Access Restricted</h2>
					<p className="text-xs text-muted-foreground">
						This page is strictly restricted to Sentinel system administrators
						and bot owners.
					</p>
					<Button
						onClick={() => navigate("/")}
						variant="outline"
						className="rounded-xl text-xs"
					>
						Return to Dashboard
					</Button>
				</Card>
			</div>
		);
	}

	const activeCount = keys.filter((k) => k.isValid).length;
	const systemPoolCount = keys.filter(
		(k) => k.keyType === "system" && k.isValid,
	).length;
	const errorCount = keys.filter(
		(k) => k.invalidCount > 0 || !k.isValid,
	).length;

	const content = (
		<div className="space-y-6">
			{isInsideShell && (
				<div className="flex flex-col gap-1 pb-4 border-b border-border/40">
					<div className="flex items-center gap-2">
						<h1 className="text-xl font-bold tracking-tight text-foreground">
							System API Key Pool
						</h1>
					</div>
				</div>
			)}

			{/* Quick Stats Grid */}
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
				<Card className="p-4 border-border/80 bg-card/60 backdrop-blur-md rounded-2xl shadow-xs">
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-muted-foreground font-medium">
							Total Keys
						</span>
					</div>
					<div className="text-2xl font-bold font-mono mt-2 text-foreground">
						{loading ? <Skeleton className="h-7 w-12" /> : keys.length}
					</div>
				</Card>

				<Card className="p-4 border-border/80 bg-card/60 backdrop-blur-md rounded-2xl shadow-xs">
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-emerald-500 font-medium">
							Active Keys
						</span>
					</div>
					<div className="text-2xl font-bold font-mono mt-2 text-emerald-500">
						{loading ? <Skeleton className="h-7 w-12" /> : activeCount}
					</div>
				</Card>

				<Card className="p-4 border-border/80 bg-card/60 backdrop-blur-md rounded-2xl shadow-xs">
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-primary font-medium">
							System Pool
						</span>
					</div>
					<div className="text-2xl font-bold font-mono mt-2 text-foreground">
						{loading ? <Skeleton className="h-7 w-12" /> : systemPoolCount}
					</div>
				</Card>

				<Card className="p-4 border-border/80 bg-card/60 backdrop-blur-md rounded-2xl shadow-xs">
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-amber-500 font-medium">
							Issue / Errors
						</span>
					</div>
					<div className="text-2xl font-bold font-mono mt-2 text-amber-500">
						{loading ? <Skeleton className="h-7 w-12" /> : errorCount}
					</div>
				</Card>
			</div>

			{/* Error Notification */}
			{error && (
				<Alert variant="destructive" className="rounded-2xl">
					<AlertCircle className="size-4" />
					<AlertTitle>Error</AlertTitle>
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			{/* Register New Key Card */}
			<Card className="border-border/80 bg-card/90 backdrop-blur-md rounded-2xl shadow-xl">
				<CardHeader className="border-b border-border/40 pb-4">
					<div className="flex items-center justify-between gap-4">
						<div className="space-y-0.5">
							<CardTitle className="text-base font-bold flex items-center gap-2">
								<Plus className="size-4 text-primary" />
								Register API Key
							</CardTitle>
						</div>
					</div>
				</CardHeader>
				<CardContent className="pt-6">
					<form
						onSubmit={(e) => void handleAddKey(e)}
						className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center"
					>
						<div className="flex-1">
							<Input
								id="system-api-key-input"
								type="password"
								value={newKey}
								onChange={(e) => setNewKey(e.target.value)}
								maxLength={16}
								disabled={isSubmitting}
								placeholder="Enter 16-character Torn API Key..."
								className="font-mono text-xs rounded-xl h-10 bg-background/50"
							/>
						</div>

						<div className="w-full sm:w-44">
							<Select
								value={keyType}
								onValueChange={(v) => setKeyType(v as "system" | "personal")}
								disabled={isSubmitting}
							>
								<SelectTrigger className="h-10 rounded-xl text-xs bg-background/50">
									<SelectValue placeholder="Key Type" />
								</SelectTrigger>
								<SelectContent className="rounded-xl">
									<SelectItem value="system" className="text-xs">
										System Pool Key
									</SelectItem>
									<SelectItem value="personal" className="text-xs">
										Personal Owner Key
									</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<Button
							type="submit"
							disabled={isSubmitting || !newKey.trim()}
							className="h-10 px-5 rounded-xl text-xs font-semibold shrink-0 cursor-pointer gap-2"
						>
							{isSubmitting ? (
								<>
									<Loader2 className="size-4 animate-spin" />
									<span>Verifying Torn Key...</span>
								</>
							) : (
								<>
									<ShieldCheck className="size-4" />
									<span>Register Key</span>
								</>
							)}
						</Button>
					</form>
				</CardContent>
			</Card>

			{/* Key Pool List Card */}
			<Card className="border-border/80 bg-card/90 backdrop-blur-md rounded-2xl shadow-xl">
				<CardHeader className="border-b border-border/40 pb-4">
					<div className="flex items-center justify-between gap-4">
						<div>
							<CardTitle className="text-base font-bold">API Keys</CardTitle>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void fetchKeys()}
							disabled={loading}
							className="h-8 px-2.5 rounded-xl text-xs text-muted-foreground hover:text-foreground cursor-pointer gap-1.5"
						>
							<RefreshCw
								className={`size-3.5 ${loading ? "animate-spin" : ""}`}
							/>
							Refresh
						</Button>
					</div>
				</CardHeader>
				<CardContent className="p-6">
					{loading && (
						<div className="space-y-3">
							{[1, 2, 3].map((i) => (
								<div
									key={`skel-${i}`}
									className="p-4 rounded-xl border border-border/40 bg-background/30 flex items-center justify-between gap-4"
								>
									<div className="space-y-2 flex-1">
										<Skeleton className="h-4 w-40" />
										<Skeleton className="h-3 w-60" />
									</div>
									<Skeleton className="h-8 w-24 rounded-xl" />
								</div>
							))}
						</div>
					)}

					{!loading && keys.length === 0 && (
						<div className="flex flex-col items-center justify-center p-12 text-center gap-3 rounded-xl border border-dashed border-border/60 bg-background/30">
							<div className="size-12 rounded-2xl bg-muted/50 border border-border flex items-center justify-center text-muted-foreground">
								<KeyRound className="size-6" />
							</div>
							<div className="space-y-1">
								<h3 className="text-sm font-semibold text-foreground">
									No API Keys in System Pool
								</h3>
								<p className="text-xs text-muted-foreground max-w-sm">
									Add at least one Torn API key above so background workers and
									member verification can execute queries.
								</p>
							</div>
						</div>
					)}

					{!loading && keys.length > 0 && (
						<div className="space-y-3">
							{keys.map((k) => (
								<div
									key={k.id}
									className="p-4 rounded-xl bg-background/50 hover:bg-background/80 border border-border/80 transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs"
								>
									<div className="flex items-center gap-3.5 min-w-0">
										{k.isValid ? (
											<div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shrink-0">
												<CheckCircle2 className="size-4" />
											</div>
										) : (
											<div className="p-2.5 rounded-xl bg-destructive/10 text-destructive border border-destructive/20 shrink-0">
												<AlertCircle className="size-4" />
											</div>
										)}

										<div className="min-w-0 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<a
													href={`https://www.torn.com/profiles.php?XID=${k.userId}`}
													target="_blank"
													rel="noopener noreferrer"
													className="font-bold text-foreground hover:text-primary transition-colors flex items-center gap-1 font-mono"
												>
													Torn Player #{k.userId}
													<ExternalLink className="size-3 text-muted-foreground" />
												</a>

												<Badge
													variant={
														k.keyType === "system" ? "default" : "secondary"
													}
													className="text-[9px] font-mono px-1.5 py-0 uppercase font-semibold"
												>
													{k.keyType === "system" ? "SYSTEM POOL" : "PERSONAL"}
												</Badge>

												<Badge
													variant={k.isValid ? "outline" : "destructive"}
													className={`text-[9px] font-mono px-1.5 py-0 uppercase font-semibold ${
														k.isValid
															? "border-emerald-500/30 text-emerald-500 bg-emerald-500/5"
															: ""
													}`}
												>
													{k.isValid ? "ACTIVE" : "DISABLED"}
												</Badge>

												{k.invalidCount > 0 && (
													<Badge
														variant="destructive"
														className="text-[9px] font-mono px-1.5 py-0 uppercase font-semibold"
													>
														{k.invalidCount} ERRORS
													</Badge>
												)}
											</div>

											<div className="text-[11px] text-muted-foreground font-mono flex flex-wrap items-center gap-x-3 gap-y-1">
												<span>Key: ••••••••••••••••</span>
												<span>
													Added: {new Date(k.createdAt).toLocaleDateString()}
												</span>
												{k.lastUsedAt && (
													<span>
														Last Used:{" "}
														{new Date(k.lastUsedAt).toLocaleTimeString()}
													</span>
												)}
											</div>
										</div>
									</div>

									<div className="flex items-center gap-2 self-end sm:self-center shrink-0">
										{k.invalidCount > 0 && (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => void handleResetErrors(k.id)}
												className="h-8 px-2.5 text-xs rounded-xl text-amber-500 border-amber-500/30 hover:bg-amber-500/10 cursor-pointer"
												title="Reset error counter"
											>
												Reset Errors
											</Button>
										)}

										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={togglingKeyId === k.id}
											onClick={() => void handleToggleValidity(k.id, k.isValid)}
											className={`h-8 px-2.5 text-xs rounded-xl cursor-pointer ${
												k.isValid
													? "text-muted-foreground hover:text-amber-500"
													: "text-emerald-500 hover:text-emerald-400"
											}`}
										>
											{togglingKeyId === k.id ? (
												<Loader2 className="size-3.5 animate-spin" />
											) : k.isValid ? (
												"Disable"
											) : (
												"Enable"
											)}
										</Button>

										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													disabled={deletingKeyId === k.id}
													className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl cursor-pointer"
													title="Delete API key"
												>
													{deletingKeyId === k.id ? (
														<Loader2 className="size-3.5 animate-spin" />
													) : (
														<Trash2 className="size-3.5" />
													)}
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent className="rounded-2xl border-border bg-card">
												<AlertDialogHeader>
													<AlertDialogTitle className="text-lg font-bold">
														Delete API Key?
													</AlertDialogTitle>
													<AlertDialogDescription className="text-xs text-muted-foreground">
														Are you sure you want to remove Torn Player #
														{k.userId}&apos;s key from the system pool? It will
														no longer be used for background jobs and
														verification.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter className="mt-4 flex gap-2">
													<AlertDialogCancel className="rounded-xl text-xs font-semibold">
														Cancel
													</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => void handleDeleteKey(k.id)}
														className="rounded-xl text-xs font-semibold bg-destructive text-white hover:bg-destructive/90"
													>
														Delete Key
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);

	if (isInsideShell) {
		return <div className="space-y-6 pb-12">{content}</div>;
	}

	return (
		<div className="min-h-screen w-full bg-background text-foreground font-sans relative overflow-x-hidden">
			{/* Subtle Background Radial Glow */}
			<div className="absolute top-0 left-1/2 -translate-x-1/2 size-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

			{/* Top Header Navigation */}
			<header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
				<div className="flex items-center gap-3">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => navigate("/")}
						className="h-8 px-2.5 rounded-xl text-xs text-muted-foreground hover:text-foreground cursor-pointer gap-1.5"
					>
						<ArrowLeft className="size-3.5" />
						Servers
					</Button>
					<div className="h-4 w-px bg-border/60" />
					<div className="flex items-center gap-2">
						<div className="size-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
							<KeyRound className="size-3.5" />
						</div>
						<div>
							<h1 className="text-sm font-bold tracking-tight text-foreground">
								System API Key Pool
							</h1>
						</div>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						onClick={toggle}
						className="size-8 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
						aria-label="Toggle theme"
					>
						{theme === "dark" ? (
							<Sun className="size-3.5" />
						) : (
							<Moon className="size-3.5" />
						)}
					</Button>

					{user && (
						<div className="flex items-center gap-2 pl-2 border-l border-border/60">
							<Avatar className="size-6 border border-border">
								{avatarUrl ? (
									<AvatarImage src={avatarUrl} alt={user.username} />
								) : null}
								<AvatarFallback className="text-[10px] font-mono">
									{user.username.charAt(0).toUpperCase()}
								</AvatarFallback>
							</Avatar>
							<span className="text-xs font-medium text-foreground hidden sm:inline">
								{user.username}
							</span>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => void logout()}
								className="size-6 text-muted-foreground hover:text-foreground rounded-full cursor-pointer"
								title="Sign out"
							>
								<LogOut className="size-3" />
							</Button>
						</div>
					)}
				</div>
			</header>

			<main className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
				{content}
			</main>
		</div>
	);
}
