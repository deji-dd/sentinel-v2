import { type IconName, ICONS } from "./generated/icons";
import { COMPONENT_ICONS, ROOM_ICONS } from "./generated/room-icons";
import { CHAT_MENTION, type ChatMentionView } from "./protocol";

/**
 * Tiny DOM helpers. Torn chat class names (`name___hash`) are prefixed with
 * `sc_` to match our namespaced copy of Torn's chat CSS, so they never collide
 * with Torn's live classes or with the original Torn Rooms script.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
	return parts
		.filter(Boolean)
		.join(" ")
		.split(/\s+/)
		.filter(Boolean)
		.map((c) => (c.includes("___") && !c.startsWith("sc_") ? `sc_${c}` : c))
		.join(" ");
}

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
	c?: string;
	style?: string;
	on?: Record<string, (event: Event) => void>;
	[attr: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Props = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "c") el.className = cx(value as string);
		else if (key === "on") {
			for (const [event, handler] of Object.entries(
				value as Record<string, (event: Event) => void>,
			)) {
				el.addEventListener(event, handler);
			}
		} else if (key === "style") el.setAttribute("style", value as string);
		else if (key === "value" && "value" in el) {
			(el as HTMLInputElement).value = String(value);
		} else if (value === true) el.setAttribute(key, "");
		else el.setAttribute(key, String(value));
	}
	append(el, children);
	return el;
}

/** replaceChildren that accepts the same children as h(), including null and arrays. */
export function fill(el: Element, ...children: Child[]): void {
	el.replaceChildren();
	append(el, children);
}

export function append(el: Node, children: Child[]): void {
	for (const child of children) {
		if (Array.isArray(child)) {
			append(el, child);
			continue;
		}
		if (child === null || child === undefined || child === false) continue;
		el.appendChild(
			child instanceof Node ? child : document.createTextNode(String(child)),
		);
	}
}

const NS = "http://www.w3.org/2000/svg";
let gradientSeq = 0;

/** Torn's icon component: an SVG whose paths are filled by a CSS-coloured gradient. */
function svg(
	def: {
		viewBox: string;
		inner: string;
		width?: string | null;
		height?: string | null;
	},
	cls: string,
	label?: string,
): SVGSVGElement {
	const el = document.createElementNS(NS, "svg");
	const id = `sc_icon_gradient${++gradientSeq}_default`;
	el.setAttribute("viewBox", def.viewBox);
	el.setAttribute("width", def.width ?? "24");
	el.setAttribute("height", def.height ?? "24");
	el.setAttribute("class", cx("root___mSyc0", cls));
	if (label) {
		el.setAttribute("role", "button");
		el.setAttribute("aria-label", label);
		el.setAttribute("tabindex", "0");
	}
	const inner = def.inner.includes("__GID__")
		? def.inner.replace(/__GID__/g, id)
		: `<defs><linearGradient id="${id}" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox"><stop id="start" offset="0"></stop><stop id="end" offset="1"></stop></linearGradient></defs><g fill="url(#${id})">${def.inner}</g>`;
	el.innerHTML = inner; // constant markup generated from Torn's own icons, never user content
	return el;
}

// Torn's retry arrows (its "Not sent · Retry" row draws them inline, so they are not in the captured icons).
const RETRY = {
	viewBox: "0 0 16 12",
	width: "16",
	height: "12",
	inner:
		'<path d="M6,6,3,9.31,0,6H2A6,6,0,0,1,12.12,1.65L10.78,3.14A4,4,0,0,0,4,6Zm7-3.31L10,6h2A4,4,0,0,1,5.22,8.87L3.88,10.36A6,6,0,0,0,14,6h2Z"></path>',
};
export const retryIcon = (cls = "") => svg(RETRY, cls);
export const icon = (name: IconName, cls = "", label?: string) =>
	svg(ICONS[name], cls, label);
export const componentIcon = (name: keyof typeof COMPONENT_ICONS, cls = "") =>
	svg(COMPONENT_ICONS[name], cls);
export const roomIcon = (name: string, cls = "", label?: string) =>
	svg(ROOM_ICONS[name] ?? ICONS.chats, cls, label);
export const ROOM_ICON_NAMES = Object.keys(ROOM_ICONS);

type Variant =
	| "headingH1"
	| "subtitle"
	| "body"
	| "error"
	| "success"
	| "placeholder"
	| "link1"
	| "link2"
	| "divider1"
	| "divider2";
const VARIANT: Record<Variant, string> = {
	headingH1: "headingH1___VK9XQ",
	subtitle: "subtitle___u4sr8",
	body: "body___HxuJg",
	error: "error___jHa2z",
	success: "success___QgAFZ",
	placeholder: "placeholder___NCioo",
	link1: "link1___jjWAf",
	link2: "link2___CQita",
	divider1: "divider1___XB_RF",
	divider2: "divider2___nG653",
};
const TAG: Record<Variant, "span" | "p" | "a"> = {
	headingH1: "span",
	subtitle: "span",
	body: "p",
	error: "p",
	success: "p",
	placeholder: "span",
	link1: "a",
	link2: "a",
	divider1: "span",
	divider2: "span",
};

/** Torn's Text component. */
export function text(
	variant: Variant,
	cls: string,
	props: Props,
	...children: Child[]
): HTMLElement {
	return h(
		TAG[variant],
		{ ...props, c: `root___XpplE ${VARIANT[variant]} ${cls}` },
		...children,
	);
}

/** Beside an unread counter: the room has messages tagging you that you have not seen. */
export function atBadge(
	cls: string,
	mentions: number[] | undefined,
): HTMLElement | null {
	return mentions?.length
		? h(
				"div",
				{
					c: cx("sc-at-badge", cls),
					title: `Tagged in ${mentions.length} message${mentions.length === 1 ? "" : "s"}`,
				},
				"@",
			)
		: null;
}

/** Torn's unread counter badge (ln component). */
export function badge(cls: string, count: number): HTMLElement | null {
	if (!count) return null;
	return h(
		"div",
		{ c: cls },
		text(
			"headingH1",
			`root____FDYX ${count < 10 ? "oneDigit___FJ3vn" : ""} ${count > 99 ? "threeDigits___LxKm3" : ""}`,
			{ style: "color: white;" },
			count > 99 ? "99+" : count,
		),
	);
}

// Torn shows Torn City Time (UTC).
const pad = (n: number) => String(n).padStart(2, "0");
export function tct(ts: number): string {
	const d = new Date(ts);
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function tctDay(ts: number): string {
	const d = new Date(ts);
	return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}`;
}
/** Relative time as moment's fromNow() with its default thresholds, which Torn's chat uses ("an hour ago" from 45 minutes). */
export function ago(ts: number, now = Date.now()): string {
	const ms = Math.abs(now - ts);
	const seconds = Math.round(ms / 1000);
	const minutes = Math.round(ms / 60_000);
	const hours = Math.round(ms / 3_600_000);
	const days = Math.round(ms / 86_400_000);
	const months = Math.round((ms / 86_400_000) * (4800 / 146097));
	const years = Math.round((ms / 86_400_000) * (400 / 146097));
	const unit = (n: number, one: string, many: string) =>
		n <= 1 ? one : `${n} ${many}`;
	const scale =
		seconds < 45
			? "a few seconds"
			: minutes < 45
				? unit(minutes, "a minute", "minutes")
				: hours < 22
					? unit(hours, "an hour", "hours")
					: days < 26
						? unit(days, "a day", "days")
						: months < 11
							? unit(months, "a month", "months")
							: unit(years, "a year", "years");
	return `${scale} ago`;
}

/** Splits text into text nodes and https links, like Torn's chat, and the `@Name`s the message tags into profile links (`me` stands out). */
export function linkify(
	s: string,
	mentions: ChatMentionView[] = [],
	me?: number,
): Child[] {
	const out: Child[] = [];
	const tagged = new Map(mentions.map((m) => [m.name.toLowerCase(), m.id]));
	const plain = (part: string) => {
		let last = 0;
		if (tagged.size) {
			for (const match of part.matchAll(CHAT_MENTION)) {
				const id = tagged.get((match[1] ?? "").toLowerCase());
				if (id === undefined) continue;
				const index = match.index ?? 0;
				if (index > last) out.push(part.slice(last, index));
				out.push(
					h(
						"a",
						{
							c: cx("sc-mention", id === me && "sc-mention-me"),
							href: `/profiles.php?XID=${id}`,
						},
						match[0],
					),
				);
				last = index + match[0].length;
			}
		}
		if (last < part.length) out.push(part.slice(last));
	};
	let last = 0;
	for (const match of s.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
		const index = match.index ?? 0;
		if (index > last) plain(s.slice(last, index));
		out.push(
			h(
				"a",
				{ href: match[0], target: "_blank", rel: "noopener noreferrer" },
				match[0],
			),
		);
		last = index + match[0].length;
	}
	if (last < s.length) plain(s.slice(last));
	return out;
}
