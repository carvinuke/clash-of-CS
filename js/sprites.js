/*
 * Procedural isometric art. Buildings, walls, ruins, troops and their shadows are drawn with
 * Canvas 2D at runtime, so the game ships without image files.
 *
 * Art rules (keep them when adding art):
 *  - One sun, upper left. Surface brightness comes from lit(normal): tops +0.18, front-left
 *    faces 0, front-right faces -0.3. Shadows fall toward the screen's lower right.
 *  - Materials come from MAT. Team colour goes on banners, flags, cloth and trim, and tints roofs.
 *  - Upgrades show through materials: tier 0 timber and plaster, tier 1 coursed stone,
 *    tier 2 dressed stone with gold.
 *  - Interactive things (buildings, troops) get a dark ink outline; scenery does not.
 *  - Static bodies are cached per (type, level, rotation, team, variant) at 2x. Moving parts
 *    (turret heads, flames, liquids, crystals, flags) are drawn live each frame. Troop frames
 *    are cached per quantised pose so large battles stay cheap.
 *
 * Local building coordinates: u,v in tiles across the footprint (0..w, 0..h), z in pixels up.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U;
  const HW = 32, HH = 16, SC = 2;
  const TILE = Math.hypot(HW, HH);          // on-screen length of one tile edge
  const KX = HW / TILE, KY = HH / TILE;
  const Spr = { HW: HW, HH: HH, SC: SC };

  // ---------------------------------------------------------------- colour
  const rgbCache = {};
  function rgbOf(c) {
    let r = rgbCache[c];
    if (r) return r;
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const n = parseInt(h, 16);
      r = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else {
      const m = c.match(/[\d.]+/g);
      r = [+m[0], +m[1], +m[2]];
    }
    rgbCache[c] = r;
    return r;
  }
  function hex3(r, g, b) {
    const k = function (x) { return x < 0 ? 0 : x > 255 ? 255 : Math.round(x); };
    return '#' + ((1 << 24) | (k(r) << 16) | (k(g) << 8) | k(b)).toString(16).slice(1);
  }
  // f > 0 mixes toward white, f < 0 toward black.
  function shade(c, f) {
    const p = rgbOf(c), t = f < 0 ? 0 : 255, k = Math.min(1, Math.abs(f));
    return hex3(p[0] + (t - p[0]) * k, p[1] + (t - p[1]) * k, p[2] + (t - p[2]) * k);
  }
  function mix(a, b, t) {
    const p = rgbOf(a), q = rgbOf(b);
    return hex3(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
  }
  function alpha(c, a) { const p = rgbOf(c); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')'; }
  Spr.shade = shade;
  Spr.alpha = alpha;
  Spr.mix = mix;

  // ---------------------------------------------------------------- light
  // Brightness shift for a unit surface normal (z up): one sun for everything, upper left.
  function lit(nx, ny, nz) { return -0.025 - 0.275 * nx + 0.025 * ny + 0.205 * nz; }
  const TOP = lit(0, 0, 1), FL = lit(0, 1, 0), FR = lit(1, 0, 0);
  const ZT = 1.155 / 45.25;                  // one pixel of height in tile units (camera 30° up)
  function litPlane(col, a, b, c) {
    const ax = b[0] - a[0], ay = b[1] - a[1], az = (b[2] - a[2]) * ZT;
    const bx = c[0] - a[0], by = c[1] - a[1], bz = (c[2] - a[2]) * ZT;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    let l = Math.hypot(nx, ny, nz) || 1;
    if (nz < 0) l = -l;
    return shade(col, lit(nx / l, ny / l, nz / l));
  }
  // Shadows fall this far (in tiles) per pixel of height.
  const SHX = 0.016, SHY = 0.005;
  Spr.SHADOW = { x: SHX, y: SHY };

  // ---------------------------------------------------------------- palette
  const MAT = {
    stone: '#b9ad99', stoneDark: '#8d8474', stoneCool: '#a3a7a9', dressed: '#ddd0b6', sandstone: '#d9b77e',
    plaster: '#eadbbd', timber: '#6e4a2f', plank: '#a87444', fresh: '#caa06a', canvas: '#ece2c9',
    brick: '#b0623f', iron: '#4b5159', steel: '#97a2ad', brass: '#c99a45', copper: '#c27a45',
    verdigris: '#6fb3a0', gold: '#f2c23a', energy: '#a35cff', energyLight: '#dcbcff',
    glass: '#2f3a46', glow: '#ffcf6e', ice: '#bfe9ff', dirt: '#9a774b', burlap: '#c2a26a', obsidian: '#3e3846'
  };
  Spr.MAT = MAT;
  const INK = '#2b1e12';
  const EDGE = 'rgba(43,30,18,0.42)';
  const INKLINE = 'rgba(38,26,16,0.85)';

  function tierOf(lv, max) { return lv / max <= 0.34 ? 0 : lv / max <= 0.67 ? 1 : 2; }
  // Wall finish per tier.
  function finish(t) {
    return t === 0 ? { col: MAT.plaster, tex: 'timber', frame: MAT.timber }
      : t === 1 ? { col: MAT.stone, tex: 'stone' }
        : { col: MAT.dressed, tex: 'dressed' };
  }
  const TRIM = [MAT.timber, MAT.brass, MAT.gold];
  // Roofs are a slate or tile material tinted by the team colour; greens are darkened so they read on grass.
  function roofOf(team) {
    const p = rgbOf(team);
    let c = mix(team, '#5a5048', 0.35);
    if (p[1] > p[0] && p[1] > p[2]) c = shade(c, -0.24);
    return shade(c, -0.06);
  }

  // ---------------------------------------------------------------- iso primitives
  function P(u, v, z) { return [(u - v) * HW, (u + v) * HH - (z || 0)]; }
  Spr.P = P;
  function trace(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
  function poly(ctx, pts, fill, edge) {
    trace(ctx, pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 0.7; ctx.stroke(); }
  }
  function proj(pts) { return pts.map(function (p) { return P(p[0], p[1], p[2]); }); }
  function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  function lerp2(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function radii(r) { return [r * HW * Math.SQRT2, r * HH * Math.SQRT2]; }
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // Runs fn(ctx, len, ht) in the plane of a box's front face, seen head-on and clipped to it:
  // x runs 0..len left to right on screen, y from 0 at z0 up to -ht.
  // 'L' is the front-left face (v = v1), 'R' the front-right face (u = u1).
  function onFace(ctx, side, u0, v0, u1, v1, z0, z1, fn, clip) {
    const o = P(side === 'L' ? u0 : u1, v1, z0);
    const len = (side === 'L' ? u1 - u0 : v1 - v0) * TILE, ht = z1 - z0;
    ctx.save();
    ctx.transform(KX, side === 'L' ? KY : -KY, 0, 1, o[0], o[1]);
    if (clip) trace(ctx, clip(len, ht));
    else { ctx.beginPath(); ctx.rect(0, -ht, len, ht); }
    ctx.clip();
    fn(ctx, len, ht);
    ctx.restore();
  }
  // Runs fn(ctx) in a face plane centred at (u, v, z), unclipped.
  function decal(ctx, side, u, v, z, fn) {
    const o = P(u, v, z);
    ctx.save();
    ctx.transform(KX, side === 'L' ? KY : -KY, 0, 1, o[0], o[1]);
    fn(ctx);
    ctx.restore();
  }

  // ---------------------------------------------------------------- surface textures (face space)
  // Each fills the face; col is the material colour already lit for that side.
  const TEX = {
    stone: function (c, len, ht, col, rng, o) {
      const ch = o.course || 7, bw = o.block || 15;
      c.fillStyle = shade(col, -0.3); c.fillRect(0, -ht, len, ht);
      for (let y = 0, row = 0; y < ht - 0.4; y += ch, row++) {
        const h = Math.min(ch, ht - y);
        for (let x = row % 2 ? -bw / 2 : 0; x < len; x += bw) {
          c.fillStyle = shade(col, (rng.next() - 0.5) * 0.14);
          c.fillRect(x + 0.7, -y - h + 0.7, bw - 1.4, h - 1.4);
          c.fillStyle = shade(col, 0.18);
          c.fillRect(x + 0.7, -y - h + 0.7, bw - 1.4, 0.9);
        }
      }
    },
    dressed: function (c, len, ht, col, rng, o) {
      const ch = o.course || 9, bw = o.block || 24;
      c.fillStyle = col; c.fillRect(0, -ht, len, ht);
      c.fillStyle = shade(col, -0.22);
      for (let y = 0, row = 0; y < ht; y += ch, row++) {
        const top = Math.min(y + ch, ht);
        if (y > 0) c.fillRect(0, -y - 0.4, len, 0.8);
        for (let x = row % 2 ? bw / 2 : 0; x < len; x += bw) if (x > 0) c.fillRect(x - 0.4, -top, 0.8, top - y);
      }
      c.fillStyle = 'rgba(255,255,255,0.16)';
      for (let y = 0; y < ht; y += ch) c.fillRect(0, -Math.min(y + ch, ht) + 0.5, len, 0.8);
    },
    brick: function (c, len, ht, col, rng) {
      const ch = 4, bw = 9;
      c.fillStyle = mix(col, '#e2d6c2', 0.45); c.fillRect(0, -ht, len, ht);
      for (let y = 0, row = 0; y < ht; y += ch, row++) {
        for (let x = row % 2 ? -bw / 2 : 0; x < len; x += bw) {
          c.fillStyle = shade(col, (rng.next() - 0.5) * 0.2);
          c.fillRect(x + 0.5, -y - ch + 0.5, bw - 1, ch - 1);
        }
      }
    },
    plank: function (c, len, ht, col, rng) {
      const pw = 6;
      for (let x = 0; x < len; x += pw) {
        c.fillStyle = shade(col, (rng.next() - 0.5) * 0.16); c.fillRect(x, -ht, pw, ht);
        c.fillStyle = shade(col, -0.38); c.fillRect(x + pw - 0.8, -ht, 0.8, ht);
      }
      c.fillStyle = shade(col, -0.2);
      if (ht > 10) { c.fillRect(0, -ht * 0.22 - 1.2, len, 2.4); c.fillRect(0, -ht * 0.8 - 1.2, len, 2.4); }
    },
    // Plaster in a timber frame: posts per bay, sill, mid rail and braces in the lower half.
    timber: function (c, len, ht, col, rng, o) {
      c.fillStyle = col; c.fillRect(0, -ht, len, ht);
      c.fillStyle = 'rgba(120,90,60,0.08)';
      for (let i = 0; i < len * ht / 90; i++) c.fillRect(rng.next() * len, -rng.next() * ht, 2 + rng.next() * 4, 1.4);
      const f = o.frame, bw = 2.8, n = Math.max(1, Math.round(len / 32)), mid = -ht * 0.48;
      c.fillStyle = f;
      c.fillRect(0, -bw, len, bw); c.fillRect(0, -ht, len, bw); c.fillRect(0, mid - 1.2, len, 2.4);
      for (let i = 0; i <= n; i++) c.fillRect(Math.min(len - bw, Math.max(0, i * len / n - bw / 2)), -ht, bw, ht);
      c.strokeStyle = f; c.lineWidth = 2.2;
      for (let i = 0; i < n; i++) {
        const x0 = i * len / n + 2.5, x1 = (i + 1) * len / n - 2.5;
        c.beginPath();
        if (i % 2) { c.moveTo(x0, -bw); c.lineTo(x1, mid); } else { c.moveTo(x0, mid); c.lineTo(x1, -bw); }
        c.stroke();
      }
    },
    metal: function (c, len, ht, col, rng, o) {
      const pw = o.block || 18;
      c.fillStyle = shade(col, -0.35); c.fillRect(0, -ht, len, ht);
      for (let x = 0; x < len; x += pw) {
        const w = Math.min(pw, len - x);
        c.fillStyle = shade(col, (rng.next() - 0.5) * 0.08); c.fillRect(x + 0.6, -ht + 0.6, w - 1.2, ht - 1.2);
        c.fillStyle = shade(col, 0.24); c.fillRect(x + 0.6, -ht + 0.6, w - 1.2, 0.8);
        c.fillStyle = o.rivet || shade(col, -0.45);
        for (let y = 3; y < ht - 1.5; y += 7) { c.fillRect(x + 2, -y - 1, 1.2, 1.2); if (w > 6) c.fillRect(x + w - 3.2, -y - 1, 1.2, 1.2); }
      }
    }
  };

  // ---------------------------------------------------------------- solids
  // A box with textured sides. o: {tex, frame, course, block, rivet, top: colour | false, rim: false}
  function block(ctx, rng, u0, v0, u1, v1, z0, z1, col, o) {
    o = o || {};
    const tex = o.tex && TEX[o.tex];
    const side = function (s, f) {
      const pts = s === 'L'
        ? [P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1)]
        : [P(u1, v1, z0), P(u1, v0, z0), P(u1, v0, z1), P(u1, v1, z1)];
      const fc = shade(col, f);
      poly(ctx, pts, fc);
      if (tex) {
        onFace(ctx, s, u0, v0, u1, v1, z0, z1, function (c, len, ht) {
          tex(c, len, ht, fc, rng, { frame: o.frame && shade(o.frame, f), course: o.course, block: o.block, rivet: o.rivet });
        });
      }
      trace(ctx, pts); ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
    };
    if (z1 > z0) { side('L', FL); side('R', FR); }
    if (o.top !== false) {
      const t = [P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)];
      poly(ctx, t, o.top || shade(col, TOP), EDGE);
      if (o.rim !== false && z1 > z0) {
        ctx.strokeStyle = 'rgba(255,246,224,0.38)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(t[3][0] + 1, t[3][1] - 0.6); ctx.lineTo(t[2][0], t[2][1] - 1); ctx.lineTo(t[1][0] - 1, t[1][1] - 0.6); ctx.stroke();
      }
    }
  }

  // Extruded polygon (tile-space outline) from z0 to z1, each visible side lit by its normal.
  function prism(ctx, pts, z0, z1, col, o) {
    o = o || {};
    let cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      let nx = b[1] - a[1], ny = a[0] - b[0];
      if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      if (nx + ny <= 0.001) continue;
      poly(ctx, [P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1)], shade(col, lit(nx, ny, 0)), EDGE);
    }
    if (o.top !== false) poly(ctx, pts.map(function (p) { return P(p[0], p[1], z1); }), o.top || shade(col, TOP), EDGE);
  }
  // Rectangle centred at (cx, cy), length l along angle a and width w across it.
  function rotRect(cx, cy, a, l, w) {
    const dx = Math.cos(a), dy = Math.sin(a);
    return [[cx + dx * l / 2 - dy * w / 2, cy + dy * l / 2 + dx * w / 2], [cx + dx * l / 2 + dy * w / 2, cy + dy * l / 2 - dx * w / 2],
      [cx - dx * l / 2 + dy * w / 2, cy - dy * l / 2 - dx * w / 2], [cx - dx * l / 2 - dy * w / 2, cy - dy * l / 2 + dx * w / 2]];
  }

  function cylPath(ctx, u, v, r, z0, z1) {
    const b = P(u, v, z0), t = P(u, v, z1), rr = radii(r);
    ctx.beginPath();
    ctx.moveTo(b[0] - rr[0], b[1]);
    ctx.ellipse(b[0], b[1], rr[0], rr[1], 0, Math.PI, 0, true);
    ctx.lineTo(t[0] + rr[0], t[1]);
    ctx.ellipse(t[0], t[1], rr[0], rr[1], 0, 0, Math.PI, false);
    ctx.closePath();
  }
  // Light across a cylinder's width, matching lit() for its normals.
  function cylFill(ctx, x, rx, col) {
    const g = ctx.createLinearGradient(x - rx, 0, x + rx, 0);
    g.addColorStop(0, shade(col, 0.2)); g.addColorStop(0.32, shade(col, 0.04));
    g.addColorStop(0.72, shade(col, -0.2)); g.addColorStop(1, shade(col, -0.3));
    return g;
  }
  // Vertical cylinder. o: {top: colour | false, tex: 'stone' | 'bands', course, n}
  function cyl(ctx, rng, u, v, r, z0, z1, col, o) {
    o = o || {};
    const b = P(u, v, z0), t = P(u, v, z1), rr = radii(r);
    cylPath(ctx, u, v, r, z0, z1);
    ctx.fillStyle = cylFill(ctx, b[0], rr[0], col);
    ctx.fill();
    if (o.tex === 'stone' && z1 - z0 > 3) {
      ctx.save(); ctx.clip();
      const ch = o.course || 7, n = o.n || Math.max(4, Math.round(r * 8));
      ctx.lineWidth = 0.8;
      for (let z = z0, row = 0; z < z1 - 0.5; z += ch, row++) {
        const top = Math.min(z + ch, z1);
        ctx.strokeStyle = 'rgba(30,20,12,0.3)';
        if (z > z0) { ctx.beginPath(); ctx.ellipse(b[0], b[1] - (z - z0), rr[0], rr[1], 0, 0, Math.PI); ctx.stroke(); }
        for (let k = 0; k < n; k++) {
          const a = (k + (row % 2 ? 0.5 : 0) + 0.25) / n * Math.PI;
          const x = b[0] + Math.cos(a) * rr[0], s = Math.sin(a) * rr[1];
          ctx.beginPath(); ctx.moveTo(x, b[1] - (z - z0) + s); ctx.lineTo(x, b[1] - (top - z0) + s); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,248,230,0.22)';
        ctx.beginPath(); ctx.ellipse(b[0], b[1] - (top - z0) + 1, rr[0], rr[1], 0, 0.15, Math.PI - 0.15); ctx.stroke();
      }
      ctx.restore();
    } else if (o.tex === 'bands') {
      ctx.save(); ctx.clip();
      ctx.strokeStyle = 'rgba(30,20,12,0.35)'; ctx.lineWidth = 1.2;
      for (let z = z0 + 3; z < z1; z += 5) { ctx.beginPath(); ctx.ellipse(b[0], b[1] - (z - z0), rr[0], rr[1], 0, 0, Math.PI); ctx.stroke(); }
      ctx.restore();
    }
    cylPath(ctx, u, v, r, z0, z1);
    ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
    if (o.top !== false) {
      ctx.beginPath(); ctx.ellipse(t[0], t[1], rr[0], rr[1], 0, 0, Math.PI * 2);
      ctx.fillStyle = o.top || shade(col, TOP); ctx.fill();
      ctx.strokeStyle = EDGE; ctx.stroke();
    }
  }

  function disk(ctx, u, v, z, r, fill, edge) {
    const c = P(u, v, z), rr = radii(r);
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 0.7; ctx.stroke(); }
  }

  function cone(ctx, u, v, r, z0, z1, col, rows) {
    const b = P(u, v, z0), a = P(u, v, z1), rr = radii(r);
    const side = function () {
      ctx.beginPath();
      ctx.moveTo(b[0] - rr[0], b[1]);
      ctx.ellipse(b[0], b[1], rr[0], rr[1], 0, Math.PI, 0, true);
      ctx.lineTo(a[0], a[1]);
      ctx.closePath();
    };
    ctx.beginPath(); ctx.ellipse(b[0], b[1], rr[0], rr[1], 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(col, -0.08); ctx.fill();
    side();
    const g = ctx.createLinearGradient(b[0] - rr[0], 0, b[0] + rr[0], 0);
    g.addColorStop(0, shade(col, 0.24)); g.addColorStop(0.42, shade(col, 0.03)); g.addColorStop(1, shade(col, -0.34));
    ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.clip();
    const n = rows || 4;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      ctx.strokeStyle = alpha(shade(col, -0.6), 0.32); ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.ellipse(b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, rr[0] * (1 - t), rr[1] * (1 - t), 0, 0, Math.PI); ctx.stroke();
    }
    ctx.restore();
    side(); ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.strokeStyle = shade(col, -0.45); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(b[0], b[1], rr[0], rr[1], 0, 0.05, Math.PI - 0.05); ctx.stroke();
  }

  // Hemisphere resting on (u, v, z); n ribs on the visible side.
  function dome(ctx, u, v, r, z, col, ribs) {
    const c = P(u, v, z), rr = radii(r), R = rr[0], hz = 39.2 * r;
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI);
    ctx.ellipse(c[0], c[1], R, R, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    const g = ctx.createRadialGradient(c[0] - R * 0.38, c[1] - R * 0.62, R * 0.05, c[0] - R * 0.1, c[1] - R * 0.3, R * 1.2);
    g.addColorStop(0, shade(col, 0.4)); g.addColorStop(0.45, shade(col, 0.02)); g.addColorStop(1, shade(col, -0.36));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
    if (ribs) {
      ctx.strokeStyle = alpha(shade(col, -0.45), 0.55); ctx.lineWidth = 1;
      for (let k = 0; k < ribs; k++) {
        const ph = -Math.PI / 4 + (k + 0.5) / ribs * Math.PI;
        ctx.beginPath();
        for (let i = 0; i <= 10; i++) {
          const th = i / 10 * Math.PI / 2;
          const p = P(u + Math.cos(ph) * Math.sin(th) * r, v + Math.sin(ph) * Math.sin(th) * r, z + Math.cos(th) * hz);
          if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
        }
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- roofs
  // One roof plane: eave e0 -> e1, ridge r1 -> r0 (3D points), tiled in rows along the eave.
  function roofPlane(ctx, e0, e1, r1, r0, col, o) {
    o = o || {};
    const fill = litPlane(col, e0, e1, r1);
    const pts = proj([e0, e1, r1, r0]);
    poly(ctx, pts, fill);
    ctx.save(); trace(ctx, pts); ctx.clip();
    const em = lerp2(pts[0], pts[1], 0.5), rm = lerp2(pts[3], pts[2], 0.5);
    const rows = Math.max(2, Math.round(Math.hypot(rm[0] - em[0], rm[1] - em[1]) / (o.row || 5.5)));
    const len = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const n = Math.max(2, Math.round(len / (o.tile || 7.5)));
    for (let k = 0; k < rows; k++) {
      const t0 = k / rows, t1 = (k + 1) / rows;
      const a0 = lerp2(pts[0], pts[3], t0), b0 = lerp2(pts[1], pts[2], t0);
      const a1 = lerp2(pts[0], pts[3], t1), b1 = lerp2(pts[1], pts[2], t1);
      if (k) {
        ctx.strokeStyle = alpha(shade(fill, -0.5), 0.5); ctx.lineWidth = 0.9; line(ctx, a0, b0);
        ctx.strokeStyle = alpha(shade(fill, 0.35), 0.3); ctx.lineWidth = 0.7; line(ctx, [a0[0], a0[1] - 1], [b0[0], b0[1] - 1]);
      }
      if (o.plain) continue;
      ctx.strokeStyle = alpha(shade(fill, -0.45), 0.32); ctx.lineWidth = 0.7;
      for (let j = 1; j < n; j++) {
        const s = (j - (k % 2 ? 0.5 : 0)) / n;
        line(ctx, lerp2(a0, b0, s), lerp2(a1, b1, s));
      }
    }
    ctx.restore();
    trace(ctx, pts); ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
  }

  function edgeLine(ctx, a, b, w, col) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = col; ctx.lineWidth = w;
    line(ctx, P(a[0], a[1], a[2]), P(b[0], b[1], b[2]));
    ctx.lineCap = 'butt';
  }

  // Hip roof over [u0,u1] x [v0,v1], eaves at z0, ridge or apex at z1.
  function hipRoof(ctx, u0, v0, u1, v1, z0, z1, col, o) {
    o = o || {};
    const du = u1 - u0, dv = v1 - v0;
    const c00 = [u0, v0, z0], c10 = [u1, v0, z0], c11 = [u1, v1, z0], c01 = [u0, v1, z0];
    let A, B, F, H;
    if (du >= dv) {
      const m = (v0 + v1) / 2;
      A = [u0 + dv / 2, m, z1]; B = [u1 - dv / 2, m, z1];
      F = [[c01, c00, A, A], [c00, c10, B, A], [c10, c11, B, B], [c11, c01, A, B]];
      H = [[c00, A], [c01, A], [c10, B], [c11, B]];
    } else {
      const m = (u0 + u1) / 2;
      A = [m, v0 + du / 2, z1]; B = [m, v1 - du / 2, z1];
      F = [[c01, c00, A, B], [c00, c10, A, A], [c10, c11, B, A], [c11, c01, B, B]];
      H = [[c00, A], [c10, A], [c01, B], [c11, B]];
    }
    F.forEach(function (f) { roofPlane(ctx, f[0], f[1], f[2], f[3], col, o); });
    const cap = o.cap || shade(col, -0.32);
    edgeLine(ctx, c01, c11, 1.8, shade(col, -0.5));
    edgeLine(ctx, c11, c10, 1.8, shade(col, -0.55));
    H.forEach(function (h) { edgeLine(ctx, h[0], h[1], 1.6, cap); });
    if (A[0] !== B[0] || A[1] !== B[1]) edgeLine(ctx, A, B, 1.8, cap);
  }

  // Gable roof; ridge along u (alongV false) or v. gable(c, len, ht) paints the visible gable end.
  function gableRoof(ctx, u0, v0, u1, v1, z0, z1, col, alongV, gable, o) {
    o = o || {};
    const tri = function (len, ht) { return [[0, 0], [len, 0], [len / 2, -ht]]; };
    const barge = o.barge || MAT.timber;
    if (!alongV) {
      const m = (v0 + v1) / 2;
      roofPlane(ctx, [u0, v0, z0], [u1, v0, z0], [u1, m, z1], [u0, m, z1], col, o);
      if (o.mid) o.mid();
      roofPlane(ctx, [u1, v1, z0], [u0, v1, z0], [u0, m, z1], [u1, m, z1], col, o);
      if (gable) onFace(ctx, 'R', u1, v0, u1, v1, z0, z1, gable, tri);
      edgeLine(ctx, [u0, v1, z0], [u1, v1, z0], 1.8, shade(col, -0.5));
      edgeLine(ctx, [u1, v0, z0], [u1, m, z1], 2.2, barge);
      edgeLine(ctx, [u1, m, z1], [u1, v1, z0], 2.2, barge);
      edgeLine(ctx, [u0, m, z1], [u1, m, z1], 1.8, shade(col, -0.32));
    } else {
      const m = (u0 + u1) / 2;
      roofPlane(ctx, [u0, v1, z0], [u0, v0, z0], [m, v0, z1], [m, v1, z1], col, o);
      if (o.mid) o.mid();
      if (gable) onFace(ctx, 'L', u0, v1, u1, v1, z0, z1, gable, tri);
      roofPlane(ctx, [u1, v0, z0], [u1, v1, z0], [m, v1, z1], [m, v0, z1], col, o);
      edgeLine(ctx, [u1, v0, z0], [u1, v1, z0], 1.8, shade(col, -0.55));
      edgeLine(ctx, [u0, v1, z0], [m, v1, z1], 2.2, barge);
      edgeLine(ctx, [m, v1, z1], [u1, v1, z0], 2.2, barge);
      edgeLine(ctx, [m, v0, z1], [m, v1, z1], 1.8, shade(col, -0.32));
    }
  }

  // Dark band under eaves where the roof overhang shades the walls.
  function eaveShade(ctx, u0, v0, u1, v1, z, d) {
    d = d || 5;
    poly(ctx, [P(u0, v1, z - d), P(u1, v1, z - d), P(u1, v1, z), P(u0, v1, z)], 'rgba(30,20,10,0.22)');
    poly(ctx, [P(u1, v1, z - d), P(u1, v0, z - d), P(u1, v0, z), P(u1, v1, z)], 'rgba(30,20,10,0.2)');
  }

  // ---------------------------------------------------------------- details
  // Timber or iron member between two 3D points, with ink edges and a lit side.
  function beam(ctx, a, b, w, col) {
    const p = P(a[0], a[1], a[2]), q = P(b[0], b[1], b[2]);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = INKLINE; ctx.lineWidth = w + 1.3; line(ctx, p, q);
    ctx.strokeStyle = col; ctx.lineWidth = w; line(ctx, p, q);
    let nx = p[1] - q[1], ny = q[0] - p[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    if (nx + ny > 0) { nx = -nx; ny = -ny; }
    const k = w * 0.26;
    ctx.strokeStyle = shade(col, 0.28); ctx.lineWidth = Math.max(0.6, w * 0.3);
    line(ctx, [p[0] + nx * k, p[1] + ny * k], [q[0] + nx * k, q[1] + ny * k]);
  }
  function pole(ctx, u, v, z0, z1, w, col) { beam(ctx, [u, v, z0], [u, v, z1], w || 1.8, col || MAT.timber); }

  function finial(ctx, u, v, z, col) {
    const p = P(u, v, z);
    ctx.strokeStyle = shade(col, -0.35); ctx.lineWidth = 1.5;
    line(ctx, p, [p[0], p[1] - 7]);
    ctx.beginPath(); ctx.arc(p[0], p[1] - 8, 2.3, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(p[0] - 1.2, p[1] - 9.3, 1, 1);
  }

  function archPath(c, x, y, w, h) {
    c.beginPath();
    c.moveTo(x - w / 2, y);
    c.lineTo(x - w / 2, y - h + w / 2);
    c.arc(x, y - h + w / 2, w / 2, Math.PI, 0);
    c.lineTo(x + w / 2, y);
    c.closePath();
  }
  // Face-space details: x is the centre, z the bottom (positive up).
  function door(c, x, w, h, o) {
    o = o || {};
    archPath(c, x, 0, w + 3.2, h + 1.6);
    c.fillStyle = o.frame || shade(MAT.stoneDark, -0.1); c.fill();
    archPath(c, x, 0, w, h);
    c.fillStyle = o.col || '#5b3a22'; c.fill();
    c.save(); c.clip();
    c.fillStyle = 'rgba(0,0,0,0.28)';
    for (let i = 1; i < 4; i++) c.fillRect(x - w / 2 + i * w / 4 - 0.4, -h, 0.8, h);
    c.fillStyle = MAT.iron;
    c.fillRect(x - w / 2, -h * 0.3, w, 1.3); c.fillRect(x - w / 2, -h * 0.66, w, 1.3);
    c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(x - w / 2, -h, w, 2.5);
    c.restore();
    c.fillStyle = MAT.brass; c.beginPath(); c.arc(x + w * 0.28, -h * 0.45, 0.9, 0, Math.PI * 2); c.fill();
  }
  function win(c, x, z, w, h, o) {
    o = o || {};
    const y = -z - h, fr = o.frame || MAT.timber;
    c.fillStyle = fr;
    if (o.arch) { archPath(c, x, -z + 1.2, w + 2.4, h + 2.4); c.fill(); archPath(c, x, -z, w, h); }
    else { c.fillRect(x - w / 2 - 1.2, y - 1.2, w + 2.4, h + 2.4); c.beginPath(); c.rect(x - w / 2, y, w, h); }
    c.fillStyle = o.glow || MAT.glass; c.fill();
    c.save(); c.clip();
    if (o.glow) {
      c.fillStyle = 'rgba(255,255,240,0.45)'; c.fillRect(x - w / 2, y + h * 0.5, w, h * 0.5);
    } else {
      c.fillStyle = 'rgba(176,210,232,0.38)';
      c.beginPath(); c.moveTo(x - w / 2, y + h * 0.6); c.lineTo(x - w / 2, y); c.lineTo(x - w / 2 + w * 0.6, y); c.closePath(); c.fill();
    }
    c.fillStyle = fr; c.fillRect(x - 0.5, y, 1, h); c.fillRect(x - w / 2, y + h * 0.48, w, 1);
    c.restore();
    c.fillStyle = shade(fr, 0.2); c.fillRect(x - w / 2 - 2, -z, w + 4, 1.5);
  }
  function slit(c, x, z, h) {
    c.fillStyle = shade(MAT.stoneDark, -0.25); c.fillRect(x - 2, -z - h - 1, 4, h + 2);
    c.fillStyle = '#1c1a1e'; c.fillRect(x - 0.9, -z - h, 1.8, h);
  }
  // Hanging banner in the team colour with a light chevron.
  function banner(c, x, ztop, w, h, team, trim) {
    const y = -ztop;
    c.beginPath();
    c.moveTo(x - w / 2, y); c.lineTo(x + w / 2, y); c.lineTo(x + w / 2, y + h); c.lineTo(x, y + h - w * 0.4); c.lineTo(x - w / 2, y + h);
    c.closePath();
    c.fillStyle = team; c.fill();
    c.save(); c.clip();
    c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(x + w * 0.18, y, w, h);
    c.strokeStyle = trim || 'rgba(255,240,200,0.85)'; c.lineWidth = 1.1;
    c.beginPath(); c.moveTo(x - w / 2, y + h * 0.3); c.lineTo(x, y + h * 0.5); c.lineTo(x + w / 2, y + h * 0.3); c.stroke();
    c.restore();
    c.strokeStyle = INKLINE; c.lineWidth = 0.7;
    c.beginPath(); c.moveTo(x - w / 2, y); c.lineTo(x + w / 2, y); c.lineTo(x + w / 2, y + h); c.lineTo(x, y + h - w * 0.4); c.lineTo(x - w / 2, y + h); c.closePath(); c.stroke();
    c.fillStyle = MAT.timber; c.fillRect(x - w / 2 - 1.5, y - 1.6, w + 3, 1.8);
  }
  function coinMark(c, x, y, r) {
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = MAT.gold; c.fill(); c.strokeStyle = '#8a5d10'; c.lineWidth = 1; c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.6, 0, Math.PI * 2); c.strokeStyle = 'rgba(138,93,16,0.8)'; c.lineWidth = 0.8; c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.55)'; c.fillRect(x - r * 0.55, y - r * 0.6, r * 0.4, r * 0.3);
  }

  // Small sandbag or round stone seen from above-front.
  function lump(ctx, u, v, z, rx, ry, col) {
    const p = P(u, v, z);
    ctx.beginPath(); ctx.ellipse(p[0], p[1] - ry * 0.6, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(col, -0.12); ctx.fill();
    ctx.strokeStyle = EDGE; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(p[0] - rx * 0.18, p[1] - ry * 0.9, rx * 0.7, ry * 0.55, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(col, 0.12); ctx.fill();
  }

  function pennantSpec(u, v, z, len, ht) { return [u, v, z, len || 15, ht || 9]; }

  // ---------------------------------------------------------------- building bodies
  // Each draws a building with its top corner at the origin and may return {flags: [...]}.
  const DRAW = {};

  DRAW.core = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 6), f = finish(t), roof = roofOf(team), trim = TRIM[t];
    const tower = t === 2 ? MAT.dressed : MAT.stone;
    block(g, rng, 0.1, 0.1, 3.9, 3.9, 0, 4, MAT.stoneDark, { tex: 'stone', course: 4, block: 12 });
    block(g, rng, 0.3, 0.3, 3.7, 3.7, 4, 10, MAT.stone, { tex: 'stone', course: 6, block: 14 });
    const T = [[0.62, 0.62], [3.38, 0.62], [0.62, 3.38], [3.38, 3.38]];
    const drawTower = function (p) {
      cyl(g, rng, p[0], p[1], 0.46, 10, 58, tower, { tex: 'stone', course: 7, top: false });
      cyl(g, rng, p[0], p[1], 0.53, 58, 63, shade(tower, -0.06), {});
      decal(g, 'L', p[0], p[1] + 0.46, 30, function (c) { slit(c, 0, 0, 9); });
      cone(g, p[0], p[1], 0.58, 63, 90, roof, 4);
      finial(g, p[0], p[1], 90, trim);
    };
    if (t >= 1) drawTower(T[0]);
    block(g, rng, 0.6, 0.6, 3.4, 3.4, 10, 44, f.col, { tex: f.tex, frame: f.frame, top: false, course: 8, block: 18 });
    onFace(g, 'L', 0.6, 0.6, 3.4, 3.4, 10, 44, function (c, len) {
      door(c, len / 2, 15, 22, { frame: t ? shade(f.col, -0.25) : MAT.timber });
      banner(c, len / 2 - 15, 31, 7, 17, team, t === 2 ? MAT.gold : null);
      banner(c, len / 2 + 15, 31, 7, 17, team, t === 2 ? MAT.gold : null);
      win(c, len * 0.22, 19, 6, 9, { arch: t > 0, glow: t === 2 ? MAT.glow : null });
      win(c, len * 0.78, 19, 6, 9, { arch: t > 0, glow: t === 2 ? MAT.glow : null });
    });
    onFace(g, 'R', 0.6, 0.6, 3.4, 3.4, 10, 44, function (c, len) {
      [0.27, 0.5, 0.73].forEach(function (k) { win(c, len * k, 17, 6, 10, { arch: t > 0 }); });
    });
    if (t === 2) block(g, rng, 0.55, 0.55, 3.45, 3.45, 41, 44, MAT.gold, { top: false });
    eaveShade(g, 0.6, 0.6, 3.4, 3.4, 44);
    hipRoof(g, 0.46, 0.46, 3.54, 3.54, 44, 64, roof);
    // the keep rises out of the roof (its walls start where the roof meets them)
    block(g, rng, 1.52, 1.52, 2.48, 2.48, 57, 80, f.col, { tex: f.tex, frame: f.frame, top: false, course: 7, block: 14 });
    onFace(g, 'L', 1.52, 1.52, 2.48, 2.48, 57, 80, function (c, len) { win(c, len / 2, 5, 6, 10, { arch: true, glow: MAT.glow }); });
    onFace(g, 'R', 1.52, 1.52, 2.48, 2.48, 57, 80, function (c, len) { win(c, len / 2, 5, 6, 10, { arch: true, glow: MAT.glow }); });
    block(g, rng, 1.46, 1.46, 2.54, 2.54, 80, 83, t === 2 ? MAT.gold : shade(f.col, -0.12), { top: false });
    hipRoof(g, 1.42, 1.42, 2.58, 2.58, 83, 100, roof);
    finial(g, 2, 2, 100, trim === MAT.timber ? MAT.brass : trim);
    if (t >= 1) { drawTower(T[1]); drawTower(T[2]); drawTower(T[3]); }
    // lamps by the door
    [1.55, 2.45].forEach(function (u) {
      const p = P(u, 3.72, 10);
      g.fillStyle = MAT.iron; g.fillRect(p[0] - 0.8, p[1] - 14, 1.6, 14);
      g.fillStyle = MAT.glow; g.beginPath(); g.arc(p[0], p[1] - 15.5, 2.2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = EDGE; g.lineWidth = 0.7; g.stroke();
    });
    if (t >= 1) return { flags: [pennantSpec(0.62, 3.38, 97, 14, 8), pennantSpec(3.38, 0.62, 97, 14, 8)] };
    pole(g, 0.3, 3.7, 10, 66);
    return { flags: [pennantSpec(0.3, 3.7, 66, 17, 10)] };
  };

  DRAW.mint = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 8), roof = roofOf(team);
    const f = t === 1 ? { col: MAT.brick, tex: 'brick' } : finish(t);
    block(g, rng, 0.12, 0.12, 2.88, 2.88, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    // coin press: back post, anvil (the ram is drawn live), front post, beam
    block(g, rng, 2.45, 0.5, 2.6, 0.65, 5, 35, MAT.timber, { tex: 'plank' });
    block(g, rng, 2.3, 0.82, 2.75, 1.22, 5, 11, MAT.iron, { tex: 'metal', block: 8 });
    block(g, rng, 2.45, 1.38, 2.6, 1.53, 5, 35, MAT.timber, { tex: 'plank' });
    block(g, rng, 2.42, 0.46, 2.63, 1.57, 35, 39, shade(MAT.timber, 0.1), {});
    // workshop
    block(g, rng, 0.3, 0.3, 2.1, 1.8, 5, 30, f.col, { tex: f.tex, frame: f.frame, top: false });
    onFace(g, 'L', 0.3, 0.3, 2.1, 1.8, 5, 30, function (c, len) {
      door(c, len * 0.64, 11, 16, { frame: t ? shade(f.col, -0.3) : MAT.timber });
      win(c, len * 0.22, 9, 7, 8);
      coinMark(c, len * 0.64, -21.5, 3.6);
    });
    onFace(g, 'R', 0.3, 0.3, 2.1, 1.8, 5, 30, function (c, len) { win(c, len * 0.5, 9, 7, 8); });
    eaveShade(g, 0.3, 0.3, 2.1, 1.8, 30);
    gableRoof(g, 0.3, 0.18, 2.1, 1.92, 30, 47, roof, false, function (c, len, ht) {
      TEX[f.tex](c, len, ht, shade(f.col, FR), rng, { frame: shade(MAT.timber, FR) });
      c.fillStyle = shade(MAT.timber, FR); c.beginPath(); c.arc(len / 2, -ht * 0.42, 2.6, 0, Math.PI * 2); c.fill();
    }, {
      mid: function () {
        block(g, rng, 0.5, 0.45, 0.86, 0.81, 38, 60, MAT.brick, { tex: 'brick' });
        block(g, rng, 0.46, 0.41, 0.9, 0.85, 60, 62, MAT.stoneDark, {});
      }
    });
    // coin tray where the pile sits, and a sack
    disk(g, 2.32, 2.32, 5, 0.46, '#5e4a33', EDGE);
    disk(g, 2.32, 2.32, 5.5, 0.38, '#7a6040');
    lump(g, 0.75, 2.4, 5, 7, 6, MAT.burlap);
    lump(g, 1.15, 2.55, 5, 6, 5, shade(MAT.burlap, -0.08));
    pole(g, 0.25, 2.75, 5, 44);
    return { flags: [pennantSpec(0.25, 2.75, 44, 13, 8)] };
  };

  DRAW.well = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 8);
    const stone = [MAT.stone, MAT.stone, MAT.dressed][t], wood = t === 2 ? '#5d6670' : MAT.timber;
    const base = [[0.4, 1.5], [1.5, 0.4], [2.6, 1.5], [1.5, 2.6]];
    const top = base.map(function (b) { return [1.5 + (b[0] - 1.5) * 0.2, 1.5 + (b[1] - 1.5) * 0.2]; });
    const at = function (i, z) { const k = (z - 4) / 62; return [base[i][0] + (top[i][0] - base[i][0]) * k, base[i][1] + (top[i][1] - base[i][1]) * k, z]; };
    const leg = function (i) { beam(g, [base[i][0], base[i][1], 4], [top[i][0], top[i][1], 66], 3.4, wood); };
    const brace = function (i, j, z) { beam(g, at(i, z), at(j, z), 2.2, shade(wood, -0.05)); };
    cyl(g, rng, 1.5, 1.5, 1.34, 0, 4, MAT.stoneDark, { tex: 'stone', course: 4, n: 10 });
    leg(0); leg(1); brace(0, 1, 30); brace(0, 1, 52);
    // gauge with a glass window (the level is drawn live)
    cyl(g, rng, 2.38, 0.62, 0.2, 4, 30, MAT.brass, { top: shade(MAT.brass, 0.25) });
    decal(g, 'L', 2.38, 0.82, 8, function (c) { c.fillStyle = '#241c33'; c.fillRect(-1.8, -16, 3.6, 16); c.strokeStyle = shade(MAT.brass, -0.3); c.lineWidth = 0.8; c.strokeRect(-1.8, -16, 3.6, 16); });
    // well wall and pool
    cyl(g, rng, 1.5, 1.5, 0.98, 4, 16, stone, { tex: 'stone', course: 6, n: 9, top: shade(stone, TOP) });
    disk(g, 1.5, 1.5, 16, 0.8, '#2a1f3f', EDGE);
    brace(1, 2, 30); brace(0, 3, 30);
    leg(2); leg(3); brace(2, 3, 30); brace(2, 3, 52);
    block(g, rng, 1.3, 1.3, 1.7, 1.7, 66, 72, wood, { tex: 'plank' });
    // pulley wheel on the crown
    const p = P(1.5, 1.5, 78);
    g.beginPath(); g.ellipse(p[0], p[1], 5, 6, 0, 0, Math.PI * 2); g.fillStyle = shade(MAT.brass, -0.1); g.fill(); g.strokeStyle = INKLINE; g.lineWidth = 0.8; g.stroke();
    g.beginPath(); g.ellipse(p[0], p[1], 2, 2.4, 0, 0, Math.PI * 2); g.fillStyle = MAT.iron; g.fill();
    return null;
  };

  DRAW.vault = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 7);
    const body = [MAT.stone, MAT.dressed, MAT.steel][t], tex = ['stone', 'dressed', 'metal'][t];
    const band = [MAT.timber, MAT.iron, MAT.gold][t];
    block(g, rng, 0.12, 0.12, 2.88, 2.88, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    block(g, rng, 0.32, 0.32, 2.68, 2.68, 5, 30, body, { tex: tex, top: false, course: 8, block: 18, rivet: t === 2 ? MAT.gold : null });
    ['L', 'R'].forEach(function (s) {
      const f = s === 'L' ? FL : FR;
      onFace(g, s, 0.32, 0.32, 2.68, 2.68, 5, 30, function (c, len, ht) {
        c.fillStyle = shade(band, f);
        c.fillRect(0, -ht, 4.5, ht); c.fillRect(len - 4.5, -ht, 4.5, ht); c.fillRect(0, -ht * 0.5 - 1.6, len, 3.2);
        c.fillStyle = shade(band, f + 0.25);
        for (let y = 3; y < ht; y += 6) { c.fillRect(1.6, -y - 0.6, 1.2, 1.2); c.fillRect(len - 2.8, -y - 0.6, 1.2, 1.2); }
        if (s === 'L') {
          const cx = len / 2, cy = -ht * 0.5;
          c.beginPath(); c.arc(cx, cy, 9.5, 0, Math.PI * 2); c.fillStyle = shade(MAT.brass, f); c.fill(); c.strokeStyle = INKLINE; c.lineWidth = 0.8; c.stroke();
          c.beginPath(); c.arc(cx, cy, 7.6, 0, Math.PI * 2); c.fillStyle = shade(MAT.iron, 0.1); c.fill();
          c.strokeStyle = shade(MAT.brass, 0.15); c.lineWidth = 1.3;
          for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3 + 0.3; c.beginPath(); c.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5); c.lineTo(cx - Math.cos(a) * 5, cy - Math.sin(a) * 5); c.stroke(); }
          c.beginPath(); c.arc(cx, cy, 1.8, 0, Math.PI * 2); c.fillStyle = MAT.brass; c.fill();
        } else {
          banner(c, len / 2, ht - 3, 9, 16, team, t === 2 ? MAT.gold : null);
        }
      });
    });
    block(g, rng, 0.26, 0.26, 2.74, 2.74, 30, 33, shade(body, -0.05), {});
    // open pit with its far walls; gold is drawn live on the floor at z 22
    const pz = 22;
    poly(g, [P(0.72, 0.72, 33), P(2.28, 0.72, 33), P(2.28, 2.28, 33), P(0.72, 2.28, 33)], '#2a221a');
    poly(g, [P(0.72, 0.72, pz), P(2.28, 0.72, pz), P(2.28, 0.72, 33), P(0.72, 0.72, 33)], shade(body, FL - 0.42));
    poly(g, [P(0.72, 0.72, pz), P(0.72, 2.28, pz), P(0.72, 2.28, 33), P(0.72, 0.72, 33)], shade(body, FR - 0.32));
    poly(g, [P(0.72, 0.72, pz), P(2.28, 0.72, pz), P(2.28, 2.28, pz), P(0.72, 2.28, pz)], 'rgba(20,14,8,0.55)');
    const merlon = function (u, v) { block(g, rng, u - 0.12, v - 0.12, u + 0.12, v + 0.12, 33, 39, shade(body, -0.02), {}); };
    const m = [];
    for (let k = 0.4; k < 2.7; k += 0.46) { m.push([k, 0.38]); m.push([0.38, k]); m.push([k, 2.62]); m.push([2.62, k]); }
    m.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }).forEach(function (p) { merlon(p[0], p[1]); });
    return null;
  };

  DRAW.tank = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 7), metal = [MAT.copper, MAT.brass, MAT.steel][t];
    cyl(g, rng, 1.5, 1.5, 1.32, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, n: 10 });
    cyl(g, rng, 1.5, 1.5, 1.12, 5, 14, metal, { tex: 'bands' });
    decal(g, 'L', 1.5, 1.5 + 1.12, 6, function (c) { c.fillStyle = team; c.fillRect(-6, -6, 12, 4); c.strokeStyle = INKLINE; c.lineWidth = 0.6; c.strokeRect(-6, -6, 12, 4); });
    // back struts, behind the glass
    [Math.PI, Math.PI * 1.5].forEach(function (a) {
      const u = 1.5 + Math.cos(a) * 1.02, v = 1.5 + Math.sin(a) * 1.02;
      beam(g, [u, v, 14], [u, v, 54], 3, metal);
    });
    // feed pipe and valve
    beam(g, [2.2, 0.75, 9], [2.62, 0.48, 9], 3.2, metal);
    beam(g, [2.62, 0.48, 9], [2.62, 0.48, 24], 3.2, metal);
    const p = P(2.62, 0.48, 26);
    g.beginPath(); g.ellipse(p[0], p[1], 5, 2.6, 0, 0, Math.PI * 2); g.strokeStyle = INKLINE; g.lineWidth = 2.6; g.stroke(); g.strokeStyle = '#c4473a'; g.lineWidth = 1.5; g.stroke();
    return null;
  };

  DRAW.barracks = function (g, w, h, lv, team, rng, rot) {
    const t = tierOf(lv, 5), f = finish(t), roof = roofOf(team);
    const R1 = !!rot;
    const L = function (a, b) { return R1 ? [b, a] : [a, b]; };
    const bx = function (a0, b0, a1, b1, z0, z1, col, o) { const p = L(a0, b0), q = L(a1, b1); block(g, rng, p[0], p[1], q[0], q[1], z0, z1, col, o); };
    const front = R1 ? 'R' : 'L', end = R1 ? 'L' : 'R';
    const hp = L(0.35, 0.35), hq = L(3.25, 1.95);
    bx(0.12, 0.12, 3.88, 2.88, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    // training yard
    const y0 = L(0.3, 2.08), y1 = L(3.7, 2.08), y2 = L(3.7, 2.72), y3 = L(0.3, 2.72);
    poly(g, [P(y0[0], y0[1], 5), P(y1[0], y1[1], 5), P(y2[0], y2[1], 5), P(y3[0], y3[1], 5)], shade(MAT.dirt, 0.12));
    // barrels at the far end
    [[3.55, 0.55], [3.55, 0.95]].forEach(function (a) { const p = L(a[0], a[1]); cyl(g, rng, p[0], p[1], 0.16, 5, 16, MAT.plank, { tex: 'bands', top: shade(MAT.plank, 0.15) }); });
    // longhouse
    block(g, rng, hp[0], hp[1], hq[0], hq[1], 5, 28, f.col, { tex: f.tex, frame: f.frame, top: false, course: 7 });
    const ax = function (len, a) { return R1 ? len - (a - 0.35) * TILE : (a - 0.35) * TILE; };
    onFace(g, front, hp[0], hp[1], hq[0], hq[1], 5, 28, function (c, len) {
      door(c, ax(len, 1.75), 13, 17, { frame: t ? shade(f.col, -0.3) : MAT.timber });
      [0.85, 2.65].forEach(function (a) { win(c, ax(len, a), 8, 7, 8); });
    });
    onFace(g, end, hp[0], hp[1], hq[0], hq[1], 5, 28, function (c, len) { win(c, len / 2, 8, 7, 8); });
    const ep = L(0.35, 0.35), eq = L(3.25, 1.95);
    eaveShade(g, ep[0], ep[1], eq[0], eq[1], 28);
    const rp = L(0.35, 0.22), rq = L(3.25, 2.08);
    gableRoof(g, rp[0], rp[1], rq[0], rq[1], 28, 48, roof, R1, function (c, len, ht) {
      TEX[f.tex](c, len, ht, shade(f.col, R1 ? FL : FR), rng, { frame: shade(MAT.timber, R1 ? FL : FR) });
      // crossed swords over a shield
      const x = len / 2, y = -ht * 0.36;
      c.lineCap = 'round';
      c.strokeStyle = INKLINE; c.lineWidth = 2.8;
      c.beginPath(); c.moveTo(x - 8, y - 5); c.lineTo(x + 8, y + 5); c.moveTo(x + 8, y - 5); c.lineTo(x - 8, y + 5); c.stroke();
      c.strokeStyle = '#e4e9ee'; c.lineWidth = 1.6; c.stroke();
      c.lineCap = 'butt';
      c.beginPath(); c.moveTo(x - 4.5, y - 4.5); c.lineTo(x + 4.5, y - 4.5); c.lineTo(x + 4.5, y + 0.5); c.quadraticCurveTo(x + 4.5, y + 4.5, x, y + 6.5); c.quadraticCurveTo(x - 4.5, y + 4.5, x - 4.5, y + 0.5); c.closePath();
      c.fillStyle = team; c.fill(); c.strokeStyle = INKLINE; c.lineWidth = 0.8; c.stroke();
      c.strokeStyle = 'rgba(255,240,210,0.8)'; c.lineWidth = 0.9; c.beginPath(); c.moveTo(x, y - 3); c.lineTo(x, y + 4); c.stroke();
    });
    // training dummy and weapon rack in the yard
    const d = L(0.8, 2.42);
    pole(g, d[0], d[1], 5, 26, 2.2, MAT.timber);
    cyl(g, rng, d[0], d[1], 0.12, 12, 24, MAT.burlap, { top: shade(MAT.burlap, 0.2) });
    beam(g, [d[0] - 0.18, d[1] + 0.18, 20], [d[0] + 0.18, d[1] - 0.18, 20], 2, MAT.timber);
    const r0 = L(2.3, 2.45), r1 = L(3.2, 2.45);
    beam(g, [r0[0], r0[1], 5], [r0[0], r0[1], 20], 2, MAT.timber);
    beam(g, [r1[0], r1[1], 5], [r1[0], r1[1], 20], 2, MAT.timber);
    for (let k = 0; k < 4; k++) {
      const a = L(2.42 + k * 0.22, 2.4);
      g.strokeStyle = INKLINE; g.lineWidth = 1.6; const s0 = P(a[0], a[1], 6), s1 = P(a[0], a[1], 26); line(g, s0, s1);
      g.strokeStyle = '#c9d0d6'; g.lineWidth = 0.9; line(g, s0, s1);
    }
    beam(g, [r0[0], r0[1], 17], [r1[0], r1[1], 17], 2, MAT.timber);
    const f1 = L(0.22, 2.78), f2 = L(3.78, 0.22);
    pole(g, f1[0], f1[1], 5, 46); pole(g, f2[0], f2[1], 5, 46);
    const flags = [pennantSpec(f1[0], f1[1], 46, 13, 8), pennantSpec(f2[0], f2[1], 46, 13, 8)];
    return { flags: flags };
  };

  // Ridge tent in canvas with a team stripe; the open end faces the camera.
  function tent(g, rng, u0, v0, u1, v1, z1, alongV, team) {
    const cloth = MAT.canvas;
    gableRoof(g, u0, v0, u1, v1, 1, z1, cloth, alongV, function (c, len, ht) {
      c.fillStyle = shade(cloth, alongV ? FL : FR); c.fillRect(0, -ht, len, ht);
      c.beginPath(); c.moveTo(len * 0.5, -ht * 0.92); c.lineTo(len * 0.72, 0); c.lineTo(len * 0.28, 0); c.closePath();
      c.fillStyle = '#3a2a1e'; c.fill();
      c.beginPath(); c.moveTo(len * 0.5, -ht * 0.92); c.lineTo(len * 0.62, 0); c.lineTo(len * 0.72, 0); c.closePath();
      c.fillStyle = shade(cloth, -0.2); c.fill();
    }, { plain: true, row: 9, barge: shade(cloth, -0.3) });
    // team stripe along the front eave
    if (!alongV) edgeLine(g, [u0, v1 - 0.06, 4], [u1, v1 - 0.06, 4], 2.2, team);
    else edgeLine(g, [u1 - 0.06, v0, 4], [u1 - 0.06, v1, 4], 2.2, team);
  }

  DRAW.garrison = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 6);
    // packed earth yard with a ragged edge
    g.save(); g.transform(HW, HH, -HW, HH, 0, 0);
    g.beginPath();
    for (let i = 0; i < 40; i++) {
      const a = i / 40 * Math.PI * 2, r = 1.78 + Math.sin(i * 1.7) * 0.05 + (rng.next() - 0.5) * 0.06;
      const k = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const x = 2 + Math.cos(a) * r / k * 0.98, y = 2 + Math.sin(a) * r / k * 0.98;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
    g.fillStyle = MAT.dirt; g.fill();
    g.fillStyle = 'rgba(255,240,210,0.1)';
    for (let i = 0; i < 40; i++) { g.beginPath(); g.arc(rng.range(0.5, 3.5), rng.range(0.5, 3.5), rng.range(0.04, 0.1), 0, Math.PI * 2); g.fill(); }
    g.restore();
    // palisade along the back edges
    const stakes = [];
    for (let u = 0.3; u < 3.8; u += 0.23) stakes.push([u, 0.22]);
    for (let v = 0.45; v < 3.8; v += 0.23) stakes.push([0.22, v]);
    const sh = 18 + t * 4;
    stakes.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }).forEach(function (s) {
      const c = t === 2 ? MAT.stone : MAT.plank;
      cyl(g, rng, s[0], s[1], 0.1, 0, sh, c, { top: false });
      cone(g, s[0], s[1], 0.1, sh, sh + 5, shade(c, 0.05), 1);
    });
    if (t >= 1) { beam(g, [0.3, 0.3, sh - 6], [3.8, 0.3, sh - 6], 1.6, MAT.timber); beam(g, [0.3, 0.3, sh - 6], [0.3, 3.8, sh - 6], 1.6, MAT.timber); }
    tent(g, rng, 0.45, 0.45, 1.6, 1.4, 27 + t * 3, false, team);
    tent(g, rng, 2.3, 0.45, 3.3, 1.55, 25 + t * 3, true, team);
    tent(g, rng, 0.45, 2.3, 1.55, 3.3, 25 + t * 3, false, team);
    // fire pit ring (flames drawn live) and benches
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2;
      lump(g, 2.3 + Math.cos(a) * 0.36, 2.3 + Math.sin(a) * 0.36, 0, 3.4, 2.4, MAT.stoneCool);
    }
    disk(g, 2.3, 2.3, 0.5, 0.28, '#3a2f28');
    block(g, rng, 1.85, 2.98, 2.95, 3.2, 0, 4, MAT.plank, { tex: 'plank' });
    block(g, rng, 2.98, 1.85, 3.2, 2.95, 0, 4, MAT.plank, { tex: 'plank' });
    pole(g, 3.62, 3.62, 0, 52, 2);
    return { flags: [pennantSpec(3.62, 3.62, 52, 17, 11)] };
  };

  DRAW.lab = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 5), stone = [MAT.stone, MAT.stone, MAT.dressed][t];
    block(g, rng, 0.12, 0.12, 2.88, 2.88, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    // alchemy bench at the right corner
    block(g, rng, 2.2, 0.32, 2.72, 0.75, 5, 13, MAT.plank, { tex: 'plank' });
    [['#62e08a', 2.34, 0.5], ['#ff6fae', 2.52, 0.46], ['#6fc3ff', 2.6, 0.62]].forEach(function (q) {
      const p = P(q[1], q[2], 13);
      g.fillStyle = q[0]; g.strokeStyle = INKLINE; g.lineWidth = 0.7;
      g.beginPath(); g.moveTo(p[0] - 1, p[1] - 7); g.lineTo(p[0] + 1, p[1] - 7); g.lineTo(p[0] + 3, p[1]); g.lineTo(p[0] - 3, p[1]); g.closePath(); g.fill(); g.stroke();
    });
    cyl(g, rng, 1.5, 1.5, 1.02, 5, 40, stone, { tex: 'stone', course: 7, n: 9, top: false });
    decal(g, 'L', 1.5, 2.52, 5, function (c) { door(c, 0, 10, 16, { col: '#3b3a4a', frame: shade(stone, -0.25) }); });
    decal(g, 'R', 2.52, 1.5, 22, function (c) { win(c, 0, 0, 6, 9, { arch: true, glow: '#9ff5d0' }); });
    decal(g, 'L', 1.5, 2.52, 27, function (c) { win(c, 0, 0, 5, 7, { arch: true, glow: '#9ff5d0' }); });
    cyl(g, rng, 1.5, 1.5, 1.08, 40, 44, t === 2 ? MAT.gold : shade(stone, -0.08), {});
    dome(g, 1.5, 1.5, 1.0, 44, MAT.verdigris, 5);
    // observation slit and telescope
    const s0 = P(1.5, 1.5, 70), s1 = P(2.18, 2.18, 50);
    g.strokeStyle = '#26323a'; g.lineWidth = 5; g.lineCap = 'round'; line(g, s0, s1); g.lineCap = 'butt';
    beam(g, [1.62, 1.62, 60], [2.3, 1.85, 82], 4.4, MAT.brass);
    const tp = P(2.3, 1.85, 82);
    g.beginPath(); g.ellipse(tp[0], tp[1], 2.6, 3, 0.6, 0, Math.PI * 2); g.fillStyle = '#1d2630'; g.fill(); g.strokeStyle = shade(MAT.brass, -0.3); g.stroke();
    finial(g, 1.5, 1.5, 83, MAT.brass);
    pole(g, 0.3, 2.7, 5, 42);
    return { flags: [pennantSpec(0.3, 2.7, 42, 13, 8)] };
  };

  DRAW.station = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 4), roof = roofOf(team);
    block(g, rng, 0.1, 0.1, 1.9, 1.9, 0, 4, MAT.stoneDark, { tex: 'stone', course: 4, block: 10 });
    // crane mast and boom
    block(g, rng, 1.55, 0.22, 1.72, 0.39, 4, 48, MAT.timber, { tex: 'plank' });
    beam(g, [1.635, 0.3, 45], [1.635, 1.5, 47], 2.4, MAT.timber);
    beam(g, [1.635, 0.3, 30], [1.635, 0.85, 45], 1.6, MAT.timber);
    const a = P(1.635, 1.45, 47), b = P(1.635, 1.45, 30);
    g.strokeStyle = '#3a3330'; g.lineWidth = 0.9; line(g, a, b);
    // hut
    block(g, rng, 0.25, 0.3, 1.32, 1.5, 4, 23, t >= 2 ? MAT.stone : MAT.plank, { tex: t >= 2 ? 'stone' : 'plank', top: false });
    onFace(g, 'L', 0.25, 0.3, 1.32, 1.5, 4, 23, function (c, len) {
      door(c, len * 0.4, 9, 13, {});
      c.strokeStyle = '#d7dde3'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(len * 0.78 - 3, -15); c.lineTo(len * 0.78 + 3, -9); c.stroke();
      c.fillStyle = MAT.timber; c.save(); c.translate(len * 0.78, -12); c.rotate(-0.8); c.fillRect(-4, -0.9, 8, 1.8); c.restore();
    });
    onFace(g, 'R', 0.25, 0.3, 1.32, 1.5, 4, 23, function (c, len) { win(c, len * 0.5, 7, 6, 7); });
    eaveShade(g, 0.25, 0.3, 1.32, 1.5, 23);
    gableRoof(g, 0.14, 0.3, 1.43, 1.5, 23, 38, roof, true, function (c, len, ht) {
      TEX.plank(c, len, ht, shade(MAT.plank, FL), rng);
    });
    // hanging crate and lumber
    block(g, rng, 1.5, 1.33, 1.77, 1.58, 21, 30, MAT.fresh, { tex: 'plank' });
    for (let k = 0; k < 3; k++) block(g, rng, 0.25, 1.62 + k * 0.02, 1.25, 1.8 + k * 0.02, 4 + k * 2.2, 6 + k * 2.2, shade(MAT.fresh, -k * 0.06), {});
    pole(g, 0.2, 0.2, 4, 40);
    return { flags: [pennantSpec(0.2, 0.2, 40, 12, 7)] };
  };

  DRAW.blaster = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 7), stone = [MAT.stone, MAT.dressed, MAT.stoneCool][t], trim = TRIM[t];
    cyl(g, rng, 1.5, 1.5, 1.38, 0, 14, stone, { tex: 'stone', course: 7, n: 12, top: shade(stone, TOP) });
    disk(g, 1.5, 1.5, 14, 1.02, shade(MAT.plank, TOP - 0.1), EDGE);
    const merl = [];
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 + 0.31; merl.push([1.5 + Math.cos(a) * 1.2, 1.5 + Math.sin(a) * 1.2]); }
    merl.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }).forEach(function (p) {
      block(g, rng, p[0] - 0.13, p[1] - 0.13, p[0] + 0.13, p[1] + 0.13, 14, 21, stone, {});
    });
    cyl(g, rng, 1.5, 1.5, 0.62, 14, 18, MAT.iron, { top: shade(MAT.iron, 0.3) });
    disk(g, 1.5, 1.5, 18, 0.5, alpha(team, 0.9));
    if (t === 2) cyl(g, rng, 1.5, 1.5, 1.4, 11, 14, trim, { top: false });
    return null;
  };

  DRAW.spire = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 7), f = finish(t), stone = [MAT.stone, MAT.stone, MAT.dressed][t];
    block(g, rng, 0.35, 0.35, 2.65, 2.65, 0, 8, MAT.stoneDark, { tex: 'stone', course: 4, block: 12 });
    block(g, rng, 0.78, 0.78, 2.22, 2.22, 8, 40, stone, { tex: 'stone', top: false, course: 7, block: 13 });
    const upper = t === 0 ? { col: MAT.plank, tex: 'plank' } : t === 1 ? f : { col: MAT.dressed, tex: 'dressed' };
    block(g, rng, 0.8, 0.8, 2.2, 2.2, 40, 60, upper.col, { tex: upper.tex, frame: upper.frame, top: false });
    onFace(g, 'L', 0.78, 0.78, 2.22, 2.22, 8, 60, function (c, len) { slit(c, len / 2, 14, 10); slit(c, len / 2, 38, 8); });
    onFace(g, 'R', 0.78, 0.78, 2.22, 2.22, 8, 60, function (c, len) { slit(c, len / 2, 24, 10); });
    // corbels under the overhanging fighting platform
    for (let k = 0.95; k < 2.2; k += 0.4) {
      block(g, rng, k - 0.07, 2.2, k + 0.07, 2.4, 54, 60, MAT.timber, {});
      block(g, rng, 2.2, k - 0.07, 2.4, k + 0.07, 54, 60, MAT.timber, {});
    }
    const deck = t === 0 ? MAT.plank : stone;
    block(g, rng, 0.6, 0.6, 2.4, 2.4, 60, 64, deck, { tex: t === 0 ? 'plank' : 'stone', course: 4, block: 10, top: shade(MAT.plank, TOP - 0.18) });
    // parapet: back edges, flag pole, then front edges (the ballista is drawn live above them)
    const wallTop = 68, mz = 73;
    block(g, rng, 0.6, 0.6, 2.4, 0.76, 64, wallTop, deck, { tex: t === 0 ? 'plank' : 'stone', course: 4, block: 8 });
    block(g, rng, 0.6, 0.76, 0.76, 2.4, 64, wallTop, deck, { tex: t === 0 ? 'plank' : 'stone', course: 4, block: 8 });
    [[0.6, 0.6], [1.32, 0.6], [2.04, 0.6], [0.6, 1.32], [0.6, 2.04]].forEach(function (q) { block(g, rng, q[0], q[1], q[0] + 0.36, q[1] + 0.16, wallTop, mz, deck, {}); });
    pole(g, 0.68, 0.68, mz, 112, 2);
    block(g, rng, 2.24, 0.76, 2.4, 2.4, 64, wallTop, deck, { tex: t === 0 ? 'plank' : 'stone', course: 4, block: 8 });
    block(g, rng, 0.76, 2.24, 2.24, 2.4, 64, wallTop, deck, { tex: t === 0 ? 'plank' : 'stone', course: 4, block: 8 });
    [[2.24, 1.0], [2.24, 1.72], [1.0, 2.24], [1.72, 2.24], [2.24, 2.24]].forEach(function (q) { block(g, rng, q[0], q[1], q[0] + 0.16, q[1] + (q[0] === 2.24 && q[1] === 2.24 ? 0.16 : 0.36), wallTop, mz, deck, {}); });
    if (t === 2) block(g, rng, 0.58, 0.58, 2.42, 2.42, 60, 62, MAT.gold, { top: false });
    return { flags: [pennantSpec(0.68, 0.68, 112, 20, 9)] };
  };

  DRAW.mortar = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 6), bag = [MAT.burlap, '#b9ab8e', '#8e9399'][t];
    cyl(g, rng, 1.5, 1.5, 1.34, 0, 5, shade(MAT.dirt, -0.05), { top: shade(MAT.dirt, 0.1) });
    const ring = [];
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 14; i++) {
        const a = (i + row * 0.5) / 14 * Math.PI * 2;
        ring.push({ u: 1.5 + Math.cos(a) * 1.1, v: 1.5 + Math.sin(a) * 1.1, z: 5 + row * 6, row: row });
      }
    }
    const back = ring.filter(function (s) { return s.u + s.v < 3; }), fr = ring.filter(function (s) { return s.u + s.v >= 3; });
    const draw = function (s) { lump(g, s.u, s.v, s.z, 9.5, 5, shade(bag, s.row ? 0.04 : -0.04)); };
    back.sort(function (a, b) { return a.row - b.row || (a.u + a.v) - (b.u + b.v); }).forEach(draw);
    disk(g, 1.5, 1.5, 6, 0.88, '#3b332b', EDGE);
    disk(g, 1.5, 1.5, 6.5, 0.6, '#4a4035');
    // shell stack
    [[1.05, 0.9], [1.2, 0.8], [1.12, 0.86]].forEach(function (s, i) {
      const p = P(s[0], s[1], 6 + (i === 2 ? 4 : 0));
      g.beginPath(); g.arc(p[0], p[1] - 3, 3.2, 0, Math.PI * 2); g.fillStyle = '#2d2f33'; g.fill(); g.strokeStyle = INKLINE; g.lineWidth = 0.7; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(p[0] - 1.6, p[1] - 5, 1.2, 1.2);
    });
    fr.sort(function (a, b) { return a.row - b.row || (a.u + a.v) - (b.u + b.v); }).forEach(draw);
    pole(g, 0.42, 2.58, 3, 40);
    return { flags: [pennantSpec(0.42, 2.58, 40, 13, 8)] };
  };

  DRAW.frost = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 7);
    block(g, rng, 0.15, 0.15, 1.85, 1.85, 0, 6, MAT.stoneCool, { tex: 'stone', course: 6, block: 11 });
    ['L', 'R'].forEach(function (s) {
      onFace(g, s, 0.15, 0.15, 1.85, 1.85, 0, 6, function (c, len, ht) {
        c.strokeStyle = 'rgba(150,230,255,0.9)'; c.lineWidth = 1;
        c.beginPath(); for (let x = 6; x < len - 4; x += 9) { c.moveTo(x, -1.5); c.lineTo(x + 2.5, -ht + 1.5); c.lineTo(x + 5, -1.5); } c.stroke();
      });
    });
    block(g, rng, 0.42, 0.42, 1.58, 1.58, 6, 10, shade(MAT.stoneCool, -0.1), {});
    // faceted ice obelisk flanked by two shards (a: half-width at the base, b: at the shoulder)
    const shard = function (u, v, a, b, z0, z1, z2) {
      poly(g, [P(u - a, v + a, z0), P(u + a, v + a, z0), P(u + b, v + b, z1), P(u - b, v + b, z1)], '#d4f3ff', EDGE);
      poly(g, [P(u + a, v + a, z0), P(u + a, v - a, z0), P(u + b, v - b, z1), P(u + b, v + b, z1)], '#7fbad6', EDGE);
      poly(g, [P(u - b, v + b, z1), P(u + b, v + b, z1), P(u, v, z2)], '#effcff', EDGE);
      poly(g, [P(u + b, v + b, z1), P(u + b, v - b, z1), P(u, v, z2)], '#a8d8ee', EDGE);
    };
    const z0 = 10, z1 = 46 + t * 3, a0 = 0.56, a1 = 1.44, b0 = 0.8, b1 = 1.2;
    shard(0.34, 1.62, 0.13, 0.07, 6, 20 + t * 2, 27 + t * 2);
    shard(1, 1, 0.44, 0.2, z0, z1, z1 + 9);
    shard(1.64, 0.36, 0.12, 0.06, 6, 15 + t * 2, 21 + t * 2);
    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1;
    line(g, P(a0 + 0.12, a1, z0 + 6), P(b0 + 0.06, b1, z1 - 5));
    g.strokeStyle = 'rgba(40,110,150,0.35)';
    line(g, P(a1, a1 - 0.3, z0 + 4), P(b1, b1 - 0.1, z1 - 8));
    decal(g, 'L', 1, 1.44, 16, function (c) { c.fillStyle = alpha(team, 0.75); c.beginPath(); c.moveTo(0, -12); c.lineTo(3, -6); c.lineTo(0, 0); c.lineTo(-3, -6); c.closePath(); c.fill(); });
    return null;
  };

  // Hero homes: an open platform the hero stands on (drawn live), so the hero is the building's face.
  DRAW.hall = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 5), stone = [MAT.stone, MAT.stone, MAT.dressed][t];
    block(g, rng, 0.15, 0.15, 2.85, 2.85, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    // braziers on stone posts at the back corners (flames are live)
    [[0.5, 1.2], [1.2, 0.5]].forEach(function (p) {
      cyl(g, rng, p[0], p[1], 0.2, 5, 24, stone, { tex: 'stone', course: 6, n: 4, top: false });
      cyl(g, rng, p[0], p[1], 0.28, 24, 28, t ? MAT.brass : MAT.iron, { top: shade('#2a1a10', 0.1) });
    });
    pole(g, 0.45, 0.45, 5, 56, 2);
    block(g, rng, 0.75, 0.75, 2.45, 2.45, 5, 10, stone, { tex: 'stone', course: 5, block: 10 });
    onFace(g, 'L', 0.75, 0.75, 2.45, 2.45, 5, 10, function (c, len) { c.fillStyle = alpha(team, 0.85); c.fillRect(len / 2 - 6, -4.5, 12, 3); });
    // steps down the front
    block(g, rng, 1.15, 2.45, 2.05, 2.75, 5, 7.5, shade(stone, -0.05), {});
    block(g, rng, 2.45, 1.15, 2.75, 2.05, 5, 7.5, shade(stone, -0.05), {});
    if (t === 2) block(g, rng, 0.72, 0.72, 2.48, 2.48, 9, 10, MAT.gold, { top: false });
    return { flags: [pennantSpec(0.45, 0.45, 56, 18, 11)] };
  };

  DRAW.lodge = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 5);
    block(g, rng, 0.15, 0.15, 2.85, 2.85, 0, 4, MAT.plank, { tex: 'plank' });
    block(g, rng, 0.3, 0.3, 1.4, 1.4, 4, 20, t ? MAT.stone : MAT.timber, { tex: t ? 'stone' : 'plank', top: false });
    onFace(g, 'L', 0.3, 0.3, 1.4, 1.4, 4, 20, function (c, len) { door(c, len / 2, 8, 11, {}); });
    onFace(g, 'R', 0.3, 0.3, 1.4, 1.4, 4, 20, function (c, len) { win(c, len / 2, 6, 5, 6, { glow: '#9fe0ff' }); });
    eaveShade(g, 0.3, 0.3, 1.4, 1.4, 20);
    hipRoof(g, 0.2, 0.2, 1.5, 1.5, 20, 34, roofOf(team));
    // straw practice target
    cyl(g, rng, 2.35, 0.7, 0.3, 4, 14, MAT.burlap, { top: shade(MAT.burlap, 0.15) });
    decal(g, 'L', 2.35, 1.0, 6, function (c) {
      [[4.5, '#f3ecdc'], [3, team], [1.4, '#f3ecdc']].forEach(function (r) { c.beginPath(); c.arc(0, -3, r[0], 0, Math.PI * 2); c.fillStyle = r[1]; c.fill(); });
    });
    if (t === 2) block(g, rng, 0.14, 0.14, 2.86, 2.86, 3, 4, MAT.gold, { top: false });
    pole(g, 0.35, 2.65, 4, 46);
    return { flags: [pennantSpec(0.35, 2.65, 46, 14, 9)] };
  };

  DRAW.lance = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 6), metal = [MAT.iron, '#5d6670', '#3c4350'][t];
    block(g, rng, 0.3, 0.3, 2.7, 2.7, 0, 8, metal, { tex: 'metal', block: 16 });
    block(g, rng, 0.55, 0.55, 2.45, 2.45, 8, 12, shade(metal, 0.12), { tex: 'metal', block: 12 });
    decal(g, 'L', 1.5, 2.7, 1.5, function (c) { c.fillStyle = team; c.fillRect(-9, -5, 18, 3); });
    const post = function (u, v) {
      for (let k = 0; k < 4; k++) cyl(g, rng, u, v, 0.11 - k * 0.012, 12 + k * 4, 15 + k * 4, k % 2 ? '#f0ebe0' : '#8a5a3c', {});
      beam(g, [u, v, 28], [1.5 + (u - 1.5) * 0.45, 1.5 + (v - 1.5) * 0.45, 46], 1.4, MAT.copper);
    };
    post(0.78, 0.78); post(2.22, 0.78); post(0.78, 2.22);
    cyl(g, rng, 1.5, 1.5, 0.42, 12, 54, shade(metal, 0.05), { top: false });
    [18, 25, 32, 39, 46].forEach(function (z) {
      const c = P(1.5, 1.5, z), rr = radii(0.56);
      g.beginPath(); g.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI);
      g.strokeStyle = INKLINE; g.lineWidth = 4.2; g.stroke();
      g.strokeStyle = MAT.copper; g.lineWidth = 2.8; g.stroke();
      g.strokeStyle = shade(MAT.copper, 0.35); g.lineWidth = 0.8;
      g.beginPath(); g.ellipse(c[0], c[1] - 0.8, rr[0] * 0.95, rr[1], 0, 0.5, 1.6); g.stroke();
    });
    cyl(g, rng, 1.5, 1.5, 0.3, 54, 58, MAT.brass, { top: '#2b2f36' });
    post(2.22, 2.22);
    return null;
  };

  DRAW.mine = function (g, w, h, lv, team, rng) {
    disk(g, 0.5, 0.5, 0.5, 0.32, '#3d3a36', EDGE);
    cyl(g, rng, 0.5, 0.5, 0.2, 0.5, 3, '#5c5650', {});
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4, p = P(0.5 + Math.cos(a) * 0.27, 0.5 + Math.sin(a) * 0.27, 1);
      g.fillStyle = '#26231f'; g.beginPath(); g.arc(p[0], p[1], 1.6, 0, Math.PI * 2); g.fill();
    }
    return null;
  };

  // Anti-air pit: a squat armoured emplacement; the twin guns are drawn live so they can aim.
  DRAW.flak = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 5), plate = [MAT.stoneCool, MAT.steel, '#7d8894'][t];
    block(g, rng, 0.2, 0.2, 2.8, 2.8, 0, 6, MAT.stoneDark, { tex: 'stone', course: 3, block: 12 });
    block(g, rng, 0.45, 0.45, 2.55, 2.55, 6, 13, plate, { tex: t ? 'metal' : 'stone', block: 12, top: shade(plate, TOP - 0.08) });
    ['L', 'R'].forEach(function (s) {
      onFace(g, s, 0.45, 0.45, 2.55, 2.55, 6, 13, function (c, len, ht) {
        for (let x = 3; x < len - 3; x += 8) { c.fillStyle = x % 16 < 8 ? team : '#2d2f33'; c.fillRect(x, -ht + 2, 5, 2.4); }
      });
    });
    // ammunition crates in the corners
    [[0.62, 2.1], [2.1, 0.62]].forEach(function (q) { block(g, rng, q[0], q[1], q[0] + 0.3, q[1] + 0.3, 13, 17, MAT.plank, { tex: 'plank' }); });
    cyl(g, rng, 1.5, 1.5, 0.78, 13, 16, MAT.iron, { top: shade(MAT.iron, 0.25) });
    if (t === 2) cyl(g, rng, 1.5, 1.5, 0.84, 12, 13.5, MAT.gold, { top: false });
    return null;
  };

  // Rail gun bastion: a dressed-stone redoubt with copper coils; the barrel is drawn live.
  DRAW.rail = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 4), stone = t ? MAT.dressed : MAT.stone;
    block(g, rng, 0.12, 0.12, 2.88, 2.88, 0, 8, MAT.stoneDark, { tex: 'stone', course: 4, block: 12 });
    block(g, rng, 0.38, 0.38, 2.62, 2.62, 8, 24, stone, { tex: 'dressed', course: 6, block: 14, top: shade(stone, TOP - 0.1) });
    ['L', 'R'].forEach(function (s) {
      onFace(g, s, 0.38, 0.38, 2.62, 2.62, 8, 24, function (c, len, ht) {
        c.fillStyle = shade(MAT.copper, s === 'L' ? FL : FR); c.fillRect(0, -ht * 0.55 - 1.5, len, 3);
        c.fillStyle = alpha(team, 0.9); c.fillRect(len / 2 - 6, -ht + 2, 12, 3);
      });
    });
    [[0.6, 0.6], [2.4, 0.6], [0.6, 2.4], [2.4, 2.4]].forEach(function (q) {
      for (let k = 0; k < 3; k++) cyl(g, rng, q[0], q[1], 0.16, 24 + k * 3, 26 + k * 3, k % 2 ? shade(MAT.copper, 0.2) : MAT.copper, {});
    });
    if (t === 2) block(g, rng, 0.36, 0.36, 2.64, 2.64, 22, 24, MAT.gold, { top: false });
    return null;
  };

  DRAW.snare = function (g, w, h, lv, team, rng) {
    disk(g, 0.5, 0.5, 0.5, 0.34, '#4a463f', EDGE);
    cyl(g, rng, 0.5, 0.5, 0.22, 0.5, 4, '#6b6458', {});
    beam(g, [0.5, 0.5, 4], [0.42, 0.42, 9], 2.6, MAT.brass);
    return null;
  };

  // Reserve Bunker: thick poured-stone strongroom with a riveted steel door; stock shows live on the roof.
  DRAW.bunker = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 3), slab = t === 2 ? '#8d939b' : MAT.stoneCool;
    block(g, rng, 0.1, 0.1, 2.9, 2.9, 0, 5, MAT.stoneDark, { tex: 'stone', course: 3, block: 14 });
    block(g, rng, 0.3, 0.3, 2.7, 2.7, 5, 28, slab, { tex: 'stone', course: 9, block: 20, top: shade(slab, TOP - 0.06) });
    onFace(g, 'L', 0.3, 0.3, 2.7, 2.7, 5, 28, function (c, len, ht) {
      c.fillStyle = '#5d646d'; c.fillRect(len / 2 - 9, -17, 18, 17);
      c.strokeStyle = INKLINE; c.lineWidth = 1; c.strokeRect(len / 2 - 9, -17, 18, 17);
      c.fillStyle = MAT.steel; for (let y = -15; y < 0; y += 4) { c.fillRect(len / 2 - 7.5, y, 1.2, 1.2); c.fillRect(len / 2 + 6.3, y, 1.2, 1.2); }
      c.beginPath(); c.arc(len / 2, -8.5, 3.6, 0, Math.PI * 2); c.strokeStyle = MAT.brass; c.lineWidth = 1.4; c.stroke();
      c.fillStyle = team; c.fillRect(4, -ht + 3, len - 8, 2.4);
    });
    onFace(g, 'R', 0.3, 0.3, 2.7, 2.7, 5, 28, function (c, len, ht) {
      c.fillStyle = shade(MAT.iron, FR); c.fillRect(0, -ht * 0.4 - 1.5, len, 3);
      c.fillStyle = team; c.fillRect(4, -ht + 3, len - 8, 2.4);
    });
    block(g, rng, 0.22, 0.22, 2.78, 2.78, 28, 31, shade(slab, -0.1), { top: shade(slab, TOP - 0.12) });
    if (t >= 1) [[0.34, 0.34], [2.66, 0.34], [0.34, 2.66], [2.66, 2.66]].forEach(function (q) { cyl(g, rng, q[0], q[1], 0.1, 31, 34, t === 2 ? MAT.gold : MAT.brass, {}); });
    return null;
  };

  // Spell Forge: a kiln-house with a cauldron out front; brewed flasks stand on the shelf (live).
  DRAW.forge = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 5), f = finish(t);
    block(g, rng, 0.12, 0.12, 2.88, 2.88, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    block(g, rng, 0.55, 0.55, 0.92, 0.92, 26, 54, MAT.brick, { tex: 'brick' });
    block(g, rng, 0.3, 0.3, 1.8, 1.9, 5, 28, f.col, { tex: f.tex, frame: f.frame, top: false });
    onFace(g, 'L', 0.3, 0.3, 1.8, 1.9, 5, 28, function (c, len) { door(c, len * 0.36, 8, 12, {}); win(c, len * 0.76, 9, 5, 6, { glow: '#c7a2ff' }); });
    onFace(g, 'R', 0.3, 0.3, 1.8, 1.9, 5, 28, function (c, len) { win(c, len * 0.5, 9, 6, 8, { arch: true, glow: '#c7a2ff' }); });
    eaveShade(g, 0.3, 0.3, 1.8, 1.9, 28);
    hipRoof(g, 0.18, 0.18, 1.92, 2.02, 28, 42, roofOf(team));
    // cauldron on a fire ring, and the flask shelf
    cyl(g, rng, 2.2, 2.2, 0.5, 5, 8, MAT.stoneDark, { tex: 'stone', top: '#3a2418' });
    cyl(g, rng, 2.2, 2.2, 0.42, 8, 15, MAT.iron, { tex: 'bands', top: '#2a2230' });
    block(g, rng, 2.3, 0.3, 2.72, 1.75, 5, 13, MAT.plank, { tex: 'plank' });
    if (t === 2) block(g, rng, 0.28, 0.28, 1.82, 1.92, 26, 28, MAT.gold, { top: false });
    pole(g, 0.3, 2.65, 5, 44);
    return { flags: [pennantSpec(0.3, 2.65, 44, 13, 8)] };
  };

  // Ember Brazier: a fire bowl on a squat column; the flames and their heat ring are live.
  DRAW.brazier = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 6), stone = [MAT.stone, MAT.dressed, MAT.obsidian][t], metal = [MAT.iron, MAT.brass, MAT.gold][t];
    block(g, rng, 0.15, 0.15, 1.85, 1.85, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 10 });
    cyl(g, rng, 1, 1, 0.42, 5, 18, stone, { tex: 'stone', course: 6, n: 6, top: false });
    decal(g, 'L', 1, 1.42, 9, function (c) { c.fillStyle = alpha(team, 0.85); c.fillRect(-4, -4, 8, 3); });
    cyl(g, rng, 1, 1, 0.6, 18, 22, shade(metal, -0.15), { top: false });
    cyl(g, rng, 1, 1, 0.8, 22, 25, metal, { tex: 'bands', top: '#2a1a10' });
    disk(g, 1, 1, 25, 0.6, '#5a2a14');
    return null;
  };

  // Hailstorm Tower: a frosted round tower; the triple launcher on top is live.
  DRAW.hail = function (g, w, h, lv, team, rng) {
    const t = tierOf(lv, 5), stone = [MAT.stoneCool, '#b8c4cc', '#d9e4ea'][t];
    block(g, rng, 0.25, 0.25, 2.75, 2.75, 0, 7, MAT.stoneDark, { tex: 'stone', course: 4, block: 12 });
    cyl(g, rng, 1.5, 1.5, 0.98, 7, 38, stone, { tex: 'stone', course: 7, n: 10, top: false });
    decal(g, 'L', 1.5, 2.48, 14, function (c) { slit(c, 0, 0, 9); });
    decal(g, 'R', 2.48, 1.5, 20, function (c) { slit(c, 0, 0, 8); });
    cyl(g, rng, 1.5, 1.5, 1.12, 38, 45, '#7fbad6', { top: shade(stone, TOP - 0.05) });
    // icicles under the frost band
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (0.05 + i * 0.13) - Math.PI / 4, p = P(1.5 + Math.cos(a) * 1.1, 1.5 + Math.sin(a) * 1.1, 38);
      poly(g, [[p[0] - 1.6, p[1]], [p[0] + 1.6, p[1]], [p[0], p[1] + 4 + (i % 3) * 2]], '#e4f8ff', EDGE);
    }
    decal(g, 'L', 1.5, 2.6, 40, function (c) { c.fillStyle = alpha(team, 0.9); c.fillRect(-6, -4, 12, 3); });
    if (t === 2) cyl(g, rng, 1.5, 1.5, 1.14, 44, 45.5, MAT.gold, { top: false });
    return null;
  };

  // Tempest Coil: a copper-wound mast between four posts; the storm orb on top is live.
  DRAW.tempest = function (g, w, h, lv, team, rng) {
    const metal = lv >= 3 ? '#3c4350' : '#5d6670';
    block(g, rng, 0.3, 0.3, 2.7, 2.7, 0, 10, metal, { tex: 'metal', block: 14 });
    decal(g, 'L', 1.5, 2.7, 2, function (c) { c.fillStyle = team; c.fillRect(-9, -5, 18, 3); });
    const post = function (u, v) {
      cyl(g, rng, u, v, 0.13, 10, 30, MAT.iron, { top: MAT.brass });
      beam(g, [u, v, 30], [1.5 + (u - 1.5) * 0.4, 1.5 + (v - 1.5) * 0.4, 58], 1.2, MAT.copper);
    };
    post(0.65, 0.65); post(2.35, 0.65); post(0.65, 2.35);
    cyl(g, rng, 1.5, 1.5, 0.36, 10, 66, shade(metal, 0.1), { top: false });
    for (let z = 16; z < 64; z += 5) {
      const c = P(1.5, 1.5, z), rr = radii(0.46);
      g.beginPath(); g.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI);
      g.strokeStyle = INKLINE; g.lineWidth = 3.4; g.stroke();
      g.strokeStyle = MAT.copper; g.lineWidth = 2.2; g.stroke();
    }
    cyl(g, rng, 1.5, 1.5, 0.48, 64, 68, MAT.brass, { top: '#2b2f36' });
    post(2.35, 2.35);
    return null;
  };

  // Siege Charge: a cluster of powder kegs wired to a plunger.
  DRAW.charge = function (g, w, h, lv, team, rng) {
    disk(g, 1, 1, 0.5, 0.78, '#4a3f33', EDGE);
    [[0.72, 0.78], [1.28, 0.78], [0.98, 1.26]].forEach(function (q) {
      cyl(g, rng, q[0], q[1], 0.27, 0.5, 13, '#8a5530', { tex: 'bands', top: shade('#8a5530', TOP) });
      disk(g, q[0], q[1], 13, 0.08, '#1b1612');
    });
    beam(g, [1.36, 1.36, 1], [1.36, 1.36, 8], 1.4, MAT.iron);
    block(g, rng, 1.24, 1.24, 1.48, 1.48, 8, 10, '#c4473a', {});
    g.strokeStyle = '#2b1e12'; g.lineWidth = 0.8; line(g, P(1.36, 1.36, 9), P(0.98, 1.26, 13));
    return null;
  };

  // Boss defenses: one of a kind, guarding a stronghold.
  // The Thornheart: a gnarled heartwood crown on a mossy mound; the heart floats live above it.
  DRAW.thornheart = function (g, w, h, lv, team, rng) {
    const bark = '#5b3d24', moss = '#4f6b34';
    cyl(g, rng, 2, 2, 1.85, 0, 6, '#5a4a33', { top: moss });
    const branch = function (a, z0, z1, r) {
      const e = [2 + Math.cos(a) * r, 2 + Math.sin(a) * r, z1];
      beam(g, [2 + Math.cos(a) * 0.3, 2 + Math.sin(a) * 0.3, z0], e, 4, bark);
      // thorny leaf clusters on the crown's branch tips
      if (z1 > z0) [[0, 0, 0], [0.16, -0.1, 4], [-0.12, 0.12, 3]].forEach(function (o) { lump(g, e[0] + o[0], e[1] + o[1], e[2] + o[2] - 4, 6.5, 4.5, rng.chance(0.5) ? moss : '#3f5a2a'); });
      const m = P(2 + Math.cos(a) * r * 0.6, 2 + Math.sin(a) * r * 0.6, z0 + (z1 - z0) * 0.6);
      poly(g, [[m[0] - 1.4, m[1]], [m[0] + 1.4, m[1]], [m[0] + 3.5, m[1] - 4]], '#c9b98a', EDGE);
    };
    const roots = [], crown = [];
    for (let i = 0; i < 7; i++) roots.push(i / 7 * Math.PI * 2 + 0.3);
    for (let i = 0; i < 6; i++) crown.push(i / 6 * Math.PI * 2);
    const depth = function (a) { return Math.cos(a) + Math.sin(a); };
    roots.sort(function (a, b) { return depth(a) - depth(b); });
    crown.sort(function (a, b) { return depth(a) - depth(b); });
    roots.filter(function (a) { return depth(a) < 0; }).forEach(function (a) { branch(a, 16, 6, 1.7); });
    crown.filter(function (a) { return depth(a) < 0; }).forEach(function (a) { branch(a, 40, 70, 1.35); });
    cyl(g, rng, 2, 2, 0.62, 6, 44, bark, { tex: 'bands', top: shade(bark, 0.15) });
    roots.filter(function (a) { return depth(a) >= 0; }).forEach(function (a) { branch(a, 16, 6, 1.7); });
    crown.filter(function (a) { return depth(a) >= 0; }).forEach(function (a) { branch(a, 40, 70, 1.35); });
    decal(g, 'L', 2, 2.55, 16, function (c) { c.fillStyle = alpha(team, 0.8); c.fillRect(-5, -4, 10, 3); });
    return null;
  };

  // Sunfire Bombard: a sandstone bastion; the great brass mortar is live.
  DRAW.bombard = function (g, w, h, lv, team, rng) {
    block(g, rng, 0.2, 0.2, 3.8, 3.8, 0, 10, MAT.stoneDark, { tex: 'stone', course: 5, block: 14 });
    block(g, rng, 0.6, 0.6, 3.4, 3.4, 10, 22, MAT.sandstone, { tex: 'dressed', course: 6, block: 14, top: shade(MAT.sandstone, TOP - 0.1) });
    ['L', 'R'].forEach(function (s) {
      onFace(g, s, 0.6, 0.6, 3.4, 3.4, 10, 22, function (c, len, ht) {
        c.fillStyle = shade(MAT.gold, s === 'L' ? FL : FR); c.fillRect(0, -ht + 1, len, 2);
        banner(c, len * 0.25, ht - 2, 7, 9, team); banner(c, len * 0.75, ht - 2, 7, 9, team);
      });
    });
    // round corner towers with gilded caps; shells stacked between them
    [[0.55, 0.55], [3.45, 0.55], [0.55, 3.45], [3.45, 3.45]].forEach(function (q) {
      cyl(g, rng, q[0], q[1], 0.42, 0, 30, MAT.sandstone, { tex: 'stone', course: 6, n: 5, top: false });
      cyl(g, rng, q[0], q[1], 0.48, 30, 34, MAT.gold, { top: shade(MAT.sandstone, TOP) });
    });
    [[1.2, 2.9], [2.9, 1.2]].forEach(function (q) {
      [[0, 0, 0], [0.22, 0, 0], [0.11, 0.1, 4]].forEach(function (o) {
        const p = P(q[0] + o[0], q[1] + o[1], 22 + o[2]);
        g.beginPath(); g.arc(p[0], p[1] - 3, 3.4, 0, Math.PI * 2); g.fillStyle = '#2d2f33'; g.fill(); g.strokeStyle = INKLINE; g.lineWidth = 0.7; g.stroke();
      });
    });
    return null;
  };

  // Wyrm Idol: a stepped obsidian dais with glowing seams; the turning wyrm head is live.
  DRAW.idol = function (g, w, h, lv, team, rng) {
    const seam = function (s) {
      return function (c, len, ht) {
        c.strokeStyle = '#ff8a2a'; c.lineWidth = 1.1;
        c.beginPath();
        for (let x = 5; x < len - 4; x += 11) { c.moveTo(x, -1); c.lineTo(x + 3, -ht * 0.5); c.lineTo(x + 1, -ht + 1.5); }
        c.stroke();
      };
    };
    block(g, rng, 0.15, 0.15, 3.85, 3.85, 0, 8, MAT.obsidian, { tex: 'dressed', course: 4, block: 14 });
    ['L', 'R'].forEach(function (s) { onFace(g, s, 0.15, 0.15, 3.85, 3.85, 0, 8, seam(s)); });
    block(g, rng, 0.6, 0.6, 3.4, 3.4, 8, 18, shade(MAT.obsidian, 0.06), { tex: 'dressed', course: 5, block: 12 });
    ['L', 'R'].forEach(function (s) { onFace(g, s, 0.6, 0.6, 3.4, 3.4, 8, 18, seam(s)); });
    block(g, rng, 1, 1, 3, 3, 18, 26, shade(MAT.obsidian, 0.12), { tex: 'dressed', course: 8, block: 10 });
    onFace(g, 'L', 1, 1, 3, 3, 18, 26, function (c, len) { c.fillStyle = alpha(team, 0.85); c.fillRect(len / 2 - 7, -6, 14, 3); });
    return null;
  };

  // Walls: 1 palisade, 2 fieldstone, 3 sandstone, 4 banded granite, 5 steel, 6 obsidian and gold,
  // 7 bronze-banded basalt, 8 glazed jade stone, 9 sunstone with a white-gold glow.

  const WALL = [null,
    { col: '#9b6a3e', H: 17 },
    { col: '#a39b8d', tex: 'stone', H: 16 },
    { col: MAT.sandstone, tex: 'stone', H: 18 },
    { col: '#8f949b', tex: 'stone', H: 20, band: MAT.iron },
    { col: '#9aa6b2', tex: 'metal', H: 21, cap: MAT.brass },
    { col: MAT.obsidian, tex: 'dressed', H: 22, cap: MAT.gold, glow: '#b67cff' },
    { col: '#55524f', tex: 'dressed', H: 23, band: MAT.copper, cap: MAT.copper },
    { col: '#5f9a84', tex: 'dressed', H: 24, band: MAT.gold, cap: MAT.gold },
    { col: '#efd9a4', tex: 'dressed', H: 25, band: MAT.gold, cap: MAT.gold, glow: '#fff3c4' }];
  Spr.WALL = WALL;
  function drawWall(g, rng, lv, mask) {
    const W = WALL[U.clamp(lv, 1, WALL.length - 1)], H = W.H;
    if (lv <= 1) {
      const st = [[0.36, 0.42], [0.62, 0.36], [0.5, 0.62]];
      if (mask & 1) st.push([0.86, 0.5], [1.1, 0.5]);
      if (mask & 2) st.push([0.5, 0.86], [0.5, 1.1]);
      if (mask & 3) st.push([0.66, 0.66]);
      st.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }).forEach(function (s, i) {
        const z = H - (i % 2) * 2;
        cyl(g, rng, s[0], s[1], 0.13, 0, z, shade(W.col, (i % 3) * 0.05), { top: false });
        cone(g, s[0], s[1], 0.13, z, z + 6, shade(W.col, 0.1), 1);
      });
      if (mask & 1) beam(g, [0.5, 0.5, H - 6], [1.2, 0.5, H - 6], 1.6, MAT.timber);
      if (mask & 2) beam(g, [0.5, 0.5, H - 6], [0.5, 1.2, H - 6], 1.6, MAT.timber);
      return;
    }
    const o = { tex: W.tex, course: 5, block: 9, rivet: W.cap };
    const seg = function (u0, v0, u1, v1, z1) {
      block(g, rng, u0, v0, u1, v1, 0, z1, W.col, o);
      if (W.band) {
        ['L', 'R'].forEach(function (s) {
          onFace(g, s, u0, v0, u1, v1, 0, z1, function (c, len, ht) {
            c.fillStyle = shade(W.band, s === 'L' ? FL : FR); c.fillRect(0, -ht * 0.62 - 1.4, len, 2.8);
            c.fillStyle = shade(W.band, 0.3); for (let x = 2; x < len; x += 6) c.fillRect(x, -ht * 0.62 - 0.5, 1, 1);
          });
        });
      }
      if (W.glow) {
        ['L', 'R'].forEach(function (s) {
          onFace(g, s, u0, v0, u1, v1, 0, z1, function (c, len, ht) { c.fillStyle = alpha(W.glow, 0.85); c.fillRect(0, -ht * 0.5 - 0.6, len, 1.2); });
        });
      }
    };
    seg(0.24, 0.24, 0.76, 0.76, H + 4);
    if (W.cap) block(g, rng, 0.21, 0.21, 0.79, 0.79, H + 4, H + 6, shade(W.cap, -0.12), {});
    if (lv === 3) block(g, rng, 0.35, 0.35, 0.65, 0.65, H + 4, H + 8, shade(W.col, 0.04), {});
    if (mask & 1) seg(0.76, 0.3, 1.24, 0.7, H);
    if (mask & 2) seg(0.3, 0.76, 0.7, 1.24, H);
  }

  // Rubble of a destroyed building in its own materials: scorch, broken stubs, chunks, charred beams.
  const RUIN = {
    core: [MAT.stone, MAT.dressed], mint: [MAT.brick, MAT.plaster], well: [MAT.stone, MAT.timber], vault: [MAT.stone, MAT.iron],
    tank: [MAT.brass, MAT.steel], barracks: [MAT.plaster, MAT.timber], garrison: [MAT.canvas, MAT.plank], lab: [MAT.stone, MAT.verdigris],
    station: [MAT.plank, MAT.timber], blaster: [MAT.stone, MAT.iron], spire: [MAT.stone, MAT.timber], mortar: [MAT.burlap, MAT.iron],
    frost: [MAT.ice, MAT.stoneCool], lance: [MAT.steel, MAT.copper], mine: [MAT.iron, MAT.iron],
    hall: [MAT.stone, MAT.brass], lodge: [MAT.plank, MAT.canvas],
    flak: [MAT.stoneCool, MAT.iron], rail: [MAT.dressed, MAT.copper], snare: [MAT.iron, MAT.brass], bunker: [MAT.stoneCool, MAT.steel],
    forge: [MAT.brick, MAT.timber], brazier: [MAT.stone, MAT.iron], hail: [MAT.stoneCool, MAT.ice], tempest: [MAT.steel, MAT.copper],
    charge: [MAT.plank, MAT.iron], thornheart: ['#5b3d24', '#4f6b34'], bombard: [MAT.sandstone, MAT.brass], idol: [MAT.obsidian, '#ff7a2a']
  };
  // Drawn under the inked rubble, so the translucent mark never picks up the ink outline.
  // One path per tone, so overlapping blobs read as a single even scorch.
  function scorch(g, w, h, rng) {
    g.save(); g.transform(HW, HH, -HW, HH, 0, 0);
    [[1, 'rgba(58,42,30,0.42)'], [0.55, 'rgba(40,29,21,0.3)']].forEach(function (k) {
      g.beginPath();
      for (let i = 0; i < 5 + w * h; i++) {
        const u = rng.range(0.35, w - 0.35), v = rng.range(0.35, h - 0.35);
        const r = Math.min(u, w - u, v, h - v) * rng.range(0.7, 1) * k[0];
        g.moveTo(u + r, v); g.arc(u, v, r, 0, Math.PI * 2);
      }
      g.fillStyle = k[1]; g.fill();
    });
    g.restore();
  }

  function drawRuin(g, w, h, rng, type, level) {
    const m = type === 'wall' ? [WALL[U.clamp(level, 1, WALL.length - 1)].col, MAT.stoneDark] : RUIN[type] || [MAT.stone, MAT.timber];
    const big = w > 1;
    if (big) {
      // a broken corner of wall at the back
      let u = 0.3, z = rng.range(12, 18);
      while (u < w * 0.55) { const s = rng.range(0.28, 0.4); block(g, rng, u, 0.25, u + s, 0.47, 0, z, m[0], { tex: 'stone', course: 5, block: 9 }); u += s; z *= rng.range(0.45, 0.8); }
      let v = 0.47; z = rng.range(9, 14);
      while (v < h * 0.45) { const s = rng.range(0.28, 0.4); block(g, rng, 0.25, v, 0.47, v + s, 0, z, m[0], { tex: 'stone', course: 5, block: 9 }); v += s; z *= rng.range(0.45, 0.8); }
    }
    const chunks = [];
    const n = Math.round(w * h * (big ? 1.7 : 2.5));
    const near = function () { return (rng.next() + rng.next()) / 2 - 0.5; };
    for (let layer = 0; layer < 2; layer++) {
      for (let i = 0; i < (layer ? n / 4 : n); i++) {
        const cu = w / 2 + near() * (w - 0.5) * (layer ? 0.6 : 1), cv = h / 2 + near() * (h - 0.5) * (layer ? 0.6 : 1);
        const s = rng.range(0.1, big ? 0.24 : 0.14);
        chunks.push({ u: cu, v: cv, s: s, z: layer * (big ? 5 : 2), col: rng.chance(0.7) ? m[0] : m[1], layer: layer });
      }
    }
    chunks.sort(function (a, b) { return a.layer - b.layer || (a.u + a.v) - (b.u + b.v); }).forEach(function (k) {
      block(g, rng, k.u - k.s, k.v - k.s * 0.8, k.u + k.s, k.v + k.s * 0.8, k.z, k.z + k.s * 26, k.col, { rim: false });
    });
    for (let i = 0; i < (big ? 3 : 1); i++) {
      const a = [rng.range(0.4, w - 0.4), rng.range(0.4, h - 0.4), rng.range(2, 5)];
      beam(g, a, [a[0] + rng.range(-0.5, 0.5), a[1] + rng.range(-0.5, 0.5), rng.range(8, 16)], 2.6, '#3b2c22');
    }
  }

  function drawConstruction(g, w, h, rng) {
    block(g, rng, 0.15, 0.15, w - 0.15, h - 0.15, 0, 5, MAT.stoneDark, { tex: 'stone', course: 5, block: 12 });
    const z = 5, top = 30;
    const P4 = [[0.35, 0.35], [w - 0.35, 0.35], [0.35, h - 0.35], [w - 0.35, h - 0.35]];
    // half-built back walls
    block(g, rng, 0.35, 0.35, w - 0.35, 0.5, z, 15, MAT.stone, { tex: 'stone', course: 5, block: 10 });
    block(g, rng, 0.35, 0.5, 0.5, h - 0.35, z, 12, MAT.stone, { tex: 'stone', course: 5, block: 10 });
    pole(g, P4[0][0], P4[0][1], z, top, 2.4, MAT.fresh);
    pole(g, P4[1][0], P4[1][1], z, top, 2.4, MAT.fresh);
    pole(g, P4[2][0], P4[2][1], z, top, 2.4, MAT.fresh);
    beam(g, [P4[0][0], P4[0][1], top - 2], [P4[1][0], P4[1][1], top - 2], 2.2, MAT.fresh);
    beam(g, [P4[0][0], P4[0][1], top - 2], [P4[2][0], P4[2][1], top - 2], 2.2, MAT.fresh);
    // materials waiting on site
    for (let k = 0; k < 3; k++) block(g, rng, w * 0.32, h * 0.58 + k * 0.03, w * 0.32 + 0.9, h * 0.58 + 0.25 + k * 0.03, z + k * 2.4, z + 2.2 + k * 2.4, shade(MAT.fresh, -k * 0.07), {});
    block(g, rng, w * 0.62, h * 0.3, w * 0.62 + 0.3, h * 0.3 + 0.3, z, z + 7, MAT.stone, { tex: 'stone', course: 7, block: 10 });
    block(g, rng, w * 0.62 + 0.32, h * 0.3, w * 0.62 + 0.6, h * 0.3 + 0.28, z, z + 6, shade(MAT.stone, -0.05), {});
    pole(g, P4[3][0], P4[3][1], z, top, 2.4, MAT.fresh);
    beam(g, [P4[1][0], P4[1][1], top - 2], [P4[3][0], P4[3][1], top - 2], 2.2, MAT.fresh);
    beam(g, [P4[2][0], P4[2][1], top - 2], [P4[3][0], P4[3][1], top - 2], 2.2, MAT.fresh);
    beam(g, [P4[2][0], P4[2][1], z], [P4[3][0], P4[3][1], top - 4], 1.6, shade(MAT.fresh, -0.1));
  }

  // ---------------------------------------------------------------- sprite cache
  const ZMAX = { core: 112, spire: 118, lance: 62, well: 86, tank: 60, lab: 94, mint: 66, barracks: 56, garrison: 66, station: 52, blaster: 26, mortar: 46, frost: 66, vault: 42, mine: 8, wall: 34, hall: 62, lodge: 52, flak: 24, rail: 36, snare: 12, bunker: 40,
    forge: 60, brazier: 30, hail: 50, tempest: 74, charge: 14, thornheart: 76, bombard: 38, idol: 30 };
  // Visual height of each building's main mass (for picking, bars and projectile impacts).
  Spr.TOP = { core: 100, spire: 74, lance: 60, well: 72, tank: 58, lab: 82, mint: 47, barracks: 48, garrison: 32, station: 40, blaster: 28, mortar: 24, frost: 56, vault: 39, mine: 8, wall: 22, hall: 36, lodge: 34, flak: 30, rail: 38, snare: 8, bunker: 31,
    forge: 40, brazier: 34, hail: 58, tempest: 80, charge: 10, thornheart: 80, bombard: 58, idol: 60 };
  const PAD = 8;
  const cache = new Map();

  // Ink outline around the opaque pixels of a sprite: separates buildings from the scenery.
  function inked(src) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d');
    const d = SC, e = d * 0.7;
    [[-d, 0], [d, 0], [0, -d], [0, d], [-e, -e], [e, -e], [-e, e], [e, e]].forEach(function (o) { g.drawImage(src, o[0], o[1]); });
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = 'rgba(32,22,14,0.75)';
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    g.drawImage(src, 0, 0);
    return c;
  }

  /*
   * Returns {canvas, ox, oy, w, h, flags}: draw with the footprint's top corner at (sx, sy):
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
    const zmax = variant === 'normal' ? (ZMAX[type] || 60) : 40;
    const ox = (h + ext) * HW + PAD, oy = zmax + PAD;
    const cw = (w + h + ext * 2) * HW + PAD * 2, ch = (w + h + ext * 2) * HH + zmax + PAD * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(cw * SC);
    canvas.height = Math.ceil(ch * SC);
    const g = canvas.getContext('2d');
    g.scale(SC, SC);
    g.translate(ox, oy);
    g.lineJoin = 'round';
    const rng = new U.Rng(U.hash(key));
    let out = null;
    if (variant === 'ruin') drawRuin(g, w, h, rng, type, level);
    else if (variant === 'build') drawConstruction(g, w, h, rng);
    else if (type === 'wall') drawWall(g, rng, level, extra || 0);
    else out = DRAW[type](g, w, h, level, team, rng, rot);
    const ink = inked(canvas);
    if (variant === 'ruin') {
      const g2 = ink.getContext('2d');
      g2.globalCompositeOperation = 'destination-over';
      g2.setTransform(SC, 0, 0, SC, ox * SC, oy * SC);
      scorch(g2, w, h, rng);
    }
    s = { canvas: ink, ox: ox, oy: oy, w: cw, h: ch, flags: out && out.flags };
    cache.set(key, s);
    return s;
  };

  Spr.clearCache = function () { cache.clear(); shadows.clear(); frames.clear(); };

  // ---------------------------------------------------------------- shadows
  // Shadow casters: ['b', u0, v0, u1, v1, z, ao] boxes, ['c', u, v, r, z, ao] cylinders,
  // ['l', u0, v0, z0, u1, v1, z1, width] poles and beams. ao adds a dark contact rim.
  const VOL = {
    core: function (w, h, lv) {
      const v = [['b', 0.1, 0.1, 3.9, 3.9, 10, 1], ['b', 0.6, 0.6, 3.4, 3.4, 54], ['b', 1.52, 1.52, 2.48, 2.48, 92]];
      if (tierOf(lv, 6) >= 1) [[0.62, 0.62], [3.38, 0.62], [0.62, 3.38], [3.38, 3.38]].forEach(function (p) { v.push(['c', p[0], p[1], 0.46, 76]); });
      return v;
    },
    mint: function () { return [['b', 0.12, 0.12, 2.88, 2.88, 5, 1], ['b', 0.3, 0.2, 2.1, 1.9, 38], ['b', 0.5, 0.45, 0.86, 0.81, 60], ['b', 2.42, 0.46, 2.63, 1.57, 37]]; },
    well: function () {
      const v = [['c', 1.5, 1.5, 1.34, 4, 1], ['c', 1.5, 1.5, 0.98, 16], ['b', 1.3, 1.3, 1.7, 1.7, 78]];
      [[0.4, 1.5], [1.5, 0.4], [2.6, 1.5], [1.5, 2.6]].forEach(function (b) { v.push(['l', b[0], b[1], 0, 1.5 + (b[0] - 1.5) * 0.2, 1.5 + (b[1] - 1.5) * 0.2, 66, 0.1]); });
      return v;
    },
    vault: function () { return [['b', 0.12, 0.12, 2.88, 2.88, 5, 1], ['b', 0.3, 0.3, 2.7, 2.7, 37]]; },
    tank: function () { return [['c', 1.5, 1.5, 1.32, 5, 1], ['c', 1.5, 1.5, 1.05, 60]]; },
    barracks: function (w, h) { return w > h ? [['b', 0.12, 0.12, 3.88, 2.88, 5, 1], ['b', 0.35, 0.3, 3.25, 2.0, 40]] : [['b', 0.12, 0.12, 2.88, 3.88, 5, 1], ['b', 0.3, 0.35, 2.0, 3.25, 40]]; },
    garrison: function () { return [['b', 0.45, 0.45, 1.6, 1.4, 18], ['b', 2.3, 0.45, 3.3, 1.55, 16], ['b', 0.45, 2.3, 1.55, 3.3, 16], ['b', 0.15, 0.15, 3.85, 0.3, 20], ['b', 0.15, 0.15, 0.3, 3.85, 20], ['l', 3.62, 3.62, 0, 3.62, 3.62, 52, 0.06]]; },
    lab: function () { return [['b', 0.12, 0.12, 2.88, 2.88, 5, 1], ['c', 1.5, 1.5, 1.02, 66]]; },
    station: function () { return [['b', 0.1, 0.1, 1.9, 1.9, 4, 1], ['b', 0.2, 0.3, 1.4, 1.5, 30], ['b', 1.55, 0.22, 1.72, 0.39, 48]]; },
    blaster: function () { return [['c', 1.5, 1.5, 1.38, 22, 1]]; },
    spire: function () { return [['b', 0.35, 0.35, 2.65, 2.65, 8, 1], ['b', 0.78, 0.78, 2.22, 2.22, 60], ['b', 0.6, 0.6, 2.4, 2.4, 73], ['l', 0.68, 0.68, 73, 0.68, 0.68, 112, 0.06]]; },
    mortar: function () { return [['c', 1.5, 1.5, 1.34, 16, 1]]; },
    frost: function () { return [['b', 0.15, 0.15, 1.85, 1.85, 6, 1], ['b', 0.6, 0.6, 1.4, 1.4, 50]]; },
    lance: function () { return [['b', 0.3, 0.3, 2.7, 2.7, 12, 1], ['c', 1.5, 1.5, 0.45, 60]]; },
    mine: function () { return [['c', 0.5, 0.5, 0.3, 2, 1]]; },
    hall: function () { return [['b', 0.15, 0.15, 2.85, 2.85, 10, 1], ['c', 0.5, 1.2, 0.24, 28], ['c', 1.2, 0.5, 0.24, 28], ['l', 0.45, 0.45, 5, 0.45, 0.45, 56, 0.06]]; },
    lodge: function () { return [['b', 0.15, 0.15, 2.85, 2.85, 4, 1], ['b', 0.3, 0.3, 1.4, 1.4, 34], ['c', 2.35, 0.7, 0.3, 14], ['l', 0.35, 2.65, 4, 0.35, 2.65, 46, 0.06]]; },
    flak: function () { return [['b', 0.2, 0.2, 2.8, 2.8, 13, 1], ['c', 1.5, 1.5, 0.6, 30]]; },
    rail: function () { return [['b', 0.12, 0.12, 2.88, 2.88, 8, 1], ['b', 0.38, 0.38, 2.62, 2.62, 34]]; },
    snare: function () { return [['c', 0.5, 0.5, 0.3, 4, 1]]; },
    bunker: function () { return [['b', 0.1, 0.1, 2.9, 2.9, 31, 1]]; },
    forge: function () { return [['b', 0.12, 0.12, 2.88, 2.88, 5, 1], ['b', 0.3, 0.3, 1.8, 1.9, 40], ['b', 0.55, 0.55, 0.92, 0.92, 54], ['c', 2.2, 2.2, 0.45, 15]]; },
    brazier: function () { return [['b', 0.15, 0.15, 1.85, 1.85, 5, 1], ['c', 1, 1, 0.7, 25]]; },
    hail: function () { return [['b', 0.25, 0.25, 2.75, 2.75, 7, 1], ['c', 1.5, 1.5, 1.1, 52]]; },
    tempest: function () { return [['b', 0.3, 0.3, 2.7, 2.7, 10, 1], ['c', 1.5, 1.5, 0.45, 80]]; },
    charge: function () { return [['c', 1, 1, 0.7, 9, 1]]; },
    thornheart: function () { return [['c', 2, 2, 1.85, 6, 1], ['c', 2, 2, 0.62, 44], ['c', 2, 2, 1.2, 70]]; },
    bombard: function () { return [['b', 0.2, 0.2, 3.8, 3.8, 10, 1], ['b', 0.6, 0.6, 3.4, 3.4, 22], ['c', 0.55, 0.55, 0.48, 34], ['c', 3.45, 0.55, 0.48, 34], ['c', 0.55, 3.45, 0.48, 34], ['c', 3.45, 3.45, 0.48, 34], ['c', 2, 2, 0.6, 60]]; },
    idol: function () { return [['b', 0.15, 0.15, 3.85, 3.85, 8, 1], ['b', 1, 1, 3, 3, 26], ['c', 2, 2, 0.6, 62]]; }
  };
  function wallVol(lv, mask) {
    const H = WALL[U.clamp(lv, 1, WALL.length - 1)].H;
    const v = [['b', 0.24, 0.24, 0.76, 0.76, H + 4, 1]];
    if (mask & 1) v.push(['b', 0.76, 0.3, 1.24, 0.7, H, 1]);
    if (mask & 2) v.push(['b', 0.3, 0.76, 0.7, 1.24, H, 1]);
    return v;
  }
  const shadows = new Map();
  // Returns {canvas, ox, oy, w, h} drawn like Spr.building, in a solid colour: the renderer
  // merges all shadows into one layer and fades it once, so overlaps never double up.
  Spr.shadow = function (type, level, rot, variant, extra) {
    const key = type + '|' + level + '|' + rot + '|' + variant + '|' + (extra || 0);
    let s = shadows.get(key);
    if (s) return s;
    const size = CS.Base.size(type, rot), w = size[0], h = size[1];
    const ext = type === 'wall' ? 1 : 0;
    const vols = variant === 'ruin' ? [['b', 0.2, 0.2, w - 0.2, h - 0.2, 6, 1]]
      : variant === 'build' ? [['b', 0.15, 0.15, w - 0.15, h - 0.15, 5, 1], ['b', 0.3, 0.3, w - 0.3, 0.55, 30]]
        : type === 'wall' ? wallVol(level, extra || 0) : VOL[type](w, h, level, rot);
    let zmax = 0;
    vols.forEach(function (v) { zmax = Math.max(zmax, v[0] === 'b' ? v[5] : v[0] === 'c' ? v[4] : Math.max(v[3], v[6])); });
    const u0 = -ext - 0.2, v0 = -ext - 0.2, u1 = w + ext + zmax * SHX + 0.3, v1 = h + ext + zmax * SHY + 0.3;
    const ox = (v1 - u0) * HW, oy = -(u0 + v0) * HH;
    const cw = Math.ceil((u1 - v0 - u0 + v1) * HW), ch = Math.ceil((u1 + v1 - u0 - v0) * HH);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const g = canvas.getContext('2d');
    g.setTransform(HW, HH, -HW, HH, ox, oy);
    g.fillStyle = g.strokeStyle = '#000';
    g.lineCap = 'round';
    vols.forEach(function (v) {
      if (v[0] === 'b') {
        const dx = v[5] * SHX, dy = v[5] * SHY;
        g.beginPath();
        g.moveTo(v[1], v[2]); g.lineTo(v[3], v[2]); g.lineTo(v[3] + dx, v[2] + dy); g.lineTo(v[3] + dx, v[4] + dy); g.lineTo(v[1] + dx, v[4] + dy); g.lineTo(v[1], v[4]);
        g.closePath(); g.fill();
        if (v[6]) { g.fillRect(v[1] - 0.07, v[2] - 0.07, v[3] - v[1] + 0.14, v[4] - v[2] + 0.14); }
      } else if (v[0] === 'c') {
        g.lineWidth = v[3] * 2;
        g.beginPath(); g.moveTo(v[1], v[2]); g.lineTo(v[1] + v[4] * SHX, v[2] + v[4] * SHY); g.stroke();
        g.beginPath(); g.arc(v[1], v[2], v[3] + (v[5] ? 0.07 : 0), 0, Math.PI * 2); g.fill();
      } else {
        g.lineWidth = v[7] * 2;
        g.beginPath(); g.moveTo(v[1] + v[3] * SHX, v[2] + v[3] * SHY); g.lineTo(v[4] + v[6] * SHX, v[5] + v[6] * SHY); g.stroke();
      }
    });
    s = { canvas: canvas, ox: ox, oy: oy, w: cw, h: ch };
    shadows.set(key, s);
    return s;
  };

  // ---------------------------------------------------------------- live parts (drawn every frame)
  // Waving pennant from a pole top at screen point p.
  function pennant(ctx, p, len, ht, col, time, ph) {
    const n = 7, wave = function (t) { return Math.sin(time * 4.2 + ph - t * 3.2) * 1.8 * t + t * 2.2; };
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i <= n; i++) { const t = i / n; ctx.lineTo(p[0] + len * t, p[1] + wave(t) + t * ht * 0.18); }
    for (let i = n; i >= 0; i--) { const t = i / n; ctx.lineTo(p[0] + len * t * (i === n ? 0.82 : 1), p[1] + ht - t * ht * 0.42 + wave(t)); }
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const t = i / n; ctx.lineTo(p[0] + len * t, p[1] + ht * 0.62 - t * ht * 0.2 + wave(t)); }
    for (let i = n; i >= 0; i--) { const t = i / n; ctx.lineTo(p[0] + len * t * (i === n ? 0.82 : 1), p[1] + ht - t * ht * 0.42 + wave(t)); }
    ctx.closePath(); ctx.fill();
  }

  function glowDot(ctx, x, y, r, inner, outer) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function gem(ctx, x, y, w, h, col) {
    ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.lineTo(x - w, y); ctx.closePath();
    ctx.fillStyle = shade(col, 0.4); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.closePath();
    ctx.fillStyle = shade(col, -0.12); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.closePath();
    ctx.fillStyle = alpha(shade(col, -0.35), 0.45); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.lineTo(x - w, y); ctx.closePath();
    ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x - w * 0.55, y - h * 0.1); ctx.lineTo(x - w * 0.1, y - h * 0.7); ctx.stroke();
  }

  // A tube between two screen points with ink, base colour and a top highlight.
  function tube(ctx, a, b, w, col, cap) {
    ctx.lineCap = cap || 'round';
    ctx.strokeStyle = INKLINE; ctx.lineWidth = w + 1.6; line(ctx, a, b);
    ctx.strokeStyle = col; ctx.lineWidth = w; line(ctx, a, b);
    ctx.strokeStyle = shade(col, 0.32); ctx.lineWidth = w * 0.32;
    line(ctx, [a[0], a[1] - w * 0.22], [b[0], b[1] - w * 0.22]);
    ctx.lineCap = 'butt';
  }

  // Small round-bottomed flask with a cork, its foot at (x, y).
  function flask(ctx, x, y, s, col) {
    ctx.beginPath(); ctx.arc(x, y - 3.4 * s, 3.4 * s, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.beginPath(); ctx.rect(x - 1.2 * s, y - 9.4 * s, 2.4 * s, 3.4 * s);
    ctx.fillStyle = 'rgba(225,238,245,0.9)'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8a5a2c'; ctx.fillRect(x - 1.4 * s, y - 10.8 * s, 2.8 * s, 1.6 * s);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(x - 2 * s, y - 5 * s, 1.2 * s, 1.2 * s);
  }
  // Expanding ring of an aura defense's reach on the ground around (u, v).
  function pulseRing(ctx, u, v, range, k, rgb) {
    const rr = radii(range * (1 - k * 0.3)), g0 = P(u, v, 0);
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (k * 0.8) + ')'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(g0[0], g0[1], rr[0], rr[1], 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(' + rgb + ',' + (k * 0.12) + ')'; ctx.fill();
  }

  // ctx is already translated to the footprint's top corner and scaled by zoom.
  Spr.drawLive = function (ctx, b, info, time, spr) {
    const w = b.w, h = b.h, team = info.team || '#3f86e8';
    switch (b.type) {
      case 'core': {
        const z = 114 + Math.sin(time * 2) * 3;
        const c = P(2, 2, z);
        glowDot(ctx, c[0], c[1], 22, alpha(team, 0.5), alpha(team, 0));
        gem(ctx, c[0], c[1], 7.5, 12.5, team);
        // Command Core Lv 7+: one orbiting shard per level past 6
        for (let i = 0; i < (b.level || 0) - 6; i++) {
          const a = time * 1.4 + i * Math.PI * 2 / ((b.level || 0) - 6);
          const s = P(2 + Math.cos(a) * 0.62, 2 + Math.sin(a) * 0.62, z - 6);
          gem(ctx, s[0], s[1], 3, 5.5, i % 2 ? MAT.gold : team);
        }
        break;
      }
      case 'mint': {
        const fill = info.fill || 0;
        if (fill > 0.02) {
          const r = 0.16 + fill * 0.24, top = 6 + 3 + fill * 10;
          cone(ctx, 2.32, 2.32, r, 6, top, MAT.gold, 3);
          const p = P(2.32, 2.32, top);
          ctx.fillStyle = '#fff3b0'; ctx.fillRect(p[0] - 2, p[1] + 3, 1.5, 1.5); ctx.fillRect(p[0] + 3, p[1] + 6, 1.5, 1.5);
        }
        const k = info.active ? Math.abs(Math.sin(time * 3)) : 0.2;
        const rz = 14 + (1 - k) * 12;
        beam(ctx, [2.52, 1.02, rz + 6], [2.52, 1.02, 35], 2, MAT.iron);
        block(ctx, null, 2.38, 0.88, 2.66, 1.16, rz, rz + 6, MAT.steel, {});
        if (info.active) {
          const c = P(0.68, 0.63, 62);
          for (let i = 0; i < 3; i++) {
            const q = (time * 0.55 + i / 3) % 1;
            ctx.fillStyle = 'rgba(235,230,224,' + (0.42 * (1 - q)) + ')';
            ctx.beginPath(); ctx.arc(c[0] + q * 9 + Math.sin(time + i) * 2, c[1] - q * 24, 3 + q * 5, 0, Math.PI * 2); ctx.fill();
          }
        }
        break;
      }
      case 'well': {
        const fill = info.fill || 0;
        const pulse = 0.5 + Math.sin(time * 3) * 0.18;
        const c = P(1.5, 1.5, 16), rr = radii(0.8);
        ctx.save(); ctx.translate(c[0], c[1]); ctx.scale(1, rr[1] / rr[0]);
        glowDot(ctx, 0, 0, rr[0], 'rgba(236,206,255,' + pulse + ')', 'rgba(163,92,255,0.15)');
        ctx.restore();
        const z = 38 + Math.sin(time * 1.7) * 3;
        const top = P(1.5, 1.5, 76), k = P(1.5, 1.5, z);
        ctx.strokeStyle = '#3a3330'; ctx.lineWidth = 0.9; line(ctx, top, [k[0], k[1] - 9]);
        if (info.active) glowDot(ctx, k[0], k[1], 14, 'rgba(220,170,255,0.55)', 'rgba(163,92,255,0)');
        gem(ctx, k[0], k[1], 5, 9, info.active ? '#c78bff' : '#8a7a99');
        if (info.active) {
          for (let i = 0; i < 3; i++) {
            const q = (time * 0.5 + i / 3) % 1;
            ctx.fillStyle = 'rgba(214,170,255,' + (0.8 * (1 - q)) + ')';
            ctx.beginPath(); ctx.arc(c[0] + Math.sin(i * 2 + time) * 9, c[1] - q * 32, 1.5, 0, Math.PI * 2); ctx.fill();
          }
        }
        if (fill > 0.02) {
          const m = P(2.38, 0.82, 8);
          const x = m[0] + 0, y = m[1];
          ctx.save(); ctx.transform(KX, KY, 0, 1, x, y);
          ctx.fillStyle = '#b77bff'; ctx.fillRect(-1.6, -16 * fill, 3.2, 16 * fill);
          ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-1.6, -16 * fill, 3.2, 1);
          ctx.restore();
        }
        break;
      }
      case 'vault': {
        const fill = info.fill || 0;
        if (fill > 0.01) {
          const n = Math.ceil(fill * 9);
          for (let i = 0; i < n; i++) {
            const u = 0.88 + (i % 3) * 0.44, v = 0.9 + Math.floor(i / 3) * 0.45, z = 22 + Math.floor(i / 9) * 4;
            block(ctx, null, u, v, u + 0.34, v + 0.22, z, z + 4.5, MAT.gold, { top: '#ffe27a' });
          }
          if (fill > 0.6) {
            const p = P(1.5, 1.5, 30);
            ctx.fillStyle = 'rgba(255,240,170,' + (0.25 + Math.sin(time * 3) * 0.1) + ')';
            ctx.beginPath(); ctx.ellipse(p[0], p[1], 26, 12, 0, 0, Math.PI * 2); ctx.fill();
          }
        }
        break;
      }
      case 'tank': {
        const fill = info.fill || 0, metal = MAT.brass;
        const g0 = P(1.5, 1.5, 14), rr = radii(0.95);
        // glass back wall
        cylPath(ctx, 1.5, 1.5, 0.95, 14, 52);
        ctx.fillStyle = 'rgba(40,50,70,0.35)'; ctx.fill();
        if (fill > 0.01) {
          const top = 14 + fill * 36, t0 = P(1.5, 1.5, top), r2 = radii(0.9);
          cylPath(ctx, 1.5, 1.5, 0.9, 14, top);
          const lg = ctx.createLinearGradient(g0[0] - r2[0], 0, g0[0] + r2[0], 0);
          lg.addColorStop(0, 'rgba(196,140,255,0.92)'); lg.addColorStop(0.6, 'rgba(150,70,240,0.9)'); lg.addColorStop(1, 'rgba(110,50,190,0.92)');
          ctx.fillStyle = lg; ctx.fill();
          ctx.beginPath(); ctx.ellipse(t0[0], t0[1], r2[0], r2[1], 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(226,190,255,0.95)'; ctx.fill();
          for (let i = 0; i < 3; i++) {
            const q = (time * 0.4 + i / 3) % 1;
            ctx.fillStyle = 'rgba(255,255,255,' + (0.6 * (1 - q)) + ')';
            ctx.beginPath(); ctx.arc(g0[0] + Math.sin(i * 2.3) * 14, g0[1] - 4 - q * (top - 18), 1.3, 0, Math.PI * 2); ctx.fill();
          }
        }
        // glass front: rim lines and a highlight
        cylPath(ctx, 1.5, 1.5, 0.95, 14, 52);
        ctx.strokeStyle = 'rgba(210,235,245,0.7)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2.2;
        line(ctx, [g0[0] - rr[0] * 0.55, g0[1] - 6], [g0[0] - rr[0] * 0.55, g0[1] - 32]);
        [0, Math.PI / 2].forEach(function (a) {
          const u = 1.5 + Math.cos(a) * 1.02, v = 1.5 + Math.sin(a) * 1.02;
          beam(ctx, [u, v, 14], [u, v, 54], 3, metal);
        });
        cyl(ctx, null, 1.5, 1.5, 1.04, 52, 57, metal, { tex: 'bands', top: shade(metal, -0.04) });
        cyl(ctx, null, 1.5, 1.5, 0.78, 57, 59, shade(metal, -0.15), { top: shade(metal, -0.02) });
        dome(ctx, 1.5, 1.5, 0.5, 59, metal, 4);
        const v0 = P(1.5, 1.5, 79);
        ctx.fillStyle = MAT.iron; ctx.fillRect(v0[0] - 1, v0[1], 2, 4);
        ctx.beginPath(); ctx.arc(v0[0], v0[1], 2.2, 0, Math.PI * 2); ctx.fillStyle = '#c4473a'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
        break;
      }
      case 'garrison': {
        const c = P(2.3, 2.3, 1);
        const f = 0.8 + Math.sin(time * 14) * 0.15 + Math.sin(time * 23) * 0.08;
        glowDot(ctx, c[0], c[1] - 5, 22, 'rgba(255,150,60,0.32)', 'rgba(255,150,60,0)');
        ctx.fillStyle = '#ff8a2a'; ctx.beginPath(); ctx.moveTo(c[0] - 6, c[1]); ctx.quadraticCurveTo(c[0] - 2, c[1] - 20 * f, c[0], c[1] - 23 * f); ctx.quadraticCurveTo(c[0] + 3, c[1] - 12 * f, c[0] + 6, c[1]); ctx.fill();
        ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.moveTo(c[0] - 3, c[1]); ctx.quadraticCurveTo(c[0], c[1] - 14 * f, c[0] + 3, c[1]); ctx.fill();
        const n = Math.min(6, info.troops || 0);
        const types = info.troopTypes && info.troopTypes.length ? info.troopTypes : ['scout'];
        for (let i = 0; i < n; i++) {
          const a = i / 6 * Math.PI * 2 + 0.6;
          const p = P(2.3 + Math.cos(a) * 0.95, 2.3 + Math.sin(a) * 0.95, 0);
          Spr.drawTroop(ctx, p[0], p[1], 0.8, types[i % types.length], team, time + i, { face: Math.cos(a) - Math.sin(a) > 0 ? -1 : 1, idle: true, skin: i % 4 });
        }
        break;
      }
      case 'lab': {
        const on = info.active && Math.sin(time * 5) > 0;
        const p = P(2.3, 1.85, 82);
        if (info.busy) {
          glowDot(ctx, p[0], p[1], 7, 'rgba(150,255,220,0.8)', 'rgba(150,255,220,0)');
          for (let i = 0; i < 4; i++) {
            const q = (time * 0.7 + i / 4) % 1;
            const s = P(2.3, 1.85, 84 + q * 26);
            ctx.fillStyle = 'rgba(150,255,220,' + (1 - q) + ')';
            ctx.fillRect(s[0] + Math.sin(i * 3 + time * 2) * 8, s[1], 1.8, 1.8);
          }
        }
        const l = P(2.52, 1.5, 34);
        ctx.fillStyle = on ? 'rgba(160,255,210,0.9)' : 'rgba(120,200,170,0.4)';
        ctx.beginPath(); ctx.arc(l[0], l[1], 1.6, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'hall':
      case 'lodge': {
        if (b.type === 'hall') {
          [[0.5, 1.2], [1.2, 0.5]].forEach(function (q, i) {
            const p = P(q[0], q[1], 28), f = Math.sin(time * 9 + i * 2) * 0.8;
            glowDot(ctx, p[0], p[1] - 3, 7, 'rgba(255,190,90,0.55)', 'rgba(255,140,40,0)');
            ctx.beginPath(); ctx.moveTo(p[0] - 3, p[1]); ctx.quadraticCurveTo(p[0] - 2.4 + f, p[1] - 6, p[0] + f, p[1] - 9.5);
            ctx.quadraticCurveTo(p[0] + 2.4 + f, p[1] - 5, p[0] + 3, p[1]); ctx.closePath();
            ctx.fillStyle = '#ffb347'; ctx.fill();
            ctx.beginPath(); ctx.arc(p[0], p[1] - 2.2, 1.6, 0, Math.PI * 2); ctx.fillStyle = '#fff1b0'; ctx.fill();
          });
        }
        if (info.hero) {
          const p = b.type === 'hall' ? P(1.6, 1.6, 10) : P(2.0, 1.95, 4);
          Spr.drawTroop(ctx, p[0], p[1], 1, info.hero, team, time, { face: 1, idle: true });
        }
        break;
      }
      case 'station': {
        if (info.idle) {
          const p = P(1.55, 1.78, 4);
          ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(0.85, 0.85);
          drawEngineer(ctx, time);
          ctx.restore();
        }
        break;
      }
      case 'blaster': {
        const ang = info.angle || 0, recoil = info.recoil || 0;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const carriage = rotRect(1.5 - dx * 0.08, 1.5 - dy * 0.08, ang, 0.92, 0.66);
        const pivot = P(1.5, 1.5, 28);
        const len = 1.2 - recoil * 0.24, back = 0.36 + recoil * 0.1;
        const tip = P(1.5 + dx * len, 1.5 + dy * len, 29), tail = P(1.5 - dx * back, 1.5 - dy * back, 28);
        const behind = dx + dy < 0;
        const barrel = function () {
          tube(ctx, tail, tip, 11, '#3a4048');
          ctx.beginPath(); ctx.arc(tail[0], tail[1], 3.4, 0, Math.PI * 2); ctx.fillStyle = '#4b525b'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
          ctx.beginPath(); ctx.arc(tip[0], tip[1], 6.4, 0, Math.PI * 2); ctx.fillStyle = '#525a64'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.9; ctx.stroke();
          ctx.beginPath(); ctx.arc(tip[0] + dx * 1.3 - dy * 0.7, tip[1] + (dx + dy) * 0.45, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#111316'; ctx.fill();
          const band = P(1.5 + dx * 0.3, 1.5 + dy * 0.3, 28.5);
          ctx.beginPath(); ctx.arc(band[0], band[1], 6.2, 0, Math.PI * 2); ctx.fillStyle = team; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.9; ctx.stroke();
        };
        if (behind) barrel();
        prism(ctx, carriage, 18, 26, '#6b5038', { top: shade('#6b5038', TOP) });
        ctx.beginPath(); ctx.arc(pivot[0], pivot[1], 4.4, 0, Math.PI * 2); ctx.fillStyle = MAT.iron; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
        if (!behind) barrel();
        break;
      }
      case 'spire': {
        // ballista on a turntable: stock along the aim, bow at the front, bolt only while loaded
        const ang = info.angle || 0, dx = Math.cos(ang), dy = Math.sin(ang), z = 82;
        cyl(ctx, null, 1.5, 1.5, 0.36, 64, 69, MAT.iron, { top: shade(MAT.iron, 0.25) });
        pole(ctx, 1.5, 1.5, 69, z - 2, 4.4, '#4a3220');
        const at = function (f, s) { return P(1.5 + dx * f - dy * s, 1.5 + dy * f + dx * s, z); };
        const back = at(-0.62, 0), front = at(0.62, 0);
        const a1 = at(0.04, 0.86), a2 = at(0.04, -0.86), m1 = at(0.5, 0.46), m2 = at(0.5, -0.46);
        const nock = at(info.recoil ? 0.02 : -0.4, 0);
        const stock = function () {
          tube(ctx, back, front, 6.4, '#5b3d24', 'butt');
          if (!info.recoil) {
            const tipB = at(0.94, 0), head = at(1.04, 0);
            tube(ctx, nock, tipB, 2, '#d9cdb4', 'butt');
            ctx.beginPath(); ctx.moveTo(head[0], head[1]); ctx.lineTo(tipB[0] - dy * 3, tipB[1] + dx * 1.5); ctx.lineTo(tipB[0] + dy * 3, tipB[1] - dx * 1.5); ctx.closePath();
            ctx.fillStyle = MAT.steel; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
          }
        };
        const bow = function () {
          ctx.strokeStyle = INKLINE; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(nock[0], nock[1]); ctx.lineTo(a2[0], a2[1]); ctx.stroke();
          ctx.strokeStyle = '#f4eedc'; ctx.lineWidth = 1; ctx.stroke();
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.quadraticCurveTo(m1[0], m1[1], front[0], front[1]); ctx.quadraticCurveTo(m2[0], m2[1], a2[0], a2[1]);
          ctx.strokeStyle = INKLINE; ctx.lineWidth = 7.2; ctx.stroke();
          ctx.strokeStyle = '#7a5232'; ctx.lineWidth = 4.8; ctx.stroke();
          ctx.strokeStyle = '#bd8f5c'; ctx.lineWidth = 1.4; ctx.stroke();
          ctx.lineCap = 'butt';
          [a1, a2].forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.4, 0, Math.PI * 2); ctx.fillStyle = MAT.steel; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke(); });
          ctx.beginPath(); ctx.arc(front[0], front[1], 3, 0, Math.PI * 2); ctx.fillStyle = team; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.stroke();
        };
        if (dx + dy < 0) { bow(); stock(); } else { stock(); bow(); }
        break;
      }
      case 'mortar': {
        const ang = info.angle || 0, recoil = info.recoil || 0, dx = Math.cos(ang), dy = Math.sin(ang);
        prism(ctx, rotRect(1.5, 1.5, ang, 0.74, 0.74), 6, 13, '#5a4a3a', {});
        const base = P(1.5 - dx * 0.06, 1.5 - dy * 0.06, 14);
        const tip = P(1.5 + dx * 0.42, 1.5 + dy * 0.42, 37 - recoil * 7);
        tube(ctx, base, tip, 16, '#3a3f46');
        ctx.beginPath(); ctx.ellipse(tip[0], tip[1], 9, 5.4, 0, 0, Math.PI * 2); ctx.fillStyle = '#4c535c'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(tip[0], tip[1], 6, 3.4, 0, 0, Math.PI * 2); ctx.fillStyle = '#111316'; ctx.fill();
        const band = lerp2(base, tip, 0.4);
        ctx.strokeStyle = INKLINE; ctx.lineWidth = 4.4; ctx.beginPath(); ctx.ellipse(band[0], band[1], 8.4, 3.6, 0, 0.1, Math.PI - 0.1); ctx.stroke();
        ctx.strokeStyle = team; ctx.lineWidth = 3; ctx.stroke();
        break;
      }
      case 'frost': {
        const z = 64 + Math.sin(time * 2.2) * 3;
        const c = P(1, 1, z);
        glowDot(ctx, c[0], c[1], 17, 'rgba(190,240,255,0.65)', 'rgba(190,240,255,0)');
        ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(time * 0.6);
        ctx.strokeStyle = INKLINE; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
        for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; line(ctx, [Math.cos(a) * 7, Math.sin(a) * 7], [-Math.cos(a) * 7, -Math.sin(a) * 7]); }
        ctx.strokeStyle = '#e9fbff'; ctx.lineWidth = 1.8;
        for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; line(ctx, [Math.cos(a) * 7, Math.sin(a) * 7], [-Math.cos(a) * 7, -Math.sin(a) * 7]); }
        ctx.lineCap = 'butt';
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
        const c = P(1.5, 1.5, 64), on = info.firing;
        const r = on ? 8 + Math.sin(time * 40) * 1.5 : 6;
        glowDot(ctx, c[0], c[1], r * 2.4, on ? 'rgba(225,250,255,0.95)' : 'rgba(170,220,255,0.7)', alpha(team, 0));
        ctx.beginPath(); ctx.arc(c[0], c[1], r * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = on ? '#ffffff' : '#cfeeff'; ctx.fill(); ctx.strokeStyle = 'rgba(80,140,200,0.6)'; ctx.lineWidth = 0.8; ctx.stroke();
        if (on || Math.sin(time * 1.3) > 0.85) {
          ctx.strokeStyle = 'rgba(200,240,255,0.85)'; ctx.lineWidth = 1;
          [[0.78, 0.78], [2.22, 0.78], [0.78, 2.22], [2.22, 2.22]].forEach(function (q, i) {
            const e = P(1.5 + (q[0] - 1.5) * 0.45, 1.5 + (q[1] - 1.5) * 0.45, 46);
            ctx.beginPath(); ctx.moveTo(c[0], c[1]);
            ctx.lineTo((c[0] + e[0]) / 2 + Math.sin(time * 50 + i) * 3, (c[1] + e[1]) / 2 + Math.cos(time * 47 + i) * 3);
            ctx.lineTo(e[0], e[1]); ctx.stroke();
          });
        }
        break;
      }
      case 'flak': {
        // twin anti-air guns on a turntable, barrels raised toward the sky
        const ang = info.angle || 0, recoil = info.recoil || 0, dx = Math.cos(ang), dy = Math.sin(ang);
        prism(ctx, rotRect(1.5, 1.5, ang, 0.9, 0.8), 16, 23, '#59606a', { top: shade('#59606a', TOP) });
        const guns = function () {
          [-0.2, 0.2].forEach(function (s) {
            const base = P(1.5 - dy * s, 1.5 + dx * s, 25);
            const len = 0.55 - recoil * 0.12;
            const tip = P(1.5 + dx * len - dy * s, 1.5 + dy * len + dx * s, 50 - recoil * 4);
            tube(ctx, base, tip, 5.2, '#3a4048');
            ctx.beginPath(); ctx.arc(tip[0], tip[1], 3, 0, Math.PI * 2); ctx.fillStyle = '#16181b'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
          });
        };
        const hub = P(1.5, 1.5, 25);
        const shield = function () {
          ctx.beginPath(); ctx.arc(hub[0], hub[1], 6.5, 0, Math.PI * 2); ctx.fillStyle = team; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.9; ctx.stroke();
        };
        if (dx + dy < 0) { guns(); shield(); } else { shield(); guns(); }
        break;
      }
      case 'rail': {
        // twin rails on a carriage; a charge glows between them while the coils build up
        const ang = info.angle || 0, recoil = info.recoil || 0, dx = Math.cos(ang), dy = Math.sin(ang);
        prism(ctx, rotRect(1.5, 1.5, ang, 1.1, 0.9), 24, 32, '#4d545d', { top: shade('#4d545d', TOP) });
        const back = 0.55 + recoil * 0.2, len = 1.6 - recoil * 0.3;
        const rails = function () {
          [-0.14, 0.14].forEach(function (s) {
            tube(ctx, P(1.5 - dx * back - dy * s, 1.5 - dy * back + dx * s, 36), P(1.5 + dx * len - dy * s, 1.5 + dy * len + dx * s, 38), 3.6, s < 0 ? '#2f343b' : '#3d434b');
          });
        };
        const glow = function () {
          const c = P(1.5 + dx * 0.4, 1.5 + dy * 0.4, 37), k = recoil ? 1 : 0.45 + Math.sin(time * 5) * 0.2;
          glowDot(ctx, c[0], c[1], 9, 'rgba(200,240,255,' + k + ')', 'rgba(120,200,255,0)');
          ctx.beginPath(); ctx.arc(P(1.5, 1.5, 36)[0], P(1.5, 1.5, 36)[1], 4.4, 0, Math.PI * 2); ctx.fillStyle = team; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
        };
        if (dx + dy < 0) { rails(); glow(); } else { glow(); rails(); }
        break;
      }
      case 'bunker': {
        // stacked stock on the roof: gold bars at the front-left, energy cells at the back-right
        const fill = info.fill || 0;
        const n = Math.min(4, Math.ceil(fill * 4));
        for (let i = 0; i < n; i++) {
          const u = 0.75 + i * 0.36;
          block(ctx, null, u, 1.75, u + 0.28, 2.05, 31, 35, MAT.gold, { top: '#ffe27a' });
          cyl(ctx, null, u + 0.14, 1.05, 0.12, 31, 37, MAT.energy, { top: MAT.energyLight });
        }
        const l = P(1.5, 2.7, 25), on = Math.sin(time * 2) > 0;
        ctx.fillStyle = on ? 'rgba(255,207,110,0.95)' : 'rgba(255,207,110,0.45)';
        ctx.beginPath(); ctx.arc(l[0], l[1], 1.6, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'forge': {
        const c = P(2.2, 2.2, 15), rr = radii(0.36);
        ctx.beginPath(); ctx.ellipse(c[0], c[1], rr[0], rr[1], 0, 0, Math.PI * 2);
        ctx.fillStyle = info.busy ? '#c78bff' : '#6a4f80'; ctx.fill();
        if (info.busy) {
          const f = P(2.2, 2.2, 6);
          glowDot(ctx, f[0], f[1], 9, 'rgba(255,170,70,0.7)', 'rgba(255,120,40,0)');
          glowDot(ctx, c[0], c[1], 12, 'rgba(220,170,255,0.45)', 'rgba(180,110,255,0)');
          for (let i = 0; i < 4; i++) {
            const q = (time * 0.6 + i / 4) % 1;
            ctx.fillStyle = 'rgba(230,200,255,' + (0.9 * (1 - q)) + ')';
            ctx.beginPath(); ctx.arc(c[0] + Math.sin(i * 2.4 + time) * 5, c[1] - 2 - q * 22, 1.4 + q * 1.4, 0, Math.PI * 2); ctx.fill();
          }
        }
        (info.spells || []).slice(0, 6).forEach(function (k, i) {
          const p = P(2.51, 0.5 + i * 0.22, 13);
          flask(ctx, p[0], p[1], 0.9, C.spells[k].color);
        });
        break;
      }
      case 'brazier':
      case 'thornheart': {
        const boss = b.type === 'thornheart';
        const u = w / 2, v = h / 2;
        if (info.pulse > 0) pulseRing(ctx, u, v, C.buildings[b.type].attack.range, info.pulse, boss ? '140,230,110' : '255,150,60');
        if (boss) {
          const z = 78 + Math.sin(time * 1.6) * 3, p = P(u, v, z), beat = 2 + Math.max(0, Math.sin(time * 5)) * 0.3;
          glowDot(ctx, p[0], p[1], 16 * beat, 'rgba(255,120,110,0.5)', 'rgba(140,230,110,0)');
          ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(beat, beat);
          ctx.beginPath(); ctx.moveTo(0, 7); ctx.bezierCurveTo(-11, -1, -6, -11, 0, -5); ctx.bezierCurveTo(6, -11, 11, -1, 0, 7); ctx.closePath();
          ctx.fillStyle = '#c4313a'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 1; ctx.stroke();
          ctx.strokeStyle = '#7fe06a'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(-6, -4); ctx.lineTo(0, 1); ctx.lineTo(5, -5); ctx.moveTo(0, 1); ctx.lineTo(0, 6); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-5, -5, 2, 2);
          ctx.restore();
        } else {
          const p = P(u, v, 25), k = info.active === false ? 0.4 : 1;
          const f = (0.85 + Math.sin(time * 13) * 0.12 + Math.sin(time * 21) * 0.06) * k;
          glowDot(ctx, p[0], p[1] - 6, 18, 'rgba(255,150,60,0.4)', 'rgba(255,150,60,0)');
          ctx.fillStyle = '#ff7a2a'; ctx.beginPath(); ctx.moveTo(p[0] - 8, p[1]); ctx.quadraticCurveTo(p[0] - 4, p[1] - 18 * f, p[0], p[1] - 22 * f); ctx.quadraticCurveTo(p[0] + 4, p[1] - 12 * f, p[0] + 8, p[1]); ctx.fill();
          ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.moveTo(p[0] - 4, p[1]); ctx.quadraticCurveTo(p[0] - 1, p[1] - 12 * f, p[0] + 4, p[1]); ctx.fill();
          for (let i = 0; i < 3; i++) {
            const q = (time * 0.8 + i / 3) % 1;
            ctx.fillStyle = 'rgba(255,200,90,' + (1 - q) + ')';
            ctx.fillRect(p[0] + Math.sin(i * 3 + time * 2) * 6, p[1] - 12 - q * 22, 1.5, 1.5);
          }
        }
        break;
      }
      case 'hail': {
        const ang = info.angle || 0, recoil = info.recoil || 0, dx = Math.cos(ang), dy = Math.sin(ang);
        cyl(ctx, null, 1.5, 1.5, 0.55, 45, 49, MAT.iron, { top: shade(MAT.iron, 0.25) });
        const tubes = function () {
          [-0.28, 0, 0.28].forEach(function (s, i) {
            const len = 0.95 - recoil * 0.2;
            const base = P(1.5 - dx * 0.35 - dy * s, 1.5 - dy * 0.35 + dx * s, 50 + (i === 1 ? 4 : 0));
            const tip = P(1.5 + dx * len - dy * s, 1.5 + dy * len + dx * s, 62 + (i === 1 ? 4 : 0) - recoil * 3);
            tube(ctx, base, tip, 6.4, '#5d6670');
            ctx.beginPath(); ctx.arc(tip[0], tip[1], 3.4, 0, Math.PI * 2); ctx.fillStyle = recoil ? '#1b1e22' : '#d4f3ff'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
          });
        };
        const hub = P(1.5, 1.5, 51);
        const plate = function () { ctx.beginPath(); ctx.arc(hub[0], hub[1], 6, 0, Math.PI * 2); ctx.fillStyle = team; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.9; ctx.stroke(); };
        if (dx + dy < 0) { tubes(); plate(); } else { plate(); tubes(); }
        break;
      }
      case 'tempest': {
        const c = P(1.5, 1.5, 76 + Math.sin(time * 2) * 2), k = info.pulse || 0;
        const r = 6.5 + k * 3 + Math.sin(time * 9) * 0.6;
        glowDot(ctx, c[0], c[1], r * 2.6, 'rgba(255,245,170,' + (0.55 + k * 0.4) + ')', alpha(team, 0));
        ctx.beginPath(); ctx.arc(c[0], c[1], r * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = k ? '#ffffff' : '#fff6c4'; ctx.fill(); ctx.strokeStyle = 'rgba(160,130,40,0.6)'; ctx.lineWidth = 0.8; ctx.stroke();
        if (k > 0 || Math.sin(time * 1.7) > 0.8) {
          ctx.strokeStyle = 'rgba(255,248,200,0.9)'; ctx.lineWidth = 1;
          [[0.65, 0.65], [2.35, 0.65], [0.65, 2.35], [2.35, 2.35]].forEach(function (q, i) {
            const e = P(1.5 + (q[0] - 1.5) * 0.4, 1.5 + (q[1] - 1.5) * 0.4, 58);
            ctx.beginPath(); ctx.moveTo(c[0], c[1]);
            ctx.lineTo((c[0] + e[0]) / 2 + Math.sin(time * 50 + i) * 3, (c[1] + e[1]) / 2 + Math.cos(time * 45 + i) * 3);
            ctx.lineTo(e[0], e[1]); ctx.stroke();
          });
        }
        break;
      }
      case 'bombard': {
        const ang = info.angle || 0, recoil = info.recoil || 0, dx = Math.cos(ang), dy = Math.sin(ang);
        prism(ctx, rotRect(2, 2, ang, 1.4, 1.4), 22, 30, '#7a5a34', { top: shade('#7a5a34', TOP) });
        const base = P(2 - dx * 0.1, 2 - dy * 0.1, 31);
        const tip = P(2 + dx * 0.6, 2 + dy * 0.6, 64 - recoil * 8);
        tube(ctx, base, tip, 24, '#b8893a');
        ctx.beginPath(); ctx.ellipse(tip[0], tip[1], 13, 7.6, 0, 0, Math.PI * 2); ctx.fillStyle = '#c99a45'; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(tip[0], tip[1], 8.6, 4.8, 0, 0, Math.PI * 2); ctx.fillStyle = '#1b1612'; ctx.fill();
        if (recoil) glowDot(ctx, tip[0], tip[1], 10, 'rgba(255,200,90,0.6)', 'rgba(255,140,40,0)');
        const band = lerp2(base, tip, 0.45);
        ctx.strokeStyle = INKLINE; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(band[0], band[1], 12.4, 5.4, 0, 0.1, Math.PI - 0.1); ctx.stroke();
        ctx.strokeStyle = team; ctx.lineWidth = 3.4; ctx.stroke();
        // sun emblem on the barrel
        const sun = lerp2(base, tip, 0.2);
        ctx.beginPath(); ctx.arc(sun[0], sun[1], 4, 0, Math.PI * 2); ctx.fillStyle = MAT.gold; ctx.fill(); ctx.strokeStyle = INKLINE; ctx.lineWidth = 0.8; ctx.stroke();
        break;
      }
      case 'idol': {
        // a wyrm head on a turning neck; embers glow in its jaws
        const ang = info.angle || 0, dx = Math.cos(ang), dy = Math.sin(ang), dark = '#5a4a66';
        const neck = function () { cyl(ctx, null, 2, 2, 0.5, 26, 46, dark, { tex: 'bands', top: shade(dark, 0.2) }); };
        const head = function () {
          const at = function (f, s, z) { return [2 + dx * f - dy * s, 2 + dy * f + dx * s, z]; };
          const flat = function (pts) { return pts.map(function (q) { const p = at(q[0], q[1], 0); return [p[0], p[1]]; }); };
          // swept-back horns in two segments
          [-0.3, 0.3].forEach(function (s) { const m = at(-0.35, s * 1.5, 66); beam(ctx, at(0.15, s, 56), m, 4, '#e4d6b8'); beam(ctx, m, at(-0.75, s * 1.6, 70), 2.6, '#f4ecd8'); });
          prism(ctx, flat([[0.3, -0.36], [1.45, -0.17], [1.45, 0.17], [0.3, 0.36]]), 38, 44, shade(dark, -0.12), {});
          prism(ctx, flat([[0.05, -0.46], [0.75, -0.4], [1.55, -0.2], [1.55, 0.2], [0.75, 0.4], [0.05, 0.46]]), 44, 57, dark, { top: shade(dark, 0.18) });
          prism(ctx, flat([[0.25, -0.42], [0.6, -0.42], [0.6, 0.42], [0.25, 0.42]]), 57, 60, shade(dark, 0.08), {});
          // fangs along the jaw line
          for (let k = 0; k < 3; k++) [-0.3, 0.3].forEach(function (s) { const f = P.apply(null, at(0.9 + k * 0.22, s, 44)); poly(ctx, [[f[0] - 1.4, f[1]], [f[0] + 1.4, f[1]], [f[0], f[1] + 4]], '#f4ecd8', EDGE); });
          const m = P.apply(null, at(1.55, 0, 44));
          glowDot(ctx, m[0], m[1], 12 + Math.sin(time * 7) * 2, 'rgba(255,170,60,0.9)', 'rgba(255,90,30,0)');
          [-0.2, 0.2].forEach(function (s) {
            const e = P.apply(null, at(0.4, s, 59));
            glowDot(ctx, e[0], e[1], 5, 'rgba(255,210,80,0.8)', 'rgba(255,140,40,0)');
            ctx.beginPath(); ctx.arc(e[0], e[1], 2.2, 0, Math.PI * 2); ctx.fillStyle = '#ffe27a'; ctx.fill();
          });
        };
        if (dx + dy < 0) { head(); neck(); } else { neck(); head(); }
        break;
      }
      case 'snare':
      case 'charge':
      case 'mine': {
        if (info.hidden) break;
        const p = P(w / 2, h / 2, b.type === 'charge' ? 10 : 4);
        const blink = info.triggered ? 1 : (Math.sin(time * 4) > 0.6 ? 1 : 0.25);
        ctx.fillStyle = 'rgba(255,70,40,' + blink + ')';
        ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, Math.PI * 2); ctx.fill();
        break;
      }
    }
    if (spr && spr.flags) {
      for (let i = 0; i < spr.flags.length; i++) {
        const f = spr.flags[i];
        pennant(ctx, P(f[0], f[1], f[2]), f[3], f[4], team, time, f[0] * 3 + f[1] * 5 + (b.id || 0));
      }
    }
    if (info.upgrading) {
      const posts = [[0.2, h - 0.2], [w - 0.2, h - 0.2], [w - 0.2, 0.2]];
      posts.forEach(function (p) { pole(ctx, p[0], p[1], 0, 40, 2, MAT.fresh); });
      [14, 30].forEach(function (z) {
        beam(ctx, [posts[0][0], posts[0][1], z], [posts[1][0], posts[1][1], z], 2.2, MAT.fresh);
        beam(ctx, [posts[1][0], posts[1][1], z], [posts[2][0], posts[2][1], z], 2.2, MAT.fresh);
      });
      beam(ctx, [posts[0][0], posts[0][1], 2], [posts[1][0], posts[1][1], 28], 1.4, shade(MAT.fresh, -0.12));
      const k = Math.sin(time * 8);
      if (k > 0.8) {
        const sp = P(w * 0.62, h - 0.2, 31);
        ctx.fillStyle = '#ffe9a0';
        for (let i = 0; i < 4; i++) ctx.fillRect(sp[0] + Math.cos(i * 1.6) * 5, sp[1] + Math.sin(i * 1.6) * 3, 1.5, 1.5);
      }
    }
  };

  // ---------------------------------------------------------------- troops
  const SKIN = ['#f1c9a5', '#d9a37c', '#a8714d', '#ffd9b8'];

  function inkFill(c, col, lw) {
    c.fillStyle = col; c.fill();
    c.strokeStyle = INKLINE; c.lineWidth = lw || 1; c.stroke();
  }
  function limb(c, x0, y0, x1, y1, w, col) {
    c.lineCap = 'round';
    c.strokeStyle = INKLINE; c.lineWidth = w + 1.8; line(c, [x0, y0], [x1, y1]);
    c.strokeStyle = col; c.lineWidth = w; line(c, [x0, y0], [x1, y1]);
    c.lineCap = 'butt';
  }
  function legs(c, walk, col, w, len, boot) {
    const s = Math.sin(walk) * 3, lift = Math.cos(walk) * 1.6;
    limb(c, -0.9, -len, -s - 0.6, -Math.max(0, -lift), w, shade(col, -0.25));
    if (boot) { c.fillStyle = shade(boot, -0.2); c.fillRect(-s - 2, -Math.max(0, -lift) - 1.4, 3.6, 1.8); }
    limb(c, 0.9, -len, s + 0.6, -Math.max(0, lift), w, col);
    if (boot) { c.fillStyle = boot; c.fillRect(s - 0.8, -Math.max(0, lift) - 1.4, 3.8, 1.8); }
  }
  function head(c, x, y, r, skin) {
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); inkFill(c, skin);
    c.fillStyle = '#24170f'; c.fillRect(x + r * 0.32, y - r * 0.22, 1.3, 1.5);
    c.fillStyle = 'rgba(200,90,70,0.25)'; c.fillRect(x + r * 0.1, y + r * 0.2, 1.8, 1);
  }
  function body(c, pts, col) {
    trace(c, pts); inkFill(c, col);
    c.save(); trace(c, pts); c.clip();
    let maxY = -99;
    pts.forEach(function (p) { maxY = Math.max(maxY, p[1]); });
    c.fillStyle = 'rgba(0,0,0,0.16)'; c.fillRect(-20, maxY - 3, 40, 4);
    c.restore();
  }

  function drawEngineer(c, time) {
    c.fillStyle = 'rgba(14,20,28,0.28)'; c.beginPath(); c.ellipse(0, 0.5, 6, 2.6, 0, 0, Math.PI * 2); c.fill();
    legs(c, 0, '#3b4a63', 2.3, 6, '#2a211c');
    body(c, [[-4, -14], [4, -14], [4.4, -6], [-4.4, -6]], '#f08a24');
    c.fillStyle = '#ffd23a'; c.fillRect(-4, -11, 8, 1.4);
    head(c, 0.4, -17.4, 3.5, SKIN[0]);
    c.beginPath(); c.arc(0.4, -18.6, 4, Math.PI, 0); c.lineTo(5, -18.6); c.lineTo(-4.2, -18.6); c.closePath(); inkFill(c, '#ffd23a');
    const sw = Math.sin(time * 6) * 0.6;
    c.save(); c.translate(3.5, -11); c.rotate(-0.6 + sw);
    c.fillStyle = MAT.timber; c.fillRect(0, -0.9, 7, 1.8); c.fillStyle = '#9aa4ae'; c.fillRect(6, -2.6, 3, 5.2);
    c.restore();
  }

  // Shadow and team-ring size per troop.
  const BIG = { bruiser: 1.3, scout: 0.9, lancer: 1.25, colossus: 1.9, marshal: 1.2, gyro: 0.9, trebuchet: 1.5, drake: 1.3 };

  // Draws one troop with its feet at the origin, facing +x. a: {walk, lunge, flick, hover, spin, skin, idle}
  function drawTroopBody(c, type, team, a) {
    const skin = SKIN[a.skin || 0], lunge = a.lunge || 0;
    const big = BIG[type] || 1;
    c.fillStyle = 'rgba(14,20,28,0.3)';
    c.beginPath(); c.ellipse(0, 0.6, 7 * big, 2.8 * big, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = alpha(team, 0.55); c.lineWidth = 1.2;
    c.beginPath(); c.ellipse(0, 0.6, 7.5 * big, 3.2 * big, 0, 0, Math.PI * 2); c.stroke();
    c.lineJoin = 'round';
    if (lunge) c.translate(lunge * 2.5, 0);
    const bob = a.idle ? 0 : Math.abs(Math.sin(a.walk)) * 1.2;
    c.translate(0, -bob);
    const sw = a.idle ? 0 : Math.sin(a.walk);
    if (type === 'scout') {
      c.scale(0.92, 0.92);
      legs(c, a.walk, '#3b3346', 2.3, 7, '#2a211c');
      limb(c, -1.2, -12.5, -3 - sw * 1.6, -8.5, 1.9, shade(team, -0.35));
      body(c, [[-4, -15], [4, -15], [4.8, -6.5], [-4.8, -6.5]], team);
      c.fillStyle = '#5a3a22'; c.fillRect(-4.6, -9, 9.2, 1.7);
      c.fillStyle = MAT.brass; c.fillRect(-0.8, -9.2, 1.8, 2);
      head(c, 0.8, -18.3, 3.7, skin);
      c.beginPath(); c.arc(0.3, -18.8, 4.5, Math.PI * 0.82, Math.PI * 2.12); c.lineTo(-3.8, -14.6); c.closePath(); inkFill(c, shade(team, -0.2));
      c.save(); c.translate(3.4, -11.5); c.rotate(-0.55 - lunge * 1.2);
      c.beginPath(); c.moveTo(1.6, -1); c.lineTo(11, -1.1); c.lineTo(12.8, 0); c.lineTo(11, 1.1); c.lineTo(1.6, 1); c.closePath(); inkFill(c, '#e4e9ee', 0.8);
      c.fillStyle = MAT.brass; c.fillRect(0.4, -2.6, 1.6, 5.2);
      c.restore();
      limb(c, 1.4, -13, 3.6, -11.2, 1.9, shade(team, -0.1));
    } else if (type === 'ranger') {
      legs(c, a.walk, '#4a3a2a', 2.4, 7, '#2a211c');
      c.beginPath(); c.moveTo(-3.5, -16); c.lineTo(-7.5 - sw, -4); c.lineTo(-1, -5.5); c.closePath(); inkFill(c, shade(team, -0.1));
      c.fillStyle = '#6b4a2b'; c.save(); c.translate(-4, -12); c.rotate(-0.35); c.fillRect(-1.6, -6, 3.2, 9); c.restore();
      c.fillStyle = '#e8e2d0'; c.fillRect(-5.6, -19.5, 1, 3); c.fillRect(-3.8, -19.8, 1, 3);
      body(c, [[-4, -16], [4, -16], [4.6, -6.5], [-4.6, -6.5]], '#5d6b3a');
      c.fillStyle = team; c.fillRect(-4.3, -16, 8.6, 2.4);
      c.fillStyle = '#4a3220'; c.fillRect(-4.5, -9.5, 9, 1.6);
      head(c, 0.8, -19.2, 3.6, skin);
      c.beginPath(); c.ellipse(0.6, -21.6, 6.6, 1.9, 0, 0, Math.PI * 2); inkFill(c, '#3d4a2a');
      c.beginPath(); c.arc(0.6, -22, 3.4, Math.PI, 0); c.closePath(); inkFill(c, '#46552f');
      c.fillStyle = team; c.fillRect(-2.8, -22.6, 6.8, 1.2);
      // longbow and string
      const bx = 6, by = -12.5;
      c.strokeStyle = INKLINE; c.lineWidth = 2.8; c.beginPath(); c.arc(bx - 4, by, 9, -1.15, 1.15); c.stroke();
      c.strokeStyle = '#8a5a2c'; c.lineWidth = 1.6; c.beginPath(); c.arc(bx - 4, by, 9, -1.15, 1.15); c.stroke();
      const t0 = [bx - 4 + Math.cos(-1.15) * 9, by + Math.sin(-1.15) * 9], t1 = [bx - 4 + Math.cos(1.15) * 9, by + Math.sin(1.15) * 9];
      c.strokeStyle = '#f2ecda'; c.lineWidth = 0.7;
      c.beginPath(); c.moveTo(t0[0], t0[1]); c.lineTo(bx - 2.2 - lunge * 3, by); c.lineTo(t1[0], t1[1]); c.stroke();
      limb(c, 1.5, -14, bx - 0.5, by, 1.9, shade('#5d6b3a', -0.05));
    } else if (type === 'bruiser') {
      c.scale(1.24, 1.24);
      legs(c, a.walk * 0.8, '#4b5058', 3, 6.5, '#2a2a2e');
      // shield on the far arm
      c.beginPath(); c.moveTo(-9, -17); c.lineTo(-2.5, -17); c.lineTo(-2.5, -10); c.quadraticCurveTo(-2.5, -4.5, -5.75, -3); c.quadraticCurveTo(-9, -4.5, -9, -10); c.closePath();
      inkFill(c, team);
      c.strokeStyle = 'rgba(255,240,210,0.8)'; c.lineWidth = 1; c.beginPath(); c.moveTo(-5.75, -15.5); c.lineTo(-5.75, -5.5); c.moveTo(-8, -12); c.lineTo(-3.5, -12); c.stroke();
      body(c, [[-5.5, -17.5], [5.5, -17.5], [6, -6], [-6, -6]], '#a3adb7');
      c.fillStyle = team; c.fillRect(-1.6, -17, 3.2, 11);
      c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(-4.8, -16.8, 2, 8);
      c.beginPath(); c.arc(-5, -15.5, 3.2, 0, Math.PI * 2); inkFill(c, '#8a949e');
      head(c, 0.6, -20.5, 3.4, skin);
      c.beginPath(); c.arc(0.6, -21.3, 4, Math.PI * 0.95, Math.PI * 2.05); c.closePath(); inkFill(c, '#7d8892');
      c.fillStyle = '#2b2f36'; c.fillRect(1.2, -21.2, 3.8, 1.2);
      // hammer
      c.save(); c.translate(5, -11); c.rotate(-0.9 + sw * 0.15 - lunge * 1.4);
      c.fillStyle = INKLINE; c.fillRect(-0.4, -1.5, 12, 3);
      c.fillStyle = '#7a5530'; c.fillRect(0, -1, 11.2, 2);
      rrect(c, 9, -4.2, 6, 8.4, 1.2); inkFill(c, '#6b737d');
      c.fillStyle = 'rgba(255,255,255,0.3)'; c.fillRect(10, -3.4, 1.4, 6.6);
      c.restore();
      c.beginPath(); c.arc(4.6, -15.5, 3.2, 0, Math.PI * 2); inkFill(c, '#97a1ab');
    } else if (type === 'demo') {
      legs(c, a.walk, '#3a2f28', 2.3, 6.5, '#241c17');
      body(c, [[-4, -14.5], [4.2, -14.5], [4.8, -6], [-4.6, -6]], '#7a5233');
      c.fillStyle = shade('#7a5233', 0.15); c.fillRect(-2.5, -12, 5, 5.5);
      c.beginPath(); c.moveTo(-4.4, -14.6); c.lineTo(4.6, -14.6); c.lineTo(3.4, -12.2); c.lineTo(-3.6, -12.2); c.closePath(); inkFill(c, team);
      head(c, 1, -17.6, 3.6, skin);
      c.fillStyle = '#4a3a2c'; c.beginPath(); c.arc(0.6, -19, 3.8, Math.PI * 1.05, Math.PI * 1.95); c.fill();
      c.fillStyle = '#2b2b2b'; c.fillRect(-2.6, -19, 7.4, 1.6);
      c.beginPath(); c.arc(3.1, -18.3, 1.7, 0, Math.PI * 2); c.fillStyle = MAT.brass; c.fill();
      c.beginPath(); c.arc(3.1, -18.3, 1, 0, Math.PI * 2); c.fillStyle = '#9fe2ff'; c.fill();
      // bomb carried in front
      const bx = 5.2 + lunge, by = -10.5;
      c.beginPath(); c.arc(bx, by, 5, 0, Math.PI * 2); inkFill(c, '#26272c');
      c.fillStyle = 'rgba(255,255,255,0.3)'; c.beginPath(); c.arc(bx - 1.8, by - 2, 1.6, 0, Math.PI * 2); c.fill();
      c.fillStyle = MAT.brass; c.fillRect(bx - 1.4, by - 6, 2.8, 1.6);
      c.strokeStyle = '#8b6a3a'; c.lineWidth = 1; c.beginPath(); c.moveTo(bx, by - 6); c.quadraticCurveTo(bx + 2, by - 9, bx + 0.5, by - 10.5); c.stroke();
      if (a.flick) { c.fillStyle = '#ffd34d'; c.beginPath(); c.arc(bx + 0.5, by - 11, 1.9, 0, Math.PI * 2); c.fill(); c.fillStyle = '#ff7a2a'; c.beginPath(); c.arc(bx + 0.5, by - 11, 0.9, 0, Math.PI * 2); c.fill(); }
      limb(c, 1.5, -12.5, bx - 3.4, by + 1, 1.9, '#7a5233');
    } else if (type === 'mage') {
      c.beginPath(); c.moveTo(-6, 0); c.quadraticCurveTo(-4.5, -9, -3.4, -16); c.lineTo(3.6, -16); c.quadraticCurveTo(4.6, -9, 6, 0); c.closePath();
      inkFill(c, team);
      c.save(); c.clip(); c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(1.5, -17, 6, 18); c.restore();
      c.fillStyle = MAT.gold; c.fillRect(-5.6, -2, 11.2, 1.5);
      c.fillStyle = '#3b2a5c'; c.fillRect(-3.6, -9.6, 7.2, 1.5);
      head(c, 0.8, -19, 3.6, skin);
      c.fillStyle = '#e8e2d6'; c.beginPath(); c.moveTo(-1, -17); c.quadraticCurveTo(1.5, -11, 3.6, -16.5); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(-5.6, -20.4); c.lineTo(6.6, -20.4); c.lineTo(2.6, -27.5); c.quadraticCurveTo(0.8, -31.5, -2.6, -32); c.quadraticCurveTo(-0.2, -29, -1.2, -26.5); c.closePath();
      inkFill(c, '#3b2a5c');
      c.fillStyle = team; c.fillRect(-4.6, -22, 9.6, 1.5);
      const sx = 6.4 + lunge * 2;
      limb(c, sx, 0, sx + lunge, -24, 1.6, '#6b4a2b');
      const glow = 3.2 + (a.flick ? 0.9 : 0) + lunge * 2;
      glowDot(c, sx + lunge, -25.5, glow + 4, 'rgba(220,170,255,0.7)', 'rgba(180,110,255,0)');
      c.beginPath(); c.arc(sx + lunge, -25.5, glow * 0.62, 0, Math.PI * 2); c.fillStyle = '#f4e4ff'; c.fill();
      limb(c, 2, -14, sx - 0.4, -13, 1.8, shade(team, -0.1));
    } else if (type === 'mender') {
      const hov = 13 + Math.sin(a.hover) * 2;
      c.translate(0, bob - hov);
      c.strokeStyle = INKLINE; c.lineWidth = 2.6;
      line(c, [-9, -8], [9, -8]);
      c.strokeStyle = '#6a7480'; c.lineWidth = 1.4;
      line(c, [-9, -8], [9, -8]);
      const sp = a.spin * 2.1;
      c.strokeStyle = 'rgba(220,230,240,0.85)'; c.lineWidth = 1;
      c.beginPath(); c.ellipse(-9, -9.4, 4.4 * Math.abs(Math.cos(sp)) + 0.6, 1.2, 0, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.ellipse(9, -9.4, 4.4 * Math.abs(Math.sin(sp)) + 0.6, 1.2, 0, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0, -6, 6.6, 0, Math.PI * 2);
      const gr = c.createRadialGradient(-2.2, -8.6, 0.6, 0, -6, 7.5);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#b6c3cf');
      inkFill(c, gr);
      c.fillStyle = '#2fbf62'; c.fillRect(-1.2, -9.6, 2.4, 7); c.fillRect(-3.5, -7.3, 7, 2.4);
      c.fillStyle = team; c.fillRect(-5.5, -1.6, 11, 1.8);
      c.fillStyle = '#2b3a46'; c.beginPath(); c.arc(0, 0.6, 1.6, 0, Math.PI); c.fill();
    } else if (type === 'lancer') {
      // rider on a stocky mount; the lance dips forward as he strikes
      const g = Math.sin(a.walk), coat = '#8a6142';
      const hoof = function (x, ph, col) {
        const sx = a.idle ? 0 : Math.sin(a.walk + ph) * 2.4;
        limb(c, x, -7.5, x + sx, -0.4, 1.9, col);
      };
      hoof(-5.2, Math.PI, shade(coat, -0.3)); hoof(4.2, 0, shade(coat, -0.3));
      c.beginPath(); c.ellipse(-0.4, -9.5, 7.6, 3.8, 0, 0, Math.PI * 2); inkFill(c, coat);
      c.fillStyle = team; c.fillRect(-4.2, -12.4, 6.6, 4.4);
      c.fillStyle = MAT.gold; c.fillRect(-4.2, -8.6, 6.6, 0.9);
      hoof(-3.6, 0, coat); hoof(5.8, Math.PI, coat);
      // neck and head
      c.beginPath(); c.moveTo(4.5, -11); c.lineTo(8.2, -16.5 - g * 0.4); c.lineTo(11, -15.4 - g * 0.4); c.lineTo(10.4, -13.6); c.lineTo(6.5, -8.5); c.closePath(); inkFill(c, coat);
      c.fillStyle = '#2b1e14'; c.fillRect(7.4, -17.4 - g * 0.4, 1.6, 4);
      c.fillStyle = '#1d140e'; c.fillRect(9.4, -15.6 - g * 0.4, 1, 1);
      c.beginPath(); c.moveTo(-7.6, -10.5); c.quadraticCurveTo(-11, -9, -10, -4.5); c.lineWidth = 1.6; c.strokeStyle = '#2b1e14'; c.stroke();
      // rider
      body(c, [[-2.8, -21], [2.6, -21], [3, -13], [-3.2, -13]], '#a3adb7');
      c.fillStyle = team; c.fillRect(-0.6, -21, 1.4, 8);
      head(c, 0.2, -24, 3.2, skin);
      c.beginPath(); c.arc(0.2, -24.6, 3.6, Math.PI * 0.95, Math.PI * 2.05); c.closePath(); inkFill(c, '#7d8892');
      c.fillStyle = team; c.beginPath(); c.moveTo(-0.6, -28.2); c.lineTo(-4.6, -30.4); c.lineTo(-1.6, -27.4); c.closePath(); c.fill();
      c.save(); c.translate(2, -17); c.rotate(-0.28 + lunge * 0.32);
      c.strokeStyle = INKLINE; c.lineWidth = 2.6; line(c, [-4, 0], [14 + lunge * 2, 0]);
      c.strokeStyle = MAT.timber; c.lineWidth = 1.4; line(c, [-4, 0], [14 + lunge * 2, 0]);
      c.beginPath(); c.moveTo(13 + lunge * 2, -1.6); c.lineTo(18 + lunge * 2, 0); c.lineTo(13 + lunge * 2, 1.6); c.closePath(); inkFill(c, '#e4e9ee', 0.8);
      c.fillStyle = team; c.fillRect(9.5, 0.6, 3.6, 2.6);
      c.restore();
      limb(c, 1, -19, 3.4, -17, 1.8, '#97a1ab');
    } else if (type === 'gyro') {
      // rotor craft: hovers like the Mender, bomb slung under the cockpit
      const hov = 15 + Math.sin(a.hover) * 1.6;
      c.translate(0, bob - hov);
      c.strokeStyle = INKLINE; c.lineWidth = 2.4; line(c, [-3, -6], [-12, -8]);
      c.strokeStyle = '#6a7480'; c.lineWidth = 1.2; line(c, [-3, -6], [-12, -8]);
      c.beginPath(); c.moveTo(-12.5, -11); c.lineTo(-10.5, -8.2); c.lineTo(-13.8, -7.6); c.closePath(); inkFill(c, team, 0.8);
      c.beginPath(); c.arc(0, 2.2, 3.1, 0, Math.PI * 2); inkFill(c, '#26272c');
      c.fillStyle = 'rgba(255,255,255,0.3)'; c.beginPath(); c.arc(-1, 1.2, 1, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(0, -5, 6.4, 4.6, 0, 0, Math.PI * 2); inkFill(c, MAT.brass);
      c.fillStyle = team; c.fillRect(-6, -4.4, 12, 1.8);
      c.beginPath(); c.ellipse(2.6, -7.4, 3.2, 2.6, 0, Math.PI, 0); c.closePath(); inkFill(c, 'rgba(160,220,255,0.75)', 0.8);
      head(c, 1.8, -8.4, 2.2, skin);
      c.fillStyle = '#4a3a2c'; c.fillRect(-0.4, -10.4, 4.2, 1.2);
      c.strokeStyle = INKLINE; c.lineWidth = 2.2; line(c, [0, -9.8], [0, -13.4]);
      const sp = a.spin * 2.1;
      c.strokeStyle = 'rgba(225,232,240,0.9)'; c.lineWidth = 1.1;
      c.beginPath(); c.ellipse(0, -13.6, 11 * Math.abs(Math.cos(sp)) + 1, 1.3, 0, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = 'rgba(225,232,240,0.45)';
      c.beginPath(); c.ellipse(0, -13.6, 11 * Math.abs(Math.sin(sp)) + 1, 1.3, 0, 0, Math.PI * 2); c.stroke();
    } else if (type === 'colossus') {
      c.scale(1.7, 1.7);
      const stone = '#8f877c';
      legs(c, a.walk * 0.6, shade(stone, -0.1), 3.6, 6, null);
      limb(c, -5.5, -15, -7 - sw * 1.2, -7, 3.6, shade(stone, -0.2));
      c.beginPath(); c.arc(-7 - sw * 1.2, -6.5, 2.8, 0, Math.PI * 2); inkFill(c, shade(stone, -0.25));
      body(c, [[-6.5, -20], [6.5, -20], [5.6, -6.5], [-5.6, -6.5]], stone);
      c.fillStyle = 'rgba(30,20,12,0.3)'; c.fillRect(-3, -16, 2, 0.8); c.fillRect(1.6, -12, 2.6, 0.8); c.fillRect(-4.4, -10, 1.6, 0.8);
      c.beginPath(); c.moveTo(-6.2, -19.4); c.lineTo(-3.4, -19.4); c.lineTo(5.4, -8.4); c.lineTo(2.6, -8.4); c.closePath(); inkFill(c, team, 0.8);
      glowDot(c, 0.4, -14.5, 3.4, 'rgba(255,190,90,0.85)', 'rgba(255,140,40,0)');
      c.beginPath(); c.arc(0.5, -22.4, 3.4, 0, Math.PI * 2); inkFill(c, shade(stone, 0.06));
      c.fillStyle = '#ffcf6e'; c.fillRect(1.3, -23.2, 2, 1.2);
      // the striking fist rises and falls with the stomp
      const fx = 7 + lunge * 1.5, fy = -12 + lunge * 5;
      limb(c, 5, -17, fx, fy, 3.6, stone);
      c.beginPath(); c.arc(fx, fy + 0.5, 3.2, 0, Math.PI * 2); inkFill(c, shade(stone, 0.05));
    } else if (type === 'marshal') {
      c.scale(1.18, 1.18);
      const plate = '#c7ccd1';
      // cape behind
      c.beginPath(); c.moveTo(-4, -18); c.quadraticCurveTo(-9 - sw * 1.5, -9, -8 - sw, -1.5); c.lineTo(-1.5, -3); c.lineTo(-1, -17); c.closePath(); inkFill(c, team);
      legs(c, a.walk * 0.85, '#565c66', 2.9, 6.5, '#2a2a2e');
      body(c, [[-5, -18], [5, -18], [5.6, -6], [-5.6, -6]], plate);
      c.fillStyle = MAT.gold; c.fillRect(-5.4, -8.6, 11, 1.6); c.fillRect(-0.9, -17.6, 1.8, 9);
      c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(-4.2, -17, 1.8, 7);
      c.beginPath(); c.arc(-4.6, -16, 3, 0, Math.PI * 2); inkFill(c, MAT.gold);
      head(c, 0.6, -21.4, 3.4, skin);
      c.fillStyle = '#5a4030'; c.beginPath(); c.moveTo(-1, -19.4); c.quadraticCurveTo(1.4, -15.8, 3.8, -19.6); c.closePath(); c.fill();
      // crested helm
      c.beginPath(); c.arc(0.6, -22.2, 4, Math.PI * 0.95, Math.PI * 2.05); c.closePath(); inkFill(c, plate);
      c.fillStyle = '#2b2f36'; c.fillRect(1.4, -22.2, 3.6, 1.2);
      c.beginPath(); c.moveTo(-2.4, -25.4); c.quadraticCurveTo(-1, -30.5, 3.6, -29.4); c.quadraticCurveTo(0.6, -28, 1.8, -25.4); c.closePath(); inkFill(c, team, 0.8);
      c.fillStyle = MAT.gold; c.fillRect(-1.6, -26.6, 4.6, 1.3);
      // great hammer
      c.save(); c.translate(5, -12); c.rotate(-1.05 + sw * 0.12 - lunge * 1.6);
      c.fillStyle = INKLINE; c.fillRect(-0.5, -1.6, 14, 3.2);
      c.fillStyle = MAT.timber; c.fillRect(0, -1, 13.2, 2);
      rrect(c, 11, -5, 6.4, 10, 1.4); inkFill(c, '#6b737d');
      c.fillStyle = MAT.gold; c.fillRect(11, -0.8, 6.4, 1.6);
      c.restore();
      c.beginPath(); c.arc(4.6, -16, 3, 0, Math.PI * 2); inkFill(c, MAT.gold);
    } else if (type === 'huntress') {
      // hooded archer; her bowstring crackles with storm light
      legs(c, a.walk, '#3f3a4a', 2.3, 7.5, '#2a211c');
      c.beginPath(); c.moveTo(-3.8, -18); c.quadraticCurveTo(-8.5 - sw * 1.2, -8, -7 - sw, -1); c.lineTo(-1, -5); c.closePath(); inkFill(c, shade(team, -0.15));
      c.fillStyle = '#6b4a2b'; c.save(); c.translate(-3.2, -13); c.rotate(-0.4); c.fillRect(-1.6, -6.5, 3.2, 9.5); c.restore();
      c.fillStyle = '#bfe7ff'; c.fillRect(-5.2, -21, 1, 3); c.fillRect(-3.4, -21.4, 1, 3);
      body(c, [[-3.6, -17], [3.6, -17], [4.2, -7], [-4.2, -7]], '#3c4a5c');
      c.fillStyle = team; c.fillRect(-3.6, -11, 7.8, 1.4);
      c.fillStyle = MAT.gold; c.fillRect(-0.6, -11.2, 1.4, 1.8);
      head(c, 0.9, -20, 3.4, skin);
      c.beginPath(); c.moveTo(-3.4, -17.5); c.quadraticCurveTo(-3.6, -25.5, 1.2, -25); c.quadraticCurveTo(5.2, -24.6, 4.8, -20); c.lineTo(2.6, -22.6); c.quadraticCurveTo(-0.6, -22.6, -1.2, -17.2); c.closePath(); inkFill(c, team);
      const bx = 6.2, by = -13;
      c.strokeStyle = INKLINE; c.lineWidth = 2.8; c.beginPath(); c.arc(bx - 4.5, by, 10, -1.2, 1.2); c.stroke();
      c.strokeStyle = '#3d5a78'; c.lineWidth = 1.6; c.beginPath(); c.arc(bx - 4.5, by, 10, -1.2, 1.2); c.stroke();
      const t0 = [bx - 4.5 + Math.cos(-1.2) * 10, by + Math.sin(-1.2) * 10], t1 = [bx - 4.5 + Math.cos(1.2) * 10, by + Math.sin(1.2) * 10];
      c.strokeStyle = a.flick ? '#e8fbff' : '#8fdcff'; c.lineWidth = 0.9;
      c.beginPath(); c.moveTo(t0[0], t0[1]); c.lineTo(bx - 2.4 - lunge * 3, by); c.lineTo(t1[0], t1[1]); c.stroke();
      glowDot(c, bx - 2.4 - lunge * 3, by, 3, 'rgba(160,230,255,0.75)', 'rgba(160,230,255,0)');
      limb(c, 1.5, -15, bx - 0.5, by, 1.8, '#3c4a5c');
    } else if (type === 'vaulter') {
      // wall vaulter: a light runner carrying a long pole, swung up to strike
      legs(c, a.walk, '#5a4632', 2.2, 7, '#2a211c');
      body(c, [[-3.8, -15], [3.8, -15], [4.4, -6.5], [-4.4, -6.5]], '#d8b67a');
      c.fillStyle = team; c.fillRect(-4, -12.5, 8.2, 2.2);
      head(c, 0.8, -18.3, 3.5, skin);
      c.fillStyle = '#3a2a1c'; c.beginPath(); c.arc(0.4, -19.2, 3.7, Math.PI * 1.05, Math.PI * 1.95); c.fill();
      c.fillStyle = team; c.fillRect(-3, -20, 7, 1.4);
      c.save(); c.translate(1.5, -11); c.rotate(-0.25 - lunge * 0.6);
      c.strokeStyle = INKLINE; c.lineWidth = 2.6; line(c, [-12, 0], [15, 0]);
      c.strokeStyle = '#b08850'; c.lineWidth = 1.4; line(c, [-12, 0], [15, 0]);
      c.fillStyle = MAT.iron; c.fillRect(13, -1.3, 3, 2.6);
      c.restore();
      limb(c, 1.4, -13, 4, -11.5, 1.8, '#d8b67a');
    } else if (type === 'trebuchet') {
      // rolling siege engine: the arm flings its boulder up and over the front
      c.scale(1.3, 1.3);
      const wood = '#8a5a34';
      const wheel = function (x, col) {
        c.beginPath(); c.arc(x, -3, 3, 0, Math.PI * 2); inkFill(c, col);
        c.strokeStyle = shade(col, -0.45); c.lineWidth = 0.8;
        for (let i = 0; i < 2; i++) { const t = a.walk + i * Math.PI / 2; line(c, [x + Math.cos(t) * 2.6, -3 + Math.sin(t) * 2.6], [x - Math.cos(t) * 2.6, -3 - Math.sin(t) * 2.6]); }
      };
      wheel(-5.8, shade(wood, -0.3)); wheel(6.2, shade(wood, -0.3));
      limb(c, -3.6, -6, 0, -18, 1.8, shade(wood, -0.2));
      body(c, [[-9, -8.5], [9, -8.5], [9, -4.5], [-9, -4.5]], wood);
      c.fillStyle = team; c.fillRect(-8, -7.8, 16, 1.4);
      const th = 2.64 + lunge * 2.57, py = -18;
      const lx = Math.cos(th) * 13, ly = py + Math.sin(th) * 13, sx = -Math.cos(th) * 5, sy = py - Math.sin(th) * 5;
      limb(c, sx, sy, lx, ly, 1.6, '#6e4a2f');
      rrect(c, sx - 3, sy - 1, 6, 5, 1); inkFill(c, MAT.iron);
      if (lunge < 0.5) { c.beginPath(); c.arc(lx, ly + 1.6, 2.3, 0, Math.PI * 2); inkFill(c, '#8f877c'); }
      limb(c, 3.6, -6, 0, -18, 1.8, wood);
      c.beginPath(); c.arc(0, py, 1.5, 0, Math.PI * 2); inkFill(c, MAT.brass);
      wheel(-6.5, wood); wheel(5.5, wood);
    } else if (type === 'drake') {
      // ember drake: hovers on beating wings, embers flicker in its jaws
      const hov = 14 + Math.sin(a.hover) * 2;
      c.translate(0, bob - hov);
      c.scale(1.2, 1.2);
      const hide = '#b8452c', flap = Math.sin(a.hover * 2);
      c.beginPath(); c.moveTo(-1, -9); c.lineTo(-6, -17 - flap * 4); c.lineTo(2, -15 - flap * 3); c.closePath(); inkFill(c, shade(hide, -0.3));
      c.beginPath(); c.moveTo(-4, -7); c.quadraticCurveTo(-10, -6, -12, -10); c.lineTo(-10.5, -6.5); c.quadraticCurveTo(-8, -3, -3, -4); c.closePath(); inkFill(c, shade(hide, -0.1));
      c.beginPath(); c.ellipse(0, -6.5, 5.6, 3.6, -0.15, 0, Math.PI * 2); inkFill(c, hide);
      c.fillStyle = '#f0c27a'; c.beginPath(); c.ellipse(0.6, -4.6, 3.8, 1.5, -0.15, 0, Math.PI * 2); c.fill();
      c.fillStyle = team; c.fillRect(-2.6, -10, 4, 1.6);
      c.beginPath(); c.moveTo(3, -8.5); c.quadraticCurveTo(6, -12, 7.5, -12.5); c.lineTo(11, -11.6); c.lineTo(11, -9.8); c.lineTo(7.5, -9.6); c.quadraticCurveTo(5.5, -7.5, 4.5, -5.5); c.closePath(); inkFill(c, hide);
      c.beginPath(); c.moveTo(7, -12.4); c.lineTo(5.4, -15.4); c.lineTo(8.2, -12.6); c.closePath(); inkFill(c, '#e8dcc0', 0.7);
      c.fillStyle = '#ffd34d'; c.fillRect(8.4, -11.8, 1.2, 1);
      if (a.flick || lunge) glowDot(c, 11.6, -10.6, 2.6 + lunge * 3, 'rgba(255,200,90,0.9)', 'rgba(255,120,40,0)');
      c.beginPath(); c.moveTo(1, -8.5); c.lineTo(-3, -18 - flap * 5); c.lineTo(6, -14 - flap * 3.5); c.closePath(); inkFill(c, shade(hide, 0.1));
      c.strokeStyle = shade(hide, -0.45); c.lineWidth = 0.7; line(c, [1, -8.5], [1.4, -16 - flap * 4]);
    }
  }

  const HOVER = { mender: 1, gyro: 1, drake: 1 };   // hovering cancels the walk bob, so their frames ignore walking

  function poseOf(type, time, o) {
    const TAU = Math.PI * 2;
    const walkK = o.idle || HOVER[type] ? -1 : Math.floor((((o.walk != null ? o.walk : time * 10) % TAU) + TAU) % TAU / TAU * 8);
    const atkK = o.atk != null && o.atk < 1 ? Math.min(3, Math.floor(o.atk * 4)) : -1;
    const flick = type === 'demo' || type === 'mage' || type === 'huntress' || type === 'drake' ? Math.floor(time * 9) & 1 : 0;
    const hovK = HOVER[type] ? Math.floor((((time * 3) % TAU) + TAU) % TAU / TAU * 8) : 0;
    const spinK = HOVER[type] ? Math.floor(time * 18) % 3 : 0;
    return {
      key: walkK + '|' + atkK + '|' + flick + '|' + hovK + '|' + spinK,
      a: {
        idle: walkK < 0, walk: walkK < 0 ? 0 : (walkK + 0.5) / 8 * TAU, lunge: atkK < 0 ? 0 : Math.sin((atkK + 0.5) / 4 * Math.PI),
        flick: flick, hover: (hovK + 0.5) / 8 * TAU, spin: spinK, skin: o.skin || 0
      }
    };
  }

  // Troops are drawn from cached frames (one per quantised pose) so hundreds stay cheap.
  const FS = 2, FW = 48, FH = 56, FX = 24, FY = 46;
  const frames = new Map();
  function frameOf(type, team, time, o) {
    const p = poseOf(type, time, o);
    const key = type + '|' + team + '|' + (type === 'mender' ? 0 : o.skin || 0) + '|' + p.key;   // the Mender has no face
    let f = frames.get(key);
    if (f) return f;
    // evict only the oldest frame: clearing them all made big armies redraw every pose in one frame
    if (frames.size >= 1600) frames.delete(frames.keys().next().value);
    f = document.createElement('canvas');
    f.width = FW * FS; f.height = FH * FS;
    const g = f.getContext('2d');
    g.scale(FS, FS); g.translate(FX, FY);
    drawTroopBody(g, type, team, p.a);
    frames.set(key, f);
    return f;
  }

  // Draws a troop with its feet at (x, y) at scale k. o: {face, walk, atk, hit, idle, skin}
  Spr.drawTroop = function (ctx, x, y, k, type, team, time, o) {
    const f = frameOf(type, team, time, o);
    const face = o.face || 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k * face, k);
    ctx.drawImage(f, -FX, -FY, FW, FH);
    if (o.hit) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      ctx.drawImage(f, -FX, -FY, FW, FH);
    }
    ctx.restore();
  };

  // Direct draw (icons). Same pose rules as the cached frames, without quantising.
  Spr.drawUnit = function (ctx, type, team, time, o) {
    o = o || {};
    ctx.save();
    ctx.scale(o.face || 1, 1);
    drawTroopBody(ctx, type, team, {
      idle: !!o.idle, walk: o.idle ? 0 : (o.walk != null ? o.walk : time * 10),
      lunge: o.atk != null && o.atk < 1 ? Math.sin(o.atk * Math.PI) : 0,
      flick: Math.floor(time * 9) & 1, hover: time * 3, spin: Math.floor(time * 18) % 3, skin: o.skin || 0
    });
    ctx.restore();
  };

  // ---------------------------------------------------------------- UI images
  const thumbCache = {};
  Spr.thumb = function (type, level, team, px) {
    px = px || 96;
    team = team || '#3f86e8';
    const key = type + '|' + level + '|' + team + '|' + px;
    if (thumbCache[key]) return thumbCache[key];
    const s = Spr.building(type, level, 0, team, 'normal', type === 'wall' ? 3 : 0);
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
      Spr.drawLive(ctx, { type: type, w: size[0], h: size[1], id: 0 }, { team: team, fill: 0.7, active: true, angle: 0.8, troops: 0, troopTypes: [], hero: C.buildings[type].hero }, 0.5, s);
      ctx.restore();
    }
    thumbCache[key] = c.toDataURL();
    return thumbCache[key];
  };

  // Portrait framing per troop: [feet position as a share of the height, drawing units across].
  const ICON_FIT = { mage: [0.9, 38], lancer: [0.88, 40], gyro: [1.08, 34], colossus: [0.95, 54], marshal: [0.9, 40], huntress: [0.88, 34], vaulter: [0.86, 38], trebuchet: [0.88, 40], drake: [1.12, 40] };
  Spr.troopIcon = function (type, team, px) {
    px = px || 72;
    const key = 'troop|' + type + '|' + team + '|' + px;
    if (thumbCache[key]) return thumbCache[key];
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    const fit = ICON_FIT[type] || [0.86, 32];
    ctx.translate(px / 2, px * fit[0]);
    const k = px / fit[1];
    ctx.scale(k, k);
    ctx.lineJoin = 'round';
    Spr.drawUnit(ctx, type, team || '#3f86e8', 0.3, { face: 1, idle: true });
    thumbCache[key] = c.toDataURL();
    return thumbCache[key];
  };

  // Spell portrait: a flask of the spell's colour with its sigil.
  Spr.spellIcon = function (type, px) {
    px = px || 72;
    const key = 'spell|' + type + '|' + px;
    if (thumbCache[key]) return thumbCache[key];
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    ctx.scale(px / 32, px / 32);
    ctx.lineJoin = 'round';
    const col = C.spells[type].color;
    glowDot(ctx, 16, 19, 15, alpha(col, 0.45), alpha(col, 0));
    flask(ctx, 16, 29, 2.4, col);
    ctx.save(); ctx.translate(16, 20.8);
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    if (type === 'heal') { ctx.fillRect(-1.2, -4, 2.4, 8); ctx.fillRect(-4, -1.2, 8, 2.4); }
    else if (type === 'rage') { ctx.beginPath(); ctx.moveTo(-4, 1); ctx.lineTo(0, -3); ctx.lineTo(4, 1); ctx.moveTo(-4, 4); ctx.lineTo(0, 0); ctx.lineTo(4, 4); ctx.stroke(); }
    else if (type === 'freeze') { for (let i = 0; i < 3; i++) { const t = i * Math.PI / 3; line(ctx, [Math.cos(t) * 4.5, Math.sin(t) * 4.5], [-Math.cos(t) * 4.5, -Math.sin(t) * 4.5]); } }
    else { ctx.beginPath(); ctx.moveTo(1.5, -5); ctx.lineTo(-2.5, 0.5); ctx.lineTo(0.5, 0.5); ctx.lineTo(-1.5, 5); ctx.lineTo(3, -1); ctx.lineTo(0, -1); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    thumbCache[key] = c.toDataURL();
    return thumbCache[key];
  };

  CS.Sprites = Spr;
})(window.CS = window.CS || {});
