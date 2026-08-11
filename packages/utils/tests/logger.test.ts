import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Logger } from "../src/logger";

describe("logger utility", () => {
	let logSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;
	let debugSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		debugSpy = spyOn(console, "debug").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		debugSpy.mockRestore();
	});

	test("should log info messages with formatted context tag", () => {
		const logger = new Logger("TestContext");
		logger.info("Hello world", { key: "value" });

		expect(logSpy).toHaveBeenCalled();
		const msg = logSpy.mock.calls[0]?.[0] as string;
		expect(msg).toContain("[INFO]");
		expect(msg).toContain("[TestContext]");
		expect(msg).toContain("Hello world");
	});

	test("should log warn messages", () => {
		const logger = new Logger("WarnContext");
		logger.warn("Careful!");

		expect(warnSpy).toHaveBeenCalled();
		const msg = warnSpy.mock.calls[0]?.[0] as string;
		expect(msg).toContain("[WARN]");
		expect(msg).toContain("[WarnContext]");
		expect(msg).toContain("Careful!");
	});

	test("should log error messages", () => {
		const logger = new Logger("ErrorContext");
		const err = new Error("Something broke");
		logger.error("Failed to execute", err);

		expect(errorSpy).toHaveBeenCalled();
		const msg = errorSpy.mock.calls[0]?.[0] as string;
		expect(msg).toContain("[ERROR]");
		expect(msg).toContain("Failed to execute");
		expect(errorSpy.mock.calls[0]?.[1]).toBe(err);
	});

	test("should handle timer function cleanly", async () => {
		const logger = new Logger("TimerContext");
		const stopTimer = logger.time();

		expect(warnSpy).toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 10));

		stopTimer();
		expect(logSpy).toHaveBeenCalled();
		const msg = logSpy.mock.calls[0]?.[0] as string;
		expect(msg).toContain("Completed in");
	});
});
