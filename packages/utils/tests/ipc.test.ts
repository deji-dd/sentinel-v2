import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IPC_SOCKET_PATHS, IpcClient, IpcServer } from "../src/ipc";

describe("ipc utility", () => {
	const testSocketPath = path.join(
		process.cwd(),
		"data",
		`test_ipc_${Date.now()}.sock`,
	);

	beforeAll(() => {
		const dir = path.dirname(testSocketPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	});

	afterAll(() => {
		if (fs.existsSync(testSocketPath)) {
			try {
				fs.unlinkSync(testSocketPath);
			} catch {}
		}
	});

	test("should expose valid IPC_SOCKET_PATHS structure", () => {
		expect(IPC_SOCKET_PATHS.api).toContain("sentinel_api.sock");
		expect(IPC_SOCKET_PATHS.worker).toContain("sentinel_worker.sock");
		expect(IPC_SOCKET_PATHS.bot).toContain("sentinel_bot.sock");
	});

	test("should transmit messages between IpcServer and IpcClient over UDS", async () => {
		const receivedServerMessages: Array<{ type: string; payload: string }> = [];
		const receivedClientMessages: Array<{ type: string; payload: string }> = [];

		const server = new IpcServer<{ type: string; payload: string }>(
			testSocketPath,
			(msg) => {
				receivedServerMessages.push(msg);
			},
		);

		server.start();

		// Wait briefly for server socket creation
		await new Promise((r) => setTimeout(r, 50));

		const client = new IpcClient<{ type: string; payload: string }>(
			testSocketPath,
			(msg) => {
				receivedClientMessages.push(msg);
			},
		);

		// Wait for connection establishing
		await new Promise((r) => setTimeout(r, 100));

		// Send message from client to server
		client.send({ type: "PING", payload: "hello server" });

		await new Promise((r) => setTimeout(r, 100));
		expect(receivedServerMessages.length).toBe(1);
		expect(receivedServerMessages[0]).toEqual({
			type: "PING",
			payload: "hello server",
		});

		// Broadcast message from server to client
		server.broadcast({ type: "PONG", payload: "hello client" });

		await new Promise((r) => setTimeout(r, 100));
		expect(receivedClientMessages.length).toBe(1);
		expect(receivedClientMessages[0]).toEqual({
			type: "PONG",
			payload: "hello client",
		});

		client.close();
		server.close();
	});
});
