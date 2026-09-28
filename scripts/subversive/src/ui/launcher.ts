import { STORAGE } from "../constants";
import { state } from "../state";
import { closePanel, openPanel, positionPanel, setStatus } from "./panel";

let launcherElem: HTMLElement | null = null;

export function resetLauncherPosition(): void {
	if (!launcherElem) return;
	const defaultX = Math.max(10, window.innerWidth - 64);
	const defaultY = Math.max(10, window.innerHeight - 84);
	launcherElem.style.left = `${defaultX}px`;
	launcherElem.style.top = `${defaultY}px`;
	GM_setValue(STORAGE.position, { x: defaultX, y: defaultY });
	if (state.panelOpen) {
		positionPanel();
	}
	setStatus("UI position reset to default", "ok");
}

export function initLauncher(root: ShadowRoot | Document): void {
	launcherElem = root.getElementById("satf-launcher") as HTMLElement | null;
	if (!launcherElem) return;

	if (typeof GM_registerMenuCommand === "function") {
		try {
			GM_registerMenuCommand("Reset UI Position", resetLauncherPosition);
		} catch {}
	}

	window.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.altKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
			resetLauncherPosition();
		}
	});

	// Restore saved position
	const savedPos = GM_getValue<{ x?: number; y?: number } | null>(
		STORAGE.position,
		null,
	);
	if (
		savedPos &&
		typeof savedPos.x === "number" &&
		typeof savedPos.y === "number"
	) {
		const lWidth = launcherElem.offsetWidth || 48;
		const lHeight = launcherElem.offsetHeight || 48;
		const clampedX = Math.max(
			10,
			Math.min(window.innerWidth - lWidth - 10, savedPos.x),
		);
		const clampedY = Math.max(
			10,
			Math.min(window.innerHeight - lHeight - 10, savedPos.y),
		);
		launcherElem.style.left = `${clampedX}px`;
		launcherElem.style.top = `${clampedY}px`;
		if (savedPos.x !== clampedX || savedPos.y !== clampedY) {
			GM_setValue(STORAGE.position, { x: clampedX, y: clampedY });
		}
	}

	// Pointer Dragging
	let isDragging = false;
	let dragStartX = 0;
	let dragStartY = 0;
	let initialLeft = 0;
	let initialTop = 0;

	launcherElem.addEventListener("pointerdown", (e: PointerEvent) => {
		if (e.button !== 0 || !launcherElem) return;
		isDragging = false;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		const rect = launcherElem.getBoundingClientRect();
		initialLeft = rect.left;
		initialTop = rect.top;

		const onMove = (moveEvt: PointerEvent) => {
			if (!launcherElem) return;
			const dx = moveEvt.clientX - dragStartX;
			const dy = moveEvt.clientY - dragStartY;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDragging = true;
			const lWidth = launcherElem.offsetWidth || 48;
			const lHeight = launcherElem.offsetHeight || 48;
			const newLLeft = Math.max(
				10,
				Math.min(window.innerWidth - lWidth - 10, initialLeft + dx),
			);
			const newLTop = Math.max(
				10,
				Math.min(window.innerHeight - lHeight - 10, initialTop + dy),
			);
			launcherElem.style.left = `${newLLeft}px`;
			launcherElem.style.top = `${newLTop}px`;
			if (state.panelOpen) {
				positionPanel();
			}
		};

		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			if (!launcherElem) return;

			if (isDragging) {
				const finalRect = launcherElem.getBoundingClientRect();
				const lWidth = launcherElem.offsetWidth || 48;
				const lHeight = launcherElem.offsetHeight || 48;
				const clampedX = Math.max(
					10,
					Math.min(window.innerWidth - lWidth - 10, finalRect.left),
				);
				const clampedY = Math.max(
					10,
					Math.min(window.innerHeight - lHeight - 10, finalRect.top),
				);
				launcherElem.style.left = `${clampedX}px`;
				launcherElem.style.top = `${clampedY}px`;
				GM_setValue(STORAGE.position, {
					x: clampedX,
					y: clampedY,
				});
				if (state.panelOpen) {
					positionPanel();
				}
				setTimeout(() => {
					isDragging = false;
				}, 50);
			} else {
				if (state.panelOpen) {
					closePanel();
				} else {
					openPanel();
				}
			}
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	});

	window.addEventListener("resize", () => {
		if (!launcherElem) return;
		const rect = launcherElem.getBoundingClientRect();
		const lWidth = launcherElem.offsetWidth || 48;
		const lHeight = launcherElem.offsetHeight || 48;
		const clampedX = Math.max(
			10,
			Math.min(window.innerWidth - lWidth - 10, rect.left),
		);
		const clampedY = Math.max(
			10,
			Math.min(window.innerHeight - lHeight - 10, rect.top),
		);
		if (rect.left !== clampedX || rect.top !== clampedY) {
			launcherElem.style.left = `${clampedX}px`;
			launcherElem.style.top = `${clampedY}px`;
			GM_setValue(STORAGE.position, { x: clampedX, y: clampedY });
		}
		if (state.panelOpen) {
			positionPanel();
		}
	});
}
