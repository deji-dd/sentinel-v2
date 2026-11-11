import { useRef, useState } from "react";
import type * as React from "react";

import { cn } from "@/lib/utils";

import { Input } from "./input";

function sanitize(raw: string, decimals: number): string {
	let value = raw.replace(/,/g, "").replace(/\s/g, "");
	const negative = value.startsWith("-");
	if (negative) value = value.slice(1);
	value = value.replace(/[^\d.]/g, "");

	const dot = value.indexOf(".");
	if (dot !== -1) {
		const integer = value.slice(0, dot);
		const fraction = value.slice(dot + 1).replace(/\./g, "");
		value = decimals > 0 ? `${integer}.${fraction}` : integer;
	}
	if (value.startsWith(".")) value = `0${value}`;
	if (!value) return "";
	return negative ? `-${value}` : value;
}

function groupInteger(value: string): string {
	if (!value) return "";
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [integer = "", fraction] = unsigned.split(".");
	const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const body =
		fraction === undefined ? grouped || "0" : `${grouped || "0"}.${fraction}`;
	return negative ? `-${body}` : body;
}

function significantCount(value: string): number {
	return value.replace(/[^\d.-]/g, "").length;
}

function caretForSignificant(formatted: string, wanted: number): number {
	let seen = 0;
	for (let index = 0; index < formatted.length; index += 1) {
		if (seen >= wanted) return index;
		if (/[\d.-]/.test(formatted[index] ?? "")) seen += 1;
	}
	return formatted.length;
}

export interface NumberInputProps extends Omit<
	React.ComponentProps<typeof Input>,
	"value" | "onChange" | "type"
> {
	/** Raw numeric string without thousands separators, e.g. `1234.5`. */
	value: string;
	onValueChange: (value: string) => void;
	/** Fraction digits accepted. `0` disables the decimal point entirely. */
	decimals?: number;
}

/**
 * A shadcn `Input` that renders thousands separators (`1,234,567`) while
 * keeping the value handed to the caller unformatted, so money parsing and
 * number validation see a plain decimal string.
 */
export function NumberInput({
	value,
	onValueChange,
	decimals = 0,
	className,
	onFocus,
	onBlur,
	...props
}: NumberInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const display = groupInteger(draft ?? value);

	const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const raw = event.target.value;
		const caret = event.target.selectionStart ?? raw.length;
		const wanted = significantCount(raw.slice(0, caret));
		const clean = sanitize(raw, decimals);
		const formatted = groupInteger(clean);
		setDraft(clean);
		onValueChange(clean);
		requestAnimationFrame(() => {
			const position = caretForSignificant(formatted, wanted);
			inputRef.current?.setSelectionRange(position, position);
		});
	};

	return (
		<Input
			ref={inputRef}
			type="text"
			inputMode={decimals > 0 ? "decimal" : "numeric"}
			autoComplete="off"
			value={display}
			onChange={handleChange}
			onFocus={(event) => {
				setDraft(value);
				onFocus?.(event);
			}}
			onBlur={(event) => {
				setDraft(null);
				onBlur?.(event);
			}}
			className={cn("font-mono tabular-nums", className)}
			{...props}
		/>
	);
}
