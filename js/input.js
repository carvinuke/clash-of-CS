/*
 * Mouse, touch and keyboard input. Drag pans the camera, the wheel or a pinch zooms, a tap
 * selects or places. In raids a tap deploys one troop and holding deploys a steady stream.
 */
(function (CS) {
  'use strict';
  const R = CS.Render;
  const I = {};
  const DRAG = 6, HOLD_MS = 220, STREAM_MS = 110, PAN_SPEED = 700;
  let G = null, cv = null;
  const pointers = new Map();
  const keys = {};
  let down = null, pinch = null, lastKeyFrame = 0;

  function tileAt(x, y) { return R.toTile(x, y); }

  function onGhost(p, t) { return t[0] >= p.x && t[0] < p.x + p.w && t[1] >= p.y && t[1] < p.y + p.h; }

  function startPinch() {
    const pts = Array.from(pointers.values());
    pinch = {
      d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2
    };
    if (down && G.place && down.mode === 'line') G.place.line = null;
    down = null;
  }

  function onDown(e) {
    if (G.paused) return;
    CS.Audio.unlock();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
    const touch = e.pointerType !== 'mouse';
    const t = tileAt(e.clientX, e.clientY);
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, touch: touch, mode: 'pan', at: performance.now() };
    if (e.button === 1 || e.button === 2) return;
    if (G.mode === 'raid') { down.mode = 'raid'; return; }
    const p = G.place;
    if (p) {
      if (p.type === 'wall' && !p.moveId && (!touch || onGhost(p, t))) {
        down.mode = 'line';
        down.start = touch ? { x: p.x, y: p.y } : { x: Math.floor(t[0]), y: Math.floor(t[1]) };
      } else if (!touch || onGhost(p, t)) {
        down.mode = 'ghost';
        down.gx = touch ? t[0] - (p.x + p.w / 2) : 0;
        down.gy = touch ? t[1] - (p.y + p.h / 2) : 0;
        down.drop = !!p.moveId && G.edit;
      }
      return;
    }
    if (G.edit && G.mode === 'village') {
      const id = G.pickAt(e.clientX, e.clientY);
      if (id && G.startMove(id)) {
        const q = G.place;
        down.mode = 'ghost';
        down.gx = t[0] - (q.x + q.w / 2);
        down.gy = t[1] - (q.y + q.h / 2);
        down.drop = true;
      }
    }
  }

  function onMove(e) {
    const pt = pointers.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    if (pinch && pointers.size >= 2) {
      const pts = Array.from(pointers.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      R.pan(mx - pinch.mx, my - pinch.my);
      R.zoomAt(d / pinch.d, mx, my);
      pinch.d = d; pinch.mx = mx; pinch.my = my;
      return;
    }
    I.mouse = { x: e.clientX, y: e.clientY };
    G.pointer = e.target === cv && e.pointerType === 'mouse' ? I.mouse : null;
    if (!down) { hover(e); return; }
    if (e.pointerId !== down.id) return;
    const dx = e.clientX - down.lx, dy = e.clientY - down.ly;
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG) {
      down.moved = true;
      if (down.mode === 'raid') down.mode = 'pan';
    }
    const t = tileAt(e.clientX, e.clientY);
    if (down.mode === 'pan' && down.moved) R.pan(dx, dy);
    else if (down.mode === 'ghost' && G.place) G.movePlace(t[0] - down.gx, t[1] - down.gy);
    else if (down.mode === 'line' && G.place && down.moved) G.place.line = G.wallLine(down.start.x, down.start.y, t[0], t[1]);
    down.lx = e.clientX; down.ly = e.clientY;
    cv.style.cursor = down.mode === 'pan' && down.moved ? 'grabbing' : cv.style.cursor;
  }

  function hover(e) {
    if (e.target !== cv || G.paused) { G.hover = null; return; }
    if (G.place && e.pointerType === 'mouse') {
      const t = tileAt(e.clientX, e.clientY);
      G.movePlace(t[0], t[1]);
      cv.style.cursor = 'copy';
      return;
    }
    if (G.mode === 'raid') {
      const c = G.pickAt(e.clientX, e.clientY);
      G.hover = c ? { id: c.id } : null;
      cv.style.cursor = 'crosshair';
      return;
    }
    const id = G.pickAt(e.clientX, e.clientY);
    G.hover = id ? { id: id } : null;
    cv.style.cursor = id ? 'pointer' : G.edit ? 'move' : 'grab';
  }

  function tap(e) {
    const t = tileAt(e.clientX, e.clientY);
    if (G.mode === 'raid') { G.deployAt(t[0], t[1], false); return; }
    if (G.place) { G.movePlace(t[0], t[1]); CS.UI.refresh(); return; }
    const id = G.pickAt(e.clientX, e.clientY);
    if (G.edit && !id) return;
    G.select(id);
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    cv.style.cursor = '';
    if (e.type === 'pointercancel') { if (G.place) G.place.line = null; return; }
    if (d.mode === 'pan' || d.mode === 'raid') { if (!d.moved) tap(e); return; }
    if (d.mode === 'stream') return;
    if (d.mode === 'ghost') {
      if (!d.moved || (d.drop && G.place && G.place.ok)) G.confirmPlace();
      else CS.UI.refresh();
      return;
    }
    if (d.mode === 'line' && G.place) {
      const line = G.place.line;
      if (line && line.length > 1) G.placeLine(line);
      else { G.place.line = null; if (!d.touch || !d.moved) G.confirmPlace(); }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    if (G.paused) return;
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    R.zoomAt(Math.exp(-e.deltaY * k * 0.0015), e.clientX, e.clientY);
  }

  // Per-frame work: held-key panning and the troop deployment stream.
  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = lastKeyFrame ? Math.min(0.05, (ts - lastKeyFrame) / 1000) : 0;
    lastKeyFrame = ts;
    if (!G || G.paused || CS.UI.modal) return;
    let px = 0, py = 0;
    if (keys.arrowleft || keys.a) px += 1;
    if (keys.arrowright || keys.d) px -= 1;
    if (keys.arrowup || keys.w) py += 1;
    if (keys.arrowdown || keys.s) py -= 1;
    if (px || py) R.pan(px * PAN_SPEED * dt, py * PAN_SPEED * dt);
    if (down && down.mode === 'raid' && !down.moved && ts - down.at >= HOLD_MS) {
      down.mode = 'stream';
      down.last = 0;
    }
    if (down && down.mode === 'stream' && ts - down.last >= STREAM_MS) {
      down.last = ts;
      const t = tileAt(down.lx, down.ly);
      G.deployAt(t[0], t[1], true);
    }
  }

  function onKey(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (CS.UI.modal) {
      if (k === 'escape') { e.preventDefault(); if (CS.UI.modal !== 'results') CS.UI.close(); }
      else if (k === 'enter' && CS.UI.modal === 'confirm') { e.preventDefault(); CS.UI.ACT.confirmYes(); }
      return;
    }
    if (G.paused) {
      if (k === 'enter' || k === ' ') { e.preventDefault(); G.play(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    keys[k] = true;
    if (k.indexOf('arrow') === 0 || k === ' ') e.preventDefault();
    const raid = G.mode === 'raid';
    if (k === 'escape') {
      if (G.place) G.cancelPlace();
      else if (G.edit) G.toggleEdit(false);
      else if (G.sel) G.select(null);
      else if (!raid) CS.UI.open('settings');
      return;
    }
    if (k === '+' || k === '=') { R.zoomAt(1.2, R.W / 2, R.H / 2); return; }
    if (k === '-' || k === '_') { R.zoomAt(1 / 1.2, R.W / 2, R.H / 2); return; }
    if (k === 'f' && G.battle) { G.toggleSpeed(); return; }
    if (raid) {
      const b = G.battle;
      if (!b) return;
      if (k >= '1' && k <= '9') {
        const list = CS.CONFIG.deployOrder.filter(function (t) { return (b.meta.brought || {})[t] > 0; });
        const type = list[Number(k) - 1];
        if (type) G.selectTroop(type);
      } else if (k === ' ' && I.mouse) {
        const t = tileAt(I.mouse.x, I.mouse.y);
        G.deployAt(t[0], t[1], false);
      }
      return;
    }
    if (k === 'enter' && G.place) { G.confirmPlace(); return; }
    if (k === 'r') { if (G.place) G.rotatePlace(); else CS.UI.open('research'); return; }
    if (k === ' ') { G.home(); return; }
    const map = { b: 'build', e: 'edit', m: 'world', t: 'army', l: 'log', c: 'collect', h: 'help', p: 'layouts' };
    if (map[k] && !e.repeat) CS.UI.ACT[map[k]]();
  }

  I.init = function (game) {
    G = game;
    cv = R.canvas;
    cv.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('pointerleave', function () { G.pointer = null; G.hover = null; });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', function () { Object.keys(keys).forEach(function (k) { keys[k] = false; }); });
    requestAnimationFrame(loop);
  };

  CS.Input = I;
})(window.CS = window.CS || {});
