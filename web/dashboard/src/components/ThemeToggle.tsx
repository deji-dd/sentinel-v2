import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
	className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
	const { theme, toggle } = useTheme();

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			onClick={toggle}
			aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
			title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
			className={cn(
				"cursor-pointer border border-border/70 bg-card/60 hover:bg-accent hover:border-primary/40 rounded-xl",
				className,
			)}
		>
			{theme === "dark" ? (
				<Sun className="size-4 text-amber-400 transition-transform hover:rotate-45" />
			) : (
				<Moon className="size-4 text-sky-500 transition-transform hover:-rotate-12" />
			)}
			<span className="sr-only">Toggle theme</span>
		</Button>
	);
}
