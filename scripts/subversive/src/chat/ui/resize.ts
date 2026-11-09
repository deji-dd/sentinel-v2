// Drag the left edge to resize a chat panel's width, or the top edge to resize
// its height. Panels are anchored to the bottom-right, so dragging left/up
// grows them. Double-click a handle to forget this panel's custom size.
import { h } from "../dom";
import { PANEL_SIZE_LIMITS, setRoomPanelSize } from "../store";

let resizing = false;

/** Layout must not re-apply sizes while a pointer drag is in progress. */
export function isResizingPanel(): boolean {
	return resizing;
}

function clamp(value: number, min: number, max: number): number {
	return Math.round(Math.max(min, Math.min(max, value)));
}

type Axis = "width" | "height";

function bindHandle(el: HTMLElement, key: string, axis: Axis): void {
	const handle = h("div", {
		c: `sc-resize-${axis}`,
		title:
			axis === "width"
				? "Drag left to widen this panel"
				: "Drag up to make this panel taller",
		role: "separator",
		"aria-label": axis === "width" ? "Resize width" : "Resize height",
		on: {
			pointerdown: (event: Event) => {
				const down = event as PointerEvent;
				if (down.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				resizing = true;
				el.classList.add("sc-resizing");
				const startWidth = el.offsetWidth;
				const startHeight = el.offsetHeight;
				const startX = down.clientX;
				const startY = down.clientY;

				const onMove = (move: PointerEvent) => {
					move.preventDefault();
					if (axis === "width") {
						const width = clamp(
							startWidth - (move.clientX - startX),
							PANEL_SIZE_LIMITS.minWidth,
							PANEL_SIZE_LIMITS.maxWidth,
						);
						el.style.width = `${width}px`;
					} else {
						const height = clamp(
							startHeight - (move.clientY - startY),
							PANEL_SIZE_LIMITS.minHeight,
							PANEL_SIZE_LIMITS.maxHeight,
						);
						el.style.height = `${height}px`;
					}
				};
				const finish = () => {
					if (!resizing) return;
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", finish);
					window.removeEventListener("pointercancel", finish);
					window.removeEventListener("blur", finish);
					resizing = false;
					el.classList.remove("sc-resizing");
					setRoomPanelSize(key, {
						width: el.offsetWidth,
						height: el.offsetHeight,
					});
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", finish);
				window.addEventListener("pointercancel", finish);
				window.addEventListener("blur", finish);
			},
			dblclick: (event: Event) => {
				event.preventDefault();
				event.stopPropagation();
				setRoomPanelSize(key, null);
			},
		},
	});
	el.append(handle);
}

export function attachPanelResize(el: HTMLElement, key: string): void {
	bindHandle(el, key, "width");
	bindHandle(el, key, "height");
}
