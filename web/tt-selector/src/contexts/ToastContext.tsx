import { createContext, type ReactNode, useContext } from "react";
import { toast as sonnerToast, Toaster } from "sonner";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastContextValue {
	toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({
	toast: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
	const triggerToast = (message: string, type: ToastType = "info") => {
		switch (type) {
			case "success":
				sonnerToast.success(message);
				break;
			case "error":
				sonnerToast.error(message);
				break;
			case "warning":
				sonnerToast.warning(message);
				break;
			default:
				sonnerToast(message);
				break;
		}
	};

	return (
		<ToastContext.Provider value={{ toast: triggerToast }}>
			{children}
			<Toaster
				theme="dark"
				position="bottom-right"
				richColors
				toastOptions={{
					style: {
						background: "#0d1117",
						border: "1px solid #21262d",
						color: "#f4f4f5",
						fontFamily: "Space Grotesk, sans-serif",
					},
				}}
			/>
		</ToastContext.Provider>
	);
}

export function useToast() {
	return useContext(ToastContext);
}
