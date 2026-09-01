import { Loader2, MapPin, Plus, RotateCcw, Save, X } from "lucide-react";
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

interface FactionMeta {
	name: string;
	tag: string | null;
}

interface TerritoryBlueprint {
	id: string;
	sector: number | null;
	size: number | null;
	density: number | null;
	slots: number | null;
}

interface TerritoryPageProps {
	guildId: string;
}

export default function TerritoryPage({ guildId }: TerritoryPageProps) {
	const { toast } = useToast();
	const { navigate } = useRouter();

	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);
	const [isEnabled, setIsEnabled] = useState(true);

	const [channels, setChannels] = useState<Channel[]>([]);

	// DB Territory Blueprints & Async Search State
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<TerritoryBlueprint[]>([]);
	const [isSearchingTerritories, setIsSearchingTerritories] = useState(false);
	const [showDropdown, setShowDropdown] = useState(false);

	// Form States
	const [ttFullChannelId, setTtFullChannelId] = useState<string | null>(null);
	const [initialTtFullChannelId, setInitialTtFullChannelId] = useState<
		string | null
	>(null);

	const [ttFilteredChannelId, setTtFilteredChannelId] = useState<string | null>(
		null,
	);
	const [initialTtFilteredChannelId, setInitialTtFilteredChannelId] = useState<
		string | null
	>(null);

	const [ttTerritoryIds, setTtTerritoryIds] = useState<string[]>([]);
	const [initialTtTerritoryIds, setInitialTtTerritoryIds] = useState<string[]>(
		[],
	);

	const [ttFactionIds, setTtFactionIds] = useState<number[]>([]);
	const [initialTtFactionIds, setInitialTtFactionIds] = useState<number[]>([]);

	// Input States
	const [newFactionInput, setNewFactionInput] = useState("");

	// Faction Lookup State
	const [isResolvingFaction, setIsResolvingFaction] = useState(false);
	const [factionNamesMap, setFactionNamesMap] = useState<
		Record<number, FactionMeta>
	>({});

	const [isSaving, setIsSaving] = useState(false);

	// Dirty detection
	const isDirty =
		ttFullChannelId !== initialTtFullChannelId ||
		ttFilteredChannelId !== initialTtFilteredChannelId ||
		JSON.stringify(ttTerritoryIds) !== JSON.stringify(initialTtTerritoryIds) ||
		JSON.stringify(ttFactionIds) !== JSON.stringify(initialTtFactionIds);

	const textChannels = channels.filter((c) => c.type === 0 || c.type === 5);

	const fetchConfig = useCallback(async () => {
		setLoading(true);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const [configRes, channelsRes] = await Promise.all([
				guildRoute.config.get(),
				guildRoute.channels.get(),
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

				setIsEnabled(true);

				const fullChan = config.ttFullChannelId ?? null;
				const filtChan = config.ttFilteredChannelId ?? null;
				const terrIds = config.ttTerritoryIds ?? [];
				const factIds = config.ttFactionIds ?? [];

				setTtFullChannelId(fullChan);
				setInitialTtFullChannelId(fullChan);
				setTtFilteredChannelId(filtChan);
				setInitialTtFilteredChannelId(filtChan);
				setTtTerritoryIds(terrIds);
				setInitialTtTerritoryIds(terrIds);
				setTtFactionIds(factIds);
				setInitialTtFactionIds(factIds);

				// Resolve names for initial faction IDs
				for (const id of factIds) {
					try {
						const res = await fetch(`/api/v1/guilds/${guildId}/factions/${id}`);
						if (res.ok) {
							const resData = (await res.json()) as {
								faction?: { name: string; tag: string | null };
							};
							if (resData.faction) {
								const factionInfo = resData.faction;
								setFactionNamesMap((prev) => ({
									...prev,
									[id]: {
										name: factionInfo.name,
										tag: factionInfo.tag,
									},
								}));
							}
						}
					} catch {
						// Ignore individual lookup errors
					}
				}
			}

			if (channelsRes.data && "channels" in channelsRes.data) {
				setChannels(channelsRes.data.channels);
			}
		} catch {
			toast("Failed to load territory configuration.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	useEffect(() => {
		const timer = setTimeout(async () => {
			const trimmed = searchQuery.trim();
			setIsSearchingTerritories(true);
			try {
				const res = await fetch(
					`/api/v1/guilds/${guildId}/territories?q=${encodeURIComponent(trimmed)}&limit=20`,
				);
				if (res.ok) {
					const data = (await res.json()) as {
						territories?: TerritoryBlueprint[];
					};
					setSearchResults(data.territories ?? []);
				}
			} catch {
				setSearchResults([]);
			} finally {
				setIsSearchingTerritories(false);
			}
		}, 200);

		return () => clearTimeout(timer);
	}, [searchQuery, guildId]);

	const handleAddCode = (code: string) => {
		const formatted = code.trim().toUpperCase();
		if (!formatted) return;
		if (ttTerritoryIds.includes(formatted)) {
			toast(`Territory "${formatted}" is already added.`, "info");
			return;
		}
		setTtTerritoryIds((prev) => [...prev, formatted]);
		setSearchQuery("");
		setShowDropdown(false);
	};

	const handleRemoveTerritory = (id: string) => {
		setTtTerritoryIds((prev) => prev.filter((t) => t !== id));
	};

	const handleAddFaction = async () => {
		const parsed = Number.parseInt(newFactionInput.trim(), 10);
		if (Number.isNaN(parsed) || parsed <= 0) {
			toast("Please enter a valid positive numeric Faction ID.", "error");
			return;
		}
		if (ttFactionIds.includes(parsed)) {
			toast(`Faction ID ${parsed} is already added.`, "info");
			return;
		}

		setIsResolvingFaction(true);
		try {
			const res = await fetch(`/api/v1/guilds/${guildId}/factions/${parsed}`);
			if (res.ok) {
				const resData = (await res.json()) as {
					faction?: { name: string; tag: string | null };
				};
				if (resData.faction) {
					const factionInfo = resData.faction;
					setFactionNamesMap((prev) => ({
						...prev,
						[parsed]: {
							name: factionInfo.name,
							tag: factionInfo.tag,
						},
					}));
					toast(`Verified Faction: ${factionInfo.name}`, "success");
				}
			} else {
				toast(`Faction ID ${parsed} added (could not resolve name).`, "info");
			}

			setTtFactionIds((prev) => [...prev, parsed]);
			setNewFactionInput("");
		} catch {
			toast(`Added Faction ID ${parsed}.`, "info");
			setTtFactionIds((prev) => [...prev, parsed]);
			setNewFactionInput("");
		} finally {
			setIsResolvingFaction(false);
		}
	};

	const handleRemoveFaction = (id: number) => {
		setTtFactionIds((prev) => prev.filter((f) => f !== id));
	};

	const handleDiscard = () => {
		setTtFullChannelId(initialTtFullChannelId);
		setTtFilteredChannelId(initialTtFilteredChannelId);
		setTtTerritoryIds(initialTtTerritoryIds);
		setTtFactionIds(initialTtFactionIds);
		setSearchQuery("");
		setNewFactionInput("");
		setShowDropdown(false);
		toast("Unsaved changes discarded.", "info");
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const res = await guildRoute.config.put({
				ttFullChannelId: ttFullChannelId || null,
				ttFilteredChannelId: ttFilteredChannelId || null,
				ttTerritoryIds,
				ttFactionIds,
			});

			if (res.error) {
				toast("Failed to update territory alert settings.", "error");
			} else {
				toast("Territory alert settings updated successfully!", "success");
				setInitialTtFullChannelId(ttFullChannelId);
				setInitialTtFilteredChannelId(ttFilteredChannelId);
				setInitialTtTerritoryIds(ttTerritoryIds);
				setInitialTtFactionIds(ttFactionIds);
			}
		} catch {
			toast("An unexpected error occurred while saving.", "error");
		} finally {
			setIsSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3 py-4 border-b border-border/60">
					<Loader2 className="size-5 animate-spin text-primary" />
					<span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
						Loading Territory Settings...
					</span>
				</div>
				{[1, 2, 3, 4].map((i) => (
					<Card
						key={`skeleton-${i}`}
						className="p-6 border-border/60 bg-card/60"
					>
						<Skeleton className="h-6 w-1/3 mb-4 rounded-lg" />
						<Skeleton className="h-10 w-full rounded-xl mb-2" />
						<Skeleton className="h-4 w-1/2 rounded-lg" />
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
						Territory Assaults
					</h1>
					<p className="text-muted-foreground text-sm mt-1">
						Module is currently disabled for this server.
					</p>
				</div>

				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl p-8 sm:p-12 text-center flex flex-col items-center gap-4">
					<div className="size-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shadow-xs">
						<MapPin className="size-7" />
					</div>
					<div className="space-y-1">
						<CardTitle className="text-xl font-bold tracking-tight text-foreground">
							Module Disabled
						</CardTitle>
						<p className="text-muted-foreground text-xs sm:text-sm max-w-md leading-relaxed">
							The Territory Assaults module is turned off for this server.
							Contact a Sentinel administrator to enable this module.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => navigate(`/guilds/${guildId}`)}
						className="mt-2 text-xs font-semibold rounded-xl cursor-pointer"
					>
						Back to Settings
					</Button>
				</Card>
			</div>
		);
	}

	return (
		<div className="space-y-8 pb-20">
			{/* Page Header */}
			<div className="pb-6 border-b border-border/60">
				<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
					Territory Assaults
				</h1>
			</div>

			{/* 1. Full Territory Feed Channel */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Full Territory Feed Channel
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 max-w-md">
						<label
							htmlFor="full-channel-select"
							className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
						>
							Target Discord Channel
						</label>
						{textChannels.length > 0 ? (
							<Select
								value={ttFullChannelId ?? "none"}
								onValueChange={(val) =>
									setTtFullChannelId(val === "none" ? null : val)
								}
							>
								<SelectTrigger
									id="full-channel-select"
									className="w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
									<SelectGroup>
										<SelectItem value="none">
											<span className="text-muted-foreground italic">
												-- No Channel Selected --
											</span>
										</SelectItem>
										{textChannels.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												#{c.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						) : (
							<Input
								id="full-channel-select"
								type="text"
								value={ttFullChannelId ?? ""}
								onChange={(e) => setTtFullChannelId(e.target.value || null)}
								placeholder="Enter Discord Channel ID"
								className="font-mono text-xs rounded-xl"
							/>
						)}
					</div>
				</CardContent>
			</Card>

			{/* 2. Filtered Territory Feed Channel */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Filtered Feed Channel
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 max-w-md">
						<label
							htmlFor="filtered-channel-select"
							className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground"
						>
							Target Discord Channel
						</label>
						{textChannels.length > 0 ? (
							<Select
								value={ttFilteredChannelId ?? "none"}
								onValueChange={(val) =>
									setTtFilteredChannelId(val === "none" ? null : val)
								}
							>
								<SelectTrigger
									id="filtered-channel-select"
									className="w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
								>
									<SelectValue placeholder="-- No Channel Selected --" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
									<SelectGroup>
										<SelectItem value="none">
											<span className="text-muted-foreground italic">
												-- No Channel Selected --
											</span>
										</SelectItem>
										{textChannels.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												#{c.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						) : (
							<Input
								id="filtered-channel-select"
								type="text"
								value={ttFilteredChannelId ?? ""}
								onChange={(e) => setTtFilteredChannelId(e.target.value || null)}
								placeholder="Enter Discord Channel ID"
								className="font-mono text-xs rounded-xl"
							/>
						)}
					</div>
				</CardContent>
			</Card>

			{/* 3. Target Territory Codes */}
			<Card className="relative z-20 border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Target Territory Codes
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 max-w-md relative">
						<div className="flex gap-2.5 items-center">
							<div className="relative flex-1">
								<Input
									id="territory-search-input"
									type="text"
									value={searchQuery}
									onChange={(e) => {
										setSearchQuery(e.target.value);
										setShowDropdown(true);
									}}
									onFocus={() => setShowDropdown(true)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleAddCode(searchQuery.trim().toUpperCase());
										}
									}}
									placeholder="Search territory code (e.g. AAA)..."
									className="h-10 font-mono uppercase rounded-xl text-xs pr-8"
								/>
								{isSearchingTerritories && (
									<Loader2 className="size-4 animate-spin text-muted-foreground absolute right-2.5 top-3" />
								)}
							</div>
							<Button
								type="button"
								onClick={() => handleAddCode(searchQuery.trim().toUpperCase())}
								disabled={!searchQuery.trim()}
								className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
							>
								<Plus className="size-4" data-icon="inline-start" />
								Add Code
							</Button>
						</div>

						{/* Asynchronous Search Results Dropdown Menu */}
						{showDropdown && searchQuery.trim().length > 0 && (
							<div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl">
								{isSearchingTerritories ? (
									<div className="p-3 text-center text-xs text-muted-foreground flex items-center justify-center gap-2 font-mono">
										<Loader2 className="size-3.5 animate-spin" />
										Searching database...
									</div>
								) : searchResults.length === 0 ? (
									<div className="p-3 text-center text-xs text-muted-foreground font-mono">
										No matching DB territory found. Click Add to add "
										{searchQuery.trim().toUpperCase()}".
									</div>
								) : (
									searchResults.map((t) => (
										<button
											key={t.id}
											type="button"
											onClick={() => {
												handleAddCode(t.id);
											}}
											className="w-full text-left px-3 py-2 text-xs rounded-lg hover:bg-accent hover:text-accent-foreground flex items-center justify-between font-mono cursor-pointer transition-colors"
										>
											<span className="font-bold text-foreground">{t.id}</span>
											<span className="text-[11px] text-muted-foreground font-sans">
												{t.sector != null ? `Sector ${t.sector}` : ""}
												{t.size != null ? ` • Size ${t.size}` : ""}
												{t.density != null ? ` • Density ${t.density}` : ""}
											</span>
										</button>
									))
								)}
							</div>
						)}
					</div>

					<div className="flex flex-wrap gap-2">
						{ttTerritoryIds.length === 0 ? (
							<p className="text-xs text-muted-foreground italic">
								No territory codes configured.
							</p>
						) : (
							ttTerritoryIds.map((id) => (
								<Badge
									key={id}
									variant="secondary"
									className="pl-3 pr-1.5 py-1 rounded-xl text-xs font-mono font-medium flex items-center gap-1.5 border border-border"
								>
									<span>{id}</span>
									<button
										type="button"
										onClick={() => handleRemoveTerritory(id)}
										className="size-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors"
										title="Remove code"
									>
										<X className="size-3" />
									</button>
								</Badge>
							))
						)}
					</div>
				</CardContent>
			</Card>

			{/* 4. Target Faction IDs */}
			<Card className="relative z-10 border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Target Faction IDs
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex gap-2.5 max-w-md items-center">
						<Input
							type="number"
							value={newFactionInput}
							onChange={(e) => setNewFactionInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									void handleAddFaction();
								}
							}}
							placeholder="Enter Faction ID (e.g. 8807)"
							className="flex-1 h-10 font-mono rounded-xl text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						/>
						<Button
							type="button"
							onClick={() => void handleAddFaction()}
							disabled={isResolvingFaction || !newFactionInput.trim()}
							className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
						>
							{isResolvingFaction ? (
								<Loader2
									className="size-4 animate-spin"
									data-icon="inline-start"
								/>
							) : (
								<Plus className="size-4" data-icon="inline-start" />
							)}
							Add Faction
						</Button>
					</div>

					<div className="flex flex-wrap gap-2">
						{ttFactionIds.length === 0 ? (
							<p className="text-xs text-muted-foreground italic">
								No target faction IDs configured.
							</p>
						) : (
							ttFactionIds.map((id) => {
								const meta = factionNamesMap[id];
								const displayName = meta
									? `${meta.name}${meta.tag ? ` [${meta.tag}]` : ""} (${id})`
									: `Faction ${id}`;
								return (
									<Badge
										key={id}
										variant="secondary"
										className="pl-3 pr-1.5 py-1 rounded-xl text-xs font-mono font-medium flex items-center gap-1.5 border border-border"
									>
										<span>{displayName}</span>
										<button
											type="button"
											onClick={() => handleRemoveFaction(id)}
											className="size-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors"
											title="Remove faction"
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
