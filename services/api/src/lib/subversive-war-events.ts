import { resolveSubversiveFactionId } from "@sentinel/utils";
import { subversiveDibsManager } from "./dibs-manager";
import type { CachedUserSession } from "./subversive-target-cache";
import { subversiveTargetCache } from "./subversive-target-cache";

export interface WarEventPayload {
	success: true;
	modified: boolean;
	version: number;
	war?: ReturnType<typeof subversiveTargetCache.getWarState> & {
		userHitCount?: number;
	};
	targets?: ReturnType<typeof subversiveTargetCache.getAvailableWarTargets>;
	hospitalQueue?: ReturnType<typeof subversiveTargetCache.getHospitalQueue>;
	dibs?: ReturnType<typeof subversiveDibsManager.getActiveDibs>;
	dibsLeadTimeSeconds?: number;
}

interface PendingSubscriber {
	id: string;
	session: CachedUserSession;
	maxFF?: number;
	maxBS?: number;
	resolve: (payload: WarEventPayload) => void;
	timeoutTimer: ReturnType<typeof setTimeout>;
}

class SubversiveWarEventManager {
	private currentVersion = Date.now();
	private subscribers = new Map<string, PendingSubscriber>();

	public getVersion(): number {
		return this.currentVersion;
	}

	public generatePayload(
		session: CachedUserSession,
		options: { maxFF?: number; maxBS?: number; modified?: boolean } = {},
	): WarEventPayload {
		const factionId = resolveSubversiveFactionId(session.factionId);
		const war = subversiveTargetCache.getWarState(factionId);
		const attackerBsScore = session.bsScore ?? 0;
		let targets = subversiveTargetCache.getAvailableWarTargets({
			attackerBsScore,
			factionId,
		});
		if (typeof options.maxFF === "number") {
			const limitFF = options.maxFF;
			targets = targets.filter((t) => t.fairFight <= limitFF);
		}
		if (typeof options.maxBS === "number") {
			const limitBS = options.maxBS;
			targets = targets.filter((t) => t.estimatedBs <= limitBS);
		}
		const hospitalQueue = subversiveTargetCache.getHospitalQueue({
			limit: 25,
			attackerBsScore,
			factionId,
		});
		const dibs = subversiveDibsManager.getActiveDibs(factionId);
		const dibsLeadTimeSeconds =
			(subversiveDibsManager.getCachedConfig(factionId).claimLeadTime ?? 5) *
			60;

		const userHitCount = subversiveTargetCache.getUserHitCount(
			session.tornId,
			factionId,
		);

		return {
			success: true,
			modified: options.modified ?? true,
			version: this.currentVersion,
			war: {
				...war,
				userHitCount,
			},
			targets,
			hospitalQueue,
			dibs,
			dibsLeadTimeSeconds,
		};
	}

	public waitForUpdate(
		session: CachedUserSession,
		sinceVersion: number,
		options: {
			maxFF?: number;
			maxBS?: number;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<WarEventPayload> {
		if (sinceVersion < this.currentVersion || options.signal?.aborted) {
			return Promise.resolve(
				this.generatePayload(session, { ...options, modified: true }),
			);
		}

		const subId = `${session.tornId}_${Math.random().toString(36).slice(2, 9)}`;
		const timeoutMs = Math.min(
			30_000,
			Math.max(1_000, options.timeoutMs ?? 25_000),
		);

		return new Promise<WarEventPayload>((resolve) => {
			const onAbort = () => {
				clearTimeout(timeoutTimer);
				this.subscribers.delete(subId);
			};

			const timeoutTimer = setTimeout(() => {
				if (options.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				this.subscribers.delete(subId);
				resolve({
					success: true,
					modified: false,
					version: this.currentVersion,
				});
			}, timeoutMs);

			if (options.signal) {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			this.subscribers.set(subId, {
				id: subId,
				session,
				maxFF: options.maxFF,
				maxBS: options.maxBS,
				resolve: (payload) => {
					if (options.signal) {
						options.signal.removeEventListener("abort", onAbort);
					}
					resolve(payload);
				},
				timeoutTimer,
			});
		});
	}

	public notifyUpdate(): void {
		this.currentVersion = Date.now();
		if (this.subscribers.size === 0) return;

		for (const sub of this.subscribers.values()) {
			clearTimeout(sub.timeoutTimer);
			const payload = this.generatePayload(sub.session, {
				maxFF: sub.maxFF,
				maxBS: sub.maxBS,
				modified: true,
			});
			sub.resolve(payload);
		}
		this.subscribers.clear();
	}
}

export const subversiveWarEventManager = new SubversiveWarEventManager();
