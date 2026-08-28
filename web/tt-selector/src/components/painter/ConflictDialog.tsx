import { AlertTriangle, Check, X } from "lucide-react";

interface ConflictDialogProps {
	isOpen: boolean;
	targetTerritoryId: string;
	currentOwnerLabelName: string;
	newOwnerLabelName: string;
	onConfirmReassign: () => void;
	onCancel: () => void;
}

export function ConflictDialog({
	isOpen,
	targetTerritoryId,
	currentOwnerLabelName,
	newOwnerLabelName,
	onConfirmReassign,
	onCancel,
}: ConflictDialogProps) {
	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
			<div className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-[#0d1117] p-6 shadow-2xl space-y-4">
				<div className="flex items-start gap-3">
					<div className="size-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
						<AlertTriangle className="size-5" />
					</div>
					<div>
						<h3 className="font-bold text-base text-zinc-100 font-sans">
							Territory Reassignment
						</h3>
						<p className="text-xs text-zinc-400 mt-1 leading-relaxed">
							Territory{" "}
							<span className="font-mono font-bold text-amber-400">
								{targetTerritoryId}
							</span>{" "}
							is currently assigned to{" "}
							<span className="font-semibold text-zinc-200">
								{currentOwnerLabelName}
							</span>
							.
						</p>
					</div>
				</div>

				<div className="p-3 rounded-xl bg-zinc-900/80 border border-border text-xs text-zinc-300">
					Would you like to transfer ownership of{" "}
					<span className="font-mono font-bold text-amber-400">
						{targetTerritoryId}
					</span>{" "}
					to{" "}
					<span className="font-semibold text-emerald-400">
						{newOwnerLabelName}
					</span>
					?
				</div>

				<div className="flex items-center justify-end gap-2.5 pt-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors flex items-center gap-1.5 cursor-pointer"
					>
						<X className="size-3.5" />
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirmReassign}
						className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-black transition-colors flex items-center gap-1.5 cursor-pointer font-sans shadow-lg shadow-amber-500/20"
					>
						<Check className="size-3.5" />
						Transfer Territory
					</button>
				</div>
			</div>
		</div>
	);
}
