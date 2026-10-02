import {
	AlertTriangle,
	CheckCircle2,
	Clock,
	Copy,
	ExternalLink,
	Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";
import { useRouter } from "../router";

interface ContractSession {
	valid: boolean;
	token: string;
	guildId: string;
	channelId?: string | null;
	discordUserId: string;
	discordUsername?: string | null;
	factionId: number;
	factionName?: string | null;
	standardHitPrice?: number;
	strickenHitPrice?: number;
	expiresAt: string;
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

export function ClientContractCreatePage() {
	const { queryParams, navigate } = useRouter();
	const { toast } = useToast();
	const token = queryParams.token?.trim() || "";

	const [sessionLoading, setSessionLoading] = useState(true);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [session, setSession] = useState<ContractSession | null>(null);

	const [_validatingFaction, setValidatingFaction] = useState(false);
	const [factionData, setFactionData] = useState<ValidatedFactionData | null>(
		null,
	);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submittedContract, setSubmittedContract] = useState<{
		id: string;
		receiptUrl: string;
	} | null>(null);

	// Timing States
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

	// Hit Filter Terms
	const [onlineStatus, setOnlineStatus] = useState(true);
	const [idleStatus, setIdleStatus] = useState(true);
	const [offlineStatus, setOfflineStatus] = useState(false);
	const [idleDuration, setIdleDuration] = useState<number>(15);
	const [strickenHits, setStrickenHits] = useState(false);
	const [levelRange, setLevelRange] = useState<[number, number]>([1, 100]);

	// Step 1: Validate Session Token
	useEffect(() => {
		if (!token) {
			setSessionLoading(false);
			setSessionError(
				"No contract session token provided. Please click the link from Discord.",
			);
			return;
		}

		let active = true;
		const checkSession = async () => {
			setSessionLoading(true);
			try {
				const res = await api.v2.merc["contract-session"].get({
					query: { token },
				});

				if (!active) return;

				if (
					res.error ||
					!res.data ||
					!("valid" in res.data) ||
					!res.data.valid
				) {
					let errMsg = "Session link expired or invalid.";
					if (
						res.data &&
						typeof res.data === "object" &&
						"error" in res.data &&
						typeof res.data.error === "string"
					) {
						errMsg = res.data.error;
					} else if (
						res.error &&
						typeof res.error === "object" &&
						"value" in res.error &&
						res.error.value &&
						typeof res.error.value === "object" &&
						"error" in res.error.value &&
						typeof (res.error.value as Record<string, unknown>).error ===
							"string"
					) {
						errMsg = (res.error.value as Record<string, unknown>)
							.error as string;
					} else if (res.error && typeof res.error.value === "string") {
						errMsg = res.error.value;
					} else if (res.error?.value instanceof Error) {
						errMsg = res.error.value.message;
					} else if (
						res.error &&
						typeof res.error === "object" &&
						"status" in res.error &&
						typeof res.error.status === "number"
					) {
						errMsg = `Failed to validate session token (HTTP ${res.error.status}).`;
					}
					setSessionError(errMsg);
				} else {
					const data = res.data as ContractSession;
					setSession(data);
					// Automatically validate faction war status
					loadFactionWarStatus(data.factionId, token);
				}
			} catch (err) {
				if (active) {
					setSessionError(
						err instanceof Error
							? err.message
							: "Failed to validate session token.",
					);
				}
			} finally {
				if (active) setSessionLoading(false);
			}
		};

		checkSession();
		return () => {
			active = false;
		};
	}, [token]);

	const loadFactionWarStatus = async (
		factionId: number,
		sessionToken: string,
	) => {
		setValidatingFaction(true);
		try {
			const res = await api.v2.merc.factions.validate.get({
				query: {
					factionId: String(factionId),
					token: sessionToken,
				},
			});

			if (res.data && "valid" in res.data && res.data.valid) {
				const data = res.data as ValidatedFactionData;
				setFactionData(data);

				if (data.warStatus === "active") {
					setStartImmediately(true);
					setEndOnWarEnd(true);
				} else if (data.warStatus === "upcoming") {
					setStartImmediately(false);
					setStartMinutesBeforeWar(30);
					setEndOnWarEnd(true);
				} else {
					setStartImmediately(true);
					setEndOnWarEnd(false);
				}
			}
		} catch (err) {
			console.error("Failed to detect faction war:", err);
		} finally {
			setValidatingFaction(false);
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!session) return;

		const parsedHitPrice = session.standardHitPrice ?? 3000000;
		const parsedStrickenPrice = strickenHits
			? (session.strickenHitPrice ?? 4000000)
			: null;

		let calculatedStartTime = new Date().toISOString();
		if (
			factionData?.warStatus === "upcoming" &&
			!startImmediately &&
			factionData.war?.start
		) {
			const warStartMs = factionData.war.start * 1000;
			calculatedStartTime = new Date(
				warStartMs - startMinutesBeforeWar * 60 * 1000,
			).toISOString();
		} else if (!startImmediately) {
			calculatedStartTime = parseTctInputToIso(customStartTime);
		}

		let calculatedEndTime: string | null = null;
		if (endOnWarEnd && factionData?.war?.end) {
			calculatedEndTime = new Date(factionData.war.end * 1000).toISOString();
		} else if (!endOnWarEnd) {
			calculatedEndTime = parseTctInputToIso(customEndTime);
		}

		const payload = {
			token: session.token,
			factionId: session.factionId,
			factionName:
				factionData?.name ??
				session.factionName ??
				`Faction ${session.factionId}`,
			warStatusAtCreation: factionData?.warStatus ?? "no_war",
			warId: factionData?.war?.id ?? null,
			warStart: factionData?.war?.start ?? null,
			warEnd: factionData?.war?.end ?? null,
			warTarget: factionData?.war?.target ?? null,
			warOpponent: factionData?.war?.opponent ?? null,

			startTime: calculatedStartTime,
			startImmediately,
			startMinutesBeforeWar:
				factionData?.warStatus === "upcoming" && !startImmediately
					? startMinutesBeforeWar
					: null,
			endTime: calculatedEndTime,
			endOnWarEnd,

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

			hitPrice: parsedHitPrice,
			strickenHitPrice: parsedStrickenPrice,

			changeTermsOnWarStart: false,
			warStartTerms: null,
			warStartHitPrice: null,
			warStartStrickenHitPrice: null,
		};

		setIsSubmitting(true);
		try {
			const res = await api.v2.merc.contracts.client.post(payload);

			if (
				res.error ||
				!res.data ||
				!("success" in res.data) ||
				!res.data.success
			) {
				const errMsg =
					res.data && "error" in res.data && typeof res.data.error === "string"
						? res.data.error
						: "Failed to submit contract.";
				toast(errMsg, "error");
				return;
			}

			toast("Mercenary contract created successfully!", "success");
			const receiptUrl =
				typeof window !== "undefined" && window.location?.origin
					? `${window.location.origin}/#/merc/receipt/${res.data.contractId}`
					: res.data.receiptUrl;
			setSubmittedContract({
				id: res.data.contractId,
				receiptUrl,
			});
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Failed to create contract.",
				"error",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	if (sessionLoading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground px-4">
				<Loader2 className="size-8 animate-spin text-primary mb-4" />
				<div className="font-mono text-sm tracking-wider uppercase text-muted-foreground">
					Validating Contract Session...
				</div>
			</div>
		);
	}

	if (sessionError) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground px-4">
				<Card className="max-w-md w-full border-border/80 bg-card/90 shadow-2xl backdrop-blur-md rounded-2xl p-6 text-center space-y-4">
					<div className="size-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mx-auto">
						<AlertTriangle className="size-6" />
					</div>
					<h2 className="text-xl font-bold tracking-tight">
						{sessionError.includes("active or upcoming contract")
							? "Contract Already In Progress"
							: "Session Link Invalid"}
					</h2>
					<p className="text-sm text-muted-foreground">{sessionError}</p>
					<div className="pt-2">
						<p className="text-xs text-muted-foreground font-mono">
							Please return to Discord and click the "Create Contract" button in
							the contract creation channel to generate a fresh link.
						</p>
					</div>
				</Card>
			</div>
		);
	}

	if (submittedContract) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground px-4 py-12">
				<Card className="max-w-xl w-full border-emerald-500/30 bg-card/90 shadow-2xl backdrop-blur-md rounded-2xl p-8 space-y-2">
					<div className="size-16 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto border border-emerald-500/20">
						<CheckCircle2 className="size-8" />
					</div>
					<div className="text-center space-y-2">
						<h1 className="text-2xl font-bold tracking-tight">
							Mercenary Contract Confirmed!
						</h1>
					</div>

					<div className="p-4 rounded-xl bg-muted/30 border border-border/80 space-y-3 font-mono text-xs">
						<div className="flex items-center justify-between text-muted-foreground">
							<span>CONTRACT ID</span>
							<span className="text-foreground font-bold">
								{submittedContract.id}
							</span>
						</div>
						<div className="flex items-center justify-between text-muted-foreground">
							<span>TARGET FACTION</span>
							<span className="text-foreground">
								{factionData?.name ?? session?.factionName}
							</span>
						</div>
						<div className="flex items-center justify-between text-muted-foreground">
							<span>RATE PER HIT</span>
							<span className="text-emerald-400 font-bold">
								${(session?.standardHitPrice ?? 3000000).toLocaleString()}
							</span>
						</div>
					</div>

					{/* Permanent Receipt Viewer Link */}
					<div className="space-y-3">
						<div className="text-xs font-semibold text-foreground uppercase tracking-wider block">
							Permanent Receipt Viewer
						</div>
						<p className="text-xs text-muted-foreground">
							Bookmark this link to monitor real-time hit counts and targets hit
							throughout the contract:
						</p>
						<div className="flex items-center gap-2">
							<Input
								readOnly
								value={submittedContract.receiptUrl}
								className="font-mono text-xs h-10 bg-background"
							/>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									navigator.clipboard.writeText(submittedContract.receiptUrl);
									toast("Receipt link copied to clipboard!", "success");
								}}
								className="h-10 px-3"
							>
								<Copy className="size-4" />
							</Button>
						</div>
					</div>

					<div className="flex flex-col sm:flex-row gap-3 pt-2">
						<Button
							type="button"
							className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2"
							onClick={() => navigate(`/merc/receipt/${submittedContract.id}`)}
						>
							<ExternalLink className="size-4" />
							Open Live Receipt Viewer
						</Button>
					</div>
				</Card>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background text-foreground py-10 px-4 flex justify-center">
			<div className="max-w-3xl w-full space-y-8">
				{/* Top Branding Banner */}
				<div className="text-center space-y-2">
					<div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs font-mono uppercase tracking-wider">
						Subversive Alliance Mercenary Services
					</div>
					<h1 className="text-3xl font-extrabold tracking-tight">
						Mercenary Contract Request
					</h1>
				</div>

				<form onSubmit={handleSubmit} className="space-y-6">
					{/* 1. Client Faction Banner */}
					<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
						<CardHeader className="border-b border-border/40 pb-4">
							<CardTitle className="text-base font-semibold flex items-center justify-between">
								<span>1. Client Faction Information</span>
							</CardTitle>
						</CardHeader>
						<CardContent className="pt-0 space-y-4">
							<div className="p-4 rounded-xl bg-muted/20 border border-border/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
								<div>
									<div className="text-xs text-muted-foreground font-mono uppercase">
										CLIENT FACTION
									</div>
									<div className="text-lg font-bold text-foreground">
										{factionData?.name ?? session?.factionName} [
										{session?.factionId}]
									</div>
								</div>
							</div>
						</CardContent>
					</Card>

					{/* 2. Contract Duration & Timing */}
					<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
						<CardHeader className="border-b border-border/40 pb-4">
							<CardTitle className="text-base font-semibold flex items-center gap-2">
								2. Contract Duration & Timing (TCT / UTC)
							</CardTitle>
						</CardHeader>
						<CardContent className="pt-0 space-y-6">
							{factionData?.warStatus === "upcoming" ? (
								<div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-4">
									<div className="flex items-center justify-between flex-wrap gap-2">
										<div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
											<Clock className="size-4" />
											Upcoming War Detected
										</div>
										{factionData.war?.start && (
											<div className="text-xs text-muted-foreground font-mono">
												War Start:{" "}
												<span className="text-foreground font-bold">
													{formatTctDateTime(
														new Date(factionData.war.start * 1000),
													)}
												</span>
											</div>
										)}
									</div>
									<div className="space-y-3">
										<div className="flex justify-between items-center text-xs font-mono">
											<span className="text-muted-foreground">
												START RELATIVE TO WAR:
											</span>
											<span className="text-amber-400 font-bold">
												{startMinutesBeforeWar === 0
													? "Start exactly at war start"
													: `Start ${startMinutesBeforeWar} mins before war`}
											</span>
										</div>
										<Slider
											value={[startMinutesBeforeWar]}
											min={0}
											max={120}
											step={5}
											onValueChange={(val) =>
												setStartMinutesBeforeWar(val[0] ?? 30)
											}
										/>
									</div>
									<div className="flex items-center space-x-2 pt-1">
										<Checkbox
											id="start-imm"
											checked={startImmediately}
											onCheckedChange={(checked) =>
												setStartImmediately(Boolean(checked))
											}
										/>
										<label
											htmlFor="start-imm"
											className="text-xs text-foreground cursor-pointer"
										>
											Override & start contract immediately right now
										</label>
									</div>
								</div>
							) : (
								<div className="space-y-4">
									<div className="flex items-center space-x-2">
										<Checkbox
											id="start-now"
											checked={startImmediately}
											onCheckedChange={(checked) =>
												setStartImmediately(Boolean(checked))
											}
										/>
										<label
											htmlFor="start-now"
											className="text-sm font-semibold text-foreground cursor-pointer"
										>
											Start Contract Immediately upon creation
										</label>
									</div>

									{!startImmediately && (
										<div className="max-w-xs space-y-1.5 pl-6">
											<label
												htmlFor="custom-start-time"
												className="text-xs text-muted-foreground"
											>
												CUSTOM START TIME (TCT)
											</label>
											<Input
												id="custom-start-time"
												type="datetime-local"
												value={customStartTime}
												onChange={(e) => setCustomStartTime(e.target.value)}
												className="h-10 rounded-xl bg-background border-input text-foreground text-xs"
											/>
										</div>
									)}
								</div>
							)}

							<div className="pt-2 border-t border-border/40 space-y-4">
								<div className="flex items-center space-x-2">
									<Checkbox
										id="end-war"
										checked={endOnWarEnd}
										onCheckedChange={(checked) =>
											setEndOnWarEnd(Boolean(checked))
										}
										disabled={factionData?.warStatus === "no_war"}
									/>
									<label
										htmlFor="end-war"
										className={`text-sm font-semibold cursor-pointer ${
											factionData?.warStatus === "no_war"
												? "text-muted-foreground opacity-60"
												: "text-foreground"
										}`}
									>
										End contract automatically when war concludes
									</label>
								</div>

								{!endOnWarEnd && (
									<div className="max-w-xs space-y-1.5 pl-6">
										<label
											htmlFor="custom-end-time"
											className="text-xs text-muted-foreground"
										>
											CUSTOM END TIME (TCT)
										</label>
										<Input
											id="custom-end-time"
											type="datetime-local"
											value={customEndTime}
											onChange={(e) => setCustomEndTime(e.target.value)}
											className="h-10 rounded-xl bg-background border-input text-foreground text-xs"
										/>
									</div>
								)}
							</div>
						</CardContent>
					</Card>

					{/* 3. Target Hit Filter Rules */}
					<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
						<CardHeader className="border-b border-border/40 pb-4">
							<CardTitle className="text-base font-semibold">
								3. Target Hit Rules & Eligibility
							</CardTitle>
						</CardHeader>
						<CardContent className="pt-0 space-y-6">
							<div>
								<div className="text-xs font-semibold text-foreground uppercase tracking-wider block mb-3">
									Allowed Activity Statuses
								</div>
								<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
									<div className="flex items-center gap-2 p-3 rounded-xl border border-border/80 bg-muted/20 hover:bg-muted/30">
										<Checkbox
											id="status-online"
											checked={onlineStatus}
											onCheckedChange={(c) => setOnlineStatus(Boolean(c))}
										/>
										<label
											htmlFor="status-online"
											className="text-xs font-semibold text-foreground cursor-pointer"
										>
											Online
										</label>
									</div>
									<div className="flex items-center gap-2 p-3 rounded-xl border border-border/80 bg-muted/20 hover:bg-muted/30">
										<Checkbox
											id="status-idle"
											checked={idleStatus}
											onCheckedChange={(c) => setIdleStatus(Boolean(c))}
										/>
										<label
											htmlFor="status-idle"
											className="text-xs font-semibold text-foreground cursor-pointer"
										>
											Idle
										</label>
									</div>
									<div className="flex items-center gap-2 p-3 rounded-xl border border-border/80 bg-muted/20 hover:bg-muted/30">
										<Checkbox
											id="status-offline"
											checked={offlineStatus}
											onCheckedChange={(c) => setOfflineStatus(Boolean(c))}
										/>
										<label
											htmlFor="status-offline"
											className="text-xs font-semibold text-foreground cursor-pointer"
										>
											Offline
										</label>
									</div>
								</div>
							</div>

							{idleStatus && (
								<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
									<div className="flex justify-between items-center text-xs font-mono">
										<span className="text-muted-foreground">
											MAXIMUM IDLE DURATION:
										</span>
										<span className="text-primary font-bold">
											{idleDuration} minutes
										</span>
									</div>
									<Slider
										value={[idleDuration]}
										min={1}
										max={60}
										step={1}
										onValueChange={(val) => {
											const next = val[0] ?? 15;
											setIdleDuration(next);
										}}
									/>
								</div>
							)}

							<div className="space-y-3">
								<div className="flex justify-between items-center text-xs font-mono">
									<span className="text-muted-foreground">
										TARGET LEVEL RANGE:
									</span>
									<span className="text-primary font-bold">
										Level {levelRange[0]} – {levelRange[1]}
									</span>
								</div>
								<Slider
									value={[levelRange[0], levelRange[1]]}
									min={1}
									max={100}
									step={1}
									onValueChange={(val) => {
										const min = val[0] ?? 1;
										const max = val[1] ?? 100;
										setLevelRange([min, max]);
									}}
								/>
							</div>

							<div className="pt-2 border-t border-border/40">
								<div className="flex items-center gap-2.5 p-3 rounded-xl border border-border/80 bg-muted/20 hover:bg-muted/30">
									<Checkbox
										id="stricken-hits"
										checked={strickenHits}
										onCheckedChange={(c) => setStrickenHits(Boolean(c))}
									/>
									<label htmlFor="stricken-hits" className="cursor-pointer">
										<span className="text-xs font-semibold text-foreground block">
											Stricken Hits
										</span>
									</label>
								</div>
							</div>
						</CardContent>
					</Card>

					{/* 4. Pricing & Rates (Fixed Service Rates) */}
					<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
						<CardHeader className="border-b border-border/40 pb-4">
							<div className="flex items-center justify-between">
								<CardTitle className="text-base font-semibold">
									4. Pricing & Payout Rates
								</CardTitle>
							</div>
						</CardHeader>
						<CardContent className="pt-0 space-y-4">
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-1.5">
									<div className="text-xs font-mono text-muted-foreground uppercase">
										STANDARD HIT PRICE
									</div>
									<div className="text-2xl font-bold font-mono text-emerald-400">
										${(session?.standardHitPrice ?? 3000000).toLocaleString()}
									</div>
								</div>

								{strickenHits ? (
									<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-1.5">
										<div className="text-xs font-mono text-muted-foreground uppercase">
											STRICKEN HIT PRICE
										</div>
										<div className="text-2xl font-bold font-mono text-purple-400">
											${(session?.strickenHitPrice ?? 4000000).toLocaleString()}
										</div>
									</div>
								) : (
									<div className="p-4 rounded-xl border border-dashed border-border/60 bg-muted/10 space-y-1.5 opacity-60">
										<div className="text-xs font-mono text-muted-foreground uppercase">
											STRICKEN HIT PRICE
										</div>
										<div className="text-2xl font-bold font-mono text-muted-foreground">
											Disabled
										</div>
									</div>
								)}
							</div>
						</CardContent>
					</Card>

					{/* Submit Action */}
					<Button
						type="submit"
						disabled={isSubmitting}
						className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base shadow-lg transition-transform hover:scale-[1.01]"
					>
						{isSubmitting ? (
							<span className="flex items-center gap-2">
								<Loader2 className="size-5 animate-spin" /> Submitting Mercenary
								Contract...
							</span>
						) : (
							"Confirm & Deploy Mercenary Contract"
						)}
					</Button>
				</form>
			</div>
		</div>
	);
}

export default ClientContractCreatePage;
