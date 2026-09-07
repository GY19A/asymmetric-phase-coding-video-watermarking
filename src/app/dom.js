// Small DOM helpers. No framework.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "testid") el.dataset.testid = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function text(el, value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (el.textContent !== s) el.textContent = s;
}

export function show(el, visible) {
  if (!el) return;
  if (visible) el.removeAttribute("hidden");
  else el.setAttribute("hidden", "");
}

export function setDisabled(el, disabled) {
  if (!el) return;
  if (disabled) el.setAttribute("disabled", "");
  else el.removeAttribute("disabled");
}

export function setClass(el, name, on) {
  if (!el) return;
  el.classList.toggle(name, !!on);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Copy text to the clipboard. Falls back to execCommand on plain HTTP origins. */
export async function copyText(value) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

export function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
