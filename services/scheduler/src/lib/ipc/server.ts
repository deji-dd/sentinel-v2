import type { IpcBotMessage, IpcMessage } from "@sentinel/schemas";
import type { IpcServer } from "@sentinel/utils/ipc";

let activeIpcServer: IpcServer<IpcMessage> | null = null;

export function setActiveIpcServer(server: IpcServer<IpcMessage> | null): void {
	activeIpcServer = server;
}

export function getActiveIpcServer(): IpcServer<IpcMessage> | null {
	return activeIpcServer;
}

/**
 * Dispatches a strongly-typed IPC payload to connected clients (e.g. Discord Bot / API).
 */
export function dispatchToBot(payload: IpcBotMessage): void {
	if (activeIpcServer) {
		activeIpcServer.broadcast(payload);
	}
}
