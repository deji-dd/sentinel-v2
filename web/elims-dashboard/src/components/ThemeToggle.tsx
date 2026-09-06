import { Check, Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
	className?: string;
	mode?: "dropdown" | "toggle";
}

export function ThemeToggle({
	className,
	mode = "dropdown",
}: ThemeToggleProps) {
	const { theme, resolvedTheme, setTheme, toggle } = useTheme();

	if (mode === "toggle") {
		return (
			<Button
				variant="ghost"
				size="icon-sm"
				onClick={toggle}
				aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
				title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
				className={cn(
					"cursor-pointer border border-border/70 bg-card/60 hover:bg-accent hover:border-primary/40 rounded-xl",
					className,
				)}
			>
				{resolvedTheme === "dark" ? (
					<Sun className="size-4 text-amber-400 transition-transform hover:rotate-45" />
				) : (
					<Moon className="size-4 text-sky-500 transition-transform hover:-rotate-12" />
				)}
				<span className="sr-only">Toggle theme</span>
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className={cn(
						"cursor-pointer border border-border/70 bg-card/60 hover:bg-accent hover:border-primary/40 rounded-xl relative",
						className,
					)}
					aria-label="Select theme"
					title="Select theme"
				>
					<Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 text-amber-400 dark:text-foreground" />
					<Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 text-foreground dark:text-sky-400" />
					<span className="sr-only">Toggle theme</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-36">
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={() => setTheme("light")}
						className="flex items-center justify-between cursor-pointer"
					>
						<span className="flex items-center gap-2">
							<Sun className="size-4 text-amber-400" />
							<span>Light</span>
						</span>
						{theme === "light" && <Check className="size-3.5 text-primary" />}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setTheme("dark")}
						className="flex items-center justify-between cursor-pointer"
					>
						<span className="flex items-center gap-2">
							<Moon className="size-4 text-sky-400" />
							<span>Dark</span>
						</span>
						{theme === "dark" && <Check className="size-3.5 text-primary" />}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setTheme("system")}
						className="flex items-center justify-between cursor-pointer"
					>
						<span className="flex items-center gap-2">
							<Laptop className="size-4 text-muted-foreground" />
							<span>System</span>
						</span>
						{theme === "system" && <Check className="size-3.5 text-primary" />}
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
