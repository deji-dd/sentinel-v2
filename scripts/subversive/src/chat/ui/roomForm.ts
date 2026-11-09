// Create / edit a room: Torn's room settings form (name, icon, description, access control).
import { h, ROOM_ICON_NAMES, roomIcon, text } from "../dom";
import {
	CHAT_LIMITS,
	type ChatPostPolicy,
	type ChatVisibility,
} from "../protocol";
import { state } from "../store";
import {
	backView,
	checkbox,
	setting,
	tabList,
	textInput,
	tornBtn,
} from "./forms";

export interface RoomFormValues {
	name: string;
	description: string;
	icon: string;
	color: string;
	visibility: ChatVisibility;
	postPolicy: ChatPostPolicy;
	showFactionTags: boolean;
}

export function roomForm(opts: {
	backTitle: string;
	submitTitle: string;
	initial?: RoomFormValues;
	onBack: () => void;
	onSubmit: (values: RoomFormValues) => Promise<void>;
}): HTMLElement {
	const values: RoomFormValues = opts.initial
		? { ...opts.initial }
		: {
				name: "",
				description: "",
				icon: "",
				color: "",
				visibility: "private",
				postPolicy: "everyone",
				showFactionTags: false,
			};
	const host = h("div", { style: "display: contents;" });

	const main = () => {
		const submit = tornBtn(opts.submitTitle, () => {}, {
			cls: "actionButton___ucXZJ",
			submit: true,
		});
		const error = text("error", "", {
			style: "margin: 10px 10px 0; display: none;",
		});
		const valid = () => {
			submit.disabled = !values.name.trim();
		};
		const name = textInput({
			value: values.name,
			maxLength: CHAT_LIMITS.roomName,
			onInput: (value) => {
				values.name = value;
				valid();
			},
		});
		const description = textInput({
			value: values.description,
			maxLength: CHAT_LIMITS.description,
			onInput: (value) => (values.description = value),
		});
		const iconBtn = h(
			"button",
			{
				type: "button",
				c: "root___Z_Afv iconWrapper___N1Bnd iconButton___URo_b",
				on: { click: () => picker() },
			},
			h(
				"div",
				{ c: "iconWrapper___N1Bnd" },
				roomIcon(values.icon, "icon___eo4eO"),
			),
		);
		const accessOptions: {
			value: ChatVisibility;
			title: string;
			icon: "accessPrivate" | "accessPublic";
		}[] = [{ value: "private", title: "Invite only", icon: "accessPrivate" }];
		if (state.me?.superadmin) {
			accessOptions.push({
				value: "public",
				title: "Public",
				icon: "accessPublic",
			});
		}
		const form = h(
			"form",
			{
				on: {
					submit: (event: Event) => {
						event.preventDefault();
						submit.disabled = true;
						error.style.display = "none";
						void opts
							.onSubmit({
								...values,
								name: values.name.trim(),
								description: values.description.trim(),
							})
							.catch((err: unknown) => {
								error.textContent =
									err instanceof Error ? err.message : String(err);
								error.style.display = "";
								submit.disabled = false;
							});
					},
				},
			},
			backView(opts.backTitle, opts.onBack, "sc-scroll", [
				h(
					"div",
					{ style: "display: flex; flex-direction: row;" },
					setting("Room name", [name.root], { cls: "roomNameSetting___S2obB" }),
					setting("Icon", [iconBtn]),
				),
				setting("Room description", [
					h("div", { c: "row___gZZ09" }, description.root),
				]),
				setting("Color", [
					colorPicker(values.color, (color) => (values.color = color)),
				]),
				setting("Access control", [
					tabList(accessOptions, values.visibility, (value) => {
						values.visibility = value;
					}),
				]),
				setting("Who can write", [
					tabList(
						[
							{
								value: "everyone" as ChatPostPolicy,
								title: "Everyone",
								icon: "accessPublic" as const,
							},
							{
								value: "admins" as ChatPostPolicy,
								title: "Admins only",
								icon: "accessExclusive" as const,
							},
						],
						values.postPolicy,
						(value) => (values.postPolicy = value),
					),
				]),
				setting("Names", [
					checkbox(
						"Show [faction tag] before names",
						values.showFactionTags,
						(value) => (values.showFactionTags = value),
					).label,
				]),
				error,
				submit,
			]),
		);
		valid();
		host.replaceChildren(form);
		name.input.focus();
	};

	// oS: the icon picker.
	const picker = () => {
		const grid = h("div", { c: "collection___MXn9U" });
		const draw = (query: string) =>
			grid.replaceChildren(
				...["", ...ROOM_ICON_NAMES]
					.filter((name) => !query || name.includes(query.toLowerCase()))
					.map((name) =>
						h(
							"div",
							{
								role: "presentation",
								title: name || "default",
								on: {
									click: () => {
										values.icon = name;
										main();
									},
								},
							},
							roomIcon(name, "", name || "default"),
						),
					),
			);
		const search = textInput({
			placeholder: "Search icons",
			icon: "search",
			cls: "input___dQlNS",
			onInput: draw,
		});
		draw("");
		host.replaceChildren(
			backView("Back to settings", main, "root___SvMxo", [search.root, grid]),
		);
		search.input.focus();
	};

	main();
	return host;
}

// Torn-toned presets; '' keeps Torn's grey. The last swatch opens the system color picker.
const PRESETS = [
	"",
	"#b22222",
	"#c2571a",
	"#b8860b",
	"#2e7d32",
	"#00838f",
	"#1565c0",
	"#6a1b9a",
	"#ad1457",
];

function colorPicker(
	initial: string,
	onChange: (color: string) => void,
): HTMLElement {
	let current = initial;
	const custom = h("input", {
		type: "color",
		title: "Custom color",
		value: initial && !PRESETS.includes(initial) ? initial : "#888888",
		on: {
			input: (event: Event) => pick((event.target as HTMLInputElement).value),
		},
	});
	const customSwatch = h(
		"label",
		{ c: "sc-swatch sc-swatch-custom", title: "Custom color" },
		custom,
	);
	const swatches = PRESETS.map((color) =>
		h("button", {
			type: "button",
			title: color || "Default",
			c: `sc-swatch ${color ? "" : "sc-swatch-default"}`,
			style: color ? `--sc-room: ${color}` : undefined,
			on: { click: () => pick(color) },
		}),
	);
	// Only toggle classes: rebuilding would close the system color picker while it is open.
	const draw = () => {
		swatches.forEach((el, index) =>
			el.classList.toggle("sc-swatch-on", PRESETS[index] === current),
		);
		const isCustom = !!current && !PRESETS.includes(current);
		customSwatch.classList.toggle("sc-swatch-on", isCustom);
		if (isCustom) customSwatch.style.setProperty("--sc-room", current);
	};
	const pick = (color: string) => {
		current = color;
		onChange(color);
		draw();
	};
	draw();
	return h("div", { c: "sc-swatches" }, ...swatches, customSwatch);
}
