import allianceSnapshot from "../../../../data/faction-alliances.snapshot.json" with {
	type: "json",
};
import { logger } from "./logger";

export interface AllianceMember {
	name: string;
	id?: number;
	children: AllianceMember[];
}

interface AllianceResponse {
	alliances: AllianceMember[];
}

interface AllianceCache {
	fetchedAt: number;
	factionToAlliance: Map<number, string>;
}

const ALLIANCE_JSON_URL =
	"https://raw.githubusercontent.com/Marches0/torn-public/25b7cef36fd0949237b7ce2ee3fa53a9b7e5bc53/factions/alliances/factionAlliances.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;

let cache: AllianceCache | null = null;

function normalizeAllianceResponse(input: unknown): AllianceResponse {
	if (
		!input ||
		typeof input !== "object" ||
		!Array.isArray((input as { alliances?: unknown[] }).alliances)
	) {
		throw new Error("Invalid alliance JSON: missing alliances array");
	}

	return input as AllianceResponse;
}

function buildFactionToAllianceMap(
	root: AllianceMember[],
): Map<number, string> {
	const factionToAlliance = new Map<number, string>();

	const visit = (node: AllianceMember, rootAllianceName: string): void => {
		if (typeof node.id === "number" && Number.isFinite(node.id)) {
			factionToAlliance.set(node.id, rootAllianceName);
		}

		for (const child of node.children || []) {
			visit(child, rootAllianceName);
		}
	};

	for (const alliance of root) {
		const rootAllianceName = alliance.name || "Unknown Alliance";
		visit(alliance, rootAllianceName);
	}

	return factionToAlliance;
}

async function fetchRemoteAllianceMap(): Promise<Map<number, string>> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(ALLIANCE_JSON_URL, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Alliance fetch failed with status ${response.status}`);
		}

		const parsed = normalizeAllianceResponse(await response.json());
		return buildFactionToAllianceMap(parsed.alliances);
	} finally {
		clearTimeout(timeout);
	}
}

function loadSnapshotAllianceMap(): Map<number, string> {
	const parsed = normalizeAllianceResponse(allianceSnapshot);
	return buildFactionToAllianceMap(parsed.alliances);
}

export async function getFactionToAllianceMap(): Promise<Map<number, string>> {
	const now = Date.now();

	if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
		return cache.factionToAlliance;
	}

	try {
		const factionToAlliance = await fetchRemoteAllianceMap();
		cache = { fetchedAt: now, factionToAlliance };
		return factionToAlliance;
	} catch (error) {
		logger.warn(
			`Failed to fetch remote alliance data, using snapshot fallback: ${error instanceof Error ? error.message : String(error)}`,
		);

		const factionToAlliance = loadSnapshotAllianceMap();
		cache = { fetchedAt: now, factionToAlliance };
		return factionToAlliance;
	}
}
