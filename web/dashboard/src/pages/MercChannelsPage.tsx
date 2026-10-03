import { Clock, Loader2, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface MercChannelsConfig {
	contractCreation: string | null;
	upcomingContracts: string | null;
	targets: string | null;
	revivables: string | null;
	mercLog: string | null;
	pastContracts: string | null;
	clientCategory: string | null;
	archiveCategory: string | null;
	updatedAt?: string | null;
	updatedBy?: string | null;
}

interface MercChannelsPageProps {
	guildId: string;
}

export function MercChannelsPage({ guildId }: MercChannelsPageProps) {
	const { toast } = useToast();

	const [loading, setLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	const [channelNames, setChannelNames] = useState<string[]>([]);
	const [categoryNames, setCategoryNames] = useState<string[]>([]);
	const [config, setConfig] = useState<MercChannelsConfig>({
		contractCreation: null,
		upcomingContracts: null,
		targets: null,
		revivables: null,
		mercLog: null,
		pastContracts: null,
		clientCategory: null,
		archiveCategory: null,
	});
	const [initialConfig, setInitialConfig] = useState<MercChannelsConfig>({
		contractCreation: null,
		upcomingContracts: null,
		targets: null,
		revivables: null,
		mercLog: null,
		pastContracts: null,
		clientCategory: null,
		archiveCategory: null,
	});

	const fetchData = async () => {
		setLoading(true);

		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			// Fetch mercenary channel config & Discord channel names
			const res = await guildRoute.merc.channels.get();

			if (res.data && "config" in res.data) {
				const cfg = res.data.config as MercChannelsConfig;
				const names = Array.isArray(res.data.channelNames)
					? (res.data.channelNames as string[])
					: [];

				const catNames = Array.isArray(
					(res.data as Record<string, unknown>).categoryNames,
				)
					? ((res.data as Record<string, unknown>).categoryNames as string[])
					: [];

				const currentConfig: MercChannelsConfig = {
					contractCreation: cfg.contractCreation ?? null,
					upcomingContracts: cfg.upcomingContracts ?? null,
					targets: cfg.targets ?? null,
					revivables: cfg.revivables ?? null,
					mercLog: cfg.mercLog ?? null,
					pastContracts: cfg.pastContracts ?? null,
					clientCategory: cfg.clientCategory ?? null,
					archiveCategory: cfg.archiveCategory ?? null,
					updatedAt: cfg.updatedAt ?? null,
					updatedBy: cfg.updatedBy ?? null,
				};

				setConfig(currentConfig);
				setInitialConfig(currentConfig);
				setChannelNames(names);
				setCategoryNames(catNames);
			} else {
				// Fallback to standard channels endpoint if merc endpoint returns empty
				const chanRes = await guildRoute.channels.get();
				if (chanRes.data && "channels" in chanRes.data) {
					const allChans = chanRes.data.channels as Array<{
						name: string;
						type: number;
					}>;
					const names = Array.from(
						new Set(
							allChans
								.filter((c) => c.type === 0 || c.type === 5)
								.map((c) => c.name)
								.filter(Boolean),
						),
					).sort((a, b) => a.localeCompare(b));
					const cats = Array.from(
						new Set(
							allChans
								.filter((c) => c.type === 4)
								.map((c) => c.name)
								.filter(Boolean),
						),
					).sort((a, b) => a.localeCompare(b));
					setChannelNames(names);
					setCategoryNames(cats);
				}
			}
		} catch (err) {
			console.error("Failed to load mercenary channels configuration:", err);
			toast(
				err instanceof Error
					? err.message
					: "Failed to load mercenary channels configuration.",
				"error",
			);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		fetchData();
	}, [guildId]);

	const isDirty =
		config.contractCreation !== initialConfig.contractCreation ||
		config.upcomingContracts !== initialConfig.upcomingContracts ||
		config.targets !== initialConfig.targets ||
		config.revivables !== initialConfig.revivables ||
		config.mercLog !== initialConfig.mercLog ||
		config.pastContracts !== initialConfig.pastContracts ||
		config.clientCategory !== initialConfig.clientCategory ||
		config.archiveCategory !== initialConfig.archiveCategory;

	const handleDiscard = () => {
		setConfig(initialConfig);
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const guildRoute = api.v2.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.merc.channels.put({
				contractCreation: config.contractCreation,
				upcomingContracts: config.upcomingContracts,
				targets: config.targets,
				revivables: config.revivables,
				mercLog: config.mercLog,
				pastContracts: config.pastContracts,
				clientCategory: config.clientCategory,
				archiveCategory: config.archiveCategory,
			});

			if (res.error) {
				const errMsg =
					typeof res.error.value === "string"
						? res.error.value
						: "Failed to save mercenary channel selections.";
				toast(errMsg, "error");
				return;
			}

			const updated = (
				res.data && "config" in res.data ? res.data.config : config
			) as MercChannelsConfig;
			setConfig(updated);
			setInitialConfig(updated);
			toast("Mercenary channel selections saved successfully.", "success");
		} catch (err) {
			console.error("Error saving mercenary channel configuration:", err);
			toast(
				err instanceof Error
					? err.message
					: "An unexpected error occurred while saving.",
				"error",
			);
		} finally {
			setIsSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="pb-6 border-b border-border/60">
					<Skeleton className="h-9 w-64" />
				</div>
				<Skeleton className="h-96 w-full rounded-2xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 pb-12 max-w-5xl">
			{/* Main Channel Routing Configuration Card */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Channel Selections
					</CardTitle>
				</CardHeader>

				<CardContent className="space-y-6">
					{/* 1. Contract Creation Channel */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-contract-creation"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Contract Creation
						</label>

						<div className="max-w-md">
							<Select
								value={config.contractCreation ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										contractCreation: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-contract-creation"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Channel Selected --
										</SelectItem>
										{channelNames.map((name) => (
											<SelectItem key={name} value={name}>
												#{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.contractCreation && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-blue-400 font-semibold">
									#{config.contractCreation}
								</span>
							</div>
						)}
					</div>

					{/* 2. Upcoming Contracts Channel */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-upcoming-contracts"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Upcoming Contracts
						</label>

						<div className="max-w-md">
							<Select
								value={config.upcomingContracts ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										upcomingContracts: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-upcoming-contracts"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Channel Selected --
										</SelectItem>
										{channelNames.map((name) => (
											<SelectItem key={name} value={name}>
												#{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.upcomingContracts && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-amber-400 font-semibold">
									#{config.upcomingContracts}
								</span>
							</div>
						)}
					</div>

					{/* 3. Targets Channel */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-targets"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Targets
						</label>

						<div className="max-w-md">
							<Select
								value={config.targets ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										targets: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-targets"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Channel Selected --
										</SelectItem>
										{channelNames.map((name) => (
											<SelectItem key={name} value={name}>
												#{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.targets && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-rose-400 font-semibold">
									#{config.targets}
								</span>
							</div>
						)}
					</div>

					{/* 4. Revivables Channel */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-revivables"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Revivables List
						</label>

						<div className="max-w-md">
							<Select
								value={config.revivables ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										revivables: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-revivables"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Channel Selected --
										</SelectItem>
										{channelNames.map((name) => (
											<SelectItem key={name} value={name}>
												#{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.revivables && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-cyan-400 font-semibold">
									#{config.revivables}
								</span>
							</div>
						)}
					</div>

					{/* 5. Merc Log Channel */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-merc-log"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Merc Log
						</label>

						<div className="max-w-md">
							<Select
								value={config.mercLog ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										mercLog: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-merc-log"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Channel Selected --
										</SelectItem>
										{channelNames.map((name) => (
											<SelectItem key={name} value={name}>
												#{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.mercLog && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-emerald-400 font-semibold">
									#{config.mercLog}
								</span>
							</div>
						)}
					</div>

					{/* 6. Past Contracts Channel */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-past-contracts"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Past Contracts
						</label>
						<p className="text-[11px] text-muted-foreground">
							Announcements are posted here when a completed contract is marked
							as paid.
						</p>

						<div className="max-w-md">
							<Select
								value={config.pastContracts ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										pastContracts: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-past-contracts"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Channel Selected --
										</SelectItem>
										{channelNames.map((name) => (
											<SelectItem key={name} value={name}>
												#{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.pastContracts && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-emerald-400 font-semibold">
									#{config.pastContracts}
								</span>
							</div>
						)}
					</div>

					{/* 5. Client Channels Category */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-client-category"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Client Channels Category
						</label>

						<div className="max-w-md">
							<Select
								value={config.clientCategory ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										clientCategory: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-client-category"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Category Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Category Selected --
										</SelectItem>
										{categoryNames.map((name) => (
											<SelectItem key={name} value={name}>
												{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.clientCategory && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-primary font-semibold">
									{config.clientCategory}
								</span>
							</div>
						)}
					</div>

					{/* 6. Archive Category */}
					<div className="p-4 rounded-xl border border-border/80 bg-muted/20 space-y-3">
						<label
							htmlFor="select-archive-category"
							className="text-sm font-semibold text-foreground block cursor-pointer"
						>
							Archive Category
						</label>

						<div className="max-w-md">
							<Select
								value={config.archiveCategory ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										archiveCategory: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger
									id="select-archive-category"
									className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Category Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-72">
									<SelectGroup>
										<SelectItem value="none">
											-- No Category Selected --
										</SelectItem>
										{categoryNames.map((name) => (
											<SelectItem key={name} value={name}>
												{name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{config.archiveCategory && (
							<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
								<span className="text-muted-foreground text-[10px]">
									SELECTED:
								</span>
								<span className="text-amber-400 font-semibold">
									{config.archiveCategory}
								</span>
							</div>
						)}
					</div>

					{/* Metadata Info Footer */}
					{config.updatedAt && (
						<div className="pt-2 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/60">
							<div className="flex items-center gap-1.5">
								<Clock className="size-3.5" />
								<span>
									Last updated: {new Date(config.updatedAt).toLocaleString()}
								</span>
							</div>
							{config.updatedBy && (
								<span className="font-mono text-[10px]">
									By: {config.updatedBy}
								</span>
							)}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Bottom Save & Discard Controls Bar */}
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

export default MercChannelsPage;
