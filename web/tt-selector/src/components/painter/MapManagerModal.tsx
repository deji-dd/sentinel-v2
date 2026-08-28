import {
	Copy,
	Download,
	Edit3,
	FolderKanban,
	Plus,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { useState } from "react";
import type { UserMap } from "./TacticalMapCanvas";

interface MapManagerModalProps {
	isOpen: boolean;
	maps: UserMap[];
	activeMapId: string | null;
	onClose: () => void;
	onSelectMap: (map: UserMap) => void;
	onCreateNewMap: (name: string) => void;
	onDuplicateMap: (map: UserMap) => void;
	onRenameMap: (mapId: string, newName: string) => void;
	onDeleteMap: (mapId: string) => void;
	onImportMap: (imported: UserMap) => void;
}

export function MapManagerModal({
	isOpen,
	maps,
	activeMapId,
	onClose,
	onSelectMap,
	onCreateNewMap,
	onDuplicateMap,
	onRenameMap,
	onDeleteMap,
	onImportMap,
}: MapManagerModalProps) {
	const [newMapName, setNewMapName] = useState("");
	const [editingMapId, setEditingMapId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");

	if (!isOpen) return null;

	const handleCreate = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = newMapName.trim();
		if (!trimmed) return;
		onCreateNewMap(trimmed);
		setNewMapName("");
	};

	const handleStartRename = (map: UserMap) => {
		if (!map.id) return;
		setEditingMapId(map.id);
		setEditingName(map.name);
	};

	const handleSaveRename = (mapId: string) => {
		const trimmed = editingName.trim();
		if (trimmed) {
			onRenameMap(mapId, trimmed);
		}
		setEditingMapId(null);
	};

	const handleExport = (map: UserMap) => {
		const dataStr =
			"data:text/json;charset=utf-8," +
			encodeURIComponent(JSON.stringify(map, null, 2));
		const downloadAnchor = document.createElement("a");
		downloadAnchor.setAttribute("href", dataStr);
		downloadAnchor.setAttribute(
			"download",
			`tt-map-${map.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.json`,
		);
		document.body.appendChild(downloadAnchor);
		downloadAnchor.click();
		downloadAnchor.remove();
	};

	const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (event) => {
			try {
				const content = event.target?.result as string;
				const parsed = JSON.parse(content) as UserMap;
				if (parsed.name && Array.isArray(parsed.labels)) {
					onImportMap(parsed);
				}
			} catch {
				// error handled upstream
			}
		};
		reader.readAsText(file);
	};

	return (
		<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
			<div className="w-full max-w-2xl rounded-2xl border border-border/80 bg-[#0d1117] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
				{/* Modal Header */}
				<div className="p-5 border-b border-border/60 flex items-center justify-between bg-zinc-900/50">
					<div className="flex items-center gap-3">
						<div className="size-9 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
							<FolderKanban className="size-5" />
						</div>
						<div>
							<h2 className="font-bold text-base text-zinc-100 font-sans">
								Map Manager
							</h2>
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="size-8 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center cursor-pointer transition-colors"
					>
						<X className="size-4" />
					</button>
				</div>

				{/* Create New Map Input */}
				<div className="p-4 border-b border-border/60 bg-[#090c12]">
					<form onSubmit={handleCreate} className="flex gap-2">
						<input
							type="text"
							value={newMapName}
							onChange={(e) => setNewMapName(e.target.value)}
							placeholder="Enter new map name..."
							className="flex-1 px-3.5 py-2 rounded-xl bg-zinc-900 border border-border text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500 font-sans"
						/>
						<button
							type="submit"
							disabled={!newMapName.trim()}
							className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black flex items-center gap-1.5 cursor-pointer font-sans transition-all shadow-md shadow-amber-500/10"
						>
							<Plus className="size-4" />
							Create Map
						</button>
						<label className="px-3.5 py-2 rounded-xl border border-border bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors">
							<Upload className="size-3.5 text-zinc-400" />
							<span>Import JSON</span>
							<input
								type="file"
								accept=".json"
								onChange={handleFileImport}
								className="hidden"
							/>
						</label>
					</form>
				</div>

				{/* Maps List */}
				<div className="p-4 overflow-y-auto space-y-2 flex-1">
					{maps.length === 0 ? (
						<div className="p-12 text-center text-zinc-500 text-xs font-mono">
							No saved maps found. Create your first territory map above!
						</div>
					) : (
						maps.map((m) => {
							const isEditing = editingMapId === m.id;
							const isActive = activeMapId === m.id;
							const totalTerritories = m.labels.reduce(
								(acc, l) => acc + l.territories.length,
								0,
							);

							return (
								<div
									key={m.id || m.name}
									className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${
										isActive
											? "border-amber-500/60 bg-amber-500/5 shadow-inner"
											: "border-border/60 bg-zinc-900/40 hover:border-zinc-700"
									}`}
								>
									<div className="flex-1 min-w-0">
										{isEditing ? (
											<div className="flex items-center gap-2">
												<input
													type="text"
													value={editingName}
													onChange={(e) => setEditingName(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															m.id && handleSaveRename(m.id);
														}
													}}
													className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-amber-500 text-xs text-zinc-100 font-sans"
												/>
												<button
													type="button"
													onClick={() => m.id && handleSaveRename(m.id)}
													className="px-2 py-1 rounded-lg bg-amber-500 text-black text-[11px] font-bold cursor-pointer"
												>
													Save
												</button>
											</div>
										) : (
											<div className="flex items-center gap-2">
												<span className="font-semibold text-sm text-zinc-200 truncate">
													{m.name}
												</span>
												{isActive && (
													<span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-mono font-bold border border-amber-500/30 uppercase">
														Active
													</span>
												)}
											</div>
										)}
										<div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-400 font-mono">
											<span>{m.labels.length} Factions</span>
											<span>•</span>
											<span>{totalTerritories} Claimed TTs</span>
										</div>
									</div>

									{/* Action buttons */}
									<div className="flex items-center gap-1.5 shrink-0">
										{!isActive && (
											<button
												type="button"
												onClick={() => {
													onSelectMap(m);
													onClose();
												}}
												className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors cursor-pointer"
											>
												Load
											</button>
										)}
										<button
											type="button"
											onClick={() => handleStartRename(m)}
											title="Rename map"
											className="size-8 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center cursor-pointer transition-colors"
										>
											<Edit3 className="size-3.5" />
										</button>
										<button
											type="button"
											onClick={() => onDuplicateMap(m)}
											title="Duplicate map"
											className="size-8 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center cursor-pointer transition-colors"
										>
											<Copy className="size-3.5" />
										</button>
										<button
											type="button"
											onClick={() => handleExport(m)}
											title="Export JSON"
											className="size-8 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center justify-center cursor-pointer transition-colors"
										>
											<Download className="size-3.5" />
										</button>
										{maps.length > 1 && m.id && (
											<button
												type="button"
												onClick={() => m.id && onDeleteMap(m.id)}
												title="Delete map"
												className="size-8 rounded-lg hover:bg-destructive/20 text-zinc-400 hover:text-destructive flex items-center justify-center cursor-pointer transition-colors"
											>
												<Trash2 className="size-3.5" />
											</button>
										)}
									</div>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
