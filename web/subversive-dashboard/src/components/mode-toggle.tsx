import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface ModeToggleProps {
	className?: string;
}

export function ModeToggle({ className }: ModeToggleProps) {
	const { theme, setTheme } = useTheme();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className={cn("cursor-pointer", className)}
				>
					<Sun className="size-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
					<Moon className="absolute size-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
					<span className="sr-only">Toggle theme</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={() => setTheme("light")}
						className="cursor-pointer flex items-center justify-between"
					>
						<div className="flex items-center gap-2">
							<Sun />
							<span>Light</span>
						</div>
						{theme === "light" && <Check className="text-primary" />}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setTheme("dark")}
						className="cursor-pointer flex items-center justify-between"
					>
						<div className="flex items-center gap-2">
							<Moon />
							<span>Dark</span>
						</div>
						{theme === "dark" && <Check className="text-primary" />}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setTheme("system")}
						className="cursor-pointer flex items-center justify-between"
					>
						<div className="flex items-center gap-2">
							<Monitor />
							<span>System</span>
						</div>
						{theme === "system" && <Check className="text-primary" />}
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
