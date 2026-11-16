// boxEditor.js — a draggable, resizable rectangle laid over an image/video.
//
// `layer` must be an element positioned exactly on top of the media
// (same size). The box is kept in fractions (0–1) of that layer.
// Drag the middle to move it; drag the bottom-right corner to resize.
// Pointer events cover mouse, touch and pen with one code path.

export function createBox(layer, { label, color = '#ffd400', onChange } = {}) {
  const el = document.createElement('div');
  el.className = 'roi';
  el.style.borderColor = color;
  el.innerHTML = `<span class="roi-label" style="background:${color}">${label || ''}</span><div class="roi-handle" style="background:${color}"></div>`;
  layer.appendChild(el);

  let box = { x: 0.1, y: 0.1, w: 0.5, h: 0.1 };
  let editable = false;

  function render() {
    el.style.left = box.x * 100 + '%';
    el.style.top = box.y * 100 + '%';
    el.style.width = box.w * 100 + '%';
    el.style.height = box.h * 100 + '%';
  }

  let drag = null;
  el.addEventListener('pointerdown', (ev) => {
    if (!editable) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    const r = layer.getBoundingClientRect();
    drag = {
      mode: ev.target.classList.contains('roi-handle') ? 'resize' : 'move',
      startX: ev.clientX, startY: ev.clientY,
      rw: r.width, rh: r.height,
      orig: { ...box },
    };
  });
  el.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = (ev.clientX - drag.startX) / drag.rw;
    const dy = (ev.clientY - drag.startY) / drag.rh;
    const o = drag.orig;
    if (drag.mode === 'move') {
      box.x = clamp(o.x + dx, 0, 1 - o.w);
      box.y = clamp(o.y + dy, 0, 1 - o.h);
    } else {
      box.w = clamp(o.w + dx, 0.03, 1 - o.x);
      box.h = clamp(o.h + dy, 0.02, 1 - o.y);
    }
    render();
  });
  const end = () => {
    if (drag) onChange?.({ ...box });
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  render();
  return {
    get: () => ({ ...box }),
    set(b) { box = { ...b }; render(); },
    setEditable(v) { editable = v; el.classList.toggle('editable', v); },
    show(v) { el.hidden = !v; },
    flash(cls) {
      el.classList.remove('ok', 'ask');
      void el.offsetWidth; // restart the CSS animation
      el.classList.add(cls);
    },
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
