// Code pane text. Function names come from the core exports that actually
// resolved at runtime, so the pane matches the implementation in use.
import { CANONICAL } from "./validation.js";

function fn(names, role) {
  return names?.[role] ?? null;
}

function importLine(names, roles, sdkSrc) {
  const present = roles.map((r) => fn(names, r)).filter(Boolean);
  const missing = roles.filter((r) => !fn(names, r));
  const lines = [];
  if (present.length) lines.push(`import { ${present.join(", ")} } from "${sdkSrc}";`);
  for (const m of missing) lines.push(`// ${m}() is not exported by this core build.`);
  return lines.join("\n");
}

export function sdkImportLine(names, sdkSrc) {
  const all = Object.values(names ?? {}).filter(Boolean);
  return all.length ? `import { ${all.join(", ")} } from "${sdkSrc}";` : `// The core library did not load.`;
}

export function embedSnippet(widgetSrc) {
  return `<script type="module" src="${widgetSrc}"></script>\n<apcvw-demo></apcvw-demo>`;
}

/**
 * @param {number} step 1..5
 * @param {object} ctx names, sdkSrc, publicKeyHex, message, nonce, bitCount, psnr, runLength, groups
 */
export function codeForStep(step, ctx) {
  const n = ctx.names;
  const W = CANONICAL.width;
  const H = CANONICAL.height;
  const msg = JSON.stringify(ctx.message ?? "");
  const nonce = JSON.stringify(ctx.nonce ?? "");
  const bits = ctx.bitCount ?? "payload.bits.length";
  const psnr = ctx.psnr ?? 42;
  const K = ctx.runLength ?? 30;
  const G = ctx.groups ?? 4;
  switch (step) {
    case 1:
      return [
        importLine(n, ["generateIdentity"], ctx.sdkSrc),
        "",
        `const identity = await ${fn(n, "generateIdentity") ?? "generateIdentity"}();`,
        `// identity.publicKey  : 32 bytes${ctx.publicKeyHex ? `, here ${ctx.publicKeyHex.slice(0, 16)}...` : ""}`,
        "// identity.privateKey : 32-byte Ed25519 seed. Random, never stored, never sent.",
      ].join("\n");
    case 2:
      return [
        "// Browser side. Not part of the core library.",
        `// Decode with a native video element, letterbox into ${W}x${H}, read RGBA.`,
        'const video = document.createElement("video");',
        "video.muted = true; video.src = objectUrl;",
        'await new Promise((ok, err) => { video.onloadedmetadata = ok; video.onerror = err; });',
        `const canvas = Object.assign(document.createElement("canvas"), { width: ${W}, height: ${H} });`,
        'const ctx = canvas.getContext("2d", { willReadFrequently: true });',
        "// for each presented frame inside the 4 s excerpt (requestVideoFrameCallback):",
        `ctx.fillRect(0, 0, ${W}, ${H}); ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);`,
        `const rgba = ctx.getImageData(0, 0, ${W}, ${H}).data;   // one of 120 samples at 30 fps`,
      ].join("\n");
    case 3:
      return [
        importLine(n, ["createPayload", "createLayout", "createCarriers", "embedFrame"], ctx.sdkSrc),
        "",
        `const payload = await ${fn(n, "createPayload") ?? "createPayload"}(${msg}, identity.privateKey);`,
        `// payload.bits: ${bits} bits = (1 flag + 2 length + message + 64 signature + 30 RS parity) * 8`,
        `const layout = await ${fn(n, "createLayout") ?? "createLayout"}({ width: ${W}, height: ${H}, nonce: ${nonce}, bitCount: payload.bits.length });`,
        `const carriers = await ${fn(n, "createCarriers") ?? "createCarriers"}(layout, payload.bits, ${psnr});   // four Cr planes, PSNR target in dB`,
        "",
        "// Signer side: frame i carries group floor(i / K) mod G. Only Cr changes.",
        `const group = Math.floor(i / ${K}) % ${G};`,
        `const markedRgba = ${fn(n, "embedFrame") ?? "embedFrame"}(rgba, ${W}, ${H}, carriers.planes[group]);`,
        "// Then draw markedRgba to a canvas that feeds MediaRecorder (canvas.captureStream).",
      ].join("\n");
    case 4:
      return [
        importLine(n, ["createLayout", "extractFrameEvidence", "verifyEvidence"], ctx.sdkSrc),
        "",
        "// Verifier side: public metadata and public key only. No message, no private key.",
        `const layout = await ${fn(n, "createLayout") ?? "createLayout"}({ width: ${W}, height: ${H}, nonce: metadata.nonce, bitCount: metadata.bitCount });`,
        "const rows = [];",
        "// for each frame decoded from the produced file (a new video element):",
        `rows.push(${fn(n, "extractFrameEvidence") ?? "extractFrameEvidence"}(rgba, ${W}, ${H}, layout));`,
        `const result = await ${fn(n, "verifyEvidence") ?? "verifyEvidence"}(rows, layout, publicKey);`,
        "// result.verified, result.reason, result.messageBytes, result.signature (64 bytes),",
        "// result.correctedSymbols, result.groupCounts",
      ].join("\n");
    case 5:
      return [
        importLine(n, ["spectrumPreview"], ctx.sdkSrc),
        "",
        "// Log-power Cr spectrum of one frame, DC centered, for display only.",
        `const spectrum = ${fn(n, "spectrumPreview") ?? "spectrumPreview"}(rgba, ${W}, ${H}, { channel: "Cr", log: true, center: true });`,
        "// Residual shown in the inspector: (marked - source) * gain + 128 per channel.",
      ].join("\n");
    default:
      return "";
  }
}
