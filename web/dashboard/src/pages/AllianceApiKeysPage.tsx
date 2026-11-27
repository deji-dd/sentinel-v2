import { KeyRound, Loader2, Plus, RotateCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ChannelSelect, type DiscordChannel } from "@/components/ChannelSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";

interface AllianceKey {
	id: string;
	tornId: number;
	tornName: string;
	isValid: boolean;
	invalidCount: number;
	donatedByDiscordId?: string | null;
	donatedByDiscordTag?: string | null;
	lastUsedAt?: string | Date | null;
	createdAt: string | Date;
}

function extractApiError(error: unknown, fallback: string): string {
	if (typeof error === "object" && error !== null && "value" in error) {
		const value = (error as { value?: { error?: string } }).value;
		if (typeof value?.error === "string") return value.error;
	}
	return fallback;
}

const PAGE_SIZE = 10;

function isPlaceholderName(name: string | null | undefined, tornId: number) {
	const trimmed = name?.trim();
	return !trimmed || trimmed === `Player ${tornId}`;
}

export function AllianceApiKeysPage({ guildId }: { guildId: string }) {
	const { toast } = useToast();
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [keys, setKeys] = useState<AllianceKey[]>([]);
	const [channels, setChannels] = useState<DiscordChannel[]>([]);
	const [channelId, setChannelId] = useState("");
	const [newKey, setNewKey] = useState("");
	const [page, setPage] = useState(1);
	const [healingNames, setHealingNames] = useState(false);

	const load = useCallback(async (): Promise<AllianceKey[] | null> => {
		try {
			const [poolRes, channelRes, channelsRes] = await Promise.all([
				api.v2.alliance["key-pool"].get(),
				api.v2.alliance["key-donation-channel"].get(),
				api.v2.guilds({ guildId }).channels.get(),
			]);
			let loadedKeys: AllianceKey[] | null = null;
			if (poolRes.data && "keys" in poolRes.data) {
				loadedKeys = (poolRes.data.keys as AllianceKey[]) ?? [];
				setKeys(loadedKeys);
				setPage(1);
			}
			if (channelRes.data && "channelId" in channelRes.data) {
				setChannelId(channelRes.data.channelId ?? "");
			}
			if (channelsRes.data && "channels" in channelsRes.data) {
				setChannels(channelsRes.data.channels);
			}
			return loadedKeys;
		} catch {
			toast("Failed to load the Alliance key pool.", "error");
			return null;
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	const resolveNames = async () => {
		setHealingNames(true);
		try {
			const res = await api.v2.alliance["key-pool"]["resolve-names"].post();
			if (res.error) return;
			const healed =
				res.data && "healed" in res.data ? Number(res.data.healed) : 0;
			if (healed > 0) {
				toast(
					`Resolved ${healed} player name${healed === 1 ? "" : "s"}.`,
					"success",
				);
			}
		} finally {
			setHealingNames(false);
		}
	};

	useEffect(() => {
		void (async () => {
			const loaded = await load();
			if (loaded?.some((key) => isPlaceholderName(key.tornName, key.tornId))) {
				await resolveNames();
				await load();
			}
		})();
		// Initial load only; subsequent loads happen after explicit mutations.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [load]);

	const saveChannel = async () => {
		setBusy(true);
		try {
			const res = await api.v2.alliance["key-donation-channel"].put({
				channelId: channelId || null,
			});
			if (res.error) {
				toast(
					extractApiError(res.error, "Failed to save donation channel."),
					"error",
				);
				return;
			}
			toast("Key donation channel saved. Embed syncing.", "success");
			await load();
		} finally {
			setBusy(false);
		}
	};

	const syncEmbed = async () => {
		setBusy(true);
		try {
			const res = await api.v2.alliance["key-donation-channel"].sync.post();
			if (res.error) {
				toast("Failed to sync donation embed.", "error");
				return;
			}
			toast("Donation embed refresh dispatched.", "success");
		} finally {
			setBusy(false);
		}
	};

	const addKey = async () => {
		const key = newKey.trim();
		if (key.length !== 16) {
			toast("Torn API key must be 16 characters.", "error");
			return;
		}
		setBusy(true);
		try {
			const res = await api.v2.alliance["key-pool"].post({ apiKey: key });
			if (res.error) {
				toast(extractApiError(res.error, "Failed to add key."), "error");
				return;
			}
			toast("Public key added to the Alliance pool.", "success");
			setNewKey("");
			await load();
		} finally {
			setBusy(false);
		}
	};

	const deleteKey = async (id: string) => {
		setBusy(true);
		try {
			const res = await api.v2.alliance["key-pool"]({ id }).delete();
			if (res.error) {
				toast("Failed to remove key.", "error");
				return;
			}
			toast("Key removed from the Alliance pool.", "info");
			await load();
		} finally {
			setBusy(false);
		}
	};

	const totalPages = Math.max(1, Math.ceil(keys.length / PAGE_SIZE));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * PAGE_SIZE;
	const visibleKeys = keys.slice(start, start + PAGE_SIZE);

	if (loading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-64 w-full rounded-2xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 pb-12">
			<div className="pb-6 border-b border-border/60">
				<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
					Alliance API Keys
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Public-only keys powering Alliance features. Members can donate
					through the persistent embed once a donation channel is configured.
				</p>
			</div>

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40 space-y-1">
					<CardTitle className="text-lg font-semibold tracking-tight flex items-center gap-2">
						Key Donation Channel
					</CardTitle>
					<p className="text-xs text-muted-foreground">
						The bot posts and maintains the donation embed in this channel.
					</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 flex flex-col max-w-md">
						<ChannelSelect
							channels={channels}
							allowedTypes={[0]}
							value={channelId}
							onValueChange={(val) => setChannelId(val === "none" ? "" : val)}
							noneLabel="-- No Donation Channel --"
							placeholder="-- No Donation Channel --"
							triggerClassName="w-full h-10 rounded-xl bg-background border-input text-sm"
						/>
						<div className="flex gap-2">
							<Button
								type="button"
								onClick={() => void saveChannel()}
								disabled={busy}
								className="h-9 rounded-xl text-xs font-semibold cursor-pointer"
							>
								<Save className="size-3.5 mr-1.5" />
								Save Channel
							</Button>
							<Button
								type="button"
								variant="outline"
								onClick={() => void syncEmbed()}
								disabled={busy || !channelId}
								className="h-9 rounded-xl text-xs font-semibold cursor-pointer"
							>
								<RotateCw className="size-3.5 mr-1.5" />
								Sync Embed
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl">
				<CardHeader className="border-b border-border/40 space-y-1">
					<CardTitle className="text-lg font-semibold tracking-tight flex items-center gap-2">
						Key Pool ({keys.length})
						{healingNames && (
							<span className="text-[10px] font-normal text-muted-foreground">
								Resolving player names…
							</span>
						)}
					</CardTitle>
					<p className="text-xs text-muted-foreground">
						Imported system keys and member donations appear here. Every key is
						verified as Public Only before it is stored.
					</p>
				</CardHeader>
				<CardContent className="space-y-5">
					<div className="flex flex-col sm:flex-row gap-2.5 max-w-lg items-center">
						<div className="relative w-full">
							<KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
							<Input
								type="password"
								value={newKey}
								onChange={(e) => setNewKey(e.target.value)}
								placeholder="16-char Public Only Torn API key"
								className="pl-9 font-mono text-xs rounded-xl h-10"
								maxLength={16}
							/>
						</div>
						<Button
							type="button"
							onClick={() => void addKey()}
							disabled={busy || newKey.trim().length !== 16}
							className="h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
						>
							{busy ? (
								<Loader2 className="size-4 mr-1 animate-spin" />
							) : (
								<Plus className="size-4 mr-1" />
							)}
							Add Key
						</Button>
					</div>

					{keys.length === 0 ? (
						<p className="text-xs text-muted-foreground italic py-2">
							No keys yet. Donations and imported keys will show up here.
						</p>
					) : (
						<div className="grid grid-cols-1 gap-2.5">
							{visibleKeys.map((key) => (
								<div
									key={key.id}
									className="p-3 rounded-xl border border-border/70 bg-background/50 flex items-center justify-between gap-3 text-xs"
								>
									<div className="min-w-0">
										<span className="font-medium">{key.tornName}</span>{" "}
										<span className="font-mono text-[10px] text-muted-foreground">
											[{key.tornId}]
										</span>
										<Badge
											variant="outline"
											className={`ml-2 text-[9px] font-mono px-1.5 py-0 ${
												key.isValid
													? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
													: "text-rose-400 border-rose-500/30 bg-rose-500/10"
											}`}
										>
											{key.isValid ? "Valid" : `Invalid (${key.invalidCount})`}
										</Badge>
										{key.donatedByDiscordTag && (
											<div className="text-[11px] text-muted-foreground">
												Donated by @{key.donatedByDiscordTag}
											</div>
										)}
										{key.lastUsedAt && (
											<div className="text-[11px] text-muted-foreground">
												Last used{" "}
												{new Date(key.lastUsedAt).toLocaleDateString()}
											</div>
										)}
									</div>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => void deleteKey(key.id)}
										disabled={busy}
										className="size-8 text-muted-foreground hover:text-destructive cursor-pointer"
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							))}
						</div>
					)}

					{keys.length > PAGE_SIZE && (
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-border/40">
							<span className="text-[11px] text-muted-foreground">
								Showing {start + 1}–{Math.min(start + PAGE_SIZE, keys.length)}{" "}
								of {keys.length}
							</span>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setPage((current) => Math.max(1, current - 1))}
									disabled={safePage === 1}
									className="h-8 rounded-lg text-xs cursor-pointer"
								>
									Previous
								</Button>
								<span className="text-xs font-mono text-muted-foreground">
									Page {safePage} / {totalPages}
								</span>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() =>
										setPage((current) => Math.min(totalPages, current + 1))
									}
									disabled={safePage === totalPages}
									className="h-8 rounded-lg text-xs cursor-pointer"
								>
									Next
								</Button>
							</div>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
