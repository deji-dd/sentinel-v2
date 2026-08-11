import { AuthProvider } from "./contexts/AuthContext";
import { ToastProvider } from "./contexts/ToastContext";
import { Router, RouterProvider } from "./router";

export function App() {
	return (
		<RouterProvider>
			<AuthProvider>
				<ToastProvider>
					<Router />
				</ToastProvider>
			</AuthProvider>
		</RouterProvider>
	);
}
