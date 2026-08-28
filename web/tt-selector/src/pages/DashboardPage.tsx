import { FolderKanban, LogOut, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import logoImg from "../../public/logo.png";

import { ConflictDialog } from "../components/painter/ConflictDialog";

import { HoverTooltip } from "../components/painter/HoverTooltip";
import { MapManagerModal } from "../components/painter/MapManagerModal";
import { MapSidebar } from "../components/painter/MapSidebar";
import {
	type MapLabel,
	TacticalMapCanvas,
	type TerritoryMetadataResponse,
	type UserMap,
} from "../components/painter/TacticalMapCanvas";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";
import type { RewardInfo } from "../lib/racket-utils";

const DEFAULT_LABELS: MapLabel[] = [
	{
		id: "faction-1",
		text: "Faction 1",
		color: "#3b82f6",
		enabled: true,
		territories: [],
		respect: 0,
		sectors: 0,
		rackets: 0,
	},
	{
		id: "faction-2",
		text: "Faction 2",
		color: "#ef4444",
		enabled: true,
		territories: [],
		respect: 0,
		sectors: 0,
		rackets: 0,
	},
];

export function DashboardPage() {
	const { user, logout } = useAuth();
	const { toast } = useToast();

	const [metadata, setMetadata] = useState<TerritoryMetadataResponse | null>(
		null,
	);
	const [maps, setMaps] = useState<UserMap[]>([]);
	const [currentMap, setCurrentMap] = useState<UserMap>({
		name: "Default",
		labels: DEFAULT_LABELS,
		assignments: {},
	});

	const [initialMapState, setInitialMapState] = useState<string>("");
	const [selectedLabelId, setSelectedLabelId] = useState<string | null>(
		DEFAULT_LABELS[0]?.id ?? null,
	);
	const [isSaving, setIsSaving] = useState(false);
	const [isMapManagerOpen, setIsMapManagerOpen] = useState(false);
	const [isCanvasReady, setIsCanvasReady] = useState(false);

	const isPageReady = Boolean(metadata) && isCanvasReady;
	const handleMapReady = useCallback(() => setIsCanvasReady(true), []);

	// Conflict dialog state
	const [conflictData, setConflictData] = useState<{
		territoryId: string;
		currentLabel: MapLabel;
		newLabel: MapLabel;
	} | null>(null);

	// Hover tooltip state
	const [hoveredData, setHoveredData] = useState<{
		data: {
			territoryId: string;
			sector: number;
			respect: number;
			size?: number;
			density?: number;
			slots?: number;
			racket?: {
				name: string;
				rewardInfo: RewardInfo | null;
				dailyValue: number;
			};
			assignedLabel?: {
				text: string;
				color: string;
			};
		} | null;
		mousePos: { x: number; y: number };
	}>({ data: null, mousePos: { x: 0, y: 0 } });

	// Fetch metadata & user maps on mount
	const fetchData = useCallback(async () => {
		try {
			const metaRes = await api.api.v1.tt.metadata.get();
			if (metaRes.data && "territories" in metaRes.data) {
				setMetadata(metaRes.data as unknown as TerritoryMetadataResponse);
			} else {
				toast("Failed to load territory metadata from database.", "error");
			}

			const mapsRes = await api.api.v1.tt.maps.get();
			if (mapsRes.data && "maps" in mapsRes.data) {
				const userMaps = mapsRes.data.maps as unknown as UserMap[];
				setMaps(userMaps);
				if (userMaps.length > 0 && userMaps[0]) {
					const firstMap = userMaps[0];
					setCurrentMap(firstMap);
					setInitialMapState(JSON.stringify(firstMap));
					if (firstMap.labels.length > 0 && firstMap.labels[0]) {
						setSelectedLabelId(firstMap.labels[0].id);
					}
				} else {
					const initial = {
						name: "Default",
						labels: DEFAULT_LABELS,
						assignments: {},
					};
					setCurrentMap(initial);
					setInitialMapState(JSON.stringify(initial));
				}
			}
		} catch {
			toast("Failed to load map data from server.", "error");
		}
	}, [toast]);

	useEffect(() => {
		void fetchData();
	}, [fetchData]);

	// Derive assignments directly from enabled labels
	const assignments = useMemo(() => {
		const result: Record<string, string> = {};
		for (const label of currentMap.labels) {
			if (label.enabled) {
				for (const tid of label.territories) {
					result[tid] = label.id;
				}
			}
		}
		return result;
	}, [currentMap.labels]);

	// Dirty tracking
	const isDirty = useMemo(() => {
		return (
			JSON.stringify({
				name: currentMap.name,
				labels: currentMap.labels,
			}) !==
			(initialMapState
				? JSON.stringify({
						name: JSON.parse(initialMapState).name,
						labels: JSON.parse(initialMapState).labels,
					})
				: "")
		);
	}, [currentMap, initialMapState]);

	// Handle territory click from Leaflet map
	const handleTerritoryClick = useCallback(
		(territoryId: string) => {
			if (!selectedLabelId) {
				toast("Please select an active faction layer first.", "warning");
				return;
			}

			const activeLabel = currentMap.labels.find(
				(l) => l.id === selectedLabelId,
			);
			if (!activeLabel) return;

			// 1. If territory is already in the selected label -> unpaint it
			if (activeLabel.territories.includes(territoryId)) {
				setCurrentMap((prev) => ({
					...prev,
					labels: prev.labels.map((l) =>
						l.id === selectedLabelId
							? {
									...l,
									territories: l.territories.filter(
										(tid) => tid !== territoryId,
									),
								}
							: l,
					),
				}));
				return;
			}

			// 2. Check if territory is already claimed by another faction
			const existingOwner = currentMap.labels.find(
				(l) => l.id !== selectedLabelId && l.territories.includes(territoryId),
			);

			if (existingOwner) {
				setConflictData({
					territoryId,
					currentLabel: existingOwner,
					newLabel: activeLabel,
				});
				return;
			}

			// 3. Paint cleanly into active label
			setCurrentMap((prev) => ({
				...prev,
				labels: prev.labels.map((l) =>
					l.id === selectedLabelId
						? { ...l, territories: [...l.territories, territoryId] }
						: l,
				),
			}));
		},
		[selectedLabelId, currentMap.labels, toast],
	);

	// Confirm reassignment across factions
	const handleConfirmReassign = () => {
		if (!conflictData) return;
		const { territoryId, currentLabel, newLabel } = conflictData;

		setCurrentMap((prev) => ({
			...prev,
			labels: prev.labels.map((l) => {
				if (l.id === currentLabel.id) {
					return {
						...l,
						territories: l.territories.filter((tid) => tid !== territoryId),
					};
				}
				if (l.id === newLabel.id) {
					return {
						...l,
						territories: [...l.territories, territoryId],
					};
				}
				return l;
			}),
		}));

		toast(`Transferred ${territoryId} to ${newLabel.text}.`, "success");
		setConflictData(null);
	};

	// Save map to database
	const handleSaveMap = async () => {
		setIsSaving(true);
		try {
			const res = await api.api.v1.tt.maps.post({
				mapId: currentMap.id,
				name: currentMap.name,
				labels: currentMap.labels,
				assignments,
			});

			if (res.data && "map" in res.data) {
				const savedMap = res.data.map as unknown as UserMap;
				setCurrentMap(savedMap);
				setInitialMapState(JSON.stringify(savedMap));

				setMaps((prev) => {
					const idx = prev.findIndex((m) => m.id === savedMap.id);
					if (idx >= 0) {
						const updated = [...prev];
						updated[idx] = savedMap;
						return updated;
					}
					return [savedMap, ...prev];
				});

				toast("Territory map saved successfully!", "success");
			} else {
				toast("Failed to save map.", "error");
			}
		} catch {
			toast("An unexpected error occurred while saving.", "error");
		} finally {
			setIsSaving(false);
		}
	};

	// Faction Layer Management Handlers
	const handleUpdateLabel = (
		labelId: string,
		updater: (prev: MapLabel) => MapLabel,
	) => {
		setCurrentMap((prev) => ({
			...prev,
			labels: prev.labels.map((l) => (l.id === labelId ? updater(l) : l)),
		}));
	};

	const handleAddLabel = () => {
		const count = currentMap.labels.length + 1;
		const newLabel: MapLabel = {
			id: `faction-${Date.now()}`,
			text: `Faction ${count}`,
			color: `#${Math.floor(Math.random() * 16777215)
				.toString(16)
				.padStart(6, "0")}`,
			enabled: true,
			territories: [],
			respect: 0,
			sectors: 0,
			rackets: 0,
		};

		setCurrentMap((prev) => ({
			...prev,
			labels: [...prev.labels, newLabel],
		}));
		setSelectedLabelId(newLabel.id);
		toast(`Added ${newLabel.text}`, "info");
	};

	const handleDeleteLabel = (labelId: string) => {
		setCurrentMap((prev) => ({
			...prev,
			labels: prev.labels.filter((l) => l.id !== labelId),
		}));
		if (selectedLabelId === labelId) {
			const remaining = currentMap.labels.filter((l) => l.id !== labelId);
			setSelectedLabelId(remaining[0]?.id ?? null);
		}
	};

	const handleRemoveTerritoryFromLabel = (
		labelId: string,
		territoryId: string,
	) => {
		setCurrentMap((prev) => ({
			...prev,
			labels: prev.labels.map((l) =>
				l.id === labelId
					? {
							...l,
							territories: l.territories.filter((tid) => tid !== territoryId),
						}
					: l,
			),
		}));
	};

	// Map Management Modal Handlers
	const handleCreateNewMap = (name: string) => {
		const newMap: UserMap = {
			name,
			labels: DEFAULT_LABELS,
			assignments: {},
		};
		setCurrentMap(newMap);
		setInitialMapState(JSON.stringify(newMap));
		setSelectedLabelId(DEFAULT_LABELS[0]?.id ?? null);
		setIsMapManagerOpen(false);
		toast(`Created new map: "${name}"`, "success");
	};

	const handleDuplicateMap = (source: UserMap) => {
		const duplicate: UserMap = {
			name: `${source.name} (Copy)`,
			labels: JSON.parse(JSON.stringify(source.labels)),
			assignments: { ...source.assignments },
		};
		setCurrentMap(duplicate);
		setInitialMapState(JSON.stringify(duplicate));
		setSelectedLabelId(duplicate.labels[0]?.id ?? null);
		setIsMapManagerOpen(false);
		toast(`Cloned map: "${duplicate.name}"`, "info");
	};

	const handleRenameMap = (mapId: string, newName: string) => {
		if (currentMap.id === mapId) {
			setCurrentMap((prev) => ({ ...prev, name: newName }));
		}
		setMaps((prev) =>
			prev.map((m) => (m.id === mapId ? { ...m, name: newName } : m)),
		);
	};

	const handleDeleteMap = async (mapId: string) => {
		try {
			await api.api.v1.tt.maps({ mapId }).delete();
			setMaps((prev) => prev.filter((m) => m.id !== mapId));

			if (currentMap.id === mapId) {
				const remaining = maps.filter((m) => m.id !== mapId);
				if (remaining.length > 0 && remaining[0]) {
					setCurrentMap(remaining[0]);
					setInitialMapState(JSON.stringify(remaining[0]));
				} else {
					handleCreateNewMap("Default");
				}
			}
			toast("Map deleted.", "info");
		} catch {
			toast("Failed to delete map.", "error");
		}
	};

	const handleImportMap = (imported: UserMap) => {
		setCurrentMap(imported);
		setInitialMapState(JSON.stringify(imported));
		setSelectedLabelId(imported.labels[0]?.id ?? null);
		setIsMapManagerOpen(false);
		toast(`Imported "${imported.name}" successfully!`, "success");
	};

	return (
		<div className="w-screen h-screen flex flex-col bg-[#07090e] text-zinc-100 overflow-hidden font-sans">
			{/* Top Tactical Command Header */}
			<header className="h-14 border-b border-border/80 bg-[#0d1117]/95 backdrop-blur-md px-4 flex items-center justify-between gap-4 z-40 shrink-0">
				{/* Brand / Logo */}
				<div className="flex items-center gap-3">
					<img
						src={logoImg}
						alt="Sentinel Logo"
						className="size-8 rounded-xl object-contain drop-shadow"
					/>
					<div>
						<div className="flex items-center gap-2">
							<span className="font-extrabold text-sm tracking-wider text-zinc-100 uppercase">
								TT Selector
							</span>
						</div>
					</div>
				</div>

				{/* Center Quick Stats / Active Brush Pill */}
				<div className="hidden md:flex items-center gap-3">
					<div className="px-3 py-1 rounded-xl bg-zinc-900/90 border border-border flex items-center gap-2 text-xs font-mono">
						<span className="text-zinc-500 text-[11px]">ACTIVE:</span>
						{selectedLabelId ? (
							<span
								className="font-bold flex items-center gap-1.5"
								style={{
									color:
										currentMap.labels.find((l) => l.id === selectedLabelId)
											?.color ?? "#f59e0b",
								}}
							>
								<span
									className="size-2.5 rounded-full"
									style={{
										backgroundColor:
											currentMap.labels.find((l) => l.id === selectedLabelId)
												?.color ?? "#f59e0b",
									}}
								/>
								{currentMap.labels.find((l) => l.id === selectedLabelId)?.text}
							</span>
						) : (
							<span className="text-zinc-500">None Selected</span>
						)}
					</div>
				</div>

				{/* Right Navigation & User Status */}
				<div className="flex items-center gap-3">
					{/* Map Manager Button */}
					<button
						type="button"
						onClick={() => setIsMapManagerOpen(true)}
						className="px-3 py-1.5 rounded-xl border border-border bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
					>
						<FolderKanban className="size-3.5 text-amber-400" />
						<span className="hidden sm:inline">Maps</span>
					</button>

					{/* Logged in User Profile */}
					<div className="flex items-center gap-2 pl-2 border-l border-border/60">
						{user?.avatar ? (
							<img
								src={user.avatar}
								alt={user.username ?? "User Avatar"}
								className="size-7 rounded-full object-cover border border-border shrink-0"
							/>
						) : (
							<div className="size-7 rounded-full bg-zinc-800 border border-border flex items-center justify-center text-xs font-mono text-zinc-300 shrink-0">
								{user?.username ? (
									user.username[0]?.toUpperCase()
								) : (
									<User className="size-3.5" />
								)}
							</div>
						)}
						<div className="hidden lg:block text-left">
							<span className="block text-xs font-semibold text-zinc-200 leading-none">
								{user?.username ?? ""}
							</span>
						</div>

						<button
							type="button"
							onClick={() => void logout()}
							title="Sign Out"
							className="size-8 rounded-lg hover:bg-destructive/20 text-zinc-400 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors ml-1"
						>
							<LogOut className="size-3.5" />
						</button>
					</div>
				</div>
			</header>

			{/* Main Tactical Workspace */}
			<div className="flex-1 flex overflow-hidden relative">
				{/* Sidebar */}
				<MapSidebar
					currentMap={currentMap}
					metadata={metadata}
					selectedLabelId={selectedLabelId}
					isSaving={isSaving}
					isDirty={isDirty}
					onSelectLabel={(id) => setSelectedLabelId(id)}
					onUpdateLabel={handleUpdateLabel}
					onAddLabel={handleAddLabel}
					onDeleteLabel={handleDeleteLabel}
					onRemoveTerritoryFromLabel={handleRemoveTerritoryFromLabel}
					onOpenMapManager={() => setIsMapManagerOpen(true)}
					onSaveMap={() => void handleSaveMap()}
				/>

				{/* Map Canvas */}
				<main className="flex-1 h-full relative">
					<TacticalMapCanvas
						metadata={metadata}
						labels={currentMap.labels}
						assignments={assignments}
						selectedLabelId={selectedLabelId}
						onMapReady={handleMapReady}
						onTerritoryClick={handleTerritoryClick}
						onHoverChange={(data, mousePos) =>
							setHoveredData({ data, mousePos })
						}
					/>

					{/* Hover Tooltip Overlay */}
					{hoveredData.data && (
						<HoverTooltip
							visible={Boolean(hoveredData.data)}
							x={hoveredData.mousePos.x}
							y={hoveredData.mousePos.y}
							territoryId={hoveredData.data.territoryId}
							sector={hoveredData.data.sector}
							respect={hoveredData.data.respect}
							size={hoveredData.data.size}
							density={hoveredData.data.density}
							slots={hoveredData.data.slots}
							racket={hoveredData.data.racket}
							assignedLabel={hoveredData.data.assignedLabel}
						/>
					)}
				</main>
			</div>

			{/* Global Tactical HUD Loading Overlay */}
			{!isPageReady && (
				<div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#07090e] select-none">
					<div className="relative flex flex-col items-center gap-6">
						{/* Tactical Brand */}
						<div className="flex items-center gap-3">
							<img
								src={logoImg}
								alt="Sentinel Logo"
								className="size-10 rounded-xl object-contain drop-shadow-lg"
							/>
							<span className="font-extrabold text-base tracking-widest text-zinc-100 uppercase font-mono">
								TT Selector
							</span>
						</div>
					</div>
				</div>
			)}

			{/* Conflict Dialog */}
			{conflictData && (
				<ConflictDialog
					isOpen={Boolean(conflictData)}
					targetTerritoryId={conflictData.territoryId}
					currentOwnerLabelName={conflictData.currentLabel.text}
					newOwnerLabelName={conflictData.newLabel.text}
					onConfirmReassign={handleConfirmReassign}
					onCancel={() => setConflictData(null)}
				/>
			)}

			{/* Map Manager Modal */}
			<MapManagerModal
				isOpen={isMapManagerOpen}
				maps={maps}
				activeMapId={currentMap.id ?? null}
				onClose={() => setIsMapManagerOpen(false)}
				onSelectMap={(selected) => {
					setCurrentMap(selected);
					setInitialMapState(JSON.stringify(selected));
					if (selected.labels.length > 0 && selected.labels[0]) {
						setSelectedLabelId(selected.labels[0].id);
					}
				}}
				onCreateNewMap={handleCreateNewMap}
				onDuplicateMap={handleDuplicateMap}
				onRenameMap={handleRenameMap}
				onDeleteMap={(id) => void handleDeleteMap(id)}
				onImportMap={handleImportMap}
			/>
		</div>
	);
}
