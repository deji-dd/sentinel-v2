import type {
	ButtonHTMLAttributes,
	InputHTMLAttributes,
	ReactNode,
	SelectHTMLAttributes,
} from "react";

function cx(...classes: Array<string | false | null | undefined>): string {
	return classes.filter(Boolean).join(" ");
}

export function PageShell({ children }: { children: ReactNode }) {
	return (
		<div className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-8">
			{children}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	badge,
	actions,
}: {
	title: string;
	description?: string;
	badge?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
						{title}
					</h1>
					{badge}
				</div>
				{description ? (
					<p className="mt-1 max-w-3xl text-sm text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex flex-wrap items-center gap-2">{actions}</div>
			) : null}
		</header>
	);
}

export function SectionCard({
	title,
	description,
	actions,
	children,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="rounded-xl border border-border/60 bg-card p-4 sm:p-5">
			<div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h2 className="text-sm font-semibold tracking-tight">{title}</h2>
					{description ? (
						<p className="mt-0.5 text-xs text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

export function StatCard({
	label,
	value,
	hint,
	tone = "default",
}: {
	label: string;
	value: string;
	hint?: string;
	tone?: "default" | "success" | "warning" | "danger" | "info";
}) {
	const toneClass =
		tone === "success"
			? "text-success"
			: tone === "warning"
				? "text-warning"
				: tone === "danger"
					? "text-destructive"
					: tone === "info"
						? "text-info"
						: "text-foreground";
	return (
		<div className="rounded-xl border border-border/60 bg-card p-4">
			<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</p>
			<p className={cx("mt-1 font-mono text-xl font-semibold", toneClass)}>
				{value}
			</p>
			{hint ? (
				<p className="mt-1 text-xs text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

const BADGE_TONES = {
	neutral: "bg-muted text-muted-foreground border-border",
	primary: "bg-primary/10 text-primary border-primary/30",
	success: "bg-success/10 text-success border-success/30",
	warning: "bg-warning/10 text-warning border-warning/30",
	danger: "bg-destructive/10 text-destructive border-destructive/30",
	info: "bg-info/10 text-info border-info/30",
} as const;

export function StatusBadge({
	tone = "neutral",
	children,
}: {
	tone?: keyof typeof BADGE_TONES;
	children: ReactNode;
}) {
	return (
		<span
			className={cx(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
				BADGE_TONES[tone],
			)}
		>
			{children}
		</span>
	);
}

export function Button({
	variant = "primary",
	className = "",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
	const variants = {
		primary: "bg-primary text-primary-foreground hover:bg-primary/90",
		secondary:
			"bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border/60",
		ghost: "bg-transparent text-foreground hover:bg-accent",
		danger:
			"bg-destructive text-destructive-foreground hover:bg-destructive/90",
	};
	return (
		<button
			className={cx(
				"inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition disabled:opacity-50",
				variants[variant],
				className,
			)}
			{...props}
		/>
	);
}

export function Input({
	className = "",
	...props
}: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			className={cx(
				"h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-ring",
				className,
			)}
			{...props}
		/>
	);
}

export function Select({
	className = "",
	children,
	...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<select
			className={cx(
				"h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring",
				className,
			)}
			{...props}
		>
			{children}
		</select>
	);
}

export function EmptyState({
	title,
	description,
}: {
	title: string;
	description?: string;
}) {
	return (
		<div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
			<p className="text-sm font-semibold">{title}</p>
			{description ? (
				<p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
					{description}
				</p>
			) : null}
		</div>
	);
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
	return (
		<div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
			<span className="size-4 animate-spin rounded-full border-2 border-border border-t-primary" />
			{label}
		</div>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{message}
		</div>
	);
}

export function Checkbox({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="size-4 rounded border-border bg-background accent-primary"
			/>
			<span className="text-muted-foreground">{label}</span>
		</label>
	);
}
