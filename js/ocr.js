// ocr.js — wraps Tesseract.js.
//
// Tesseract.js already runs recognition inside its own Web Worker, so the
// video keeps playing while a card is read. We create the worker once
// (it downloads ~10 MB of English data the first time, then the browser
// caches it) and push every request through a queue so two reads never
// overlap.
//
// Tesseract is loaded by a <script> tag in index.html (global `Tesseract`).

let worker = null;
let queue = Promise.resolve();

// Characters that appear in SRG card names. Limiting the alphabet stops
// Tesseract from "seeing" things like ¢ or §.
const NAME_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ?!*'-.,&():\"/#";
const NUMBER_CHARS = '#0123456789';

export async function initOcr(onProgress) {
  if (worker) return;
  worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => onProgress?.(m),
  });
}

/**
 * Read one line of text from a canvas.
 * kind: "name" or "number" (changes the allowed characters).
 * Returns { text, confidence } (confidence 0–100 from Tesseract).
 */
export function readLine(canvas, kind = 'name') {
  const job = queue.then(async () => {
    await worker.setParameters({
      tessedit_pageseg_mode: '7', // treat the image as a single line of text
      tessedit_char_whitelist: kind === 'number' ? NUMBER_CHARS : NAME_CHARS,
      preserve_interword_spaces: '1',
    });
    const { data } = await worker.recognize(canvas);
    return { text: data.text.replace(/\s+/g, ' ').trim(), confidence: data.confidence };
  });
  queue = job.catch(() => {}); // keep the queue alive after an error
  return job;
}
