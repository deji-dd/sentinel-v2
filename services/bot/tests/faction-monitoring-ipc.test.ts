import { describe, expect, it } from "bun:test";
import type { FactionMember } from "@sentinel/schemas";
import {
	pendingFetchFactionMembersRequests,
	workerIpcClient,
} from "../src/lib/ipc/listener";
import { sendFetchFactionMembersRequest } from "../src/lib/ipc/server";

describe("Faction Monitoring IPC Module", () => {
	it("sendFetchFactionMembersRequest dispatches IPC request and resolves members from scheduler", async () => {
		let sentMessage: unknown = null;
		const originalSend = workerIpcClient.send.bind(workerIpcClient);
		workerIpcClient.send = ((msg: unknown) => {
			sentMessage = msg;
		}) as unknown as typeof workerIpcClient.send;

		try {
			const promise = sendFetchFactionMembersRequest(12345, 2000);

			expect(sentMessage).not.toBeNull();
			const req = sentMessage as {
				action: string;
				requestId: string;
				data: { factionId: number };
			};
			expect(req.action).toBe("fetch_faction_members_request");
			expect(req.data.factionId).toBe(12345);

			const pending = pendingFetchFactionMembersRequests.get(req.requestId);
			expect(pending).toBeDefined();

			const mockMembers: FactionMember[] = [
				{
					id: 101,
					name: "HospitalMember",
					level: 50,
					days_in_faction: 100,
					position: "Member",
					is_revivable: true,
					is_on_wall: false,
					is_in_oc: false,
					has_early_discharge: false,
					revive_setting: "Everyone",
					status: {
						description: "In hospital for 20 mins",
						details: "Suffering from gunshot wounds",
						state: "Hospital",
						color: "red",
						until: 1800000000,
					},
					last_action: {
						status: "Offline",
						relative: "10 mins ago",
						timestamp: 1799990000,
					},
				},
			];

			pending?.resolve(mockMembers);

			const result = await promise;
			expect(result.length).toBe(1);
			expect(result[0]?.name).toBe("HospitalMember");
			expect(result[0]?.is_revivable).toBe(true);
		} finally {
			workerIpcClient.send = originalSend;
		}
	});

	it("sendFetchFactionMembersRequest rejects on timeout when scheduler does not respond", async () => {
		const promise = sendFetchFactionMembersRequest(99999, 50);
		await expect(promise).rejects.toThrow("Faction members fetch timed out");
	});
});
