// The "Rooms" panel: Torn's People panel layout with rooms instead of private chats.
import { api } from "../api";
import {
	ago,
	atBadge,
	badge,
	componentIcon,
	cx,
	h,
	icon,
	roomIcon,
	text,
} from "../dom";
import type { IconName } from "../generated/icons";
import {
	CHAT_LIMITS,
	type ChatBrowseRoom,
	type ChatRoomView,
} from "../protocol";
import {
	applyMe,
	type DirectoryTab,
	invites,
	join,
	joinedRooms,
	openRoom,
	refreshRooms,
	senderName,
	setDirectoryTab,
	setOwnAvatar,
	state,
	toggleDirectory,
} from "../store";
import {
	actionButton,
	checkbox,
	setting,
	textInput,
	tornBtn,
	warning,
} from "./forms";
import { roomForm } from "./roomForm";

export class Directory {
	readonly el = h("div", {
		c: "root___Ex8tg root___hrPnu visible___IVBmB root___jByi5 sc-panel",
		id: "sc_rooms_panel",
	});
	private search = "";
	private creating = false;
	private browse: ChatBrowseRoom[] | null = null;
	private browseQuery = "";
	constructor(private onOpenSettings: () => void) {}

	private header = h(
		"button",
		{
			type: "button",
			c: "root___zZRe1 root___tQsxi",
			on: { click: () => toggleDirectory(false) },
		},
		h(
			"div",
			{ c: "textContainer___yU28H" },
			icon("chats"),
			text("headingH1", "", { style: "color: white;" }, "Rooms"),
		),
		withClick(icon("minimize", "minimizeIcon___Qr0SL", "Minimize Rooms"), () =>
			toggleDirectory(false),
		),
	);
	private tabSlot = h("div", { style: "display: contents;" });
	private body = h("div", { c: "content___SMWAe" });
	private listSlot = h("div", { style: "display: contents;" });
	private errorSlot = h("div", {});
	private mode = "";

	/** Re-renders tabs and lists on every change; inputs and forms are rebuilt only when the view changes. */
	render(): void {
		if (!this.el.firstChild)
			this.el.append(this.header, this.tabSlot, this.body);
		this.errorSlot.replaceChildren(state.error ? warning(state.error) : "");
		if (!state.me) {
			if (this.mode !== "connect") {
				this.mode = "connect";
				this.tabSlot.replaceChildren();
				this.body.replaceChildren(
					h("div", { c: "sc-scroll" }, this.connectView()),
					this.errorSlot,
				);
			}
			return;
		}
		const mode = this.creating ? "create" : state.directoryTab;
		this.tabSlot.replaceChildren(this.tabBar());
		if (mode !== this.mode) {
			this.mode = mode;
			if (mode === "create") {
				this.body.replaceChildren(
					roomForm({
						backTitle: "Back to rooms",
						submitTitle: "Create new chat room",
						onBack: () => {
							this.creating = false;
							this.render();
						},
						onSubmit: async (values) => {
							const { room } = await api<{ room: ChatRoomView }>(
								"POST",
								"/v2/chat/rooms",
								values,
							);
							this.creating = false;
							await refreshRooms();
							openRoom(room.id);
						},
					}),
				);
			} else if (mode === "browse") {
				this.body.replaceChildren(
					this.searchBox(
						"Search public rooms",
						(query) => void this.loadBrowse(query),
					),
					this.listSlot,
					this.errorSlot,
				);
			} else if (mode === "settings") {
				this.body.replaceChildren(
					h("div", { c: "sc-scroll" }, this.settingsView()),
					this.errorSlot,
				);
			} else if (mode === "rooms") {
				this.body.replaceChildren(
					this.searchBox("Search your rooms", (query) => {
						this.search = query;
						this.render();
					}),
					this.listSlot,
					this.errorSlot,
				);
			} else {
				this.body.replaceChildren(this.listSlot, this.errorSlot);
			}
		}
		if (mode !== "create" && mode !== "settings") {
			this.listSlot.replaceChildren(
				mode === "browse"
					? this.browseList()
					: this.roomList(mode === "invites"),
			);
		}
		this.errorSlot.replaceChildren(state.error ? warning(state.error) : "");
	}

	private tabBar(): HTMLElement {
		const tabs: [DirectoryTab, IconName, string, number][] = [
			[
				"rooms",
				"tabChats",
				"Your rooms",
				joinedRooms().reduce((count, room) => count + room.unread, 0),
			],
			["invites", "tabFriends", "Invitations", invites().length],
			["browse", "globe", "Public rooms", 0],
			["settings", "settings", "Settings", 0],
		];
		return h(
			"div",
			{ c: "root___M9jgF" },
			tabs.flatMap(([id, iconName, title, count], index) => [
				h(
					"button",
					{
						type: "button",
						role: "tab",
						title,
						c: cx(
							"root___FDeLd",
							!this.creating && state.directoryTab === id && "selected___f9h6Z",
						),
						on: {
							click: () => {
								this.creating = false;
								setDirectoryTab(id);
								if (id === "browse") void this.loadBrowse();
							},
						},
					},
					icon(iconName, "icon___mLyRZ"),
					badge("messageCount___jsC_Z", count),
				),
				index < tabs.length - 1 ? h("div", { c: "divider___yq6Xu" }) : null,
			]),
		);
	}

	private searchBox(
		placeholder: string,
		onInput: (query: string) => void,
	): HTMLElement {
		const box = textInput({
			placeholder,
			icon: "search",
			value: state.directoryTab === "browse" ? this.browseQuery : this.search,
			onInput,
		});
		return h("div", { c: "root___wDVPW root___TNYGW" }, box.root);
	}

	private card(opts: {
		key: string;
		iconName: string;
		color?: string;
		title: string;
		metadata?: string;
		description: string;
		unread?: number;
		mentions?: number[];
		onClick: () => void;
		createIcon?: boolean;
	}): HTMLElement {
		return h(
			"button",
			{
				type: "button",
				c: `root___QOWpT sc-card ${opts.color ? "sc-colored" : ""}`,
				id: `sc_room_card_${opts.key}`,
				style: opts.color ? `--sc-room: ${opts.color}` : undefined,
				on: { click: opts.onClick },
			},
			h(
				"span",
				{ c: "root___uxEGq largeWrapper___i8ZDk sc-card-icon" },
				opts.createIcon ? componentIcon("createRoom") : roomIcon(opts.iconName),
			),
			h(
				"div",
				{ c: "wrapper___pXMZO" },
				h(
					"div",
					{ c: "header___PzxzT" },
					text("link1", "title___BsFVo regular___hyk3H", {}, opts.title),
					opts.metadata
						? text("body", "metadata___n5Pj2", {}, opts.metadata)
						: null,
				),
				h(
					"div",
					{ c: "content___LLeBK" },
					text(
						"body",
						"description____safi",
						{},
						h("span", { c: "root___RoNAh" }, opts.description),
					),
				),
				badge("messageCount___IqCpE", opts.unread ?? 0),
				atBadge("sc-at-card", opts.mentions),
			),
		);
	}

	private roomList(invitesOnly: boolean): HTMLElement {
		const query = this.search.toLowerCase();
		const rooms = (invitesOnly ? invites() : joinedRooms()).filter(
			(room) => !query || room.name.toLowerCase().includes(query),
		);
		const cards: HTMLElement[] = [];
		if (!invitesOnly && !query) {
			cards.push(
				this.card({
					key: "create",
					iconName: "",
					createIcon: true,
					title: "Create New Chat Room",
					description: `Create your own chat room and invite players or whole factions (up to ${CHAT_LIMITS.ownedRooms})`,
					onClick: () => {
						this.creating = true;
						this.render();
					},
				}),
			);
		}
		for (const room of rooms) {
			cards.push(
				this.card({
					key: room.id,
					iconName: room.icon,
					color: room.color,
					title: room.name,
					metadata: room.lastMessage
						? ago(room.lastMessage.ts)
						: invitesOnly
							? "invited"
							: "",
					description: room.lastMessage
						? `${senderName(room, room.lastMessage)}: ${room.lastMessage.text || (room.lastMessage.gif ? "GIF" : "")}`
						: room.description || "No messages yet",
					unread: room.unread,
					mentions: room.joined ? room.mentions : undefined,
					onClick: () =>
						room.joined
							? openRoom(room.id)
							: join(room.id).catch((error: unknown) =>
									alert(error instanceof Error ? error.message : String(error)),
								),
				}),
			);
		}
		if (invitesOnly && !rooms.length) {
			cards.push(
				text(
					"body",
					"sc-empty",
					{},
					"No invitations. When someone invites you or your faction, the room shows up here.",
				),
			);
		}
		return h(
			"div",
			{ c: "root___nbZIu sc-scroll" },
			h("div", { c: "sc-list" }, cards),
			h("div", { c: "footer___v_x_1" }),
		);
	}

	private async loadBrowse(query = this.browseQuery): Promise<void> {
		this.browseQuery = query;
		try {
			const { rooms } = await api<{ rooms: ChatBrowseRoom[] }>(
				"GET",
				`/v2/chat/rooms/browse?q=${encodeURIComponent(query)}`,
			);
			if (query === this.browseQuery) {
				this.browse = rooms;
				this.render();
			}
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			this.render();
		}
	}

	private browseList(): HTMLElement {
		if (!this.browse) {
			void this.loadBrowse();
			return h("div", { c: "root___nbZIu" });
		}
		const cards = this.browse.map((room) =>
			this.card({
				key: `pub_${room.id}`,
				iconName: room.icon,
				color: room.color,
				title: room.name,
				metadata: `${room.memberCount} ${room.memberCount === 1 ? "member" : "members"}`,
				description: room.description || room.topic,
				onClick: () =>
					room.joined
						? openRoom(room.id)
						: join(room.id).catch((error: unknown) =>
								alert(error instanceof Error ? error.message : String(error)),
							),
			}),
		);
		if (!cards.length) {
			cards.push(
				text(
					"body",
					"sc-empty",
					{},
					this.browseQuery ? "No results found" : "No public rooms yet.",
				),
			);
		}
		return h(
			"div",
			{ c: "root___nbZIu sc-scroll" },
			h("div", { c: "sc-list" }, cards),
			h("div", { c: "footer___v_x_1" }),
		);
	}

	private settingsView(): HTMLElement {
		const me = state.me;
		if (!me) return h("div", {});
		const status = text("body", "", { style: "margin-top: 6px;" }, "");
		const consent = avatarCheckbox(me.showAvatar, (show) => {
			consent.input.disabled = true;
			void api<{ me: typeof me }>("PATCH", "/v2/chat/me", {
				showAvatar: show,
			})
				.then((response) => {
					applyMe(response.me);
					setOwnAvatar(show);
					status.textContent = show
						? "Your picture now shows next to your messages."
						: "Your picture is removed, also from your past messages.";
				})
				.catch((error: unknown) => {
					consent.input.checked = !show;
					status.textContent =
						error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					consent.input.disabled = false;
				});
		});
		return h(
			"div",
			{},
			setting("Profile picture", [
				consent.label,
				text(
					"body",
					"",
					{ style: "margin-top: 6px; opacity: 0.8;" },
					"Off by default. When off, the server keeps no link to your picture and others see Torn's default avatar.",
				),
				status,
			]),
			setting("Account", [
				text(
					"body",
					"",
					{ style: "margin-bottom: 8px;" },
					`Logged in as ${me.name} [${me.id}]${me.factionTag ? `, faction ${me.factionTag}` : ""}.`,
				),
				h(
					"div",
					{ c: "root___ek5Sm" },
					actionButton("settings", "Open Subversive settings", () =>
						this.onOpenSettings(),
					),
				),
				text(
					"body",
					"",
					{ style: "margin-top: 8px; opacity: 0.8;" },
					"Messages are stored on the Subversive server (the last 5,000 per room) and are visible to the members of the rooms you post in.",
				),
			]),
			setting("GIFs", [
				text(
					"body",
					"",
					{},
					state.gif.enabled
						? "GIF search is available in the composer. Pasting a KLIPY, Tenor or Giphy image link also sends it as a GIF."
						: "GIF search is not configured on this server. You can still paste a KLIPY, Tenor or Giphy image link to send it as a GIF.",
				),
			]),
		);
	}

	private connectView(): HTMLElement {
		return h(
			"div",
			{ c: "root___bdV8w sc-login" },
			setting("Subversive Chat", [
				text(
					"body",
					"",
					{},
					"Chat rooms inside Torn's chat bar for the Subversive family: create rooms, invite players or whole factions, react, tag people and send GIFs.",
				),
				text(
					"body",
					"",
					{ style: "margin-top: 8px;" },
					"Connect your Torn API key in the Subversive panel first. The same session signs you in here, so there is no second login.",
				),
				h(
					"div",
					{ c: "root___gsxrG", style: "margin-top: 10px;" },
					tornBtn("Open Subversive settings", () => this.onOpenSettings()),
				),
				text(
					"body",
					"",
					{ style: "margin-top: 8px; opacity: 0.8;" },
					"Stored on the server: your player ID, name and faction tag, your profile picture link only if you enable it in chat settings, and the messages you post. Visible to members of the rooms you post in.",
				),
			]),
		);
	}
}

function avatarCheckbox(
	checked: boolean,
	onChange: (value: boolean) => void,
): { label: HTMLElement; input: HTMLInputElement } {
	return checkbox(
		"Show my Torn profile picture next to my messages",
		checked,
		onChange,
	);
}

function withClick<T extends Element>(el: T, run: () => void): T {
	el.addEventListener("click", (event) => {
		event.stopPropagation();
		run();
	});
	return el;
}
