/*
 * Shared helpers: math, seeded random numbers, formatting, the event bus and the game clock.
 */
(function (CS) {
  'use strict';

  const U = {};

  U.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.dist = function (ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); };

  // Distance from a point to an axis-aligned rectangle [x, x+w] x [y, y+h] (0 when inside).
  U.distToRect = function (px, py, x, y, w, h) {
    const dx = px < x ? x - px : px > x + w ? px - x - w : 0;
    const dy = py < y ? y - py : py > y + h ? py - y - h : 0;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Deterministic PRNG (mulberry32). The state is a plain integer so battles can be saved and resumed.
  U.Rng = function (seed) { this.s = (seed >>> 0) || 1; };
  U.Rng.prototype.next = function () {
    let t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  U.Rng.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  U.Rng.prototype.int = function (a, b) { return a + Math.floor(this.next() * (b - a + 1)); };
  U.Rng.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length)]; };
  U.Rng.prototype.chance = function (p) { return this.next() < p; };
  U.Rng.prototype.shuffle = function (arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };

  U.hash = function (str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  U.fmt = function (n) {
    n = Math.floor(n);
    if (n < 10000) return n.toLocaleString('en-US');
    if (n < 1e6) return (n / 1000).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  };

  // Whole percent rounded down, so 49.6% destruction never reads as the 50% a win needs.
  U.pct = function (f) { return Math.floor(f * 100 + 1e-6); };

  U.fmtTime = function (sec) {
    sec = Math.max(0, Math.ceil(sec));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm' + (s ? ' ' + String(s).padStart(2, '0') + 's' : '');
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + 'h' + (mm ? ' ' + String(mm).padStart(2, '0') + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  };

  U.clockTime = function (sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  U.esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  U.$ = function (id) { return document.getElementById(id); };

  U.deepClone = function (o) { return JSON.parse(JSON.stringify(o)); };

  // Fills keys missing from `target` with values from `defaults` (recursively for plain objects).
  U.fillDefaults = function (target, defaults) {
    Object.keys(defaults).forEach(function (k) {
      const d = defaults[k];
      if (target[k] === undefined || target[k] === null && d !== null) target[k] = U.deepClone(d);
      else if (d && typeof d === 'object' && !Array.isArray(d) && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        U.fillDefaults(target[k], d);
      }
    });
    return target;
  };

  // Tiny synchronous event bus used to decouple systems from the UI and tutorial.
  const listeners = {};
  CS.Bus = {
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return fn; },
    off: function (name, fn) { const l = listeners[name]; if (l) listeners[name] = l.filter(function (f) { return f !== fn; }); },
    emit: function (name, data) {
      (listeners[name] || []).slice().forEach(function (fn) {
        try { fn(data); } catch (e) { console.error('Event handler failed for', name, e); }
      });
    }
  };

  // The game clock. `offset` exists so automated tests can simulate time passing.
  CS.Clock = {
    offset: 0,
    now: function () { return Date.now() + this.offset; }
  };

  CS.U = U;
})(window.CS = window.CS || {});
