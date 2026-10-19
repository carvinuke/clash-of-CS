/*
 * Procedural isometric art. Every building, troop and icon is drawn with Canvas 2D at runtime,
 * so the game ships without image files. Static building bodies are rendered once per
 * (type, level, rotation, team, state) into an oversampled offscreen canvas; moving parts
 * (turret heads, flames, liquid levels, crystals) are drawn live on top each frame.
 *
 * Local building coordinates: u,v in tiles across the footprint (0..w, 0..h), z in pixels up.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U;
  const HW = 32, HH = 16, SC = 2;
  const Spr = { HW: HW, HH: HH, SC: SC };

  // ---------------------------------------------------------------- color helpers
  const rgbCache = {};
  function rgbOf(hex) {
    let c = rgbCache[hex];
    if (c) return c;
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    c = rgbCache[hex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return c;
  }
  // f > 0 mixes toward white, f < 0 toward black.
  function shade(hex, f) {
    const c = rgbOf(hex), t = f < 0 ? 0 : 255, p = Math.abs(f);
    return 'rgb(' + Math.round(c[0] + (t - c[0]) * p) + ',' + Math.round(c[1] + (t - c[1]) * p) + ',' + Math.round(c[2] + (t - c[2]) * p) + ')';
  }
  function alpha(hex, a) { const c = rgbOf(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  Spr.shade = shade;
  Spr.alpha = alpha;

  const EDGE = 'rgba(28,22,18,0.38)';
  const STONE = '#a7a196', DARKSTONE = '#7c7a75', WOOD = '#a8743f', METAL = '#8e9aa6', GOLD = '#f2c23a', ENERGY = '#b56cff', IRON = '#4b5058';

  // ---------------------------------------------------------------- iso primitives
  function P(u, v, z) { return [(u - v) * HW, (u + v) * HH - (z || 0)]; }
  Spr.P = P;

  function poly(ctx, pts, fill, edge) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 0.8; ctx.stroke(); }
  }

  function box(ctx, u0, v0, u1, v1, z0, z1, col, o) {
    o = o || {};
    const e = o.edge === false ? null : EDGE;
    poly(ctx, [P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1)], o.left || shade(col, 0), e);
    poly(ctx, [P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z1), P(u1, v0, z1)], o.right || shade(col, -0.3), e);
    poly(ctx, [P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)], o.top || shade(col, 0.2), e);
  }

  function radii(r) { return [r * HW * Math.SQRT2, r * HH * Math.SQRT2]; }

  function cyl(ctx, u, v, r, z0, z1, col, topFill) {
    const b = P(u, v, z0), t = P(u, v, z1), rr = radii(r);
    const g = ctx.createLinearGradient(b[0] - rr[0], 0, b[0] + rr[0], 0);
    g.addColorStop(0, shade(col, 0.12));
    g.addColorStop(0.45, shade(col, 0));
    g.addColorStop(1, shade(col, -0.4));
    ctx.beginPath();
    ctx.moveTo(b[0] - rr[0], b[1]);
    ctx.ellipse(b[0], b[1], rr[0], rr[1], 0, Math.PI, 0, true);
    ctx.lineTo(t[0] + rr[0], t[1]);
    ctx.ellipse(t[0], t[1], rr[0], rr[1], 0, 0, Math.PI, false);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = EDGE; ctx.lineWidth = 0.8; ctx.stroke();
    if (topFill !== false) {
      ctx.beginPath();
      ctx.ellipse(t[0], t[1], rr[0], rr[1], 0, 0, Math.PI * 2);
      ctx.fillStyle = topFill || shade(col, 0.22);
      ctx.fill();
      ctx.stroke();
    }
  }

  function disk(ctx, u, v, z, r, fill, edge) {
    const c = P(u, v, z), rr = radii(r);
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 0.8; ctx.stroke(); }
  }

  function cone(ctx, u, v, r, z0, z1, col) {
    const b = P(u, v, z0), a = P(u, v, z1), rr = radii(r);
    const g = ctx.createLinearGradient(b[0] - rr[0], 0, b[0] + rr[0], 0);
    g.addColorStop(0, shade(col, 0.15));
    g.addColorStop(0.5, shade(col, 0));
    g.addColorStop(1, shade(col, -0.42));
    ctx.beginPath();
    ctx.moveTo(b[0] - rr[0], b[1]);
    ctx.ellipse(b[0], b[1], rr[0], rr[1], 0, Math.PI, 0, true);
    ctx.lineTo(a[0], a[1]);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = EDGE; ctx.lineWidth = 0.8; ctx.stroke();
  }

  function pyramid(ctx, u0, v0, u1, v1, z0, z1, col) {
    const ap = P((u0 + u1) / 2, (v0 + v1) / 2, z1);
    const A = P(u0, v0, z0), B = P(u1, v0, z0), Cc = P(u1, v1, z0), D = P(u0, v1, z0);
    poly(ctx, [A, B, ap], shade(col, -0.12), EDGE);
    poly(ctx, [D, A, ap], shade(col, 0.12), EDGE);
    poly(ctx, [B, Cc, ap], shade(col, -0.34), EDGE);
    poly(ctx, [Cc, D, ap], shade(col, 0.04), EDGE);
  }

  // Pitched roof. alongV=false: ridge runs along u.
  function gable(ctx, u0, v0, u1, v1, z0, z1, col, wallCol, alongV) {
    if (!alongV) {
      const vm = (v0 + v1) / 2;
      poly(ctx, [P(u0, v0, z0), P(u1, v0, z0), P(u1, vm, z1), P(u0, vm, z1)], shade(col, -0.15), EDGE);
      poly(ctx, [P(u1, v0, z0), P(u1, v1, z0), P(u1, vm, z1)], shade(wallCol, -0.3), EDGE);
      poly(ctx, [P(u0, v1, z0), P(u1, v1, z0), P(u1, vm, z1), P(u0, vm, z1)], shade(col, 0.06), EDGE);
    } else {
      const um = (u0 + u1) / 2;
      poly(ctx, [P(u0, v0, z0), P(u0, v1, z0), P(um, v1, z1), P(um, v0, z1)], shade(col, 0.1), EDGE);
      poly(ctx, [P(u0, v1, z0), P(u1, v1, z0), P(um, v1, z1)], shade(wallCol, 0), EDGE);
      poly(ctx, [P(u1, v0, z0), P(u1, v1, z0), P(um, v1, z1), P(um, v0, z1)], shade(col, -0.3), EDGE);
    }
  }

  // Draws on a vertical face: 'L' face is v = const (x runs along +u), 'R' face is u = const (x runs along +v).
  function decal(ctx, side, u, v, z, fn) {
    const o = P(u, v, z);
    ctx.save();
    ctx.transform(side === 'L' ? 0.894 : -0.894, 0.447, 0, 1, o[0], o[1]);
    fn(ctx);
    ctx.restore();
  }

  function archDoor(ctx, w, h, fill) {
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(-w / 2, -h + w / 2);
    ctx.arc(0, -h + w / 2, w / 2, Math.PI, 0);
    ctx.lineTo(w / 2, 0);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  function windowRect(ctx, w, h, glow) {
    ctx.fillStyle = glow || '#2b2622';
    ctx.fillRect(-w / 2, -h, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(-w / 2, -h, w, h);
  }

  function shadow(ctx, w, h) {
    ctx.save();
    ctx.translate(5, 3);
    poly(ctx, [P(0.1, 0.1, 0), P(w - 0.05, 0.1, 0), P(w - 0.05, h - 0.05, 0), P(0.1, h - 0.05, 0)], 'rgba(20,30,10,0.22)');
    ctx.restore();
  }

  function flag(ctx, u, v, z, height, col) {
    const a = P(u, v, z), b = P(u, v, z + height);
    ctx.strokeStyle = '#3b2b20';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.quadraticCurveTo(b[0] + 7, b[1] + 1, b[0] + 13, b[1] + 4);
    ctx.quadraticCurveTo(b[0] + 7, b[1] + 6, b[0], b[1] + 9);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  function tierOf(lv, max) { return lv / max <= 0.34 ? 0 : lv / max <= 0.67 ? 1 : 2; }
  const WALLS = ['#c19463', '#d5cdbf', '#7c8797'];
  const TRIMS = ['#8a5f36', '#a39c90', '#e8b93c'];

  // ---------------------------------------------------------------- building bodies
  const DRAW = {};

  DRAW.core = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 6), wall = WALLS[t], trim = TRIMS[t];
    shadow(ctx, 4, 4);
    box(ctx, 0.12, 0.12, 3.88, 3.88, 0, 7, DARKSTONE);
    const towers = t >= 1 ? [[0.62, 0.62], [3.38, 0.62], [0.62, 3.38], [3.38, 3.38]] : [];
    if (towers.length) { cyl(ctx, 0.62, 0.62, 0.42, 7, 60, wall); cone(ctx, 0.62, 0.62, 0.52, 60, 78, team); }
    box(ctx, 0.55, 0.55, 3.45, 3.45, 7, 46, wall);
    box(ctx, 0.45, 0.45, 3.55, 3.55, 46, 52, trim);
    decal(ctx, 'L', 2.0, 3.45, 7, function (c) { archDoor(c, 15, 24, '#3a281b'); c.fillStyle = trim; c.fillRect(-9, -26, 18, 3); });
    [1.0, 3.0].forEach(function (u) { decal(ctx, 'L', u, 3.45, 30, function (c) { windowRect(c, 5, 8, alpha(team, 0.85)); }); });
    [1.2, 2.4].forEach(function (v) { decal(ctx, 'R', 3.45, v, 30, function (c) { windowRect(c, 5, 8, alpha(team, 0.6)); }); });
    pyramid(ctx, 0.55, 0.55, 3.45, 3.45, 52, 76 + t * 5, team);
    if (towers.length) {
      [[3.38, 0.62], [0.62, 3.38], [3.38, 3.38]].forEach(function (p) {
        cyl(ctx, p[0], p[1], 0.42, 7, 60, wall);
        cone(ctx, p[0], p[1], 0.52, 60, 78, team);
      });
    }
    if (t === 2) { box(ctx, 1.9, 1.9, 2.1, 2.1, 76 + t * 5, 84 + t * 5, GOLD); }
    flag(ctx, 0.55, 3.45, 52, 26, team);
  };

  DRAW.mint = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 8), wall = WALLS[t];
    shadow(ctx, 3, 3);
    box(ctx, 0.15, 0.15, 2.85, 2.85, 0, 5, STONE);
    box(ctx, 0.55, 0.62, 0.9, 0.97, 28, 50, '#8f7f73');
    box(ctx, 0.35, 0.35, 2.05, 1.95, 5, 28, wall);
    gable(ctx, 0.28, 0.28, 2.12, 2.02, 28, 42, team, wall, false);
    decal(ctx, 'L', 1.2, 1.95, 16, function (c) {
      c.beginPath(); c.arc(0, -3, 8, 0, Math.PI * 2); c.fillStyle = GOLD; c.fill();
      c.strokeStyle = '#a77712'; c.lineWidth = 1.2; c.stroke();
      c.fillStyle = '#a77712'; c.font = 'bold 10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('C', 0, -2.5);
    });
    decal(ctx, 'R', 2.05, 0.75, 5, function (c) { archDoor(c, 9, 15, '#3a281b'); });
    // coin tray where the pile sits
    disk(ctx, 2.25, 2.25, 5, 0.5, '#6b5a43', EDGE);
  };

  DRAW.well = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 8), wall = WALLS[t];
    shadow(ctx, 3, 3);
    box(ctx, 0.15, 0.15, 2.85, 2.85, 0, 5, STONE);
    box(ctx, 0.45, 1.3, 0.75, 1.7, 5, 50, WOOD);
    box(ctx, 1.3, 0.45, 1.7, 0.75, 5, 50, WOOD);
    cyl(ctx, 1.5, 1.5, 1.02, 5, 17, wall, '#2a2140');
    disk(ctx, 1.5, 1.5, 15, 0.8, alpha(ENERGY, 0.9));
    box(ctx, 0.45, 0.45, 1.7, 0.75, 50, 55, '#8a5a2f');
    box(ctx, 0.45, 0.75, 0.75, 1.7, 50, 55, '#8a5a2f');
    box(ctx, 2.25, 1.3, 2.55, 1.7, 5, 50, WOOD);
    box(ctx, 1.3, 2.25, 1.7, 2.55, 5, 50, WOOD);
    flag(ctx, 2.4, 2.4, 5, 30, team);
  };

  DRAW.vault = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 7);
    const body = ['#8f7b62', '#9aa4ae', '#5e6a7a'][t];
    shadow(ctx, 3, 3);
    box(ctx, 0.15, 0.15, 2.85, 2.85, 0, 5, STONE);
    box(ctx, 0.35, 0.35, 2.65, 2.65, 5, 30, body);
    box(ctx, 0.3, 0.3, 2.7, 2.7, 30, 34, TRIMS[t]);
    poly(ctx, [P(0.75, 0.75, 34), P(2.25, 0.75, 34), P(2.25, 2.25, 34), P(0.75, 2.25, 34)], '#2a241d');
    decal(ctx, 'L', 1.5, 2.65, 17, function (c) {
      c.beginPath(); c.arc(0, 0, 9.5, 0, Math.PI * 2); c.fillStyle = shade(body, -0.25); c.fill();
      c.strokeStyle = GOLD; c.lineWidth = 1.6; c.stroke();
      c.strokeStyle = '#d9a72a'; c.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 4; c.beginPath(); c.moveTo(Math.cos(a) * 6, Math.sin(a) * 6); c.lineTo(-Math.cos(a) * 6, -Math.sin(a) * 6); c.stroke(); }
    });
    decal(ctx, 'R', 2.65, 1.5, 22, function (c) { c.fillStyle = alpha(team, 0.9); c.fillRect(-7, -4, 14, 8); });
  };

  DRAW.tank = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 7);
    const metal = ['#8a7b6a', METAL, '#5c6878'][t];
    shadow(ctx, 3, 3);
    box(ctx, 0.15, 0.15, 2.85, 2.85, 0, 5, STONE);
    cyl(ctx, 1.5, 1.5, 1.12, 5, 13, metal);
    cyl(ctx, 1.5, 1.5, 0.96, 13, 50, '#cfe3ea', 'rgba(220,236,242,0.55)');
    box(ctx, 2.35, 0.55, 2.7, 0.9, 5, 20, team);
  };

  DRAW.barracks = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 5), wall = WALLS[t];
    const alongV = h > w;
    shadow(ctx, w, h);
    box(ctx, 0.15, 0.15, w - 0.15, h - 0.15, 0, 5, STONE);
    box(ctx, 0.4, 0.4, w - 0.4, h - 0.4, 5, 28, wall);
    gable(ctx, 0.3, 0.3, w - 0.3, h - 0.3, 28, 48, team, wall, alongV);
    const emblem = function (c) {
      archDoor(c, 14, 20, '#3a281b');
      c.strokeStyle = '#d8d8d8'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-9, -32); c.lineTo(9, -22); c.moveTo(9, -32); c.lineTo(-9, -22); c.stroke();
    };
    if (!alongV) decal(ctx, 'L', w / 2, h - 0.4, 5, emblem);
    else decal(ctx, 'R', w - 0.4, h / 2, 5, emblem);
    flag(ctx, 0.25, h - 0.25, 5, 40, team);
    flag(ctx, w - 0.25, 0.25, 5, 40, team);
    if (t >= 1) flag(ctx, w - 0.25, h - 0.25, 5, 34, team);
  };

  DRAW.garrison = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 6);
    poly(ctx, [P(0.2, 0.2, 0), P(3.8, 0.2, 0), P(3.8, 3.8, 0), P(0.2, 3.8, 0)], 'rgba(120,92,58,0.55)');
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      disk(ctx, 2 + Math.cos(a) * 1.75, 2 + Math.sin(a) * 1.75, 1, 0.13, shade(STONE, -0.1), EDGE);
    }
    const tent = function (u, v) {
      pyramid(ctx, u - 0.55, v - 0.55, u + 0.55, v + 0.55, 0, 30 + t * 4, team);
      decal(ctx, 'L', u, v + 0.55, 0, function (c) { c.fillStyle = 'rgba(30,20,10,0.7)'; c.beginPath(); c.moveTo(-4, 0); c.lineTo(0, -12); c.lineTo(4, 0); c.fill(); });
    };
    tent(0.9, 0.9); tent(3.1, 0.9); tent(0.9, 3.1);
    // log seats around the fire
    box(ctx, 1.4, 2.65, 2.6, 2.85, 0, 5, WOOD);
    box(ctx, 2.65, 1.4, 2.85, 2.6, 0, 5, WOOD);
    disk(ctx, 2, 2, 0.5, 0.42, '#5a4634', EDGE);
    box(ctx, 3.0, 3.0, 3.35, 3.35, 0, 16, WOOD);
    flag(ctx, 3.55, 3.55, 0, 44, team);
  };

  DRAW.lab = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 5), wall = WALLS[t];
    shadow(ctx, 3, 3);
    box(ctx, 0.15, 0.15, 2.85, 2.85, 0, 5, STONE);
    cyl(ctx, 1.5, 1.5, 1.12, 5, 28, wall);
    const c = P(1.5, 1.5, 28), rr = radii(1.0);
    const g = ctx.createLinearGradient(c[0] - rr[0], c[1] - rr[0], c[0] + rr[0], c[1]);
    g.addColorStop(0, '#d9f3ff'); g.addColorStop(0.5, '#7cc7ea'); g.addColorStop(1, '#3a7aa6');
    ctx.beginPath(); ctx.ellipse(c[0], c[1], rr[0], rr[0] * 0.95, 0, Math.PI, 0); ctx.closePath();
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = EDGE; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(c[0], c[1], rr[0] * 0.7, rr[0] * 0.66, 0, Math.PI * 1.1, Math.PI * 1.45); ctx.stroke();
    ctx.strokeStyle = '#4b4f57'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(c[0] + 4, c[1] - 20); ctx.lineTo(c[0] + 22, c[1] - 36); ctx.stroke();
    decal(ctx, 'L', 1.5, 2.6, 5, function (k) { archDoor(k, 10, 16, '#2d3340'); });
    cyl(ctx, 2.55, 0.55, 0.16, 5, 16, '#62e08a'); cyl(ctx, 2.5, 0.95, 0.14, 5, 13, '#ff6fae');
    flag(ctx, 0.35, 2.65, 5, 30, team);
  };

  DRAW.station = function (ctx, w, h, lv, team) {
    shadow(ctx, 2, 2);
    box(ctx, 0.12, 0.12, 1.88, 1.88, 0, 4, STONE);
    box(ctx, 1.62, 0.25, 1.82, 0.45, 4, 44, '#d29a34');
    const a = P(1.72, 0.35, 44), b = P(1.72, 1.45, 46);
    ctx.strokeStyle = '#d29a34'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0], b[1] + 16); ctx.stroke();
    box(ctx, 0.3, 0.3, 1.45, 1.55, 4, 22, WALLS[tierOf(lv, 4)]);
    pyramid(ctx, 0.22, 0.22, 1.53, 1.63, 22, 38, team);
    decal(ctx, 'L', 0.85, 1.55, 4, function (c) {
      archDoor(c, 8, 12, '#3a281b');
      c.strokeStyle = '#e8e8e8'; c.lineWidth = 2; c.beginPath(); c.moveTo(-5, -20); c.lineTo(5, -14); c.stroke();
    });
  };

  DRAW.blaster = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 7);
    shadow(ctx, 3, 3);
    cyl(ctx, 1.5, 1.5, 1.32, 0, 12, ['#9b9184', STONE, '#6b7280'][t]);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      box(ctx, 1.5 + Math.cos(a) * 1.15 - 0.12, 1.5 + Math.sin(a) * 1.15 - 0.12, 1.5 + Math.cos(a) * 1.15 + 0.12, 1.5 + Math.sin(a) * 1.15 + 0.12, 12, 16, TRIMS[t]);
    }
    cyl(ctx, 1.5, 1.5, 0.72, 12, 21, ['#5a5f66', '#6d7781', '#3e4652'][t]);
    disk(ctx, 1.5, 1.5, 21, 0.55, alpha(team, 0.9));
  };

  DRAW.spire = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 7), wall = ['#b48a5a', '#cdc5b7', '#7b8595'][t];
    shadow(ctx, 3, 3);
    box(ctx, 0.3, 0.3, 2.7, 2.7, 0, 6, DARKSTONE);
    box(ctx, 0.85, 0.85, 2.15, 2.15, 6, 54, wall);
    decal(ctx, 'L', 1.5, 2.15, 34, function (c) { windowRect(c, 3, 9); });
    decal(ctx, 'R', 2.15, 1.5, 34, function (c) { windowRect(c, 3, 9); });
    box(ctx, 0.55, 0.55, 2.45, 2.45, 54, 60, TRIMS[t]);
    [[0.65, 0.65], [2.35, 0.65], [0.65, 2.35]].forEach(function (p) { box(ctx, p[0] - 0.08, p[1] - 0.08, p[0] + 0.08, p[1] + 0.08, 60, 78, WOOD); });
    pyramid(ctx, 0.45, 0.45, 2.55, 2.55, 78, 94, team);
    box(ctx, 2.27, 2.27, 2.43, 2.43, 60, 78, WOOD);
  };

  DRAW.mortar = function (ctx, w, h, lv, team) {
    const t = tierOf(lv, 6);
    shadow(ctx, 3, 3);
    cyl(ctx, 1.5, 1.5, 1.28, 0, 10, ['#b49b6c', '#a99f8f', '#6b6f78'][t]);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      disk(ctx, 1.5 + Math.cos(a) * 1.08, 1.5 + Math.sin(a) * 1.08, 11, 0.24, ['#c8ae7c', '#bcb3a3', '#7e838d'][t], EDGE);
    }
    disk(ctx, 1.5, 1.5, 10, 0.72, '#3a332b');
    flag(ctx, 0.4, 2.6, 8, 26, team);
  };

  DRAW.frost = function (ctx, w, h, lv, team) {
    shadow(ctx, 2, 2);
    box(ctx, 0.15, 0.15, 1.85, 1.85, 0, 6, '#9fbfd0');
    const z0 = 6, z1 = 44, a0 = 0.5, a1 = 1.5, b0 = 0.78, b1 = 1.22;
    poly(ctx, [P(a0, a1, z0), P(a1, a1, z0), P(b1, b1, z1), P(b0, b1, z1)], '#c7ecfa', EDGE);
    poly(ctx, [P(a1, a0, z0), P(a1, a1, z0), P(b1, b1, z1), P(b1, b0, z1)], '#86bfd8', EDGE);
    poly(ctx, [P(b0, b0, z1), P(b1, b0, z1), P(b1, b1, z1), P(b0, b1, z1)], '#e8fbff', EDGE);
    decal(ctx, 'L', 1, 1.42, 20, function (c) { c.fillStyle = alpha(team, 0.8); c.fillRect(-3, -10, 6, 10); });
  };

  DRAW.lance = function (ctx, w, h, lv, team) {
    shadow(ctx, 3, 3);
    box(ctx, 0.3, 0.3, 2.7, 2.7, 0, 8, '#4e5560');
    box(ctx, 0.55, 0.55, 2.45, 2.45, 8, 12, '#6b737e');
    cyl(ctx, 1.5, 1.5, 0.45, 12, 54, '#5d6670');
    [18, 27, 36, 45].forEach(function (z) { cyl(ctx, 1.5, 1.5, 0.6, z, z + 3, '#c9853f'); });
    disk(ctx, 1.5, 1.5, 54, 0.3, alpha(team, 0.9));
  };

  DRAW.mine = function (ctx, w, h, lv, team) {
    disk(ctx, 0.5, 0.5, 0.5, 0.3, '#3d3a36', EDGE);
    disk(ctx, 0.5, 0.5, 2, 0.18, '#5c5650', EDGE);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4;
      const p = P(0.5 + Math.cos(a) * 0.3, 0.5 + Math.sin(a) * 0.3, 1);
      ctx.fillStyle = '#26231f'; ctx.beginPath(); ctx.arc(p[0], p[1], 1.6, 0, Math.PI * 2); ctx.fill();
    }
  };

  const WALL_MATS = ['#a87444', '#a9a397', '#c47a4c', '#5e6670', '#8ea2b8', '#3b3644'];
  function drawWall(ctx, lv, mask) {
    const col = WALL_MATS[U.clamp(lv, 1, 6) - 1];
    const H = 12 + lv * 2;
    const cap = lv === 6 ? GOLD : lv === 4 ? '#5ad1c3' : null;
    box(ctx, 0.2, 0.2, 0.8, 0.8, 0, H + 3, col);
    if (lv === 1) pyramid(ctx, 0.2, 0.2, 0.8, 0.8, H + 3, H + 9, col);
    if (cap) box(ctx, 0.25, 0.25, 0.75, 0.75, H + 3, H + 5, cap);
    if (mask & 1) box(ctx, 0.8, 0.3, 1.2, 0.7, 0, H, col);
    if (mask & 2) box(ctx, 0.3, 0.8, 0.7, 1.2, 0, H, col);
  }

  function drawRuin(ctx, w, h, seed, col) {
    poly(ctx, [P(0.1, 0.1, 0), P(w - 0.1, 0.1, 0), P(w - 0.1, h - 0.1, 0), P(0.1, h - 0.1, 0)], 'rgba(48,36,28,0.55)');
    const rng = new U.Rng(seed);
    const n = Math.round(w * h * 2.2);
    for (let i = 0; i < n; i++) {
      const u = rng.range(0.3, w - 0.3), v = rng.range(0.3, h - 0.3), s = rng.range(0.12, 0.3);
      box(ctx, u - s, v - s, u + s, v + s * 0.8, 0, rng.range(3, 9), rng.chance(0.5) ? col : '#6d665e');
    }
    if (w > 1) {
      const a = P(w * 0.3, h * 0.6, 3), b = P(w * 0.75, h * 0.35, 10);
      ctx.strokeStyle = '#5a3d24'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }

  function drawConstruction(ctx, w, h) {
    box(ctx, 0.15, 0.15, w - 0.15, h - 0.15, 0, 5, STONE);
    const posts = [[0.3, 0.3], [w - 0.3, 0.3], [0.3, h - 0.3], [w - 0.3, h - 0.3]];
    posts.forEach(function (p) { box(ctx, p[0] - 0.06, p[1] - 0.06, p[0] + 0.06, p[1] + 0.06, 5, 30, '#b88a52'); });
    ctx.strokeStyle = '#9c7240'; ctx.lineWidth = 2;
    [[posts[0], posts[1]], [posts[0], posts[2]], [posts[1], posts[3]], [posts[2], posts[3]]].forEach(function (pp) {
      const a = P(pp[0][0], pp[0][1], 18), b = P(pp[1][0], pp[1][1], 18);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    });
    box(ctx, w * 0.3, h * 0.3, w * 0.62, h * 0.62, 5, 14, '#c9a46c');
    box(ctx, w * 0.55, h * 0.58, w * 0.8, h * 0.8, 5, 10, '#b98f55');
  }

  const ZMAX = { core: 100, spire: 98, lance: 66, well: 60, tank: 60, lab: 66, mint: 56, barracks: 56, garrison: 50, station: 50, blaster: 40, mortar: 34, frost: 54, vault: 40, mine: 8, wall: 32 };
  const PAD = 8;
  const cache = new Map();

  /*
   * Returns {canvas, ox, oy, w, h}: draw with the footprint's top corner at (sx, sy):
   * ctx.drawImage(c.canvas, sx - c.ox * zoom, sy - c.oy * zoom, c.w * zoom, c.h * zoom)
   * variant: 'normal' | 'ruin' | 'build'. extra: wall neighbour mask.
   */
  Spr.building = function (type, level, rot, team, variant, extra) {
    const key = type + '|' + level + '|' + rot + '|' + team + '|' + variant + '|' + (extra || 0);
    let s = cache.get(key);
    if (s) return s;
    const size = CS.Base.size(type, rot);
    const w = size[0], h = size[1];
    const ext = type === 'wall' ? 1 : 0;
    const zmax = variant === 'normal' ? (ZMAX[type] || 60) : 34;
    const ox = (h + ext) * HW + PAD, oy = zmax + PAD;
    const cw = (w + h + ext * 2) * HW + PAD * 2, ch = (w + h + ext * 2) * HH + zmax + PAD * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(cw * SC);
    canvas.height = Math.ceil(ch * SC);
    const ctx = canvas.getContext('2d');
    ctx.scale(SC, SC);
    ctx.translate(ox, oy);
    ctx.lineJoin = 'round';
    if (variant === 'ruin') drawRuin(ctx, w, h, U.hash(key), type === 'wall' ? WALL_MATS[level - 1] : '#9a8f80');
    else if (variant === 'build') drawConstruction(ctx, w, h);
    else if (type === 'wall') drawWall(ctx, level, extra || 0);
    else DRAW[type](ctx, w, h, level, team);
    s = { canvas: canvas, ox: ox, oy: oy, w: cw, h: ch };
    cache.set(key, s);
    return s;
  };

  Spr.clearCache = function () { cache.clear(); };

  // ---------------------------------------------------------------- live parts (drawn every frame)
  // ctx is already translated to the footprint top corner and scaled by zoom.
  Spr.drawLive = function (ctx, b, info, time) {
    const w = b.w, h = b.h;
    switch (b.type) {
      case 'core': {
        const z = 96 + Math.sin(time * 2) * 4;
        const c = P(2, 2, z);
        const g = ctx.createRadialGradient(c[0], c[1], 1, c[0], c[1], 22);
        g.addColorStop(0, alpha(info.team, 0.55)); g.addColorStop(1, alpha(info.team, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], 22, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(c[0], c[1]);
        ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(8, 0); ctx.lineTo(0, 13); ctx.lineTo(-8, 0); ctx.closePath();
        ctx.fillStyle = shade(info.team, 0.45); ctx.fill();
        ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(8, 0); ctx.lineTo(0, 13); ctx.closePath();
        ctx.fillStyle = shade(info.team, -0.1); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.restore();
        break;
      }
      case 'mint': {
        const fill = info.fill || 0;
        if (fill > 0.02) {
          const r = 0.18 + fill * 0.32;
          cone(ctx, 2.25, 2.25, r, 5, 5 + 4 + fill * 12, GOLD);
        }
        const c = P(0.72, 0.8, 52);
        if (info.active) {
          for (let i = 0; i < 3; i++) {
            const k = (time * 0.6 + i / 3) % 1;
            ctx.fillStyle = 'rgba(220,220,220,' + (0.45 * (1 - k)) + ')';
            ctx.beginPath(); ctx.arc(c[0] + k * 8, c[1] - k * 22, 3 + k * 5, 0, Math.PI * 2); ctx.fill();
          }
        }
        break;
      }
      case 'well': {
        const fill = info.fill || 0;
        const pulse = 0.55 + Math.sin(time * 3) * 0.2;
        const c = P(1.5, 1.5, 15), rr = radii(0.8);
        const g = ctx.createRadialGradient(c[0], c[1], 1, c[0], c[1], rr[0]);
        g.addColorStop(0, 'rgba(240,210,255,' + pulse + ')'); g.addColorStop(1, 'rgba(181,108,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI * 2); ctx.fill();
        const z = 34 + Math.sin(time * 1.7) * 3;
        const k = P(1.5, 1.5, z);
        ctx.save(); ctx.translate(k[0], k[1]);
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(5, 0); ctx.lineTo(0, 9); ctx.lineTo(-5, 0); ctx.closePath();
        ctx.fillStyle = info.active ? '#e3b8ff' : '#8a7a99'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.7; ctx.stroke();
        ctx.restore();
        if (info.active) {
          for (let i = 0; i < 3; i++) {
            const q = (time * 0.5 + i / 3) % 1;
            ctx.fillStyle = 'rgba(214,160,255,' + (0.8 * (1 - q)) + ')';
            ctx.beginPath(); ctx.arc(c[0] + Math.sin(i * 2 + time) * 8, c[1] - q * 30, 1.6, 0, Math.PI * 2); ctx.fill();
          }
        }
        if (fill > 0.05) {
          ctx.fillStyle = 'rgba(181,108,255,0.85)';
          const m = P(2.45, 0.6, 6);
          ctx.fillRect(m[0] - 2, m[1] - fill * 14, 4, fill * 14);
        }
        break;
      }
      case 'vault': {
        const fill = info.fill || 0;
        if (fill > 0.01) {
          const n = Math.ceil(fill * 6);
          for (let i = 0; i < n; i++) {
            const u = 0.95 + (i % 3) * 0.38, v = 0.95 + Math.floor(i / 3) * 0.55;
            box(ctx, u, v, u + 0.3, v + 0.42, 34, 34 + 3 + fill * 5, GOLD, { edge: 'rgba(120,80,10,0.5)' });
          }
        }
        break;
      }
      case 'tank': {
        const fill = info.fill || 0;
        if (fill > 0.01) {
          const top = 14 + fill * 34;
          const b0 = P(1.5, 1.5, 14), t0 = P(1.5, 1.5, top), rr = radii(0.9);
          ctx.beginPath();
          ctx.moveTo(b0[0] - rr[0], b0[1]);
          ctx.ellipse(b0[0], b0[1], rr[0], rr[1], 0, Math.PI, 0, true);
          ctx.lineTo(t0[0] + rr[0], t0[1]);
          ctx.ellipse(t0[0], t0[1], rr[0], rr[1], 0, 0, Math.PI, false);
          ctx.closePath();
          ctx.fillStyle = 'rgba(160,80,240,0.82)'; ctx.fill();
          ctx.beginPath(); ctx.ellipse(t0[0], t0[1], rr[0], rr[1], 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(214,160,255,0.95)'; ctx.fill();
        }
        const hl = P(1.5, 1.5, 0), r0 = radii(0.96);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(hl[0] - r0[0] * 0.55, hl[1] - 18); ctx.lineTo(hl[0] - r0[0] * 0.55, hl[1] - 44); ctx.stroke();
        cyl(ctx, 1.5, 1.5, 1.02, 50, 55, METAL);
        disk(ctx, 1.5, 1.5, 58, 0.4, shade(METAL, 0.1), EDGE);
        break;
      }
      case 'garrison': {
        const c = P(2, 2, 2);
        const f = 0.8 + Math.sin(time * 14) * 0.15 + Math.sin(time * 23) * 0.08;
        ctx.fillStyle = 'rgba(255,140,40,0.35)'; ctx.beginPath(); ctx.arc(c[0], c[1] - 4, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff8a2a'; ctx.beginPath(); ctx.moveTo(c[0] - 6, c[1]); ctx.quadraticCurveTo(c[0], c[1] - 22 * f, c[0] + 6, c[1]); ctx.fill();
        ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.moveTo(c[0] - 3, c[1]); ctx.quadraticCurveTo(c[0], c[1] - 13 * f, c[0] + 3, c[1]); ctx.fill();
        const n = Math.min(6, info.troops || 0);
        for (let i = 0; i < n; i++) {
          const a = i / 6 * Math.PI * 2 + 0.6;
          const p = P(2 + Math.cos(a) * 1.15, 2 + Math.sin(a) * 1.15, 0);
          ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(0.8, 0.8);
          Spr.drawUnit(ctx, info.troopTypes[i % info.troopTypes.length] || 'scout', info.team, time + i, { face: Math.cos(a) > 0 ? -1 : 1, idle: true });
          ctx.restore();
        }
        break;
      }
      case 'lab': {
        const p = P(0.6, 0.6, 30);
        const on = info.active && Math.sin(time * 6) > 0;
        ctx.fillStyle = on ? '#7dffb0' : '#2e5b40';
        ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2); ctx.fill();
        if (info.busy) {
          for (let i = 0; i < 4; i++) {
            const q = (time * 0.8 + i / 4) % 1;
            const s = P(1.5, 1.5, 40 + q * 30);
            ctx.fillStyle = 'rgba(140,255,220,' + (1 - q) + ')';
            ctx.fillRect(s[0] + Math.sin(i * 3 + time * 2) * 12, s[1], 2, 2);
          }
        }
        break;
      }
      case 'station': {
        if (info.idle) {
          const p = P(1.25, 1.95, 0);
          ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(0.85, 0.85);
          drawEngineer(ctx, time);
          ctx.restore();
        }
        break;
      }
      case 'blaster': {
        const ang = info.angle || 0;
        const recoil = info.recoil || 0;
        const base = P(1.5, 1.5, 26);
        const len = 1.15 - recoil * 0.25;
        const tip = P(1.5 + Math.cos(ang) * len, 1.5 + Math.sin(ang) * len, 27);
        const behind = tip[1] < base[1];
        const barrel = function () {
          ctx.strokeStyle = '#2f3338'; ctx.lineWidth = 8; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
          ctx.strokeStyle = '#5c636c'; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.moveTo(base[0], base[1] - 1.5); ctx.lineTo(tip[0], tip[1] - 1.5); ctx.stroke();
          ctx.lineCap = 'butt';
        };
        if (behind) barrel();
        const g = ctx.createRadialGradient(base[0] - 3, base[1] - 4, 1, base[0], base[1], 11);
        g.addColorStop(0, '#9aa4ae'); g.addColorStop(1, '#3d434b');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(base[0], base[1], 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = EDGE; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.fillStyle = alpha(info.team, 0.95); ctx.fillRect(base[0] - 5, base[1] - 2, 10, 3);
        if (!behind) barrel();
        break;
      }
      case 'spire': {
        const ang = info.angle || 0;
        const c = P(1.5, 1.5, 64);
        const d = P(1.5 + Math.cos(ang) * 0.6, 1.5 + Math.sin(ang) * 0.6, 64);
        const dx = d[0] - c[0], dy = d[1] - c[1];
        ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(c[0] - dx * 0.4, c[1] - dy * 0.4); ctx.lineTo(d[0], d[1]); ctx.stroke();
        const px = -dy, py = dx;
        const L = Math.sqrt(px * px + py * py) || 1;
        ctx.strokeStyle = '#c99a5a'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(d[0] - dx * 0.2 + px / L * 9, d[1] - dy * 0.2 + py / L * 5);
        ctx.quadraticCurveTo(d[0] + dx * 0.2, d[1] + dy * 0.2, d[0] - dx * 0.2 - px / L * 9, d[1] - dy * 0.2 - py / L * 5);
        ctx.stroke();
        break;
      }
      case 'mortar': {
        const ang = info.angle || 0;
        const recoil = info.recoil || 0;
        const base = P(1.5, 1.5, 12);
        const tip = P(1.5 + Math.cos(ang) * 0.42, 1.5 + Math.sin(ang) * 0.42, 31 - recoil * 6);
        ctx.strokeStyle = '#2c2f33'; ctx.lineWidth = 12; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
        ctx.strokeStyle = '#575e66'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(base[0] - 2, base[1] - 1); ctx.lineTo(tip[0] - 2, tip[1] - 1); ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.fillStyle = '#141414'; ctx.beginPath(); ctx.ellipse(tip[0], tip[1], 6, 3.5, 0, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'frost': {
        const z = 56 + Math.sin(time * 2.2) * 4;
        const c = P(1, 1, z);
        const g = ctx.createRadialGradient(c[0], c[1], 1, c[0], c[1], 18);
        g.addColorStop(0, 'rgba(190,240,255,0.7)'); g.addColorStop(1, 'rgba(190,240,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], 18, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(time * 0.8);
        ctx.fillStyle = '#e6fbff'; ctx.strokeStyle = '#7cc6e6'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(5, 0); ctx.lineTo(0, 9); ctx.lineTo(-5, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
        if (info.pulse > 0) {
          const rr = radii(C.buildings.frost.attack.range * (1 - info.pulse * 0.3));
          const g0 = P(1, 1, 0);
          ctx.strokeStyle = 'rgba(170,230,255,' + (info.pulse * 0.8) + ')'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.ellipse(g0[0], g0[1], rr[0], rr[1], 0, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = 'rgba(170,230,255,' + (info.pulse * 0.12) + ')'; ctx.fill();
        }
        break;
      }
      case 'lance': {
        const c = P(1.5, 1.5, 60);
        const on = info.firing;
        const r = on ? 9 + Math.sin(time * 40) * 1.5 : 7;
        const g = ctx.createRadialGradient(c[0], c[1], 1, c[0], c[1], r * 2.2);
        g.addColorStop(0, on ? 'rgba(220,250,255,1)' : 'rgba(170,220,255,0.9)'); g.addColorStop(0.4, alpha(info.team, 0.6)); g.addColorStop(1, alpha(info.team, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], r * 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = on ? '#ffffff' : '#bfe6ff'; ctx.beginPath(); ctx.arc(c[0], c[1], r * 0.6, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'mine': {
        if (info.hidden) break;
        const p = P(0.5, 0.5, 3);
        const blink = info.triggered ? 1 : (Math.sin(time * 4) > 0.6 ? 1 : 0.25);
        ctx.fillStyle = 'rgba(255,60,40,' + blink + ')';
        ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, Math.PI * 2); ctx.fill();
        break;
      }
    }
    if (info.upgrading) {
      const posts = [[0.25, h - 0.25], [w - 0.25, h - 0.25], [w - 0.25, 0.25]];
      ctx.strokeStyle = '#c99a5a'; ctx.lineWidth = 2;
      posts.forEach(function (p) {
        const a = P(p[0], p[1], 0), b = P(p[0], p[1], 36);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
      const a = P(posts[0][0], posts[0][1], 24), m = P(posts[1][0], posts[1][1], 24), z = P(posts[2][0], posts[2][1], 24);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(m[0], m[1]); ctx.lineTo(z[0], z[1]); ctx.stroke();
      const sp = P(w * 0.6, h * 0.95, 26 + Math.abs(Math.sin(time * 8)) * 4);
      if (Math.sin(time * 8) > 0.85) {
        ctx.fillStyle = '#ffe9a0';
        for (let i = 0; i < 4; i++) ctx.fillRect(sp[0] + Math.cos(i * 1.6) * 5, sp[1] + Math.sin(i * 1.6) * 3, 1.5, 1.5);
      }
    }
  };

  // ---------------------------------------------------------------- troops
  const SKIN = ['#f1c9a5', '#d9a37c', '#a8714d', '#ffd9b8'];

  function legs(ctx, walk, col, spread, len) {
    const s = Math.sin(walk) * 3;
    ctx.strokeStyle = col; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-spread, -len); ctx.lineTo(-spread + s, 0); ctx.moveTo(spread, -len); ctx.lineTo(spread - s, 0); ctx.stroke();
    ctx.lineCap = 'butt';
  }
  function head(ctx, x, y, r, skin) {
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.fillStyle = '#222'; ctx.fillRect(x + r * 0.25, y - r * 0.15, 1.3, 1.3);
  }
  function rounded(ctx, x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.7; ctx.stroke();
  }
  function drawEngineer(ctx, time) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(0, 0, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
    legs(ctx, 0, '#3b4a63', 2, 6);
    rounded(ctx, -4, -15, 8, 9, 2, '#f08a24');
    head(ctx, 0, -18, 3.6, SKIN[0]);
    ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(0, -19.5, 4, Math.PI, 0); ctx.fill();
    const sw = Math.sin(time * 6) * 0.6;
    ctx.save(); ctx.translate(4, -11); ctx.rotate(-0.6 + sw);
    ctx.fillStyle = '#7a5530'; ctx.fillRect(0, -1, 7, 2); ctx.fillStyle = '#9aa4ae'; ctx.fillRect(6, -3, 3, 6);
    ctx.restore();
  }

  /*
   * Draws a troop with its feet at the origin. opts: {face, walk, atk (0..1 since attack),
   * hit (bool), idle, lv, skin}
   */
  Spr.drawUnit = function (ctx, type, team, time, o) {
    o = o || {};
    const face = o.face || 1;
    const walk = o.idle ? 0 : (o.walk != null ? o.walk : time * 10);
    const lunge = o.atk != null && o.atk < 1 ? Math.sin(o.atk * Math.PI) : 0;
    const skin = SKIN[o.skin || 0];
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const big = type === 'bruiser' ? 1.35 : type === 'mender' ? 1.1 : type === 'scout' ? 0.9 : 1;
    ctx.beginPath(); ctx.ellipse(0, 0, 6.5 * big, 3.2 * big, 0, 0, Math.PI * 2); ctx.fill();
    ctx.scale(face, 1);
    if (lunge) ctx.translate(lunge * 2.5, 0);
    const bob = o.idle ? 0 : Math.abs(Math.sin(walk)) * 1.4;
    ctx.translate(0, -bob);
    if (type === 'scout') {
      ctx.scale(0.9, 0.9);
      legs(ctx, walk, '#3a3a46', 1.8, 6);
      rounded(ctx, -4, -14, 8, 9, 2.5, '#5e8f4a');
      ctx.fillStyle = team; ctx.fillRect(-4, -11, 8, 2);
      head(ctx, 0.5, -17, 3.6, skin);
      ctx.fillStyle = team; ctx.beginPath(); ctx.arc(0, -18, 4.2, Math.PI * 0.9, Math.PI * 2.05); ctx.fill();
      ctx.save(); ctx.translate(4, -9); ctx.rotate(-0.4 - lunge * 0.8);
      ctx.fillStyle = '#d7dde3'; ctx.fillRect(0, -1, 7, 2); ctx.fillStyle = '#6b4a2b'; ctx.fillRect(-1, -1.5, 2, 3);
      ctx.restore();
    } else if (type === 'ranger') {
      legs(ctx, walk, '#4a3a2a', 2, 6);
      ctx.fillStyle = team; ctx.beginPath(); ctx.moveTo(-5, -15); ctx.lineTo(-7, -4); ctx.lineTo(0, -6); ctx.closePath(); ctx.fill();
      rounded(ctx, -4, -15, 8, 10, 2.5, '#8a5d36');
      head(ctx, 0.5, -18, 3.6, skin);
      ctx.fillStyle = '#2f4a2a'; ctx.beginPath(); ctx.ellipse(0.5, -20.5, 6.2, 1.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.5, -21, 3.2, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = '#7a4f24'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(5, -11, 6.5, -1.2, 1.2); ctx.stroke();
      ctx.strokeStyle = '#e8e2d0'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(5 + Math.cos(-1.2) * 6.5, -11 + Math.sin(-1.2) * 6.5); ctx.lineTo(5 - lunge * 3, -11); ctx.lineTo(5 + Math.cos(1.2) * 6.5, -11 + Math.sin(1.2) * 6.5); ctx.stroke();
    } else if (type === 'bruiser') {
      ctx.scale(1.3, 1.3);
      legs(ctx, walk * 0.7, '#3d3a36', 2.6, 6);
      rounded(ctx, -6, -17, 12, 12, 3.5, '#8d96a0');
      ctx.fillStyle = team; ctx.fillRect(-6, -8, 12, 2.5);
      ctx.fillStyle = '#6c757f'; ctx.beginPath(); ctx.arc(-6, -15, 3.2, 0, Math.PI * 2); ctx.arc(6, -15, 3.2, 0, Math.PI * 2); ctx.fill();
      head(ctx, 0.5, -20, 3.4, skin);
      ctx.fillStyle = '#5b636d'; ctx.beginPath(); ctx.arc(0.5, -21, 3.8, Math.PI, 0); ctx.fill(); ctx.fillRect(-3.3, -21.5, 7.6, 1.6);
      ctx.save(); ctx.translate(6, -10); ctx.rotate(-0.3 - lunge * 1.1);
      ctx.fillStyle = '#4f565e'; ctx.fillRect(-1, -1.5, 8, 3);
      ctx.fillStyle = '#7d858e'; ctx.beginPath(); ctx.arc(8, 0, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (type === 'demo') {
      legs(ctx, walk, '#3a2f28', 1.8, 6);
      ctx.fillStyle = '#26262a'; ctx.beginPath(); ctx.arc(-4, -12, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(-5.5, -14, 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#8b6a3a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-4, -18); ctx.quadraticCurveTo(-2, -22, -5, -24); ctx.stroke();
      if (Math.sin(time * 30) > -0.3) { ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(-5, -24, 1.8, 0, Math.PI * 2); ctx.fill(); }
      rounded(ctx, -2, -14, 7, 9, 2.5, '#6b4b33');
      ctx.fillStyle = team; ctx.fillRect(-2, -10, 7, 2);
      head(ctx, 2, -17, 3.4, skin);
      ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, -18.5, 6, 2.2);
      ctx.fillStyle = '#9fe2ff'; ctx.fillRect(3.2, -18.2, 2, 1.6);
    } else if (type === 'mage') {
      ctx.fillStyle = team;
      ctx.beginPath(); ctx.moveTo(-5.5, 0); ctx.lineTo(-3, -15); ctx.lineTo(3, -15); ctx.lineTo(5.5, 0); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.7; ctx.stroke();
      ctx.fillStyle = shade('#ffffff', -0.15); ctx.fillRect(-4.5, -2, 9, 1.5);
      head(ctx, 0.5, -18, 3.5, skin);
      ctx.fillStyle = '#5b3b8c'; ctx.beginPath(); ctx.moveTo(-5, -19.5); ctx.lineTo(6, -19.5); ctx.lineTo(1.5, -30); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#6b4a2b'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(6 + lunge * 2, -24); ctx.stroke();
      const glow = 3 + Math.sin(time * 8) * 0.8 + lunge * 2;
      ctx.fillStyle = 'rgba(200,140,255,0.45)'; ctx.beginPath(); ctx.arc(6 + lunge * 2, -25, glow + 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#efd6ff'; ctx.beginPath(); ctx.arc(6 + lunge * 2, -25, glow * 0.6, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'mender') {
      const hover = 12 + Math.sin(time * 3) * 2;
      ctx.translate(0, -hover + bob);
      ctx.strokeStyle = '#59636e'; ctx.lineWidth = 1.2;
      const spin = time * 30;
      ctx.beginPath(); ctx.moveTo(-9, -8); ctx.lineTo(-3, -8); ctx.moveTo(3, -8); ctx.lineTo(9, -8); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,210,220,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(-9, -9, 4 * Math.abs(Math.cos(spin)), 1.2, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(9, -9, 4 * Math.abs(Math.sin(spin)), 1.2, 0, 0, Math.PI * 2); ctx.stroke();
      const g = ctx.createRadialGradient(-2, -9, 1, 0, -6, 8);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#b9c6d2');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, -6, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.7; ctx.stroke();
      ctx.fillStyle = '#35c46a'; ctx.fillRect(-1.2, -9.5, 2.4, 7); ctx.fillRect(-3.5, -7.2, 7, 2.4);
      ctx.fillStyle = team; ctx.fillRect(-4, -1, 8, 1.6);
    }
    if (o.hit) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(-12, -36, 24, 40);
    }
    ctx.restore();
  };

  // ---------------------------------------------------------------- UI images
  const thumbCache = {};
  Spr.thumb = function (type, level, team, px) {
    px = px || 96;
    const key = type + '|' + level + '|' + team + '|' + px;
    if (thumbCache[key]) return thumbCache[key];
    const s = Spr.building(type, level, 0, team || '#3f86e8', 'normal', type === 'wall' ? 3 : 0);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    const k = Math.min(px / s.w, px / s.h) * 0.98;
    ctx.drawImage(s.canvas, (px - s.w * k) / 2, (px - s.h * k) / 2, s.w * k, s.h * k);
    if (type !== 'wall' && type !== 'mine') {
      ctx.save();
      const size = CS.Base.size(type, 0);
      ctx.translate((px - s.w * k) / 2 + s.ox * k, (px - s.h * k) / 2 + s.oy * k);
      ctx.scale(k, k);
      Spr.drawLive(ctx, { type: type, w: size[0], h: size[1] }, { team: team || '#3f86e8', fill: 0.7, active: true, angle: 0.8, troops: 0, troopTypes: [] }, 0.5);
      ctx.restore();
    }
    thumbCache[key] = c.toDataURL();
    return thumbCache[key];
  };

  Spr.troopIcon = function (type, team, px) {
    px = px || 72;
    const key = 'troop|' + type + '|' + team + '|' + px;
    if (thumbCache[key]) return thumbCache[key];
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    ctx.translate(px / 2, px * 0.86);
    const k = px / 34;
    ctx.scale(k, k);
    Spr.drawUnit(ctx, type, team || '#3f86e8', 0.3, { face: 1, idle: true });
    thumbCache[key] = c.toDataURL();
    return thumbCache[key];
  };

  CS.Sprites = Spr;
})(window.CS = window.CS || {});
