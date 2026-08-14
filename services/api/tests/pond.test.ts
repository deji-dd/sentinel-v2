import { describe, expect, it } from "bun:test";
import { app } from "../src/app";

describe("Elysia API Server - Pond IoT Routes", () => {
	const testDeviceId = `test_device_${Date.now()}`;

	it("POST /pond/data ingests sensor data successfully", async () => {
		const payload = {
			device_id: testDeviceId,
			temperature_c: 24.5,
			ph: 7.2,
			turbidity_ntu: 12.8,
			pond_level_pct: 85,
			pump_in_active: false,
			pump_drain_active: true,
		};

		const response = await app.handle(
			new Request("http://localhost/pond/data", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}),
		);

		expect(response.status).toBe(201);
		const data = (await response.json()) as { success: boolean; id: string };
		expect(data.success).toBe(true);
		expect(typeof data.id).toBe("string");
	});

	it("POST /pond/data validates required payload fields", async () => {
		const response = await app.handle(
			new Request("http://localhost/pond/data", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ device_id: testDeviceId }),
			}),
		);

		expect([400, 422]).toContain(response.status);
	});

	it("GET /pond/data/:deviceId returns history for device", async () => {
		const response = await app.handle(
			new Request(`http://localhost/pond/data/${testDeviceId}`),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as Array<{
			deviceId: string;
			temperatureC: number;
			ph: number;
		}>;
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBeGreaterThanOrEqual(1);
		const lastEntry = data[data.length - 1];
		expect(lastEntry?.deviceId).toBe(testDeviceId);
		expect(lastEntry?.temperatureC).toBe(24.5);
	});

	it("GET /pond/control/:deviceId fetches default or existing control state", async () => {
		const response = await app.handle(
			new Request(`http://localhost/pond/control/${testDeviceId}`),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			manual_mode: boolean;
			pump_in: boolean;
			pump_drain: boolean;
			simulate_breach: boolean;
		};
		expect(typeof data.manual_mode).toBe("boolean");
		expect(typeof data.pump_in).toBe("boolean");
		expect(typeof data.pump_drain).toBe("boolean");
		expect(typeof data.simulate_breach).toBe("boolean");
	});

	it("POST /pond/control/:deviceId updates device control state", async () => {
		const payload = {
			manual_mode: true,
			pump_in: true,
			pump_drain: false,
			simulate_breach: true,
		};

		const response = await app.handle(
			new Request(`http://localhost/pond/control/${testDeviceId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			success: boolean;
			state: {
				manualMode: boolean;
				pumpIn: boolean;
				pumpDrain: boolean;
				simulateBreach: boolean;
			};
		};

		expect(data.success).toBe(true);
		expect(data.state.manualMode).toBe(true);
		expect(data.state.pumpIn).toBe(true);
		expect(data.state.pumpDrain).toBe(false);
		expect(data.state.simulateBreach).toBe(true);
	});

	it("GET /pond/control/:deviceId returns updated state after POST", async () => {
		const response = await app.handle(
			new Request(`http://localhost/pond/control/${testDeviceId}`),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			manual_mode: boolean;
			pump_in: boolean;
			pump_drain: boolean;
			simulate_breach: boolean;
		};

		expect(data.manual_mode).toBe(true);
		expect(data.pump_in).toBe(true);
		expect(data.pump_drain).toBe(false);
		expect(data.simulate_breach).toBe(true);
	});

	it("handles CORS preflight and requests from https://aquasense.ayodejib.dev", async () => {
		const preflightResponse = await app.handle(
			new Request("http://localhost/pond/data", {
				method: "OPTIONS",
				headers: {
					Origin: "https://aquasense.ayodejib.dev",
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "Content-Type",
				},
			}),
		);

		expect(preflightResponse.status).toBe(204);
		expect(preflightResponse.headers.get("access-control-allow-origin")).toBe(
			"https://aquasense.ayodejib.dev",
		);

		const getResponse = await app.handle(
			new Request(`http://localhost/pond/data/${testDeviceId}`, {
				headers: {
					Origin: "https://aquasense.ayodejib.dev",
				},
			}),
		);

		expect(getResponse.status).toBe(200);
		expect(getResponse.headers.get("access-control-allow-origin")).toBe(
			"https://aquasense.ayodejib.dev",
		);
	});

	it("allows ESP32 non-browser requests without Origin header", async () => {
		const espPayload = {
			device_id: "esp32_hardware_unit_1",
			temperature_c: 25.1,
			ph: 7.4,
			turbidity_ntu: 5.2,
			pond_level_pct: 90,
			pump_in_active: true,
			pump_drain_active: false,
		};

		const response = await app.handle(
			new Request("http://localhost/pond/data", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "ESP32-HTTP-Client/1.0",
				},
				body: JSON.stringify(espPayload),
			}),
		);

		expect(response.status).toBe(201);
		const data = (await response.json()) as { success: boolean; id: string };
		expect(data.success).toBe(true);
	});
});
