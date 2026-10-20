/*
 * Home-base model helpers: building definitions, footprints, levels, counts and placement rules.
 * Buildings store `dmg` (damage taken) instead of hit points so research that raises max HP
 * never makes healthy buildings look damaged.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U;
  const Base = {};

  Base.def = function (type) { return C.buildings[type]; };

  Base.size = function (type, rot) {
    const s = C.buildings[type].size;
    return rot ? [s[1], s[0]] : [s[0], s[1]];
  };

  Base.maxLevel = function (type) { return C.buildings[type].levels.length; };

  // Stats for a level (level 0 = still under construction, which uses level 1 stats).
  Base.levelDef = function (type, level) {
    const L = C.buildings[type].levels;
    return L[U.clamp(level, 1, L.length) - 1];
  };

  Base.rect = function (b) {
    const s = Base.size(b.type, b.rot);
    return { x: b.x, y: b.y, w: s[0], h: s[1] };
  };

  Base.find = function (state, id) {
    const list = state.base.buildings;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  Base.ofType = function (state, type) {
    return state.base.buildings.filter(function (b) { return b.type === type; });
  };

  Base.count = function (state, type) {
    let n = 0;
    state.base.buildings.forEach(function (b) { if (b.type === type) n++; });
    return n;
  };

  Base.core = function (state) {
    return state.base.buildings.find(function (b) { return b.type === 'core'; }) || null;
  };

  Base.coreLevel = function (state) {
    const c = Base.core(state);
    return c ? Math.max(1, c.level) : 1;
  };

  Base.maxCount = function (type, coreLevel) {
    return C.buildings[type].max[U.clamp(coreLevel, 1, C.buildings.core.levels.length) - 1] || 0;
  };

  // First core level at which a building type becomes available.
  Base.unlockCore = function (type) {
    const m = C.buildings[type].max;
    for (let i = 0; i < m.length; i++) if (m[i] > 0) return i + 1;
    return 99;
  };

  Base.buildArea = function (coreLevel) {
    const size = C.grid.buildAreaByCore[U.clamp(coreLevel, 1, C.buildings.core.levels.length) - 1];
    const x0 = Math.floor((C.grid.size - size) / 2);
    return { x0: x0, y0: x0, x1: x0 + size, y1: x0 + size, size: size };
  };

  Base.isDefenseType = function (type) {
    const c = C.buildings[type].category;
    return c === 'defense' || c === 'trap';
  };

  Base.isResourceType = function (type) {
    const d = C.buildings[type];
    return !!(d.produces || d.stores);
  };

  Base.hpMult = function (state, type) {
    const cat = C.buildings[type].category;
    if (cat !== 'defense' && cat !== 'wall') return 1;
    return CS.Research ? CS.Research.mult(state, 'plating') : 1;
  };

  Base.maxHp = function (state, b) {
    return Math.round(Base.levelDef(b.type, b.level).hp * Base.hpMult(state, b.type));
  };

  Base.hp = function (state, b) {
    if (b.ruined) return 0;
    return Math.max(0, Base.maxHp(state, b) - (b.dmg || 0));
  };

  // A building works when it is finished, not being upgraded and not in ruins.
  Base.isFunctional = function (b) {
    return !b.ruined && b.status === 'active' && b.level >= 1;
  };

  Base.isBusy = function (b) { return b.status === 'building' || b.status === 'upgrading'; };

  // Occupancy map: tile -> building id (0 = empty). Optionally ignores one building.
  Base.occupancy = function (buildings, ignoreId) {
    const S = C.grid.size;
    const occ = new Int32Array(S * S);
    buildings.forEach(function (b) {
      if (b.id === ignoreId) return;
      const r = Base.rect(b);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (x >= 0 && y >= 0 && x < S && y < S) occ[y * S + x] = b.id;
        }
      }
    });
    return occ;
  };

  // Can `type` be put at (x, y) with rotation `rot`? Returns {ok, reason}.
  Base.canPlaceAt = function (state, type, x, y, rot, ignoreId, occ) {
    const s = Base.size(type, rot);
    const area = Base.buildArea(Base.coreLevel(state));
    if (x < area.x0 || y < area.y0 || x + s[0] > area.x1 || y + s[1] > area.y1) {
      return { ok: false, reason: 'Outside your build area' };
    }
    occ = occ || Base.occupancy(state.base.buildings, ignoreId);
    const S = C.grid.size;
    for (let ty = y; ty < y + s[1]; ty++) {
      for (let tx = x; tx < x + s[0]; tx++) {
        const id = occ[ty * S + tx];
        if (id && id !== ignoreId) return { ok: false, reason: 'Space is occupied' };
      }
    }
    return { ok: true };
  };

  // Finds the free spot nearest to (cx, cy) for a footprint, searching outward in rings.
  Base.findFreeSpot = function (state, type, rot, cx, cy, ignoreId) {
    const occ = Base.occupancy(state.base.buildings, ignoreId);
    const s = Base.size(type, rot);
    const S = C.grid.size;
    for (let r = 0; r < S; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.round(cx - s[0] / 2) + dx, y = Math.round(cy - s[1] / 2) + dy;
          if (Base.canPlaceAt(state, type, x, y, rot, ignoreId, occ).ok) return { x: x, y: y };
        }
      }
    }
    return null;
  };

  Base.newBuilding = function (state, type, x, y, rot, level, status) {
    const b = {
      id: state.base.nextId++, type: type, level: level, x: x, y: y, rot: rot ? 1 : 0,
      status: status || 'active', timer: null, dmg: 0, ruined: false, stored: 0, prodAt: 0
    };
    state.base.buildings.push(b);
    return b;
  };

  Base.name = function (type) { return C.buildings[type].name; };

  CS.Base = Base;
})(window.CS = window.CS || {});
