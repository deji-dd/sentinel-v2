import {
	AlertTriangle,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	KeyRound,
	Loader2,
	Pencil,
	Plus,
	RotateCcw,
	Save,
	Search,
	Trash2,
	UserCheck,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Switch } from "@/components/ui/switch";
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

interface FactionMapping {
	id: string;
	factionId: number;
	factionName: string | null;
	factionTag: string | null;
	tagImage: string | null;
	memberRoleIds: string[];
	leaderRoleIds: string[];
	enabled: boolean;
}

interface PendingMapping {
	tempId: string;
	factionId: number;
	factionName: string | null;
	factionTag: string | null;
	tagImage: string | null;
	memberRoleIds: string[];
	leaderRoleIds: string[];
}

interface VerificationPageProps {
	guildId: string;
}

function roleColor(color: number): string {
	if (!color) return "#64748b";
	return `#${color.toString(16).padStart(6, "0")}`;
}

const MAPPINGS_PER_PAGE = 5;

export default function VerificationPage({ guildId }: VerificationPageProps) {
	const { toast } = useToast();
	const { navigate } = useRouter();
	const topFormRef = useRef<HTMLDivElement>(null);

	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);
	const [isEnabled, setIsEnabled] = useState(true);
	const [hasApiKey, setHasApiKey] = useState(true);

	const [channels, setChannels] = useState<Channel[]>([]);
	const [roles, setRoles] = useState<Role[]>([]);

	// Verification Form States
	const [verifiedRoleIds, setVerifiedRoleIds] = useState<string[]>([]);
	const [initialVerifiedRoleIds, setInitialVerifiedRoleIds] = useState<
		string[]
	>([]);
	const [verifiedRoleInput, setVerifiedRoleInput] = useState("");

	const [nicknameTemplate, setNicknameTemplate] = useState(
		"[{tag}] {name} [{id}]",
	);
	const [initialNicknameTemplate, setInitialNicknameTemplate] = useState(
		"[{tag}] {name} [{id}]",
	);

	const [verifyOnJoin, setVerifyOnJoin] = useState(false);
	const [initialVerifyOnJoin, setInitialVerifyOnJoin] = useState(false);

	const [verifyCron, setVerifyCron] = useState(false);
	const [initialVerifyCron, setInitialVerifyCron] = useState(false);

	const [verifyCronInterval, setVerifyCronInterval] = useState("24");
	const [initialVerifyCronInterval, setInitialVerifyCronInterval] =
		useState("24");

	const [protectedRoleIds, setProtectedRoleIds] = useState<string[]>([]);
	const [initialProtectedRoleIds, setInitialProtectedRoleIds] = useState<
		string[]
	>([]);
	const [protectedRoleInput, setProtectedRoleInput] = useState("");

	const [factionListChannelId, setFactionListChannelId] = useState("");
	const [initialFactionListChannelId, setInitialFactionListChannelId] =
		useState("");

	// Faction Role Mappings State
	const [mappings, setMappings] = useState<FactionMapping[]>([]);
	const [pendingAdds, setPendingAdds] = useState<PendingMapping[]>([]);
	const [pendingUpdates, setPendingUpdates] = useState<
		Record<string, { memberRoleIds: string[]; leaderRoleIds: string[] }>
	>({});
	const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
	const [currentPage, setCurrentPage] = useState(1);

	// New / Edit Mapping Builder State
	const [newFactionId, setNewFactionId] = useState("");
	const [resolvedFaction, setResolvedFaction] = useState<{
		id: number;
		name: string;
		tag: string | null;
		tagImage: string | null;
	} | null>(null);
	const [isResolvingFaction, setIsResolvingFaction] = useState(false);
	const [newMemberRoles, setNewMemberRoles] = useState<string[]>([]);
	const [newLeaderRoles, setNewLeaderRoles] = useState<string[]>([]);
	const [newMemberRoleInput, setNewMemberRoleInput] = useState("");
	const [newLeaderRoleInput, setNewLeaderRoleInput] = useState("");
	const [editingMappingKey, setEditingMappingKey] = useState<string | null>(
		null,
	);

	// Inline Card Role Inputs State
	const [inlineMemberRoleInput, setInlineMemberRoleInput] = useState<
		Record<string, string>
	>({});
	const [inlineLeaderRoleInput, setInlineLeaderRoleInput] = useState<
		Record<string, string>
	>({});

	// Expanded Mapping State
	const [expandedMappingId, setExpandedMappingId] = useState<string | null>(
		null,
	);

	const [isSaving, setIsSaving] = useState(false);

	const isDirty =
		JSON.stringify(verifiedRoleIds) !==
			JSON.stringify(initialVerifiedRoleIds) ||
		nicknameTemplate !== initialNicknameTemplate ||
		verifyOnJoin !== initialVerifyOnJoin ||
		verifyCron !== initialVerifyCron ||
		verifyCronInterval !== initialVerifyCronInterval ||
		JSON.stringify(protectedRoleIds) !==
			JSON.stringify(initialProtectedRoleIds) ||
		factionListChannelId !== initialFactionListChannelId ||
		pendingAdds.length > 0 ||
		pendingDeletes.size > 0 ||
		Object.keys(pendingUpdates).length > 0;

	const fetchConfig = useCallback(async () => {
		setLoading(true);
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

				const enabled = (config.enabledModules ?? []).includes("verification");
				setIsEnabled(enabled);

				const validKeys = (data.apiKeys ?? []).filter((k) => k.isValid);
				setHasApiKey(validKeys.length > 0);

				const vRoles = config.verifiedRoleIds ?? [];
				const nick = config.nicknameTemplate ?? "[{tag}] {name} [{id}]";
				const vJoin = config.verifyOnJoin ?? false;
				const vCron = config.verifyCron ?? false;
				const vCronInt = String(config.verifyCronInterval ?? 24);
				const pRoles = config.protectedRoleIds ?? [];
				const fChannel = config.factionListChannelId ?? "";

				setVerifiedRoleIds(vRoles);
				setInitialVerifiedRoleIds(vRoles);
				setNicknameTemplate(nick);
				setInitialNicknameTemplate(nick);
				setVerifyOnJoin(vJoin);
				setInitialVerifyOnJoin(vJoin);
				setVerifyCron(vCron);
				setInitialVerifyCron(vCron);
				setVerifyCronInterval(vCronInt);
				setInitialVerifyCronInterval(vCronInt);
				setProtectedRoleIds(pRoles);
				setInitialProtectedRoleIds(pRoles);
				setFactionListChannelId(fChannel);
				setInitialFactionListChannelId(fChannel);

				if (
					"factionRoleMappings" in data &&
					Array.isArray(data.factionRoleMappings)
				) {
					setMappings(data.factionRoleMappings as FactionMapping[]);
				}
			}

			if (channelsRes.data && "channels" in channelsRes.data) {
				setChannels(channelsRes.data.channels);
			}

			if (rolesRes.data && "roles" in rolesRes.data) {
				setRoles(rolesRes.data.roles);
			}
		} catch {
			toast("Failed to load verification configuration.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	const handleLookupFaction = async () => {
		const factionIdNum = Number.parseInt(newFactionId, 10);
		if (!newFactionId || Number.isNaN(factionIdNum) || factionIdNum <= 0) {
			setResolvedFaction(null);
			setEditingMappingKey(null);
			toast("Please enter a valid numeric Faction ID.", "error");
			return;
		}
		setIsResolvingFaction(true);
		try {
			const res = await fetch(
				`/api/v1/guilds/${guildId}/factions/${factionIdNum}`,
			);
			if (!res.ok) {
				setResolvedFaction(null);
				setEditingMappingKey(null);
				toast("Faction not found.", "error");
				return;
			}
			const data = (await res.json()) as {
				faction?: {
					id: number;
					name: string;
					tag: string | null;
					tagImage: string | null;
				};
			};
			if (data.faction) {
				setResolvedFaction(data.faction);

				// Check if mapping for this faction already exists in pendingAdds or mappings
				const existingPending = pendingAdds.find(
					(p) => p.factionId === factionIdNum,
				);
				const existingSaved = mappings.find(
					(m) => m.factionId === factionIdNum && !pendingDeletes.has(m.id),
				);

				if (existingPending) {
					setNewMemberRoles([...existingPending.memberRoleIds]);
					setNewLeaderRoles([...existingPending.leaderRoleIds]);
					setEditingMappingKey(existingPending.tempId);
					toast(
						`Faction #${factionIdNum} is already staged for addition. Loaded for editing.`,
						"info",
					);
				} else if (existingSaved) {
					const updateObj = pendingUpdates[existingSaved.id];
					setNewMemberRoles([
						...(updateObj?.memberRoleIds ?? existingSaved.memberRoleIds),
					]);
					setNewLeaderRoles([
						...(updateObj?.leaderRoleIds ?? existingSaved.leaderRoleIds),
					]);
					setEditingMappingKey(existingSaved.id);
					toast(
						`Faction #${factionIdNum} is already configured. Loaded for editing.`,
						"info",
					);
				} else {
					setEditingMappingKey(null);
					toast(`Found Faction: ${data.faction.name}`, "success");
				}
			} else {
				setResolvedFaction(null);
				setEditingMappingKey(null);
				toast("Faction not found.", "error");
			}
		} catch {
			setResolvedFaction(null);
			setEditingMappingKey(null);
			toast("Failed to resolve faction details.", "error");
		} finally {
			setIsResolvingFaction(false);
		}
	};

	const handleClearForm = () => {
		setNewFactionId("");
		setResolvedFaction(null);
		setNewMemberRoles([]);
		setNewLeaderRoles([]);
		setEditingMappingKey(null);
	};

	const handleAddPendingMapping = () => {
		const factionIdNum = Number.parseInt(newFactionId, 10);
		if (!newFactionId || Number.isNaN(factionIdNum) || factionIdNum <= 0) {
			toast("Enter a valid numeric Faction ID.", "error");
			return;
		}

		const existingPending = pendingAdds.find(
			(p) => p.factionId === factionIdNum,
		);
		const existingSaved = mappings.find((m) => m.factionId === factionIdNum);

		if (existingPending) {
			setPendingAdds((prev) =>
				prev.map((p) =>
					p.factionId === factionIdNum
						? {
								...p,
								memberRoleIds: newMemberRoles,
								leaderRoleIds: newLeaderRoles,
							}
						: p,
				),
			);
			toast(
				`Updated staged mapping for ${resolvedFaction?.name ?? `Faction #${factionIdNum}`}.`,
				"info",
			);
		} else if (existingSaved) {
			if (pendingDeletes.has(existingSaved.id)) {
				setPendingDeletes((prev) => {
					const next = new Set(prev);
					next.delete(existingSaved.id);
					return next;
				});
			}
			setPendingUpdates((prev) => ({
				...prev,
				[existingSaved.id]: {
					memberRoleIds: newMemberRoles,
					leaderRoleIds: newLeaderRoles,
				},
			}));
			toast(
				`Updated mapping for ${resolvedFaction?.name ?? `Faction #${factionIdNum}`} staged for save.`,
				"info",
			);
		} else {
			const pending: PendingMapping = {
				tempId: `pending-${factionIdNum}-${Date.now()}`,
				factionId: factionIdNum,
				factionName: resolvedFaction?.name ?? null,
				factionTag: resolvedFaction?.tag ?? null,
				tagImage: resolvedFaction?.tagImage ?? null,
				memberRoleIds: newMemberRoles,
				leaderRoleIds: newLeaderRoles,
			};

			setPendingAdds((prev) => [...prev, pending]);
			toast("Faction mapping staged for save.", "info");
		}

		handleClearForm();
	};

	const handleRevertMapping = (idKey: string) => {
		setPendingUpdates((prev) => {
			const next = { ...prev };
			delete next[idKey];
			return next;
		});
		toast("Reverted mapping changes to original state.", "info");
	};

	const handleUpdateItemRoles = (
		idKey: string,
		isPending: boolean,
		newMemberRoleIds: string[],
		newLeaderRoleIds: string[],
	) => {
		if (isPending) {
			setPendingAdds((prev) =>
				prev.map((p) =>
					p.tempId === idKey
						? {
								...p,
								memberRoleIds: newMemberRoleIds,
								leaderRoleIds: newLeaderRoleIds,
							}
						: p,
				),
			);
		} else {
			setPendingUpdates((prev) => ({
				...prev,
				[idKey]: {
					memberRoleIds: newMemberRoleIds,
					leaderRoleIds: newLeaderRoleIds,
				},
			}));
		}
	};

	const handleDiscard = () => {
		setVerifiedRoleIds(initialVerifiedRoleIds);
		setNicknameTemplate(initialNicknameTemplate);
		setVerifyOnJoin(initialVerifyOnJoin);
		setVerifyCron(initialVerifyCron);
		setVerifyCronInterval(initialVerifyCronInterval);
		setProtectedRoleIds(initialProtectedRoleIds);
		setFactionListChannelId(initialFactionListChannelId);
		setPendingAdds([]);
		setPendingDeletes(new Set());
		setPendingUpdates({});
		handleClearForm();
		toast("Unsaved changes discarded.", "info");
	};

	const handleSaveChanges = async () => {
		setIsSaving(true);
		try {
			const guildRoute = api.api.v1.guilds[guildId];
			if (!guildRoute) return;

			// 1. Update general verification config
			const intervalNum = Number.parseInt(String(verifyCronInterval), 10);
			const configPayload = {
				verifiedRoleIds,
				nicknameTemplate,
				verifyOnJoin,
				verifyCron,
				verifyCronInterval:
					Number.isNaN(intervalNum) || intervalNum < 1 ? 24 : intervalNum,
				protectedRoleIds,
				factionListChannelId: factionListChannelId || null,
			};

			const configRes = await guildRoute.config.put(configPayload);
			if (configRes.error) {
				throw new Error("Failed to update general settings.");
			}

			// 2. Process pending deletes
			for (const mappingId of pendingDeletes) {
				const mappingRoute = guildRoute["faction-mappings"][mappingId];
				if (mappingRoute) {
					const deleteRes = await mappingRoute.delete();
					if (deleteRes.error) {
						loggerError(`Failed to delete mapping ${mappingId}`);
					}
				}
			}

			// 3. Process pending updates
			for (const [mappingId, updateObj] of Object.entries(pendingUpdates)) {
				const mappingRoute = guildRoute["faction-mappings"][mappingId];
				if (mappingRoute) {
					const putRes = await mappingRoute.put({
						memberRoleIds: updateObj.memberRoleIds,
						leaderRoleIds: updateObj.leaderRoleIds,
					});
					if (putRes.error) {
						loggerError(`Failed to update mapping ${mappingId}`);
					}
				}
			}

			// 4. Process pending adds
			for (const addObj of pendingAdds) {
				const addRes = await guildRoute["faction-mappings"].post({
					factionId: addObj.factionId,
					factionName: addObj.factionName ?? undefined,
					memberRoleIds: addObj.memberRoleIds,
					leaderRoleIds: addObj.leaderRoleIds,
				});
				if (addRes.error) {
					loggerError(`Failed to add mapping for faction ${addObj.factionId}`);
				}
			}

			toast("Verification engine settings saved successfully!", "success");
			setPendingAdds([]);
			setPendingDeletes(new Set());
			setPendingUpdates({});
			handleClearForm();
			await fetchConfig();
		} catch {
			toast("Failed to save verification settings.", "error");
		} finally {
			setIsSaving(false);
		}
	};

	function loggerError(msg: string) {
		console.error(`[VerificationPage] ${msg}`);
	}

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3 py-4 border-b border-border/60">
					<Loader2 className="size-5 animate-spin text-primary" />
					<span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
						Loading Verification Settings...
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

	if (!isEnabled) {
		return (
			<div className="space-y-8">
				<div className="pb-6 border-b border-border/60">
					<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
						Verification
					</h1>
					<p className="text-muted-foreground text-sm mt-1">
						Module is currently disabled for this server.
					</p>
				</div>

				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl p-8 sm:p-12 text-center flex flex-col items-center gap-4">
					<div className="size-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shadow-xs">
						<UserCheck className="size-7" />
					</div>
					<div className="space-y-1">
						<CardTitle className="text-xl font-bold tracking-tight text-foreground">
							Module Disabled
						</CardTitle>
						<p className="text-muted-foreground text-xs sm:text-sm max-w-md leading-relaxed">
							The Verification module is turned off for this server. Contact a
							Sentinel administrator to enable this module.
						</p>
					</div>
				</Card>
			</div>
		);
	}

	const activeMappings = mappings.filter((m) => !pendingDeletes.has(m.id));
	const allVisibleMappings = [
		...activeMappings.map((m) => ({ type: "existing" as const, data: m })),
		...pendingAdds.map((p) => ({ type: "pending" as const, data: p })),
	];

	const totalMappingsCount = allVisibleMappings.length;
	const totalPages = Math.ceil(totalMappingsCount / MAPPINGS_PER_PAGE) || 1;

	const pageStartIndex = (currentPage - 1) * MAPPINGS_PER_PAGE;
	const currentPageItems = allVisibleMappings.slice(
		pageStartIndex,
		pageStartIndex + MAPPINGS_PER_PAGE,
	);

	return (
		<div className="space-y-8 pb-20">
			{/* Page Header */}
			<div className="pb-6 border-b border-border/60">
				<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
					Verification
				</h1>
			</div>

			{/* Warning Banner if API key is missing */}
			{!hasApiKey && (
				<Alert className="border-amber-500/30 bg-amber-500/10 text-amber-200 rounded-2xl p-4 sm:p-5 shadow-lg">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
						<div className="flex items-start gap-3">
							<div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 shrink-0">
								<KeyRound className="size-5" />
							</div>
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<span className="font-bold text-sm text-amber-300">
										Torn API Key Required
									</span>
									<Badge
										variant="outline"
										className="border-amber-500/40 bg-amber-500/20 text-amber-300 text-[9px] font-mono uppercase"
									>
										Action Needed
									</Badge>
								</div>
								<AlertDescription className="text-xs text-amber-200/90 leading-relaxed">
									Verification requires at least one active, valid Torn API Key
									registered to this guild to query player profile data and
									automate role syncs.
								</AlertDescription>
							</div>
						</div>

						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => navigate(`/guilds/${guildId}`)}
							className="border-amber-500/40 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs font-semibold rounded-xl shrink-0 gap-1.5 cursor-pointer"
						>
							Configure API Key
							<ChevronRight className="size-3.5" />
						</Button>
					</div>
				</Alert>
			)}

			{/* 1. Verified Member Roles */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Verified Member Roles
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex gap-2.5 max-w-md items-center">
						{roles.length > 0 ? (
							<Select
								value={verifiedRoleInput}
								onValueChange={(val) => setVerifiedRoleInput(val)}
							>
								<SelectTrigger className="flex-1 h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans">
									<SelectValue placeholder="-- Select Role to Assign --" />
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
								type="text"
								value={verifiedRoleInput}
								onChange={(e) => setVerifiedRoleInput(e.target.value)}
								placeholder="Enter Discord Role ID"
								className="flex-1 font-mono text-xs rounded-xl"
							/>
						)}
						<Button
							type="button"
							onClick={() => {
								if (!verifiedRoleInput) return;
								if (verifiedRoleIds.includes(verifiedRoleInput)) {
									toast("Role already added.", "info");
									return;
								}
								setVerifiedRoleIds([...verifiedRoleIds, verifiedRoleInput]);
								setVerifiedRoleInput("");
							}}
							className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
						>
							<Plus className="size-4" data-icon="inline-start" />
							Add Role
						</Button>
					</div>

					<div className="flex flex-wrap gap-2">
						{verifiedRoleIds.length === 0 ? (
							<p className="text-xs text-muted-foreground italic">
								No verified member roles configured.
							</p>
						) : (
							verifiedRoleIds.map((roleId) => {
								const roleObj = roles.find((r) => r.id === roleId);
								return (
									<Badge
										key={roleId}
										variant="secondary"
										className="pl-3 pr-1.5 py-1 rounded-xl text-xs font-medium flex items-center gap-1.5 border border-border"
									>
										{roleObj && (
											<span
												className="size-2 rounded-full shrink-0"
												style={{ backgroundColor: roleColor(roleObj.color) }}
											/>
										)}
										<span>{roleObj ? `${roleObj.name}` : roleId}</span>
										<button
											type="button"
											onClick={() =>
												setVerifiedRoleIds((prev) =>
													prev.filter((id) => id !== roleId),
												)
											}
											className="size-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors"
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

			{/* 2. Automated Verification Controls */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Automated Verification
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Toggle: Verify on Join */}
					<div className="flex items-center justify-between gap-4 p-4 rounded-xl bg-background/60 border border-border/80">
						<div className="space-y-0.5">
							<p className="text-sm font-semibold text-foreground">
								Verify on Join
							</p>
							<p className="text-xs text-muted-foreground">
								Automatically attempt Torn verification when a new user joins
								the Discord server.
							</p>
						</div>
						<Switch
							checked={verifyOnJoin}
							onCheckedChange={setVerifyOnJoin}
							aria-label="Toggle verify on join"
						/>
					</div>

					{/* Toggle: Background Reverification */}
					<div className="flex items-center justify-between gap-4 p-4 rounded-xl bg-background/60 border border-border/80">
						<div className="space-y-0.5">
							<p className="text-sm font-semibold text-foreground">
								Background Auto-Reverification
							</p>
							<p className="text-xs text-muted-foreground">
								Periodically audit and re-sync roles & nicknames for verified
								members in the background.
							</p>
						</div>
						<Switch
							checked={verifyCron}
							onCheckedChange={setVerifyCron}
							aria-label="Toggle background reverification"
						/>
					</div>

					{/* Cron Frequency Input */}
					{verifyCron && (
						<div className="space-y-2 max-w-xs pl-4 border-l-2 border-primary/40">
							<label
								htmlFor="cron-interval-input"
								className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
							>
								Audit Frequency (Hours)
							</label>
							<Input
								id="cron-interval-input"
								type="text"
								inputMode="numeric"
								pattern="[0-9]*"
								value={verifyCronInterval}
								onChange={(e) =>
									setVerifyCronInterval(e.target.value.replace(/\D/g, ""))
								}
								placeholder="24"
								className="font-mono text-xs rounded-xl"
							/>
							<p className="text-[11px] text-muted-foreground">
								Run background reverification check every{" "}
								{verifyCronInterval || "24"} hours.
							</p>
						</div>
					)}
				</CardContent>
			</Card>

			{/* 3. Nickname Format Template */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Nickname Format Template
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 max-w-md">
						<label
							htmlFor="nickname-template-input"
							className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
						>
							Template String
						</label>
						<Input
							id="nickname-template-input"
							type="text"
							value={nicknameTemplate}
							onChange={(e) => setNicknameTemplate(e.target.value)}
							placeholder="[{tag}] {name} [{id}]"
							className="font-mono text-xs rounded-xl"
						/>
					</div>

					{/* Token helper chips */}
					<div className="space-y-2">
						<span className="text-[11px] font-mono text-muted-foreground uppercase font-semibold block">
							Available Tokens (Click to insert):
						</span>
						<div className="flex flex-wrap gap-2">
							{[
								{ token: "{name}", desc: "Player Name" },
								{ token: "{id}", desc: "Torn Player ID" },
								{ token: "{tag}", desc: "Faction Tag" },
							].map((item) => (
								<Button
									key={item.token}
									type="button"
									variant="outline"
									size="sm"
									onClick={() =>
										setNicknameTemplate((prev) =>
											`${prev} ${item.token}`.trim(),
										)
									}
									className="h-7 text-[11px] font-mono rounded-lg border-border/80 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
								>
									{item.token}
									<span className="text-muted-foreground text-[10px] font-sans">
										({item.desc})
									</span>
								</Button>
							))}
						</div>
					</div>
				</CardContent>
			</Card>

			{/* 4. Protected Roles */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Protected Roles
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex gap-2.5 max-w-md items-center">
						{roles.length > 0 ? (
							<Select
								value={protectedRoleInput}
								onValueChange={(val) => setProtectedRoleInput(val)}
							>
								<SelectTrigger className="flex-1 h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans">
									<SelectValue placeholder="-- Select Protected Role --" />
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
								type="text"
								value={protectedRoleInput}
								onChange={(e) => setProtectedRoleInput(e.target.value)}
								placeholder="Enter Discord Role ID"
								className="flex-1 font-mono text-xs rounded-xl"
							/>
						)}
						<Button
							type="button"
							onClick={() => {
								if (!protectedRoleInput) return;
								if (protectedRoleIds.includes(protectedRoleInput)) {
									toast("Role already protected.", "info");
									return;
								}
								setProtectedRoleIds([...protectedRoleIds, protectedRoleInput]);
								setProtectedRoleInput("");
							}}
							className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
						>
							<Plus className="size-4" data-icon="inline-start" />
							Protect Role
						</Button>
					</div>

					<div className="flex flex-wrap gap-2">
						{protectedRoleIds.length === 0 ? (
							<p className="text-xs text-muted-foreground italic">
								No protected roles configured.
							</p>
						) : (
							protectedRoleIds.map((roleId) => {
								const roleObj = roles.find((r) => r.id === roleId);
								return (
									<Badge
										key={roleId}
										variant="secondary"
										className="pl-3 pr-1.5 py-1 rounded-xl text-xs font-medium flex items-center gap-1.5 border border-border"
									>
										{roleObj && (
											<span
												className="size-2 rounded-full shrink-0"
												style={{ backgroundColor: roleColor(roleObj.color) }}
											/>
										)}
										<span>{roleObj ? `@${roleObj.name}` : roleId}</span>
										<button
											type="button"
											onClick={() =>
												setProtectedRoleIds((prev) =>
													prev.filter((id) => id !== roleId),
												)
											}
											className="size-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors"
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

			{/* 5. Faction Role Mappings */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Faction Role Mappings
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Target Faction List Channel Bar */}
					<div className="p-4 rounded-xl bg-background/50 border border-border/70 flex flex-col gap-3">
						<div className="space-y-0.5">
							<label
								htmlFor="faction-channel-select"
								className="text-sm font-semibold text-foreground block"
							>
								Faction Roster Display Channel
							</label>
							<p className="text-xs text-muted-foreground">
								Channel where Sentinel posts and updates live faction member
								rosters.
							</p>
						</div>
						<div className="w-full max-w-md">
							{channels.length > 0 ? (
								<Select
									value={factionListChannelId}
									onValueChange={(val) =>
										setFactionListChannelId(val === "none" ? "" : val)
									}
								>
									<SelectTrigger
										id="faction-channel-select"
										className="w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
									>
										<SelectValue placeholder="-- No Channel Selected --" />
									</SelectTrigger>
									<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground">
										<SelectGroup>
											<SelectItem value="none">
												-- No Channel Selected --
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
									id="faction-channel-select"
									type="text"
									value={factionListChannelId}
									onChange={(e) => setFactionListChannelId(e.target.value)}
									placeholder="Enter Discord Channel ID"
									className="font-mono text-xs rounded-xl"
								/>
							)}
						</div>
					</div>

					{/* Add or Edit Faction Mapping Panel */}
					<div
						ref={topFormRef}
						className="rounded-2xl border border-border/80 bg-background/50 overflow-hidden shadow-xs p-2"
					>
						<div className="px-5 py-3.5 bg-muted/40 border-b border-border/60 flex items-center justify-between gap-4">
							<div className="flex items-center gap-2">
								<span className="text-xs font-mono font-bold text-foreground uppercase tracking-wider">
									{editingMappingKey
										? "Edit Faction Mapping"
										: "Add Faction Mapping"}
								</span>
								{editingMappingKey && (
									<Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-[9px] font-mono uppercase">
										EDITING MAPPING
									</Badge>
								)}
							</div>
							{resolvedFaction && (
								<div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-primary/10 border border-primary/20 text-xs font-semibold text-primary">
									{resolvedFaction.tagImage && (
										<img
											src={`https://factiontags.torn.com/${resolvedFaction.tagImage}`}
											alt={resolvedFaction.tag ?? String(resolvedFaction.id)}
											className="h-3.5 object-contain"
										/>
									)}
									<span>
										{resolvedFaction.name}{" "}
										{resolvedFaction.tag ? `[${resolvedFaction.tag}]` : ""}
									</span>
								</div>
							)}
						</div>

						<div className="p-5 space-y-6">
							{/* Faction Already Exists Warning Alert */}
							{editingMappingKey && resolvedFaction && (
								<div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs flex items-center justify-between gap-3 shadow-xs">
									<div className="flex px-2 items-center gap-2.5 min-w-0">
										<AlertTriangle className="size-4 text-amber-500 shrink-0" />
										<span className="truncate font-medium text-amber-900 dark:text-amber-200">
											Faction ({resolvedFaction.name}) already exists in your
											mappings. Modifying roles will update this mapping.
										</span>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={handleClearForm}
										className="h-7 pe-2.5 text-[11px] bg-transparent hover:bg-amber-500/10 font-medium border-0 rounded-lg shrink-0 cursor-pointer"
									>
										Cancel Edit
									</Button>
								</div>
							)}

							{/* Top: Faction ID Search Row */}
							<div className="space-y-2">
								<label
									htmlFor="new-faction-id"
									className="text-xs font-semibold text-foreground flex items-center gap-1"
								>
									Torn Faction ID <span className="text-destructive">*</span>
								</label>
								<div className="flex gap-2 max-w-md items-center">
									<Input
										id="new-faction-id"
										type="text"
										inputMode="numeric"
										pattern="[0-9]*"
										value={newFactionId}
										onChange={(e) =>
											setNewFactionId(e.target.value.replace(/\D/g, ""))
										}
										placeholder="Enter Faction ID (e.g. 1234)"
										className="font-mono text-xs rounded-xl flex-1"
									/>
									<Button
										type="button"
										variant="outline"
										onClick={() => void handleLookupFaction()}
										disabled={isResolvingFaction || !newFactionId}
										className="h-10 px-4 text-xs font-semibold rounded-xl cursor-pointer shrink-0 gap-1.5"
									>
										{isResolvingFaction ? (
											<Loader2 className="size-3.5 animate-spin" />
										) : (
											<Search className="size-3.5" />
										)}
										Lookup Faction
									</Button>
								</div>
							</div>

							{/* Roles 2-Column Section */}
							<div
								className={`grid gap-6 sm:grid-cols-2 pt-4 border-t border-border/40 transition-opacity ${
									!resolvedFaction ? "opacity-50" : ""
								}`}
							>
								{/* Member Roles Selection */}
								<div className="space-y-2">
									<label
										htmlFor="new-member-role-select"
										className="text-xs font-semibold text-foreground block"
									>
										Faction Member Roles
									</label>
									<div className="flex gap-2 items-center">
										{roles.length > 0 ? (
											<Select
												value={newMemberRoleInput}
												onValueChange={(val) => setNewMemberRoleInput(val)}
												disabled={!resolvedFaction}
											>
												<SelectTrigger
													id="new-member-role-select"
													className="flex-1 h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
												>
													<SelectValue placeholder="Select Member Role..." />
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
												id="new-member-role-select"
												type="text"
												value={newMemberRoleInput}
												onChange={(e) => setNewMemberRoleInput(e.target.value)}
												placeholder="Role ID"
												disabled={!resolvedFaction}
												className="flex-1 font-mono text-xs rounded-xl"
											/>
										)}
										<Button
											type="button"
											variant="secondary"
											disabled={!resolvedFaction || !newMemberRoleInput}
											onClick={() => {
												if (!newMemberRoleInput) return;
												if (newMemberRoles.includes(newMemberRoleInput)) return;
												setNewMemberRoles([
													...newMemberRoles,
													newMemberRoleInput,
												]);
												setNewMemberRoleInput("");
											}}
											className="h-10 px-3 text-xs font-semibold rounded-xl cursor-pointer shrink-0"
										>
											Add
										</Button>
									</div>
									<div className="flex flex-wrap gap-1.5 min-h-[28px] items-center pt-1">
										{newMemberRoles.length === 0 ? (
											<span className="text-[11px] text-muted-foreground italic">
												No member roles added yet
											</span>
										) : (
											newMemberRoles.map((id) => (
												<Badge
													key={id}
													variant="outline"
													className="text-[10px] font-mono px-2 py-0.5 rounded-md flex items-center gap-1"
												>
													@{roles.find((r) => r.id === id)?.name ?? id}
													<button
														type="button"
														onClick={() =>
															setNewMemberRoles((prev) =>
																prev.filter((r) => r !== id),
															)
														}
														className="hover:text-destructive cursor-pointer"
													>
														<X className="size-3" />
													</button>
												</Badge>
											))
										)}
									</div>
								</div>

								{/* Leader Roles Selection */}
								<div className="space-y-2">
									<label
										htmlFor="new-leader-role-select"
										className="text-xs font-semibold text-foreground block"
									>
										Faction Leader Roles
									</label>
									<div className="flex gap-2 items-center">
										{roles.length > 0 ? (
											<Select
												value={newLeaderRoleInput}
												onValueChange={(val) => setNewLeaderRoleInput(val)}
												disabled={!resolvedFaction}
											>
												<SelectTrigger
													id="new-leader-role-select"
													className="flex-1 h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
												>
													<SelectValue placeholder="Select Leader Role..." />
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
												id="new-leader-role-select"
												type="text"
												value={newLeaderRoleInput}
												onChange={(e) => setNewLeaderRoleInput(e.target.value)}
												placeholder="Role ID"
												disabled={!resolvedFaction}
												className="flex-1 font-mono text-xs rounded-xl"
											/>
										)}
										<Button
											type="button"
											variant="secondary"
											disabled={!resolvedFaction || !newLeaderRoleInput}
											onClick={() => {
												if (!newLeaderRoleInput) return;
												if (newLeaderRoles.includes(newLeaderRoleInput)) return;
												setNewLeaderRoles([
													...newLeaderRoles,
													newLeaderRoleInput,
												]);
												setNewLeaderRoleInput("");
											}}
											className="h-10 px-3 text-xs font-semibold rounded-xl cursor-pointer shrink-0"
										>
											Add
										</Button>
									</div>
									<div className="flex flex-wrap gap-1.5 min-h-[28px] items-center pt-1">
										{newLeaderRoles.length === 0 ? (
											<span className="text-[11px] text-muted-foreground italic">
												No leader roles added yet
											</span>
										) : (
											newLeaderRoles.map((id) => (
												<Badge
													key={id}
													variant="outline"
													className="text-[10px] font-mono px-2 py-0.5 rounded-md flex items-center gap-1 border-purple-500/30 text-purple-300"
												>
													@{roles.find((r) => r.id === id)?.name ?? id}
													<button
														type="button"
														onClick={() =>
															setNewLeaderRoles((prev) =>
																prev.filter((r) => r !== id),
															)
														}
														className="hover:text-destructive cursor-pointer"
													>
														<X className="size-3" />
													</button>
												</Badge>
											))
										)}
									</div>
								</div>
							</div>

							{/* Action Bar */}
							<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-border/40">
								<span className="text-xs text-muted-foreground">
									{!resolvedFaction
										? "Lookup a Faction ID to enable role assignment and staging."
										: editingMappingKey
											? "Update staged roles for this faction mapping."
											: "Stage this mapping to review before saving changes."}
								</span>
								<div className="flex items-center gap-2 shrink-0">
									{editingMappingKey && (
										<Button
											type="button"
											variant="outline"
											onClick={handleClearForm}
											className="h-10 px-4 text-xs font-semibold rounded-xl cursor-pointer"
										>
											Cancel Edit
										</Button>
									)}
									<Button
										type="button"
										onClick={handleAddPendingMapping}
										disabled={!resolvedFaction}
										className="h-10 px-5 text-xs font-semibold rounded-xl cursor-pointer gap-2 shrink-0"
									>
										{editingMappingKey ? (
											<>
												<Pencil className="size-3.5" data-icon="inline-start" />
												Update Faction Mapping
											</>
										) : (
											<>
												<Plus className="size-4" data-icon="inline-start" />
												Stage Faction Mapping
											</>
										)}
									</Button>
								</div>
							</div>
						</div>
					</div>

					{/* Faction Mappings List */}
					<div className="space-y-3">
						<span className="text-xs font-mono font-bold text-muted-foreground uppercase tracking-wider block">
							Configured Faction Mappings ({totalMappingsCount})
						</span>

						{totalMappingsCount === 0 ? (
							<div className="p-6 text-center rounded-xl bg-background/40 border border-border/60 text-xs text-muted-foreground">
								No faction mappings configured yet.
							</div>
						) : (
							currentPageItems.map((item) => {
								const isPending = item.type === "pending";
								const mapping = item.data;
								const idKey = isPending
									? (mapping as PendingMapping).tempId
									: (mapping as FactionMapping).id;
								const isExpanded = expandedMappingId === idKey;
								const isModified = !isPending && Boolean(pendingUpdates[idKey]);
								const isPendingDelete = !isPending && pendingDeletes.has(idKey);

								const memberRoles = isPending
									? (mapping as PendingMapping).memberRoleIds
									: (pendingUpdates[idKey]?.memberRoleIds ??
										(mapping as FactionMapping).memberRoleIds);
								const leaderRoles = isPending
									? (mapping as PendingMapping).leaderRoleIds
									: (pendingUpdates[idKey]?.leaderRoleIds ??
										(mapping as FactionMapping).leaderRoleIds);

								return (
									<div
										key={idKey}
										className={`p-4 rounded-xl border transition-all ${
											isPendingDelete
												? "bg-destructive/5 border-destructive/30 opacity-75"
												: isPending
													? "bg-amber-500/5 border-amber-500/30"
													: isModified
														? "bg-blue-500/5 border-blue-500/30"
														: "bg-background/60 border-border/80"
										}`}
									>
										<div className="flex items-center justify-between gap-4">
											<div className="flex items-center gap-3 min-w-0">
												{"tagImage" in mapping && mapping.tagImage ? (
													<img
														src={`https://factiontags.torn.com/${mapping.tagImage}`}
														alt={
															mapping.factionTag || String(mapping.factionId)
														}
														className="h-6 object-contain shrink-0"
													/>
												) : (
													<div className="size-8 rounded-lg bg-primary/10 border border-primary/20 text-primary flex items-center justify-center font-mono text-xs font-bold shrink-0">
														#{mapping.factionId}
													</div>
												)}

												<div className="min-w-0">
													<div className="flex items-center gap-2">
														<span className="font-semibold text-sm text-foreground truncate">
															{mapping.factionName
																? `${mapping.factionName} [${mapping.factionTag ?? mapping.factionId}]`
																: `Faction #${mapping.factionId}`}
														</span>
														{isPending && (
															<Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-[9px] font-mono uppercase">
																STAGED NEW
															</Badge>
														)}
														{isModified && (
															<Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30 text-[9px] font-mono uppercase">
																STAGED EDIT
															</Badge>
														)}
														{isPendingDelete && (
															<Badge className="bg-destructive/20 text-destructive border-destructive/30 text-[9px] font-mono uppercase">
																STAGED DELETE
															</Badge>
														)}
													</div>
													<span className="text-[11px] text-muted-foreground font-mono block">
														{memberRoles.length} member{" "}
														{memberRoles.length !== 1 ? "roles" : "role"} •{" "}
														{leaderRoles.length} leader{" "}
														{leaderRoles.length !== 1 ? "roles" : "role"}
													</span>
												</div>
											</div>

											<div className="flex items-center gap-2 shrink-0">
												{isModified && (
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => handleRevertMapping(idKey)}
														className="size-8 rounded-lg text-amber-500 hover:bg-amber-500/10 cursor-pointer"
														title="Revert staged edits"
													>
														<RotateCcw className="size-3.5" />
													</Button>
												)}

												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() =>
														setExpandedMappingId(isExpanded ? null : idKey)
													}
													className="h-8 px-2.5 text-xs rounded-lg cursor-pointer"
												>
													{isExpanded ? (
														<ChevronUp className="size-3.5" />
													) : (
														<ChevronDown className="size-3.5" />
													)}
												</Button>

												{!isPending && (
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => {
															if (pendingDeletes.has(idKey)) {
																setPendingDeletes((prev) => {
																	const next = new Set(prev);
																	next.delete(idKey);
																	return next;
																});
															} else {
																setPendingDeletes((prev) =>
																	new Set(prev).add(idKey),
																);
															}
														}}
														className={`size-8 rounded-lg cursor-pointer ${
															pendingDeletes.has(idKey)
																? "text-amber-500 hover:bg-amber-500/10"
																: "text-muted-foreground hover:text-destructive hover:bg-destructive/10"
														}`}
														title={
															pendingDeletes.has(idKey)
																? "Restore mapping"
																: "Stage for deletion"
														}
													>
														{pendingDeletes.has(idKey) ? (
															<RotateCcw className="size-3.5" />
														) : (
															<Trash2 className="size-3.5" />
														)}
													</Button>
												)}

												{isPending && (
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() =>
															setPendingAdds((prev) =>
																prev.filter((p) => p.tempId !== idKey),
															)
														}
														className="size-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
														title="Remove staged mapping"
													>
														<X className="size-3.5" />
													</Button>
												)}
											</div>
										</div>

										{/* Expanded Mapping Details & Inline Role Editors */}
										{isExpanded && (
											<div className="mt-4 pt-3 border-t border-border/40 space-y-4">
												{/* Member Roles Editor */}
												<div className="space-y-2">
													<span className="text-[10px] font-mono uppercase text-muted-foreground font-bold block">
														Member Roles
													</span>
													<div className="flex gap-2 items-center max-w-sm">
														{roles.length > 0 ? (
															<Select
																value={inlineMemberRoleInput[idKey] ?? ""}
																onValueChange={(val) =>
																	setInlineMemberRoleInput((prev) => ({
																		...prev,
																		[idKey]: val,
																	}))
																}
															>
																<SelectTrigger className="flex-1 h-8 rounded-lg bg-background border-input text-foreground text-xs font-sans">
																	<SelectValue placeholder="Add member role..." />
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
																type="text"
																value={inlineMemberRoleInput[idKey] ?? ""}
																onChange={(e) =>
																	setInlineMemberRoleInput((prev) => ({
																		...prev,
																		[idKey]: e.target.value,
																	}))
																}
																placeholder="Role ID"
																className="flex-1 font-mono text-xs h-8 rounded-lg"
															/>
														)}
														<Button
															type="button"
															variant="secondary"
															size="sm"
															disabled={!inlineMemberRoleInput[idKey]}
															onClick={() => {
																const rId = inlineMemberRoleInput[idKey];
																if (!rId) return;
																if (memberRoles.includes(rId)) return;
																handleUpdateItemRoles(
																	idKey,
																	isPending,
																	[...memberRoles, rId],
																	leaderRoles,
																);
																setInlineMemberRoleInput((prev) => ({
																	...prev,
																	[idKey]: "",
																}));
															}}
															className="h-8 px-2.5 text-xs font-semibold rounded-lg cursor-pointer shrink-0"
														>
															Add
														</Button>
													</div>
													<div className="flex flex-wrap gap-1.5">
														{memberRoles.length === 0 ? (
															<span className="text-xs text-muted-foreground italic">
																None
															</span>
														) : (
															memberRoles.map((rId: string) => {
																const rObj = roles.find((r) => r.id === rId);
																return (
																	<Badge
																		key={rId}
																		variant="outline"
																		className="text-[11px] font-mono px-2 py-0.5 rounded-lg flex items-center gap-1.5"
																	>
																		{rObj && (
																			<span
																				className="size-1.5 rounded-full shrink-0"
																				style={{
																					backgroundColor: roleColor(
																						rObj.color,
																					),
																				}}
																			/>
																		)}
																		<span>{rObj ? `@${rObj.name}` : rId}</span>
																		<button
																			type="button"
																			onClick={() =>
																				handleUpdateItemRoles(
																					idKey,
																					isPending,
																					memberRoles.filter((r) => r !== rId),
																					leaderRoles,
																				)
																			}
																			className="hover:text-destructive cursor-pointer ml-0.5"
																		>
																			<X className="size-3" />
																		</button>
																	</Badge>
																);
															})
														)}
													</div>
												</div>

												{/* Leader Roles Editor */}
												<div className="space-y-2">
													<span className="text-[10px] font-mono uppercase text-muted-foreground font-bold block">
														Leader Roles
													</span>
													<div className="flex gap-2 items-center max-w-sm">
														{roles.length > 0 ? (
															<Select
																value={inlineLeaderRoleInput[idKey] ?? ""}
																onValueChange={(val) =>
																	setInlineLeaderRoleInput((prev) => ({
																		...prev,
																		[idKey]: val,
																	}))
																}
															>
																<SelectTrigger className="flex-1 h-8 rounded-lg bg-background border-input text-foreground text-xs font-sans">
																	<SelectValue placeholder="Add leader role..." />
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
																type="text"
																value={inlineLeaderRoleInput[idKey] ?? ""}
																onChange={(e) =>
																	setInlineLeaderRoleInput((prev) => ({
																		...prev,
																		[idKey]: e.target.value,
																	}))
																}
																placeholder="Role ID"
																className="flex-1 font-mono text-xs h-8 rounded-lg"
															/>
														)}
														<Button
															type="button"
															variant="secondary"
															size="sm"
															disabled={!inlineLeaderRoleInput[idKey]}
															onClick={() => {
																const rId = inlineLeaderRoleInput[idKey];
																if (!rId) return;
																if (leaderRoles.includes(rId)) return;
																handleUpdateItemRoles(
																	idKey,
																	isPending,
																	memberRoles,
																	[...leaderRoles, rId],
																);
																setInlineLeaderRoleInput((prev) => ({
																	...prev,
																	[idKey]: "",
																}));
															}}
															className="h-8 px-2.5 text-xs font-semibold rounded-lg cursor-pointer shrink-0"
														>
															Add
														</Button>
													</div>
													<div className="flex flex-wrap gap-1.5">
														{leaderRoles.length === 0 ? (
															<span className="text-xs text-muted-foreground italic">
																None
															</span>
														) : (
															leaderRoles.map((rId: string) => {
																const rObj = roles.find((r) => r.id === rId);
																return (
																	<Badge
																		key={rId}
																		variant="outline"
																		className="text-[11px] font-mono px-2 py-0.5 rounded-lg flex items-center gap-1.5 border-purple-500/30 text-purple-300"
																	>
																		{rObj && (
																			<span
																				className="size-1.5 rounded-full shrink-0"
																				style={{
																					backgroundColor: roleColor(
																						rObj.color,
																					),
																				}}
																			/>
																		)}
																		<span>{rObj ? `@${rObj.name}` : rId}</span>
																		<button
																			type="button"
																			onClick={() =>
																				handleUpdateItemRoles(
																					idKey,
																					isPending,
																					memberRoles,
																					leaderRoles.filter((r) => r !== rId),
																				)
																			}
																			className="hover:text-destructive cursor-pointer ml-0.5"
																		>
																			<X className="size-3" />
																		</button>
																	</Badge>
																);
															})
														)}
													</div>
												</div>
											</div>
										)}
									</div>
								);
							})
						)}

						{/* Pagination Controls */}
						{totalPages > 1 && (
							<div className="flex items-center justify-between pt-2">
								<span className="text-[11px] font-mono text-muted-foreground">
									Page {currentPage} of {totalPages}
								</span>
								<div className="flex items-center gap-1">
									<Button
										type="button"
										variant="outline"
										size="icon"
										onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
										disabled={currentPage === 1}
										className="size-8 rounded-lg cursor-pointer"
									>
										<ChevronLeft className="size-3.5" />
									</Button>
									<Button
										type="button"
										variant="outline"
										size="icon"
										onClick={() =>
											setCurrentPage((p) => Math.min(totalPages, p + 1))
										}
										disabled={currentPage === totalPages}
										className="size-8 rounded-lg cursor-pointer"
									>
										<ChevronRight className="size-3.5" />
									</Button>
								</div>
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Footer Action Bar */}
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
						onClick={() => void handleSaveChanges()}
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
