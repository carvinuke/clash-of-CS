/*
 * NPC world: the roster of enemy settlements, their persistent progress, procedural base
 * layouts, loot, difficulty estimates, raiding armies and independent world activity.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base;
  const NPC = {};
  const SZ = C.grid.size;

  NPC.def = function (id) {
    for (let i = 0; i < C.settlements.length; i++) if (C.settlements[i].id === id) return C.settlements[i];
    return null;
  };

  NPC.faction = function (s) { return C.factions[s.faction]; };

  function blankRecord() {
    return {
      wins: 0, losses: 0, stars: 0, lastRaidAt: 0, rebuildUntil: 0, fortify: 0, gen: 0,
      taken: { credits: 0, energy: 0 }, takenAt: 0, hostility: 0
    };
  }

  NPC.ensureWorld = function (state) {
    const recs = state.world.settlements || {};
    const out = {};
    C.settlements.forEach(function (s) {
      const r = recs[s.id] && typeof recs[s.id] === 'object' ? recs[s.id] : {};
      U.fillDefaults(r, blankRecord());
      r.fortify = U.clamp(Math.round(Number(r.fortify) || 0), 0, C.world.maxFortify);
      r.hostility = U.clamp(Math.round(Number(r.hostility) || 0), 0, 3);
      ['wins', 'losses', 'stars', 'gen', 'lastRaidAt', 'rebuildUntil', 'takenAt'].forEach(function (k) {
        r[k] = Math.max(0, Number(r[k]) || 0);
      });
      r.taken.credits = Math.max(0, Number(r.taken.credits) || 0);
      r.taken.energy = Math.max(0, Number(r.taken.energy) || 0);
      out[s.id] = r;
    });
    state.world.settlements = out;
    if (!isFinite(state.world.nextNewsAt)) state.world.nextNewsAt = CS.Clock.now() + 10 * 60000;
  };

  NPC.rec = function (state, id) { return state.world.settlements[id]; };

  NPC.winsInTier = function (state, tier) {
    return C.settlements.filter(function (s) { return s.tier === tier && NPC.rec(state, s.id).wins > 0; }).length;
  };

  NPC.unlockedTier = function (state) {
    let t = 1;
    while (t < C.tiers.length - 1 && NPC.winsInTier(state, t) >= C.world.unlockWins) t++;
    return t;
  };

  NPC.isUnlocked = function (state, s) { return s.tier <= NPC.unlockedTier(state); };

  // ---------------------------------------------------------------- loot
  NPC.maxLoot = function (state, s) {
    const rec = NPC.rec(state, s.id);
    const T = C.tiers[s.tier];
    const rng = new U.Rng(U.hash(s.id + ':loot'));
    const bonus = 1 + rec.fortify * C.world.fortifyLootBonus;
    return {
      credits: Math.round(rng.range(T.loot[0], T.loot[1]) * bonus),
      energy: Math.round(rng.range(T.loot[0], T.loot[1]) * bonus)
    };
  };

  function takenNow(rec, now) {
    const f = Math.max(0, 1 - (now - rec.takenAt) / (C.world.lootRegenMin * 60000));
    return { credits: rec.taken.credits * f, energy: rec.taken.energy * f };
  }

  NPC.loot = function (state, s, now) {
    const max = NPC.maxLoot(state, s);
    const t = takenNow(NPC.rec(state, s.id), now);
    return {
      credits: Math.max(0, Math.floor(max.credits - t.credits)),
      energy: Math.max(0, Math.floor(max.energy - t.energy))
    };
  };

  // ---------------------------------------------------------------- layouts
  const layoutCache = new Map();

  NPC.seed = function (s, rec) { return (U.hash(s.id) ^ Math.imul(rec.gen + 1, 2654435761)) >>> 0; };

  NPC.archetype = function (s, rec) {
    const opts = NPC.faction(s).layouts;
    return opts[(U.hash(s.id) + rec.gen) % opts.length];
  };

  NPC.layout = function (state, s) {
    const rec = NPC.rec(state, s.id);
    const key = s.id + ':' + rec.gen + ':' + rec.fortify;
    let lay = layoutCache.get(key);
    if (!lay) {
      lay = NPC.generate(s.tier, rec.fortify, NPC.seed(s, rec), NPC.archetype(s, rec));
      layoutCache.set(key, lay);
    }
    return lay;
  };

  /*
   * Procedural base generator. Buildings are placed with an occupancy grid so nothing overlaps
   * or leaves the tier's build area; archetypes decide where defenses and walls go:
   *  ring - storages around the core, one wall ring, defenses guarding outside it
   *  fortress - two wall rings with defenses between them
   *  compartments - one wall ring split into four cells by a wall cross
   *  spread - buildings scattered with short walls shielding key defenses
   */
  // `tier` is a tier number or a tier-shaped spec ({core, area, walls, wallLv, b}), as base presets use.
  NPC.generate = function (tier, fortify, seed, arch) {
    const T = typeof tier === 'object' ? tier : C.tiers[tier];
    if (typeof tier === 'object') tier = T.core;
    const rng = new U.Rng(seed);
    const a0 = Math.floor((SZ - T.area) / 2), a1 = a0 + T.area;
    const occ = new Uint8Array(SZ * SZ);       // 0 free, 1 building, 2 wall, 3 trap
    const out = [];
    let nextId = 1;

    function fits(x, y, w, h, pad) {
      if (x < a0 || y < a0 || x + w > a1 || y + h > a1) return false;
      for (let ty = y - pad; ty < y + h + pad; ty++) {
        for (let tx = x - pad; tx < x + w + pad; tx++) {
          if (tx < 0 || ty < 0 || tx >= SZ || ty >= SZ) continue;
          const v = occ[ty * SZ + tx];
          const inside = tx >= x && tx < x + w && ty >= y && ty < y + h;
          if (inside ? v !== 0 : v === 1) return false;
        }
      }
      return true;
    }
    function put(type, level, x, y, rot) {
      const s = Base.size(type, rot);
      const mark = type === 'wall' ? 2 : type === 'mine' ? 3 : 1;
      for (let ty = y; ty < y + s[1]; ty++) for (let tx = x; tx < x + s[0]; tx++) occ[ty * SZ + tx] = mark;
      const b = { id: nextId++, type: type, level: level, x: x, y: y, w: s[0], h: s[1], rot: rot };
      out.push(b);
      return b;
    }
    function placeNear(item, cx, cy, pad, avoid) {
      const rot = C.buildings[item.type].rotatable ? rng.int(0, 1) : 0;
      const s = Base.size(item.type, rot);
      const bx = Math.round(cx - s[0] / 2), by = Math.round(cy - s[1] / 2);
      for (let r = 0; r < SZ; r++) {
        const ring = [];
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
        const off = ring.length ? rng.int(0, ring.length - 1) : 0;
        for (let k = 0; k < ring.length; k++) {
          const d = ring[(k + off) % ring.length];
          const x = bx + d[0], y = by + d[1];
          if (avoid && x < avoid.x1 + 1 && x + s[0] > avoid.x0 - 1 && y < avoid.y1 + 1 && y + s[1] > avoid.y0 - 1) continue;
          if (fits(x, y, s[0], s[1], pad)) return put(item.type, item.level, x, y, rot);
        }
      }
      return null;
    }
    function bbox(list) {
      const r = { x0: SZ, y0: SZ, x1: 0, y1: 0 };
      list.forEach(function (b) {
        if (!b) return;
        r.x0 = Math.min(r.x0, b.x); r.y0 = Math.min(r.y0, b.y);
        r.x1 = Math.max(r.x1, b.x + b.w - 1); r.y1 = Math.max(r.y1, b.y + b.h - 1);
      });
      return r;
    }
    let wallBudget = rng.int(T.walls[0], T.walls[1]) + fortify * 8;
    const wallLv = U.clamp(rng.int(T.wallLv[0], T.wallLv[1]) + (fortify >= 1 ? 1 : 0), 1, Base.maxLevel('wall'));
    // Places walls on the perimeter of a rectangle, leaving evenly spread gaps when short on walls.
    function wallRing(r) {
      const x0 = Math.max(a0, r.x0), y0 = Math.max(a0, r.y0), x1 = Math.min(a1 - 1, r.x1), y1 = Math.min(a1 - 1, r.y1);
      const tiles = [];
      for (let x = x0; x <= x1; x++) tiles.push([x, y0]);
      for (let y = y0 + 1; y <= y1; y++) tiles.push([x1, y]);
      for (let x = x1 - 1; x >= x0; x--) tiles.push([x, y1]);
      for (let y = y1 - 1; y > y0; y--) tiles.push([x0, y]);
      const free = tiles.filter(function (t) { return occ[t[1] * SZ + t[0]] === 0; });
      if (!free.length || wallBudget <= 0) return 0;
      const skip = new Uint8Array(free.length);
      if (wallBudget < free.length * 0.5) {
        // Too few walls for a ring: build a few solid segments instead of scattered stubs.
        skip.fill(1);
        const nSeg = Math.max(1, Math.min(4, Math.floor(wallBudget / 4)));
        const segLen = Math.floor(wallBudget / nSeg);
        const off = rng.int(0, free.length - 1);
        for (let g = 0; g < nSeg; g++) {
          const st = off + Math.floor(g * free.length / nSeg);
          for (let k = 0; k < segLen; k++) skip[(st + k) % free.length] = 0;
        }
      } else if (wallBudget < free.length) {
        const gapsTotal = free.length - wallBudget;
        const nGaps = Math.max(2, Math.min(gapsTotal, Math.round(free.length / 7)));
        const gapLen = Math.ceil(gapsTotal / nGaps);
        const startOff = rng.int(0, free.length - 1);
        for (let g = 0; g < nGaps; g++) {
          const st = startOff + Math.floor(g * free.length / nGaps);
          for (let k = 0; k < gapLen; k++) skip[(st + k) % free.length] = 1;
        }
      }
      let n = 0;
      for (let i = 0; i < free.length && wallBudget > 0; i++) {
        if (skip[i]) continue;
        put('wall', wallLv, free[i][0], free[i][1], 0);
        wallBudget--; n++;
      }
      return n;
    }
    function wallLine(x0, y0, x1, y1) {
      const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
      let x = x0, y = y0, n = 0;
      for (let guard = 0; guard < SZ * 2 && wallBudget > 0; guard++) {
        if (x >= a0 && y >= a0 && x < a1 && y < a1 && occ[y * SZ + x] === 0) { put('wall', wallLv, x, y, 0); wallBudget--; n++; }
        if (x === x1 && y === y1) break;
        x += dx; y += dy;
      }
      return n;
    }

    // Composition for this tier (fortified settlements field higher-level defenses).
    const inner = [], defs = [], outer = [], traps = [];
    Object.keys(T.b).forEach(function (type) {
      const spec = T.b[type];
      const n = rng.int(spec[0], spec[1]);
      const cat = C.buildings[type].category;
      for (let i = 0; i < n; i++) {
        let lv = rng.int(spec[2], spec[3]);
        if (cat === 'defense' || cat === 'trap') lv += fortify;
        const item = { type: type, level: U.clamp(lv, 1, Base.maxLevel(type)) };
        if (cat === 'defense') defs.push(item);
        else if (cat === 'trap') traps.push(item);
        else if (C.buildings[type].stores) inner.push(item);
        else outer.push(item);
      }
    });
    rng.shuffle(defs);
    const coreLv = U.clamp(T.core + (fortify >= 2 ? 1 : 0), 1, Base.maxLevel('core'));
    const mid = SZ / 2;
    const core = put('core', coreLv, mid - 2 + rng.int(-1, 1), mid - 2 + rng.int(-1, 1), 0);
    const ccx = core.x + 2, ccy = core.y + 2;
    let enclosure = null;

    function ringPoint(i, n, radius, phase) {
      const a = phase + i / n * Math.PI * 2;
      return [ccx + Math.cos(a) * radius, ccy + Math.sin(a) * radius];
    }

    if (arch === 'spread') {
      inner.forEach(function (it) { placeNear(it, ccx + rng.range(-6, 6), ccy + rng.range(-6, 6), 1); });
      const phase = rng.range(0, 6.28);
      const placedDefs = defs.map(function (it, i) {
        const p = ringPoint(i, defs.length, rng.range(4, T.area / 2 - 3), phase);
        return placeNear(it, p[0], p[1], 1);
      });
      wallRing({ x0: core.x - 1, y0: core.y - 1, x1: core.x + 4, y1: core.y + 4 });
      placedDefs.forEach(function (d) {
        if (!d || wallBudget <= 0) return;
        // Short L-shaped shield on the side facing away from the core.
        const sx = d.x + d.w / 2 > ccx ? d.x + d.w : d.x - 1;
        const sy = d.y + d.h / 2 > ccy ? d.y + d.h : d.y - 1;
        wallLine(sx, d.y - 1, sx, d.y + d.h);
        wallLine(d.x, sy, d.x + d.w - 1, sy);
      });
    } else if (arch === 'compartments') {
      const cluster = [core];
      const items = inner.concat(defs.slice(0, Math.ceil(defs.length * 0.75)));
      const rest = defs.slice(items.length - inner.length);
      const phase = rng.range(0, 6.28);
      items.forEach(function (it, i) {
        const p = ringPoint(i, items.length, 4.5 + items.length * 0.25, phase);
        cluster.push(placeNear(it, p[0], p[1], 0));
      });
      enclosure = bbox(cluster);
      enclosure = { x0: enclosure.x0 - 1, y0: enclosure.y0 - 1, x1: enclosure.x1 + 1, y1: enclosure.y1 + 1 };
      wallRing(enclosure);
      wallLine(ccx, enclosure.y0 + 1, ccx, core.y - 1);
      wallLine(ccx, core.y + 4, ccx, enclosure.y1 - 1);
      wallLine(enclosure.x0 + 1, ccy, core.x - 1, ccy);
      wallLine(core.x + 4, ccy, enclosure.x1 - 1, ccy);
      const ph2 = rng.range(0, 6.28);
      rest.forEach(function (it, i) {
        const p = ringPoint(i, rest.length, (enclosure.x1 - enclosure.x0) / 2 + 3, ph2);
        placeNear(it, p[0], p[1], 0, enclosure);
      });
    } else if (arch === 'fortress') {
      const cluster = [core];
      inner.forEach(function (it) { cluster.push(placeNear(it, ccx, ccy, 0)); });
      const nIn = Math.floor(defs.length / 2);
      for (let i = 0; i < nIn; i++) cluster.push(placeNear(defs[i], ccx, ccy, 0));
      let r1 = bbox(cluster);
      r1 = { x0: r1.x0 - 1, y0: r1.y0 - 1, x1: r1.x1 + 1, y1: r1.y1 + 1 };
      wallRing(r1);
      const ring2 = [];
      const outerDefs = defs.slice(nIn);
      const phase = rng.range(0, 6.28);
      outerDefs.forEach(function (it, i) {
        const p = ringPoint(i, outerDefs.length, (r1.x1 - r1.x0) / 2 + 3, phase);
        ring2.push(placeNear(it, p[0], p[1], 0, r1));
      });
      const r2b = bbox(ring2.concat([{ x: r1.x0, y: r1.y0, w: r1.x1 - r1.x0 + 1, h: r1.y1 - r1.y0 + 1 }]));
      enclosure = { x0: r2b.x0 - 1, y0: r2b.y0 - 1, x1: r2b.x1 + 1, y1: r2b.y1 + 1 };
      wallRing(enclosure);
    } else { // ring
      const cluster = [core];
      inner.forEach(function (it) { cluster.push(placeNear(it, ccx, ccy, 0)); });
      if (tier >= 2 && defs.length) cluster.push(placeNear(defs.shift(), ccx, ccy, 0));
      enclosure = bbox(cluster);
      enclosure = { x0: enclosure.x0 - 1, y0: enclosure.y0 - 1, x1: enclosure.x1 + 1, y1: enclosure.y1 + 1 };
      wallRing(enclosure);
      const phase = rng.range(0, 6.28);
      defs.forEach(function (it, i) {
        const p = ringPoint(i, defs.length, (enclosure.x1 - enclosure.x0) / 2 + 2.5, phase);
        placeNear(it, p[0], p[1], 0, enclosure);
      });
    }

    // Economy buildings fill the outskirts.
    const phase = rng.range(0, 6.28);
    outer.forEach(function (it, i) {
      const p = ringPoint(i, outer.length, T.area / 2 - 3.5, phase);
      placeNear(it, p[0], p[1], rng.chance(0.5) ? 1 : 0, enclosure);
    });

    // Spend leftover walls as short barricades in front of random defenses.
    const defBuildings = out.filter(function (b) { return C.buildings[b.type].category === 'defense'; });
    let guard = 0;
    while (wallBudget > 3 && defBuildings.length && guard++ < 20) {
      const d = rng.pick(defBuildings);
      const side = rng.int(0, 3);
      if (side === 0) wallLine(d.x - 1, d.y - 1, d.x + d.w, d.y - 1);
      else if (side === 1) wallLine(d.x - 1, d.y + d.h, d.x + d.w, d.y + d.h);
      else if (side === 2) wallLine(d.x - 1, d.y, d.x - 1, d.y + d.h - 1);
      else wallLine(d.x + d.w, d.y, d.x + d.w, d.y + d.h - 1);
    }

    // Hidden traps go on open tiles near the defenses or the core.
    traps.forEach(function (it) {
      const anchor = defBuildings.length ? rng.pick(defBuildings) : core;
      for (let tries = 0; tries < 40; tries++) {
        const x = Math.round(anchor.x + anchor.w / 2 + rng.range(-4, 4)), y = Math.round(anchor.y + anchor.h / 2 + rng.range(-4, 4));
        if (fits(x, y, 1, 1, 0)) { put(it.type, it.level, x, y, 0); break; }
      }
    });
    return out;
  };

  // Buildings ready for a battle, with the settlement's current loot spread over its storages.
  NPC.battleBuildings = function (state, s, now) {
    const lay = NPC.layout(state, s);
    const loot = NPC.loot(state, s, now);
    const list = lay.map(function (b) {
      const o = Object.assign({}, b);
      if (C.buildings[b.type].category === 'trap') o.hidden = true;
      return o;
    });
    ['credits', 'energy'].forEach(function (r) {
      const storages = list.filter(function (b) { return C.buildings[b.type].stores === r || C.buildings[b.type].storesBoth; });
      const gens = list.filter(function (b) { return C.buildings[b.type].produces === r; });
      const core = list.find(function (b) { return b.type === 'core'; });
      let coreShare = 0.2;
      function give(group, share) {
        if (!group.length) { coreShare += share; return; }
        group.forEach(function (b) { b.loot = b.loot || { credits: 0, energy: 0 }; b.loot[r] += loot[r] * share / group.length; });
      }
      give(storages, 0.6);
      give(gens, 0.2);
      core.loot = core.loot || { credits: 0, energy: 0 };
      core.loot[r] += loot[r] * coreShare;
    });
    return list;
  };

  // ---------------------------------------------------------------- difficulty
  function unitPower(type, lv, n) {
    const T = C.troops[type];
    const i = U.clamp(lv, 1, T.hp.length) - 1;
    const dps = T.period ? T.dmg[i] / T.period : T.dmg[i] * 2;
    return Math.sqrt(T.hp[i] * dps) * n;
  }

  NPC.armyPower = function (state) {
    let p = 0;
    Object.keys(state.army.units).forEach(function (t) { p += unitPower(t, CS.Research.level(state, t), state.army.units[t] || 0); });
    const t = CS.Clock.now();
    C.heroOrder.forEach(function (h) { if (CS.Army.heroReady(state, h, t)) p += unitPower(h, CS.Army.heroLevel(state, h), 1); });
    return p;
  };

  NPC.defensePower = function (buildings) {
    let p = 0;
    buildings.forEach(function (b) {
      const def = C.buildings[b.type];
      const L = Base.levelDef(b.type, b.level);
      if (def.category === 'defense') {
        const A = def.attack;
        let dps = A.kind === 'lance' ? L.dmg * 2.5 : L.dmg / A.period;
        if (A.splash) dps *= 2.2;
        if (A.kind === 'frost') dps = 6 + L.slow * 40;
        p += Math.sqrt(L.hp * dps);
      } else if (def.category === 'wall') p += L.hp * 0.01;
      else if (def.category === 'trap') p += L.dmg * 0.25;
    });
    return Math.max(1, p);
  };

  NPC.difficulty = function (state, s) {
    const ratio = NPC.armyPower(state) / NPC.defensePower(NPC.layout(state, s));
    if (ratio >= 2) return { label: 'Easy', cls: 'easy', ratio: ratio };
    if (ratio >= 1.2) return { label: 'Fair', cls: 'fair', ratio: ratio };
    if (ratio >= 0.75) return { label: 'Hard', cls: 'hard', ratio: ratio };
    return { label: 'Deadly', cls: 'deadly', ratio: ratio };
  };

  NPC.defenseSummary = function (state, s) {
    const counts = {};
    NPC.layout(state, s).forEach(function (b) {
      const cat = C.buildings[b.type].category;
      if (cat !== 'defense' && cat !== 'wall') return;
      const c = counts[b.type] || (counts[b.type] = { n: 0, maxLv: 0 });
      c.n++;
      c.maxLv = Math.max(c.maxLv, b.level);
    });
    return counts;
  };

  // ---------------------------------------------------------------- raids on NPCs
  NPC.onRaidResult = function (state, s, res, now) {
    const rec = NPC.rec(state, s.id);
    const before = takenNow(rec, now);
    const max = NPC.maxLoot(state, s);
    rec.taken = {
      credits: Math.min(max.credits, before.credits + res.loot.credits),
      energy: Math.min(max.energy, before.energy + res.loot.energy)
    };
    rec.takenAt = now;
    rec.lastRaidAt = now;
    const tierBefore = NPC.unlockedTier(state);
    const notes = [];
    if (res.victory) {
      rec.wins++;
      rec.stars = Math.max(rec.stars, res.stars);
      rec.rebuildUntil = now + C.world.rebuildMin * 60000;
      if (rec.fortify < C.world.maxFortify) rec.fortify++;
      rec.gen++;
    } else rec.losses++;
    if (res.victory || res.destruction >= 0.1) {
      rec.hostility = Math.min(3, rec.hostility + 1);
      const fac = NPC.faction(s);
      const chance = fac.aggression * (C.attacks.retaliation.base + C.attacks.retaliation.perHostility * rec.hostility);
      const already = state.threat.retaliations.some(function (r) { return r.id === s.id; });
      if (!already && C.attacks.modes[state.settings.raidMode].freq > 0 && Math.random() < chance) {
        const d = C.attacks.retaliation.delayMin;
        state.threat.retaliations.push({ id: s.id, at: now + U.lerp(d[0], d[1], Math.random()) * 60000 });
        notes.push(s.leader + ' of ' + s.name + ' swears revenge. Expect a counterattack soon.');
      }
    }
    const tierAfter = NPC.unlockedTier(state);
    if (tierAfter > tierBefore) notes.push('New territory revealed: tier ' + tierAfter + ' settlements can now be raided.');
    return notes;
  };

  // ---------------------------------------------------------------- NPC raiding armies
  NPC.attackArmy = function (state, attackerId, rng) {
    const s = NPC.def(attackerId);
    const fac = NPC.faction(s);
    const core = Base.coreLevel(state);
    let space = Math.round(C.attacks.armySpaceByCore[core - 1] * (0.85 + 0.3 * rng.next()) * (0.92 + fac.aggression * 0.12));
    if (!(state.stats.defended + state.stats.raided)) space = Math.round(space * 0.7);   // the first raid ever is a gentle introduction
    const allowed = C.troopOrder.filter(function (t) { return CS.Army.unlockLevel(t) <= core; });
    let pool = fac.troops.filter(function (t) { return allowed.indexOf(t) >= 0; });
    if (pool.indexOf('scout') < 0) pool = pool.concat(['scout']);
    if (allowed.indexOf('ranger') >= 0 && pool.indexOf('ranger') < 0) pool.push('ranger');
    const army = {};
    function add(t) { army[t] = (army[t] || 0) + 1; space -= C.troops[t].space; }
    const hasWalls = state.base.buildings.some(function (b) { return b.type === 'wall' && !b.ruined; });
    if (hasWalls && allowed.indexOf('demo') >= 0) { add('demo'); if (space > 20) add('demo'); }
    if (allowed.indexOf('mender') >= 0 && space > 30 && rng.chance(0.5)) add('mender');
    let guard = 200;
    while (space > 0 && guard-- > 0) {
      const t = rng.pick(pool);
      if (C.troops[t].space <= space) add(t);
      else if (space >= 1) add('scout');
    }
    return army;
  };

  NPC.troopLevels = function (state) {
    const lv = C.attacks.troopLevelByCore[Base.coreLevel(state) - 1];
    const out = {};
    C.troopOrder.forEach(function (t) { out[t] = lv; });
    return out;
  };

  // ---------------------------------------------------------------- independent world activity
  function makeNews(state, at) {
    const list = C.settlements;
    const roll = Math.random();
    if (roll < 0.4) {
      const a = list[Math.floor(Math.random() * list.length)];
      const victims = list.filter(function (v) { return v.faction !== a.faction && Math.abs(v.tier - a.tier) <= 1; });
      if (!victims.length) return null;
      const v = victims[Math.floor(Math.random() * victims.length)];
      const rec = NPC.rec(state, v.id);
      const max = NPC.maxLoot(state, v);
      const t = takenNow(rec, at);
      rec.taken = { credits: Math.min(max.credits, t.credits + max.credits * 0.25), energy: Math.min(max.energy, t.energy + max.energy * 0.25) };
      rec.takenAt = at;
      return NPC.faction(a).name + ' from ' + a.name + ' raided ' + v.name + ' and carried off part of its loot.';
    }
    if (roll < 0.62) {
      const cands = list.filter(function (s) { return s.tier >= 2 && NPC.rec(state, s.id).fortify < C.world.maxFortify; });
      if (!cands.length) return null;
      const s = cands[Math.floor(Math.random() * cands.length)];
      const rec = NPC.rec(state, s.id);
      rec.fortify++;
      rec.gen++;
      return s.name + ' strengthened its defenses. Its vaults grew richer too.';
    }
    if (roll < 0.84) {
      const s = list[Math.floor(Math.random() * list.length)];
      const rec = NPC.rec(state, s.id);
      rec.taken = { credits: 0, energy: 0 };
      return 'A merchant caravan restocked ' + s.name + '.';
    }
    const hostile = list.filter(function (s) { return NPC.rec(state, s.id).hostility > 0; });
    if (!hostile.length) return null;
    const s = hostile[Math.floor(Math.random() * hostile.length)];
    const rec = NPC.rec(state, s.id);
    rec.hostility = Math.min(3, rec.hostility + 1);
    return NPC.faction(s).name + ' at ' + s.name + ' are mustering troops. Their hostility toward you grows.';
  }

  NPC.advanceWorld = function (state, t0, t1, report) {
    const W = state.world;
    let shown = 0, guard = 500;
    while (W.nextNewsAt <= t1 && guard-- > 0) {
      const at = W.nextNewsAt;
      const span = C.world.newsEveryMin;
      W.nextNewsAt = at + U.lerp(span[0], span[1], Math.random()) * 60000;
      if (shown >= C.world.maxNewsPerCatchUp) continue;
      const text = makeNews(state, at);
      if (!text) continue;
      shown++;
      CS.Log.add(state, 'world', text, at);
      if (report) report.news.push(text);
    }
  };

  CS.NPC = NPC;
})(window.CS = window.CS || {});
