import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

/**
 * Minimal shape of a Discord channel as returned by the guild-channels endpoints.
 * `parent_id` is the category channel id, or null when the channel sits at the top
 * level of the server (uncategorized). Some endpoints historically omitted it, so it
 * is optional — grouping degrades to a single "Uncategorized" bucket when missing.
 */
export interface DiscordChannel {
	id: string;
	name: string;
	type: number;
	/** Discord's sort weight within the channel list. Used to order category groups. */
	position?: number;
	parent_id?: string | null;
}

/** Discord channel type for a category ("section" in the server UI). */
const CATEGORY_TYPE = 4;

/** GUILD_TEXT and GUILD_ANNOUNCEMENT — the only types a bot posts into. */
const TEXT_CHANNEL_TYPES = [0, 5] as const;

export interface ChannelCategoryGroup {
	/** Category name, or the UNCATEGORIZED_LABEL fallback for top-level channels. */
	categoryName: string;
	channels: DiscordChannel[];
}

const UNCATEGORIZED_LABEL = "Uncategorized";

/**
 * Groups text channels under their server category name, preserving Discord's own
 * sidebar ordering: top-level channels first, then categories in position order.
 *
 * Accepts the *raw* channel list including type-4 entries. Callers must not
 * pre-filter to text channels, or the category map is lost and everything falls
 * into a single "Uncategorized" group.
 */
export function groupChannelsByCategory(
	channels: DiscordChannel[],
	allowedTypes: readonly number[] = TEXT_CHANNEL_TYPES,
): ChannelCategoryGroup[] {
	// Pass 1 — index the categories (type 4) by id, remembering their position so
	// groups can be emitted in the same order they appear in the server sidebar.
	const categoryNameById = new Map<string, string>();
	const categoryOrderByName = new Map<string, number>();

	channels.forEach((channel, index) => {
		if (channel.type === CATEGORY_TYPE && channel.name) {
			categoryNameById.set(channel.id, channel.name);
			categoryOrderByName.set(channel.name, channel.position ?? index);
		}
	});

	// Pass 2 — bucket every selectable channel under its category name. A parent_id
	// pointing at a category the bot cannot see still lands in a usable group rather
	// than being dropped.
	const grouped = new Map<string, DiscordChannel[]>();
	let uncategorizedCount = 0;

	for (const channel of channels) {
		if (!allowedTypes.includes(channel.type)) continue;

		const parentName = channel.parent_id
			? categoryNameById.get(channel.parent_id)
			: undefined;

		if (parentName) {
			const bucket = grouped.get(parentName);
			if (bucket) bucket.push(channel);
			else grouped.set(parentName, [channel]);
		} else {
			uncategorizedCount += 1;
			const bucket = grouped.get(UNCATEGORIZED_LABEL);
			if (bucket) bucket.push(channel);
			else grouped.set(UNCATEGORIZED_LABEL, [channel]);
		}
	}

	const groups: ChannelCategoryGroup[] = [];

	// Discord shows top-level channels above every category.
	if (uncategorizedCount > 0) {
		groups.push({
			categoryName: UNCATEGORIZED_LABEL,
			channels: grouped.get(UNCATEGORIZED_LABEL) ?? [],
		});
	}

	// Real categories in position order; orphaned groups (parent_id we could not
	// resolve) sort after them by name so they stay reachable.
	const namedGroups = [...grouped.entries()].filter(
		([name]) => name !== UNCATEGORIZED_LABEL,
	);

	namedGroups.sort(([a], [b]) => {
		const pa = categoryOrderByName.get(a);
		const pb = categoryOrderByName.get(b);
		if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
		if (pa !== undefined && pb === undefined) return -1;
		if (pa === undefined && pb !== undefined) return 1;
		return a.localeCompare(b);
	});

	for (const [categoryName, groupChannels] of namedGroups) {
		groups.push({ categoryName, channels: groupChannels });
	}

	return groups;
}

interface ChannelSelectGroupsProps {
	/** Raw, unfiltered channel list (categories included). */
	channels: DiscordChannel[];
	allowedTypes?: readonly number[];
	/** Renders one optional leading "none" row, e.g. "-- No Channel Selected --". */
	noneLabel?: string;
	/** Value bound to the "none" row. Defaults to "none". */
	noneValue?: string;
	/** Shown when there are no selectable channels at all. */
	emptyLabel?: string;
	/**
	 * Resolves the Radix item value for a channel. Defaults to the channel id, but
	 * the mercenary config persists channel *names*, so it overrides this to keep
	 * existing saved selections matching.
	 */
	getItemValue?: (channel: DiscordChannel) => string;
}

/**
 * The grouped item list every channel dropdown in the dashboard renders. Kept
 * separate from <ChannelSelect> so a call site can supply its own trigger styling
 * and scroll height if it needs to.
 */
function ChannelSelectGroups({
	channels,
	allowedTypes = TEXT_CHANNEL_TYPES,
	noneLabel,
	noneValue = "none",
	emptyLabel = "No text channels found",
	getItemValue,
}: ChannelSelectGroupsProps) {
	const groups = groupChannelsByCategory(channels, allowedTypes);
	const total = groups.reduce((sum, g) => sum + g.channels.length, 0);
	const itemValue = getItemValue ?? ((channel: DiscordChannel) => channel.id);

	const noneItem = noneLabel ? (
		<SelectGroup>
			<SelectItem value={noneValue}>
				<span className="text-muted-foreground italic">{noneLabel}</span>
			</SelectItem>
		</SelectGroup>
	) : null;

	// Keep the "none" row even when the guild exposes no channels, so the control
	// never becomes an unselectable dead end.
	if (total === 0) {
		return (
			<>
				{noneItem}
				<SelectGroup>
					<SelectItem value="" disabled>
						{emptyLabel}
					</SelectItem>
				</SelectGroup>
			</>
		);
	}

	return (
		<>
			{noneItem}

			{groups.map((group, index) => (
				<SelectGroup key={`${group.categoryName}-${index}`}>
					<SelectLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
						{group.categoryName}
					</SelectLabel>
					{group.channels.map((channel) => (
						<SelectItem key={channel.id} value={itemValue(channel)}>
							#{channel.name}
						</SelectItem>
					))}
				</SelectGroup>
			))}

			{noneLabel ? <SelectSeparator /> : null}
		</>
	);
}

interface ChannelSelectProps extends ChannelSelectGroupsProps {
	value: string | null | undefined;
	onValueChange: (value: string) => void;
	id?: string;
	placeholder?: string;
	triggerClassName?: string;
	contentClassName?: string;
	disabled?: boolean;
}

/** Convenience wrapper binding trigger, content and grouped items together. */
export function ChannelSelect({
	value,
	onValueChange,
	id,
	placeholder = "-- No Channel Selected --",
	triggerClassName,
	contentClassName,
	disabled,
	noneLabel,
	noneValue = "none",
	...groupProps
}: ChannelSelectProps) {
	// When a "none" row is rendered it owns the empty state, so an unset value
	// binds to it instead of "" (which would match no item and show a stale label).
	const selected = value || (noneLabel ? noneValue : "");

	return (
		<Select value={selected} onValueChange={onValueChange} disabled={disabled}>
			<SelectTrigger
				id={id}
				className={
					triggerClassName ??
					"w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-sans"
				}
			>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent
				className={
					contentClassName ??
					"rounded-xl border-border bg-popover text-popover-foreground max-h-72"
				}
			>
				<ChannelSelectGroups
					{...groupProps}
					noneLabel={noneLabel}
					noneValue={noneValue}
				/>
			</SelectContent>
		</Select>
	);
}
