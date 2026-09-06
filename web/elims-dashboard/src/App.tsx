import { Toaster } from "sonner";
import { AuthProvider } from "./contexts/AuthContext";
import { ElimsProvider } from "./contexts/ElimsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Router, RouterProvider } from "./router";

export function App() {
	return (
		<ThemeProvider defaultTheme="dark">
			<AuthProvider>
				<ElimsProvider>
					<RouterProvider>
						<Router />
						<Toaster position="bottom-right" richColors />
					</RouterProvider>
				</ElimsProvider>
			</AuthProvider>
		</ThemeProvider>
	);
}
