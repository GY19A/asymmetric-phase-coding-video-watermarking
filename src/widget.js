// Reusable custom element. One line of HTML after loading this bundle:
//   <script type="module" src="/apcvw-widget.js"></script>
//   <apcvw-demo></apcvw-demo>
// The demo mounts inside an open shadow root with its own stylesheet, so the
// host page's CSS and the demo's CSS do not collide. Same-origin hosting is
// required because the numerical worker is loaded relative to this bundle.
import styles from "./style.css?inline";
import { mountApp } from "./app/ui.js";

export class ApcvwDemoElement extends HTMLElement {
  static get observedAttributes() {
    return ["paper-href"];
  }

  connectedCallback() {
    if (this._app) return;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = styles;
    const host = document.createElement("div");
    shadow.append(style, host);
    this._app = mountApp(host, { paperHref: this.getAttribute("paper-href") ?? "https://arxiv.org/abs/2608.29212" });
  }

  disconnectedCallback() {
    this._app?.destroy();
    this._app = null;
  }

  /** The mounted application: getState(), pipeline, capabilities, destroy(). */
  get app() {
    return this._app ?? null;
  }

  /** The core library namespace once it has loaded, otherwise null. */
  get sdk() {
    return this._app?.sdk ?? null;
  }

  get state() {
    return this._app?.getState() ?? null;
  }
}

if (!customElements.get("apcvw-demo")) {
  customElements.define("apcvw-demo", ApcvwDemoElement);
}
