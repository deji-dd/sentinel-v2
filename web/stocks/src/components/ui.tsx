import { Info } from "lucide-react";
import { type ReactNode, useId } from "react";

import { cn } from "@/lib/utils";

import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Label } from "./ui/label";
import { Spinner as SpinnerIcon } from "./ui/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./ui/tooltip";

// Every interactive primitive is a shadcn/ui component. Re-exported here so
// pages import from one place; do not hand-roll buttons, inputs or selects.
export { Button } from "./ui/button";
export { Checkbox } from "./ui/checkbox";
export { Input } from "./ui/input";
export { Label } from "./ui/label";
export { NumberInput } from "./ui/number-input";
export {
	Select,
	SelectContent,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
export {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";
export {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "./ui/sheet";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export function PageShell({ children }: { children: ReactNode }) {
	return (
		<div className="mx-auto w-full min-w-0 max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-8">
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
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Card className="gap-3 py-4 sm:py-5">
			<CardHeader className="flex flex-col gap-2 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
				<div className="min-w-0">
					<CardTitle className="text-sm font-semibold tracking-tight">
						{title}
					</CardTitle>
					{description ? (
						<CardDescription className="mt-0.5 text-xs">
							{description}
						</CardDescription>
					) : null}
				</div>
				{actions ? (
					<div className="flex flex-wrap items-center gap-2">{actions}</div>
				) : null}
			</CardHeader>
			<CardContent className="px-4 sm:px-5">{children}</CardContent>
		</Card>
	);
}

export function StatCard({
	label,
	value,
	hint,
	tone = "default",
	help,
}: {
	label: string;
	value: string;
	hint?: string;
	tone?: "default" | "success" | "warning" | "danger" | "info";
	help?: ReactNode;
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
		<Card className="gap-1.5 py-4">
			<CardContent className="px-4">
				<p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{label}
					{help ? <HelpTip>{help}</HelpTip> : null}
				</p>
				<p className={cn("mt-1 font-mono text-xl font-semibold", toneClass)}>
					{value}
				</p>
				{hint ? (
					<p className="mt-1 text-xs text-muted-foreground">{hint}</p>
				) : null}
			</CardContent>
		</Card>
	);
}

const BADGE_TONES = {
	neutral: "border-border bg-muted text-muted-foreground",
	primary: "border-primary/30 bg-primary/10 text-primary",
	success: "border-success/30 bg-success/10 text-success",
	warning: "border-warning/30 bg-warning/10 text-warning",
	danger: "border-destructive/30 bg-destructive/10 text-destructive",
	info: "border-info/30 bg-info/10 text-info",
} as const;

export function StatusBadge({
	tone = "neutral",
	children,
}: {
	tone?: keyof typeof BADGE_TONES;
	children: ReactNode;
}) {
	return (
		<Badge
			variant="outline"
			className={cn(
				"text-[11px] font-semibold uppercase tracking-wide",
				BADGE_TONES[tone],
			)}
		>
			{children}
		</Badge>
	);
}

export function EmptyState({
	title,
	description,
}: {
	title: string;
	description?: ReactNode;
}) {
	return (
		<Empty className="p-6 md:p-8">
			<EmptyHeader>
				<EmptyTitle className="text-sm font-semibold">{title}</EmptyTitle>
				{description ? (
					<EmptyDescription className="text-xs">{description}</EmptyDescription>
				) : null}
			</EmptyHeader>
		</Empty>
	);
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
	return (
		<div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
			<SpinnerIcon />
			{label}
		</div>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	return (
		<Alert variant="destructive" className="mb-4">
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

export function CheckboxField({
	label,
	checked,
	onCheckedChange,
}: {
	label: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<Label htmlFor={id} className="flex items-center gap-2 text-sm font-normal">
			<Checkbox
				id={id}
				checked={checked}
				onCheckedChange={(value) => onCheckedChange(value === true)}
			/>
			<span className="text-muted-foreground">{label}</span>
		</Label>
	);
}

export function HelpTip({ children }: { children: ReactNode }) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="text-muted-foreground"
						aria-label="More information"
					>
						<Info />
					</Button>
				</TooltipTrigger>
				<TooltipContent className="max-w-72 text-xs leading-relaxed">
					{children}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
