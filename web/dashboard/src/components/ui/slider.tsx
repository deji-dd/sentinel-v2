import { Slider as SliderPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

function Slider({
	className,
	defaultValue,
	value,
	min = 0,
	max = 100,
	...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
	const _values = React.useMemo(() => {
		if (Array.isArray(value)) return value;
		if (Array.isArray(defaultValue)) return defaultValue;
		return [min];
	}, [value, defaultValue, min]);

	return (
		<SliderPrimitive.Root
			data-slot="slider"
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			className={cn(
				"relative flex w-full touch-none select-none items-center cursor-pointer",
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Track
				data-slot="slider-track"
				className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted border border-border/50"
			>
				<SliderPrimitive.Range
					data-slot="slider-range"
					className="absolute h-full bg-primary"
				/>
			</SliderPrimitive.Track>
			{Array.from({ length: _values.length }, (_, index) => (
				<SliderPrimitive.Thumb
					data-slot="slider-thumb"
					key={index}
					className="block size-4.5 rounded-full border-2 border-primary bg-background shadow-md transition-[color,box-shadow] hover:ring-4 hover:ring-ring/20 focus-visible:ring-4 focus-visible:ring-ring/20 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 cursor-grab active:cursor-grabbing hover:scale-110 duration-150"
				/>
			))}
		</SliderPrimitive.Root>
	);
}

export { Slider };
