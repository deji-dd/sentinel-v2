import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../config";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

export class FloatingLauncher {
	private element: HTMLElement;
	private onClick: () => void;
	private isDragging = false;
	private startX = 0;
	private startY = 0;
	private initialLeft = 0;
	private initialTop = 0;

	constructor(onClick: () => void) {
		this.onClick = onClick;
		this.element = document.createElement("div");
		this.element.className = "blasted-launcher";
		this.element.title = "Blasted's Script — Click to toggle dashboard";
		this.element.innerHTML = `
			<svg viewBox="0 0 24 24">
				<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
			</svg>
		`;

		this.restorePosition();
		this.attachDragEvents();
	}

	public getElement(): HTMLElement {
		return this.element;
	}

	private restorePosition(): void {
		const pos = GM_getValue<{ x: number; y: number }>(
			STORAGE_KEYS.position,
			DEFAULT_SETTINGS.position,
		);

		const clampedX = Math.max(
			10,
			Math.min(window.innerWidth - 54, pos?.x ?? 20),
		);
		const clampedY = Math.max(
			10,
			Math.min(window.innerHeight - 54, pos?.y ?? 120),
		);

		this.element.style.left = `${clampedX}px`;
		this.element.style.top = `${clampedY}px`;
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
				const nextX = Math.max(
					10,
					Math.min(window.innerWidth - 54, this.initialLeft + dx),
				);
				const nextY = Math.max(
					10,
					Math.min(window.innerHeight - 54, this.initialTop + dy),
				);
				this.element.style.left = `${nextX}px`;
				this.element.style.top = `${nextY}px`;
			}
		};

		const onEnd = () => {
			if (this.isDragging) {
				const rect = this.element.getBoundingClientRect();
				GM_setValue(STORAGE_KEYS.position, {
					x: Math.round(rect.left),
					y: Math.round(rect.top),
				});
				setTimeout(() => {
					this.isDragging = false;
				}, 50);
			} else {
				this.onClick();
			}
		};

		// Mouse events
		this.element.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			onStart(e.clientX, e.clientY);

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
			(e) => {
				const touch = e.touches[0];
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
				};

				window.addEventListener("touchmove", touchMove, { passive: true });
				window.addEventListener("touchend", touchEnd);
			},
			{ passive: true },
		);

		// Adjust on window resize
		window.addEventListener("resize", () => {
			this.restorePosition();
		});
	}
}
