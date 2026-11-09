// Drag to reorder, with Torn chat's thresholds: a mouse drag starts after
// 3px, a touch drag after holding 250ms. The element follows the pointer; on
// drop the nearest slot wins.

export interface Slot {
	key: string;
	center: number;
}

export interface SortableOptions {
	el: HTMLElement;
	key: string;
	/** Whether a pointerdown on this target may start a drag (headers yes, inputs and menus no). */
	canStart: (target: Element) => boolean;
	/** Slot centers (x) of every sortable item, this one included, read when the drag starts. */
	slots: () => Slot[];
	/** The element's resting transform, kept under the drag offset. */
	base: () => string;
	axis: "x" | "xy";
	onStart?: () => void;
	/** targetKey is null when dropped back on its own slot or cancelled. */
	onEnd: (targetKey: string | null) => void;
}

const MOUSE_DISTANCE = 3;
const TOUCH_DELAY = 250;
const TOUCH_TOLERANCE = 5;

export function sortable(options: SortableOptions): void {
	options.el.addEventListener("pointerdown", (down) => {
		if (down.button !== 0 || !options.canStart(down.target as Element)) return;
		const touch = down.pointerType === "touch";
		const startedAt = performance.now();
		let active = false;
		let slots: Slot[] = [];

		const detach = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
		};
		const finish = (target: string | null) => {
			detach();
			if (!active) return;
			options.el.classList.remove("sc-dragging");
			swallowNextClick(options.el);
			options.onEnd(target === options.key ? null : target);
		};
		const move = (event: PointerEvent) => {
			const dx = event.clientX - down.clientX;
			const dy = event.clientY - down.clientY;
			if (!active) {
				const distance = Math.hypot(dx, dy);
				const held = performance.now() - startedAt;
				if (touch) {
					if (held < TOUCH_DELAY) {
						if (distance > TOUCH_TOLERANCE) detach();
						return;
					}
				} else if (distance < MOUSE_DISTANCE) {
					return;
				}
				active = true;
				slots = options.slots();
				options.el.classList.add("sc-dragging");
				options.onStart?.();
			}
			event.preventDefault();
			options.el.style.transform = `${options.base()} translate(${dx}px, ${
				options.axis === "xy" ? dy : 0
			}px)`;
		};
		const up = (event: PointerEvent) => {
			if (!active) {
				detach();
				return;
			}
			let best: string | null = null;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (const slot of slots) {
				const distance = Math.abs(slot.center - event.clientX);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = slot.key;
				}
			}
			finish(best);
		};
		const cancel = () => finish(null);
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
	});
}

/** The click that ends a drag must not also toggle the panel or open its menu. */
function swallowNextClick(el: HTMLElement): void {
	const stop = (event: Event) => {
		event.stopPropagation();
		event.preventDefault();
	};
	el.addEventListener("click", stop, { capture: true, once: true });
	setTimeout(
		() => el.removeEventListener("click", stop, { capture: true }),
		400,
	);
}
