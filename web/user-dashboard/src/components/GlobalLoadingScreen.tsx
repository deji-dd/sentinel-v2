import { useGlobalLoading } from "@/contexts/LoadingContext";
import { useTheme } from "@/contexts/ThemeContext";

export function GlobalLoadingScreen() {
	const { isLoading } = useGlobalLoading();
	const { theme } = useTheme();

	return (
		<div
			aria-hidden={!isLoading}
			className={`absolute inset-0 z-30 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
				isLoading
					? "opacity-100 pointer-events-auto"
					: "opacity-0 pointer-events-none scale-102 blur-xs"
			} ${
				theme === "light"
					? "bg-[#f8fafc]/80 text-slate-900"
					: "bg-[#060913]/80 text-slate-100"
			} backdrop-blur-md`}
		>
			{/* Antigravity Glassmorphism Floating Card (Fixed 280px x 180px) */}
			<div
				className={`relative z-10 flex flex-col items-center justify-center gap-5 rounded-3xl border transition-all duration-300 w-[280px] h-[180px] shadow-2xl box-border select-none ${
					theme === "light"
						? "bg-white/85 border-slate-200/90 shadow-slate-300/40"
						: "bg-[#0b1120]/80 border-[rgba(56,189,248,0.16)] shadow-[0_20px_45px_-10px_rgba(56,189,248,0.12)] backdrop-blur-2xl"
				}`}
			>
				{/* Top Laser Accent Beam */}
				<div className="absolute top-0 left-6 right-6 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-80 animate-pulse" />

				{/* Dual-Orbital Concentric Radar Visualizer (Fixed 64px x 64px) */}
				<div className="relative size-16 flex items-center justify-center">
					{/* Outer counter-clockwise dashed ring */}
					<div
						className={`absolute inset-0 rounded-full border-2 border-dashed animate-spin ${
							theme === "light"
								? "border-[rgba(2,132,199,0.18)]"
								: "border-[rgba(56,189,248,0.16)]"
						}`}
						style={{ animationDuration: "6s", animationDirection: "reverse" }}
					/>

					{/* Middle fast-spinning gradient arc */}
					<div
						className={`absolute inset-2 rounded-full border-2 border-transparent animate-spin ${
							theme === "light"
								? "border-t-[#0284c7] border-r-[#818cf8]"
								: "border-t-[#38bdf8] border-r-[#818cf8]"
						}`}
						style={{ animationDuration: "1s" }}
					/>

					{/* Core Glowing Orb */}
					<div
						className={`size-2.5 rounded-full shadow-[0_0_12px_var(--color-primary)] ${
							theme === "light" ? "bg-[#0284c7]" : "bg-[#38bdf8]"
						}`}
						style={{
							animation:
								"sentinel-core-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite",
						}}
					/>
				</div>

				{/* Simple Sentinel Label (Fixed 20px height) */}
				<div className="h-5 flex items-center justify-center">
					<span className="text-[14px] leading-5 font-bold font-mono tracking-[0.2em] uppercase">
						SENTINEL
					</span>
				</div>
			</div>
		</div>
	);
}
