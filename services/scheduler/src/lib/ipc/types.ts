import type { IpcMessage } from "@sentinel/schemas";
import type { IpcServer } from "@sentinel/utils/ipc";

export type IpcHandlerContext<T = IpcMessage> = {
	message: T;
	server: IpcServer<IpcMessage>;
};

export type IpcActionHandler = (ctx: IpcHandlerContext) => Promise<void> | void;
