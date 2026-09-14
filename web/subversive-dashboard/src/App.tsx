import { Toaster } from "sonner";
import { ThemeProvider } from "./components/theme-provider";
import { AuthProvider } from "./contexts/AuthContext";
import { SubversiveProvider } from "./contexts/SubversiveContext";
import { Router, RouterProvider } from "./router";

export default function App() {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			disableTransitionOnChange
		>
			<AuthProvider>
				<SubversiveProvider>
					<RouterProvider>
						<Router />
						<Toaster richColors position="top-right" />
					</RouterProvider>
				</SubversiveProvider>
			</AuthProvider>
		</ThemeProvider>
	);
}
