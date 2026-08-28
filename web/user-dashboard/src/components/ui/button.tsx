import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl text-xs font-semibold tracking-wide whitespace-nowrap transition-all duration-300 ease-out select-none will-change-transform outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground shadow-xs hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-md hover:shadow-primary/25 active:translate-y-0",
				destructive:
					"bg-destructive text-white shadow-xs hover:-translate-y-0.5 hover:bg-destructive/90 hover:shadow-md hover:shadow-destructive/25 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 active:translate-y-0",
				outline:
					"border border-border bg-card/60 shadow-xs backdrop-blur-md hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 active:translate-y-0",
				secondary:
					"bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 hover:shadow-sm",
				ghost:
					"hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
				link: "text-primary underline-offset-4 hover:underline",
				cyber:
					"border border-primary/30 bg-primary/10 text-primary shadow-xs hover:-translate-y-0.5 hover:border-primary/60 hover:bg-primary/20 hover:shadow-[0_0_15px_rgba(56,189,248,0.25)] active:translate-y-0",
			},
			size: {
				default: "h-9 px-4 py-2 has-[>svg]:px-3",
				xs: "h-6 gap-1 rounded-lg px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1.5 rounded-lg px-3 text-[11px] has-[>svg]:px-2.5",
				lg: "h-10 rounded-xl px-6 text-sm has-[>svg]:px-4",
				icon: "size-9",
				"icon-xs": "size-6 rounded-lg [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-7 rounded-lg",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
