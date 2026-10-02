import {
	AlertTriangle,
	CheckCircle2,
	ExternalLink,
	KeyRound,
	Loader2,
	Plus,
	RotateCcw,
	RotateCw,
	Save,
	Trash2,
	X,
} from "lucide-react";
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
import { useRouter } from "../router";

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

export interface GuildApiKey {
	id: string;
	guildId: string;
	tornId: number;
	tornName: string;
	isValid: boolean;
	invalidCount: number;
	lastInvalidAt?: string | Date | null;
	lastUsedAt?: string | Date | null;
	donatedByDiscordId?: string | null;
	donatedByDiscordTag?: string | null;
	createdAt: string | Date;
	factionId?: number | null;
	factionName?: string | null;
}

interface GuildSettingsPageProps {
	guildId: string;
	isMerc?: boolean;
	activeServerType?: string | null;
}

export default function GuildSettingsPage({
	guildId,
	isMerc = false,
	activeServerType,
}: GuildSettingsPageProps) {
	const { toast } = useToast();
	const { queryParams } = useRouter();

	const effectiveType =
		activeServerType ??
		(queryParams.type as string | undefined) ??
		(typeof window !== "undefined"
			? sessionStorage.getItem(`sentinel_server_type_${guildId}`)
			: null);

	const initialIsMerc = effectiveType === "merc" || (!effectiveType && isMerc);

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
	const [mercRoleId, setMercRoleId] = useState<string>("");
	const [initialMercRoleId, setInitialMercRoleId] = useState<string>("");
	const [mercManagerRoleId, setMercManagerRoleId] = useState<string>("");
	const [initialMercManagerRoleId, setInitialMercManagerRoleId] =
		useState<string>("");
	const [mercDefaultHitPrice, setMercDefaultHitPrice] =
		useState<string>("3000000");
	const [initialMercDefaultHitPrice, setInitialMercDefaultHitPrice] =
		useState<string>("3000000");
	const [mercDefaultStrickenHitPrice, setMercDefaultStrickenHitPrice] =
		useState<string>("4000000");
	const [
		initialMercDefaultStrickenHitPrice,
		setInitialMercDefaultStrickenHitPrice,
	] = useState<string>("4000000");

	// Guild API Keys state
	const [keys, setKeys] = useState<GuildApiKey[]>([]);
	const [keysLoading, setKeysLoading] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [isAddingKey, setIsAddingKey] = useState(false);
	const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

	// Mercenary Faction Family State
	const [isMercGuild, setIsMercGuild] = useState(initialIsMerc);
	const [slotKeyInputs, setSlotKeyInputs] = useState<{ [id: number]: string }>(
		{},
	);
	const [slotAddingKey, setSlotAddingKey] = useState<{ [id: number]: boolean }>(
		{},
	);

	useEffect(() => {
		if (effectiveType) {
			setIsMercGuild(effectiveType === "merc");
		} else {
			setIsMercGuild(isMerc);
		}
	}, [effectiveType, isMerc]);

	const isDirty =
		logChannelId !== initialLogChannel ||
		JSON.stringify(adminRoles) !== JSON.stringify(initialAdminRoles) ||
		(isMercGuild &&
			(mercRoleId !== initialMercRoleId ||
				mercManagerRoleId !== initialMercManagerRoleId ||
				mercDefaultHitPrice !== initialMercDefaultHitPrice ||
				mercDefaultStrickenHitPrice !== initialMercDefaultStrickenHitPrice));

	const fetchKeys = useCallback(async () => {
		try {
			setKeysLoading(true);
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;
			const res = await guildRoute.keys.get({
				query: isMercGuild ? { type: "merc" } : { type: "faction" },
			});
			if (res.data && "keys" in res.data) {
				setKeys((res.data.keys as GuildApiKey[]) ?? []);
			}
		} catch {
			// ignore
		} finally {
			setKeysLoading(false);
		}
	}, [guildId, isMercGuild]);

	const fetchConfig = useCallback(async () => {
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const [configRes, channelsRes, rolesRes, serverTypesRes] =
				await Promise.all([
					guildRoute.config.get(),
					guildRoute.channels.get(),
					guildRoute.roles.get(),
					api.v2.guilds["server-types"].get(),
				]);

			if (serverTypesRes.data && "serverTypes" in serverTypesRes.data) {
				const st = serverTypesRes.data.serverTypes as {
					merc?: string | null;
					faction?: string | null;
				};
				if (effectiveType) {
					setIsMercGuild(effectiveType === "merc");
				} else if (isMerc) {
					setIsMercGuild(true);
				} else if (st.merc && guildId === st.merc && st.faction !== guildId) {
					setIsMercGuild(true);
				} else {
					setIsMercGuild(false);
				}
			}

			if (configRes.data) {
				const data = configRes.data;
				if (!data.initialized || !data.config) {
					setIsInitialized(false);
					setLoading(false);
					return;
				}

				setIsInitialized(true);
				const config = data.config as typeof data.config & {
					mercRoleId?: string | null;
					mercManagerRoleId?: string | null;
					mercDefaultHitPrice?: number | null;
					mercDefaultStrickenHitPrice?: number | null;
				};
				setLogChannelId(config.logChannelId ?? "");
				setInitialLogChannel(config.logChannelId ?? "");
				setAdminRoles(config.adminRoleIds ?? []);
				setInitialAdminRoles(config.adminRoleIds ?? []);
				setMercRoleId(config.mercRoleId ?? "");
				setInitialMercRoleId(config.mercRoleId ?? "");
				setMercManagerRoleId(config.mercManagerRoleId ?? "");
				setInitialMercManagerRoleId(config.mercManagerRoleId ?? "");

				const hitPriceStr =
					config.mercDefaultHitPrice !== null &&
					config.mercDefaultHitPrice !== undefined
						? String(config.mercDefaultHitPrice)
						: "3000000";
				setMercDefaultHitPrice(hitPriceStr);
				setInitialMercDefaultHitPrice(hitPriceStr);

				const strickenPriceStr =
					config.mercDefaultStrickenHitPrice !== null &&
					config.mercDefaultStrickenHitPrice !== undefined
						? String(config.mercDefaultStrickenHitPrice)
						: "4000000";
				setMercDefaultStrickenHitPrice(strickenPriceStr);
				setInitialMercDefaultStrickenHitPrice(strickenPriceStr);
			}

			if (channelsRes.data && "channels" in channelsRes.data) {
				setChannels(channelsRes.data.channels);
			}

			if (rolesRes.data && "roles" in rolesRes.data) {
				setRoles(rolesRes.data.roles);
			}

			await fetchKeys();
		} catch {
			toast("Failed to load guild settings.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast, fetchKeys]);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			await guildRoute.config.put({
				logChannelId: logChannelId || null,
				adminRoleIds: adminRoles,
				...(isMercGuild
					? {
							mercRoleId: mercRoleId || null,
							mercManagerRoleId: mercManagerRoleId || null,
							mercDefaultHitPrice:
								Number.parseInt(mercDefaultHitPrice.replace(/,/g, ""), 10) ||
								3000000,
							mercDefaultStrickenHitPrice:
								Number.parseInt(
									mercDefaultStrickenHitPrice.replace(/,/g, ""),
									10,
								) || 4000000,
						}
					: {}),
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
		setMercRoleId(initialMercRoleId);
		setMercManagerRoleId(initialMercManagerRoleId);
		setMercDefaultHitPrice(initialMercDefaultHitPrice);
		setMercDefaultStrickenHitPrice(initialMercDefaultStrickenHitPrice);
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

	const handleAddSlotKey = async (factionId: number) => {
		const keyToUse = slotKeyInputs[factionId] ?? "";
		const trimmed = keyToUse.trim();
		if (trimmed.length !== 16) {
			toast(
				"Torn API key must be a 16-character alphanumeric string.",
				"error",
			);
			return;
		}

		setSlotAddingKey((prev) => ({ ...prev, [factionId]: true }));
		try {
			await handleAddKey(trimmed);
			setSlotKeyInputs((prev) => ({ ...prev, [factionId]: "" }));
		} finally {
			setSlotAddingKey((prev) => ({ ...prev, [factionId]: false }));
		}
	};

	const handleAddKey = async (overrideKey?: string) => {
		const keyToUse = overrideKey || newKey;
		const trimmed = keyToUse.trim();
		if (trimmed.length !== 16) {
			toast(
				"Torn API key must be a 16-character alphanumeric string.",
				"error",
			);
			return;
		}

		setIsAddingKey(true);
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;
			const res = await guildRoute.keys.post({
				apiKey: trimmed,
				serverType: isMercGuild ? "merc" : "faction",
			});
			if (res.error) {
				const errObj = res.error as unknown;
				let msg = "Failed to register API key.";
				if (typeof errObj === "object" && errObj !== null) {
					if (
						"value" in errObj &&
						typeof (errObj as { value?: { error?: string } }).value?.error ===
							"string"
					) {
						msg = (errObj as { value: { error: string } }).value.error;
					}
				}
				toast(msg, "error");
				return;
			}

			const data = res.data as
				| {
						success?: boolean;
						key?: {
							tornName: string;
							tornId: number;
							factionName?: string;
							factionId?: number;
						};
				  }
				| undefined;
			toast(
				data?.key?.factionId
					? `Master key registered for ${data.key.factionName ?? `Faction ${data.key.factionId}`} (${data.key.tornName} [${data.key.tornId}])!`
					: data?.key
						? `Added API key for ${data.key.tornName} [${data.key.tornId}]!`
						: "API key registered successfully!",
				"success",
			);
			if (!overrideKey) setNewKey("");
			await fetchKeys();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Error adding API key.",
				"error",
			);
		} finally {
			setIsAddingKey(false);
		}
	};

	const handleDeleteKey = async (keyId: string) => {
		setDeletingKeyId(keyId);
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;
			const res = await guildRoute.keys({ keyId }).delete();
			if (res.error) {
				toast("Failed to delete API key.", "error");
				return;
			}
			toast("API key removed from guild.", "info");
			await fetchKeys();
		} catch {
			toast("Error deleting API key.", "error");
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

			{/* Guild Torn API Keys Card */}
			{isMercGuild ? (
				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardHeader className="border-b border-border/40">
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<CardTitle className="text-lg font-semibold tracking-tight flex items-center gap-2">
										<span>Master Api Keys</span>
									</CardTitle>
								</div>
							</div>
							<Button
								variant="outline"
								size="icon"
								onClick={() => void fetchKeys()}
								disabled={keysLoading}
								title="Refresh keys"
								className="size-8 border-border bg-background/50 cursor-pointer shadow-xs shrink-0"
							>
								<RotateCw
									className={`size-3.5 text-muted-foreground ${keysLoading ? "animate-spin" : ""}`}
								/>
							</Button>
						</div>
					</CardHeader>
					<CardContent className="space-y-6">
						{/* Overview Status Banner */}
						{(() => {
							const configuredFactions = [
								{ id: 2013, name: "Subversive  Alliance", tag: "SA" },
								{ id: 27312, name: "SA Succession", tag: "SA-S" },
							].filter((f) =>
								keys.some(
									(k) =>
										k.factionId === f.id ||
										k.donatedByDiscordTag?.includes(`Faction ${f.id}`),
								),
							);
							const allConfigured = configuredFactions.length === 2;

							if (allConfigured) {
								return (
									<div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 flex items-center gap-3 text-xs text-emerald-400">
										<CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
										<span>
											All required faction master keys are active. Attack logs
											will be pulled from{" "}
											<span className="font-mono font-bold">
												/faction/attacks
											</span>{" "}
											for both factions (2013 & 27312).
										</span>
									</div>
								);
							}

							return (
								<div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 flex items-center gap-3 text-xs text-amber-400">
									<AlertTriangle className="size-4 shrink-0 text-amber-400" />
									<span>
										{configuredFactions.length === 0
											? "No master keys configured."
											: `Incomplete Configuration. Please add the master key for the remaining faction.`}
									</span>
								</div>
							);
						})()}

						{/* 2 Faction Slots */}
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							{[
								{ id: 2013, name: "Subversive  Alliance", tag: "SA" },
								{ id: 27312, name: "SA Succession", tag: "SA-S" },
							].map((faction) => {
								const matchingKey = keys.find(
									(k) =>
										k.factionId === faction.id ||
										k.donatedByDiscordTag?.includes(`Faction ${faction.id}`),
								);
								const isSlotAdding = Boolean(slotAddingKey[faction.id]);
								const currentSlotInput = slotKeyInputs[faction.id] ?? "";

								if (matchingKey) {
									return (
										<div
											key={faction.id}
											className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 flex flex-col justify-between gap-3 text-xs shadow-xs"
										>
											<div className="space-y-2">
												<div className="flex items-center justify-between gap-2">
													<div className="flex items-center gap-2">
														<Badge
															variant="outline"
															className="font-mono text-[9px] px-1.5 py-0 bg-primary/10 text-primary border-primary/30"
														>
															{faction.tag}
														</Badge>
														<span className="font-bold text-sm text-foreground">
															{faction.name}
														</span>
														<span className="font-mono text-[11px] text-muted-foreground">
															[{faction.id}]
														</span>
													</div>
													<Badge
														variant="outline"
														className="text-[9px] font-mono px-1.5 py-0 text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
													>
														Active Master Key
													</Badge>
												</div>

												<div className="pt-2 border-t border-border/40 space-y-1.5">
													<div className="flex items-center justify-between">
														<span className="text-muted-foreground">
															Key Holder:
														</span>
														<a
															href={`https://www.torn.com/profiles.php?XID=${matchingKey.tornId}`}
															target="_blank"
															rel="noopener noreferrer"
															className="font-medium text-foreground hover:text-primary transition-colors flex items-center gap-1"
														>
															<span>{matchingKey.tornName}</span>
															<span className="font-mono text-[10px] text-muted-foreground">
																[{matchingKey.tornId}]
															</span>
															<ExternalLink className="size-2.5 opacity-60" />
														</a>
													</div>

													<div className="flex items-center justify-between">
														<span className="text-muted-foreground">
															Attack Logs:
														</span>
														<span className="text-emerald-400 font-mono text-[11px] flex items-center gap-1">
															<CheckCircle2 className="size-3" />
															/faction/attacks verified
														</span>
													</div>

													{matchingKey.lastUsedAt && (
														<div className="flex items-center justify-between text-[11px] text-muted-foreground">
															<span>Last Polled:</span>
															<span>
																{new Date(
																	matchingKey.lastUsedAt,
																).toLocaleDateString()}
															</span>
														</div>
													)}
												</div>
											</div>

											<div className="pt-2 border-t border-border/40 flex justify-end">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => void handleDeleteKey(matchingKey.id)}
													disabled={deletingKeyId === matchingKey.id}
													className="text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 px-2 cursor-pointer gap-1"
												>
													{deletingKeyId === matchingKey.id ? (
														<Loader2 className="size-3.5 animate-spin" />
													) : (
														<Trash2 className="size-3.5" />
													)}
													<span>Remove Key</span>
												</Button>
											</div>
										</div>
									);
								}

								return (
									<div
										key={faction.id}
										className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 flex flex-col justify-between gap-3 text-xs shadow-xs"
									>
										<div className="space-y-2">
											<div className="flex items-center justify-between gap-2">
												<div className="flex items-center gap-2">
													<span className="font-bold text-sm text-foreground">
														{faction.name}
													</span>
												</div>
												<Badge
													variant="outline"
													className="text-[9px] font-mono px-1.5 py-0 text-amber-400 border-amber-500/30 bg-amber-500/10"
												>
													Key Required
												</Badge>
											</div>
											<p className="text-[11px] text-muted-foreground">
												Enter a Torn API key for an AA member or leader in{" "}
												{faction.name} with attack logs access.
											</p>
										</div>

										<div className="space-y-2 pt-2 border-t border-border/40">
											<div className="relative">
												<KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
												<Input
													type="password"
													value={currentSlotInput}
													onChange={(e) =>
														setSlotKeyInputs((prev) => ({
															...prev,
															[faction.id]: e.target.value,
														}))
													}
													placeholder={`16-char Torn API Key (${faction.tag})`}
													className="pl-8 font-mono text-xs rounded-lg h-9"
													maxLength={16}
												/>
											</div>
											<Button
												type="button"
												onClick={() => void handleAddSlotKey(faction.id)}
												disabled={
													isSlotAdding || currentSlotInput.trim().length !== 16
												}
												className="w-full h-8 rounded-lg text-xs font-semibold cursor-pointer"
											>
												{isSlotAdding ? (
													<>
														<Loader2 className="size-3 animate-spin mr-1" />
														Verifying /faction/attacks...
													</>
												) : (
													<>
														<Plus className="size-3.5 mr-1" />
														Add {faction.tag} Master Key
													</>
												)}
											</Button>
										</div>
									</div>
								);
							})}
						</div>

						{/* Universal key add option (auto-detected) */}
						<div className="pt-4 border-t border-border/40 space-y-2">
							<span className="text-xs font-medium text-muted-foreground">
								Quick Add (Auto-Detect Faction):
							</span>
							<div className="flex flex-col sm:flex-row gap-2.5 max-w-lg items-center">
								<div className="relative w-full">
									<KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
									<Input
										type="password"
										value={newKey}
										onChange={(e) => setNewKey(e.target.value)}
										placeholder="Enter 16-char Torn API Key"
										className="pl-9 font-mono text-xs rounded-xl h-10"
										maxLength={16}
									/>
								</div>
								<Button
									type="button"
									onClick={() => void handleAddKey()}
									disabled={isAddingKey || newKey.trim().length !== 16}
									className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
								>
									{isAddingKey ? (
										<>
											<Loader2 className="size-3.5 animate-spin mr-1.5" />
											Verifying /faction/attacks...
										</>
									) : (
										<>
											<Plus className="size-4 mr-1" />
											Auto-Register Key
										</>
									)}
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			) : (
				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardHeader className="border-b border-border/40">
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
							<div>
								<div className="flex items-center gap-2">
									<CardTitle className="text-lg font-semibold tracking-tight">
										Guild API Keys
									</CardTitle>
								</div>
							</div>
							<Button
								variant="outline"
								size="icon"
								onClick={() => void fetchKeys()}
								disabled={keysLoading}
								title="Refresh keys"
								className="size-8 border-border bg-background/50 cursor-pointer shadow-xs"
							>
								<RotateCw
									className={`size-3.5 text-muted-foreground ${keysLoading ? "animate-spin" : ""}`}
								/>
							</Button>
						</div>
					</CardHeader>
					<CardContent className="space-y-5">
						{/* Add Key Form */}
						<div className="flex flex-col sm:flex-row gap-2.5 max-w-lg items-center">
							<div className="relative w-full">
								<KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
								<Input
									type="password"
									value={newKey}
									onChange={(e) => setNewKey(e.target.value)}
									placeholder="Enter 16-char Torn API Key"
									className="pl-9 font-mono text-xs rounded-xl h-10"
									maxLength={16}
								/>
							</div>
							<Button
								type="button"
								onClick={() => void handleAddKey()}
								disabled={isAddingKey || newKey.trim().length !== 16}
								className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
							>
								{isAddingKey ? (
									<>
										<Loader2 className="size-3.5 animate-spin mr-1.5" />
										Verifying...
									</>
								) : (
									<>
										<Plus className="size-4 mr-1" />
										Add Key
									</>
								)}
							</Button>
						</div>

						{/* Keys List */}
						<div className="space-y-2">
							{keys.length === 0 ? (
								<p className="text-xs text-muted-foreground italic py-2">
									No guild API keys registered yet. Add at least one valid Torn
									API key to enable server operations.
								</p>
							) : (
								<div className="grid grid-cols-1 gap-2.5">
									{keys.map((k) => (
										<div
											key={k.id}
											className="p-3.5 rounded-xl border border-border/70 bg-background/50 flex items-center justify-between gap-3 text-xs"
										>
											<div className="flex items-center gap-3 min-w-0">
												<div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
													<KeyRound className="size-4" />
												</div>
												<div className="min-w-0">
													<div className="flex items-center gap-2">
														<a
															href={`https://www.torn.com/profiles.php?XID=${k.tornId}`}
															target="_blank"
															rel="noopener noreferrer"
															className="font-medium text-foreground hover:text-primary transition-colors flex items-center gap-1"
														>
															<span>{k.tornName}</span>
															<span className="font-mono text-[10px] text-muted-foreground">
																[{k.tornId}]
															</span>
															<ExternalLink className="size-2.5 opacity-60" />
														</a>
														<Badge
															variant="outline"
															className={`text-[9px] font-mono px-1.5 py-0 ${
																k.isValid
																	? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
																	: "text-rose-400 border-rose-500/30 bg-rose-500/10"
															}`}
														>
															{k.isValid
																? "Valid"
																: `Invalid (${k.invalidCount})`}
														</Badge>
													</div>
													<div className="text-[11px] font-mono text-muted-foreground mt-0.5 flex items-center gap-2">
														{k.donatedByDiscordTag && (
															<span>Added by @{k.donatedByDiscordTag}</span>
														)}
														{k.lastUsedAt && (
															<span>
																• Used{" "}
																{new Date(k.lastUsedAt).toLocaleDateString()}
															</span>
														)}
													</div>
												</div>
											</div>

											<Button
												variant="ghost"
												size="icon"
												onClick={() => void handleDeleteKey(k.id)}
												disabled={deletingKeyId === k.id}
												title="Delete key"
												className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer shrink-0"
											>
												{deletingKeyId === k.id ? (
													<Loader2 className="size-3.5 animate-spin" />
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
			)}

			{isMercGuild && (
				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
					<CardHeader className="border-b border-border/40">
						<CardTitle className="text-lg font-semibold tracking-tight">
							Merc Config
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="max-w-md">
							<div>
								<label
									htmlFor="merc-manager-role-select"
									className="text-sm font-semibold text-foreground block mb-1"
								>
									Mercenary Role
								</label>
							</div>
							<Select
								value={mercRoleId || "none"}
								onValueChange={(val) =>
									setMercRoleId(val === "none" ? "" : val)
								}
							>
								<SelectTrigger
									id="merc-role-select"
									className="w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- Select Mercenary Role --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
									<SelectGroup>
										<SelectItem value="none">No Merc Role (None)</SelectItem>
										{roles.map((r) => (
											<SelectItem key={r.id} value={r.id}>
												@{r.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						<div className="max-w-md pt-4 border-t border-border/40 space-y-3">
							<div>
								<label
									htmlFor="merc-manager-role-select"
									className="text-sm font-semibold text-foreground block mb-1"
								>
									Mercenary Manager Role
								</label>
							</div>
							<Select
								value={mercManagerRoleId || "none"}
								onValueChange={(val) =>
									setMercManagerRoleId(val === "none" ? "" : val)
								}
							>
								<SelectTrigger
									id="merc-manager-role-select"
									className="w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- Select Mercenary Manager Role --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
									<SelectGroup>
										<SelectItem value="none">No Manager Role (None)</SelectItem>
										{roles.map((r) => (
											<SelectItem key={r.id} value={r.id}>
												@{r.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						<div className="pt-4 border-t border-border/40 grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div className="space-y-1.5">
								<label
									htmlFor="default-hit-price"
									className="text-sm font-semibold text-foreground block"
								>
									Standard Hit Value ($)
								</label>

								<Input
									id="default-hit-price"
									type="text"
									value={mercDefaultHitPrice}
									onChange={(e) => setMercDefaultHitPrice(e.target.value)}
									placeholder="3000000"
									className="h-10 rounded-xl bg-background border-input font-mono text-sm max-w-md"
								/>
							</div>

							<div className="space-y-1.5">
								<label
									htmlFor="default-stricken-price"
									className="text-sm font-semibold text-foreground block"
								>
									Stricken Hit Value ($)
								</label>

								<Input
									id="default-stricken-price"
									type="text"
									value={mercDefaultStrickenHitPrice}
									onChange={(e) =>
										setMercDefaultStrickenHitPrice(e.target.value)
									}
									placeholder="4000000"
									className="h-10 rounded-xl bg-background border-input font-mono text-sm max-w-md"
								/>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

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
