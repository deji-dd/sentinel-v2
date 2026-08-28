import { beforeAll, describe, expect, it } from "bun:test";
import { db, territoryBlueprints, users } from "@sentinel/database";
import { app } from "../src/app";

describe("Elysia API Server - TT-Selector Routes", () => {
	beforeAll(() => {
		// Insert mock blueprint
		db.insert(territoryBlueprints)
			.values({
				id: "TEST_TT_1",
				sector: 1,
				size: 10,
				density: 2,
				slots: 5,
				data: { respect: 500 },
			})
			.onConflictDoNothing()
			.run();

		// Insert mock test user
		db.insert(users)
			.values({
				username: "tt_test_commander",
				role: "user",
			})
			.onConflictDoNothing()
			.run();
	});

	it("GET /api/v1/tt/metadata returns territory blueprints and price data", async () => {
		const res = await app.handle(
			new Request("http://localhost:3000/api/v1/tt/metadata"),
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			territories: Record<string, unknown>;
			prices: { items: Record<string, number>; points: number };
			itemNames: Record<string, string>;
		};

		expect(data).toHaveProperty("territories");
		expect(data).toHaveProperty("prices");
		expect(data.prices).toHaveProperty("points");
		expect(data).toHaveProperty("itemNames");
	});

	it("GET /api/v1/tt/maps returns 401 Unauthorized for unauthenticated requests", async () => {
		const res = await app.handle(
			new Request("http://localhost:3000/api/v1/tt/maps"),
		);

		expect(res.status).toBe(401);
	});

	it("Performs complete map CRUD cycle with demo session login", async () => {
		// 1. Log in via demo-login
		const loginRes = await app.handle(
			new Request("http://localhost:3000/api/v1/auth/demo-login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "tt_test_commander" }),
			}),
		);

		expect(loginRes.status).toBe(200);
		const cookieHeader = loginRes.headers.get("set-cookie") ?? "";
		expect(cookieHeader).toContain("session=");

		const sessionCookie = cookieHeader.split(";")[0] ?? "";

		// 2. Create map
		const createRes = await app.handle(
			new Request("http://localhost:3000/api/v1/tt/maps", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: sessionCookie,
				},
				body: JSON.stringify({
					name: "Operation Northern Strike",
					labels: [
						{
							id: "faction-1",
							text: "Strike Group A",
							color: "#3b82f6",
							enabled: true,
							territories: ["TEST_TT_1"],
							respect: 500,
							sectors: 1,
							rackets: 0,
						},
					],
					assignments: { TEST_TT_1: "faction-1" },
				}),
			}),
		);

		expect(createRes.status).toBe(200);
		const createData = (await createRes.json()) as {
			success: boolean;
			map: { id: string; name: string; labels: unknown[] };
		};
		expect(createData.success).toBe(true);
		expect(createData.map.name).toBe("Operation Northern Strike");
		const mapId = createData.map.id;

		// 3. Fetch maps list
		const listRes = await app.handle(
			new Request("http://localhost:3000/api/v1/tt/maps", {
				headers: { Cookie: sessionCookie },
			}),
		);

		expect(listRes.status).toBe(200);
		const listData = (await listRes.json()) as { maps: Array<{ id: string }> };
		expect(listData.maps.some((m) => m.id === mapId)).toBe(true);

		// 4. Update map
		const updateRes = await app.handle(
			new Request("http://localhost:3000/api/v1/tt/maps", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: sessionCookie,
				},
				body: JSON.stringify({
					mapId,
					name: "Operation Northern Strike (Updated)",
					labels: [],
					assignments: {},
				}),
			}),
		);

		expect(updateRes.status).toBe(200);
		const updateData = (await updateRes.json()) as {
			map: { name: string };
		};
		expect(updateData.map.name).toBe("Operation Northern Strike (Updated)");

		// 5. Delete map
		const deleteRes = await app.handle(
			new Request(`http://localhost:3000/api/v1/tt/maps/${mapId}`, {
				method: "DELETE",
				headers: { Cookie: sessionCookie },
			}),
		);

		expect(deleteRes.status).toBe(200);
	});
});
