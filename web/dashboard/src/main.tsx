import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initTheme } from "./hooks/useTheme";

// Re-assert the persisted theme on the <html> element as soon as the bundle
// executes. index.html already does this before first paint; this keeps the
// store and the DOM in agreement if that inline script was stripped.
initTheme();

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root element #root not found in document");
}

const root = createRoot(container);
root.render(<App />);
