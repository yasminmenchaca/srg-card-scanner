// detector.js — notices when a NEW physical card has settled under the camera.
//
// Why not compare names? You often feed 3 copies of one card in a row, and
// they look identical. What differs is that the picture MOVES between
// them. So we watch for motion, then wait for stillness:
//
//   ready ──(still for stableMs)──▶ fire onCard() ──▶ waitMotion
//   waitMotion ──(big change)──▶ moving ──(still for stableMs)──▶ fire onCard()
//
// "Change" = average difference per pixel between two tiny 64×48 grayscale
// thumbnails of the frame, taken ~10 times a second. Tiny thumbnails are
// cheap and ignore camera noise.

const W = 64;
const H = 48;

export class CardDetector {
  constructor(video, { onCard, onLevel }) {
    this.video = video;
    this.onCard = onCard;     // called when a card has settled
    this.onLevel = onLevel;   // called every tick with { diff, state } (for the meter)
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.state = 'ready';     // read the card already sitting there on start
    this.stillSince = null;
    this.timer = null;
    this.paused = false;
    this.opts = { motion: 12, still: 4, stableMs: 350 };
  }

  setOptions(o) { Object.assign(this.opts, o); }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Call after a read (or a skip) so the next card needs motion first. */
  armForNext() {
    this.state = 'waitMotion';
    this.stillSince = null;
  }

  /** Treat whatever is under the camera now as a new card. */
  readNow() {
    this.state = 'ready';
    this.stillSince = null;
  }

  tick() {
    if (this.paused || this.video.readyState < 2) return;
    this.ctx.drawImage(this.video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const cur = new Uint8Array(W * H);
    for (let i = 0; i < cur.length; i++) {
      cur[i] = (px[i * 4] + px[i * 4 + 1] * 2 + px[i * 4 + 2]) >> 2;
    }

    let diff = 0;
    if (this.prev) {
      let total = 0;
      for (let i = 0; i < cur.length; i++) total += Math.abs(cur[i] - this.prev[i]);
      diff = total / cur.length;
    }
    this.prev = cur;

    const { motion, still, stableMs } = this.opts;
    const now = performance.now();

    if (diff > motion) {
      this.stillSince = null;
      if (this.state === 'waitMotion') this.state = 'moving';
    } else if (diff < still) {
      if (this.state === 'moving' || this.state === 'ready') {
        this.stillSince ??= now;
        if (now - this.stillSince >= stableMs) {
          this.state = 'waitMotion';
          this.stillSince = null;
          this.onCard();
        }
      }
    } else {
      this.stillSince = null; // in-between: small wobble, keep waiting
    }

    this.onLevel?.({ diff, state: this.state });
  }
}
