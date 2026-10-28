import { describe, expect, test } from "bun:test";

import {
	createEmptyUserShopliftingAlertState,
	isUserShopliftingAlertConditionAvailable,
	type ShopliftingSecurityStatus,
	type ShopliftingShopSnapshot,
	type TornSchema,
	type UserShopliftingAlertCondition,
	type UserShopliftingAlertState,
	type UserShopliftingAlertSubscription,
} from "@sentinel/schemas";

import {
	evaluateUserShopliftingAlert,
	normaliseUserShopliftingAlertState,
	shopliftingConditionHolds,
} from "../src/workers/subversive/shoplifting-alert-rules";
import { buildShopliftingSnapshots } from "../src/workers/subversive/shoplifting-alerts";

/**
 * Pure coverage for personal shoplifting alerts.
 *
 * The cases a user would notice: being DM'd the instant they subscribe during an
 * outage, being DM'd repeatedly while a guard is still on break, and being told a
 * shop is "all down" while its cameras are still active.
 */

const NOW_MS = 1_800_000_000_000;

function subscription(
	patch: Partial<UserShopliftingAlertSubscription> = {},
): UserShopliftingAlertSubscription {
	return {
		id: "sub-1",
		guildId: "111111111111111111",
		discordUserId: "555555555555555555",
		shopId: 24,
		condition: "guards_down",
		conditionKey: "24:guards_down",
		enabled: true,
		state: createEmptyUserShopliftingAlertState(),
		...patch,
	};
}

function snapshot(
	statuses: ShopliftingSecurityStatus[],
	patch: Partial<ShopliftingShopSnapshot> = {},
): ShopliftingShopSnapshot {
	return {
		shopId: 24,
		name: "Jewelry Store",
		statuses,
		...patch,
	};
}

function seeded(
	patch: Partial<UserShopliftingAlertState> = {},
): UserShopliftingAlertState {
	return { ...createEmptyUserShopliftingAlertState(), seeded: true, ...patch };
}

const cameras = (disabled: boolean): ShopliftingSecurityStatus => ({
	title: "Three cameras",
	disabled,
});

const guard = (disabled: boolean): ShopliftingSecurityStatus => ({
	title: "One guard",
	disabled,
});

const checkpoint = (disabled: boolean): ShopliftingSecurityStatus => ({
	title: "Checkpoint",
	disabled,
});

describe("Shoplifting alert rules", () => {
	describe("seeding", () => {
		test("records the status and stays quiet on the first poll", () => {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(true)]),
				subscription: subscription(),
				state: null,
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState.seeded).toBe(true);
			expect(nextState.wasTrue).toBe(true);
		});
	});

	describe("rising edge", () => {
		test("fires once when guards go from active to disabled", () => {
			const active = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(false)]),
				subscription: subscription(),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});
			expect(active.event).toBeNull();

			const down = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(true)]),
				subscription: subscription(),
				state: active.nextState,
				nowMs: NOW_MS + 60_000,
			});

			expect(down.event?.condition).toBe("guards_down");
			expect(down.event?.shopName).toBe("Jewelry Store");
			expect(down.event?.transition).toBe("down");
			expect(down.event?.description).toContain("Guards on break");
			expect(down.nextState.wasTrue).toBe(true);
		});

		test("does not fire again while the window stays open", () => {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(true)]),
				subscription: subscription(),
				state: seeded({ wasTrue: true, lastAlertAt: NOW_MS - 60_000 }),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState.wasTrue).toBe(true);
		});

		test("fires again after a new break once the cooldown has passed", () => {
			const { event } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(true)]),
				subscription: subscription(),
				state: seeded({ wasTrue: false, lastAlertAt: NOW_MS - 10 * 60_000 }),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
		});

		test("suppresses a second crossing inside the cooldown", () => {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(true)]),
				subscription: subscription(),
				state: seeded({ wasTrue: false, lastAlertAt: NOW_MS - 60_000 }),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			// The edge is still recorded, so the next poll does not re-fire it.
			expect(nextState.wasTrue).toBe(true);
		});
	});

	describe("falling edge", () => {
		test("fires once when guards come back", () => {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(false)]),
				subscription: subscription(),
				state: seeded({ wasTrue: true, lastAlertAt: NOW_MS - 10 * 60_000 }),
				nowMs: NOW_MS,
			});

			expect(event?.condition).toBe("guards_down");
			expect(event?.transition).toBe("up");
			expect(event?.description).toBe("Guards back at Jewelry Store.");
			expect(nextState.wasTrue).toBe(false);
		});

		test("does not fire again while the window stays closed", () => {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(false)]),
				subscription: subscription(),
				state: seeded({ wasTrue: false, lastAlertAt: NOW_MS - 60_000 }),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState.wasTrue).toBe(false);
		});

		test("delivers a recovery even inside the cooldown", () => {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), guard(false)]),
				subscription: subscription(),
				state: seeded({ wasTrue: true, lastAlertAt: NOW_MS - 60_000 }),
				nowMs: NOW_MS,
			});

			// The down DM was sent, so the matching "back" DM is owed even though
			// the pair lands inside the down-edge cooldown.
			expect(event?.transition).toBe("up");
			expect(nextState.wasTrue).toBe(false);
		});

		test("describes cameras and all-security recoveries", () => {
			const camerasUp = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), checkpoint(false)], {
					shopId: 21,
					name: "TC Clothing",
				}),
				subscription: subscription({
					shopId: 21,
					condition: "cameras_down",
					conditionKey: "21:cameras_down",
				}),
				state: seeded({ wasTrue: true, lastAlertAt: NOW_MS - 10 * 60_000 }),
				nowMs: NOW_MS,
			});
			expect(camerasUp.event?.description).toBe(
				"Cameras back online at TC Clothing.",
			);

			const allUp = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false), checkpoint(false)], {
					shopId: 21,
					name: "TC Clothing",
				}),
				subscription: subscription({
					shopId: 21,
					condition: "all_down",
					conditionKey: "21:all_down",
				}),
				state: seeded({ wasTrue: true, lastAlertAt: NOW_MS - 10 * 60_000 }),
				nowMs: NOW_MS,
			});
			expect(allUp.event?.description).toBe(
				"All security restored at TC Clothing.",
			);
		});
	});

	describe("condition semantics", () => {
		test("cameras down requires every camera to be disabled", () => {
			expect(
				shopliftingConditionHolds("cameras_down", [
					{ title: "Two cameras", disabled: true },
					{ title: "One camera", disabled: false },
				]),
			).toBe(false);

			expect(
				shopliftingConditionHolds("cameras_down", [
					{ title: "Two cameras", disabled: true },
					{ title: "One camera", disabled: true },
				]),
			).toBe(true);
		});

		test("all down requires every security measure, not just one family", () => {
			expect(
				shopliftingConditionHolds("all_down", [
					cameras(true),
					checkpoint(false),
				]),
			).toBe(false);

			expect(
				shopliftingConditionHolds("all_down", [
					cameras(true),
					checkpoint(true),
				]),
			).toBe(true);
		});

		test("a missing measure is no opinion rather than a false edge", () => {
			const state = seeded({ wasTrue: false });
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(false)]),
				subscription: subscription({
					shopId: 19,
					condition: "guards_down",
					conditionKey: "19:guards_down",
				}),
				state,
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState).toEqual(state);
		});
	});

	describe("condition availability", () => {
		test("guard alerts are only offered for shops with guards", () => {
			expect(isUserShopliftingAlertConditionAvailable("guards_down", 24)).toBe(
				true,
			);
			expect(isUserShopliftingAlertConditionAvailable("guards_down", 19)).toBe(
				false,
			);
		});

		test("every shop can watch cameras, and multi-measure shops all-down", () => {
			for (const shopId of [19, 20, 21, 22, 217, 218, 23, 24]) {
				expect(
					isUserShopliftingAlertConditionAvailable("cameras_down", shopId),
				).toBe(true);
			}

			// Single-camera shops would make "all down" identical to "cameras down".
			expect(isUserShopliftingAlertConditionAvailable("all_down", 19)).toBe(
				false,
			);
			expect(isUserShopliftingAlertConditionAvailable("all_down", 24)).toBe(
				true,
			);
		});
	});

	describe("stored state", () => {
		test("normalises a malformed row without seeding it", () => {
			const state = normaliseUserShopliftingAlertState({
				seeded: "yes",
				wasTrue: 1,
				lastAlertAt: "later",
			});

			expect(state).toEqual({
				seeded: false,
				wasTrue: null,
				lastAlertAt: null,
			});
		});

		test("keeps a valid stored state", () => {
			expect(
				normaliseUserShopliftingAlertState({
					seeded: true,
					wasTrue: false,
					lastAlertAt: NOW_MS,
				}),
			).toEqual({ seeded: true, wasTrue: false, lastAlertAt: NOW_MS });
		});
	});

	describe("event payload", () => {
		test("carries the full security state for the embed", () => {
			const condition: UserShopliftingAlertCondition = "all_down";
			const { event } = evaluateUserShopliftingAlert({
				snapshot: snapshot([cameras(true), checkpoint(true)], {
					shopId: 21,
					name: "TC Clothing",
				}),
				subscription: subscription({
					shopId: 21,
					condition,
					conditionKey: "21:all_down",
				}),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			expect(event?.statuses).toEqual([
				{ title: "Three cameras", disabled: true },
				{ title: "Checkpoint", disabled: true },
			]);
			expect(event?.description).toContain("TC Clothing");
		});
	});

	describe("Torn response normalisation", () => {
		test("maps known shops and skips unknown ones", () => {
			const snapshots = buildShopliftingSnapshots({
				shoplifting: [
					{
						id: 24,
						status: [
							{ title: "Three cameras", disabled: false },
							{ title: "One guard", disabled: true },
						],
					},
					{
						id: 999,
						status: [{ title: "One camera", disabled: true }],
					},
				],
			});

			expect(snapshots.size).toBe(1);
			expect(snapshots.get(24)).toEqual({
				shopId: 24,
				name: "Jewelry Store",
				statuses: [
					{ title: "Three cameras", disabled: false },
					{ title: "One guard", disabled: true },
				],
			});
			expect(snapshots.has(999)).toBe(false);
		});

		test("skips a shop whose statuses are all malformed", () => {
			const snapshots = buildShopliftingSnapshots({
				shoplifting: [
					{
						id: 19,
						status: [{ title: "One camera" }],
					},
				],
			} as unknown as TornSchema<"TornShopliftingResponse">);

			expect(snapshots.size).toBe(0);
		});
	});
});
