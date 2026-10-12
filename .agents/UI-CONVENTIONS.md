# Sentinel Dashboard — UI Conventions

Applies to `web/dashboard`. Every page and component must follow these rules so
the dashboard reads as one product on both desktop and mobile.

## Design tokens (never bypass them)

All colour comes from CSS variables declared in `src/index.css` and exposed as
Tailwind utilities through `@theme inline`. **Never** write raw palette colours
(`text-amber-400`, `bg-blue-500/10`, `border-emerald-500/30`) or hex values.
They do not respond to the light/dark theme toggle.

| Need | Use |
| --- | --- |
| Page / card / popover surfaces | `bg-background`, `bg-card`, `bg-popover`, `bg-muted`, `bg-accent`, `bg-secondary` |
| Body copy | `text-foreground`, `text-muted-foreground` |
| Primary action / active state | `bg-primary`, `text-primary`, `border-primary/30`, `bg-primary/10` |
| Positive / live / saved | `text-success`, `bg-success/10`, `border-success/30` |
| Caution / pending / dirty | `text-warning`, `bg-warning/10`, `border-warning/30` |
| Error / destructive | `text-destructive`, `bg-destructive/10`, `border-destructive/30` |
| Neutral status / counters | `text-info`, `bg-info/10`, `border-info/30` |
| Dividers | `border-border`, `border-border/60`, `border-border/40` |

For anything shaped like a status pill use the shared `StatusBadge`
(`@/components/StatusBadge`) with `tone="neutral | primary | success | warning |
danger | info"`, instead of hand-rolling classes.

Dark mode is class-driven (`.dark` on `<html>`); `dark:` utilities work only
because `@custom-variant dark` is declared in `index.css`. Do not add
`prefers-color-scheme` media queries.

## Typography

- Page title: `<PageHeader title=... />` (never a bare `<h1>` with ad-hoc sizes).
- Section title: `text-sm font-semibold tracking-tight`.
- Body / helper copy: `text-sm`, `text-xs text-muted-foreground`.
- Mono (`font-mono`) is only for IDs, channel names, counts and code-like values.
- Never use `text-[Npx]` below 10px.

## Shared components — use these, do not re-implement

| Component | Import | Purpose |
| --- | --- | --- |
| `PageShell` | `@/components/PageShell` | Page container: max width, vertical rhythm, bottom padding |
| `PageSection` | `@/components/PageShell` | Titled block inside a page |
| `PageHeader` | `@/components/PageHeader` | Title / description / icon / badge / actions row |
| `SectionCard` | `@/components/SectionCard` | Card with header + body and standard padding |
| `SectionCardFooter` | `@/components/SectionCard` | Card footer: status text + stacked action buttons |
| `StatusBadge` | `@/components/StatusBadge` | Semantic status pill |
| `StatCard`, `StatGrid` | `@/components/StatCard` | Metric tiles |
| `EmptyState` | `@/components/EmptyState` | "Nothing here yet" block |
| `ConfirmDialog` | `@/components/ConfirmDialog` | Destructive-action confirmation |
| `ScrollX`, `ScrollableTabs`, `Pagination` | `@/components/ScrollX` | Horizontal overflow, tab strips, table paging |
| `PageLoader`, `InlineLoader` | `@/components/PageLoader` | Loading states |

Everything else must come from `@/components/ui/*` (shadcn). Available:
`accordion`, `alert`, `alert-dialog`, `avatar`, `badge`, `button`, `card`,
`checkbox`, `collapsible`, `dialog`, `dropdown-menu`, `empty`, `input`, `label`,
`popover`, `progress`, `radio-group`, `scroll-area`, `select`, `separator`,
`sheet`, `skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`,
`textarea`, `toggle`, `toggle-group`, `tooltip`.

Raw HTML `<button>`, `<input>`, `<select>`, `<textarea>`, `<label>` are
**not allowed** — use `Button`, `Input`, `Select`, `Textarea`, `Label`,
`Checkbox`, `Switch`. The only exceptions are the invisible full-screen overlay
patterns already provided by Radix primitives.

## Mobile rules (the point of this refactor)

Breakpoints in use: `sm: 640px`, `md: 768px`, `lg: 1024px`. Phones are the
default; **write the mobile layout first and add `sm:`/`lg:` overrides.**

1. **Never** use `h-screen`, `w-screen`, `100vh` or `100vw`. Use `h-dvh`,
   `min-h-dvh`, `w-full`.
2. Never let a row of controls sit side-by-side on a phone when it needs more
   than ~320px. Stack it: `flex flex-col gap-2 sm:flex-row sm:items-center`.
   This applies to card footers, toolbar/header rows, filter bars, form rows and
   button groups.
3. Multi-column grids start at one column: `grid grid-cols-1 gap-3 sm:grid-cols-2
   lg:grid-cols-4`. Never `grid-cols-2` as the base.
4. Any horizontal row that can overflow (tables, tab strips, chip lists, long
   values) must live in `ScrollX` / `ScrollableTabs`, or be `min-w-0` + `truncate`.
5. Long dynamic text (guild names, channel names, usernames, URLs, error
   messages) needs `min-w-0` on the flex parent and `truncate` or
   `break-anywhere` on the text node.
6. Icons inside buttons must be `shrink-0`; labels must be allowed to truncate.
7. Touch targets are at least 36px tall on mobile (`h-9` / `size-9`, or `size-10`
   for primary actions). Do not shrink icon buttons below `size-8`.
8. Sticky/fixed bars need `pb-[env(safe-area-inset-bottom)]` when they touch the
   bottom edge, and `px-[max(0.75rem,env(safe-area-inset-left))]`-style padding
   when they touch a side edge.
9. Dialogs and sheets must not exceed the viewport: the shared `Dialog`,
   `AlertDialog`, `Sheet` and `Popover` primitives already clamp to `dvh`/`vw` —
   do not override their sizing with fixed `h-`/`w-` classes.
10. Prefer `flex-wrap` over fixed widths for badge/tag rows.

## Code conventions

- Strict TypeScript: no `any`, handle `T | undefined` from index access.
- Template literals, not string concatenation.
- Keep imports at the top, grouped: external, `@/components`, `@/components/ui`,
  `@/lib`, relative.
- Preserve all existing behaviour, data fetching, handlers, validation and copy.
  This is a presentation refactor — do not rename props, remove features, or
  change API calls.
- Keep files formatted the way Biome expects (tabs, double quotes, trailing
  commas). Run `npx biome check --write <files>` on the files you touch.
