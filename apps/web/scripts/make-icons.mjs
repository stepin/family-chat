// Makes every app icon from docs/design/icon.png. Run by hand when the
// source changes: node apps/web/scripts/make-icons.mjs. The outputs in
// apps/web/public/ are committed, so neither the build nor CI needs ImageMagick.
//
// - icon.svg: the icon redrawn as a vector (one attempt). Accepted when its
//   render by ImageMagick's own SVG renderer (MSVG) at 192 px differs from the
//   source at 192 px by a normalized RMSE of at most 0.05; otherwise icon.svg
//   embeds the source as a 256 px PNG. MSVG draws differently from browsers, so
//   RMSE is the script's metric; look at the result in a browser too.
// - icon-192.png, icon-512.png, apple-touch-icon.png (180): the source scaled down.
// - favicon-32.png: from the vector (flat background, no noise) when accepted.
// - badge-96.png: the notification badge, a white silhouette of the bubble with
//   the keyhole cut out, on transparency (Android draws badges by alpha).
// - icon-maskable-512.png: only when a corner of the bubble's bounding box lies
//   outside the circle of radius 0.38 W around the centre (the safe zone is
//   0.4 W): the bubble is scaled to fit that circle.
//
// Needs ImageMagick 7 (`magick` with the MSVG coder).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(repo, 'docs/design/icon.png');
const OUT = join(repo, 'apps/web/public');
const RMSE_LIMIT = 0.05;
const SAFE_RADIUS = 0.38;

/** Measured from the source (1254 × 1254). */
const SIZE = 1254;
const BG = '#1e4e41';
const FG = '#f4efe4';

function magick(args, opts = {}) {
  return execFileSync('magick', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function requireMagick() {
  try {
    const v = magick(['-version']);
    const formats = magick(['-list', 'format']);
    if (!/ImageMagick 7\./.test(v) || !/\bMSVG\b/.test(formats)) throw new Error('old');
  } catch {
    console.error('Нужен ImageMagick 7: brew install imagemagick / apt install imagemagick (ImageMagick 7 is needed)');
    process.exit(1);
  }
}

// ---- the vector ----

/** A superellipse-like bubble (four cubic curves), its tail, and the keyhole. */
function bubblePath() {
  const cx = 626.5;
  const cy = 625.5;
  const rx = 372.5;
  const ry = 326.5;
  // 0.5523 is a circle; a little more makes the slightly squarer bubble of the source.
  const k = 0.585;
  const ox = rx * k;
  const oy = ry * k;
  const f = (n) => n.toFixed(1);
  return [
    `M${f(cx - rx)} ${f(cy)}`,
    `C${f(cx - rx)} ${f(cy - oy)} ${f(cx - ox)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}`,
    `C${f(cx + ox)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - oy)} ${f(cx + rx)} ${f(cy)}`,
    `C${f(cx + rx)} ${f(cy + oy)} ${f(cx + ox)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}`,
    `C${f(cx - ox)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + oy)} ${f(cx - rx)} ${f(cy)}Z`,
  ].join('');
}

const TAIL = 'M342 812C330 862 312 902 294 931C278 956 296 984 323 977C370 965 412 944 458 912L540 880L380 760Z';
const KEYHOLE_CIRCLE = { cx: 626, cy: 559, r: 92 };
const KEYHOLE_STEM = 'M574 628L538 738Q527 773 562 773L692 773Q727 773 716 738L679 628Z';

function vectorSvg({ background = true, scale = 1 } = {}) {
  const t = scale === 1 ? '' : ` transform="translate(${(SIZE / 2) * (1 - scale)} ${(SIZE / 2) * (1 - scale)}) scale(${scale})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
${background ? `<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>\n` : ''}<g${t}>
<path fill="${FG}" d="${bubblePath()}"/>
<path fill="${FG}" d="${TAIL}"/>
<circle fill="${BG}" cx="${KEYHOLE_CIRCLE.cx}" cy="${KEYHOLE_CIRCLE.cy}" r="${KEYHOLE_CIRCLE.r}"/>
<path fill="${BG}" d="${KEYHOLE_STEM}"/>
</g>
</svg>
`;
}

/** Normalized RMSE between two images (the number in brackets of `magick compare`). */
function rmse(a, b) {
  let out = '';
  try {
    out = execFileSync('magick', ['compare', '-metric', 'RMSE', a, b, 'null:'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // compare exits 1 when the images differ; the metric is on stderr.
    out = String(e.stderr ?? '');
  }
  const m = /\(([\d.e-]+)\)/.exec(out);
  if (!m) throw new Error(`could not read RMSE from: ${out}`);
  return Number(m[1]);
}

function main() {
  requireMagick();
  const tmp = mkdtempSync(join(tmpdir(), 'fc-icons-'));
  try {
    // Vector, one attempt.
    const svg = vectorSvg();
    const svgFile = join(tmp, 'icon.svg');
    writeFileSync(svgFile, svg);
    magick(['-background', 'none', `MSVG:${svgFile}`, '-resize', '192x192', join(tmp, 'vector-192.png')]);
    magick([SRC, '-resize', '192x192', join(tmp, 'source-192.png')]);
    const score = rmse(join(tmp, 'vector-192.png'), join(tmp, 'source-192.png'));
    const vector = score <= RMSE_LIMIT;
    console.log(`icon.svg: RMSE ${score.toFixed(4)} (limit ${RMSE_LIMIT}): ${vector ? 'vector' : 'embedded PNG'}`);
    if (vector) {
      writeFileSync(join(OUT, 'icon.svg'), svg);
    } else {
      const png = magick([SRC, '-resize', '256x256', '-strip', 'PNG:-'], { encoding: 'buffer' });
      writeFileSync(
        join(OUT, 'icon.svg'),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><image width="256" height="256" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>\n`,
      );
    }

    // Raster sizes from the source.
    for (const [name, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['apple-touch-icon.png', 180],
    ]) {
      magick([SRC, '-resize', `${size}x${size}`, '-strip', join(OUT, name)]);
    }
    // Small favicon: the vector's flat background is crisper than the noisy source.
    magick(vector ? ['-background', 'none', `MSVG:${svgFile}`, '-resize', '32x32', '-strip', join(OUT, 'favicon-32.png')] : [SRC, '-resize', '32x32', '-strip', join(OUT, 'favicon-32.png')]);

    // Badge: the light shape as alpha, painted white.
    magick([
      SRC,
      '-resize',
      '96x96',
      '-colorspace',
      'Gray',
      '-level',
      '35%,85%',
      '(',
      '+clone',
      '-fill',
      'white',
      '-colorize',
      '100',
      ')',
      '+swap',
      '-compose',
      'CopyOpacity',
      '-composite',
      '-strip',
      `PNG32:${join(OUT, 'badge-96.png')}`,
    ]);
    console.log('badge-96.png: white bubble with the keyhole cut out, on transparency');

    // Maskable: the bubble's bounding box against the 0.38 W circle.
    const box = magick([SRC, '-colorspace', 'Gray', '-threshold', '60%', '-format', '%@', 'info:']).trim();
    const [, w, h, x, y] = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(box).map(Number);
    const c = SIZE / 2;
    const radius = SAFE_RADIUS * SIZE;
    const corners = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ].map(([px, py]) => Math.hypot(px - c, py - c));
    const far = Math.max(...corners);
    console.log(
      `maskable: bubble box ${box}; corner distances ${corners.map((d) => d.toFixed(0)).join(', ')} vs radius ${radius.toFixed(0)} (0.38 W)`,
    );
    if (far > radius) {
      const scale = radius / far;
      const file = join(OUT, 'icon-maskable-512.png');
      if (vector) {
        const scaled = join(tmp, 'maskable.svg');
        writeFileSync(scaled, vectorSvg({ scale }));
        magick(['-background', 'none', `MSVG:${scaled}`, '-resize', '512x512', '-strip', file]);
      } else {
        const inner = Math.round(512 * scale);
        magick(['-size', '512x512', `xc:${BG}`, '(', SRC, '-resize', `${inner}x${inner}`, ')', '-gravity', 'center', '-composite', '-strip', file]);
      }
      console.log(`maskable: icon-maskable-512.png, bubble scaled by ${scale.toFixed(3)}`);
    } else {
      console.log('maskable: icon-512.png already fits');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
