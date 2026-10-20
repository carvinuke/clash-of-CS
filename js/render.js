/*
 * Isometric renderer. Reads a "scene" description built each frame by the game (buildings,
 * troops, projectiles, overlays) and draws it; it never changes game state. Terrain is baked
 * once per scene into an offscreen canvas, buildings come from the sprite cache, and particles
 * live only here. Every effect is started by a real game event (see battleEvents in main.js).
 *
 * Light matches the sprites: one sun to the upper left, so lit sides face up-left and every
 * shadow (buildings, trees, stones) falls down-right. Building shadows are merged into one
 * layer and faded once, so overlapping shadows never double up.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Spr = CS.Sprites;
  const HW = Spr.HW, HH = Spr.HH, P = Spr.P, shade = Spr.shade;
  const S = C.grid.size, M = 7;
  const FONT = '"Signika", "Segoe UI", system-ui, sans-serif';
  const INK = 'rgba(32,22,14,0.86)', CREAM = '#fff3d6', DANGER = '#ff6a4d';
  const R = {};

  // Terrain palettes. lawn: the build area; wild: the rest of the map; lush and dry: large
  // patches mixed in by noise; out: beyond the map edge, fading to bg at the border.
  const BIOMES = {
    home: { bg: '#3b6326', lawn: '#88c04e', wild: '#79b345', lush: '#5f9c39', dry: '#a6c55f', out: '#5b8e34',
      trees: ['round', 'round', 'pine', 'bush'], deco: ['flowers', 'tufts', 'tufts', 'stones'], flowers: ['#fff4b8', '#ffffff', '#f7a9c4', '#c9b8ff'], tuft: '#4a8a2c', rock: '#a29a8c' },
    meadow: { bg: '#3d6528', lawn: '#8fc453', wild: '#80b84a', lush: '#63a13c', dry: '#adc965', out: '#5f9237',
      trees: ['round', 'round', 'pine', 'bush'], deco: ['flowers', 'flowers', 'tufts', 'stones'], flowers: ['#fff4b8', '#ffffff', '#f7a9c4', '#ffb35c'], tuft: '#4f8c2f', rock: '#a29a8c' },
    desert: { bg: '#a77e46', lawn: '#e8ca8c', wild: '#dfbd7a', lush: '#d0a966', dry: '#efd7a2', out: '#c79e5e',
      trees: ['cactus', 'cactus', 'boulder', 'shrub'], deco: ['ripples', 'stones', 'bones', 'drygrass'], tuft: '#a38545', rock: '#b8a07e' },
    snow: { bg: '#8ea7ba', lawn: '#eef4f9', wild: '#e3ecf4', lush: '#d3e0eb', dry: '#f7fafc', out: '#c6d5e2',
      trees: ['snowpine', 'snowpine', 'boulder'], deco: ['ice', 'stones', 'drygrass'], tuft: '#97856a', rock: '#8f99a5' },
    volcanic: { bg: '#2a2220', lawn: '#64554c', wild: '#584a41', lush: '#4b3e37', dry: '#6f5f54', out: '#3f3430',
      trees: ['dead', 'boulder', 'dead'], deco: ['lava', 'stones', 'ash'], tuft: '#3a302b', rock: '#4d4542' },
    swamp: { bg: '#2f4424', lawn: '#6f8b47', wild: '#617d3e', lush: '#506d35', dry: '#7d934c', out: '#465f30',
      trees: ['willow', 'willow', 'round'], deco: ['puddles', 'reeds', 'tufts'], tuft: '#3d5826', rock: '#7f8174' }
  };
  R.BIOMES = BIOMES;

  R.cam = { x: 0, y: S * HH, zoom: 1 };
  // Screen space covered by the HUD on each side; fitArea keeps the framed area clear of it.
  R.insets = { t: 0, r: 0, b: 0, l: 0 };
  R.fx = [];
  R.shake = 0;
  const aim = new Map(), recoil = new Map(), pulses = new Map(), pops = new Map();
  let shadowCanvas = null, shadowCtx = null;

  R.init = function (canvas) {
    R.canvas = canvas;
    R.ctx = canvas.getContext('2d');
    shadowCanvas = document.createElement('canvas');
    shadowCtx = shadowCanvas.getContext('2d');
    R.resize();
  };

  R.resize = function () {
    const c = R.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    R.dpr = dpr;
    R.W = c.clientWidth || window.innerWidth;
    R.H = c.clientHeight || window.innerHeight;
    c.width = Math.round(R.W * dpr);
    c.height = Math.round(R.H * dpr);
    shadowCanvas.width = c.width;
    shadowCanvas.height = c.height;
    vigKey = '';
    R.clampCam();
  };

  // ---------------------------------------------------------------- camera
  R.toScreen = function (tx, ty, z) {
    const ix = (tx - ty) * HW, iy = (tx + ty) * HH - (z || 0);
    return [(ix - R.cam.x) * R.cam.zoom + R.W / 2, (iy - R.cam.y) * R.cam.zoom + R.H / 2];
  };

  R.toTile = function (sx, sy) {
    const ix = (sx - R.W / 2) / R.cam.zoom + R.cam.x;
    const iy = (sy - R.H / 2) / R.cam.zoom + R.cam.y;
    return [(ix / HW + iy / HH) / 2, (iy / HH - ix / HW) / 2];
  };

  R.clampCam = function () {
    const c = R.cam;
    c.zoom = U.clamp(c.zoom, 0.35, 2.2);
    c.x = U.clamp(c.x, -S * HW, S * HW);
    c.y = U.clamp(c.y, 0, 2 * S * HH);
  };

  R.centerOn = function (tx, ty, zoom) {
    R.cam.x = (tx - ty) * HW;
    R.cam.y = (tx + ty) * HH;
    if (zoom) R.cam.zoom = zoom;
    R.clampCam();
  };

  // Zooms so a square of `size` tiles centered on (cx, cy) fills the view left free by the HUD
  // (map center by default). The extra height leaves room for the tallest buildings.
  R.fitArea = function (size, cx, cy) {
    const I = R.insets;
    const w = Math.max(200, R.W - I.l - I.r), h = Math.max(160, R.H - I.t - I.b);
    const z = U.clamp(Math.min(w / (size * 64 * 1.02), h / (size * 32 * 1.04 + 70)), 0.45, 1.3);
    R.centerOn(cx == null ? S / 2 : cx, cy == null ? S / 2 : cy, z);
    R.cam.x -= (I.l - I.r) / 2 / z;
    R.cam.y -= (I.t - I.b) / 2 / z;
    R.clampCam();
  };

  R.pan = function (dx, dy) {
    R.cam.x -= dx / R.cam.zoom;
    R.cam.y -= dy / R.cam.zoom;
    R.clampCam();
  };

  R.zoomAt = function (factor, sx, sy) {
    const before = R.toTile(sx, sy);
    R.cam.zoom = U.clamp(R.cam.zoom * factor, 0.35, 2.2);
    const after = R.toTile(sx, sy);
    R.cam.x += ((before[0] - after[0]) - (before[1] - after[1])) * HW;
    R.cam.y += ((before[0] - after[0]) + (before[1] - after[1])) * HH;
    R.clampCam();
  };

  // ---------------------------------------------------------------- noise
  function hash2(x, y, s) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s) { return vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15; }
  function sstep(a, b, x) { const t = U.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function rgb(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function beyond(u, v) { return Math.max(0, -u, -v, u - S, v - S); }     // tiles outside the map

  // ---------------------------------------------------------------- trees (scenery: no ink outline)
  const TS = 2, TW = 100, TH = 150, TX = 50, TY = 118;      // drawn at 2x so near trees stay crisp
  const treeCache = new Map();

  // Ground shadow of a crown of radius r whose centre is hc px up, cast down-right like buildings.
  function castShadow(g, hc, r) {
    const du = hc * Spr.SHADOW.x, dv = hc * Spr.SHADOW.y;
    const sx = (du - dv) * HW, sy = (du + dv) * HH;
    g.fillStyle = 'rgba(18,30,10,0.24)';
    g.beginPath(); g.ellipse(sx, sy, r * 1.05 + 2, r * 0.5 + 1.5, 0.12, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(18,30,10,0.2)'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(sx * 0.7, sy * 0.7); g.stroke();
  }

  function trunk(g, w, h, col) {
    g.fillStyle = col || '#6b4a2f';
    g.beginPath(); g.moveTo(-w * 0.75, 0); g.lineTo(-w / 2, -h); g.lineTo(w / 2, -h); g.lineTo(w * 0.75, 0); g.closePath(); g.fill();
    g.fillStyle = shade(col || '#6b4a2f', 0.2);
    g.fillRect(-w / 2, -h, w * 0.32, h);
  }

  // A crown of overlapping blobs: dark silhouette, mid tone shifted toward the sun, then light.
  function crown(g, blobs, leaf) {
    const circle = function (x, y, r) { g.beginPath(); g.arc(x, y, Math.max(1, r), 0, Math.PI * 2); g.fill(); };
    g.fillStyle = shade(leaf, -0.34); blobs.forEach(function (b) { circle(b[0], b[1], b[2] + 1); });
    g.fillStyle = leaf; blobs.forEach(function (b) { circle(b[0] - 1.6, b[1] - 1.5, b[2] - 0.8); });
    g.fillStyle = shade(leaf, 0.18); blobs.forEach(function (b) { circle(b[0] - b[2] * 0.3, b[1] - b[2] * 0.34, b[2] * 0.52); });
    g.fillStyle = shade(leaf, 0.36); blobs.slice(0, 2).forEach(function (b) { circle(b[0] - b[2] * 0.42, b[1] - b[2] * 0.5, b[2] * 0.18); });
  }

  function conifer(g, s, snow) {
    const col = snow ? '#2f6e4a' : '#2f7a45', dark = shade(col, -0.3), lit = shade(col, 0.14);
    for (let i = 0; i < 3; i++) {
      const y = (-10 - i * 16) * s, w = (20 - i * 5) * s, h = (28 - i * 2) * s;
      g.fillStyle = lit;
      g.beginPath(); g.moveTo(0, y - h); g.lineTo(w, y); g.lineTo(0, y + 3 * s); g.lineTo(-w, y); g.closePath(); g.fill();
      g.fillStyle = dark;
      g.beginPath(); g.moveTo(0, y - h); g.lineTo(w, y); g.lineTo(0, y + 3 * s); g.closePath(); g.fill();
      if (snow) {
        g.fillStyle = '#f3f7fa';
        g.beginPath(); g.moveTo(0, y - h); g.lineTo(-w * 0.62, y - h * 0.34); g.quadraticCurveTo(-w * 0.2, y - h * 0.26, 0, y - h * 0.4); g.closePath(); g.fill();
        g.fillStyle = '#cfdbe5';
        g.beginPath(); g.moveTo(0, y - h); g.lineTo(0, y - h * 0.4); g.quadraticCurveTo(w * 0.25, y - h * 0.3, w * 0.58, y - h * 0.38); g.closePath(); g.fill();
      }
    }
  }

  function drawTree(g, kind, s, rng) {
    if (kind === 'round' || kind === 'bush' || kind === 'willow') {
      const bush = kind === 'bush', willow = kind === 'willow';
      const leaf = willow ? '#5d7f39' : rng.pick(['#4e9a3c', '#559f3f', '#4a9440']);
      castShadow(g, (bush ? 10 : 40) * s, (bush ? 12 : 19) * s);
      if (!bush) trunk(g, 5 * s, 30 * s);
      const blobs = bush ? [[-8, -7, 8], [0, -10, 10], [8, -7, 8], [-3, -15, 6]]
        : willow ? [[0, -40, 20], [-15, -33, 13], [15, -33, 13], [-4, -51, 12]]
          : [[0, -40, 18], [-13, -31, 12], [13, -32, 12], [-6, -51, 12], [8, -50, 11]];
      crown(g, blobs.map(function (b) { return [b[0] * s, b[1] * s, b[2] * s]; }), leaf);
      if (willow) {
        g.strokeStyle = shade(leaf, -0.3); g.lineWidth = 1.6 * s; g.lineCap = 'round';
        for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(i * 6 * s, -30 * s); g.quadraticCurveTo(i * 7 * s, -20 * s, i * 7.6 * s, -12 * s); g.stroke(); }
      }
    } else if (kind === 'pine' || kind === 'snowpine') {
      castShadow(g, 34 * s, 14 * s);
      trunk(g, 4.4 * s, 12 * s);
      conifer(g, s, kind === 'snowpine');
    } else if (kind === 'cactus') {
      castShadow(g, 22 * s, 8 * s);
      const col = '#5a9a48';
      const path = function () {
        g.beginPath();
        g.moveTo(0, -1); g.lineTo(0, -44 * s);
        g.moveTo(0, -20 * s); g.lineTo(11 * s, -20 * s); g.lineTo(11 * s, -34 * s);
        g.moveTo(0, -15 * s); g.lineTo(-9 * s, -15 * s); g.lineTo(-9 * s, -26 * s);
      };
      g.lineCap = 'round'; g.lineJoin = 'round';
      path(); g.strokeStyle = shade(col, -0.3); g.lineWidth = 9 * s; g.stroke();
      g.save(); g.translate(-1.2 * s, 0); path(); g.strokeStyle = col; g.lineWidth = 6.4 * s; g.stroke(); g.restore();
      g.save(); g.translate(-2.4 * s, 0); path(); g.strokeStyle = shade(col, 0.22); g.lineWidth = 1.8 * s; g.stroke(); g.restore();
    } else if (kind === 'boulder') {
      castShadow(g, 8 * s, 15 * s);
      const col = rng.pick(['#9d958a', '#8f8a82']);
      const pts = [[-17, 0], [-15, -11], [-6, -20], [7, -19], [16, -10], [18, 0], [6, 3], [-8, 3]];
      g.fillStyle = shade(col, -0.24);
      g.beginPath(); pts.forEach(function (p, i) { if (i) g.lineTo(p[0] * s, p[1] * s); else g.moveTo(p[0] * s, p[1] * s); }); g.closePath(); g.fill();
      g.fillStyle = col;
      g.beginPath(); g.moveTo(-17 * s, 0); g.lineTo(-15 * s, -11 * s); g.lineTo(-6 * s, -20 * s); g.lineTo(7 * s, -19 * s); g.lineTo(4 * s, -6 * s); g.lineTo(-6 * s, 2 * s); g.closePath(); g.fill();
      g.fillStyle = shade(col, 0.22);
      g.beginPath(); g.moveTo(-15 * s, -11 * s); g.lineTo(-6 * s, -20 * s); g.lineTo(7 * s, -19 * s); g.lineTo(-2 * s, -12 * s); g.closePath(); g.fill();
    } else if (kind === 'dead') {
      castShadow(g, 30 * s, 9 * s);
      g.lineCap = 'round';
      const branch = function (w, col) {
        g.strokeStyle = col; g.lineWidth = w;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(-1 * s, -40 * s); g.moveTo(-0.6 * s, -22 * s); g.lineTo(-13 * s, -34 * s); g.moveTo(-0.8 * s, -30 * s); g.lineTo(11 * s, -45 * s); g.moveTo(-7 * s, -28 * s); g.lineTo(-9 * s, -41 * s); g.stroke();
      };
      branch(5 * s, '#2f2622');
      g.save(); g.translate(-1 * s, -0.5 * s); branch(1.6 * s, '#5b4b42'); g.restore();
    } else if (kind === 'shrub') {
      castShadow(g, 8 * s, 10 * s);
      g.strokeStyle = '#7d6a40'; g.lineWidth = 1.4 * s; g.lineCap = 'round';
      for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(i * 1.4 * s, 0); g.lineTo(i * 4 * s, (-10 - Math.abs(3 - Math.abs(i)) * 3) * s); g.stroke(); }
      crown(g, [[-6 * s, -10 * s, 4 * s], [5 * s, -12 * s, 4 * s], [0, -15 * s, 4 * s]], '#8d9a52');
    }
  }

  function treeSprite(kind, v) {
    const key = kind + v;
    let c = treeCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = TW * TS; c.height = TH * TS;
    const g = c.getContext('2d');
    g.scale(TS, TS); g.translate(TX, TY);
    drawTree(g, kind, 0.82 + v * 0.11, new U.Rng(U.hash(key)));
    treeCache.set(key, c);
    return c;
  }

  // ---------------------------------------------------------------- ground decoration
  function flower(g, p, col) {
    g.fillStyle = 'rgba(36,64,18,0.5)'; g.fillRect(p[0] - 0.5, p[1] - 2.6, 1, 2.8);
    g.fillStyle = shade(col, -0.3); g.beginPath(); g.arc(p[0] + 0.3, p[1] - 3, 1.9, 0, Math.PI * 2); g.fill();
    g.fillStyle = col; g.beginPath(); g.arc(p[0], p[1] - 3.3, 1.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,240,170,0.9)'; g.fillRect(p[0] - 0.5, p[1] - 3.8, 1, 1);
  }
  function tuft(g, p, rng, col) {
    g.lineCap = 'round';
    g.strokeStyle = col; g.lineWidth = 1.3;
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const ox = (i - 2) * 1.5 + rng.range(-0.4, 0.4);
      g.moveTo(p[0] + ox * 0.6, p[1]); g.lineTo(p[0] + ox * 1.5, p[1] - rng.range(3.6, 7));
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,220,0.26)'; g.lineWidth = 0.7;
    g.beginPath(); g.moveTo(p[0] - 1.5, p[1]); g.lineTo(p[0] - 2.9, p[1] - 4.4); g.stroke();
  }
  function stone(g, p, r, col) {
    g.fillStyle = 'rgba(18,28,10,0.22)';
    g.beginPath(); g.ellipse(p[0] + r * 0.6, p[1] + r * 0.1, r * 1.25, r * 0.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(col, -0.24);
    g.beginPath(); g.ellipse(p[0], p[1] - r * 0.32, r, r * 0.66, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = col;
    g.beginPath(); g.ellipse(p[0] - r * 0.14, p[1] - r * 0.44, r * 0.8, r * 0.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(col, 0.3);
    g.beginPath(); g.ellipse(p[0] - r * 0.34, p[1] - r * 0.6, r * 0.38, r * 0.22, -0.3, 0, Math.PI * 2); g.fill();
  }
  function decoCluster(g, B, kind, cu, cv, rng, blocked) {
    const at = function (spread) {
      const u = cu + (rng.next() + rng.next() - 1) * spread, v = cv + (rng.next() + rng.next() - 1) * spread;
      return blocked(u, v) ? null : P(u, v, 0);
    };
    let p, n;
    switch (kind) {
      case 'flowers': {
        const col = rng.pick(B.flowers);
        n = rng.int(5, 9);
        for (let i = 0; i < n; i++) if ((p = at(0.7))) flower(g, p, col);
        for (let i = 0; i < 2; i++) if ((p = at(0.9))) tuft(g, p, rng, B.tuft);
        break;
      }
      case 'tufts': case 'drygrass':
        n = rng.int(3, 6);
        for (let i = 0; i < n; i++) if ((p = at(1))) tuft(g, p, rng, B.tuft);
        break;
      case 'stones':
        n = rng.int(1, 3);
        for (let i = 0; i < n; i++) if ((p = at(0.7))) stone(g, p, rng.range(2.8, 5.6), B.rock);
        if ((p = at(0.8))) tuft(g, p, rng, B.tuft);
        break;
      case 'bones':
        if ((p = at(0.4))) {
          g.strokeStyle = '#efe6d2'; g.lineWidth = 1.6; g.lineCap = 'round';
          g.beginPath(); g.moveTo(p[0] - 5, p[1] - 1); g.lineTo(p[0] + 3, p[1] + 1); g.moveTo(p[0] - 1, p[1] - 3); g.lineTo(p[0] + 5, p[1] - 2); g.stroke();
          g.fillStyle = '#efe6d2'; g.beginPath(); g.arc(p[0] + 7, p[1] - 2.5, 2.2, 0, Math.PI * 2); g.fill();
        }
        if ((p = at(0.7))) stone(g, p, rng.range(2, 3.5), B.rock);
        break;
      case 'ripples':
        n = rng.int(2, 4);
        for (let i = 0; i < n; i++) {
          if (!(p = at(1.3))) continue;
          g.lineWidth = 1;
          g.strokeStyle = 'rgba(150,108,56,0.34)'; g.beginPath(); g.moveTo(p[0] - 11, p[1]); g.quadraticCurveTo(p[0], p[1] - 4, p[0] + 11, p[1]); g.stroke();
          g.strokeStyle = 'rgba(255,246,218,0.38)'; g.beginPath(); g.moveTo(p[0] - 10, p[1] - 1.3); g.quadraticCurveTo(p[0], p[1] - 5.3, p[0] + 10, p[1] - 1.3); g.stroke();
        }
        break;
      case 'ice':
        n = rng.int(1, 2);
        for (let i = 0; i < n; i++) {
          if (!(p = at(0.8))) continue;
          const rx = rng.range(7, 14);
          g.fillStyle = 'rgba(158,204,232,0.5)'; g.beginPath(); g.ellipse(p[0], p[1], rx, rx * 0.45, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1; g.beginPath(); g.ellipse(p[0] - rx * 0.2, p[1] - rx * 0.1, rx * 0.55, rx * 0.2, 0, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
        }
        break;
      case 'lava':
        if ((p = at(0.6))) {
          g.beginPath(); g.moveTo(p[0] - 12, p[1] - 2);
          for (let i = 1; i <= 4; i++) g.lineTo(p[0] - 12 + i * 6, p[1] + rng.range(-3.5, 3.5));
          g.lineCap = 'round'; g.lineJoin = 'round';
          g.strokeStyle = 'rgba(30,18,14,0.6)'; g.lineWidth = 3.4; g.stroke();
          g.strokeStyle = '#ff7a2e'; g.lineWidth = 1.5; g.stroke();
          g.strokeStyle = 'rgba(255,214,130,0.85)'; g.lineWidth = 0.6; g.stroke();
        }
        if ((p = at(0.8))) stone(g, p, rng.range(2.4, 4), B.rock);
        break;
      case 'ash':
        g.fillStyle = 'rgba(176,166,156,0.45)';
        for (let i = 0; i < 7; i++) if ((p = at(0.9))) { g.beginPath(); g.ellipse(p[0], p[1], rng.range(1, 2.4), rng.range(0.6, 1.2), 0, 0, Math.PI * 2); g.fill(); }
        break;
      case 'puddles':
        if ((p = at(0.4))) {
          const rx = rng.range(9, 15);
          g.fillStyle = 'rgba(36,62,56,0.6)'; g.beginPath(); g.ellipse(p[0], p[1], rx, rx * 0.45, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = 'rgba(196,226,214,0.45)'; g.lineWidth = 1; g.beginPath(); g.ellipse(p[0] - 2, p[1] - 1, rx * 0.6, rx * 0.2, 0, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
        }
      // falls through: puddles come with reeds
      case 'reeds':
        n = rng.int(3, 5);
        for (let i = 0; i < n; i++) {
          if (!(p = at(0.9))) continue;
          const h = rng.range(7, 12);
          g.strokeStyle = '#3c5a26'; g.lineWidth = 1.1; g.lineCap = 'round';
          g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(p[0] + rng.range(-1.5, 1.5), p[1] - h); g.stroke();
          g.fillStyle = '#6b4a2b'; g.fillRect(p[0] - 0.9, p[1] - h - 0.5, 1.8, 3.4);
        }
        break;
    }
  }

  // A small surveyor's stone at each corner of the build area.
  function marker(g, p) {
    g.fillStyle = 'rgba(18,28,10,0.25)';
    g.beginPath(); g.ellipse(p[0] + 4, p[1] + 1.5, 6, 2.4, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#cfc4ae'; g.fillRect(p[0] - 2.6, p[1] - 7, 2.6, 7.6);
    g.fillStyle = '#9b907d'; g.fillRect(p[0], p[1] - 7, 2.6, 7.6);
    g.fillStyle = '#ebe2cd';
    g.beginPath(); g.moveTo(p[0] - 2.6, p[1] - 7); g.lineTo(p[0], p[1] - 8.4); g.lineTo(p[0] + 2.6, p[1] - 7); g.lineTo(p[0], p[1] - 5.6); g.closePath(); g.fill();
  }

  // ---------------------------------------------------------------- terrain baking
  let ground = null, groundKey = '';
  let frontTrees = [];

  function bakeGround(biomeName, area, seed) {
    const B = BIOMES[biomeName] || BIOMES.home;
    const N = S + 2 * M;
    const c = document.createElement('canvas');
    c.width = N * 2 * HW;
    c.height = N * 2 * HH;
    const g = c.getContext('2d');
    g.fillStyle = B.bg;
    g.fillRect(0, 0, c.width, c.height);
    const inArea = function (u, v, pad) { return !!area && u > area.x0 - pad && v > area.y0 - pad && u < area.x1 + pad && v < area.y1 + pad; };

    // Colour field: K samples per tile in tile space, smoothed by the iso transform when drawn,
    // so there are no tile seams. Large noise patches, a mown lawn in the build area, and a
    // gradual darkening beyond the map edge that ends in the background colour.
    const K = 4, n = N * K, s1 = seed % 100003;
    const fc = document.createElement('canvas');
    fc.width = fc.height = n;
    const fg = fc.getContext('2d');
    const img = fg.createImageData(n, n);
    const lawn = rgb(B.lawn), wild = rgb(B.wild), lush = rgb(B.lush), dry = rgb(B.dry), out = rgb(B.out), bg = rgb(B.bg);
    for (let j = 0; j < n; j++) {
      const v = -M + (j + 0.5) / K;
      for (let i = 0; i < n; i++) {
        const u = -M + (i + 0.5) / K;
        const big = fbm(u * 0.09, v * 0.09, s1), fine = vnoise(u * 0.7, v * 0.7, s1 + 31);
        let col, k;
        if (inArea(u, v, 0)) {
          col = lerp3(lawn, lush, sstep(0.55, 0.85, big) * 0.3);
          k = (Math.floor(u) & 1 ? 1.022 : 0.986) * (1 + (fine - 0.5) * 0.03);      // mown stripes
          col = [col[0] * k, col[1] * k, col[2] * k];
        } else {
          col = lerp3(wild, lush, sstep(0.48, 0.78, big) * 0.75);
          col = lerp3(col, dry, sstep(0.45, 0.18, big) * 0.55);
          const d = beyond(u, v);
          if (d > 0) col = lerp3(col, out, sstep(0, 3, d));
          k = 1 + (fine - 0.5) * 0.07;
          col = [col[0] * k, col[1] * k, col[2] * k];
          if (d > 0) col = lerp3(col, bg, sstep(M - 3.5, M - 0.5, d));
        }
        const o = (j * n + i) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
    }
    fg.putImageData(img, 0, 0);
    g.save();
    g.imageSmoothingEnabled = true;
    g.setTransform(HW / K, HH / K, -HW / K, HH / K, N * HW, 0);
    g.drawImage(fc, 0, 0);
    g.restore();
    g.translate(N * HW, 2 * M * HH);

    // Decoration comes in small clusters (a patch of flowers, a few stones), never in the build area.
    const rng = new U.Rng(seed);
    const clusters = [];
    for (let i = 0; i < 56; i++) {
      const u = rng.range(-M + 1, S + M - 1), v = rng.range(-M + 1, S + M - 1);
      if (inArea(u, v, 1.2) || beyond(u, v) > M - 2) continue;
      clusters.push({ u: u, v: v, kind: rng.pick(B.deco) });
    }
    clusters.sort(function (a, b) { return (a.u + a.v) - (b.u + b.v); });
    clusters.forEach(function (cl) { decoCluster(g, B, cl.kind, cl.u, cl.v, rng, function (u, v) { return inArea(u, v, 0.3); }); });

    // Build area: a soft lawn edge and corner stones.
    if (area) {
      const q = [P(area.x0, area.y0, 0), P(area.x1, area.y0, 0), P(area.x1, area.y1, 0), P(area.x0, area.y1, 0)];
      g.beginPath(); q.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.closePath();
      g.strokeStyle = 'rgba(26,44,12,0.24)'; g.lineWidth = 3.4; g.stroke();
      g.strokeStyle = 'rgba(255,252,226,0.26)'; g.lineWidth = 1.1; g.stroke();
      q.forEach(function (p) { marker(g, p); });
    }

    // Trees grow only beyond the map edge, in groves plus a few loners. Trees behind the map are
    // baked; trees in front of it are drawn over the scene each frame.
    frontTrees = [];
    const spots = [];
    const free = function (u, v) {
      const d = beyond(u, v);
      if (d < 0.9 || d > M - 0.7) return false;
      for (let i = 0; i < spots.length; i++) if (Math.abs(spots[i].u - u) + Math.abs(spots[i].v - v) < 0.9) return false;
      return true;
    };
    const ring = function () {
      for (let k = 0; k < 24; k++) {
        const u = rng.range(-M + 0.7, S + M - 0.7), v = rng.range(-M + 0.7, S + M - 0.7);
        if (beyond(u, v) >= 1.2 && beyond(u, v) <= M - 1.2) return [u, v];
      }
      return null;
    };
    const add = function (u, v, kind) { if (free(u, v)) spots.push({ u: u, v: v, kind: kind, size: rng.int(0, 3), front: u > S || v > S }); };
    for (let i = 0; i < 20; i++) {
      const c0 = ring();
      if (!c0) continue;
      const kind = rng.pick(B.trees);
      const count = rng.int(3, 8);
      for (let k = 0; k < count; k++) add(c0[0] + rng.range(-1.8, 1.8), c0[1] + rng.range(-1.8, 1.8), rng.chance(0.8) ? kind : rng.pick(B.trees));
    }
    for (let i = 0; i < 30; i++) { const p = ring(); if (p) add(p[0], p[1], rng.pick(B.trees)); }
    spots.sort(function (a, b) { return (a.u + a.v) - (b.u + b.v); });
    spots.forEach(function (s) {
      if (s.front) { frontTrees.push(s); return; }
      const p = P(s.u, s.v, 0);
      g.drawImage(treeSprite(s.kind, s.size), p[0] - TX, p[1] - TY, TW, TH);
    });
    return { canvas: c, ox: N * HW, oy: 2 * M * HH };
  }

  R.setGround = function (biome, area, seed) {
    const key = biome + '|' + (area ? area.x0 + ',' + area.x1 : 'none') + '|' + seed;
    if (key === groundKey && ground) return;
    groundKey = key;
    ground = bakeGround(biome, area, seed);
    R.bg = (BIOMES[biome] || BIOMES.home).bg;
    vigKey = '';
  };

  // ---------------------------------------------------------------- effects
  // Particles live in tile space (x, y) with a height z in px. Rings are ground circles that
  // grow from r0 to r1 tiles. Only game events start effects.
  const smolder = [], flies = [];
  const dmgAcc = new Map();
  let textCount = 0;

  function add(p) { if (R.fx.length < 700) R.fx.push(p); }
  function ring(x, y, r0, r1, col, life, w) { add({ k: 'ring', x: x, y: y, z: 0, life: life, max: life, r0: r0, r1: r1, col: col, w: w || 2 }); }

  R.emit = function (kind, x, y, z, o) {
    o = o || {};
    const rnd = Math.random;
    switch (kind) {
      case 'spark':
        for (let i = 0; i < 4; i++) add({ k: 'dot', x: x, y: y, z: z || 10, vx: (rnd() - 0.5) * 2.6, vy: (rnd() - 0.5) * 2.6, vz: 30 + rnd() * 40, g: 160, life: 0.3, max: 0.3, col: o.col || '#ffe08a', size: 1.5 });
        break;
      case 'boom': {
        const r = o.r || 1;
        add({ k: 'flash', x: x, y: y, z: z || 6, life: 0.22, max: 0.22, size: 14 + r * 18, col: o.col || '#ffd27a' });
        ring(x, y, 0.2, r, '#ffe6b4', 0.4, 2.4);
        for (let i = 0; i < 6 + r * 4; i++) add({ k: 'fire', x: x + (rnd() - 0.5) * r * 0.5, y: y + (rnd() - 0.5) * r * 0.5, z: (z || 6) + rnd() * 8, vx: (rnd() - 0.5) * 2 * r, vy: (rnd() - 0.5) * 2 * r, vz: 20 + rnd() * 40, g: 30, life: 0.45 + rnd() * 0.3, max: 0.75, size: 3.5 + rnd() * 4.5, col: rnd() < 0.5 ? '#ff9b3d' : '#ffd34d' });
        for (let i = 0; i < 4; i++) add({ k: 'smoke', x: x, y: y, z: (z || 6) + 10, vx: (rnd() - 0.5) * 0.7, vy: (rnd() - 0.5) * 0.7, vz: 16 + rnd() * 14, g: 0, life: 1 + rnd() * 0.6, max: 1.6, size: 5 + rnd() * 5, col: '#6e6862' });
        break;
      }
      case 'debris': {
        const n = Math.min(12, o.n || 10), cols = o.cols || ['#8a7e70', '#6b5f52'];
        for (let i = 0; i < n; i++) add({ k: 'chunk', x: x + (rnd() - 0.5) * (o.w || 1), y: y + (rnd() - 0.5) * (o.w || 1), z: 10 + rnd() * 18, vx: (rnd() - 0.5) * 3.4, vy: (rnd() - 0.5) * 3.4, vz: 50 + rnd() * 80, g: 260, life: 0.8 + rnd() * 0.4, max: 1.2, size: 2 + rnd() * 3, col: cols[i % cols.length], rot: rnd() * 6 });
        for (let i = 0; i < 6; i++) add({ k: 'smoke', x: x + (rnd() - 0.5) * (o.w || 1), y: y + (rnd() - 0.5) * (o.w || 1), z: 8, vx: (rnd() - 0.5) * 0.5, vy: (rnd() - 0.5) * 0.5, vz: 12 + rnd() * 16, g: 0, life: 1.4 + rnd() * 0.8, max: 2.2, size: 8 + rnd() * 7, col: '#a19a90' });
        break;
      }
      case 'shock':     // a major building fell: two ground rings and a short, small shake
        ring(x, y, 0.4, (o.r || 2) + 2.2, '#fff1d6', 0.7, 3);
        ring(x, y, 0.2, (o.r || 2) + 1, '#d8c9a8', 0.9, 6);
        R.shake = Math.min(5, R.shake + (o.shake || 4));
        break;
      case 'smoke':
        add({ k: 'smoke', x: x, y: y, z: z || 8, vx: (rnd() - 0.5) * 0.3, vy: (rnd() - 0.5) * 0.3, vz: 12 + rnd() * 10, g: 0, life: 1.6, max: 1.6, size: 5 + rnd() * 5, col: o.col || '#5d5853' });
        break;
      case 'dust':
        for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; add({ k: 'smoke', x: x, y: y, z: 2, vx: Math.cos(a) * 1.3, vy: Math.sin(a) * 1.3, vz: 6, g: 0, life: 0.5, max: 0.5, size: 3 + rnd() * 2, col: '#d8c9a8' }); }
        break;
      case 'deploy':
        ring(x, y, 0.15, 0.75, o.col || CREAM, 0.35, 2);
        for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + 0.4; add({ k: 'smoke', x: x, y: y, z: 2, vx: Math.cos(a) * 0.9, vy: Math.sin(a) * 0.9, vz: 5, g: 0, life: 0.45, max: 0.45, size: 3, col: '#e2d6bb' }); }
        break;
      case 'heal':
        ring(x, y, 0.3, o.r || 2, '#7dffa4', 0.5, 1.6);
        for (let i = 0; i < 3; i++) add({ k: 'plus', x: x + (rnd() - 0.5) * 1.4, y: y + (rnd() - 0.5) * 1.4, z: 12, vx: 0, vy: 0, vz: 20, g: 0, life: 0.8, max: 0.8, size: 2.6, col: '#6dff98' });
        break;
      case 'frost':
        ring(x, y, 0.6, o.r || 4, '#bfefff', 0.5, 2.2);
        break;
      case 'text':
        add({ k: 'text', x: x, y: y, z: z || 40, vx: 0, vy: 0, vz: 24, g: 0, life: o.life || 1.3, max: o.life || 1.3, text: o.text, col: o.col || '#fff', size: o.size || 15 });
        break;
      case 'coins':
        for (let i = 0; i < 5; i++) add({ k: 'coin', x: x, y: y, z: z || 30, vx: (rnd() - 0.5) * 1.8, vy: (rnd() - 0.5) * 1.8, vz: 60 + rnd() * 50, g: 220, life: 0.75, max: 0.75, size: 2.8, col: o.col || '#f2c23a' });
        break;
      case 'poof':
        for (let i = 0; i < 5; i++) add({ k: 'smoke', x: x, y: y, z: 8, vx: (rnd() - 0.5) * 1.1, vy: (rnd() - 0.5) * 1.1, vz: 10 + rnd() * 10, g: 0, life: 0.6, max: 0.6, size: 4 + rnd() * 3, col: '#d2cbc2' });
        break;
      case 'muzzle':
        add({ k: 'flash', x: x, y: y, z: z || 26, life: 0.08, max: 0.08, size: 11, col: '#fff2b0' });
        for (let i = 0; i < 2; i++) add({ k: 'smoke', x: x, y: y, z: z || 26, vx: (o.dx || 0) * 0.8 + (rnd() - 0.5) * 0.3, vy: (o.dy || 0) * 0.8 + (rnd() - 0.5) * 0.3, vz: 8 + rnd() * 6, g: 0, life: 0.7, max: 0.7, size: 3 + rnd() * 2, col: '#cfc9c0' });
        break;
    }
  };

  // Damage and loot numbers: everything one target takes within 0.3 s is summed into one number.
  R.damage = function (key, x, y, z, n, col, prefix) {
    let a = dmgAcc.get(key);
    if (!a) { a = { n: 0, t: 0, col: col, prefix: prefix || '' }; dmgAcc.set(key, a); }
    a.n += n; a.x = x; a.y = y; a.z = z;
  };

  // Rubble keeps smoking for a few seconds after a building is destroyed.
  R.smolder = function (x, y, w) { smolder.push({ x: x, y: y, w: w || 1, left: 6, acc: 0 }); };

  // Screen-space icons flying from (x0, y0) to (x1, y1), e.g. collected coins to the HUD counter.
  R.flyTo = function (x0, y0, x1, y1, icon, n, onDone) {
    for (let i = 0; i < n; i++) {
      flies.push({ x0: x0 + (Math.random() - 0.5) * 18, y0: y0 + (Math.random() - 0.5) * 10, x1: x1, y1: y1, t: -i * 0.07, dur: 0.62, icon: icon, done: i === n - 1 ? onDone : null });
    }
  };

  R.clearFx = function () {
    R.fx.length = 0; smolder.length = 0; dmgAcc.clear(); R.shake = 0;
    flies.forEach(function (f) { if (f.done) f.done(); });
    flies.length = 0;
  };

  R.pulse = function (id) { pulses.set(id, performance.now()); };
  R.recoil = function (id) { recoil.set(id, performance.now()); };
  R.pop = function (id) { pops.set(id, performance.now()); };

  function updateFx(dt) {
    const F = R.fx;
    let w = 0;
    textCount = 0;
    for (let i = 0; i < F.length; i++) {
      const p = F[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.vx) p.x += p.vx * dt;
      if (p.vy) p.y += p.vy * dt;
      if (p.vz != null) {
        p.z += p.vz * dt;
        p.vz -= (p.g || 0) * dt;
        if (p.z < 0) { p.z = 0; p.vz = -p.vz * 0.3; p.vx *= 0.5; p.vy *= 0.5; }
      }
      if (p.k === 'text') textCount++;
      F[w++] = p;
    }
    F.length = w;
    R.shake = Math.max(0, R.shake - dt * 16);
    for (let i = smolder.length - 1; i >= 0; i--) {
      const s = smolder[i];
      s.left -= dt; s.acc += dt;
      if (s.left <= 0) { smolder.splice(i, 1); continue; }
      if (s.acc >= 0.4) {
        s.acc = 0;
        add({ k: 'smoke', x: s.x + (Math.random() - 0.5) * s.w * 0.6, y: s.y + (Math.random() - 0.5) * s.w * 0.6, z: 6, vx: 0.15, vy: -0.05, vz: 14 + Math.random() * 8, g: 0, life: 1.8, max: 1.8, size: 4 + s.w * 1.5, col: s.left > 3 ? '#4f4a46' : '#8a847d' });
      }
    }
    dmgAcc.forEach(function (a, key) {
      a.t += dt;
      if (a.t < 0.3) return;
      dmgAcc.delete(key);
      const v = Math.round(a.n);
      if (v < 1 || textCount >= 48) return;
      textCount++;
      add({ k: 'text', x: a.x, y: a.y, z: a.z, vx: 0, vy: 0, vz: 22, g: 0, life: 0.85, max: 0.85, text: a.prefix + U.fmt(v), col: a.col, size: 12, small: true });
    });
    for (let i = flies.length - 1; i >= 0; i--) {
      const f = flies[i];
      f.t += dt;
      if (f.t >= f.dur) { flies.splice(i, 1); if (f.done) f.done(); }
    }
  }

  function ellipseAt(ctx, x, y, r) {
    const s = R.toScreen(x, y), z = R.cam.zoom;
    ctx.beginPath();
    ctx.ellipse(s[0], s[1], Math.max(0.1, r * HW * Math.SQRT2 * z), Math.max(0.1, r * HH * Math.SQRT2 * z), 0, 0, Math.PI * 2);
  }

  function drawFx(ctx, z) {
    const F = R.fx;
    for (let i = 0; i < F.length; i++) {
      const p = F[i];
      const f = p.life / p.max;
      if (p.k === 'ring') {
        const e = 1 - f, r = p.r0 + (p.r1 - p.r0) * (1 - (1 - e) * (1 - e));
        ellipseAt(ctx, p.x, p.y, r);
        ctx.globalAlpha = f * 0.85;
        ctx.strokeStyle = p.col; ctx.lineWidth = p.w * Math.max(0.7, z); ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      const s = R.toScreen(p.x, p.y, p.z);
      if (s[0] < -40 || s[0] > R.W + 40 || s[1] < -60 || s[1] > R.H + 40) continue;
      if (p.k === 'dot' || p.k === 'coin') {
        const sz = p.size * z;
        ctx.fillStyle = p.col;
        ctx.beginPath();
        if (p.k === 'coin') ctx.ellipse(s[0], s[1], sz * 1.2, sz, 0, 0, Math.PI * 2);
        else ctx.arc(s[0], s[1], sz * 0.6, 0, Math.PI * 2);
        ctx.fill();
        if (p.k === 'coin') { ctx.strokeStyle = 'rgba(80,50,8,0.6)'; ctx.lineWidth = 0.8; ctx.stroke(); }
      } else if (p.k === 'chunk') {
        const sz = p.size * z;
        ctx.save(); ctx.translate(s[0], s[1]); ctx.rotate(p.rot + p.life * 6);
        ctx.fillStyle = p.col; ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.8);
        ctx.restore();
      } else if (p.k === 'fire') {
        ctx.globalAlpha = f;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(s[0], s[1], p.size * z * (0.5 + f * 0.5), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.k === 'smoke') {
        ctx.globalAlpha = f * 0.42;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(s[0], s[1], p.size * z * (1.6 - f * 0.6), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.k === 'flash') {
        const r = p.size * z;
        const g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], r);
        g.addColorStop(0, 'rgba(255,255,232,' + f + ')'); g.addColorStop(0.4, Spr.alpha(p.col, f * 0.75)); g.addColorStop(1, 'rgba(255,160,60,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.fill();
      } else if (p.k === 'plus') {
        ctx.globalAlpha = f; ctx.fillStyle = p.col;
        const q = p.size * z;
        ctx.fillRect(s[0] - q * 0.35, s[1] - q, q * 0.7, q * 2); ctx.fillRect(s[0] - q, s[1] - q * 0.35, q * 2, q * 0.7);
        ctx.globalAlpha = 1;
      } else if (p.k === 'text') {
        ctx.globalAlpha = Math.min(1, f * 2.5);
        const px = Math.round(p.size * (p.small ? U.clamp(z, 0.9, 1.15) : Math.max(0.85, Math.min(1.25, z))));
        ctx.font = '700 ' + px + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3; ctx.strokeStyle = INK;
        ctx.strokeText(p.text, s[0], s[1]);
        ctx.fillStyle = p.col; ctx.fillText(p.text, s[0], s[1]);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawFlies(ctx) {
    flies.forEach(function (f) {
      if (f.t <= 0) return;
      const e = U.clamp(f.t / f.dur, 0, 1), k = e * e * (3 - 2 * e);
      const cx = (f.x0 + f.x1) / 2, cy = Math.min(f.y0, f.y1) - 70;
      const x = (1 - k) * (1 - k) * f.x0 + 2 * (1 - k) * k * cx + k * k * f.x1;
      const y = (1 - k) * (1 - k) * f.y0 + 2 * (1 - k) * k * cy + k * k * f.y1;
      const im = CS.Icons.image(f.icon, 40), sz = 20 - k * 6;
      if (im) ctx.drawImage(im, x - sz / 2, y - sz / 2, sz, sz);
    });
  }

  // ---------------------------------------------------------------- ground overlays
  function tileQuad(ctx, x0, y0, x1, y1) {
    const a = R.toScreen(x0, y0), b = R.toScreen(x1, y0), c = R.toScreen(x1, y1), d = R.toScreen(x0, y1);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
  }

  // Placement and edit grid over the build area; occupied tiles read as darker ground.
  function drawGrid(ctx, scene) {
    const area = scene.area;
    if (scene.occupied && scene.occupied.length) {
      ctx.beginPath();
      scene.occupied.forEach(function (r) { tileQuad(ctx, r.x, r.y, r.x + r.w, r.y + r.h); });
      ctx.fillStyle = 'rgba(28,42,14,0.2)'; ctx.fill();
    }
    ctx.beginPath();
    for (let x = area.x0; x <= area.x1; x++) { const a = R.toScreen(x, area.y0), b = R.toScreen(x, area.y1); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    for (let y = area.y0; y <= area.y1; y++) { const a = R.toScreen(area.x0, y), b = R.toScreen(area.x1, y); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.strokeStyle = 'rgba(255,252,228,' + (scene.gridAlpha || 0.16) + ')';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Where troops cannot land: a soft tint merged into runs, plus one outline along the border
  // between blocked and open ground (no per-tile lines).
  function drawDeploy(ctx, d) {
    const mask = d.mask;
    ctx.beginPath();
    for (let y = 0; y < S; y++) {
      let x = 0;
      while (x < S) {
        if (mask[y * S + x]) { x++; continue; }
        const x0 = x;
        while (x < S && !mask[y * S + x]) x++;
        tileQuad(ctx, x0, y, x, y + 1);
      }
    }
    ctx.fillStyle = 'rgba(214,52,34,' + d.alpha + ')';
    ctx.fill();
    ctx.beginPath();
    const seg = function (x0, y0, x1, y1) { const a = R.toScreen(x0, y0), b = R.toScreen(x1, y1); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (mask[y * S + x]) continue;
        if (x + 1 < S && mask[y * S + x + 1]) seg(x + 1, y, x + 1, y + 1);
        if (x > 0 && mask[y * S + x - 1]) seg(x, y, x, y + 1);
        if (y + 1 < S && mask[(y + 1) * S + x]) seg(x, y + 1, x + 1, y + 1);
        if (y > 0 && mask[(y - 1) * S + x]) seg(x, y, x + 1, y);
      }
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(110,18,8,' + d.edge * 0.35 + ')'; ctx.lineWidth = 3.4; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,104,80,' + Math.min(1, d.edge) + ')'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function rangeEllipse(ctx, x, y, r, col, fill) {
    ellipseAt(ctx, x, y, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.setLineDash([]);
  }

  // Corner brackets on the ground around a footprint: selection and target markers.
  function brackets(ctx, b, col, w, out, a) {
    const x0 = b.x - out, y0 = b.y - out, x1 = b.x + b.w + out, y1 = b.y + b.h + out;
    const L = Math.min(0.6, Math.min(b.w, b.h) * 0.28 + 0.14);
    ctx.beginPath();
    [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]].forEach(function (c) {
      const p = R.toScreen(c[0], c[1]), q1 = R.toScreen(c[0] + c[2] * L, c[1]), q2 = R.toScreen(c[0], c[1] + c[3] * L);
      ctx.moveTo(q1[0], q1[1]); ctx.lineTo(p[0], p[1]); ctx.lineTo(q2[0], q2[1]);
    });
    ctx.globalAlpha = a;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(28,20,12,0.55)'; ctx.lineWidth = w + 2.4; ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  }

  function drawShadows(ctx, scene, sx, sy) {
    const g = shadowCtx, z = R.cam.zoom;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, shadowCanvas.width, shadowCanvas.height);
    g.setTransform(R.dpr, 0, 0, R.dpr, sx * R.dpr, sy * R.dpr);
    let any = false;
    scene.buildings.forEach(function (b) {
      if (b.alpha != null && b.alpha < 0.5) return;
      const sh = Spr.shadow(b.type, Math.max(1, b.level), b.rot, b.ruin ? 'ruin' : b.level < 1 ? 'build' : 'normal', b.mask || 0);
      const s = R.toScreen(b.x, b.y);
      const x = s[0] - sh.ox * z, y = s[1] - sh.oy * z, w = sh.w * z, h = sh.h * z;
      if (x > R.W || y > R.H || x + w < 0 || y + h < 0) return;
      g.drawImage(sh.canvas, x, y, w, h);
      any = true;
    });
    if (!any) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.3;
    ctx.drawImage(shadowCanvas, 0, 0);
    ctx.restore();
  }

  // ---------------------------------------------------------------- buildings and troops
  function popAmount(id) {
    const t = pops.get(id);
    if (t == null) return 0;
    const e = (performance.now() - t) / 380;
    if (e >= 1) { pops.delete(id); return 0; }
    return Math.sin(e * Math.PI) * (1 - e);
  }

  function drawBuilding(ctx, b, time) {
    const z = R.cam.zoom;
    const s = R.toScreen(b.x, b.y);
    const variant = b.ruin ? 'ruin' : b.level < 1 ? 'build' : 'normal';
    const spr = Spr.building(b.type, Math.max(1, b.level), b.rot, b.team, variant, b.mask || 0);
    const x = s[0] - spr.ox * z, y = s[1] - spr.oy * z, w = spr.w * z, h = spr.h * z;
    if (x > R.W || y > R.H || x + w < 0 || y + h < 0) return;
    ctx.save();
    const pop = b.id > 0 ? popAmount(b.id) : 0;
    if (pop) {
      // a quick squash and stretch from the ground up when a building is placed or finished
      const c = R.toScreen(b.x + b.w / 2, b.y + b.h / 2);
      ctx.translate(c[0], c[1]); ctx.scale(1 - pop * 0.035, 1 + pop * 0.09); ctx.translate(-c[0], -c[1]);
    }
    if (b.alpha != null) ctx.globalAlpha = b.alpha;
    ctx.drawImage(spr.canvas, x, y, w, h);
    if (variant === 'normal') {
      ctx.save();
      ctx.translate(s[0], s[1]);
      ctx.scale(z, z);
      Spr.drawLive(ctx, b, b.info || {}, time, spr);
      ctx.restore();
    }
    const glow = b.hitFlash ? 0.2 : b.sel ? 0.06 + Math.sin(time * 4) * 0.02 : b.hover ? 0.05 : 0;
    if (glow > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = glow;
      ctx.drawImage(spr.canvas, x, y, w, h);
    }
    ctx.restore();
  }

  function drawUnit(ctx, u, time) {
    const s = R.toScreen(u.x, u.y);
    const z = R.cam.zoom;
    if (s[0] < -40 || s[1] < -60 || s[0] > R.W + 40 || s[1] > R.H + 40) return;
    const k = Math.max(z, 0.8) * 1.1;
    if (u.targeted) {
      ctx.beginPath(); ctx.ellipse(s[0], s[1], 9 * k, 4.4 * k, 0, 0, Math.PI * 2);
      ctx.setLineDash([3, 2.5]);
      ctx.strokeStyle = 'rgba(255,96,70,0.85)'; ctx.lineWidth = 1.3; ctx.stroke();
      ctx.setLineDash([]);
    }
    Spr.drawTroop(ctx, s[0], s[1], k, u.type, u.team, time + u.id * 0.37, u);
  }

  function drawProjectile(ctx, p, time) {
    const z = R.cam.zoom;
    if (p.k === 'shell') {
      const f = p.f;
      const h = 37 + (4 - 37) * f + 4 * f * (1 - f) * 110;
      const g = R.toScreen(p.x, p.y, 0);
      ctx.fillStyle = 'rgba(20,14,8,' + (0.12 + f * 0.22) + ')';
      ctx.beginPath(); ctx.ellipse(g[0], g[1], (3 + f * 3) * z, (1.5 + f * 1.5) * z, 0, 0, Math.PI * 2); ctx.fill();
      const s = R.toScreen(p.x, p.y, h);
      ctx.fillStyle = '#2b2c30'; ctx.beginPath(); ctx.arc(s[0], s[1], 5.2 * z, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(s[0] - 1.6 * z, s[1] - 1.6 * z, 1.5 * z, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = (time * 12 | 0) & 1 ? '#ffd34d' : '#ff8a3d'; ctx.beginPath(); ctx.arc(s[0] + 2.6 * z, s[1] - 3.6 * z, 1.4 * z, 0, Math.PI * 2); ctx.fill();
      return;
    }
    const s = R.toScreen(p.x, p.y, p.z);
    if (p.k === 'ball') {
      for (let i = 2; i >= 1; i--) {
        const t = R.toScreen(p.x - p.dx * 0.35 * i, p.y - p.dy * 0.35 * i, p.z + p.dz * 0.35 * i);
        ctx.fillStyle = 'rgba(70,64,58,' + (0.22 / i) + ')'; ctx.beginPath(); ctx.arc(t[0], t[1], (3.6 - i * 0.6) * z, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#26272b'; ctx.beginPath(); ctx.arc(s[0], s[1], 3.8 * z, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(s[0] - 1.2 * z, s[1] - 1.2 * z, 1.1 * z, 0, Math.PI * 2); ctx.fill();
    } else if (p.k === 'bolt' || p.k === 'arrow') {
      const L = p.k === 'bolt' ? 1.1 : 0.62;
      const t = R.toScreen(p.x - p.dx * L, p.y - p.dy * L, p.z + p.dz * L);
      ctx.lineCap = 'round';
      ctx.strokeStyle = INK; ctx.lineWidth = (p.k === 'bolt' ? 3.6 : 2.6) * z; ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
      ctx.strokeStyle = p.k === 'bolt' ? '#c9a26b' : '#b08a5a'; ctx.lineWidth = (p.k === 'bolt' ? 1.8 : 1.2) * z; ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = '#e4e8ec'; ctx.beginPath(); ctx.arc(s[0], s[1], (p.k === 'bolt' ? 2 : 1.4) * z, 0, Math.PI * 2); ctx.fill();
      if (p.k === 'arrow') { ctx.fillStyle = '#f3ecdc'; ctx.beginPath(); ctx.arc(t[0], t[1], 1.4 * z, 0, Math.PI * 2); ctx.fill(); }
    } else if (p.k === 'orb') {
      const r = 8 * z;
      const g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], r);
      g.addColorStop(0, 'rgba(255,244,255,1)'); g.addColorStop(0.35, 'rgba(206,140,255,0.9)'); g.addColorStop(1, 'rgba(160,80,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBeam(ctx, a, b) {
    const pts = [a];
    const n = 7;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      pts.push([a[0] + (b[0] - a[0]) * t + (Math.random() - 0.5) * 9, a[1] + (b[1] - a[1]) * t + (Math.random() - 0.5) * 9]);
    }
    pts.push(b);
    [[7, 'rgba(120,200,255,0.3)'], [3, 'rgba(190,235,255,0.9)'], [1.2, '#ffffff']].forEach(function (st) {
      ctx.strokeStyle = st[1]; ctx.lineWidth = st[0] * R.cam.zoom;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    });
  }

  // ---------------------------------------------------------------- bars, timers, bubbles
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function healthCol(f) { return f > 0.5 ? '#7ccf4f' : f > 0.25 ? '#f0c042' : '#e8553d'; }

  function bar(ctx, x, y, w, h, frac, col) {
    x = Math.round(x - w / 2); y = Math.round(y); w = Math.round(w);
    ctx.fillStyle = INK;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, w, h);
    const fw = Math.round(w * U.clamp(frac, 0, 1));
    ctx.fillStyle = col;
    ctx.fillRect(x, y, fw, h);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x, y, fw, 1);
  }

  function timerPill(ctx, x, y, t) {
    ctx.font = '600 11px ' + FONT;
    const tw = ctx.measureText(t.text).width;
    const w = Math.round(Math.max(52, tw + 27)), h = 19;
    const x0 = Math.round(x - w / 2), y0 = Math.round(y - h);
    rrect(ctx, x0, y0, w, h, 3);
    ctx.fillStyle = 'rgba(34,25,17,0.9)'; ctx.fill();
    ctx.strokeStyle = 'rgba(214,170,92,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    const im = CS.Icons.image(t.icon || 'clock', 28);
    if (im) ctx.drawImage(im, x0 + 4, y0 + 2.5, 13, 13);
    ctx.fillStyle = CREAM; ctx.textAlign = 'left';
    ctx.fillText(t.text, x0 + 20, y0 + 13);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x0 + 3, y0 + h - 3, w - 6, 2);
    ctx.fillStyle = '#e8b54e'; ctx.fillRect(x0 + 3, y0 + h - 3, Math.round((w - 6) * U.clamp(t.frac, 0, 1)), 2);
  }

  function bubble(ctx, x, y, kind, time, id) {
    const by = Math.round(y + Math.sin(time * 2.4 + id) * 1.6);
    const r = 11.5;
    ctx.beginPath();
    ctx.arc(x, by - r, r, Math.PI * 0.62, Math.PI * 2.38);
    ctx.lineTo(x, by + 4);
    ctx.closePath();
    ctx.fillStyle = kind === 'repair' ? '#ffe2d6' : '#fff6e3'; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.3; ctx.stroke();
    const im = CS.Icons.image(kind === 'repair' ? 'wrench' : kind, 36);
    if (im) ctx.drawImage(im, x - 8.5, by - r - 8.5, 17, 17);
  }

  function drawOverlays(ctx, scene, time) {
    const z = R.cam.zoom;
    scene.buildings.forEach(function (b) {
      const top = R.toScreen(b.x + b.w / 2, b.y + b.h / 2, (b.barZ || 40) + 14);
      if (top[0] < -70 || top[0] > R.W + 70 || top[1] < -40 || top[1] > R.H + 40) return;
      let y = top[1];
      if (b.hpFrac != null && b.hpFrac < 1 && !b.ruin) {
        const w = Math.max(26, (b.w + b.h) * 8.5) * U.clamp(z, 0.75, 1.2);
        bar(ctx, top[0], y, w, 4, b.hpFrac, healthCol(b.hpFrac));
        y -= 6;
      }
      if (b.timer) { timerPill(ctx, top[0], y, b.timer); y -= 22; }
      if (b.bubble) bubble(ctx, top[0], y - 2, b.bubble, time, b.id);
    });
    if (scene.unitBars) {
      (scene.units || []).forEach(function (u) {
        if (u.hp >= u.maxHp) return;
        const k = Math.max(z, 0.8) * 1.1;
        const s = R.toScreen(u.x, u.y);
        const hy = (u.type === 'bruiser' ? 40 : u.type === 'mender' ? 42 : 33) * k;
        bar(ctx, s[0], s[1] - hy, 14, 2, u.hp / u.maxHp, u.enemy ? '#ff7a5c' : '#7fd0ff');
      });
    }
  }

  function drawCursor(ctx, c) {
    ellipseAt(ctx, c.x, c.y, 0.42);
    if (c.ok) { ctx.fillStyle = 'rgba(255,243,214,0.16)'; ctx.fill(); }
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(28,20,12,0.5)'; ctx.stroke();
    ctx.lineWidth = 1.7; ctx.strokeStyle = c.ok ? CREAM : DANGER; ctx.stroke();
    if (!c.ok) {
      const s = R.toScreen(c.x, c.y), q = 4.5 * R.cam.zoom;
      ctx.beginPath(); ctx.moveTo(s[0] - q, s[1] - q * 0.5); ctx.lineTo(s[0] + q, s[1] + q * 0.5); ctx.moveTo(s[0] + q, s[1] - q * 0.5); ctx.lineTo(s[0] - q, s[1] + q * 0.5);
      ctx.strokeStyle = DANGER; ctx.lineWidth = 1.8; ctx.stroke();
    }
  }

  let vig = null, vigKey = '';
  function vignette(ctx) {
    const key = R.W + 'x' + R.H + R.bg;
    if (key !== vigKey) {
      vigKey = key;
      vig = ctx.createRadialGradient(R.W / 2, R.H * 0.5, Math.min(R.W, R.H) * 0.38, R.W / 2, R.H * 0.5, Math.hypot(R.W, R.H) * 0.62);
      vig.addColorStop(0, Spr.alpha(shade(R.bg || '#3b6326', -0.6), 0));
      vig.addColorStop(1, Spr.alpha(shade(R.bg || '#3b6326', -0.6), 0.34));
    }
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, R.W, R.H);
  }

  function smoothAngle(id, target, dt) {
    let a = aim.has(id) ? aim.get(id) : target;
    let d = target - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    a += d * Math.min(1, dt * 10);
    aim.set(id, a);
    return a;
  }
  R.aimAngle = function (id, target, dt) { return target == null ? (aim.has(id) ? aim.get(id) : 0.8) : smoothAngle(id, target, dt); };
  R.aimOf = function (id) { return aim.has(id) ? aim.get(id) : null; };
  R.recoilAmount = function (id) {
    const t = recoil.get(id);
    if (!t) return 0;
    const e = (performance.now() - t) / 1000;
    return e < 0.25 ? 1 - e / 0.25 : 0;
  };
  R.pulseAmount = function (id) {
    const t = pulses.get(id);
    if (!t) return 0;
    const e = (performance.now() - t) / 1000;
    return e < 0.6 ? 1 - e / 0.6 : 0;
  };

  /*
   * scene: { buildings, units, projectiles, beams, ghost, highlights, ranges, grid, gridAlpha, area,
   *          occupied, deploy: {mask, alpha, edge}, cursor: {x, y, ok}, unitBars }
   * building: { id, type, level, rot, x, y, w, h, team, ruin, mask, info, alpha, barZ, hpFrac, hitFlash,
   *             timer: {frac, text, icon}, bubble, sel, hover, targeted, engaged }
   */
  R.draw = function (scene, time, dt) {
    const ctx = R.ctx;
    const z = R.cam.zoom;
    updateFx(dt);
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.fillStyle = R.bg || '#3b6326';
    ctx.fillRect(0, 0, R.W, R.H);
    let sx = 0, sy = 0;
    if (R.shake > 0.1) { sx = (Math.random() - 0.5) * R.shake; sy = (Math.random() - 0.5) * R.shake; ctx.translate(sx, sy); }
    if (ground) {
      const o = R.toScreen(0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(ground.canvas, o[0] - ground.ox * z, o[1] - ground.oy * z, ground.canvas.width * z, ground.canvas.height * z);
    }
    if (scene.grid && scene.area) drawGrid(ctx, scene);
    if (scene.deploy) drawDeploy(ctx, scene.deploy);
    (scene.highlights || []).forEach(function (h) {
      ctx.beginPath();
      tileQuad(ctx, h.x, h.y, h.x + h.w, h.y + h.h);
      ctx.fillStyle = h.fill; ctx.fill();
      ctx.strokeStyle = h.stroke; ctx.lineWidth = 2; ctx.stroke();
    });
    (scene.ranges || []).forEach(function (r) {
      rangeEllipse(ctx, r.x, r.y, r.r, r.col || 'rgba(255,248,226,0.7)', r.fill || 'rgba(255,248,226,0.06)');
      if (r.min) rangeEllipse(ctx, r.x, r.y, r.min, 'rgba(255,120,100,0.6)', 'rgba(255,80,60,0.08)');
    });
    drawShadows(ctx, scene, sx, sy);
    scene.buildings.forEach(function (b) {
      if (b.sel) brackets(ctx, b, CREAM, 2.2, 0.12 + Math.sin(time * 5) * 0.04, 1);
      else if (b.engaged) brackets(ctx, b, DANGER, 1.6, 0.08, 0.75);
      else if (b.targeted) brackets(ctx, b, CREAM, 1.4, 0.08, 0.6);
    });
    // depth-sorted buildings and troops
    const list = [];
    scene.buildings.forEach(function (b) { list.push({ d: b.x + b.w / 2 + b.y + b.h / 2, b: b }); });
    if (scene.ghost) { const g = scene.ghost; list.push({ d: g.x + g.w / 2 + g.y + g.h / 2 + 0.01, b: g }); }
    (scene.units || []).forEach(function (u) { list.push({ d: u.x + u.y + (u.type === 'mender' ? 0.6 : 0), u: u }); });
    list.sort(function (a, b) { return a.d - b.d; });
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.b) drawBuilding(ctx, it.b, time);
      else drawUnit(ctx, it.u, time);
    }
    frontTrees.forEach(function (s) {
      const p = R.toScreen(s.u, s.v);
      if (p[0] < -TX * z || p[0] > R.W + TX * z || p[1] < -10 || p[1] > R.H + TY * z) return;
      ctx.drawImage(treeSprite(s.kind, s.size), p[0] - TX * z, p[1] - TY * z, TW * z, TH * z);
    });
    (scene.projectiles || []).forEach(function (p) { drawProjectile(ctx, p, time); });
    (scene.beams || []).forEach(function (b) { drawBeam(ctx, R.toScreen(b.x0, b.y0, b.z0), R.toScreen(b.x1, b.y1, b.z1)); });
    drawFx(ctx, z);
    drawOverlays(ctx, scene, time);
    if (scene.cursor) drawCursor(ctx, scene.cursor);
    if (sx || sy) ctx.translate(-sx, -sy);
    vignette(ctx);
    drawFlies(ctx);
  };

  CS.Render = R;
})(window.CS = window.CS || {});
