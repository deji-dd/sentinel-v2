import { isWarEngaged, state } from "../state";
import type { CurrentWarInfo } from "../types";
import { formatSeconds } from "../utils/formatters";

let warBanner: HTMLElement | null = null;
let warEmpty: HTMLElement | null = null;
let warActiveContent: HTMLElement | null = null;
let warOpponentName: HTMLElement | null = null;
let warTimer: HTMLElement | null = null;
let warScoreLead: HTMLElement | null = null;
let ownFactionLabel: HTMLElement | null = null;
let userHitCountEl: HTMLElement | null = null;
let warDetailsEl: HTMLElement | null = null;

export function initWarBannerElements(root: ShadowRoot | Document): void {
	warBanner = root.getElementById("satf-war-banner") as HTMLElement | null;
	warEmpty = root.getElementById("satf-war-empty") as HTMLElement | null;
	warActiveContent = root.getElementById(
		"satf-war-active-content",
	) as HTMLElement | null;
	warOpponentName = (root.getElementById("satf-war-opp-name") ||
		root.getElementById("satf-opp-name")) as HTMLElement | null;
	warTimer = (root.getElementById("satf-war-timer") ||
		root.getElementById("satf-war-title")) as HTMLElement | null;
	ownFactionLabel =
		(root.getElementById("satf-own-faction-lbl") as HTMLElement | null) ?? null;
	warScoreLead = (root.getElementById("satf-score-lead") ||
		root.getElementById("satf-war-lead")) as HTMLElement | null;
	userHitCountEl =
		(root.getElementById("satf-user-hit-count") as HTMLElement | null) ?? null;
	warDetailsEl =
		(root.getElementById("satf-war-details") as HTMLElement | null) ?? null;
}

export function updateWarCountdown(): void {
	if (!warTimer || !state.war) return;
	const now = Math.floor(Date.now() / 1000);
	const start = state.war.start || 0;

	if (state.war.state === "scheduled") {
		const diff = start - now;
		warTimer.textContent =
			diff > 0 ? `Starts in ${formatSeconds(diff)}` : "Starting...";
	} else if (state.war.state === "active") {
		const diff = now - start;
		warTimer.textContent =
			diff > 0 ? `Active: ${formatSeconds(diff)}` : "Active";
	} else {
		warTimer.textContent = "Standby";
	}
}

export function stopCountdownTimer(): void {
	if (state.countdownTimer) {
		clearInterval(state.countdownTimer);
		state.countdownTimer = null;
	}
}

export function renderWarBanner(war: CurrentWarInfo | null): void {
	const engaged = war && isWarEngaged();

	if (warEmpty) warEmpty.style.display = engaged ? "none" : "block";
	if (warActiveContent)
		warActiveContent.style.display = engaged ? "block" : "none";

	if (!warBanner) return;
	if (!engaged) {
		warBanner.style.display = "none";
		stopCountdownTimer();
		return;
	}

	warBanner.style.display = "block";

	// Show the member's own family faction (2013 Subversive Alliance / 27312 SA Succession)
	const ownFactionName =
		state.user?.factionName ?? war.factionName ?? war.subversive?.name ?? null;
	if (ownFactionLabel && ownFactionName) {
		ownFactionLabel.textContent = ownFactionName;
	}

	if (warOpponentName) {
		warOpponentName.textContent = war.opponent?.name || "Opponent";
	}

	if (warScoreLead) {
		const saScore = war.subversive?.score ?? 0;
		const oppScore = war.opponent?.score ?? 0;
		const lead = saScore - oppScore;
		warScoreLead.textContent = lead >= 0 ? `+${lead}` : String(lead);
		warScoreLead.className = `satf-lead-badge ${lead >= 0 ? "lead-pos" : "lead-neg"}`;
	}

	// The viewer's own landed hits this war. Hidden until a count arrives so an
	// unranked or not-yet-tracked war does not show a misleading zero.
	//
	// Both elements ship with an inline `display: none` in the template, so the
	// span itself must be un-hidden as well as the wrapper. Revealing only the
	// wrapper leaves the text written but permanently invisible.
	if (userHitCountEl) {
		const hits = (war as { userHitCount?: number }).userHitCount;
		if (typeof hits === "number" && hits > 0) {
			userHitCountEl.textContent = `${hits} ${hits === 1 ? "hit" : "hits"} this war`;
			userHitCountEl.style.display = "";
			if (warDetailsEl) warDetailsEl.style.display = "";
		} else {
			userHitCountEl.textContent = "";
			userHitCountEl.style.display = "none";
			if (warDetailsEl) warDetailsEl.style.display = "none";
		}
	}

	updateWarCountdown();
}
