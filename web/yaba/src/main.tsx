import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App";
import { initTheme } from "./hooks/useTheme";

initTheme();

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root element #root not found in document");
}

createRoot(container).render(<App />);
