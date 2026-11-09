// A room's chat panel: the same markup as Torn's faction/global panels.
import { api } from "../api";
import {
	ago,
	type Child,
	cx,
	fill,
	h,
	icon,
	linkify,
	retryIcon,
	roomIcon,
	tct,
	tctDay,
	text,
} from "../dom";
import { DEFAULT_AVATAR } from "../generated/avatar";
import type { IconName } from "../generated/icons";
import {
	CHAT_LIMITS,
	CHAT_REACTIONS,
	type ChatAccessView,
	type ChatGif,
	type ChatMessageView,
	type ChatReactionView,
	type ChatRoomView,
} from "../protocol";
import {
	closeRoom,
	deleteRoom,
	discard,
	join,
	leave,
	loadHistory,
	markRead,
	onReactions,
	onRoomMessage,
	type PendingMessage,
	react,
	refreshRooms,
	retry,
	seeMentions,
	send,
	senderName,
	state,
	tagsMe,
	toggleRoom,
} from "../store";
import {
	backView,
	info,
	parseTornId,
	setting,
	textInput,
	tornBtn,
	warning,
} from "./forms";
import { gifFromTypedText, type GifPickerHandle, openGifPicker } from "./gif";
import { roomForm } from "./roomForm";

type View = "chat" | "members" | "invite" | "settings" | "leave" | "delete";

const GAP_MS = 15 * 60 * 1000;

export class RoomPanel {
	readonly el: HTMLElement;
	private header = h("div", { c: "root___RdBC0" });
	/** faction tags and Torn's Bubbles / Avatars settings the messages were drawn with */
	private styleShown = "";
	/** Follow new messages: true while the reader is at the bottom (set by their scrolling, not re-measured). */
	private pinned = true;
	/** Messages from others that arrived while the reader was scrolled up: Torn's "↓ N new messages" pill. */
	private unseen = 0;
	/** The newest message in the list and its row: a new message after it is appended, not re-rendered. */
	private shown: ChatMessageView | null = null;
	private shownRow: HTMLElement | null = null;
	private pill: HTMLElement | null = null;
	private content = h("div", { c: "content___aMpKJ" });
	private scroller = h("div", { c: "scrollWrapper___DmIrl" });
	private list = h("div", {});
	private pendingList = h("div", {});
	private footer = h("div", { c: "footer___QxkWe" });
	private composerSlot = h("div", {});
	private textarea: HTMLTextAreaElement;
	private sendBtn: HTMLButtonElement;
	private gifBtn: HTMLButtonElement;
	private gifBar = h("div", { c: "sc-gif-bar" });
	private composer: HTMLElement;
	private composerWrap: HTMLElement;
	private gif: ChatGif | null = null;
	private gifPicker: GifPickerHandle | null = null;
	private gifViewer: HTMLElement | null = null;
	private overlay: HTMLElement | null = null;
	private view: View = "chat";
	private menuOpen = false;
	private loading = false;
	private unsub: () => void;
	private unsubReactions: () => void;
	/** Each shown message's reactions row, by message id, to redraw just that row when they change. */
	private reactionRows = new Map<number, HTMLElement>();
	/** The open emoji picker: its message and how to close it. */
	private picker: { id: number; close: () => void } | null = null;
	/** Each confirmed message's hover tools and how to place them. */
	private toolsOf = new WeakMap<
		HTMLElement,
		{ tools: HTMLElement; place: () => void }
	>();
	/** The message showing its tools under the pointer. */
	private hovered: HTMLElement | null = null;
	/** Where the pointer left the hovered message: while it heads from there to the tools, other messages keep out. */
	private exit: { x: number; y: number; at: number; dist: number } | null =
		null;
	private hoverTimer: ReturnType<typeof setTimeout> | undefined;
	/** Who reacted with one emoji, shown while the pointer is on its reaction. */
	private who: { id: number; emoji: string; el: HTMLElement } | null = null;
	private footerTimer: ReturnType<typeof setTimeout> | undefined;
	/** Torn's blue pill again, "@ N mentions": jumps to the oldest message tagging you that you have not seen. */
	private atPill: HTMLElement | null = null;
	private atShown = 0;
	private jumping = false;
	/** Messages tagging you count as seen once on screen; these are the ones on it now. */
	private mentionWatch: IntersectionObserver;
	private mentionsInView = new Set<number>();
	private onVisible = () => this.seeVisibleMentions();
	/** The names offered while typing `@`: the room's members, fetched when first needed. */
	private suggest: {
		el: HTMLElement;
		start: number;
		query: string;
		items: Candidate[];
		active: number;
	} | null = null;
	private members: { at: number; list: Candidate[] } | null = null;
	private membersLoading = false;

	constructor(readonly id: string) {
		this.el = h("div", {
			c: "root___Ex8tg root___hrPnu visible___IVBmB root___IOJWq sc-panel",
			"data-room": id,
		});
		this.textarea = h("textarea", {
			c: "textarea___JRbO5",
			placeholder: "Type your message here...",
			maxlength: CHAT_LIMITS.message,
			on: {
				keydown: (event: Event) => {
					const keyboard = event as KeyboardEvent;
					event.stopPropagation();
					if (
						this.suggest &&
						!keyboard.isComposing &&
						this.suggestKey(keyboard)
					) {
						return;
					}
					if (keyboard.key === "Enter" && !keyboard.shiftKey) {
						event.preventDefault();
						void this.submit();
					}
				},
				input: () => {
					this.syncSend();
					this.pingTyping();
					this.updateSuggest();
				},
				// The caret moved into or out of an @name.
				click: () => this.updateSuggest(),
				keyup: (event: Event) => {
					const keyboard = event as KeyboardEvent;
					if (
						["ArrowLeft", "ArrowRight", "Home", "End"].includes(keyboard.key)
					) {
						this.updateSuggest();
					}
				},
				blur: () => this.closeSuggest(),
			},
		});
		this.sendBtn = h(
			"button",
			{
				type: "button",
				c: "iconWrapper___DRSkm",
				on: { click: () => void this.submit() },
			},
			icon("send", "icon___mMNXf"),
		);
		this.gifBtn = h(
			"button",
			{
				type: "button",
				c: "sc-gif-btn",
				title: "Send a GIF",
				on: { click: () => this.toggleGifPicker() },
			},
			"GIF",
		);
		this.composer = h(
			"div",
			{ c: "root___aBCjE" },
			this.textarea,
			this.gifBtn,
			this.sendBtn,
		);
		this.composerWrap = h(
			"div",
			{ c: "sc-composer-wrap" },
			this.gifBar,
			this.composer,
		);
		// As in Torn, the "Last message" footer scrolls with the messages instead of taking a fixed strip.
		this.scroller.append(this.list, this.pendingList, this.footer);
		// A panel rendered before it is on screen (page load, minimized) has no height yet, so
		// scrolling to the newest message does nothing; redo it when the scroller gets its size.
		const follow = new ResizeObserver(() => {
			if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
		});
		follow.observe(this.scroller);
		follow.observe(this.list);
		follow.observe(this.pendingList);
		follow.observe(this.footer);
		this.scroller.addEventListener("scroll", () => {
			this.closePicker();
			if (this.scroller.clientHeight) this.pinned = this.atBottom();
			if (this.pinned && this.unseen) this.setUnseen(0);
			if (this.scroller.scrollTop < 40 && state.more.get(id) && !this.loading) {
				void this.loadOlder();
			}
			if (this.atBottom()) markRead(id);
		});
		this.scroller.addEventListener("pointermove", (event) =>
			this.trackHover(event as PointerEvent),
		);
		this.scroller.addEventListener("pointerleave", (event) => {
			if ((event as PointerEvent).pointerType !== "touch")
				this.setHovered(null);
		});
		// Half a message on screen is seen; a message taller than the panel counts once it fills half of it.
		this.mentionWatch = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const messageId = Number((entry.target as HTMLElement).dataset.id);
					if (
						entry.intersectionRatio >= 0.5 ||
						(entry.rootBounds &&
							entry.intersectionRect.height >= entry.rootBounds.height / 2)
					) {
						this.mentionsInView.add(messageId);
					} else {
						this.mentionsInView.delete(messageId);
					}
				}
				this.seeVisibleMentions();
			},
			{ root: this.scroller, threshold: [0, 0.25, 0.5, 0.75, 1] },
		);
		document.addEventListener("visibilitychange", this.onVisible);
		this.content.append(
			h("div", { c: "root___v2RvA" }, this.scroller),
			this.composerSlot,
		);
		this.el.append(this.header, this.content);
		this.unsub = onRoomMessage((roomId, msg) => {
			if (roomId !== id) return;
			const mine = !!msg && msg.userId === state.me?.id;
			if (msg && !mine && !this.pinned) this.setUnseen(this.unseen + 1);
			// Sending a message always brings you to it, as in Torn's chat.
			if (msg) this.appendMessage(msg, mine);
			else this.renderMessages();
		});
		this.unsubReactions = onReactions((roomId, msgId) => {
			const row = roomId === id && this.reactionRows.get(msgId);
			const message =
				row && state.messages.get(id)?.find((m) => m.id === msgId);
			if (row && message) this.fillReactions(row, message, true);
			// The chips were redrawn: keep the list on the one under the pointer, or drop it with its reaction.
			if (row && message && this.who?.id === msgId) {
				const chip = [...row.children].find(
					(child) => (child as HTMLElement).dataset.emoji === this.who?.emoji,
				) as HTMLElement | undefined;
				if (chip) this.showWho(message, this.who.emoji, chip);
				else this.hideWho();
			}
		});
		this.update();
		if (!state.messages.has(id) && state.rooms.get(id)?.joined) {
			void loadHistory(id).then(
				() => this.renderMessages(true),
				() => {},
			);
		} else {
			this.renderMessages(true);
		}
	}

	destroy(): void {
		this.unsub();
		this.unsubReactions();
		this.closePicker();
		this.closeSuggest();
		this.hideWho();
		this.gifPicker?.close();
		this.gifViewer?.remove();
		this.mentionWatch.disconnect();
		document.removeEventListener("visibilitychange", this.onVisible);
		clearTimeout(this.hoverTimer);
		clearTimeout(this.footerTimer);
		this.el.remove();
	}

	private get room(): ChatRoomView | undefined {
		return state.rooms.get(this.id);
	}

	/** Called on every store change: cheap parts only. */
	update(): void {
		const room = this.room;
		if (!room) return;
		this.renderHeader(room);
		this.renderComposer(room);
		this.renderGifBar();
		this.renderPending();
		this.renderFooter();
		this.renderAt(room);
		this.seeVisibleMentions();
		const style = `${room.showFactionTags}:${state.chatStyle.bubbles}:${state.chatStyle.avatars}`;
		if (style !== this.styleShown) {
			this.styleShown = style;
			this.footer.className = cx(
				"footer___QxkWe",
				!state.chatStyle.bubbles && "classic___S4LnO",
			);
			this.footerText = "";
			this.pendingKey = "";
			this.renderMessages();
			this.renderPending();
			this.renderFooter();
		}
		if (
			room.unread &&
			this.atBottom() &&
			document.visibilityState === "visible"
		) {
			markRead(this.id);
		}
	}

	// ---------------------------------------------------------------- header

	private renderHeader(room: ChatRoomView): void {
		const options: [IconName, string, () => void][] = [];
		if (room.joined) {
			options.push(["tabFriends", "Members", () => this.show("members")]);
		}
		if (room.role !== "member") {
			options.push(["tabRecent", "Invite", () => this.show("invite")]);
			options.push(["settings", "Room settings", () => this.show("settings")]);
		}
		if (room.role === "owner") {
			options.push(["cross", "Delete room", () => this.show("delete")]);
		} else {
			options.push(["leave", "Leave room", () => this.show("leave")]);
		}

		const unread = room.unread > 0;
		this.el.classList.toggle("sc-colored", !!room.color);
		if (room.color) this.el.style.setProperty("--sc-room", room.color);
		fill(
			this.header,
			h(
				"button",
				{
					type: "button",
					c: cx(
						"root___zZRe1 root___rnQAo header___cccSy",
						unread && "message___g25GS",
					),
					// Like Torn's faction chat: a click on the header (not its title menu) minimizes the panel.
					on: {
						click: () => {
							this.menuOpen = false;
							toggleRoom(this.id);
						},
					},
				},
				h(
					"div",
					{
						c: cx(
							"actionButton___CPUK5 enabled___Zme4G",
							this.menuOpen &&
								"actionButtonPressed___U2o81 actionButtonWithOpenOptions___Rntyl",
						),
						role: "button",
						tabindex: "0",
						on: {
							click: (event: Event) => {
								event.stopPropagation();
								this.menuOpen = !this.menuOpen;
								this.renderHeader(room);
							},
						},
					},
					roomIcon(room.icon, "icon___MBR1e"),
					text(
						"headingH1",
						"overflow___E0zcf title___ptIMK",
						{ title: room.name, style: "color: white;" },
						room.name,
					),
					icon("arrow", "icon___MBR1e arrowIcon___RgJFw"),
				),
				withClick(
					icon(
						"minimize",
						"icon___MBR1e minimizeIcon___Bk5cS",
						`Minimize ${room.name}`,
					),
					() => toggleRoom(this.id),
				),
				// Like a private chat's X: the room leaves the chat bar and comes back from the Rooms panel.
				withClick(
					icon(
						"closeChat",
						"icon___MBR1e closeIcon___s4Gjc",
						`Close ${room.name}`,
					),
					() => closeRoom(this.id),
				),
			),
			this.menuOpen
				? h(
						"div",
						{ c: "optionsContainer___CpJ5q" },
						options.map(([iconName, title, run]) =>
							h(
								"button",
								{
									type: "button",
									c: "root___Lrh0J",
									on: {
										click: (event: Event) => {
											event.stopPropagation();
											this.menuOpen = false;
											this.renderHeader(room);
											run();
										},
									},
								},
								icon(iconName, "icon___DbWGg"),
								text("subtitle", "title___oY9So", {}, title),
							),
						),
					)
				: null,
		);
	}

	// ---------------------------------------------------------------- messages

	/** Within about one message of the end counts as the bottom. */
	private atBottom(): boolean {
		return (
			this.scroller.scrollHeight -
				this.scroller.scrollTop -
				this.scroller.clientHeight <
			60
		);
	}

	private toBottom(): void {
		this.pinned = true;
		this.scroller.scrollTop = this.scroller.scrollHeight;
		this.setUnseen(0);
	}

	private setUnseen(count: number): void {
		this.unseen = count;
		this.pill?.remove();
		this.pill = null;
		if (!count) {
			this.atPill?.classList.remove("sc-at-up");
			return;
		}
		const close = h(
			"div",
			{ role: "presentation", c: "closeButton___zQTHG" },
			icon("closeChat", "closeIcon___UMWK4", "Dismiss new messages"),
		);
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			this.setUnseen(0);
		});
		this.pill = h(
			"button",
			{
				type: "button",
				c: "root___XpplE subtitle___u4sr8 root___dtYq3",
				style: "color: white;",
				on: { click: () => this.toBottom() },
			},
			arrowDown(),
			`${count} new message${count === 1 ? "" : "s"}`,
			close,
		);
		this.scroller.parentElement?.append(this.pill);
		this.atPill?.classList.toggle("sc-at-up", !!this.pill);
	}

	private async loadOlder(): Promise<void> {
		this.loading = true;
		const previousHeight = this.scroller.scrollHeight;
		try {
			await loadHistory(this.id, true);
			this.renderMessages();
			this.scroller.scrollTop += this.scroller.scrollHeight - previousHeight;
		} finally {
			this.loading = false;
		}
	}

	renderMessages(forceBottom = false): void {
		const stick = forceBottom || this.pinned || this.atBottom();
		const messages = state.messages.get(this.id) ?? [];
		this.closePicker();
		this.hideWho();
		this.setHovered(null);
		this.reactionRows.clear();
		this.mentionWatch.disconnect();
		this.mentionsInView.clear();
		const items: HTMLElement[] = [];
		messages.forEach((message, index) =>
			items.push(
				...this.rows(message, messages[index - 1], index < messages.length - 1),
			),
		);
		this.list.replaceChildren(...items);
		this.shown = messages[messages.length - 1] ?? null;
		this.shownRow = items[items.length - 1] ?? null;
		this.afterRender(stick);
	}

	/** A new newest message: one row added, like Torn's chat, instead of rebuilding the list. */
	private appendMessage(message: ChatMessageView, mine: boolean): void {
		const messages = state.messages.get(this.id) ?? [];
		const previous = messages[messages.length - 2];
		if (
			messages[messages.length - 1] !== message ||
			!previous ||
			previous !== this.shown ||
			!this.shownRow
		) {
			return this.renderMessages(mine);
		}
		const stick = mine || this.pinned || this.atBottom();
		const rows = this.rows(message, previous, false);
		this.shownRow.style.marginBottom = `${rowGap()}px`;
		this.list.append(...rows);
		this.shown = message;
		this.shownRow = rows[rows.length - 1] ?? null;
		this.afterRender(stick);
	}

	/** A message's rows: a time divider when a new group starts, then the message. As Torn: 5px between rows (6px without bubbles), 10px after the last one. */
	private rows(
		message: ChatMessageView,
		previous: ChatMessageView | undefined,
		hasNext: boolean,
		pending?: PendingMessage,
	): HTMLElement[] {
		const rows: HTMLElement[] = [];
		const newGroup =
			!previous ||
			message.ts - previous.ts > GAP_MS ||
			tctDay(previous.ts) !== tctDay(message.ts);
		if (newGroup) {
			rows.push(
				h(
					"div",
					{
						c: cx(
							"virtualItem___eIUjo",
							!state.chatStyle.bubbles && "classic___S4LnO",
						),
						style: `margin-bottom: ${rowGap()}px;`,
					},
					text(
						"divider2",
						"root___Pai0M messageGroupTimestamp___Aag0t",
						{},
						this.stamp(message.ts),
					),
				),
			);
		}
		const first = newGroup || previous.userId !== message.userId;
		rows.push(
			this.message(
				message,
				first,
				message.userId === state.me?.id,
				hasNext ? rowGap() : 10,
				pending,
			),
		);
		return rows;
	}

	private pendingKey = "";

	/** Our messages the server has not confirmed yet, after the confirmed ones. */
	private renderPending(): void {
		const pending = state.pending.filter((item) => item.roomId === this.id);
		const key = pending.map((item) => `${item.reqId}:${item.failed}`).join();
		if (key === this.pendingKey) return;
		this.pendingKey = key;
		const me = state.me;
		let previous = (state.messages.get(this.id) ?? []).at(-1);
		const rows: HTMLElement[] = [];
		pending.forEach((item, index) => {
			const view: ChatMessageView = {
				id: 0,
				roomId: item.roomId,
				userId: me?.id ?? 0,
				name: me?.name ?? "",
				avatar: null,
				factionTag: me?.factionTag ?? null,
				text: item.text,
				ts: item.ts,
				reactions: [],
				mentions: [],
				gif: item.gif,
			};
			rows.push(...this.rows(view, previous, index < pending.length - 1, item));
			previous = view;
		});
		const stick = this.pinned || this.atBottom();
		this.pendingList.replaceChildren(...rows);
		if (this.shownRow) {
			this.shownRow.style.marginBottom = `${pending.length ? rowGap() : 10}px`;
		}
		if (stick) this.toBottom();
	}

	private afterRender(stick: boolean): void {
		if (
			this.shownRow &&
			state.pending.some((item) => item.roomId === this.id)
		) {
			this.shownRow.style.marginBottom = `${rowGap()}px`;
		}
		this.renderFooter();
		if (stick) {
			this.toBottom();
			if (
				document.visibilityState === "visible" &&
				state.expanded.has(this.id)
			) {
				markRead(this.id);
			}
		}
	}

	private stamp(ts: number): string {
		const today = tctDay(Date.now());
		const day = tctDay(ts);
		return day === today ? tct(ts) : `${day} ${tct(ts)}`;
	}

	private message(
		message: ChatMessageView,
		first: boolean,
		self: boolean,
		gap: number,
		pending?: PendingMessage,
	): HTMLElement {
		const profile = `/profiles.php?XID=${message.userId}`;
		const canDelete =
			!pending && (self || (this.room?.role ?? "member") !== "member");
		// Torn's chat settings: without bubbles a message is a classic line ("Name: text", the same for
		// your own), without avatars it has no picture.
		const classic = !state.chatStyle.bubbles;
		const avatar = state.chatStyle.avatars
			? h(
					"a",
					{
						"data-label": "avatar",
						href: profile,
						c: `root___uxEGq redirect___lSgmf smallWrapper___QAAkH ${classic ? "avatar___b8bkC" : "avatar___DTfNY"}`,
					},
					avatarImg(message.avatar, "avatar___PYHqr smallAvatar___UPIO2"),
				)
			: null;
		const sender = text(
			"link2",
			`hrefLink___9O1GI ${classic ? "sender___wV_Ae" : "sender___WTwPl"} regular___hyk3H clickable___efRv1`,
			{ href: profile },
			`${senderName(this.room, message)}:`,
		);
		const body = h(
			"span",
			{
				c: `root___XpplE body___HxuJg ${classic ? "message___MITZq" : "message___AI7Nl"}`,
			},
			h(
				"span",
				{ c: "root___RoNAh" },
				...linkify(message.text, message.mentions, state.me?.id),
			),
		);
		const gif = message.gif ? this.gifNode(message.gif) : null;
		const bubble = h(
			"div",
			// Torn's pending style fades a message only when it is not confirmed within half a second.
			classic
				? { c: cx("root___yvwp3", pending && "pending___aZTtW") }
				: {
						c: cx(
							"root___EP_Dq",
							first && "first___icNlg",
							self && "self___HgXOK",
							pending && "pending___aZTtW",
						),
					},
			classic
				? h(
						"div",
						{ c: "box___cZJah" },
						h("span", {}, avatar, sender),
						body,
						gif,
					)
				: h(
						"div",
						{ c: "box___eWW6m" },
						h("span", { c: "senderContainer___aAlZ2" }, avatar, sender),
						body,
						gif,
					),
		);
		if (!pending) {
			// In the bubble's bottom right corner: after the text when the line has room, else on a line of their own.
			const reactions = h("div", { c: "sc-reactions" });
			this.reactionRows.set(message.id, reactions);
			this.fillReactions(reactions, message);
			bubble.append(reactions, this.tools(message, bubble, canDelete));
		}
		const row = h(
			"div",
			{
				c: cx("virtualItem___eIUjo", classic && "classic___S4LnO"),
				style: `margin-bottom: ${gap}px;`,
				"data-id": pending ? undefined : message.id,
			},
			bubble,
			pending?.failed
				? h(
						"div",
						{
							c: cx("root___dwjU1", !classic && "alignEnd___zwJTZ"),
						},
						text("body", "message___RIM_x", {}, "Not sent"),
						text(
							"link2",
							"action___fg5Sc",
							{
								on: {
									click: () =>
										void retry(pending).catch((error: unknown) =>
											this.flash(messageOf(error)),
										),
								},
							},
							retryIcon("icon___NEsJp"),
							"Retry",
						),
						text(
							"link2",
							"action___fg5Sc",
							{ on: { click: () => discard(pending) } },
							"Delete",
						),
					)
				: null,
		);
		if (!pending && tagsMe(message)) this.mentionWatch.observe(row);
		return row;
	}

	private gifNode(gif: ChatGif): HTMLElement {
		const image = h("img", {
			src: gif.url,
			alt: gif.title || "GIF",
			c: "sc-gif",
			loading: "lazy",
		});
		if (gif.width && gif.height) {
			image.style.aspectRatio = `${gif.width} / ${gif.height}`;
		}
		image.addEventListener("click", (event) => {
			event.stopPropagation();
			this.openGifViewer(gif);
		});
		return h("span", { c: "sc-gif-wrap" }, image);
	}

	private openGifViewer(gif: ChatGif): void {
		this.gifViewer?.remove();
		const close = () => {
			this.gifViewer?.remove();
			this.gifViewer = null;
		};
		this.gifViewer = h(
			"div",
			{
				c: "sc-gif-viewer",
				role: "dialog",
				"aria-label": gif.title || "GIF",
				on: {
					click: (event: Event) => {
						if (event.target === this.gifViewer) close();
					},
				},
			},
			h("img", { src: gif.url, alt: gif.title || "GIF" }),
			h(
				"button",
				{
					type: "button",
					c: "sc-gif-viewer-close",
					title: "Close",
					on: { click: close },
				},
				icon("cross"),
			),
		);
		this.el.append(this.gifViewer);
	}

	// ---------------------------------------------------------------- mentions

	/** Over the "new messages" pill when both show; its X counts the mentions as seen. */
	private renderAt(room: ChatRoomView): void {
		const count = room.joined ? (room.mentions ?? []).length : 0;
		if (count === this.atShown) return;
		this.atShown = count;
		this.atPill?.remove();
		this.atPill = null;
		if (!count) return;
		const close = h(
			"div",
			{ role: "presentation", c: "closeButton___zQTHG" },
			icon("closeChat", "closeIcon___UMWK4", "Dismiss mentions"),
		);
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			seeMentions(this.id, this.room?.mentions ?? []);
		});
		this.atPill = h(
			"button",
			{
				type: "button",
				c: cx(
					"root___XpplE subtitle___u4sr8 root___dtYq3 sc-at-pill",
					this.pill && "sc-at-up",
				),
				style: "color: white;",
				title: "Go to the message tagging you",
				on: { click: () => void this.jumpToMention() },
			},
			h("span", { c: "sc-at-sign" }, "@"),
			`${count > 99 ? "99+" : count} mention${count === 1 ? "" : "s"}`,
			close,
		);
		this.scroller.parentElement?.append(this.atPill);
	}

	/** Unseen mentions on screen, while the page is looked at, are seen. */
	private seeVisibleMentions(): void {
		if (!this.mentionsInView.size || document.visibilityState !== "visible") {
			return;
		}
		const ids = (this.room?.mentions ?? []).filter((id) =>
			this.mentionsInView.has(id),
		);
		if (ids.length) seeMentions(this.id, ids);
	}

	/** The @ button: to the oldest unseen message tagging you, loading older history until it is there. */
	private async jumpToMention(): Promise<void> {
		const target = this.room?.mentions?.[0];
		if (!target || this.jumping) return;
		this.jumping = this.loading = true;
		try {
			let loaded = false;
			for (let pages = 0; pages < MAX_JUMP_PAGES; pages++) {
				const list = state.messages.get(this.id);
				if (
					list &&
					(list.some((message) => message.id === target) ||
						!list.length ||
						(list[0]?.id ?? 0) < target ||
						!state.more.get(this.id))
				) {
					break;
				}
				await loadHistory(this.id, !!list);
				loaded = true;
			}
			if (loaded) this.renderMessages();
			const row = this.list.querySelector<HTMLElement>(`[data-id="${target}"]`);
			// Deleted, or too far back to load: nothing to go to.
			seeMentions(this.id, [target]);
			if (row) this.scrollToRow(row);
		} catch (error) {
			this.flash(messageOf(error));
		} finally {
			this.jumping = this.loading = false;
		}
	}

	/** Brings a message to the middle of the panel (smoothly for the last screen of the way) and makes it flash. */
	private scrollToRow(row: HTMLElement): void {
		const scroller = this.scroller;
		const top = () =>
			scroller.scrollTop +
			row.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top -
			Math.max(8, (scroller.clientHeight - row.offsetHeight) / 2);
		this.pinned = false;
		if (Math.abs(top() - scroller.scrollTop) > scroller.clientHeight) {
			scroller.scrollTop =
				top() +
				(top() < scroller.scrollTop
					? scroller.clientHeight
					: -scroller.clientHeight);
		}
		scroller.scrollTo({
			top: top(),
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
		const bubble = row.querySelector<HTMLElement>(
			".sc_root___EP_Dq, .sc_root___yvwp3",
		);
		if (!bubble) return;
		bubble.classList.remove("sc-flash");
		void bubble.offsetWidth; // restart the animation
		bubble.classList.add("sc-flash");
		bubble.addEventListener(
			"animationend",
			(event) => {
				if (event.target === bubble) bubble.classList.remove("sc-flash");
			},
			{ once: true },
		);
	}

	// ---------------------------------------------------------------- @name suggestions

	/** The `@name` being typed right before the caret. */
	private mentionAtCaret(): { start: number; query: string } | null {
		const textarea = this.textarea;
		if (textarea.selectionStart !== textarea.selectionEnd) return null;
		const before = textarea.value.slice(0, textarea.selectionStart);
		const match = /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_-]{0,32})$/.exec(before);
		return match
			? {
					start: before.length - (match[1]?.length ?? 0) - 1,
					query: match[1] ?? "",
				}
			: null;
	}

	private updateSuggest(): void {
		const at = this.room?.canPost ? this.mentionAtCaret() : null;
		if (!at) {
			this.closeSuggest();
			return;
		}
		this.loadMembers();
		const items = this.candidates(at.query);
		if (!items.length) {
			this.closeSuggest();
			return;
		}
		// The highlight stays on its name while the list only refreshes (members arriving); a new query starts at the best match.
		const previous =
			this.suggest?.query === at.query
				? this.suggest.items[this.suggest.active]?.id
				: undefined;
		const element =
			this.suggest?.el ??
			h("div", {
				c: "sc-suggest",
				role: "listbox",
				on: { pointerdown: (event: Event) => event.preventDefault() },
			});
		this.suggest = {
			el: element,
			start: at.start,
			query: at.query,
			items,
			active: Math.max(
				0,
				items.findIndex((user) => user.id === previous),
			),
		};
		this.paintSuggest();
		if (!element.isConnected) this.scroller.parentElement?.append(element);
	}

	private paintSuggest(): void {
		const suggest = this.suggest;
		if (!suggest) return;
		fill(
			suggest.el,
			suggest.items.map((user, index) =>
				h(
					"div",
					{
						c: cx(
							"sc-suggest-item",
							index === suggest.active && "sc-suggest-on",
						),
						role: "option",
						"aria-selected": String(index === suggest.active),
						on: {
							click: () => this.pick(user),
							pointermove: () => {
								if (suggest.active === index) return;
								suggest.active = index;
								this.paintSuggest();
							},
						},
					},
					h(
						"span",
						{ c: "sc-suggest-name" },
						...matched(user.name, suggest.query),
					),
					h("span", { c: "sc-suggest-id" }, `[${user.id}]`),
				),
			),
		);
	}

	/** Arrows move through the names, Enter or Tab picks one, Escape closes the list. */
	private suggestKey(event: KeyboardEvent): boolean {
		const suggest = this.suggest;
		if (!suggest) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			suggest.active =
				(suggest.active +
					(event.key === "ArrowDown" ? 1 : -1) +
					suggest.items.length) %
				suggest.items.length;
			this.paintSuggest();
		} else if (
			(event.key === "Enter" && !event.shiftKey) ||
			event.key === "Tab"
		) {
			const item = suggest.items[suggest.active];
			if (item) this.pick(item);
		} else if (event.key === "Escape") {
			this.closeSuggest();
		} else {
			return false;
		}
		event.preventDefault();
		return true;
	}

	/** Replaces the `@name` being typed with the picked player's name and a space. */
	private pick(user: Candidate): void {
		const suggest = this.suggest;
		if (!suggest) return;
		const textarea = this.textarea;
		const spaced = /^\s/.test(textarea.value.slice(textarea.selectionStart));
		textarea.setRangeText(
			`@${user.name}${spaced ? "" : " "}`,
			suggest.start,
			textarea.selectionStart,
			"end",
		);
		if (spaced) {
			textarea.setSelectionRange(
				textarea.selectionStart + 1,
				textarea.selectionStart + 1,
			);
		}
		this.closeSuggest();
		this.syncSend();
	}

	private closeSuggest(): void {
		this.suggest?.el.remove();
		this.suggest = null;
	}

	/** The room's members (asked again after a minute), refreshing the open list when they arrive. */
	private loadMembers(): void {
		if (
			this.membersLoading ||
			(this.members && Date.now() - this.members.at < 60_000)
		) {
			return;
		}
		this.membersLoading = true;
		api<ChatAccessView>("GET", `/v2/chat/rooms/${this.id}/access`)
			.then(
				(access) =>
					(this.members = {
						at: Date.now(),
						list: access.members.map((member) => ({
							id: member.id,
							name: member.name,
						})),
					}),
				() =>
					(this.members = {
						at: Date.now(),
						list: this.members?.list ?? [],
					}),
			)
			.finally(() => {
				this.membersLoading = false;
				if (this.suggest) this.updateSuggest();
			});
	}

	/** Members matching what follows the @, not you: names starting with it first, then who spoke last, then A to Z. */
	private candidates(query: string): Candidate[] {
		const messages = state.messages.get(this.id) ?? [];
		const spoke = new Map<number, number>();
		messages.forEach((message, index) => spoke.set(message.userId, index));
		// Until the member list arrives, the people in the loaded messages.
		const people = new Map<number, string>(
			(
				this.members?.list ??
				messages.map((message) => ({
					id: message.userId,
					name: message.name,
				}))
			).map((user) => [user.id, user.name]),
		);
		people.delete(state.me?.id ?? 0);
		const lower = query.toLowerCase();
		return [...people]
			.map(([id, name]) => ({ id, name, lower: name.toLowerCase() }))
			.filter((user) => user.lower.includes(lower))
			.sort(
				(a, b) =>
					Number(b.lower.startsWith(lower)) -
						Number(a.lower.startsWith(lower)) ||
					(spoke.get(b.id) ?? -1) - (spoke.get(a.id) ?? -1) ||
					a.lower.localeCompare(b.lower),
			)
			.slice(0, SUGGEST_MAX)
			.map(({ id, name }) => ({ id, name }));
	}

	/**
	 * What hovering a message shows: its time, the reaction bubble, and Delete when allowed. Beside the
	 * message when there is room, else over its top corner; a tap shows it on touch screens.
	 */
	private tools(
		message: ChatMessageView,
		bubble: HTMLElement,
		canDelete: boolean,
	): HTMLElement {
		const reactBtn = this.room?.joined
			? h(
					"button",
					{
						type: "button",
						c: "sc-tools-react",
						title: "React",
						"aria-label": "React",
					},
					smileyIcon(),
				)
			: null;
		reactBtn?.addEventListener("click", (event) => {
			event.stopPropagation();
			if (this.picker?.id === message.id) this.closePicker();
			else if (reactBtn) this.openPicker(message, bubble, reactBtn);
		});
		const tools = h(
			"div",
			{ c: "sc-tools" },
			h("span", { c: "sc-tools-time" }, this.stamp(message.ts)),
			reactBtn,
			canDelete
				? withClick(icon("closeChat", "sc-tools-del", "Delete message"), () => {
						if (confirm("Delete this message for everyone?")) {
							api(
								"DELETE",
								`/v2/chat/rooms/${this.id}/messages/${message.id}`,
							).catch((error: unknown) => this.flash(messageOf(error)));
						}
					})
				: null,
		);
		bubble.tabIndex = -1;
		const place = () => {
			const rect = bubble.getBoundingClientRect();
			const scrollerRect = this.scroller.getBoundingClientRect();
			const free = bubble.classList.contains("sc_self___HgXOK")
				? rect.left - scrollerRect.left
				: scrollerRect.left + this.scroller.clientWidth - rect.right;
			bubble.classList.toggle("sc-tools-over", free < tools.offsetWidth + 8);
		};
		bubble.addEventListener("focusin", place);
		this.toolsOf.set(bubble, { tools, place });
		return tools;
	}

	/**
	 * Hover with a safe triangle, as in menus: after the pointer leaves the hovered message, it keeps
	 * its tools while it moves inside the triangle from where it left to the tools, or keeps getting
	 * closer to them on a curved path (for AIM_MS at most), so crossing a gap or a neighbouring message
	 * on the way does not hide them. Moving away from them hands the hover over at once.
	 */
	private trackHover(event: PointerEvent): void {
		if (event.pointerType === "touch") return;
		const bubble = this.bubbleAt(event.target as Element | null);
		if (bubble === this.hovered) {
			this.exit = null;
			clearTimeout(this.hoverTimer);
			return;
		}
		const tools = this.hovered && this.toolsOf.get(this.hovered)?.tools;
		if (tools) {
			const now = performance.now();
			const rect = tools.getBoundingClientRect();
			const distance = Math.hypot(
				Math.max(rect.left - event.clientX, 0, event.clientX - rect.right),
				Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom),
			);
			const exit = (this.exit ??= {
				x: event.clientX,
				y: event.clientY,
				at: now,
				dist: distance,
			});
			const closer = distance <= exit.dist + 1;
			exit.dist = Math.min(exit.dist, distance);
			if (
				now - exit.at < AIM_MS &&
				(closer || towards(exit, rect, event.clientX, event.clientY))
			) {
				// Still on the way; if the pointer stops short of the tools, the message under it takes over.
				const { clientX: x, clientY: y } = event;
				clearTimeout(this.hoverTimer);
				this.hoverTimer = setTimeout(
					() => this.setHovered(this.bubbleAt(document.elementFromPoint(x, y))),
					AIM_MS,
				);
				return;
			}
		}
		this.setHovered(bubble);
	}

	/** The message whose row is under the pointer: its whole width counts, so the tools beside a message are inside its hover. */
	private bubbleAt(element: Element | null): HTMLElement | null {
		const item = element?.closest(".sc_virtualItem___eIUjo");
		const bubble =
			item?.querySelector<HTMLElement>(
				":scope > .sc_root___EP_Dq, :scope > .sc_root___yvwp3",
			) ?? null;
		return bubble && this.toolsOf.has(bubble) && this.list.contains(bubble)
			? bubble
			: null;
	}

	private setHovered(bubble: HTMLElement | null): void {
		clearTimeout(this.hoverTimer);
		this.exit = null;
		if (bubble === this.hovered) return;
		this.hovered?.classList.remove("sc-hover");
		this.hovered = bubble;
		if (!bubble) return;
		bubble.classList.add("sc-hover");
		this.toolsOf.get(bubble)?.place();
	}

	private openPicker(
		message: ChatMessageView,
		bubble: HTMLElement,
		anchor: HTMLElement,
	): void {
		this.closePicker();
		const mine = new Set(
			(message.reactions ?? [])
				.filter((reaction) =>
					reaction.users.some((user) => user.id === state.me?.id),
				)
				.map((reaction) => reaction.emoji),
		);
		const picker = h(
			"div",
			{ c: "sc-picker", role: "menu" },
			CHAT_REACTIONS.map((emoji) =>
				h(
					"button",
					{
						type: "button",
						role: "menuitem",
						c: cx("sc-pick", mine.has(emoji) && "sc-pick-on"),
						on: {
							click: (event: Event) => {
								event.stopPropagation();
								this.closePicker();
								void react(this.id, message.id, emoji).catch((error: unknown) =>
									this.flash(messageOf(error)),
								);
							},
						},
					},
					emoji,
				),
			),
		);
		this.el.append(picker);
		bubble.classList.add("sc-picking");
		// Above the bubble button, or below it when the header is in the way; inside the panel.
		const anchorRect = anchor.getBoundingClientRect();
		const panelRect = this.el.getBoundingClientRect();
		const top = this.header.getBoundingClientRect().bottom;
		const left = Math.min(
			Math.max(
				4,
				anchorRect.left +
					anchorRect.width / 2 -
					picker.offsetWidth / 2 -
					panelRect.left,
			),
			panelRect.width - picker.offsetWidth - 4,
		);
		picker.style.left = `${left}px`;
		picker.style.top = `${
			anchorRect.top - picker.offsetHeight - 4 >= top
				? anchorRect.top - panelRect.top - picker.offsetHeight - 4
				: anchorRect.bottom - panelRect.top + 4
		}px`;
		const outside = (event: Event) => {
			if (
				!picker.contains(event.target as Node) &&
				!anchor.contains(event.target as Node)
			) {
				this.closePicker();
			}
		};
		const escape = (event: KeyboardEvent) =>
			event.key === "Escape" && this.closePicker();
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape, true);
		this.picker = {
			id: message.id,
			close: () => {
				document.removeEventListener("pointerdown", outside, true);
				document.removeEventListener("keydown", escape, true);
				bubble.classList.remove("sc-picking");
				picker.remove();
			},
		};
	}

	private closePicker(): void {
		this.picker?.close();
		this.picker = null;
	}

	/**
	 * A message's reactions: emoji and count, highlighted when one is ours; a click adds or takes
	 * back ours. On a change (`animate`), an emoji that just got a reaction plays its animation.
	 */
	private fillReactions(
		row: HTMLElement,
		message: ChatMessageView,
		animate = false,
	): void {
		const joined = !!this.room?.joined;
		// The server confirming what is already shown changes nothing, and must not restart an animation.
		const key = JSON.stringify([
			joined,
			state.me?.id,
			(message.reactions ?? []).map((reaction) => [
				reaction.emoji,
				reaction.users.map((user) => user.id),
			]),
		]);
		if (row.dataset.key === key) return;
		row.dataset.key = key;
		const before = new Map(
			[...row.children].map((child) => [
				(child as HTMLElement).dataset.emoji,
				Number((child as HTMLElement).dataset.count),
			]),
		);
		fill(
			row,
			(message.reactions ?? []).map((reaction) =>
				h(
					"button",
					{
						type: "button",
						c: cx(
							"sc-chip",
							reaction.users.some((user) => user.id === state.me?.id) &&
								"sc-chip-on",
							animate &&
								reaction.users.length > (before.get(reaction.emoji) ?? 0) &&
								"sc-chip-pop",
						),
						"data-emoji": reaction.emoji,
						"data-count": reaction.users.length,
						"aria-label": `${reactedBy(reaction)} reacted with ${reaction.emoji}`,
						disabled: !joined,
						on: {
							click: () =>
								void react(this.id, message.id, reaction.emoji).catch(
									(error: unknown) => this.flash(messageOf(error)),
								),
							pointerenter: (event: Event) => {
								const pointer = event as PointerEvent;
								const shown =
									pointer.pointerType !== "touch" &&
									state.messages
										.get(this.id)
										?.find((item) => item.id === message.id);
								if (shown) {
									this.showWho(
										shown,
										reaction.emoji,
										event.currentTarget as HTMLElement,
									);
								}
							},
							pointerleave: () => {
								if (
									this.who?.id === message.id &&
									this.who.emoji === reaction.emoji
								) {
									this.hideWho();
								}
							},
						},
					},
					h(
						"span",
						{
							c: "sc-chip-emoji",
							"data-anim": REACTION_ANIMATIONS[reaction.emoji] ?? "pop",
						},
						reaction.emoji,
					),
					h("span", { c: "sc-chip-count" }, reaction.users.length),
				),
			),
		);
	}

	/** Who reacted with one emoji, above its reaction (below it when the header is in the way). */
	private showWho(
		message: ChatMessageView,
		emoji: string,
		chip: HTMLElement,
	): void {
		const reaction = message.reactions?.find((item) => item.emoji === emoji);
		if (!reaction) {
			this.hideWho();
			return;
		}
		const element = this.who?.el ?? h("div", { c: "sc-who", role: "tooltip" });
		// Each name on its line, you first; a long list ends in "and N more".
		const names = reaction.users
			.map((user) => (user.id === state.me?.id ? "You" : user.name))
			.sort((a, b) => (a === "You" ? -1 : b === "You" ? 1 : 0));
		fill(
			element,
			h(
				"div",
				{ c: "sc-who-head" },
				h("span", { c: "sc-who-emoji" }, emoji),
				`${names.length}`,
			),
			names.slice(0, WHO_MAX).map((name) => h("div", {}, name)),
			names.length > WHO_MAX
				? h("div", { c: "sc-who-more" }, `and ${names.length - WHO_MAX} more`)
				: null,
		);
		if (!element.isConnected) this.el.append(element);
		this.who = { id: message.id, emoji, el: element };
		const rect = chip.getBoundingClientRect();
		const panelRect = this.el.getBoundingClientRect();
		const top = this.header.getBoundingClientRect().bottom;
		element.style.left = `${Math.min(
			Math.max(
				4,
				rect.left + rect.width / 2 - panelRect.left - element.offsetWidth / 2,
			),
			panelRect.width - element.offsetWidth - 4,
		)}px`;
		element.style.top = `${
			rect.top - element.offsetHeight - 4 >= top
				? rect.top - panelRect.top - element.offsetHeight - 4
				: rect.bottom - panelRect.top + 4
		}px`;
	}

	private hideWho(): void {
		this.who?.el.remove();
		this.who = null;
	}

	private footerText = "";

	private renderFooter(): void {
		const last = this.room?.lastMessage;
		const age = last ? Date.now() - last.ts : 0;
		// As Torn: who is typing; else "Last message" once the last message is a minute old, refreshed on each full minute since it was sent.
		const typing = typingLabel(
			(state.typing.get(this.id) ?? []).map((user) => user.name),
		);
		const line =
			typing || (last && age >= 60_000 ? `Last message: ${ago(last.ts)}` : "");
		// Only when the line changes, so the typing dots keep flashing through other updates.
		if (line !== this.footerText) {
			this.footerText = line;
			this.footer.replaceChildren(
				typing
					? h(
							"div",
							{
								c: "root___XpplE divider2___nG653 root___koA3y typingIndicator___Lo_wW visible___geRbO",
							},
							h("div", { c: "root___gGAMB" }),
							typing,
						)
					: line
						? text(
								"divider2",
								"root___Pai0M lastMessageTimeInfo___XV7Vj",
								{},
								line,
							)
						: "",
			);
		}
		clearTimeout(this.footerTimer);
		if (last) {
			this.footerTimer = setTimeout(
				() => this.renderFooter(),
				60_000 - (Math.max(0, age) % 60_000) + 50,
			);
		}
	}

	// ---------------------------------------------------------------- composer

	private typingSent = 0;

	/** While there is text: a typing ping at most every few seconds. */
	private pingTyping(): void {
		const now = Date.now();
		if (
			!this.textarea.value.trim() ||
			now - this.typingSent < CHAT_LIMITS.typingPingMs
		) {
			return;
		}
		this.typingSent = now;
		api("POST", `/v2/chat/rooms/${this.id}/typing`).catch(() => {});
	}

	private syncSend(): void {
		this.sendBtn.disabled = !this.textarea.value.trim() && !this.gif;
	}

	private composerKey = "";

	/** Swaps the composer for a notice only when the reason changes, so typing keeps focus. */
	private renderComposer(room: ChatRoomView): void {
		const key = !room.joined
			? "invite"
			: state.conn !== "live"
				? state.conn
				: !room.canPost
					? "readonly"
					: "compose";
		if (key !== this.composerKey) {
			this.composerKey = key;
			this.composerSlot.replaceChildren(
				key === "invite"
					? warning(
							"Accept the invitation to chat in this room",
							" ",
							tornBtn("Accept", () => {
								join(this.id)
									.then(() => loadHistory(this.id))
									.then(() => this.renderMessages(true))
									.catch((error: unknown) => this.flash(messageOf(error)));
							}),
						)
					: key === "offline"
						? warning("Disconnected")
						: key === "connecting"
							? info("Connecting")
							: key === "readonly"
								? warning("Only admins can write in this room")
								: this.composerWrap,
			);
		}
		this.syncSend();
	}

	private renderGifBar(): void {
		if (!this.gif) {
			this.gifBar.replaceChildren();
			this.gifBar.style.display = "none";
			return;
		}
		this.gifBar.style.display = "flex";
		fill(
			this.gifBar,
			h("img", {
				src: this.gif.url,
				alt: this.gif.title || "GIF",
				c: "sc-gif-preview",
			}),
			text("body", "sc-gif-preview-title", {}, this.gif.title || "GIF ready"),
			h(
				"button",
				{
					type: "button",
					c: "sc-gif-remove",
					title: "Remove GIF",
					on: {
						click: () => {
							this.gif = null;
							this.renderGifBar();
							this.syncSend();
						},
					},
				},
				icon("cross"),
			),
		);
	}

	private toggleGifPicker(): void {
		if (this.gifPicker) {
			this.gifPicker.close();
			return;
		}
		this.gifPicker = openGifPicker({
			ignore: this.gifBtn,
			onPick: (gif) => {
				this.gif = gif;
				this.gifPicker = null;
				this.renderGifBar();
				this.syncSend();
				this.textarea.focus();
			},
			onClose: () => {
				this.gifPicker = null;
			},
		});
		this.el.append(this.gifPicker.el);
	}

	private async submit(): Promise<void> {
		const value = this.textarea.value.trim();
		const typedGif = !this.gif ? gifFromTypedText(value) : null;
		const gif = this.gif ?? typedGif;
		if (!value && !gif) return;
		this.closeSuggest();
		this.closePicker();
		this.gifPicker?.close();
		this.textarea.value = "";
		this.gif = null;
		this.typingSent = 0;
		this.renderGifBar();
		this.syncSend();
		// Shown at once; a refusal leaves it as "Not sent" with Retry, as in Torn's chat.
		this.toBottom();
		await send(this.id, typedGif ? "" : value, gif).catch((error: unknown) =>
			this.flash(messageOf(error)),
		);
	}

	private flashes = new Map<
		string,
		{ strip: HTMLElement; timer: ReturnType<typeof setTimeout> }
	>();

	/** A warning above the composer for a few seconds; the same one again only restarts its time. */
	private flash(message: string): void {
		const shown = this.flashes.get(message);
		if (shown) clearTimeout(shown.timer);
		const strip = shown?.strip ?? warning(message);
		if (!shown) this.composerSlot.prepend(strip);
		const timer = setTimeout(() => {
			strip.remove();
			this.flashes.delete(message);
		}, 4000);
		this.flashes.set(message, { strip, timer });
	}

	// ---------------------------------------------------------------- sub-views

	private show(view: View): void {
		this.view = view;
		this.overlay?.remove();
		this.overlay = null;
		if (view === "chat") return;
		const back = () => this.show("chat");
		const room = this.room;
		if (!room) return;
		let node: HTMLElement;
		if (view === "settings") {
			node = roomForm({
				backTitle: "Back to chat",
				submitTitle: "Save",
				initial: {
					name: room.name,
					description: room.description,
					icon: room.icon,
					color: room.color,
					visibility: room.visibility,
					postPolicy: room.postPolicy,
					showFactionTags: room.showFactionTags,
				},
				onBack: back,
				onSubmit: async (values) => {
					await api("PATCH", `/v2/chat/rooms/${this.id}`, values);
					await refreshRooms();
					back();
				},
			});
		} else if (view === "invite") {
			node = this.inviteView(back);
		} else if (view === "members") {
			node = this.membersView(back);
		} else {
			const deleting = view === "delete";
			node = backView("Back to chat", back, "root___bdV8w", [
				text(
					"body",
					"message___V2QQb",
					{},
					deleting
						? `Delete ${room.name}? Every message in it is removed for everyone.`
						: `Leave ${room.name}? You can come back if you are invited again.`,
				),
				h(
					"div",
					{ c: "row___gsxrG", style: "justify-content: center;" },
					tornBtn(deleting ? "Delete room" : "Leave room", () => {
						(deleting ? deleteRoom(this.id) : leave(this.id)).catch(
							(error: unknown) => this.flash(messageOf(error)),
						);
					}),
				),
			]);
		}
		this.overlay = node;
		this.content.append(node);
	}

	private inviteView(back: () => void): HTMLElement {
		const status = text("body", "message___V2QQb", {}, "");
		const row = (
			placeholder: string,
			label: string,
			kind: "player" | "faction",
		) => {
			const input = textInput({
				placeholder,
				cls: "input___hkebW",
				onEnter: () => void go(),
			});
			const go = async () => {
				const id = parseTornId(input.input.value);
				if (!id) {
					status.textContent = `That is not a ${kind} ID or link.`;
					return;
				}
				status.textContent = "Inviting…";
				try {
					await api("POST", `/v2/chat/rooms/${this.id}/grants`, {
						kind,
						id,
					});
					input.input.value = "";
					status.textContent = `${
						kind === "player" ? "Player" : "Faction"
					} #${id} is invited.`;
				} catch (error) {
					status.textContent = messageOf(error);
				}
			};
			return h("div", { c: "row___gsxrG" }, input.root, tornBtn(label, go));
		};
		return backView("Back to chat", back, "root___bdV8w", [
			text(
				"body",
				"message___V2QQb",
				{},
				"Invite a player, or a whole faction: everyone in it gets the room, and loses it on leaving the faction. IDs or profile links work.",
			),
			row("Player ID", "Invite", "player"),
			row("Faction ID", "Invite", "faction"),
			status,
		]);
	}

	private membersView(back: () => void): HTMLElement {
		const body = h(
			"div",
			{ c: "sc-scroll", style: "flex: 1;" },
			info("Loading"),
		);
		const room = this.room;
		if (!room) return backView("Back to chat", back, "", [body]);
		const manage = room.role !== "member";
		const draw = async () => {
			try {
				const access = await api<ChatAccessView>(
					"GET",
					`/v2/chat/rooms/${this.id}/access`,
				);
				const act = (label: string, run: () => Promise<unknown>) =>
					text(
						"link1",
						"hrefLink___9O1GI sc-act",
						{
							href: "#",
							on: {
								click: (event: Event) => {
									event.preventDefault();
									run().then(draw, (error: unknown) => alert(messageOf(error)));
								},
							},
						},
						label,
					);
				const line = (...children: Child[]) =>
					h("div", { c: "sc-line" }, ...children);
				const profile = (id: number, name: string) =>
					text(
						"link1",
						"hrefLink___9O1GI",
						{ href: `/profiles.php?XID=${id}` },
						`${name} [${id}]`,
					);
				// A personal invite stays as the joined player's access, but is no longer pending: it moves to their member row.
				const joined = new Set(access.members.map((member) => member.id));
				const personal = new Set(
					access.grants
						.filter((grant) => grant.kind === "player")
						.map((grant) => grant.id),
				);
				const pending = access.grants.filter(
					(grant) => grant.kind !== "player" || !joined.has(grant.id),
				);
				const removeGrant = (kind: string, id: number) =>
					act("Remove", () =>
						api("DELETE", `/v2/chat/rooms/${this.id}/grants/${kind}/${id}`),
					);
				fill(
					body,
					setting(`Members (${access.members.length})`, [
						...access.members.map((member) =>
							line(
								profile(member.id, member.name),
								member.role !== "member"
									? text("body", "sc-role", {}, member.role)
									: null,
								room.role === "owner" && member.role !== "owner"
									? act(member.role === "admin" ? "Demote" : "Make admin", () =>
											api(
												member.role === "admin" ? "DELETE" : "POST",
												`/v2/chat/rooms/${this.id}/admins/${member.id}`,
											),
										)
									: null,
								manage && member.role === "member" && personal.has(member.id)
									? removeGrant("player", member.id)
									: null,
								manage && member.role === "member"
									? act("Ban", () =>
											api(
												"POST",
												`/v2/chat/rooms/${this.id}/bans/${member.id}`,
												{ label: member.name },
											),
										)
									: null,
							),
						),
					]),
					setting("Invited", [
						...(pending.length
							? []
							: [
									text(
										"body",
										"",
										{},
										room.visibility === "public"
											? "Public room: anyone can join."
											: "Nobody yet.",
									),
								]),
						...pending.map((grant) =>
							line(
								grant.kind === "faction"
									? text(
											"link1",
											"hrefLink___9O1GI",
											{ href: `/factions.php?step=profile&ID=${grant.id}` },
											`${grant.label} [${grant.id}]`,
										)
									: profile(grant.id, grant.label),
								text("body", "sc-role", {}, grant.kind),
								manage ? removeGrant(grant.kind, grant.id) : null,
							),
						),
					]),
					manage && access.bans.length
						? setting(
								"Banned",
								access.bans.map((ban) =>
									line(
										profile(ban.id, ban.label),
										act("Unban", () =>
											api("DELETE", `/v2/chat/rooms/${this.id}/bans/${ban.id}`),
										),
									),
								),
							)
						: null,
				);
			} catch (error) {
				body.replaceChildren(warning(messageOf(error)));
			}
		};
		void draw();
		return backView("Back to chat", back, "", [body]);
	}
}

interface Candidate {
	id: number;
	name: string;
}

/** Names the @ list offers at once. */
const SUGGEST_MAX = 6;

/** History pages the @ button loads at most to reach a mention (50 messages each). */
const MAX_JUMP_PAGES = 40;

/** A name with the part matching the typed query in bold. */
function matched(name: string, query: string): Child[] {
	const index = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
	if (index < 0) return [name];
	return [
		name.slice(0, index),
		h("b", {}, name.slice(index, index + query.length)),
		name.slice(index + query.length),
	];
}

/** Names listed when hovering a reaction before "and N more". */
const WHO_MAX = 12;

/** Which animation each reaction plays when it goes in (keyframes in extra.css). */
const REACTION_ANIMATIONS: Record<string, string> = {
	"👍": "thumb",
	"❤️": "heart",
	"😂": "laugh",
	"😮": "wow",
	"😢": "sad",
	"🔥": "fire",
};

/** How long the pointer may take from a message to its tools. */
const AIM_MS = 500;

/** Is (x, y) inside the area between the point the pointer left from and the tools (their convex hull)? The tools count 10px larger, for curved paths. */
function towards(
	from: { x: number; y: number },
	tools: DOMRect,
	x: number,
	y: number,
): boolean {
	const rect = {
		left: tools.left - 10,
		top: tools.top - 10,
		right: tools.right + 10,
		bottom: tools.bottom + 10,
	};
	if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
		return true;
	}
	const corners: [number, number][] = [
		[rect.left, rect.top],
		[rect.right, rect.top],
		[rect.right, rect.bottom],
		[rect.left, rect.bottom],
	];
	return corners.some((corner, index) =>
		inTriangle(
			x,
			y,
			from.x,
			from.y,
			corner,
			corners[(index + 1) % 4] ?? corner,
		),
	);
}

function inTriangle(
	x: number,
	y: number,
	px: number,
	py: number,
	[ax, ay]: [number, number],
	[bx, by]: [number, number],
): boolean {
	const side = (x1: number, y1: number, x2: number, y2: number) =>
		(x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
	const d1 = side(px, py, ax, ay);
	const d2 = side(ax, ay, bx, by);
	const d3 = side(bx, by, px, py);
	return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** "You, Ghost and Foxy", at most eight names, then "and N more". */
function reactedBy(reaction: ChatReactionView): string {
	const names = reaction.users
		.map((user) => (user.id === state.me?.id ? "You" : user.name))
		.sort((a, b) => (a === "You" ? -1 : b === "You" ? 1 : 0));
	const shown =
		names.length > 8
			? [...names.slice(0, 8), `${names.length - 8} more`]
			: names;
	return shown.length > 1
		? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
		: (shown[0] ?? "");
}

/** The reaction bubble's icon: a smiling face. */
function smileyIcon(): SVGSVGElement {
	const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	el.setAttribute("viewBox", "0 0 16 16");
	el.setAttribute("width", "14");
	el.setAttribute("height", "14");
	// constant markup, never user content
	el.innerHTML =
		'<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.7" cy="6.4" r="1" fill="currentColor"/><circle cx="10.3" cy="6.4" r="1" fill="currentColor"/><path d="M4.9 9.4a3.4 3.4 0 0 0 6.2 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
	return el;
}

/** Torn's space between message rows: 6px in its classic (no bubbles) style, else 5px. */
const rowGap = () => (state.chatStyle.bubbles ? 5 : 6);

/** Torn's typing indicator text. */
function typingLabel(names: string[]): string {
	if (names.length === 0) return "";
	if (names.length === 1) return `${names[0]} is typing...`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
	return "Several people are typing...";
}

/** Torn's avatar rule: the player's picture, or Torn's default when missing or broken. */
function avatarImg(src: string | null, cls: string): HTMLImageElement {
	const image = h("img", { alt: "avatar", c: cls, src: src || DEFAULT_AVATAR });
	image.addEventListener(
		"error",
		() => {
			if (image.src !== DEFAULT_AVATAR) image.src = DEFAULT_AVATAR;
		},
		{ once: true },
	);
	return image;
}

function withClick<T extends Element>(el: T, run: () => void): T {
	el.addEventListener("click", (event) => {
		event.stopPropagation();
		run();
	});
	return el;
}

/** Torn's "new messages" arrow (Font Awesome arrow-down, white). */
function arrowDown(): SVGSVGElement {
	const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	el.setAttribute("viewBox", "0 0 384 512");
	el.setAttribute("height", "14");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute(
		"d",
		"M169.4 470.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 370.8 224 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 306.7L54.6 265.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z",
	);
	path.setAttribute("fill", "white");
	el.append(path);
	return el;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
