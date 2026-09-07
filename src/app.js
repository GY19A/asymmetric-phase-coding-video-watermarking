// Page entry. Mounts the demo in light DOM. The widget (src/widget.js) mounts
// the same application inside a shadow root.
import "./style.css";
import { mountApp } from "./app/ui.js";

const root = document.getElementById("app");
const app = mountApp(root, { paperHref: "https://arxiv.org/abs/2608.29212" });

// Exposed for browser tests and the console. Not a public API.
window.apcvwDemo = app;
