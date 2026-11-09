// Puts our buttons into Torn's chat bar and our panels next to Torn's open
// panels. Panels are laid out like Torn's: stacked in one grid cell, each slid
// left with translateX and a 150ms linear transition, reorderable by dragging
// the header; bar buttons are reorderable too.
import { atBadge, badge, cx, h, icon, roomIcon } from "../dom";
import {
	DIRECTORY,
	joinedRooms,
	minimizePanels,
	moveBarButton,
	movePanel,
	PANEL_SIZE_LIMITS,
	panelSizeFor,
	state,
	toggleDirectory,
	toggleRoom,
	visiblePanels,
} from "../store";
import { Directory } from "./directory";
import { sortable } from "./drag";
import { attachPanelResize, isResizingPanel } from "./resize";
import { RoomPanel } from "./room";

const PANEL_GAP = 3; // Torn spaces its 300px panels 303px apart
const BAR_HEIGHT = 38;
const BAR_GAP = 5;

/** A pointerdown that may start dragging a panel: on its header, not on its menu or inputs. */
const isPanelHandle = (target: Element) =>
	!!target.closest(".sc_root___RdBC0, .sc-panel > .sc_root___zZRe1") &&
	!target.closest(".sc_optionsContainer___CpJ5q, input, textarea");

export class Layout {
	private root = h("div", { c: "sc-root" });
	private panels = h("div", { c: "sc-panels" });
	private bar = h("div", { c: "sc-bar" });
	private directory: Directory;
	private rooms = new Map<string, RoomPanel>();
	private offsets = new Map<string, number>();
	private dragging: string | null = null;
	private barDragging = false;
	private observer: MutationObserver;
	private frame = 0;
	private lastBar: HTMLElement | null = null;

	constructor(onOpenSettings: () => void) {
		this.directory = new Directory(onOpenSettings);
		this.bindPanelDrag(this.directory.el, DIRECTORY);
		this.bindPanelResize(this.directory.el, DIRECTORY);
		this.root.append(this.panels);
		document.body.append(this.root);
		this.observer = new MutationObserver(() => this.schedule());
		this.watch();
		window.addEventListener("resize", () => this.schedule());
	}

	private watch(): void {
		const chat = document.getElementById("chatRoot");
		if (chat) {
			this.observer.observe(chat, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["class", "style"],
			});
		}
	}

	private schedule(): void {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.mountBar();
			this.position();
		});
	}

	/**
	 * Torn's bar is React-managed and re-renders; keep our buttons in it, before
	 * the Notes button. Anchoring on the Notes/People button's parent is more
	 * robust than a hashed bar class, which changes with every Torn build.
	 */
	private mountBar(): void {
		const anchor =
			document.getElementById("notes_panel_button") ??
			document.getElementById("people_panel_button");
		if (!anchor) return;
		const tornBar = anchor.parentElement;
		if (!tornBar) return;
		if (
			this.bar.parentElement !== tornBar ||
			this.bar.nextElementSibling !== anchor
		) {
			this.observer.disconnect();
			tornBar.insertBefore(this.bar, anchor);
			this.watch();
		}
		this.lastBar = tornBar;
	}

	/** Our stack sits left of Torn's visible panels, on the same baseline; each panel slides to its slot. */
	private position(): void {
		if (isResizingPanel()) return;
		let left = window.innerWidth - 5 + PANEL_GAP;
		for (const panel of document.querySelectorAll<HTMLElement>(
			'#chatRoot [class*="visible___"][class*="root___"]',
		)) {
			const rect = panel.getBoundingClientRect();
			if (rect.width > 0 && rect.left < left) left = rect.left;
		}
		const tornBar = this.lastBar?.getBoundingClientRect();
		const bottom =
			tornBar && tornBar.height
				? window.innerHeight - tornBar.top + BAR_GAP
				: BAR_HEIGHT + BAR_GAP;
		this.root.style.right = `${Math.max(5, window.innerWidth - left + PANEL_GAP)}px`;
		this.root.style.bottom = `${bottom}px`;

		const room = left - PANEL_GAP - 5; // width left of Torn's panels
		const maxHeight = Math.max(
			PANEL_SIZE_LIMITS.minHeight,
			window.innerHeight - bottom - 10,
		);
		let offset = 0;
		const overflow: string[] = [];
		this.offsets.clear();
		for (const key of visiblePanels()) {
			const element = this.panelEl(key);
			if (!element) continue;
			const size = panelSizeFor(key);
			const width = Math.min(size.width, Math.max(200, room));
			const height = Math.min(size.height, maxHeight);
			// Keep at least the rightmost panel; the rest must fit on screen.
			if (offset > 0 && offset + width > room && key !== this.dragging) {
				overflow.push(key);
				continue;
			}
			this.offsets.set(key, offset);
			element.style.width = `${width}px`;
			element.style.height = `${height}px`;
			if (key !== this.dragging) {
				element.style.transform = `translateX(-${offset}px)`;
			}
			offset += width + PANEL_GAP;
		}
		if (overflow.length && !this.dragging) minimizePanels(overflow);
	}

	private panelEl(key: string): HTMLElement | undefined {
		return key === DIRECTORY ? this.directory.el : this.rooms.get(key)?.el;
	}

	private bindPanelResize(el: HTMLElement, key: string): void {
		attachPanelResize(el, key);
	}

	private bindPanelDrag(el: HTMLElement, key: string): void {
		sortable({
			el,
			key,
			axis: "xy",
			canStart: isPanelHandle,
			base: () => `translateX(-${this.offsets.get(key) ?? 0}px)`,
			slots: () =>
				visiblePanels().flatMap((other) => {
					const rect = this.panelEl(other)?.getBoundingClientRect();
					return rect
						? [{ key: other, center: rect.left + rect.width / 2 }]
						: [];
				}),
			onStart: () => (this.dragging = key),
			onEnd: (target) => {
				this.dragging = null;
				if (target) movePanel(key, target);
				this.position();
			},
		});
	}

	render(): void {
		if (!this.barDragging) this.renderBar();
		this.renderPanels();
		this.schedule();
	}

	private renderBar(): void {
		const buttons: HTMLElement[] = [];
		for (const id of state.open) {
			const room = state.rooms.get(id);
			if (!room) continue;
			const opened = state.expanded.has(id);
			const button = h(
				"button",
				{
					type: "button",
					id: `sc_chat_panel_button:${id}`,
					title: room.name,
					c: cx(
						"root___zZRe1 root___rnQAo root___y4L37",
						opened && "opened___dihOy opened___PTx4p",
						room.unread > 0 && "message___g25GS",
						room.color && "sc-colored",
					),
					style: room.color ? `--sc-room: ${room.color}` : undefined,
					on: { click: () => toggleRoom(id) },
				},
				roomIcon(room.icon, cx("icon___vikBy", opened && "opened___p8ZQ1")),
				badge("messageCount___db2PN", room.unread),
				room.joined ? atBadge("sc-at-bar", room.mentions) : null,
			);
			const wrap = h(
				"div",
				{ c: "root___tV4zg sc-bar-item", "data-room": id },
				button,
			);
			sortable({
				el: wrap,
				key: id,
				axis: "x",
				canStart: () => true,
				base: () => "",
				slots: () =>
					[...this.bar.querySelectorAll<HTMLElement>(".sc-bar-item")].map(
						(item) => {
							const rect = item.getBoundingClientRect();
							return {
								key: item.dataset.room ?? "",
								center: rect.left + rect.width / 2,
							};
						},
					),
				onStart: () => (this.barDragging = true),
				onEnd: (target) => {
					this.barDragging = false;
					wrap.style.transform = "";
					if (target) moveBarButton(id, target);
					else this.renderBar();
				},
			});
			buttons.push(wrap);
		}
		const unread = joinedRooms()
			.filter((room) => !state.open.includes(room.id))
			.reduce((count, room) => count + room.unread, 0);
		buttons.push(
			h(
				"button",
				{
					type: "button",
					id: "sc_rooms_panel_button",
					title: "Rooms",
					c: cx(
						"root___zZRe1 root___mRtyn",
						state.directory && "opened___dihOy",
					),
					on: { click: () => toggleDirectory() },
				},
				icon("chats", cx("icon___aydeq", state.directory && "opened___zdbFJ")),
				badge("messageCount___EWpiR", unread),
			),
		);
		this.bar.replaceChildren(...buttons);
	}

	private renderPanels(): void {
		for (const [id, panel] of this.rooms) {
			if (!state.expanded.has(id) || !state.rooms.has(id)) {
				panel.destroy();
				this.rooms.delete(id);
			}
		}
		if (state.directory) this.directory.render();
		const wanted: HTMLElement[] = [];
		for (const key of visiblePanels()) {
			if (key === DIRECTORY) {
				wanted.push(this.directory.el);
				continue;
			}
			let panel = this.rooms.get(key);
			if (!panel) {
				panel = new RoomPanel(key);
				this.rooms.set(key, panel);
				this.bindPanelDrag(panel.el, key);
				this.bindPanelResize(panel.el, key);
				// Start at its slot, then slide like Torn's panels do.
				panel.el.style.transform = `translateX(-${this.offsets.get(key) ?? 0}px)`;
			} else {
				panel.update();
			}
			wanted.push(panel.el);
		}
		// Panels share one grid cell, so DOM order never matters for layout: only add and remove.
		for (const element of [...this.panels.children]) {
			if (!wanted.includes(element as HTMLElement)) element.remove();
		}
		for (const element of wanted) {
			if (element.parentElement !== this.panels) this.panels.append(element);
		}
	}
}
