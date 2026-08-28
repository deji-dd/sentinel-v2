import { AuthProvider } from "./contexts/AuthContext";
import { ToastProvider } from "./contexts/ToastContext";
import { Router, RouterProvider } from "./router";

export function App() {
	return (
		<AuthProvider>
			<ToastProvider>
				<RouterProvider>
					<Router />
				</RouterProvider>
			</ToastProvider>
		</AuthProvider>
	);
}
