import { describe, expect, it } from "bun:test";
import type { DibsItem } from "../src/types";
import { syncDibsFromServer } from "../src/war/dibs-sync";

function dibs(targetId: number, overrides: Partial<DibsItem> = {}): DibsItem {
	return {
		targetId,
		targetName: `Target${targetId}`,
		targetLevel: 80,
		estimatedBs: 500_000_000,
		fairFight: 2.5,
		hospitalUntil: Math.floor(Date.now() / 1000) + 120,
		status: "open",
		createdAt: Date.now(),
		...overrides,
	};
}

const claim = (targetId: number, tornId: number): DibsItem =>
	dibs(targetId, {
		status: "claimed",
		claimedBy: { tornId, tornName: `Member${tornId}`, platform: "script" },
	});

describe("syncDibsFromServer", () => {
	/**
	 * The panel map used to be append-only, so a claim the server had released
	 * (lock expired, target downed, war termed) kept rendering as "Claimed (You)"
	 * while Discord showed the target as free again.
	 */
	it("drops claims the server no longer lists", () => {
		const current = new Map<number, DibsItem>([
			[1001, claim(1001, 55555)],
			[1002, claim(1002, 55555)],
		]);

		syncDibsFromServer(current, []);

		expect(current.size).toBe(0);
	});

	it("keeps a claim that is still on the server's board", () => {
		const current = new Map<number, DibsItem>([[1001, claim(1001, 55555)]]);

		syncDibsFromServer(current, [dibs(1002), claim(1001, 55555)]);

		expect([...current.keys()].sort()).toEqual([1001, 1002]);
		expect(current.get(1001)?.status).toBe("claimed");
		expect(current.get(1001)?.claimedBy?.tornId).toBe(55555);
	});

	it("takes the server's newer record over a stale local one", () => {
		const current = new Map<number, DibsItem>([[1001, claim(1001, 55555)]]);

		// Released by the lock timer and reposted as open.
		syncDibsFromServer(current, [dibs(1001, { status: "open" })]);

		expect(current.get(1001)?.status).toBe("open");
		expect(current.get(1001)?.claimedBy).toBeUndefined();
	});

	it("ignores payload entries without a usable target id", () => {
		const current = new Map<number, DibsItem>();

		syncDibsFromServer(current, [
			dibs(1001),
			{ targetName: "Broken" } as unknown as DibsItem,
		]);

		expect([...current.keys()]).toEqual([1001]);
	});
});
