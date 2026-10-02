import {
	AlertTriangle,
	CheckCircle2,
	Clock,
	Copy,
	ExternalLink,
	Filter,
	History,
	Loader2,
	Plus,
	Receipt,
	RefreshCw,
	ShieldAlert,
	Sliders,
	Swords,
	Trash2,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

export interface MercContractHitTerms {
	statuses: {
		online: boolean;
		idle: boolean;
		offline: boolean;
	};
	idleDurationMinutes: number | null;
	strickenHits: boolean;
	levelRange: [number, number];
}

export interface MercContract {
	id: string;
	guildId: string;
	factionId: number;
	factionName: string;
	warStatusAtCreation: "no_war" | "upcoming" | "active";
	warId?: number | null;
	warStart?: number | null;
	warEnd?: number | null;
	warTarget?: number | null;
	warOpponent?: {
		id: number;
		name: string;
	} | null;
	startTime: string;
	startImmediately?: boolean;
	startMinutesBeforeWar?: number | null;
	endTime: string | null;
	endOnWarEnd?: boolean;
	terms: MercContractHitTerms;
	hitPrice: number;
	strickenHitPrice?: number | null;
	changeTermsOnWarStart?: boolean;
	warStartTerms?: MercContractHitTerms | null;
	warStartHitPrice?: number | null;
	warStartStrickenHitPrice?: number | null;
	status: "active" | "upcoming" | "completed" | "cancelled";
	createdAt: string;
	updatedAt?: string | null;
	createdBy?: string | null;
}

interface ValidatedFactionData {
	id: number;
	name: string;
	tag: string | null;
	warStatus: "no_war" | "upcoming" | "active";
	war: {
		id: number;
		start: number;
		end: number | null;
		target: number;
		opponent: {
			id: number;
			name: string;
		} | null;
	} | null;
}

interface MercContractsPageProps {
	guildId: string;
}

const toTctDateTimeInput = (date: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

const parseTctInputToIso = (tctString: string): string => {
	if (tctString.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(tctString)) {
		return new Date(tctString).toISOString();
	}
	const parts = tctString.split(":");
	if (parts.length === 2) {
		return new Date(`${tctString}:00Z`).toISOString();
	}
	return new Date(`${tctString}Z`).toISOString();
};

export function formatTctDateTime(date: Date | string): string {
	const d = typeof date === "string" ? new Date(date) : date;
	if (Number.isNaN(d.getTime())) return String(date);
	const pad = (n: number) => n.toString().padStart(2, "0");
	const hours = pad(d.getUTCHours());
	const minutes = pad(d.getUTCMinutes());
	const seconds = pad(d.getUTCSeconds());
	const day = pad(d.getUTCDate());
	const month = pad(d.getUTCMonth() + 1);
	const year = d.getUTCFullYear();
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} TCT`;
}

export function MercContractsPage({ guildId }: MercContractsPageProps) {
	const { toast } = useToast();

	const [contracts, setContracts] = useState<MercContract[]>([]);
	const [loading, setLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [activeTab, setActiveTab] = useState<"current" | "past">("current");

	// Add Modal States
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isValidatingFaction, setIsValidatingFaction] = useState(false);
	const [createdContractResult, setCreatedContractResult] = useState<{
		id: string;
		factionName: string;
		receiptUrl: string;
	} | null>(null);

	// Form: Step 1 (Faction ID Validation)
	const [inputFactionId, setInputFactionId] = useState("");
	const [validatedFaction, setValidatedFaction] =
		useState<ValidatedFactionData | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);

	// Form: Step 2 Timing & War
	const [startImmediately, setStartImmediately] = useState(true);
	const [customStartTime, setCustomStartTime] = useState(() =>
		toTctDateTimeInput(new Date()),
	);
	const [startMinutesBeforeWar, setStartMinutesBeforeWar] = useState(30);
	const [endOnWarEnd, setEndOnWarEnd] = useState(true);
	const [customEndTime, setCustomEndTime] = useState(() => {
		const tomorrow = new Date();
		tomorrow.setHours(tomorrow.getHours() + 24);
		return toTctDateTimeInput(tomorrow);
	});

	// Form: Terms
	const [onlineStatus, setOnlineStatus] = useState(true);
	const [idleStatus, setIdleStatus] = useState(true);
	const [offlineStatus, setOfflineStatus] = useState(false);
	const [idleDuration, setIdleDuration] = useState<number>(15);
	const [strickenHits, setStrickenHits] = useState(false);
	const [levelRange, setLevelRange] = useState<[number, number]>([1, 100]);

	// Form: Terms on War Start (Upcoming War with startMinutesBeforeWar > 0)
	const [changeTermsOnWarStart, setChangeTermsOnWarStart] = useState(false);
	const [warStartOnline, setWarStartOnline] = useState(true);
	const [warStartIdle, setWarStartIdle] = useState(false);
	const [warStartOffline, setWarStartOffline] = useState(false);
	const [warStartIdleDuration, setWarStartIdleDuration] = useState<number>(15);
	const [warStartStricken, setWarStartStricken] = useState(false);
	const [warStartLevelRange, setWarStartLevelRange] = useState<
		[number, number]
	>([1, 100]);

	// Form: Hit Payouts
	const [hitPrice, setHitPrice] = useState<string>("3000000");
	const [strickenHitPrice, setStrickenHitPrice] = useState<string>("4000000");
	const [warStartHitPrice, setWarStartHitPrice] = useState<string>("3000000");
	const [warStartStrickenHitPrice, setWarStartStrickenHitPrice] =
		useState<string>("4000000");

	const fetchContracts = async () => {
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.merc.contracts.get();
			if (res.data && "contracts" in res.data) {
				setContracts((res.data.contracts as MercContract[]) ?? []);
			}
		} catch (err) {
			console.error("Failed to load contracts:", err);
			toast(
				err instanceof Error ? err.message : "Failed to load contracts.",
				"error",
			);
		} finally {
			setLoading(false);
			setIsRefreshing(false);
		}
	};

	useEffect(() => {
		fetchContracts();
	}, [guildId]);

	const handleRefresh = () => {
		setIsRefreshing(true);
		fetchContracts();
	};

	const resetModalForm = () => {
		setCreatedContractResult(null);
		setInputFactionId("");
		setValidatedFaction(null);
		setValidationError(null);
		setStartImmediately(true);
		setCustomStartTime(toTctDateTimeInput(new Date()));
		setStartMinutesBeforeWar(30);
		setEndOnWarEnd(true);
		const tomorrow = new Date();
		tomorrow.setHours(tomorrow.getHours() + 24);
		setCustomEndTime(toTctDateTimeInput(tomorrow));

		setOnlineStatus(true);
		setIdleStatus(true);
		setOfflineStatus(false);
		setIdleDuration(15);
		setStrickenHits(false);
		setLevelRange([1, 100]);

		setHitPrice("3000000");
		setStrickenHitPrice("4000000");
		setWarStartHitPrice("3000000");
		setWarStartStrickenHitPrice("4000000");

		setChangeTermsOnWarStart(false);
		setWarStartOnline(true);
		setWarStartIdle(false);
		setWarStartOffline(false);
		setWarStartIdleDuration(15);
		setWarStartStricken(false);
		setWarStartLevelRange([1, 100]);
	};

	const handleOpenModal = () => {
		resetModalForm();
		setIsModalOpen(true);
	};

	const handleValidateFaction = async () => {
		const fid = inputFactionId.trim();
		if (!fid || !/^\d+$/.test(fid)) {
			setValidationError("Please enter a valid numeric faction ID.");
			return;
		}

		setIsValidatingFaction(true);
		setValidationError(null);
		setValidatedFaction(null);

		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.merc.factions.validate.get({
				query: { factionId: fid },
			});

			if (res.error) {
				const errMsg =
					typeof res.error.value === "string"
						? res.error.value
						: ((res.error.value as { error?: string })?.error ??
							"Failed to validate faction.");
				setValidationError(errMsg);
				return;
			}

			const data = res.data;
			if (data && "valid" in data && data.valid && data.faction) {
				const validated: ValidatedFactionData = {
					id: data.faction.id,
					name: data.faction.name,
					tag: data.faction.tag ?? null,
					warStatus: data.warStatus as "no_war" | "upcoming" | "active",
					war: data.war
						? {
								id: data.war.id,
								start: data.war.start,
								end: data.war.end,
								target: data.war.target,
								opponent: data.war.opponent,
							}
						: null,
				};
				setValidatedFaction(validated);

				// Auto-adjust default state based on detected war
				if (validated.warStatus === "upcoming") {
					setEndOnWarEnd(true);
					setStartMinutesBeforeWar(30);
				} else if (validated.warStatus === "active") {
					setStartImmediately(true);
					setEndOnWarEnd(true);
				} else {
					setStartImmediately(true);
					setEndOnWarEnd(false);
				}
			} else {
				setValidationError(
					(data && "error" in data ? (data.error as string) : null) ??
						"Faction validation failed.",
				);
			}
		} catch (err) {
			setValidationError(
				err instanceof Error
					? err.message
					: "Network error validating faction.",
			);
		} finally {
			setIsValidatingFaction(false);
		}
	};

	const handleCreateContract = async () => {
		if (!validatedFaction) {
			toast("Please validate a faction first.", "error");
			return;
		}

		if (!onlineStatus && !idleStatus && !offlineStatus) {
			toast(
				"Please select at least one status (Online, Idle, or Offline).",
				"error",
			);
			return;
		}

		if (
			changeTermsOnWarStart &&
			!warStartOnline &&
			!warStartIdle &&
			!warStartOffline
		) {
			toast(
				"Please select at least one war-start status (Online, Idle, or Offline).",
				"error",
			);
			return;
		}

		setIsSubmitting(true);

		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			let finalStartTime: string;
			let calculatedMinutesBeforeWar: number | null = null;

			if (validatedFaction.warStatus === "upcoming") {
				calculatedMinutesBeforeWar = startMinutesBeforeWar;
				if (validatedFaction.war?.start) {
					const warStartMs = validatedFaction.war.start * 1000;
					const startMs = warStartMs - startMinutesBeforeWar * 60 * 1000;
					finalStartTime = new Date(startMs).toISOString();
				} else {
					finalStartTime = new Date().toISOString();
				}
			} else if (startImmediately) {
				finalStartTime = new Date().toISOString();
			} else {
				finalStartTime = parseTctInputToIso(customStartTime);
			}

			let finalEndTime: string | null = null;
			if (validatedFaction.warStatus === "no_war") {
				finalEndTime = parseTctInputToIso(customEndTime);
			} else if (endOnWarEnd) {
				if (validatedFaction.war?.end) {
					finalEndTime = new Date(
						validatedFaction.war.end * 1000,
					).toISOString();
				} else {
					finalEndTime = null; // Open ended until ranked war finishes
				}
			} else {
				finalEndTime = parseTctInputToIso(customEndTime);
			}

			const payload = {
				factionId: validatedFaction.id,
				factionName: validatedFaction.name,
				warStatusAtCreation: validatedFaction.warStatus,
				warId: validatedFaction.war?.id ?? null,
				warStart: validatedFaction.war?.start ?? null,
				warEnd: validatedFaction.war?.end ?? null,
				warTarget: validatedFaction.war?.target ?? null,
				warOpponent: validatedFaction.war?.opponent ?? null,
				startTime: finalStartTime,
				startImmediately:
					validatedFaction.warStatus !== "upcoming" && startImmediately,
				startMinutesBeforeWar: calculatedMinutesBeforeWar,
				endTime: finalEndTime,
				endOnWarEnd:
					validatedFaction.warStatus !== "no_war" ? endOnWarEnd : false,
				terms: {
					statuses: {
						online: onlineStatus,
						idle: idleStatus,
						offline: offlineStatus,
					},
					idleDurationMinutes: idleStatus ? idleDuration : null,
					strickenHits,
					levelRange,
				},
				hitPrice: Math.max(0, Number(hitPrice) || 0),
				strickenHitPrice: strickenHits
					? Math.max(0, Number(strickenHitPrice) || 0)
					: null,
				changeTermsOnWarStart:
					validatedFaction.warStatus === "upcoming" &&
					startMinutesBeforeWar > 0 &&
					changeTermsOnWarStart,
				warStartTerms:
					validatedFaction.warStatus === "upcoming" &&
					startMinutesBeforeWar > 0 &&
					changeTermsOnWarStart
						? {
								statuses: {
									online: warStartOnline,
									idle: warStartIdle,
									offline: warStartOffline,
								},
								idleDurationMinutes: warStartIdle ? warStartIdleDuration : null,
								strickenHits: warStartStricken,
								levelRange: warStartLevelRange,
							}
						: null,
				warStartHitPrice:
					validatedFaction.warStatus === "upcoming" &&
					startMinutesBeforeWar > 0 &&
					changeTermsOnWarStart
						? Math.max(0, Number(warStartHitPrice) || 0)
						: null,
				warStartStrickenHitPrice:
					validatedFaction.warStatus === "upcoming" &&
					startMinutesBeforeWar > 0 &&
					changeTermsOnWarStart &&
					warStartStricken
						? Math.max(0, Number(warStartStrickenHitPrice) || 0)
						: null,
			};

			const res = await guildRoute.merc.contracts.post(payload as never);

			if (res.error) {
				const errMsg =
					typeof res.error.value === "string"
						? res.error.value
						: "Failed to create contract.";
				toast(errMsg, "error");
				return;
			}

			const createdContract =
				res.data && "contract" in res.data
					? (res.data.contract as MercContract)
					: null;
			const newContractId = createdContract?.id ?? "";
			const receiptUrl =
				(res.data &&
				"receiptUrl" in res.data &&
				typeof res.data.receiptUrl === "string"
					? res.data.receiptUrl
					: null) ||
				(typeof window !== "undefined" && window.location?.origin
					? `${window.location.origin}/#/merc/receipt/${newContractId}`
					: `/#/merc/receipt/${newContractId}`);

			setCreatedContractResult({
				id: newContractId,
				factionName: validatedFaction.name,
				receiptUrl,
			});

			toast(
				`Contract for ${validatedFaction.name} created successfully.`,
				"success",
			);
			fetchContracts();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Failed to create contract.",
				"error",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleEndContract = async (contractId: string) => {
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.merc.contracts({ contractId }).put({
				status: "completed",
			});

			if (res.error) {
				toast("Failed to end contract.", "error");
				return;
			}

			toast("Contract ended. Results summary sent to Merc Log.", "success");
			fetchContracts();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Error ending contract.",
				"error",
			);
		}
	};

	const handleCancelContract = async (contractId: string) => {
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.merc.contracts({ contractId }).put({
				status: "cancelled",
			});

			if (res.error) {
				toast("Failed to cancel contract.", "error");
				return;
			}

			toast("Contract cancelled.", "success");
			fetchContracts();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Error cancelling contract.",
				"error",
			);
		}
	};

	const handleDeleteContract = async (contractId: string) => {
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.merc.contracts({ contractId }).delete();
			if (res.error) {
				toast("Failed to delete contract.", "error");
				return;
			}

			toast("Contract removed.", "success");
			fetchContracts();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Error deleting contract.",
				"error",
			);
		}
	};

	const currentContracts = contracts.filter(
		(c) => c.status === "active" || c.status === "upcoming",
	);
	const pastContracts = contracts.filter(
		(c) => c.status === "completed" || c.status === "cancelled",
	);

	const displayedContracts =
		activeTab === "current" ? currentContracts : pastContracts;

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex justify-between items-center pb-6 border-b border-border/60">
					<Skeleton className="h-8 w-48" />
					<Skeleton className="h-10 w-36 rounded-xl" />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<Skeleton className="h-24 rounded-2xl" />
					<Skeleton className="h-24 rounded-2xl" />
					<Skeleton className="h-24 rounded-2xl" />
				</div>
				<Skeleton className="h-96 w-full rounded-2xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 pb-16 max-w-5xl">
			{/* Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-border/60">
				<div className="flex items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						onClick={handleRefresh}
						disabled={isRefreshing}
						className="rounded-xl h-9 text-xs cursor-pointer border-border/80"
					>
						<RefreshCw
							className={`size-3.5 mr-1.5 ${isRefreshing ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>
					<Button
						onClick={handleOpenModal}
						size="sm"
						className="rounded-xl h-9 text-xs font-semibold shadow-xs cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
					>
						<Plus className="size-4 mr-1.5" />
						Add New Contract
					</Button>
				</div>
			</div>

			{/* Stat Highlights */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<Card className="rounded-2xl border-border/80 bg-card/70 backdrop-blur-md">
					<CardContent className="p-5 flex items-center justify-between">
						<div>
							<p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
								Active Contracts
							</p>
							<p className="text-2xl font-bold font-mono text-emerald-400 mt-1">
								{contracts.filter((c) => c.status === "active").length}
							</p>
						</div>
						<div className="size-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
							<CheckCircle2 className="size-5" />
						</div>
					</CardContent>
				</Card>

				<Card className="rounded-2xl border-border/80 bg-card/70 backdrop-blur-md">
					<CardContent className="p-5 flex items-center justify-between">
						<div>
							<p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
								Upcoming Contracts
							</p>
							<p className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1">
								{contracts.filter((c) => c.status === "upcoming").length}
							</p>
						</div>
						<div className="size-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600 dark:text-amber-400">
							<Clock className="size-5" />
						</div>
					</CardContent>
				</Card>

				<Card className="rounded-2xl border-border/80 bg-card/70 backdrop-blur-md">
					<CardContent className="p-5 flex items-center justify-between">
						<div>
							<p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
								Past / Completed
							</p>
							<p className="text-2xl font-bold font-mono text-muted-foreground mt-1">
								{
									contracts.filter(
										(c) => c.status === "completed" || c.status === "cancelled",
									).length
								}
							</p>
						</div>
						<div className="size-10 rounded-xl bg-muted border border-border/60 flex items-center justify-center text-muted-foreground">
							<History className="size-5" />
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Views / Tabs */}
			<div className="space-y-4">
				<Tabs
					value={activeTab}
					onValueChange={(v) => setActiveTab(v as "current" | "past")}
					className="w-full"
				>
					<div className="flex items-center justify-between">
						<TabsList className="bg-muted/60 p-1 rounded-xl border border-border/60">
							<TabsTrigger
								value="current"
								className="rounded-lg text-xs font-medium cursor-pointer"
							>
								Current Contracts ({currentContracts.length})
							</TabsTrigger>
							<TabsTrigger
								value="past"
								className="rounded-lg text-xs font-medium cursor-pointer"
							>
								Past Contracts ({pastContracts.length})
							</TabsTrigger>
						</TabsList>
					</div>
				</Tabs>

				{/* Contracts List */}
				{displayedContracts.length === 0 ? (
					<Card className="rounded-2xl border-border/80 bg-card/50 border-dashed p-12 text-center">
						<CardContent className="flex flex-col items-center justify-center gap-3 p-0">
							<div className="size-12 rounded-2xl bg-muted/60 flex items-center justify-center text-muted-foreground">
								<Filter className="size-6" />
							</div>
							<h3 className="text-sm font-semibold text-foreground">
								No {activeTab === "current" ? "active or upcoming" : "past"}{" "}
								contracts
							</h3>
							<p className="text-xs text-muted-foreground max-w-sm">
								{activeTab === "current"
									? "Create a new contract to define hit filters, level ranges, and automated war start triggers."
									: "Past and cancelled contracts will appear here for archival history."}
							</p>
							{activeTab === "current" && (
								<Button
									size="sm"
									onClick={handleOpenModal}
									className="mt-2 rounded-xl text-xs font-semibold cursor-pointer"
								>
									<Plus className="size-3.5 mr-1.5" />
									Create Contract
								</Button>
							)}
						</CardContent>
					</Card>
				) : (
					<div className="space-y-4">
						{displayedContracts.map((contract) => {
							const isActive = contract.status === "active";
							const isUpcoming = contract.status === "upcoming";

							return (
								<Card
									key={contract.id}
									className="rounded-2xl border-border/80 bg-card/80 backdrop-blur-md overflow-hidden transition-all duration-150 hover:border-border"
								>
									<CardHeader className="p-5 pb-4 border-b border-border/40 flex flex-row items-center justify-between">
										<div className="flex items-center gap-3 flex-wrap">
											<div className="flex items-center gap-2">
												<CardTitle className="text-base font-bold text-foreground font-sans">
													{contract.factionName}
												</CardTitle>
												<a
													href={`https://www.torn.com/factions.php?step=profile&ID=${contract.factionId}`}
													target="_blank"
													rel="noreferrer"
													className="text-[11px] font-mono text-muted-foreground hover:text-primary inline-flex items-center gap-1"
												>
													[{contract.factionId}]
													<ExternalLink className="size-3" />
												</a>
											</div>
										</div>

										{/* Top Actions */}
										<div className="flex items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												asChild
												className="h-8 px-2.5 text-xs font-semibold border-border/80 hover:bg-muted cursor-pointer"
												title="Open Live Receipt Viewer"
											>
												<a
													href={`/#/merc/receipt/${contract.id}`}
													target="_blank"
													rel="noreferrer"
													className="inline-flex items-center gap-1.5 text-foreground"
												>
													<Receipt className="size-3.5 text-primary" />
													<span>Receipt</span>
													<ExternalLink className="size-3 text-muted-foreground" />
												</a>
											</Button>
											<Button
												variant="ghost"
												size="icon"
												onClick={() => {
													const receiptUrl = `${window.location.origin}/#/merc/receipt/${contract.id}`;
													navigator.clipboard.writeText(receiptUrl);
													toast("Receipt link copied to clipboard!", "success");
												}}
												className="size-8 text-muted-foreground hover:text-foreground cursor-pointer"
												title="Copy Receipt Link"
											>
												<Copy className="size-3.5" />
											</Button>
											{isActive && (
												<Button
													variant="outline"
													size="sm"
													onClick={() => handleEndContract(contract.id)}
													className="h-8 px-2.5 text-xs font-semibold text-rose-400 border-rose-500/30 hover:bg-rose-500/10 cursor-pointer"
													title="End Contract & Finalize Results"
												>
													End Contract
												</Button>
											)}
											{isUpcoming && (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => handleCancelContract(contract.id)}
													className="h-8 px-2.5 text-xs text-muted-foreground hover:text-rose-400 cursor-pointer"
													title="Cancel Contract"
												>
													<XCircle className="size-3.5 mr-1" />
													Cancel
												</Button>
											)}
											<Button
												variant="ghost"
												size="icon"
												onClick={() => handleDeleteContract(contract.id)}
												className="size-8 text-muted-foreground hover:text-destructive cursor-pointer"
												title="Delete Record"
											>
												<Trash2 className="size-3.5" />
											</Button>
										</div>
									</CardHeader>

									<CardContent className=" space-y-4">
										{/* Timing Summary */}
										<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-muted/20 p-3.5 rounded-xl border border-border/40">
											<div>
												<span className="text-[10px] font-mono uppercase text-muted-foreground block">
													Start Timing
												</span>
												<span className="font-medium text-foreground mt-0.5 block">
													{contract.startMinutesBeforeWar !== null &&
													contract.startMinutesBeforeWar !== undefined
														? contract.startMinutesBeforeWar === 0
															? "Starts when war starts"
															: `Starts ${contract.startMinutesBeforeWar} mins before war`
														: contract.startImmediately
															? "Started immediately"
															: formatTctDateTime(contract.startTime)}
												</span>
											</div>

											<div>
												<span className="text-[10px] font-mono uppercase text-muted-foreground block">
													End Timing
												</span>
												<span className="font-medium text-foreground mt-0.5 block">
													{contract.endOnWarEnd
														? "Ends when war finishes"
														: contract.endTime
															? formatTctDateTime(contract.endTime)
															: "No expiration set"}
												</span>
											</div>
										</div>

										{/* Terms Overview */}
										<div className="space-y-3">
											<div>
												<div className="text-[10px] font-mono uppercase text-muted-foreground mb-1.5 flex items-center justify-between">
													<span>
														{contract.changeTermsOnWarStart
															? "Pre-War Terms"
															: "Contract Terms"}
													</span>
													<span className="text-muted-foreground/80 font-normal">
														Levels {contract.terms.levelRange[0]}–
														{contract.terms.levelRange[1]}
													</span>
												</div>

												<div className="flex flex-wrap items-center gap-2">
													{contract.terms.statuses.online && (
														<Badge
															variant="secondary"
															className="text-[11px] font-mono px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
														>
															Online
														</Badge>
													)}
													{contract.terms.statuses.idle && (
														<Badge
															variant="secondary"
															className="text-[11px] font-mono px-2 py-0.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30"
														>
															Idle ≤ {contract.terms.idleDurationMinutes ?? 15}m
														</Badge>
													)}
													{contract.terms.statuses.offline && (
														<Badge
															variant="secondary"
															className="text-[11px] font-mono px-2 py-0.5 bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
														>
															Offline
														</Badge>
													)}
													{contract.terms.strickenHits && (
														<Badge
															variant="secondary"
															className="text-[11px] font-mono px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20"
														>
															Stricken Hits
														</Badge>
													)}
												</div>
											</div>

											{/* Secondary Terms on War Start (if configured) */}
											{contract.changeTermsOnWarStart &&
												contract.warStartTerms && (
													<div className="pt-2 border-t border-border/40">
														<div className="text-[10px] font-mono uppercase text-amber-700 dark:text-amber-300 mb-1.5 flex items-center justify-between font-semibold">
															<span>War-Start Terms</span>
															<span className="text-muted-foreground font-normal">
																Levels {contract.warStartTerms.levelRange[0]}–
																{contract.warStartTerms.levelRange[1]}
															</span>
														</div>

														<div className="flex flex-wrap items-center gap-2">
															{contract.warStartTerms.statuses.online && (
																<Badge
																	variant="secondary"
																	className="text-[11px] font-mono px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
																>
																	Online
																</Badge>
															)}
															{contract.warStartTerms.statuses.idle && (
																<Badge
																	variant="secondary"
																	className="text-[11px] font-mono px-2 py-0.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30"
																>
																	Idle ≤{" "}
																	{contract.warStartTerms.idleDurationMinutes ??
																		15}
																	m
																</Badge>
															)}
															{contract.warStartTerms.statuses.offline && (
																<Badge
																	variant="secondary"
																	className="text-[11px] font-mono px-2 py-0.5 bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
																>
																	Offline
																</Badge>
															)}
															{contract.warStartTerms.strickenHits && (
																<Badge
																	variant="secondary"
																	className="text-[11px] font-mono px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20"
																>
																	Stricken Hits
																</Badge>
															)}
														</div>
													</div>
												)}
										</div>

										{/* Payout Details */}
										<div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/40">
											<Badge
												variant="outline"
												className="text-[11px] font-mono px-2 py-0.5 border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
											>
												${contract.hitPrice.toLocaleString()} / hit
											</Badge>
											{contract.strickenHitPrice && (
												<Badge
													variant="outline"
													className="text-[11px] font-mono px-2 py-0.5 border-blue-500/30 text-blue-400 bg-blue-500/10"
												>
													${contract.strickenHitPrice.toLocaleString()} /
													Stricken
												</Badge>
											)}
										</div>

										<div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground/70 font-mono pt-1">
											<div>
												Created: {new Date(contract.createdAt).toLocaleString()}
												{contract.createdBy && ` by ${contract.createdBy}`}
											</div>
											<div className="flex items-center gap-2">
												<span>ID: {contract.id}</span>
												<span>•</span>
												<a
													href={`/#/merc/receipt/${contract.id}`}
													target="_blank"
													rel="noreferrer"
													className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
												>
													<Receipt className="size-3" />
													Receipt Viewer
													<ExternalLink className="size-2.5" />
												</a>
											</div>
										</div>
									</CardContent>
								</Card>
							);
						})}
					</div>
				)}
			</div>

			{/* Add New Contract Dialog */}
			<Dialog
				open={isModalOpen}
				onOpenChange={(open) => {
					setIsModalOpen(open);
					if (!open) {
						setCreatedContractResult(null);
					}
				}}
			>
				<DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-card border-border/80">
					<DialogHeader>
						<DialogTitle className="text-lg font-bold flex items-center gap-2 text-foreground">
							{createdContractResult
								? "Mercenary Contract Created"
								: "Create Mercenary Contract"}
						</DialogTitle>
					</DialogHeader>

					{createdContractResult ? (
						<div className="space-y-5 py-3">
							<div className="size-14 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto border border-emerald-500/20">
								<CheckCircle2 className="size-7" />
							</div>
							<div className="text-center space-y-1">
								<h2 className="text-lg font-bold tracking-tight text-foreground">
									Contract Created Successfully!
								</h2>
								<p className="text-xs text-muted-foreground">
									Mercenary contract for{" "}
									<span className="text-foreground font-semibold">
										{createdContractResult.factionName}
									</span>{" "}
									is now registered and active.
								</p>
							</div>

							<div className="p-3.5 rounded-xl bg-muted/30 border border-border/80 space-y-2 font-mono text-xs">
								<div className="flex items-center justify-between text-muted-foreground">
									<span>CONTRACT ID</span>
									<span className="text-foreground font-bold">
										{createdContractResult.id}
									</span>
								</div>
								<div className="flex items-center justify-between text-muted-foreground">
									<span>TARGET FACTION</span>
									<span className="text-foreground">
										{createdContractResult.factionName}
									</span>
								</div>
							</div>

							{/* Permanent Receipt Viewer Link */}
							<div className="space-y-2.5 p-3.5 rounded-xl bg-muted/20 border border-border/60">
								<div className="text-xs font-semibold text-foreground uppercase tracking-wider block font-mono">
									Permanent Live Receipt Viewer
								</div>
								<p className="text-xs text-muted-foreground">
									Share this link with your client or faction leadership to
									track hits, targets hit, and live costs:
								</p>
								<div className="flex items-center gap-2">
									<Input
										readOnly
										value={createdContractResult.receiptUrl}
										className="font-mono text-xs h-10 bg-background"
									/>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											navigator.clipboard.writeText(
												createdContractResult.receiptUrl,
											);
											toast("Receipt link copied to clipboard!", "success");
										}}
										className="h-10 px-3 cursor-pointer shrink-0"
										title="Copy Receipt Link"
									>
										<Copy className="size-4" />
									</Button>
								</div>
							</div>

							<div className="flex flex-col sm:flex-row gap-2.5 pt-2">
								<Button
									type="button"
									className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 cursor-pointer"
									onClick={() => {
										window.open(createdContractResult.receiptUrl, "_blank");
									}}
								>
									<ExternalLink className="size-4" />
									Open Live Receipt Viewer
								</Button>
								<Button
									type="button"
									variant="outline"
									className="h-10 rounded-xl px-5 text-xs font-semibold cursor-pointer"
									onClick={() => {
										setIsModalOpen(false);
										setCreatedContractResult(null);
									}}
								>
									Done
								</Button>
							</div>
						</div>
					) : (
						<>
							<div className="space-y-6 py-2">
								{/* STEP 1: Faction ID Input & Validation */}
								<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
									<label
										htmlFor="faction-id-input"
										className="text-xs font-semibold text-foreground block uppercase font-mono tracking-wider"
									>
										1. Faction ID
									</label>

									<div className="flex items-center gap-2.5">
										<Input
											id="faction-id-input"
											placeholder="e.g. 27312"
											value={inputFactionId}
											onChange={(e) => {
												setInputFactionId(e.target.value);
												if (validatedFaction) {
													setValidatedFaction(null);
												}
												if (validationError) {
													setValidationError(null);
												}
											}}
											className="rounded-xl h-10 font-mono text-sm bg-background"
										/>
										<Button
											type="button"
											onClick={handleValidateFaction}
											disabled={isValidatingFaction || !inputFactionId.trim()}
											className="rounded-xl h-10 px-5 text-xs font-semibold shrink-0 cursor-pointer"
										>
											{isValidatingFaction ? (
												<>
													<Loader2 className="size-3.5 animate-spin mr-1.5" />
													Validating...
												</>
											) : (
												"Validate"
											)}
										</Button>
									</div>

									{validationError && (
										<div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
											<AlertTriangle className="size-4 shrink-0" />
											<span>{validationError}</span>
										</div>
									)}

									{validatedFaction && (
										<div className="p-3.5 rounded-xl bg-background border border-border space-y-2">
											<div className="flex items-center justify-between">
												<div className="flex items-center gap-2">
													<CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
													<span className="text-sm font-bold text-foreground">
														{validatedFaction.name}
													</span>
												</div>

												{validatedFaction.warStatus === "active" ? (
													<Badge
														variant="outline"
														className="bg-rose-500/10 text-rose-400 border-rose-500/30 text-[10px] font-mono font-semibold"
													>
														<span className="size-1.5 rounded-full bg-rose-400 animate-pulse mr-1" />
														Active War Detected
													</Badge>
												) : validatedFaction.warStatus === "upcoming" ? (
													<Badge
														variant="outline"
														className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 text-[10px] font-mono font-semibold"
													>
														Upcoming War Detected
													</Badge>
												) : (
													<Badge
														variant="outline"
														className="text-[10px] font-mono text-muted-foreground"
													>
														No War Detected
													</Badge>
												)}
											</div>

											{validatedFaction.war && (
												<div className="text-xs text-muted-foreground pt-1 border-t border-border/40 flex flex-wrap items-center gap-x-4 gap-y-1">
													{validatedFaction.war.opponent && (
														<span>
															Opponent:{" "}
															<strong className="text-foreground">
																{validatedFaction.war.opponent.name}
															</strong>{" "}
															[{validatedFaction.war.opponent.id}]
														</span>
													)}
													{validatedFaction.war.start && (
														<span>
															War Start:{" "}
															<strong className="text-foreground">
																{formatTctDateTime(
																	new Date(validatedFaction.war.start * 1000),
																)}
															</strong>
														</span>
													)}
												</div>
											)}
										</div>
									)}
								</div>

								{/* STEP 2: Timing & Terms (Disabled until Faction is Validated) */}
								<div
									className={`space-y-6 transition-all duration-200 ${
										!validatedFaction
											? "opacity-40 pointer-events-none select-none grayscale"
											: ""
									}`}
								>
									{/* War Detection Notice Banner */}
									{validatedFaction && (
										<div
											className={`p-4 rounded-xl border text-xs flex items-start gap-3 ${
												validatedFaction.warStatus === "active"
													? "bg-rose-500/10 border-rose-500/30 text-rose-900 dark:text-rose-200"
													: validatedFaction.warStatus === "upcoming"
														? "bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-200"
														: "bg-blue-500/10 border-blue-500/30 text-blue-900 dark:text-blue-200"
											}`}
										>
											{validatedFaction.warStatus === "active" ? (
												<Swords className="size-5 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
											) : validatedFaction.warStatus === "upcoming" ? (
												<Clock className="size-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
											) : (
												<ShieldAlert className="size-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
											)}
											<div>
												<h4 className="font-semibold text-sm">
													{validatedFaction.warStatus === "active"
														? "Active Ranked War Detected"
														: validatedFaction.warStatus === "upcoming"
															? "Upcoming Ranked War Detected"
															: "Standard Contract (No Wars Detected)"}
												</h4>
												<p className="text-xs opacity-90 mt-0.5">
													{validatedFaction.warStatus === "active"
														? "War is live! You can start the contract immediately and link expiration to war conclusion."
														: validatedFaction.warStatus === "upcoming"
															? "Upcoming war found. Use the slider below to trigger contract start relative to war time."
															: "Configure standard contract timeframe and target filtering rules."}
												</p>
											</div>
										</div>
									)}

									{/* Timing Configuration Section */}
									<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-4">
										<h3 className="text-xs font-semibold uppercase font-mono tracking-wider text-foreground">
											2. Contract Duration & Timing (TCT / UTC)
										</h3>

										{/* Case A: UPCOMING WAR */}
										{validatedFaction?.warStatus === "upcoming" && (
											<div className="space-y-4">
												<div>
													<div className="flex items-center justify-between text-xs mb-2">
														<label
															htmlFor="start-time-slider"
															className="font-semibold text-foreground"
														>
															Start Time Relative to War Start
														</label>
														<span className="font-mono text-amber-600 dark:text-amber-400 font-bold">
															{startMinutesBeforeWar === 0
																? "At War Start (0 min)"
																: `${startMinutesBeforeWar} minutes before war`}
														</span>
													</div>
													<Slider
														id="start-time-slider"
														min={0}
														max={60}
														step={5}
														value={[startMinutesBeforeWar]}
														onValueChange={(val) => {
															const v = val[0] ?? 0;
															setStartMinutesBeforeWar(v);
															if (v === 0) {
																setChangeTermsOnWarStart(false);
															}
														}}
														className="py-2"
													/>
													<div className="flex justify-between text-[10px] font-mono text-muted-foreground mt-1">
														<span>0 min (War Start)</span>
														<span>30 mins before</span>
														<span>60 mins before</span>
													</div>
												</div>

												<div className="space-y-2 pt-2 border-t border-border/40">
													<div className="flex items-center gap-2">
														<Checkbox
															id="upcoming-end-war"
															checked={endOnWarEnd}
															onCheckedChange={(checked) =>
																setEndOnWarEnd(Boolean(checked))
															}
														/>
														<label
															htmlFor="upcoming-end-war"
															className="text-xs font-medium text-foreground cursor-pointer"
														>
															End contract on war end (Recommended)
														</label>
													</div>

													{!endOnWarEnd && (
														<div className="pt-2">
															<label
																htmlFor="upcoming-custom-end"
																className="text-xs text-muted-foreground block mb-1"
															>
																Custom End Time (TCT)
															</label>
															<Input
																id="upcoming-custom-end"
																type="datetime-local"
																value={customEndTime}
																onChange={(e) =>
																	setCustomEndTime(e.target.value)
																}
																className="h-9 text-xs rounded-xl"
															/>
														</div>
													)}
												</div>
											</div>
										)}

										{/* Case B: ACTIVE WAR */}
										{validatedFaction?.warStatus === "active" && (
											<div className="space-y-4">
												<div className="space-y-2">
													<div className="flex items-center gap-2">
														<Checkbox
															id="active-start-imm"
															checked={startImmediately}
															onCheckedChange={(c) =>
																setStartImmediately(Boolean(c))
															}
														/>
														<label
															htmlFor="active-start-imm"
															className="text-xs font-medium text-foreground cursor-pointer"
														>
															Start immediately
														</label>
													</div>

													{!startImmediately && (
														<div className="pt-1">
															<label
																htmlFor="active-custom-start"
																className="text-xs text-muted-foreground block mb-1"
															>
																Start Time (TCT)
															</label>
															<Input
																id="active-custom-start"
																type="datetime-local"
																value={customStartTime}
																onChange={(e) =>
																	setCustomStartTime(e.target.value)
																}
																className="h-9 text-xs rounded-xl"
															/>
														</div>
													)}
												</div>

												<div className="space-y-2 pt-2 border-t border-border/40">
													<div className="flex items-center gap-2">
														<Checkbox
															id="active-end-war"
															checked={endOnWarEnd}
															onCheckedChange={(c) =>
																setEndOnWarEnd(Boolean(c))
															}
														/>
														<label
															htmlFor="active-end-war"
															className="text-xs font-medium text-foreground cursor-pointer"
														>
															End contract on war end
														</label>
													</div>

													{!endOnWarEnd && (
														<div className="pt-1">
															<label
																htmlFor="active-custom-end"
																className="text-xs text-muted-foreground block mb-1"
															>
																End Time (TCT)
															</label>
															<Input
																id="active-custom-end"
																type="datetime-local"
																value={customEndTime}
																onChange={(e) =>
																	setCustomEndTime(e.target.value)
																}
																className="h-9 text-xs rounded-xl"
															/>
														</div>
													)}
												</div>
											</div>
										)}

										{/* Case C: NO WAR */}
										{validatedFaction?.warStatus === "no_war" && (
											<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
												<div className="space-y-2">
													<div className="flex items-center gap-2 mb-1">
														<Checkbox
															id="nowar-start-imm"
															checked={startImmediately}
															onCheckedChange={(c) =>
																setStartImmediately(Boolean(c))
															}
														/>
														<label
															htmlFor="nowar-start-imm"
															className="text-xs font-medium text-foreground cursor-pointer"
														>
															Start immediately
														</label>
													</div>

													{!startImmediately && (
														<div>
															<label
																htmlFor="nowar-custom-start"
																className="text-xs text-muted-foreground block mb-1"
															>
																Start Time (TCT)
															</label>
															<Input
																id="nowar-custom-start"
																type="datetime-local"
																value={customStartTime}
																onChange={(e) =>
																	setCustomStartTime(e.target.value)
																}
																className="h-9 text-xs rounded-xl"
															/>
														</div>
													)}
												</div>

												<div className="space-y-2">
													<label
														htmlFor="nowar-custom-end"
														className="text-xs text-muted-foreground block mb-1"
													>
														End Time (TCT)
													</label>
													<Input
														id="nowar-custom-end"
														type="datetime-local"
														value={customEndTime}
														onChange={(e) => setCustomEndTime(e.target.value)}
														className="h-9 text-xs rounded-xl"
													/>
												</div>
											</div>
										)}
									</div>

									{/* Primary Target Filtering Terms */}
									<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-4">
										<div className="flex items-center justify-between">
											<h3 className="text-xs font-semibold uppercase font-mono tracking-wider text-foreground">
												3. Target Hit Terms{" "}
												{validatedFaction?.warStatus === "upcoming" &&
												startMinutesBeforeWar > 0
													? "(Pre-War)"
													: ""}
											</h3>
										</div>

										{/* Status Checkboxes */}
										<div className="space-y-3">
											<span className="text-xs font-medium text-foreground block">
												Allowed Target Statuses:
											</span>
											<div className="flex flex-wrap items-center gap-6">
												<div className="flex items-center gap-2">
													<Checkbox
														id="term-online"
														checked={onlineStatus}
														onCheckedChange={(c) => setOnlineStatus(Boolean(c))}
													/>
													<label
														htmlFor="term-online"
														className="text-xs text-foreground cursor-pointer font-medium"
													>
														Online
													</label>
												</div>

												<div className="flex items-center gap-2">
													<Checkbox
														id="term-idle"
														checked={idleStatus}
														onCheckedChange={(c) => setIdleStatus(Boolean(c))}
													/>
													<label
														htmlFor="term-idle"
														className="text-xs text-foreground cursor-pointer font-medium"
													>
														Idle
													</label>
												</div>

												<div className="flex items-center gap-2">
													<Checkbox
														id="term-offline"
														checked={offlineStatus}
														onCheckedChange={(c) =>
															setOfflineStatus(Boolean(c))
														}
													/>
													<label
														htmlFor="term-offline"
														className="text-xs text-foreground cursor-pointer font-medium"
													>
														Offline
													</label>
												</div>
											</div>

											{/* Idle Minutes Input */}
											{idleStatus && (
												<div className="pt-2 max-w-xs">
													<label
														htmlFor="term-idle-minutes"
														className="text-xs text-muted-foreground block mb-1"
													>
														Max Idle Duration (minutes)
													</label>
													<Input
														id="term-idle-minutes"
														type="number"
														min={1}
														max={1440}
														value={idleDuration}
														onChange={(e) => {
															const next = Number(e.target.value) || 15;
															setIdleDuration(next);
														}}
														className="h-9 text-xs rounded-xl font-mono"
														placeholder="15"
													/>
												</div>
											)}
										</div>

										{/* Stricken Hits Checkbox */}
										<div className="pt-2 border-t border-border/40">
											<div className="flex items-center gap-2">
												<Checkbox
													id="term-stricken"
													checked={strickenHits}
													onCheckedChange={(c) => setStrickenHits(Boolean(c))}
												/>
												<label
													htmlFor="term-stricken"
													className="text-xs text-foreground cursor-pointer font-medium"
												>
													Stricken hits
												</label>
											</div>
										</div>

										{/* Hit Payout Values */}
										<div className="pt-3 border-t border-border/40 grid grid-cols-1 sm:grid-cols-2 gap-4">
											<div>
												<label
													htmlFor="term-hit-price"
													className="text-xs font-semibold text-foreground block mb-1"
												>
													Value of 1 hit ($)
												</label>
												<Input
													id="term-hit-price"
													type="number"
													min={0}
													step={1000}
													value={hitPrice}
													onChange={(e) => setHitPrice(e.target.value)}
													className="h-9 text-xs rounded-xl font-mono"
													placeholder="3000000"
												/>
											</div>

											{strickenHits && (
												<div>
													<label
														htmlFor="term-stricken-price"
														className="text-xs font-semibold text-blue-400 block mb-1"
													>
														Value of Stricken hit ($)
													</label>
													<Input
														id="term-stricken-price"
														type="number"
														min={0}
														step={1000}
														value={strickenHitPrice}
														onChange={(e) =>
															setStrickenHitPrice(e.target.value)
														}
														className="h-9 text-xs rounded-xl font-mono border-blue-500/30"
														placeholder="4000000"
													/>
												</div>
											)}
										</div>

										{/* Level Range Slider */}
										<div className="pt-2 border-t border-border/40 space-y-2">
											<div className="flex items-center justify-between text-xs">
												<span className="font-medium text-foreground">
													Target Level Range
												</span>
												<span className="font-mono text-primary font-bold">
													Levels {levelRange[0]} – {levelRange[1]}
												</span>
											</div>
											<Slider
												min={1}
												max={100}
												step={1}
												value={[levelRange[0], levelRange[1]]}
												onValueChange={(val) => {
													const minVal = val[0] ?? 1;
													const maxVal = val[1] ?? 100;
													setLevelRange([minVal, maxVal]);
												}}
												className="py-2"
											/>
											<div className="flex justify-between text-[10px] font-mono text-muted-foreground">
												<span>Level 1</span>
												<span>Level 50</span>
												<span>Level 100</span>
											</div>
										</div>
									</div>

									{/* Upcoming War Special: Change Terms on War Start */}
									{validatedFaction?.warStatus === "upcoming" &&
										startMinutesBeforeWar > 0 && (
											<div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-4">
												<div className="flex items-center gap-2">
													<Checkbox
														id="change-terms-war-start"
														checked={changeTermsOnWarStart}
														onCheckedChange={(c) =>
															setChangeTermsOnWarStart(Boolean(c))
														}
													/>
													<label
														htmlFor="change-terms-war-start"
														className="text-xs font-semibold text-amber-700 dark:text-amber-300 cursor-pointer flex items-center gap-1.5"
													>
														<Sliders className="size-3.5" />
														Change terms on war start
													</label>
												</div>

												{changeTermsOnWarStart && (
													<div className="space-y-4 pt-3 border-t border-amber-500/20">
														<span className="text-xs font-semibold text-foreground block">
															War-Start Terms:
														</span>

														<div className="flex flex-wrap items-center gap-6">
															<div className="flex items-center gap-2">
																<Checkbox
																	id="war-term-online"
																	checked={warStartOnline}
																	onCheckedChange={(c) =>
																		setWarStartOnline(Boolean(c))
																	}
																/>
																<label
																	htmlFor="war-term-online"
																	className="text-xs text-foreground cursor-pointer font-medium"
																>
																	Online
																</label>
															</div>

															<div className="flex items-center gap-2">
																<Checkbox
																	id="war-term-idle"
																	checked={warStartIdle}
																	onCheckedChange={(c) =>
																		setWarStartIdle(Boolean(c))
																	}
																/>
																<label
																	htmlFor="war-term-idle"
																	className="text-xs text-foreground cursor-pointer font-medium"
																>
																	Idle
																</label>
															</div>

															<div className="flex items-center gap-2">
																<Checkbox
																	id="war-term-offline"
																	checked={warStartOffline}
																	onCheckedChange={(c) =>
																		setWarStartOffline(Boolean(c))
																	}
																/>
																<label
																	htmlFor="war-term-offline"
																	className="text-xs text-foreground cursor-pointer font-medium"
																>
																	Offline
																</label>
															</div>
														</div>

														{warStartIdle && (
															<div className="pt-1 max-w-xs">
																<label
																	htmlFor="war-term-idle-minutes"
																	className="text-xs text-muted-foreground block mb-1"
																>
																	Max Idle Duration (minutes)
																</label>
																<Input
																	id="war-term-idle-minutes"
																	type="number"
																	min={1}
																	max={1440}
																	value={warStartIdleDuration}
																	onChange={(e) => {
																		const next = Number(e.target.value) || 15;
																		setWarStartIdleDuration(next);
																	}}
																	className="h-9 text-xs rounded-xl font-mono"
																	placeholder="15"
																/>
															</div>
														)}

														<div className="pt-2 border-t border-amber-500/20">
															<div className="flex items-center gap-2">
																<Checkbox
																	id="war-term-stricken"
																	checked={warStartStricken}
																	onCheckedChange={(c) =>
																		setWarStartStricken(Boolean(c))
																	}
																/>
																<label
																	htmlFor="war-term-stricken"
																	className="text-xs text-foreground cursor-pointer font-medium"
																>
																	Stricken hits
																</label>
															</div>
														</div>

														<div className="pt-2 border-t border-amber-500/20 space-y-2">
															<div className="flex items-center justify-between text-xs">
																<span className="font-medium text-foreground">
																	War-Start Level Range
																</span>
																<span className="font-mono text-amber-600 dark:text-amber-400 font-bold">
																	Levels {warStartLevelRange[0]} –{" "}
																	{warStartLevelRange[1]}
																</span>
															</div>
															<Slider
																min={1}
																max={100}
																step={1}
																value={[
																	warStartLevelRange[0],
																	warStartLevelRange[1],
																]}
																onValueChange={(val) => {
																	const minVal = val[0] ?? 1;
																	const maxVal = val[1] ?? 100;
																	setWarStartLevelRange([minVal, maxVal]);
																}}
																className="py-2"
															/>
														</div>
													</div>
												)}
											</div>
										)}
								</div>
							</div>

							<DialogFooter className="pt-4 border-t border-border/60 flex items-center justify-end gap-3">
								<Button
									type="button"
									variant="outline"
									onClick={() => setIsModalOpen(false)}
									disabled={isSubmitting}
									className="rounded-xl h-10 px-4 text-xs font-semibold cursor-pointer"
								>
									Cancel
								</Button>
								<Button
									type="button"
									onClick={handleCreateContract}
									disabled={isSubmitting || !validatedFaction}
									className="rounded-xl h-10 px-6 text-xs font-semibold cursor-pointer"
								>
									{isSubmitting ? (
										<>
											<Loader2 className="size-4 animate-spin mr-1.5" />
											Creating Contract...
										</>
									) : (
										"Create Contract"
									)}
								</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

export default MercContractsPage;
