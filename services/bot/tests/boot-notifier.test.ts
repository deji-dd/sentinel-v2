import { describe, expect, mock, test } from "bun:test";
import { db, eq, systemAlerts } from "@sentinel/database";
import type { Client } from "discord.js";
import { processPendingBootAlerts } from "../src/lib/boot-notifier";

describe("Boot Notifier", () => {
	test("drains and marks alerts as read in development mode without sending DMs", async () => {
		const originalEnv = process.env.NODE_ENV;
		const originalEnable = process.env.ENABLE_DEV_BOOT_ALERTS;
		process.env.NODE_ENV = "development";
		delete process.env.ENABLE_DEV_BOOT_ALERTS;

		const alertId = crypto.randomUUID();
		await db.insert(systemAlerts).values({
			id: alertId,
			component: "API Gateway",
			message: "Dev mode test alert",
			isRead: false,
			createdAt: new Date(),
		});

		const sendMock = mock(() => Promise.resolve());
		const mockClient = {
			users: {
				fetch: mock(() => Promise.resolve({ send: sendMock })),
			},
		} as unknown as Client;

		await processPendingBootAlerts(mockClient);

		expect(sendMock).not.toHaveBeenCalled();

		const updated = await db.query.systemAlerts.findFirst({
			where: eq(systemAlerts.id, alertId),
		});
		expect(updated?.isRead).toBe(true);

		process.env.NODE_ENV = originalEnv;
		if (originalEnable !== undefined) {
			process.env.ENABLE_DEV_BOOT_ALERTS = originalEnable;
		}
	});

	test("discards stale alerts older than threshold without sending DMs", async () => {
		const originalEnv = process.env.NODE_ENV;
		const originalEnable = process.env.ENABLE_DEV_BOOT_ALERTS;
		const originalUserId = process.env.DISCORD_USER_ID;

		process.env.NODE_ENV = "production";
		process.env.DISCORD_USER_ID = "123456789";

		// Alert created 10 minutes ago
		const staleAlertId = crypto.randomUUID();
		const staleDate = new Date(Date.now() - 10 * 60 * 1000);
		await db.insert(systemAlerts).values({
			id: staleAlertId,
			component: "Scheduler Process",
			message: "Stale test alert",
			isRead: false,
			createdAt: staleDate,
		});

		// Fresh alert created 5 seconds ago
		const freshAlertId = crypto.randomUUID();
		await db.insert(systemAlerts).values({
			id: freshAlertId,
			component: "API Gateway",
			message: "Fresh test alert",
			isRead: false,
			createdAt: new Date(),
		});

		const sendMock = mock(() => Promise.resolve());
		const mockClient = {
			users: {
				fetch: mock(() => Promise.resolve({ send: sendMock })),
			},
		} as unknown as Client;

		await processPendingBootAlerts(mockClient);

		// Only the fresh alert should have sent a DM
		expect(sendMock).toHaveBeenCalledTimes(1);

		const staleRecord = await db.query.systemAlerts.findFirst({
			where: eq(systemAlerts.id, staleAlertId),
		});
		expect(staleRecord?.isRead).toBe(true);

		const freshRecord = await db.query.systemAlerts.findFirst({
			where: eq(systemAlerts.id, freshAlertId),
		});
		expect(freshRecord?.isRead).toBe(true);

		process.env.NODE_ENV = originalEnv;
		if (originalEnable !== undefined) {
			process.env.ENABLE_DEV_BOOT_ALERTS = originalEnable;
		}
		if (originalUserId !== undefined) {
			process.env.DISCORD_USER_ID = originalUserId;
		} else {
			delete process.env.DISCORD_USER_ID;
		}
	});
});
