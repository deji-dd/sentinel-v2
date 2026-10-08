import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../config";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

/**
 * The floating launcher.
 *
 * It is a real `<button>` rather than a `<div>` with mouse handlers: it is the only
 * way into the panel, and a div cannot be reached with Tab, announced by a screen
 * reader, or opened with Enter or Space. Dragging still works, and a drag no longer
 * also counts as a click — the movement threshold suppresses the click instead of
 * relying on a timer that could re-arm mid-gesture.
 */
export class FloatingLauncher {
	private element: HTMLButtonElement;
	private onClick: () => void;
	private isDragging = false;
	private startX = 0;
	private startY = 0;
	private initialLeft = 0;
	private initialTop = 0;

	constructor(onClick: () => void) {
		this.onClick = onClick;
		this.element = document.createElement("button");
		this.element.type = "button";
		this.element.className = "blasted-launcher";
		this.element.title = "Blasted's Script — open the dashboard";
		this.element.setAttribute("aria-label", "Open Blasted's Script dashboard");
		this.element.setAttribute("aria-haspopup", "dialog");
		this.element.innerHTML = `
			<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
			</svg>
		`;

		this.restorePosition();
		this.attachDragEvents();
	}

	public getElement(): HTMLElement {
		return this.element;
	}

	private clamp(x: number, y: number): { x: number; y: number } {
		return {
			x: Math.max(10, Math.min(window.innerWidth - 54, x)),
			y: Math.max(10, Math.min(window.innerHeight - 54, y)),
		};
	}

	private restorePosition(): void {
		const pos = GM_getValue<{ x: number; y: number }>(
			STORAGE_KEYS.position,
			DEFAULT_SETTINGS.position,
		);
		const { x, y } = this.clamp(pos?.x ?? 20, pos?.y ?? 120);
		this.element.style.left = `${x}px`;
		this.element.style.top = `${y}px`;
	}

	private attachDragEvents(): void {
		const onStart = (clientX: number, clientY: number) => {
			this.isDragging = false;
			this.startX = clientX;
			this.startY = clientY;
			const rect = this.element.getBoundingClientRect();
			this.initialLeft = rect.left;
			this.initialTop = rect.top;
		};

		const onMove = (clientX: number, clientY: number) => {
			const dx = clientX - this.startX;
			const dy = clientY - this.startY;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
				this.isDragging = true;
			}
			if (this.isDragging) {
				const { x, y } = this.clamp(
					this.initialLeft + dx,
					this.initialTop + dy,
				);
				this.element.style.left = `${x}px`;
				this.element.style.top = `${y}px`;
			}
		};

		const onEnd = () => {
			if (this.isDragging) {
				const rect = this.element.getBoundingClientRect();
				GM_setValue(STORAGE_KEYS.position, {
					x: Math.round(rect.left),
					y: Math.round(rect.top),
				});
			}
		};

		// A drag must not also fire the click that follows the mouseup, so the button's
		// own click handler is the only place the panel is toggled and the flag is
		// cleared once that click has been dealt with.
		this.element.addEventListener("click", (event) => {
			if (this.isDragging) {
				event.preventDefault();
				this.isDragging = false;
				return;
			}
			this.onClick();
		});

		// Mouse events
		this.element.addEventListener("mousedown", (event) => {
			if (event.button !== 0) return;
			onStart(event.clientX, event.clientY);

			const mouseMove = (ev: MouseEvent) => onMove(ev.clientX, ev.clientY);
			const mouseUp = () => {
				window.removeEventListener("mousemove", mouseMove);
				window.removeEventListener("mouseup", mouseUp);
				onEnd();
			};

			window.addEventListener("mousemove", mouseMove);
			window.addEventListener("mouseup", mouseUp);
		});

		// Touch events (Mobile support)
		this.element.addEventListener(
			"touchstart",
			(event) => {
				const touch = event.touches[0];
				if (!touch) return;
				onStart(touch.clientX, touch.clientY);

				const touchMove = (ev: TouchEvent) => {
					const t = ev.touches[0];
					if (t) onMove(t.clientX, t.clientY);
				};

				const touchEnd = () => {
					window.removeEventListener("touchmove", touchMove);
					window.removeEventListener("touchend", touchEnd);
					onEnd();
					// Touch does not fire a click after a drag on every browser, so the
					// panel opens here unless the gesture moved.
					if (!this.isDragging) this.onClick();
					this.isDragging = false;
				};

				window.addEventListener("touchmove", touchMove, { passive: true });
				window.addEventListener("touchend", touchEnd);
			},
			{ passive: true },
		);

		// Arrow keys nudge the button, so it can be moved without a pointer.
		this.element.addEventListener("keydown", (event) => {
			const step = event.shiftKey ? 40 : 10;
			const offsets: Record<string, { dx: number; dy: number }> = {
				ArrowUp: { dx: 0, dy: -step },
				ArrowDown: { dx: 0, dy: step },
				ArrowLeft: { dx: -step, dy: 0 },
				ArrowRight: { dx: step, dy: 0 },
			};
			const offset = offsets[event.key];
			if (!offset) return;

			event.preventDefault();
			const rect = this.element.getBoundingClientRect();
			const { x, y } = this.clamp(rect.left + offset.dx, rect.top + offset.dy);
			this.element.style.left = `${x}px`;
			this.element.style.top = `${y}px`;
			GM_setValue(STORAGE_KEYS.position, {
				x: Math.round(x),
				y: Math.round(y),
			});
		});

		// Adjust on window resize
		window.addEventListener("resize", () => {
			this.restorePosition();
		});
	}
}
