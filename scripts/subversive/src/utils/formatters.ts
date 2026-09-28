import { state } from "../state";
import type { BountyTarget } from "../types";

export function safeJsonParse<T>(val: unknown, fallback: T): T {
	try {
		return typeof val === "string" ? JSON.parse(val) : fallback;
	} catch {
		return fallback;
	}
}

export function formatMoney(num: number | undefined | null): string {
	if (!num || !Number.isFinite(num)) return "$0";
	return `$${Math.round(num).toLocaleString()}`;
}

export function parseMoneyInput(str: unknown): number {
	if (!str) return 0;
	const clean = String(str).replace(/[$,]/g, "").trim().toLowerCase();
	if (!clean) return 0;
	const match = clean.match(/^([\d.]+)\s*([kmbtq])?$/);
	if (!match) {
		const n = Number(clean);
		return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
	}
	const val = Number.parseFloat(match[1] ?? "");
	if (Number.isNaN(val) || val <= 0) return 0;
	const unit = match[2] ?? "";
	const mults: Record<string, number> = {
		k: 1e3,
		m: 1e6,
		b: 1e9,
		t: 1e12,
		q: 1e15,
	};
	return Math.round(val * (mults[unit] || 1));
}

export function getBountyFF(t: BountyTarget | undefined | null): number | null {
	if (!t) return null;
	if (typeof t.fairFight === "number" && !Number.isNaN(t.fairFight)) {
		return t.fairFight;
	}
	if (state.user?.bsScore && t.estimatedBs && t.estimatedBs > 0) {
		const defenderScore = 2 * Math.sqrt(t.estimatedBs);
		return Math.max(
			1.0,
			Number((1 + (8 / 3) * (defenderScore / state.user.bsScore)).toFixed(2)),
		);
	}
	return null;
}

export function formatStats(num: number | undefined | null): string {
	if (!num || !Number.isFinite(num)) return "Unknown";
	if (num >= 1e15) return `${(num / 1e15).toFixed(2)}Q`;
	if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
	if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
	if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
	if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
	return Math.round(num).toLocaleString();
}

export function parseStatsInput(str: unknown): number | null {
	if (!str) return null;
	const clean = String(str).trim().toLowerCase();
	const match = clean.match(/^([\d.]+)\s*([kmbtq])?$/);
	if (!match) return null;
	const val = Number.parseFloat(match[1] ?? "");
	if (Number.isNaN(val) || val <= 0) return null;
	const unit = match[2] ?? "";
	const mults: Record<string, number> = {
		k: 1e3,
		m: 1e6,
		b: 1e9,
		t: 1e12,
		q: 1e15,
	};
	return Math.round(val * (mults[unit] || 1));
}

export function formatSeconds(totalSeconds: number): string {
	if (totalSeconds <= 0) return "0s";
	const m = Math.floor(totalSeconds / 60);
	const s = Math.floor(totalSeconds % 60);
	if (m > 60) {
		const h = Math.floor(m / 60);
		const remM = m % 60;
		return `${h}h ${remM}m`;
	}
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function getFFTier(ff: number | undefined | null): string {
	if (typeof ff !== "number" || Number.isNaN(ff)) return "white";
	if (ff > 4.0) return "red";
	if (ff > 3.5) return "yellow";
	if (ff > 3.0) return "blue";
	if (ff > 2.0) return "green";
	return "white";
}

export function getFFColor(ff: number | undefined | null): string {
	const tier = getFFTier(ff);
	if (tier === "red") return "#ef4444";
	if (tier === "yellow") return "#eab308";
	if (tier === "blue") return "#3b82f6";
	if (tier === "green") return "#10b981";
	return "#f4f4f5";
}
