"""Plots the README figures from the data written by make_figures.mjs.

    python docs/figures/plot_figures.py

Every panel is drawn from measured arrays; no value is typed in by hand. Figures are
written to docs/img/fig-*.png. The site palette is used for consistency with the demo.
"""
import json
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

D = Path("docs/figures/data")
OUT = Path("docs/img")
OUT.mkdir(parents=True, exist_ok=True)
R = json.loads((D / "record.json").read_text())
W, H = R["width"], R["height"]

BLUE, DEEP, LIGHT, AMBER, INK, MUTED, LINE = "#0798fe", "#0077d8", "#4e97e0", "#ff9e1b", "#0e0f0c", "#5c6a7e", "#e2e6ec"
GROUP_COLORS = [BLUE, LIGHT, DEEP, AMBER]
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": LINE, "axes.labelcolor": INK,
    "xtick.color": MUTED, "ytick.color": MUTED, "axes.titlecolor": INK, "axes.titleweight": "semibold",
    "figure.facecolor": "white", "axes.facecolor": "white", "savefig.dpi": 160,
})


def rgba(name):
    a = np.frombuffer((D / name).read_bytes(), dtype=np.uint8).reshape(H, W, 4)
    return a[..., :3]


def f64(name):
    return np.frombuffer((D / name).read_bytes(), dtype=np.float64).reshape(H, W)


def f32(name):
    return np.frombuffer((D / name).read_bytes(), dtype=np.float32).reshape(H, W)


def cr(rgb):
    rgb = rgb.astype(np.float64)
    y = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    return 0.713 * (rgb[..., 0] - y) + 128


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 10 * np.log10(255 ** 2 / mse)


def style(ax, title=None):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    if title:
        ax.set_title(title, loc="left", fontsize=10.5)


# ---------------------------------------------------------------- fig 1: payload framing
def fig_payload():
    p = R["payload"]
    n = p["messageBytes"]
    # Drawn widths use a floor so the 1- and 2-byte fields stay legible; the byte counts are printed.
    segs = [("flag\n1 B", 1, LINE, INK), ("len\n2 B", 2, LINE, INK), (f"message\n{n} bytes", n, LIGHT, "white"), ("Ed25519 signature\n64 bytes", 64, BLUE, "white"), ("RS parity\n30 bytes", 30, AMBER, INK)]
    widths = [max(w, 7) for _, w, _, _ in segs]
    total = sum(widths)
    fig, ax = plt.subplots(figsize=(11, 1.9))
    x = 0
    for (label, w, c, tc), dw in zip(segs, widths):
        ax.add_patch(FancyBboxPatch((x, 0.25), dw, 0.5, boxstyle="round,pad=0,rounding_size=0.3", fc=c, ec="white", lw=1.5))
        ax.text(x + dw / 2, 0.5, label, ha="center", va="center", fontsize=9, color=tc)
        x += dw
    ax.set_xlim(0, total)
    ax.set_ylim(0, 1)
    ax.axis("off")
    ax.set_title(f"One Reed-Solomon codeword: (1 + 2 + {n} + 64 + 30) bytes x 8 = {p['bitCount']} payload bits. RS corrects up to 15 symbol errors.", loc="left", fontsize=10)
    fig.tight_layout()
    fig.savefig(OUT / "fig-payload.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 2: layout in the spectrum
def fig_layout():
    L = json.loads((D / "layout.json").read_text())
    fig, ax = plt.subplots(figsize=(11, 3.4))
    ax.scatter(L["pool"]["kx"], L["pool"]["ky"], s=4, c=LINE, label=f"eligible pool: {R['layout']['poolSize']} bins, 0.05 to 0.12 of Nyquist")
    for g, grp in enumerate(L["groups"]):
        ax.scatter(grp["kx"], grp["ky"], s=11, c=GROUP_COLORS[g], label=f"group {g}: {len(grp['ky'])} bins")
    ax.set_xlabel("horizontal frequency index k_x")
    ax.set_ylabel("vertical frequency index k_y")
    ax.set_xlim(-W // 2 * 0.135, W // 2 * 0.135)
    ax.set_ylim(0, H // 2 * 0.135)
    ax.set_aspect("equal")
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0), fontsize=9, frameon=False, markerscale=2)
    style(ax, f"Public layout for nonce \"{R['layout']['nonce']}\": {R['payload']['bitCount']} bins in four groups")
    fig.tight_layout()
    fig.savefig(OUT / "fig-layout.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 3: carrier, residual, frames
def fig_embedding():
    src, mk, dec = rgba("frame0_source.rgba"), rgba("frame0_marked.rgba"), rgba("frame0_decoded_h264.rgba")
    plane = f32("carrier_plane_g0.f32")
    res_before = f64("residual0_before_codec.f64")
    res_after = f64("residual0_after_h264.f64")
    fig, axs = plt.subplots(2, 3, figsize=(13, 5.6))
    axs[0, 0].imshow(src); style(axs[0, 0], "Source frame 0")
    axs[0, 1].imshow(mk); style(axs[0, 1], f"Marked frame 0 (RGB PSNR {psnr(mk, src):.1f} dB)")
    axs[0, 2].imshow(dec); style(axs[0, 2], f"Decoded after H.264 CRF 23 (RGB PSNR {psnr(dec, src):.1f} dB)")
    fig.text(0.5, 0.005, "Bottom row: the carrier added to the Cr plane, and the measured difference to the source before and after the codec. The codec's own block noise appears in the right panel; the carrier survives it.", ha="center", fontsize=9, color=MUTED)
    v = np.percentile(np.abs(plane), 99.5)
    axs[1, 0].imshow(plane, cmap="RdBu_r", vmin=-v, vmax=v); style(axs[1, 0], f"Carrier plane of group 0: {R['layout']['binsPerGroup']} cosines, alpha = {R['embed']['alpha']:.3f}")
    v2 = np.percentile(np.abs(res_before), 99.5)
    axs[1, 1].imshow(res_before, cmap="RdBu_r", vmin=-v2, vmax=v2); style(axs[1, 1], f"Cr residual before codec (Cr PSNR {R['embed']['crPsnrBeforeCodec']:.1f} dB)")
    axs[1, 2].imshow(res_after, cmap="RdBu_r", vmin=-v2, vmax=v2); style(axs[1, 2], f"Cr residual after H.264 (Cr PSNR {psnr(cr(dec), cr(src)):.1f} dB)")
    for ax in axs.flat:
        ax.set_xticks([]); ax.set_yticks([])
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(OUT / "fig-embedding.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 4: spectra
def fig_spectra():
    L = json.loads((D / "layout.json").read_text())
    names = [("spectrum_source.f32", "Source"), ("spectrum_marked.f32", "Marked (before codec)"), ("spectrum_decoded_h264.f32", "Decoded after H.264 CRF 23")]
    fig, axs = plt.subplots(1, 3, figsize=(13, 3.6))
    crop = int(H / 2 * 0.14)
    for ax, (fn, title) in zip(axs, names):
        m = f32(fn)  # shifted, DC at (H/2, W/2), log10(1 + |F|)
        cy, cx = H // 2, W // 2
        sub = m[cy - crop:cy + crop, cx - 2 * crop:cx + 2 * crop]
        ax.imshow(sub, cmap="gray", extent=[-2 * crop, 2 * crop, crop, -crop], vmin=np.percentile(sub, 2), vmax=np.percentile(sub, 99.8))
        if title != "Source":
            for g, grp in enumerate(L["groups"]):
                ax.scatter(grp["kx"], np.negative(grp["ky"]), s=1.2, c=GROUP_COLORS[g], alpha=0.55)
        ax.set_xlim(-2 * crop, 2 * crop); ax.set_ylim(crop, -crop)
        ax.set_xticks([]); ax.set_yticks([])
        style(ax, f"{title}")
    fig.text(0.5, 0.01, "log |FFT(Cr)| of frame 0, centered on DC, low-frequency window only. Colored dots mark the layout bins (upper half-plane; the lower half is the conjugate mirror). The bright ring of carrier bins is absent from the source and survives H.264.", ha="center", fontsize=9, color=MUTED)
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(OUT / "fig-spectra.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 5: temporal group identification
def fig_groups():
    fig, axs = plt.subplots(2, 1, figsize=(11, 5.2), sharex=True)
    for ax, (fn, title) in zip(axs, [("scores_h264_crf23.json", "Marked video after H.264 CRF 23"), ("scores_unmarked.json", "Unmarked source (negative control)")]):
        S = np.array(json.loads((D / fn).read_text()))  # frames x 4
        for g in range(4):
            ax.plot(S[:, g], color=GROUP_COLORS[g], lw=1.6, label=f"group {g}")
        for b in range(30, 120, 30):
            ax.axvline(b, color=LINE, lw=1)
        ax.set_ylabel("score_g = sum Re^2 / sum Im^2")
        style(ax, title)
        if fn.startswith("scores_h"):
            ax.legend(ncol=4, frameon=False, fontsize=9, loc="upper right")
    axs[1].set_xlabel("frame index (the verifier never reads it; groups are recovered from the scores)")
    counts = R["codecs"]["h264_crf23"]["groupCounts"]
    fig.text(0.5, 0.005, f"Frames assigned per group after 30-frame mode smoothing: {counts}. On the unmarked source the four scores stay near 1 and carry no structure.", ha="center", fontsize=9, color=MUTED)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(OUT / "fig-groups.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 6: soft decisions and bit errors
def fig_bits():
    bits = np.frombuffer((D / "payload_bits.bin").read_bytes(), dtype=np.uint8)
    fig, axs = plt.subplots(3, 1, figsize=(11, 6.6), sharex=True)
    labels = {"h264_crf23": "H.264, CRF 23", "h264_crf28": "H.264, CRF 28", "vp9_crf33": "VP9, CRF 33"}
    for ax, name in zip(axs, ["h264_crf23", "h264_crf28", "vp9_crf33"]):
        s = np.frombuffer((D / f"softsums_{name}.f64").read_bytes(), dtype=np.float64)
        sign = np.where(bits == 1, 1.0, -1.0)
        margin = s * sign / np.median(np.abs(s))  # normalized: 1.0 = median magnitude
        colors = np.where(margin > 0, BLUE, "#c0392b")
        ax.bar(np.arange(len(s)), margin, width=1.0, color=colors, lw=0)
        ax.axhline(0, color=INK, lw=0.8)
        ax.set_ylim(-0.6, 2.4)
        c = R["codecs"][name]
        style(ax, f"{labels[name]}: {c['rawBitErrors']} raw bit error{'s' if c['rawBitErrors'] != 1 else ''} of {len(s)}, RS corrected {c['correctedSymbols']}, {'VERIFIED' if c['verified'] else 'NOT VERIFIED'} ({c['bytes'] / 1e6:.2f} MB, {c['framesDecoded']} frames)")
        ax.set_ylabel("normalized margin")
        err = np.where(margin <= 0)[0]
        for e in err:
            ax.annotate(f"bit {e}", (e, margin[e]), textcoords="offset points", xytext=(0, -12), ha="center", fontsize=8, color="#c0392b")
    axs[-1].set_xlabel("payload bit index")
    fig.text(0.5, 0.005, "Soft sum of each bit times its true sign, divided by the median magnitude. Bars above zero are correct before RS decoding; red bars are raw errors, all corrected by RS.", ha="center", fontsize=8.6, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(OUT / "fig-bits.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 7: strength ladder
def fig_ladder():
    L = R["ladder"]
    x = [l["psnrTarget"] for l in L]
    fig, ax1 = plt.subplots(figsize=(8.5, 4))
    ax1.plot(x, [l["rgbPsnrFrame0"] for l in L], "o-", color=BLUE, label="RGB PSNR of marked frame 0 (dB)")
    ax1.set_xlabel("Cr PSNR target of the carrier (dB); the closed-loop ladder in the demo tries 42, 40, 38, 36, 34, 32")
    ax1.set_ylabel("RGB PSNR (dB)", color=BLUE)
    ax1.invert_xaxis()
    ax2 = ax1.twinx()
    ax2.bar(x, [l["rawBitErrors"] for l in L], width=1.1, color=AMBER, alpha=0.8, label="raw bit errors after H.264 CRF 23")
    ax2.set_ylabel("raw bit errors before RS", color=AMBER)
    ax2.set_ylim(0, max(4, max(l["rawBitErrors"] for l in L) + 1))
    for l in L:
        ax1.annotate("verified" if l["verified"] else "not verified", (l["psnrTarget"], l["rgbPsnrFrame0"]), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=8, color=MUTED)
    for s in ("top",):
        ax1.spines[s].set_visible(False); ax2.spines[s].set_visible(False)
    ax1.set_title("Stronger carrier: lower PSNR, fewer raw errors. Every rung verifies on this clip; the ladder ships the first that does.", loc="left", fontsize=9.6)
    fig.legend(loc="upper right", bbox_to_anchor=(0.9, 0.88), frameon=False, fontsize=9)
    fig.tight_layout()
    fig.savefig(OUT / "fig-ladder.png")
    plt.close(fig)


# ---------------------------------------------------------------- fig 8: protocol diagram
def fig_protocol():
    fig, ax = plt.subplots(figsize=(12, 3.6))
    ax.axis("off"); ax.set_xlim(0, 12); ax.set_ylim(0, 3.6)

    def box(x, y, w, h, title, body, fc="white", ec=LINE, tc=INK):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.12", fc=fc, ec=ec, lw=1.4))
        ax.text(x + 0.15, y + h - 0.28, title, fontsize=10, fontweight="semibold", color=tc, va="top")
        ax.text(x + 0.15, y + h - 0.62, body, fontsize=8.6, color=tc if fc != "white" else MUTED, va="top", linespacing=1.35)

    def arrow(x0, y0, x1, y1, label=None):
        ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=14, color=INK, lw=1.2))
        if label:
            ax.text((x0 + x1) / 2, (y0 + y1) / 2 + 0.14, label, ha="center", fontsize=8.2, color=MUTED)

    box(0.2, 1.7, 2.6, 1.7, "Signer (private key)", "sign message\nframe payload + RS(30)\nbuild carriers from public layout\nadd to Cr of every frame", fc="#eaf5ff", ec=BLUE)
    box(3.4, 1.7, 2.3, 1.7, "Closed loop", "encode to a real file\ndecode it again\nrun the public verifier\nship the first strength that passes", fc="white", ec=LINE)
    box(6.3, 1.7, 2.3, 1.7, "Distribution", "the video file\n+ 32-byte public key\n+ public metadata\n(nonce, size, message length)", fc="white", ec=LINE)
    box(9.2, 1.7, 2.6, 1.7, "Verifier (public key only)", "FFT of Cr per frame\ngroup by correlation score\nwhiten, accumulate, hard decision\nRS decode, Ed25519 verify", fc="#eaf5ff", ec=BLUE)
    arrow(2.8, 2.55, 3.4, 2.55); arrow(5.7, 2.55, 6.3, 2.55); arrow(8.6, 2.55, 9.2, 2.55)
    ax.text(1.5, 1.25, "holds the private key\ncan sign", ha="center", fontsize=8.6, color=BLUE)
    ax.text(10.5, 1.25, "holds no secret\ncan verify, cannot forge", ha="center", fontsize=8.6, color=BLUE)
    ax.text(6.0, 0.55, "VERIFIED with the recovered message, or NOT VERIFIED with a reason. No model weights, no registry, no network, no shared secret.", ha="center", fontsize=9, color=INK)
    fig.tight_layout()
    fig.savefig(OUT / "fig-protocol.png")
    plt.close(fig)


for f in (fig_protocol, fig_payload, fig_layout, fig_embedding, fig_spectra, fig_groups, fig_bits, fig_ladder):
    f()
    print("wrote", f.__name__)
