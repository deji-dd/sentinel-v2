// Torn chat's own form components, rebuilt with our classes.
import { type Child, componentIcon, fill, h, icon, text } from "../dom";
import type { IconName } from "../generated/icons";
import type { COMPONENT_ICONS } from "../generated/room-icons";

/** oO: a titled setting row. */
export function setting(
	title: string,
	children: Child[],
	opts: { divider?: boolean; cls?: string } = {},
): HTMLElement {
	return h(
		"div",
		{
			c: `setting___nsZNm ${opts.divider === false ? "" : "withDivider___kz3yv"} ${opts.cls ?? ""}`,
		},
		text("body", "title___KbB7I", {}, `${title}:`),
		...children,
	);
}

/** Torn's checkbox with its label. */
export function checkbox(
	label: string,
	checked: boolean,
	onChange: (value: boolean) => void,
): { label: HTMLElement; input: HTMLInputElement } {
	const input = h("input", {
		type: "checkbox",
		on: {
			change: (event: Event) =>
				onChange((event.target as HTMLInputElement).checked),
		},
	});
	input.checked = checked;
	// A real <label>, so clicking the text ticks the box too.
	const root = h(
		"label",
		{ c: "root___XpplE subtitle___u4sr8 root___D4fXT" },
		input,
		label,
	);
	return { label: root, input };
}

/** ok: Torn's text input, optionally with a trailing icon. */
export function textInput(opts: {
	value?: string;
	placeholder?: string;
	maxLength?: number;
	icon?: IconName;
	cls?: string;
	inputCls?: string;
	onInput?: (value: string) => void;
	onEnter?: (value: string) => void;
}): { root: HTMLElement; input: HTMLInputElement } {
	const input = h("input", {
		c: `input___yyCYj ${opts.icon ? "withIcon___MvvN8" : ""} ${opts.inputCls ?? ""}`,
		placeholder: opts.placeholder,
		maxlength: opts.maxLength,
		value: opts.value ?? "",
		on: {
			input: (event: Event) =>
				opts.onInput?.((event.target as HTMLInputElement).value),
			keydown: (event: Event) => {
				const keyboard = event as KeyboardEvent;
				if (keyboard.key === "Enter") {
					opts.onEnter?.((event.target as HTMLInputElement).value);
				}
				event.stopPropagation(); // keep Torn's page shortcuts out of our inputs
			},
		},
	});
	const root = h(
		"div",
		{ c: `root___Npj4l ${opts.cls ?? ""}` },
		text(
			"placeholder",
			"",
			{},
			input,
			opts.icon ? icon(opts.icon, "icon___aCVAk") : null,
		),
	);
	return { root, input };
}

/** oz/oj: Torn's tab list (Access control) with icon + title tabs. */
export function tabList<T extends string>(
	options: { value: T; title: string; icon: keyof typeof COMPONENT_ICONS }[],
	selected: T,
	onSelect: (value: T) => void,
): HTMLElement {
	const root = h("div", { c: "tabList___hrzal" });
	const draw = (current: T) => {
		fill(
			root,
			...options.flatMap((option, index) => [
				h(
					"button",
					{
						type: "button",
						role: "tab",
						title: option.title,
						c: `root___FDeLd tabItem___YA_8M ${
							option.value === current
								? "selected___f9h6Z selected___qBZhh"
								: ""
						}`,
						on: {
							click: () => {
								onSelect(option.value);
								draw(option.value);
							},
						},
					},
					componentIcon(option.icon, "icon___mLyRZ"),
					text("subtitle", "tabTitle___hVWHw", {}, option.title),
				),
				index < options.length - 1 ? h("div", { c: "divider___yq6Xu" }) : null,
			]),
		);
	};
	draw(selected);
	return root;
}

/** oN: a sub-view over the panel content, with Torn's back button. */
export function backView(
	backTitle: string,
	onBack: () => void,
	cls: string,
	children: Child[],
): HTMLElement {
	return h(
		"div",
		{ c: `root___Cnq5Q ${cls}` },
		h(
			"button",
			{
				type: "button",
				c: "root___O8vU1 shadow___swjyt",
				on: { click: onBack },
			},
			componentIcon("back", "backIcon___xhiLR"),
			text("subtitle", "", {}, backTitle),
		),
		...children,
	);
}

/** Torn's site-wide button. */
export function tornBtn(
	label: string,
	onClick: () => void,
	opts: { cls?: string; disabled?: boolean; submit?: boolean } = {},
): HTMLButtonElement {
	return h(
		"button",
		{
			type: opts.submit ? "submit" : "button",
			c: `torn-btn ${opts.cls ?? ""}`,
			disabled: opts.disabled,
			on: {
				click: (event: Event) => {
					if (!opts.submit) event.preventDefault();
					onClick();
				},
			},
		},
		label,
	);
}

/** oA: the settings-panel action button (icon | title). */
export function actionButton(
	iconName: IconName,
	title: string,
	onClick: () => void,
	cls = "",
): HTMLButtonElement {
	return h(
		"button",
		{ type: "button", c: `root___Z_Afv ${cls}`, on: { click: onClick } },
		h(
			"div",
			{ c: "iconWrapper___N1Bnd" },
			icon(iconName, "icon___eo4eO withTitle___U6QVy"),
		),
		h("div", { c: "divider___mnLeP" }),
		text("subtitle", "title___ULAC9", {}, title),
	);
}

/** mv: the red warning strip shown instead of the composer. */
export function warning(message: string, ...extra: Child[]): HTMLElement {
	return text(
		"error",
		"root___PCyAT",
		{},
		componentIcon("warning", "icon___TMKXI"),
		" ",
		h("span", { c: "message___GOEQ9" }, message),
		...extra,
	);
}

/** mh: the neutral strip (Connecting…). */
export function info(message: string, ...extra: Child[]): HTMLElement {
	return text(
		"body",
		"root___XpFMX",
		{},
		componentIcon("info", "icon___S_26w"),
		" ",
		h("span", { c: "message___Zzf2J" }, message),
		...extra,
	);
}

/** Parses a player or faction id from an id or a pasted Torn profile / faction link. */
export function parseTornId(input: string): number | null {
	const value = input.trim();
	const match =
		/(?:XID=|[?&]ID=|\[)(\d+)\]?/i.exec(value) ?? /^(\d+)$/.exec(value);
	const id = match ? Number(match[1]) : Number.NaN;
	return Number.isInteger(id) && id > 0 ? id : null;
}
