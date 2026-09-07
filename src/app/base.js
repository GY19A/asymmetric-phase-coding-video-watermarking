// Base path of the deployed application. Vite injects import.meta.env.BASE_URL at
// build time ("/" by default, or the value of `base` in vite.config.js). In Node,
// import.meta.env is undefined and the base is "/".
const raw = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/";
export const BASE_URL = raw.endsWith("/") ? raw : `${raw}/`;

/** Prefix an app-relative path ("/media/x.mp4" or "media/x.mp4") with the deployed base. */
export function withBase(path) {
  return BASE_URL + String(path).replace(/^\/+/, "");
}
