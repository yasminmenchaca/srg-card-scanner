// camera.js — starts the rear camera and cuts out the name region.
//
// Boxes are stored as fractions of the image (x, y, w, h all 0–1), so a
// box drawn on a 400 px-wide preview still fits a 1920 px camera frame.

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera needs HTTPS (or localhost) and a modern browser.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' }, // rear camera
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', ''); // iPhone: don't go full screen
  video.muted = true;
  await video.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Natural pixel size of a <video>, <img> or <canvas>. */
export function sourceSize(src) {
  return {
    w: src.videoWidth || src.naturalWidth || src.width,
    h: src.videoHeight || src.naturalHeight || src.height,
  };
}

/**
 * Crop `box` out of `src` and prepare it for OCR:
 *   1. upscale so the text is ~100+ px tall (Tesseract likes big letters)
 *   2. grayscale
 *   3. stretch contrast (darkest 2% → black, brightest 2% → white)
 *   4. flip to dark-text-on-light if the crop is mostly dark
 *   5. optional black/white threshold (Otsu's method)
 * Returns a canvas.
 */
export function cropForOcr(src, box, { threshold = false, invert: invertOpt = 'auto', plain = false } = {}) {
  const { w: sw, h: sh } = sourceSize(src);
  const sx = Math.round(box.x * sw);
  const sy = Math.round(box.y * sh);
  const cw = Math.max(1, Math.round(box.w * sw));
  const ch = Math.max(1, Math.round(box.h * sh));

  const scale = Math.min(4, Math.max(1, 120 / ch));
  const out = document.createElement('canvas');
  out.width = Math.round(cw * scale);
  out.height = Math.round(ch * scale);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, cw, ch, 0, 0, out.width, out.height);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const px = img.data;
  const n = px.length / 4;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
    gray[i] = g;
    hist[gray[i]]++;
    sum += g;
  }

  // plain: stop at grayscale + upscale. Tesseract handles white-on-art
  // text (like SRG's outlined names) better without our contrast tricks.
  if (plain) {
    for (let i = 0; i < n; i++) {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = gray[i];
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  // Contrast stretch using the 2nd and 98th percentile.
  const lo = percentile(hist, n, 0.02);
  const hi = Math.max(lo + 1, percentile(hist, n, 0.98));
  // invertOpt: true / false, or 'auto' = flip if the crop is mostly dark.
  const invert = invertOpt === 'auto' ? sum / n < 110 : invertOpt;

  for (let i = 0; i < n; i++) {
    let v = ((gray[i] - lo) * 255) / (hi - lo);
    if (invert) v = 255 - v;
    gray[i] = v;
  }

  if (threshold) {
    const t = otsu(gray);
    for (let i = 0; i < n; i++) gray[i] = gray[i] > t ? 255 : 0;
  }

  for (let i = 0; i < n; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = gray[i];
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function percentile(hist, n, p) {
  const target = n * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/** Otsu: pick the gray level that best splits pixels into two groups. */
function otsu(gray) {
  const hist = new Uint32Array(256);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}
