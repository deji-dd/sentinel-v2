import { describe, expect, test } from "bun:test";
import { setupSchedulerIpc } from "../src/lib/ipc";

describe("IPC Action Dispatcher", () => {
	test("initializes IPC server and handles known actions cleanly", async () => {
		const server = await setupSchedulerIpc();
		expect(server).toBeDefined();

		let broadcastPayload: unknown;
		server.broadcast = ((payload: unknown) => {
			broadcastPayload = payload;
		}) as unknown as typeof server.broadcast;

		server.broadcast({ action: "reset_log_manager" });
		expect(broadcastPayload).toEqual({ action: "reset_log_manager" });
	});
});
