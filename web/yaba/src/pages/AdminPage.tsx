import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { FetchError } from "@/components/FetchError";
import { PageHeader } from "@/components/PageHeader";
import { PageLoader } from "@/components/PageLoader";
import { ScrollX } from "@/components/ScrollX";
import { SectionCard } from "@/components/SectionCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { describeError } from "@/lib/format";
import type { AdminFactionRow, FactionType } from "@/lib/types";

export function AdminPage() {
	const { isAdmin, authenticated } = useAuth();
	const [factions, setFactions] = useState<AdminFactionRow[]>([]);
	const [factionChannelId, setFactionChannelId] = useState("");
	const [playerChannelId, setPlayerChannelId] = useState("");
	const [newId, setNewId] = useState("");
	const [newName, setNewName] = useState("");
	const [newType, setNewType] = useState<FactionType>("combat");
	const [collectKind, setCollectKind] = useState<"nightly" | "backfill">(
		"nightly",
	);
	const [pendingCollect, setPendingCollect] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function loadAdminData() {
		const [factionsRes, channelsRes] = await Promise.all([
			api.v2.yaba.admin.factions.get(),
			api.v2.yaba.admin.channels.get(),
		]);
		if (factionsRes.error) {
			setError(describeError(factionsRes.error) ?? "Unable to load factions.");
		} else if (
			factionsRes.data &&
			"factions" in factionsRes.data &&
			Array.isArray(factionsRes.data.factions)
		) {
			setFactions(factionsRes.data.factions);
		}
		if (channelsRes.error) {
			setError(describeError(channelsRes.error) ?? "Unable to load channels.");
		} else if (channelsRes.data && "factionChannelId" in channelsRes.data) {
			setFactionChannelId(channelsRes.data.factionChannelId ?? "");
			setPlayerChannelId(channelsRes.data.playerChannelId ?? "");
		}
	}

	useEffect(() => {
		if (!isAdmin) return;
		let active = true;
		setLoading(true);
		void loadAdminData()
			.catch((cause: unknown) => {
				if (active)
					setError(describeError(cause) ?? "Unable to load admin data.");
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [isAdmin]);

	if (!isAdmin) {
		return (
			<>
				<PageHeader
					title="Administration"
					description="Manage tracked factions, collection runs and chart channels."
					icon={ShieldCheck}
				/>
				<EmptyState
					title={authenticated ? "Admin access required" : "Sign in required"}
					description={
						authenticated
							? "Only alliance administrators can change YABA settings."
							: "Sign in with Discord to access these controls."
					}
				/>
			</>
		);
	}

	function runGuarded(task: () => Promise<void>) {
		setBusy(true);
		setError(null);
		setNotice(null);
		void task()
			.catch((cause: unknown) => {
				setError(describeError(cause) ?? "The request failed.");
			})
			.finally(() => setBusy(false));
	}

	function addFaction() {
		const parsedId = Number(newId);
		if (!Number.isInteger(parsedId) || parsedId <= 0) {
			setError("Enter a valid numeric faction ID.");
			return;
		}
		runGuarded(async () => {
			const res = await api.v2.yaba.admin.factions.post({
				factionId: parsedId,
				name: newName.trim() || undefined,
				type: newType,
			});
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to add faction.");
				return;
			}
			setNewId("");
			setNewName("");
			setNotice(`Faction ${parsedId} saved.`);
			await loadAdminData();
		});
	}

	function updateFaction(
		faction: AdminFactionRow,
		updates: {
			type?: FactionType;
			enabled?: boolean;
		},
	) {
		runGuarded(async () => {
			const res = await api.v2.yaba.admin
				.factions({
					factionId: faction.factionId,
				})
				.put(updates);
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to update faction.");
				return;
			}
			setNotice(`${faction.name} updated.`);
			await loadAdminData();
		});
	}

	function collect() {
		setPendingCollect(false);
		runGuarded(async () => {
			const res = await api.v2.yaba.admin.collect.run.post({
				kind: collectKind,
			});
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to start collection.");
				return;
			}
			setNotice(`${collectKind} collection requested.`);
		});
	}

	function recompute() {
		runGuarded(async () => {
			const res = await api.v2.yaba.admin.rankings.recompute.post();
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to recompute rankings.");
				return;
			}
			setNotice("Ranking recompute requested.");
		});
	}

	function saveChannels() {
		runGuarded(async () => {
			const res = await api.v2.yaba.admin.channels.put({
				factionChannelId: factionChannelId.trim() || null,
				playerChannelId: playerChannelId.trim() || null,
			});
			if (res.error) {
				setError(describeError(res.error) ?? "Unable to save channels.");
				return;
			}
			setNotice("Chart channels saved.");
		});
	}

	return (
		<>
			<PageHeader
				title="Administration"
				description="Manage tracked factions, collection runs and chart channels."
				icon={ShieldCheck}
				badge={<StatusBadge tone="primary">Admin</StatusBadge>}
			/>

			{error ? <FetchError message={error} /> : null}
			{notice ? <StatusBadge tone="success">{notice}</StatusBadge> : null}
			{loading ? (
				<PageLoader variant="inline" label="Loading settings..." />
			) : null}

			<SectionCard title="Add a faction" description="By Torn faction ID.">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
					<div className="flex w-full flex-col gap-1.5 sm:max-w-40">
						<Label htmlFor="faction-id">Faction ID</Label>
						<Input
							id="faction-id"
							type="number"
							min={1}
							inputMode="numeric"
							value={newId}
							onChange={(event) => setNewId(event.target.value)}
						/>
					</div>
					<div className="flex w-full flex-col gap-1.5">
						<Label htmlFor="faction-name">Name (optional)</Label>
						<Input
							id="faction-name"
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
						/>
					</div>
					<div className="flex w-full flex-col gap-1.5 sm:max-w-40">
						<Label>Type</Label>
						<Select
							value={newType}
							onValueChange={(value) =>
								setNewType(value === "revive" ? "revive" : "combat")
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="combat">Combat</SelectItem>
								<SelectItem value="revive">Revive</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<Button type="button" onClick={addFaction} disabled={busy}>
						Add faction
					</Button>
				</div>
			</SectionCard>

			<SectionCard
				title="Tracked factions"
				description="Switch the report type or disable a faction without deleting its history."
				flush
			>
				<ScrollX>
					<Table className="min-w-[640px]">
						<TableHeader>
							<TableRow>
								<TableHead>Faction</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{factions.map((faction) => (
								<TableRow key={faction.factionId}>
									<TableCell className="min-w-0 max-w-[260px] truncate font-medium">
										{faction.name}
									</TableCell>
									<TableCell>
										<Button
											type="button"
											variant="outline"
											size="xs"
											disabled={busy}
											onClick={() =>
												updateFaction(faction, {
													type: faction.type === "combat" ? "revive" : "combat",
												})
											}
										>
											{faction.type === "combat" ? "Combat" : "Revive"}
										</Button>
									</TableCell>
									<TableCell>
										<StatusBadge tone={faction.enabled ? "success" : "neutral"}>
											{faction.enabled ? "Enabled" : "Disabled"}
										</StatusBadge>
									</TableCell>
									<TableCell className="text-right">
										<Button
											type="button"
											variant="ghost"
											size="xs"
											disabled={busy}
											onClick={() =>
												updateFaction(faction, { enabled: !faction.enabled })
											}
										>
											{faction.enabled ? "Disable" : "Enable"}
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</ScrollX>
			</SectionCard>

			<SectionCard
				title="Collector & rankings"
				description="Force a collection pass or rebuild the ranking snapshots."
			>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
					<div className="flex w-full flex-col gap-1.5 sm:max-w-48">
						<Label>Collection kind</Label>
						<Select
							value={collectKind}
							onValueChange={(value) =>
								setCollectKind(value === "backfill" ? "backfill" : "nightly")
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="nightly">Nightly</SelectItem>
								<SelectItem value="backfill">Backfill</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => setPendingCollect(true)}
					>
						Run collection
					</Button>
					<Button type="button" disabled={busy} onClick={recompute}>
						Recompute rankings
					</Button>
				</div>
			</SectionCard>

			<SectionCard
				title="Chart channels"
				description="Discord channel IDs that receive the faction and player charts."
			>
				<div className="flex flex-col gap-4">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex w-full flex-col gap-1.5">
							<Label htmlFor="faction-channel">Faction chart channel ID</Label>
							<Input
								id="faction-channel"
								className="font-mono"
								value={factionChannelId}
								onChange={(event) => setFactionChannelId(event.target.value)}
							/>
						</div>
						<div className="flex w-full flex-col gap-1.5">
							<Label htmlFor="player-channel">Player chart channel ID</Label>
							<Input
								id="player-channel"
								className="font-mono"
								value={playerChannelId}
								onChange={(event) => setPlayerChannelId(event.target.value)}
							/>
						</div>
					</div>
					<Button type="button" disabled={busy} onClick={saveChannels}>
						Save channels
					</Button>
				</div>
			</SectionCard>

			<ConfirmDialog
				open={pendingCollect}
				onOpenChange={setPendingCollect}
				title={`Run ${collectKind} collection?`}
				description="This queues a worker run on the API. Existing snapshots stay published until the run completes."
				confirmLabel="Run now"
				tone="default"
				onConfirm={collect}
			/>
		</>
	);
}
