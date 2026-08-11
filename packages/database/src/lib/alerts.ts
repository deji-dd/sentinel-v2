import { db } from "../../index";
import { systemAlerts } from "../schema/system";

const COMPONENT_DISPLAY_NAMES: Record<string, string> = {
	bot: "Discord Bot",
	api: "API Gateway",
	scheduler: "Scheduler Process",
};

/**
 * Records a system boot event in the database for process restart/startup notifications.
 *
 * @param component - The component name ("bot", "worker", "api", "scheduler", etc.)
 * @param customMessage - Optional custom message to record
 */
export async function recordBootAlert(
	component: "bot" | "api" | "scheduler" | (string & {}),
	customMessage?: string,
): Promise<void> {
	const displayName = COMPONENT_DISPLAY_NAMES[component] ?? component;
	const message =
		customMessage ?? `Sentinel ${displayName} successfully booted up.`;

	try {
		await db.insert(systemAlerts).values({
			component: displayName,
			message,
			isRead: false,
			createdAt: new Date(),
		});
	} catch (error) {
		console.error(
			`[BootAlert] Failed to record boot alert for ${component}:`,
			error,
		);
	}
}
