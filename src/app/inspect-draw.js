// Canvas drawing for the inspector. Every pixel drawn here comes from data
// computed on actual planes. Overlays are geometric annotations of the layout.

const GROUP_COLORS = ["#0798fe", "#8acdff", "#4e97e0", "#ff9e1b"];

export function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function putImage(canvas, imageData) {
  if (canvas.width !== imageData.width) canvas.width = imageData.width;
  if (canvas.height !== imageData.height) canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
}

/** Quadrant swap so the DC bin sits at the image center. */
export function centerImageData(img) {
  const { width: W, height: H, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const hw = W >> 1;
  const hh = H >> 1;
  for (let y = 0; y < H; y++) {
    const sy = (y + hh) % H;
    for (let x = 0; x < W; x++) {
      const sx = (x + hw) % W;
      const si = (sy * W + sx) * 4;
      const di = (y * W + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return new ImageData(out, W, H);
}

/**
 * Draw a spectrum image, the carrier band as two ellipses, and optionally the
 * actual carrier bins of each group (with their conjugate partners).
 */
export function drawSpectrum(canvas, spectrum, { band, bins, showBins = true } = {}) {
  if (!spectrum?.image) {
    clearCanvas(canvas);
    return;
  }
  const img = spectrum.centered === false ? centerImageData(spectrum.image) : spectrum.image;
  putImage(canvas, img);
  const ctx = canvas.getContext("2d");
  const W = img.width;
  const H = img.height;
  const cx = W / 2;
  const cy = H / 2;
  if (band) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(7, 152, 254, 0.9)";
    ctx.setLineDash([4, 3]);
    for (const r of [band.lo, band.hi]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * (W / 2), r * (H / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (showBins && Array.isArray(bins)) {
    ctx.save();
    bins.forEach((flat, g) => {
      if (!flat) return;
      ctx.fillStyle = GROUP_COLORS[g % GROUP_COLORS.length];
      for (let i = 0; i < flat.length; i += 2) {
        const ky = flat[i];
        const kx = flat[i + 1];
        ctx.fillRect(cx + kx, cy + ky, 1, 1);
        ctx.fillRect(cx - kx - 1, cy - ky - 1, 1, 1);
      }
    });
    ctx.restore();
  }
}

export function drawResidual(canvas, residual) {
  if (!residual?.image) {
    clearCanvas(canvas);
    return;
  }
  putImage(canvas, residual.image);
}

/** One column per decoded frame, colored by the group the verifier assigned from correlation energy. */
export function drawGroupTimeline(canvas, frameGroups, groups = 4) {
  const n = frameGroups?.length ?? 0;
  const W = Math.max(120, n);
  const H = 28;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1a1d20";
  ctx.fillRect(0, 0, W, H);
  if (!n) return { counts: [] };
  const counts = new Array(groups).fill(0);
  const colW = W / n;
  for (let i = 0; i < n; i++) {
    const g = frameGroups[i];
    if (Number.isInteger(g) && g >= 0) {
      counts[g % groups]++;
      ctx.fillStyle = GROUP_COLORS[g % GROUP_COLORS.length];
      ctx.fillRect(Math.floor(i * colW), 4, Math.max(1, Math.ceil(colW)), H - 8);
    }
  }
  return { counts };
}

export { GROUP_COLORS };
