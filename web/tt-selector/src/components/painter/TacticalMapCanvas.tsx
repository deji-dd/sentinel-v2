import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useRef } from "react";
import type { RewardInfo } from "../../lib/racket-utils";

import { calculateDailyValue, parseRewardString } from "../../lib/racket-utils";

export interface MapLabel {
	id: string;
	text: string;
	color: string;
	enabled: boolean;
	territories: string[];
	respect: number;
	sectors: number;
	rackets: number;
}

export interface UserMap {
	id?: string;
	name: string;
	labels: MapLabel[];
	assignments: Record<string, string>;
	isPublic?: boolean;
	createdAt?: string | number | Date;
	updatedAt?: string | number | Date;
}

export interface TerritoryMetadataResponse {
	territories: Record<
		string,
		{
			sector: number;
			respect: number;
			size?: number;
			density?: number;
			slots?: number;
			racket?: {
				name: string;
				reward:
					| string
					| {
							type: string;
							quantity: number;
							id: number | null;
					  };
			};
		}
	>;
	prices: {
		items: Record<string, number>;
		points: number;
	};
	itemNames: Record<string, string>;
}

interface TacticalMapCanvasProps {
	metadata: TerritoryMetadataResponse | null;
	labels: MapLabel[];
	assignments: Record<string, string>;
	selectedLabelId: string | null;
	onMapReady?: () => void;
	onTerritoryClick: (territoryId: string) => void;
	onHoverChange: (
		data: {
			territoryId: string;
			sector: number;
			respect: number;
			size?: number;
			density?: number;
			slots?: number;
			racket?: {
				name: string;
				rewardInfo: RewardInfo | null;
				dailyValue: number;
			};
			assignedLabel?: {
				text: string;
				color: string;
			};
		} | null,
		mousePos: { x: number; y: number },
	) => void;
}

const TERRITORY_DEFAULT_FILL = "#161b22";
const TERRITORY_DEFAULT_FILL_OPACITY = "0.65";
const TERRITORY_DEFAULT_STROKE = "#30363d";
const TERRITORY_DEFAULT_STROKE_WIDTH = "0.75";
const TERRITORY_ASSIGNED_FILL_OPACITY = "0.85";
const TERRITORY_ASSIGNED_STROKE_WIDTH = "1.2";
const PAINT_SUPPRESS_AFTER_DRAG_MS = 150;

export function TacticalMapCanvas({
	metadata,
	labels,
	assignments,
	_selectedLabelId,
	onMapReady,
	onTerritoryClick,
	onHoverChange,
}: TacticalMapCanvasProps & { _selectedLabelId?: string | null }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const pathRefs = useRef<Record<string, SVGPathElement>>({});
	const centersRef = useRef<Record<string, { lat: number; lng: number }>>({});
	const labelsLayerRef = useRef<L.LayerGroup | null>(null);
	const racketsGroupRef = useRef<SVGGElement | null>(null);
	const racketDotsRef = useRef<SVGCircleElement[]>([]);
	const isDraggingRef = useRef(false);
	const suppressPaintUntilRef = useRef(0);
	const onMapReadyRef = useRef(onMapReady);
	onMapReadyRef.current = onMapReady;

	// Synchronize live racket pins on the map
	const syncRackets = useCallback(() => {
		const racketsGroup = racketsGroupRef.current;
		if (!racketsGroup || !metadata) return;

		racketsGroup.innerHTML = "";
		racketDotsRef.current = [];

		const zoom = mapRef.current?.getZoom() ?? 0.1;
		const scale = 2 ** -zoom;
		const dotRadius = (2.2 * scale).toString();
		const strokeWidth = (0.6 * scale).toString();

		for (const [tid, bp] of Object.entries(metadata.territories)) {
			if (!bp.racket) continue;
			const path = pathRefs.current[tid];
			if (!path) continue;

			try {
				const bbox = path.getBBox();
				const cx = bbox.x + bbox.width / 2;
				const cy = bbox.y + bbox.height / 2;

				centersRef.current[tid] = {
					lat: 912 - cy,
					lng: cx,
				};

				const racketDot = document.createElementNS(
					"http://www.w3.org/2000/svg",
					"circle",
				);
				racketDot.setAttribute("cx", cx.toString());
				racketDot.setAttribute("cy", cy.toString());
				racketDot.setAttribute("r", dotRadius);
				racketDot.setAttribute("fill", "#fbbf24");
				racketDot.setAttribute("stroke", "#07090e");
				racketDot.setAttribute("stroke-width", strokeWidth);
				racketDot.classList.add("racket-dot");
				racketDot.style.pointerEvents = "none";

				racketsGroup.appendChild(racketDot);
				racketDotsRef.current.push(racketDot);
			} catch {
				// fallback
			}
		}
	}, [metadata]);

	// Initialize Leaflet & Load SVG
	useEffect(() => {
		if (!containerRef.current || mapRef.current) return;

		let isCancelled = false;

		const bounds: L.LatLngBoundsExpression = [
			[0, 0],
			[912, 1564],
		];

		const map = L.map(containerRef.current, {
			crs: L.CRS.Simple,
			minZoom: -1.2,
			maxZoom: 2.5,
			maxBounds: bounds,
			maxBoundsViscosity: 0.95,
			zoomSnap: 0,
			zoomDelta: 0.25,
			wheelPxPerZoomLevel: 120,
			wheelDebounceTime: 30,
			zoomAnimation: true,
			zoomAnimationThreshold: 8,
			attributionControl: false,
			zoomControl: true,
			preferCanvas: true,
		});

		mapRef.current = map;
		labelsLayerRef.current = L.layerGroup().addTo(map);

		map.on("dragstart", () => {
			isDraggingRef.current = true;
		});

		map.on("dragend", () => {
			isDraggingRef.current = false;
			suppressPaintUntilRef.current = Date.now() + PAINT_SUPPRESS_AFTER_DRAG_MS;
		});

		// Center view on central Torn City district with tactical initial frame
		map.setView([456, 782], 0.1);

		const loadMapSvg = async () => {
			try {
				const res = await fetch("/torn-territory-map.svg");
				let rawSvg = await res.text();

				if (isCancelled || !mapRef.current || mapRef.current !== map) return;

				if (rawSvg.includes("xlink:href") && !rawSvg.includes("xmlns:xlink")) {
					rawSvg = rawSvg.replace(
						/<svg\s/i,
						'<svg xmlns:xlink="http://www.w3.org/1999/xlink" ',
					);
				}

				rawSvg = rawSvg.replace(
					/(href|xlink:href)=["']\/?(images\/[^"']+)["']/g,
					'$1="https://www.torn.com/$2"',
				);

				const parser = new DOMParser();
				const doc = parser.parseFromString(rawSvg, "image/svg+xml");
				const root = doc.documentElement;

				if (root?.nodeName.toLowerCase() !== "svg") return;

				const svgEl = document.createElementNS(
					"http://www.w3.org/2000/svg",
					"svg",
				);
				root.querySelectorAll("script").forEach((s) => {
					s.remove();
				});
				svgEl.innerHTML = root.innerHTML;

				svgEl.removeAttribute("style");
				svgEl.removeAttribute("width");
				svgEl.removeAttribute("height");
				svgEl.classList.remove("leaflet-zoom-hide");
				svgEl.setAttribute("viewBox", "0 0 1564 912");

				const defs = svgEl.querySelector("defs");
				if (defs) defs.innerHTML = "";

				svgEl.querySelectorAll("style").forEach((s) => {
					s.remove();
				});

				// Create dedicated layer for live rackets
				const racketsGroup = document.createElementNS(
					"http://www.w3.org/2000/svg",
					"g",
				);
				racketsGroup.setAttribute("id", "tactical-rackets-group");
				svgEl.appendChild(racketsGroup);
				racketsGroupRef.current = racketsGroup;

				svgEl.style.opacity = "0";
				svgEl.style.transition = "opacity 300ms ease-out";

				if (isCancelled || !mapRef.current || mapRef.current !== map) return;

				L.svgOverlay(svgEl, bounds, {
					interactive: true,
					className: "torn-tactical-overlay",
				}).addTo(map);

				const paths = svgEl.querySelectorAll("path");

				paths.forEach((path) => {
					const dbId = path.getAttribute("db_id") ?? "";
					const label = path.getAttribute("aria-label") ?? "";
					const territoryId = label || dbId;

					path.removeAttribute("class");
					path.removeAttribute("style");

					path.setAttribute("fill", TERRITORY_DEFAULT_FILL);
					path.setAttribute("fill-opacity", TERRITORY_DEFAULT_FILL_OPACITY);
					path.setAttribute("stroke", TERRITORY_DEFAULT_STROKE);
					path.setAttribute("stroke-width", TERRITORY_DEFAULT_STROKE_WIDTH);
					path.style.fill = TERRITORY_DEFAULT_FILL;
					path.style.fillOpacity = TERRITORY_DEFAULT_FILL_OPACITY;
					path.style.stroke = TERRITORY_DEFAULT_STROKE;
					path.style.strokeWidth = TERRITORY_DEFAULT_STROKE_WIDTH;
					path.style.cursor = "pointer";

					path.addEventListener("click", (e) => {
						e.stopPropagation();
						if (
							isDraggingRef.current ||
							Date.now() < suppressPaintUntilRef.current
						) {
							return;
						}
						document.dispatchEvent(
							new CustomEvent("tacticalTerritoryClick", {
								detail: { territoryId },
							}),
						);
					});

					path.addEventListener("mouseenter", (e) => {
						document.dispatchEvent(
							new CustomEvent("tacticalTerritoryHover", {
								detail: { territoryId, mouseEvent: e, type: "enter" },
							}),
						);
					});

					path.addEventListener("mousemove", (e) => {
						document.dispatchEvent(
							new CustomEvent("tacticalTerritoryHover", {
								detail: { territoryId, mouseEvent: e, type: "move" },
							}),
						);
					});

					path.addEventListener("mouseleave", () => {
						document.dispatchEvent(
							new CustomEvent("tacticalTerritoryHover", {
								detail: { territoryId, type: "leave" },
							}),
						);
					});

					pathRefs.current[territoryId] = path;
				});

				// Ultra-smooth racket indicator scaling on zoom using pre-cached DOM nodes
				map.on("zoom", () => {
					const zoom = map.getZoom();
					const scale = 2 ** -zoom;
					const dotRadius = (2.2 * scale).toString();
					const strokeWidth = (0.6 * scale).toString();

					for (const el of racketDotsRef.current) {
						el.setAttribute("r", dotRadius);
						el.setAttribute("stroke-width", strokeWidth);
					}
				});

				svgEl.style.opacity = "1";
				document.dispatchEvent(new CustomEvent("refreshTacticalLabels"));
				syncRackets();
				onMapReadyRef.current?.();
			} catch (err) {
				console.error("[TacticalMapCanvas] SVG Initialization Error:", err);
				onMapReadyRef.current?.();
			}
		};

		void loadMapSvg();

		return () => {
			isCancelled = true;
			if (mapRef.current) {
				mapRef.current.remove();
				mapRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		syncRackets();
	}, [syncRackets]);

	// Listen for territory clicks
	useEffect(() => {
		const handleTerritoryClickEvent = (e: Event) => {
			const customEvent = e as CustomEvent<{ territoryId: string }>;
			onTerritoryClick(customEvent.detail.territoryId);
		};

		document.addEventListener(
			"tacticalTerritoryClick",
			handleTerritoryClickEvent,
		);
		return () =>
			document.removeEventListener(
				"tacticalTerritoryClick",
				handleTerritoryClickEvent,
			);
	}, [onTerritoryClick]);

	// Listen for territory hover
	useEffect(() => {
		const handleHoverEvent = (e: Event) => {
			const customEvent = e as CustomEvent<{
				territoryId: string;
				mouseEvent?: MouseEvent;
				type: "enter" | "move" | "leave";
			}>;
			const { territoryId, mouseEvent, type } = customEvent.detail;

			if (type === "leave") {
				onHoverChange(null, { x: 0, y: 0 });
				return;
			}

			if (!metadata) return;
			const bp = metadata.territories[territoryId];
			if (!bp) return;

			let racketData:
				| {
						name: string;
						rewardInfo: RewardInfo | null;
						dailyValue: number;
				  }
				| undefined;

			if (bp.racket) {
				const rewardInfo = parseRewardString(
					bp.racket.reward,
					metadata.itemNames,
				);
				const dailyValue = calculateDailyValue(rewardInfo, metadata.prices);

				racketData = {
					name: bp.racket.name,
					rewardInfo,
					dailyValue,
				};
			}

			const assignedLabelId = assignments[territoryId];
			const assignedLabel = assignedLabelId
				? labels.find((l) => l.id === assignedLabelId)
				: undefined;

			const mousePos = mouseEvent
				? { x: mouseEvent.clientX, y: mouseEvent.clientY }
				: { x: 0, y: 0 };

			onHoverChange(
				{
					territoryId,
					sector: bp.sector,
					respect: bp.respect,
					size: bp.size,
					density: bp.density,
					slots: bp.slots,
					racket: racketData,
					assignedLabel: assignedLabel
						? { text: assignedLabel.text, color: assignedLabel.color }
						: undefined,
				},
				mousePos,
			);
		};

		document.addEventListener("tacticalTerritoryHover", handleHoverEvent);
		return () =>
			document.removeEventListener("tacticalTerritoryHover", handleHoverEvent);
	}, [metadata, assignments, labels, onHoverChange]);

	// Synchronize paths color styling and Centroid labels
	const syncVisuals = useCallback(() => {
		// 1. Sync SVG Path colors
		Object.entries(pathRefs.current).forEach(([tid, path]) => {
			const labelId = assignments[tid];
			const label = labelId ? labels.find((l) => l.id === labelId) : null;
			const isAssigned = Boolean(label?.enabled);

			const fill = isAssigned ? label?.color : TERRITORY_DEFAULT_FILL;
			const fillOpacity = isAssigned
				? TERRITORY_ASSIGNED_FILL_OPACITY
				: TERRITORY_DEFAULT_FILL_OPACITY;
			const stroke = isAssigned ? label?.color : TERRITORY_DEFAULT_STROKE;
			const strokeWidth = isAssigned
				? TERRITORY_ASSIGNED_STROKE_WIDTH
				: TERRITORY_DEFAULT_STROKE_WIDTH;

			if (fill) {
				path.setAttribute("fill", fill);
				path.style.fill = fill;
			}
			path.setAttribute("fill-opacity", fillOpacity);
			path.style.fillOpacity = fillOpacity;
			if (stroke) {
				path.setAttribute("stroke", stroke);
				path.style.stroke = stroke;
			}
			path.setAttribute("stroke-width", strokeWidth);
			path.style.strokeWidth = strokeWidth;
		});

		// 2. Sync Map Centroid Labels
		const labelsLayer = labelsLayerRef.current;
		if (!mapRef.current || !labelsLayer) return;
		labelsLayer.clearLayers();

		const getCenter = (tid: string): { lat: number; lng: number } | null => {
			if (centersRef.current[tid]) return centersRef.current[tid];
			const path = pathRefs.current[tid];
			if (!path) return null;
			try {
				const bbox = path.getBBox();
				const center = {
					lat: 912 - (bbox.y + bbox.height / 2),
					lng: bbox.x + bbox.width / 2,
				};
				centersRef.current[tid] = center;
				return center;
			} catch {
				return null;
			}
		};

		const groups: Record<string, string[]> = {};
		Object.entries(assignments).forEach(([tid, lid]) => {
			if (!groups[lid]) groups[lid] = [];
			groups[lid].push(tid);
		});

		Object.entries(groups).forEach(([lid, tids]) => {
			const config = labels.find((l) => l.id === lid);
			if (!config?.enabled || tids.length === 0) return;

			const ownedCenters = tids
				.map((tid) => getCenter(tid))
				.filter((c): c is { lat: number; lng: number } => !!c);

			if (ownedCenters.length > 0) {
				const centroid = ownedCenters.reduce(
					(acc, center) => {
						acc.lat += center.lat;
						acc.lng += center.lng;
						return acc;
					},
					{ lat: 0, lng: 0 },
				);
				centroid.lat /= ownedCenters.length;
				centroid.lng /= ownedCenters.length;

				// Snap to nearest owned TT center
				let anchor = ownedCenters[0] ?? centroid;
				let bestDistance = Number.POSITIVE_INFINITY;
				ownedCenters.forEach((center) => {
					const dLat = center.lat - centroid.lat;
					const dLng = center.lng - centroid.lng;
					const distSq = dLat * dLat + dLng * dLng;
					if (distSq < bestDistance) {
						bestDistance = distSq;
						anchor = center;
					}
				});

				const centerPos: L.LatLngExpression = [anchor.lat, anchor.lng];
				const icon = L.divIcon({
					className: "map-factions-label",
					html: `
						<div class="map-factions-label-badge" style="border-color: ${config.color}; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.9), 0 0 14px ${config.color}50;">
							<span class="map-faction-dot" style="background-color: ${config.color}; box-shadow: 0 0 8px ${config.color};"></span>
							<span class="map-faction-name">${config.text}</span>
							<span class="map-faction-count" style="background-color: ${config.color}35; color: #ffffff; border: 1px solid ${config.color}70;">${tids.length}</span>
						</div>
					`,
					iconSize: [140, 28],
					iconAnchor: [70, 14],
				});

				L.marker(centerPos, { icon, interactive: false }).addTo(labelsLayer);
			}
		});
	}, [assignments, labels]);

	useEffect(() => {
		syncVisuals();
	}, [syncVisuals]);

	return (
		<div className="relative w-full h-full bg-[#07090e] overflow-hidden select-none">
			<div ref={containerRef} className="w-full h-full" />
		</div>
	);
}
