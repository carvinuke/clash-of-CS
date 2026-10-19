/*
 * Isometric renderer. Reads a "scene" description built each frame by the game (buildings,
 * troops, projectiles, overlays) and draws it; it never changes game state. Terrain is baked
 * once per scene into an offscreen canvas, buildings come from the sprite cache, and particles
 * live only here.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Spr = CS.Sprites;
  const HW = Spr.HW, HH = Spr.HH, P = Spr.P;
  const S = C.grid.size, M = 6;
  const R = {};

  const BIOMES = {
    home: { bg: '#3d6b2a', lawn: ['#7dbb45', '#75b33f'], wild: ['#67a53a', '#62a036'], out: ['#4f8a2f', '#4a842c'], edge: 'rgba(40,70,20,0.5)', trees: ['round', 'pine'], deco: ['flower', 'tuft', 'pebble'] },
    meadow: { bg: '#3f6d2c', lawn: ['#86bd4c', '#7fb646'], wild: ['#6faa3e', '#6aa53a'], out: ['#558f33', '#4f8a30'], edge: 'rgba(40,70,20,0.5)', trees: ['round', 'round', 'pine'], deco: ['flower', 'flower', 'tuft'] },
    desert: { bg: '#b78c4c', lawn: ['#e7c784', '#e1bf7b'], wild: ['#dbb56e', '#d6af68'], out: ['#c99e58', '#c49953'], edge: 'rgba(120,80,30,0.45)', trees: ['cactus', 'rock'], deco: ['pebble', 'ripple', 'bones'] },
    snow: { bg: '#9fb6c7', lawn: ['#f0f5fa', '#e8eff6'], wild: ['#e1eaf2', '#dbe5ee'], out: ['#c9d8e4', '#c3d3df'], edge: 'rgba(90,120,150,0.45)', trees: ['snowpine', 'snowpine', 'rock'], deco: ['ice', 'pebble'] },
    volcanic: { bg: '#2b2220', lawn: ['#5f4f48', '#594a43'], wild: ['#51443e', '#4c3f3a'], out: ['#3e3330', '#3a302d'], edge: 'rgba(255,110,40,0.35)', trees: ['dead', 'rock'], deco: ['lava', 'pebble'] },
    swamp: { bg: '#334a22', lawn: ['#668541', '#607f3d'], wild: ['#577437', '#526f33'], out: ['#43602b', '#3f5b28'], edge: 'rgba(30,50,20,0.5)', trees: ['willow', 'willow', 'round'], deco: ['puddle', 'reed', 'tuft'] }
  };
  R.BIOMES = BIOMES;

  R.cam = { x: 0, y: S * HH, zoom: 1 };
  R.fx = [];
  R.shake = 0;
  const aim = new Map(), recoil = new Map(), pulses = new Map();

  R.init = function (canvas) {
    R.canvas = canvas;
    R.ctx = canvas.getContext('2d');
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

  // Zooms so a square of `size` tiles centered on (cx, cy) fills the view (map center by default).
  R.fitArea = function (size, cx, cy) {
    const z = Math.min(R.W / (size * 64 * 1.05), (R.H - 120) / (size * 32 * 1.25));
    R.centerOn(cx == null ? S / 2 : cx, cy == null ? S / 2 : cy, U.clamp(z, 0.45, 1.3));
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

  // ---------------------------------------------------------------- terrain baking
  let ground = null, groundKey = '';
  let frontDecor = [];
  const decorCache = new Map();

  function tileColor(list, x, y, rng) {
    const base = list[(x + y) & 1];
    const n = (rng.next() - 0.5) * 0.06;
    return Spr.shade(base, n);
  }

  function decorSprite(kind, variant) {
    const key = kind + variant;
    let c = decorCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 80; c.height = 110;
    const g = c.getContext('2d');
    g.translate(40, 100);
    const rng = new U.Rng(U.hash(key));
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.ellipse(4, 0, 22, 9, 0, 0, Math.PI * 2); g.fill();
    const s = 0.75 + variant * 0.12;
    g.scale(s, s);
    if (kind === 'pine' || kind === 'snowpine') {
      g.fillStyle = '#5a3d24'; g.fillRect(-3, -16, 6, 16);
      for (let i = 0; i < 3; i++) {
        const y = -14 - i * 18, w = 24 - i * 6;
        g.fillStyle = i % 2 ? '#2f6b34' : '#3a7b3c';
        g.beginPath(); g.moveTo(-w, y); g.lineTo(0, y - 30); g.lineTo(w, y); g.closePath(); g.fill();
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.moveTo(0, y - 30); g.lineTo(w, y); g.lineTo(0, y); g.closePath(); g.fill();
        if (kind === 'snowpine') { g.fillStyle = '#f2f7fb'; g.beginPath(); g.moveTo(-w * 0.55, y - 13); g.lineTo(0, y - 30); g.lineTo(w * 0.55, y - 13); g.quadraticCurveTo(0, y - 9, -w * 0.55, y - 13); g.fill(); }
      }
    } else if (kind === 'round' || kind === 'willow') {
      g.fillStyle = '#5a3d24'; g.fillRect(-3, -22, 6, 22);
      const cols = kind === 'willow' ? ['#4c6b2f', '#5a7a36', '#3f5c27'] : ['#3f8a3a', '#4fa046', '#357a32'];
      [[0, -42, 20], [-13, -32, 14], [13, -33, 14], [4, -55, 13]].forEach(function (b, i) {
        g.fillStyle = cols[i % 3]; g.beginPath(); g.arc(b[0], b[1], b[2], 0, Math.PI * 2); g.fill();
      });
      if (kind === 'willow') { g.strokeStyle = '#3f5c27'; g.lineWidth = 2; for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(i * 7, -36); g.quadraticCurveTo(i * 8, -20, i * 9, -12); g.stroke(); } }
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.arc(-6, -48, 8, 0, Math.PI * 2); g.fill();
    } else if (kind === 'cactus') {
      g.fillStyle = '#4f8f45'; g.strokeStyle = '#2f5f2a'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-5, 0); g.lineTo(-5, -46); g.quadraticCurveTo(0, -52, 5, -46); g.lineTo(5, 0); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(5, -26); g.lineTo(13, -26); g.lineTo(13, -38); g.quadraticCurveTo(16, -42, 19, -38); g.lineTo(19, -22); g.lineTo(5, -20); g.fill(); g.stroke();
    } else if (kind === 'dead') {
      g.strokeStyle = '#2d221e'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(0, 0); g.lineTo(-2, -40); g.moveTo(-1, -24); g.lineTo(-14, -36); g.moveTo(-1, -32); g.lineTo(12, -46); g.stroke();
      g.lineWidth = 2.5; g.beginPath(); g.moveTo(-8, -30); g.lineTo(-10, -44); g.moveTo(7, -40); g.lineTo(16, -42); g.stroke();
    } else if (kind === 'rock') {
      const col = rng.chance(0.5) ? '#8c8680' : '#77716b';
      g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(-18, 0); g.lineTo(-14, -14); g.lineTo(-2, -22); g.lineTo(12, -16); g.lineTo(18, 0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.moveTo(-14, -14); g.lineTo(-2, -22); g.lineTo(-4, -8); g.closePath(); g.fill();
    }
    decorCache.set(key, c);
    return c;
  }

  function drawDeco(g, kind, x, y, rng) {
    const p = P(x, y, 0);
    if (kind === 'flower') {
      const cols = ['#fff6a8', '#ff9ec7', '#ffffff', '#b8a8ff'];
      g.fillStyle = cols[rng.int(0, 3)];
      for (let i = 0; i < 3; i++) g.fillRect(p[0] + rng.range(-6, 6), p[1] + rng.range(-3, 3), 2, 2);
    } else if (kind === 'tuft' || kind === 'reed') {
      g.strokeStyle = kind === 'reed' ? '#3f5a2a' : 'rgba(40,90,25,0.55)'; g.lineWidth = 1;
      for (let i = 0; i < 4; i++) { const ox = rng.range(-5, 5); g.beginPath(); g.moveTo(p[0] + ox, p[1]); g.lineTo(p[0] + ox + rng.range(-2, 2), p[1] - rng.range(3, kind === 'reed' ? 11 : 6)); g.stroke(); }
    } else if (kind === 'pebble' || kind === 'bones') {
      g.fillStyle = kind === 'bones' ? '#efe6d2' : 'rgba(110,104,96,0.6)';
      g.beginPath(); g.ellipse(p[0], p[1], rng.range(1.5, 3.5), rng.range(1, 2), 0, 0, Math.PI * 2); g.fill();
    } else if (kind === 'ripple') {
      g.strokeStyle = 'rgba(160,120,60,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(p[0] - 12, p[1]); g.quadraticCurveTo(p[0], p[1] - 4, p[0] + 12, p[1]); g.stroke();
    } else if (kind === 'ice') {
      g.fillStyle = 'rgba(170,215,240,0.5)';
      g.beginPath(); g.ellipse(p[0], p[1], rng.range(6, 14), rng.range(3, 6), 0, 0, Math.PI * 2); g.fill();
    } else if (kind === 'lava') {
      g.strokeStyle = 'rgba(255,120,40,0.75)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(p[0] - 10, p[1] - 2);
      for (let i = 0; i < 4; i++) g.lineTo(p[0] - 10 + i * 6 + rng.range(-2, 2), p[1] + rng.range(-4, 4));
      g.stroke();
    } else if (kind === 'puddle') {
      g.fillStyle = 'rgba(40,70,60,0.55)';
      g.beginPath(); g.ellipse(p[0], p[1], rng.range(8, 16), rng.range(4, 7), 0, 0, Math.PI * 2); g.fill();
    }
  }

  function bakeGround(biomeName, area, seed) {
    const B = BIOMES[biomeName] || BIOMES.home;
    const N = S + 2 * M;
    const c = document.createElement('canvas');
    c.width = N * 2 * HW;
    c.height = N * 2 * HH;
    const g = c.getContext('2d');
    g.fillStyle = B.bg;
    g.fillRect(0, 0, c.width, c.height);
    g.translate(N * HW, 2 * M * HH);
    const rng = new U.Rng(seed);
    for (let y = -M; y < S + M; y++) {
      for (let x = -M; x < S + M; x++) {
        const inMap = x >= 0 && y >= 0 && x < S && y < S;
        const inArea = area && x >= area.x0 && y >= area.y0 && x < area.x1 && y < area.y1;
        const col = inArea ? tileColor(B.lawn, x, y, rng) : inMap ? tileColor(B.wild, x, y, rng) : tileColor(B.out, x, y, rng);
        const a = P(x, y, 0), b = P(x + 1, y, 0), d = P(x + 1, y + 1, 0), e = P(x, y + 1, 0);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(d[0], d[1]); g.lineTo(e[0], e[1]); g.closePath();
        g.fillStyle = col; g.fill();
        g.strokeStyle = col; g.lineWidth = 0.6; g.stroke();
      }
    }
    // decorations on the open ground
    for (let i = 0; i < 520; i++) {
      const x = rng.range(-M, S + M), y = rng.range(-M, S + M);
      if (area && x > area.x0 - 0.5 && y > area.y0 - 0.5 && x < area.x1 + 0.5 && y < area.y1 + 0.5) continue;
      drawDeco(g, rng.pick(B.deco), x, y, rng);
    }
    // map edge and build area outline
    const edge = function (x0, y0, x1, y1, col, wdt, dash) {
      g.save();
      g.strokeStyle = col; g.lineWidth = wdt;
      if (dash) g.setLineDash(dash);
      const a = P(x0, y0, 0), b = P(x1, y0, 0), d = P(x1, y1, 0), e = P(x0, y1, 0);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(d[0], d[1]); g.lineTo(e[0], e[1]); g.closePath(); g.stroke();
      g.restore();
    };
    edge(0, 0, S, S, B.edge, 3);
    if (area) edge(area.x0, area.y0, area.x1, area.y1, 'rgba(255,255,255,0.35)', 2, [8, 6]);
    // trees and rocks around the map: back ones baked, front ones drawn over the scene
    frontDecor = [];
    const spots = [];
    for (let i = 0; i < 150; i++) {
      const side = rng.int(0, 3);
      const t = rng.range(-M + 1, S + M - 1), depth = rng.range(0.6, M - 0.6);
      let x, y;
      if (side === 0) { x = t; y = -depth; } else if (side === 1) { x = -depth; y = t; } else if (side === 2) { x = t; y = S + depth; } else { x = S + depth; y = t; }
      spots.push({ x: x, y: y, kind: rng.pick(B.trees), v: rng.int(0, 3), front: side >= 2 });
    }
    spots.sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    spots.forEach(function (s) {
      if (s.front) { frontDecor.push(s); return; }
      const p = P(s.x, s.y, 0), img = decorSprite(s.kind, s.v);
      g.drawImage(img, p[0] - 40, p[1] - 100);
    });
    return { canvas: c, ox: N * HW, oy: 2 * M * HH };
  }

  R.setGround = function (biome, area, seed) {
    const key = biome + '|' + (area ? area.x0 + ',' + area.x1 : 'none') + '|' + seed;
    if (key === groundKey && ground) return;
    groundKey = key;
    ground = bakeGround(biome, area, seed);
    R.bg = (BIOMES[biome] || BIOMES.home).bg;
  };

  // ---------------------------------------------------------------- effects
  R.emit = function (kind, x, y, z, o) {
    o = o || {};
    const add = function (p) { if (R.fx.length < 600) R.fx.push(p); };
    const rnd = Math.random;
    if (kind === 'spark') {
      for (let i = 0; i < 5; i++) add({ k: 'dot', x: x, y: y, z: z || 10, vx: (rnd() - 0.5) * 3, vy: (rnd() - 0.5) * 3, vz: 30 + rnd() * 50, g: 160, life: 0.35, max: 0.35, col: o.col || '#ffe08a', size: 1.6 });
    } else if (kind === 'boom') {
      const r = o.r || 1;
      add({ k: 'flash', x: x, y: y, z: z || 6, life: 0.25, max: 0.25, size: 18 + r * 22, col: o.col || '#ffd27a' });
      add({ k: 'ring', x: x, y: y, z: 0, life: 0.45, max: 0.45, size: r, col: 'rgba(255,230,180,' });
      for (let i = 0; i < 10 + r * 6; i++) add({ k: 'fire', x: x + (rnd() - 0.5) * r * 0.6, y: y + (rnd() - 0.5) * r * 0.6, z: (z || 6) + rnd() * 8, vx: (rnd() - 0.5) * 2.5 * r, vy: (rnd() - 0.5) * 2.5 * r, vz: 20 + rnd() * 50, g: 30, life: 0.5 + rnd() * 0.4, max: 0.9, size: 4 + rnd() * 6, col: rnd() < 0.5 ? '#ff9b3d' : '#ffd34d' });
      for (let i = 0; i < 6; i++) add({ k: 'smoke', x: x, y: y, z: (z || 6) + 10, vx: (rnd() - 0.5) * 0.8, vy: (rnd() - 0.5) * 0.8, vz: 18 + rnd() * 16, g: 0, life: 1.2 + rnd() * 0.8, max: 2, size: 6 + rnd() * 6, col: '#6b6560' });
      R.shake = Math.min(8, R.shake + r * 2.5);
    } else if (kind === 'debris') {
      const n = o.n || 14;
      for (let i = 0; i < n; i++) add({ k: 'chunk', x: x + (rnd() - 0.5) * (o.w || 1), y: y + (rnd() - 0.5) * (o.w || 1), z: 10 + rnd() * 20, vx: (rnd() - 0.5) * 4, vy: (rnd() - 0.5) * 4, vz: 60 + rnd() * 90, g: 260, life: 0.9 + rnd() * 0.5, max: 1.4, size: 2 + rnd() * 3.5, col: rnd() < 0.5 ? '#8a7e70' : '#6b5f52' });
      for (let i = 0; i < 10; i++) add({ k: 'smoke', x: x + (rnd() - 0.5) * (o.w || 1), y: y + (rnd() - 0.5) * (o.w || 1), z: 8, vx: (rnd() - 0.5) * 0.6, vy: (rnd() - 0.5) * 0.6, vz: 14 + rnd() * 20, g: 0, life: 1.6 + rnd(), max: 2.6, size: 8 + rnd() * 8, col: '#9a948c' });
      R.shake = Math.min(8, R.shake + 3);
    } else if (kind === 'smoke') {
      add({ k: 'smoke', x: x, y: y, z: z || 8, vx: (rnd() - 0.5) * 0.3, vy: (rnd() - 0.5) * 0.3, vz: 14 + rnd() * 10, g: 0, life: 1.5, max: 1.5, size: 5 + rnd() * 5, col: o.col || '#5d5853' });
    } else if (kind === 'dust') {
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; add({ k: 'smoke', x: x, y: y, z: 2, vx: Math.cos(a) * 1.4, vy: Math.sin(a) * 1.4, vz: 6, g: 0, life: 0.5, max: 0.5, size: 3 + rnd() * 2, col: '#d8c9a8' }); }
    } else if (kind === 'heal') {
      for (let i = 0; i < 3; i++) add({ k: 'plus', x: x + (rnd() - 0.5) * 1.5, y: y + (rnd() - 0.5) * 1.5, z: 10, vx: 0, vy: 0, vz: 22, g: 0, life: 0.8, max: 0.8, size: 3, col: '#5dff8f' });
    } else if (kind === 'text') {
      add({ k: 'text', x: x, y: y, z: z || 40, vx: 0, vy: 0, vz: 26, g: 0, life: 1.4, max: 1.4, text: o.text, col: o.col || '#fff', size: o.size || 15 });
    } else if (kind === 'coins') {
      for (let i = 0; i < 8; i++) add({ k: 'coin', x: x, y: y, z: z || 30, vx: (rnd() - 0.5) * 2, vy: (rnd() - 0.5) * 2, vz: 70 + rnd() * 60, g: 220, life: 0.8, max: 0.8, size: 3, col: o.col || '#f2c23a' });
    } else if (kind === 'poof') {
      for (let i = 0; i < 6; i++) add({ k: 'smoke', x: x, y: y, z: 8, vx: (rnd() - 0.5) * 1.2, vy: (rnd() - 0.5) * 1.2, vz: 10 + rnd() * 12, g: 0, life: 0.7, max: 0.7, size: 4 + rnd() * 3, col: '#cfc8c0' });
    } else if (kind === 'muzzle') {
      add({ k: 'flash', x: x, y: y, z: z || 26, life: 0.08, max: 0.08, size: 10, col: '#fff2b0' });
    }
  };

  R.pulse = function (id) { pulses.set(id, performance.now()); };
  R.recoil = function (id) { recoil.set(id, performance.now()); };

  function updateFx(dt) {
    const F = R.fx;
    let w = 0;
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
      F[w++] = p;
    }
    F.length = w;
    R.shake = Math.max(0, R.shake - dt * 20);
  }

  function drawFx(ctx, z) {
    R.fx.forEach(function (p) {
      const s = R.toScreen(p.x, p.y, p.z);
      const f = p.life / p.max;
      if (p.k === 'dot' || p.k === 'chunk' || p.k === 'coin') {
        ctx.fillStyle = p.col;
        const sz = p.size * z;
        if (p.k === 'coin') { ctx.beginPath(); ctx.ellipse(s[0], s[1], sz * 1.2, sz, 0, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(s[0] - sz / 2, s[1] - sz / 2, sz, sz);
      } else if (p.k === 'fire') {
        ctx.globalAlpha = f;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(s[0], s[1], p.size * z * (0.5 + f * 0.5), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.k === 'smoke') {
        ctx.globalAlpha = f * 0.55;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(s[0], s[1], p.size * z * (1.6 - f * 0.6), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.k === 'flash') {
        const g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], p.size * z);
        g.addColorStop(0, 'rgba(255,255,230,' + f + ')'); g.addColorStop(0.4, Spr.alpha(p.col, f * 0.8)); g.addColorStop(1, 'rgba(255,160,60,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s[0], s[1], p.size * z, 0, Math.PI * 2); ctx.fill();
      } else if (p.k === 'ring') {
        const r = (1 - f) * (p.size * 1.6 + 0.6);
        ctx.strokeStyle = p.col + (f * 0.8) + ')'; ctx.lineWidth = 3 * z;
        ctx.beginPath(); ctx.ellipse(s[0], s[1], r * HW * 1.41 * z, r * HH * 1.41 * z, 0, 0, Math.PI * 2); ctx.stroke();
      } else if (p.k === 'plus') {
        ctx.globalAlpha = f; ctx.fillStyle = p.col;
        const q = p.size * z;
        ctx.fillRect(s[0] - q * 0.35, s[1] - q, q * 0.7, q * 2); ctx.fillRect(s[0] - q, s[1] - q * 0.35, q * 2, q * 0.7);
        ctx.globalAlpha = 1;
      } else if (p.k === 'text') {
        ctx.globalAlpha = Math.min(1, f * 2);
        ctx.font = '800 ' + Math.round(p.size * Math.max(0.8, z)) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.strokeText(p.text, s[0], s[1]);
        ctx.fillStyle = p.col; ctx.fillText(p.text, s[0], s[1]);
        ctx.globalAlpha = 1;
      }
    });
  }

  // ---------------------------------------------------------------- scene drawing
  function tileQuad(ctx, x0, y0, x1, y1) {
    const a = R.toScreen(x0, y0), b = R.toScreen(x1, y0), c = R.toScreen(x1, y1), d = R.toScreen(x0, y1);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
  }

  function drawGrid(ctx, area, alphaV) {
    ctx.strokeStyle = 'rgba(255,255,255,' + alphaV + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = area.x0; x <= area.x1; x++) { const a = R.toScreen(x, area.y0), b = R.toScreen(x, area.y1); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    for (let y = area.y0; y <= area.y1; y++) { const a = R.toScreen(area.x0, y), b = R.toScreen(area.x1, y); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.stroke();
  }

  // Red tint over tiles where troops cannot be deployed (merged into horizontal runs).
  function drawDeployMask(ctx, mask, a) {
    ctx.fillStyle = 'rgba(255,70,60,' + a + ')';
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
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,90,80,' + Math.min(1, a * 2.5) + ')';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function rangeEllipse(ctx, x, y, r, col, fill) {
    const c = R.toScreen(x, y), z = R.cam.zoom;
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], r * HW * Math.SQRT2 * z, r * HH * Math.SQRT2 * z, 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawBar(ctx, x, y, w, frac, col, bg) {
    ctx.fillStyle = bg || 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 6);
    ctx.fillStyle = col;
    ctx.fillRect(x - w / 2, y, w * U.clamp(frac, 0, 1), 4);
  }

  function buildingSprite(b) {
    let variant = 'normal';
    if (b.ruin) variant = 'ruin';
    else if (b.level < 1) variant = 'build';
    return Spr.building(b.type, Math.max(1, b.level), b.rot, b.team, variant, b.mask || 0);
  }

  function drawBuilding(ctx, b, time) {
    const z = R.cam.zoom;
    const s = R.toScreen(b.x, b.y);
    const spr = buildingSprite(b);
    const x = s[0] - spr.ox * z, y = s[1] - spr.oy * z, w = spr.w * z, h = spr.h * z;
    if (x > R.W || y > R.H || x + w < 0 || y + h < 0) return;
    if (b.alpha != null) ctx.globalAlpha = b.alpha;
    ctx.drawImage(spr.canvas, x, y, w, h);
    if (!b.ruin && b.level >= 1) {
      ctx.save();
      ctx.translate(s[0], s[1]);
      ctx.scale(z, z);
      Spr.drawLive(ctx, b, b.info || {}, time);
      ctx.restore();
    }
    if (b.alpha != null) ctx.globalAlpha = 1;
    if (b.hitFlash) {
      ctx.globalAlpha = 0.25;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(spr.canvas, x, y, w, h);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
  }

  function drawUnit(ctx, u, time) {
    const s = R.toScreen(u.x, u.y);
    const z = R.cam.zoom;
    if (s[0] < -40 || s[1] < -60 || s[0] > R.W + 40 || s[1] > R.H + 40) return;
    ctx.save();
    ctx.translate(s[0], s[1]);
    const k = Math.max(z, 0.8) * 1.1;
    ctx.scale(k, k);
    Spr.drawUnit(ctx, u.type, u.team, time + u.id * 0.37, u);
    ctx.restore();
  }

  function drawProjectile(ctx, p) {
    const z = R.cam.zoom;
    if (p.k === 'shell') {
      const f = p.f;
      const h = 30 + 170 * f * (1 - f) * 4 * 0.25;
      const g = R.toScreen(p.x, p.y, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(g[0], g[1], 5 * z, 2.5 * z, 0, 0, Math.PI * 2); ctx.fill();
      const s = R.toScreen(p.x, p.y, h);
      ctx.fillStyle = '#2b2b2b'; ctx.beginPath(); ctx.arc(s[0], s[1], 5.5 * z, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff9b3d'; ctx.beginPath(); ctx.arc(s[0] + 2 * z, s[1] - 2 * z, 1.6 * z, 0, Math.PI * 2); ctx.fill();
      return;
    }
    const s = R.toScreen(p.x, p.y, p.z);
    if (p.k === 'ball') {
      const t = R.toScreen(p.x - p.dx * 0.5, p.y - p.dy * 0.5, p.z);
      ctx.strokeStyle = 'rgba(80,80,80,0.35)'; ctx.lineWidth = 4 * z;
      ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
      ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(s[0], s[1], 3.5 * z, 0, Math.PI * 2); ctx.fill();
    } else if (p.k === 'bolt' || p.k === 'arrow') {
      const t = R.toScreen(p.x - p.dx * 0.6, p.y - p.dy * 0.6, p.z + (p.dz || 0) * 0.6);
      ctx.strokeStyle = p.k === 'bolt' ? '#5b3a1e' : '#6e4b2a'; ctx.lineWidth = 2 * z;
      ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
      ctx.fillStyle = '#d9dde2'; ctx.beginPath(); ctx.arc(s[0], s[1], 1.5 * z, 0, Math.PI * 2); ctx.fill();
    } else if (p.k === 'orb') {
      const g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], 9 * z);
      g.addColorStop(0, 'rgba(255,240,255,1)'); g.addColorStop(0.35, 'rgba(200,120,255,0.9)'); g.addColorStop(1, 'rgba(160,80,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s[0], s[1], 9 * z, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBeam(ctx, a, b, time) {
    const pts = [a];
    const n = 7;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      pts.push([a[0] + (b[0] - a[0]) * t + (Math.random() - 0.5) * 10, a[1] + (b[1] - a[1]) * t + (Math.random() - 0.5) * 10]);
    }
    pts.push(b);
    [[7, 'rgba(120,200,255,0.35)'], [3, 'rgba(190,235,255,0.9)'], [1.2, '#ffffff']].forEach(function (st) {
      ctx.strokeStyle = st[1]; ctx.lineWidth = st[0] * R.cam.zoom;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    });
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
   * scene: { buildings, units, projectiles, beams, ghost, grid, area, deployMask, deployAlpha,
   *          ranges, selectedId, bars (bool), labels }
   */
  R.draw = function (scene, time, dt) {
    const ctx = R.ctx;
    const z = R.cam.zoom;
    updateFx(dt);
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.fillStyle = R.bg || '#3d6b2a';
    ctx.fillRect(0, 0, R.W, R.H);
    let sx = 0, sy = 0;
    if (R.shake > 0.1) { sx = (Math.random() - 0.5) * R.shake; sy = (Math.random() - 0.5) * R.shake; ctx.translate(sx, sy); }
    if (ground) {
      const o = R.toScreen(0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(ground.canvas, o[0] - ground.ox * z, o[1] - ground.oy * z, ground.canvas.width * z, ground.canvas.height * z);
    }
    if (scene.grid && scene.area) drawGrid(ctx, scene.area, scene.gridAlpha || 0.16);
    if (scene.deployMask) drawDeployMask(ctx, scene.deployMask, scene.deployAlpha || 0.12);
    // footprint highlights under buildings
    (scene.highlights || []).forEach(function (h) {
      ctx.beginPath();
      tileQuad(ctx, h.x, h.y, h.x + h.w, h.y + h.h);
      ctx.fillStyle = h.fill; ctx.fill();
      ctx.strokeStyle = h.stroke; ctx.lineWidth = 2; ctx.stroke();
    });
    (scene.ranges || []).forEach(function (r) {
      rangeEllipse(ctx, r.x, r.y, r.r, r.col || 'rgba(255,255,255,0.55)', r.fill || 'rgba(255,255,255,0.06)');
      if (r.min) rangeEllipse(ctx, r.x, r.y, r.min, 'rgba(255,120,120,0.5)', 'rgba(255,80,80,0.08)');
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
    // front decoration
    frontDecor.forEach(function (s) {
      const p = R.toScreen(s.x, s.y);
      if (p[0] < -60 || p[0] > R.W + 60 || p[1] < -10 || p[1] > R.H + 120) return;
      ctx.drawImage(decorSprite(s.kind, s.v), p[0] - 40 * z, p[1] - 100 * z, 80 * z, 110 * z);
    });
    (scene.projectiles || []).forEach(function (p) { drawProjectile(ctx, p); });
    (scene.beams || []).forEach(function (b) { drawBeam(ctx, R.toScreen(b.x0, b.y0, b.z0), R.toScreen(b.x1, b.y1, b.z1), time); });
    drawFx(ctx, z);
    // bars, timers and bubbles
    scene.buildings.forEach(function (b) {
      const top = R.toScreen(b.x + b.w / 2, b.y + b.h / 2, b.barZ || 48);
      if (top[0] < -60 || top[0] > R.W + 60 || top[1] < -30 || top[1] > R.H + 30) return;
      if (b.hpFrac != null && b.hpFrac < 1 && !b.ruin) drawBar(ctx, top[0], top[1], Math.max(24, b.w * 14) * Math.max(0.7, z), b.hpFrac, b.hpFrac > 0.5 ? '#5ee25e' : b.hpFrac > 0.25 ? '#ffd34d' : '#ff5a4a');
      if (b.timer) {
        const w = Math.max(40, b.w * 16) * Math.max(0.75, z);
        drawBar(ctx, top[0], top[1] - 4, w, b.timer.frac, '#5fc4ff');
        ctx.font = '700 ' + Math.round(11 * Math.max(0.85, z)) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(b.timer.text, top[0], top[1] - 8);
        ctx.fillStyle = '#fff'; ctx.fillText(b.timer.text, top[0], top[1] - 8);
      }
      if (b.bubble) {
        const by = top[1] - 18 * Math.max(0.8, z) + Math.sin(time * 3 + b.id) * 2;
        const r = 11 * Math.max(0.8, z);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.beginPath(); ctx.arc(top[0], by, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = b.bubble === 'credits' ? '#f2c23a' : b.bubble === 'energy' ? '#b56cff' : '#ff5a4a';
        if (b.bubble === 'energy') {
          ctx.beginPath(); ctx.moveTo(top[0] + 1, by - r * 0.7); ctx.lineTo(top[0] - r * 0.4, by + 1); ctx.lineTo(top[0], by + 1); ctx.lineTo(top[0] - 1, by + r * 0.7); ctx.lineTo(top[0] + r * 0.45, by - 1); ctx.lineTo(top[0], by - 1); ctx.closePath(); ctx.fill();
        } else if (b.bubble === 'credits') {
          ctx.beginPath(); ctx.arc(top[0], by, r * 0.6, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#a77712'; ctx.lineWidth = 1.2; ctx.stroke();
        } else {
          ctx.font = '800 ' + Math.round(r * 1.3) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', top[0], by + 1); ctx.textBaseline = 'alphabetic';
        }
      }
    });
    if (scene.unitBars) {
      (scene.units || []).forEach(function (u) {
        if (u.hp >= u.maxHp) return;
        const s = R.toScreen(u.x, u.y, u.type === 'bruiser' ? 36 : u.type === 'mender' ? 34 : 28);
        drawBar(ctx, s[0], s[1], 16 * Math.max(0.8, z), u.hp / u.maxHp, u.team === '#3f86e8' ? '#6fd3ff' : '#ff6a5a');
      });
    }
    if (sx || sy) ctx.translate(-sx, -sy);
  };

  CS.Render = R;
})(window.CS = window.CS || {});
