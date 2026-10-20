/*
 * Base presets: three ready-made layouts for every Command Core level. Applying one moves the
 * buildings the player already owns onto it; slots for buildings they do not own stay empty.
 * Layouts come from the NPC base generator fed with the core level's full building allowance,
 * so every slot is inside that level's build area.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, Base = CS.Base;
  const Presets = {};

  Presets.STYLES = [
    { arch: 'ring', name: 'Bastion Ring', desc: 'Walls hug the Core and storages. Defenses circle the wall so every side is covered.' },
    { arch: 'fortress', name: 'Citadel', desc: 'Two wall rings. Half the defenses guard the inner keep, the rest hold the outer ring.' },
    { arch: 'compartments', name: 'Quarters', desc: 'A wall cross splits the base into four cells, so raiders must break through again and again.' }
  ];

  const cache = {};

  // Slots for every building the core level allows: [{type, x, y, rot}], core first.
  Presets.layout = function (core, i) {
    const key = core + ':' + i;
    if (cache[key]) return cache[key];
    const spec = { core: core, area: Base.buildArea(core).size, walls: [0, 0], wallLv: [1, 1], b: {}, tight: true };   // tight: no gaps around outer buildings
    Object.keys(C.buildings).forEach(function (type) {
      const n = Base.maxCount(type, core);
      if (type === 'wall') spec.walls = [n, n];
      else if (type !== 'core' && n) spec.b[type] = [n, n, 1, 1];
    });
    const want = Object.keys(spec.b).reduce(function (n, t) { return n + spec.b[t][0]; }, 1);
    let gen = [];
    const walls = spec.walls[0];
    // A seed can leave a building without room; the next one usually fits everything. On a crowded
    // core level the inner walls can take that room, so fewer of them are tried (the rest ring the base).
    search: for (let f = 1; f >= 0; f -= 0.25) {
      spec.walls = [Math.round(walls * f), Math.round(walls * f)];
      for (let seed = 7919 * core + 104729 * (i + 1), k = 0; k < 8; k++, seed++) {
        gen = CS.NPC.generate(spec, 0, seed, Presets.STYLES[i].arch);
        if (gen.filter(function (b) { return b.type !== 'wall'; }).length === want) break search;
      }
    }
    const out = gen.map(function (b) { return { type: b.type, x: b.x, y: b.y, rot: b.rot }; });
    addOuterWalls(out, core, walls);
    cache[key] = out;
    return cache[key];
  };

  // The generator spends only part of a big wall allowance, so the rest becomes rings around the whole base.
  function addOuterWalls(out, core, allowed) {
    let left = allowed - out.filter(function (b) { return b.type === 'wall'; }).length;
    const area = Base.buildArea(core), S = C.grid.size;
    const occ = Base.occupancy(out.map(function (b, k) { return { id: k + 1, type: b.type, x: b.x, y: b.y, rot: b.rot }; }));
    const r = { x0: S, y0: S, x1: 0, y1: 0 };
    out.forEach(function (b) {
      const s = Base.size(b.type, b.rot);
      r.x0 = Math.min(r.x0, b.x); r.y0 = Math.min(r.y0, b.y); r.x1 = Math.max(r.x1, b.x + s[0] - 1); r.y1 = Math.max(r.y1, b.y + s[1] - 1);
    });
    for (let pad = 1; left > 0 && pad < S; pad += 2) {
      const x0 = Math.max(area.x0, r.x0 - pad), y0 = Math.max(area.y0, r.y0 - pad);
      const x1 = Math.min(area.x1 - 1, r.x1 + pad), y1 = Math.min(area.y1 - 1, r.y1 + pad);
      for (let y = y0; y <= y1 && left > 0; y++) {
        for (let x = x0; x <= x1 && left > 0; x++) {
          if ((x !== x0 && x !== x1 && y !== y0 && y !== y1) || occ[y * S + x]) continue;
          occ[y * S + x] = 1;
          out.push({ type: 'wall', x: x, y: y, rot: 0 });
          left--;
        }
      }
    }
  }

  // Moves the player's buildings onto preset i for their core level. A building the preset has no
  // slot for goes to the nearest free spot. All or nothing: returns {ok, reason}.
  Presets.apply = function (state, i) {
    const slots = {};
    Presets.layout(Base.coreLevel(state), i).forEach(function (s) { (slots[s.type] = slots[s.type] || []).push(s); });
    const all = state.base.buildings;
    const before = all.map(function (b) { return [b.x, b.y, b.rot]; });
    // The core goes first (it sets the build area); higher levels take the earlier, more central slots.
    const order = all.slice().sort(function (a, b) { return (b.type === 'core') - (a.type === 'core') || b.level - a.level; });
    const placed = [], spill = [];
    state.base.buildings = placed;
    order.forEach(function (b) {
      const s = slots[b.type] && slots[b.type].shift();
      if (s && Base.canPlaceAt(state, b.type, s.x, s.y, s.rot, b.id).ok) { b.x = s.x; b.y = s.y; b.rot = s.rot; placed.push(b); }
      else spill.push(b);
    });
    const S = C.grid.size;
    const stuck = spill.some(function (b) {
      const spot = Base.findFreeSpot(state, b.type, b.rot, S / 2, S / 2, b.id);
      if (!spot) return true;
      b.x = spot.x; b.y = spot.y;
      placed.push(b);
      return false;
    });
    state.base.buildings = all;
    if (stuck) {
      all.forEach(function (b, k) { b.x = before[k][0]; b.y = before[k][1]; b.rot = before[k][2]; });
      return { ok: false, reason: 'Not enough room to fit every building in this layout' };
    }
    return { ok: true };
  };

  CS.Presets = Presets;
})(window.CS = window.CS || {});
