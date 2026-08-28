import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	Loader2,
} from "lucide-react";
import type React from "react";
import { Toaster as Sonner, type ToasterProps, toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "dark" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			icons={{
				success: <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />,
				info: <Info className="size-4 text-sky-400 shrink-0" />,
				warning: <AlertTriangle className="size-4 text-amber-400 shrink-0" />,
				error: <AlertCircle className="size-4 text-rose-400 shrink-0" />,
				loading: (
					<Loader2 className="size-4 text-primary animate-spin shrink-0" />
				),
			}}
			toastOptions={{
				classNames: {
					toast:
						"group toast group-[.toaster]:bg-card/90 group-[.toaster]:backdrop-blur-2xl group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:border-border/80 group-[.toaster]:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.08)] group-[.toaster]:rounded-2xl font-sans group-[.toaster]:p-4 group-[.toaster]:gap-3 group-[.toaster]:antialiased",
					title:
						"group-[.toast]:font-semibold group-[.toast]:text-xs group-[.toast]:text-foreground font-display tracking-tight",
					description:
						"group-[.toast]:text-[11px] group-[.toast]:text-muted-foreground group-[.toast]:leading-relaxed font-mono",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:rounded-xl group-[.toast]:text-xs group-[.toast]:font-semibold group-[.toast]:px-3 group-[.toast]:py-1.5 hover:group-[.toast]:bg-primary/90 transition-all shadow-xs",
					cancelButton:
						"group-[.toast]:bg-secondary group-[.toast]:text-secondary-foreground group-[.toast]:rounded-xl group-[.toast]:text-xs group-[.toast]:px-3 group-[.toast]:py-1.5",
					success:
						"group-[.toaster]:border-emerald-500/30 group-[.toaster]:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.4),0_0_24px_-4px_rgba(16,185,129,0.25)]",
					error:
						"group-[.toaster]:border-rose-500/30 group-[.toaster]:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.4),0_0_24px_-4px_rgba(244,63,94,0.25)]",
					warning:
						"group-[.toaster]:border-amber-500/30 group-[.toaster]:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.4),0_0_24px_-4px_rgba(245,158,11,0.25)]",
					info: "group-[.toaster]:border-sky-500/30 group-[.toaster]:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.4),0_0_24px_-4px_rgba(56,189,248,0.25)]",
				},
			}}
			style={
				{
					"--normal-bg": "var(--card)",
					"--normal-text": "var(--card-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius-xl)",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster, toast };
