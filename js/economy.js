/*
 * Economy: resources, storage caps, generators, construction, upgrades, repairs and the
 * time-advance function that drives every timer in the home base from timestamps.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base;
  const Eco = {};
  const RES = ['credits', 'energy'];

  Eco.RES = RES;
  Eco.resName = function (r) { return r === 'credits' ? 'Credits' : 'Energy'; };

  Eco.capacity = function (state) {
    const cap = { credits: 0, energy: 0 };
    state.base.buildings.forEach(function (b) {
      if (b.level < 1 || b.ruined && b.type !== 'core') return;
      const def = C.buildings[b.type];
      const L = Base.levelDef(b.type, b.level);
      if (b.type === 'core' || def.storesBoth) { cap.credits += L.store; cap.energy += L.store; }
      else if (def.stores) cap[def.stores] += L.capacity;
    });
    const m = CS.Research.mult(state, 'compression');
    cap.credits = Math.floor(cap.credits * m);
    cap.energy = Math.floor(cap.energy * m);
    return cap;
  };

  // Adds resources up to the storage cap. Returns the amount actually stored.
  Eco.add = function (state, res, amount) {
    if (!(amount > 0)) return 0;
    const cap = Eco.capacity(state)[res];
    const before = state.res[res];
    state.res[res] = Math.max(before, Math.min(cap, before + amount));
    return state.res[res] - before;
  };

  // cost = {credits: n} and/or {energy: n}. `short` is the missing amount of the first lacking resource.
  Eco.canAfford = function (state, cost) {
    for (let i = 0; i < RES.length; i++) {
      const r = RES[i];
      if (cost[r] && state.res[r] < cost[r]) return { ok: false, res: r, short: Math.ceil(cost[r] - state.res[r]) };
    }
    return { ok: true };
  };

  Eco.spend = function (state, cost) {
    RES.forEach(function (r) { if (cost[r]) state.res[r] = Math.max(0, state.res[r] - cost[r]); });
  };

  Eco.costText = function (cost) {
    return RES.filter(function (r) { return cost[r]; }).map(function (r) { return U.fmt(cost[r]) + ' ' + Eco.resName(r); }).join(' + ');
  };

  Eco.production = function (state) {
    const p = { credits: 0, energy: 0 };
    const m = CS.Research.mult(state, 'extraction') * CS.Events.mult(state, 'production', CS.Clock.now());
    state.base.buildings.forEach(function (b) {
      const def = C.buildings[b.type];
      if (def.produces && Base.isFunctional(b)) p[def.produces] += Base.levelDef(b.type, b.level).rate * m;
    });
    return p;
  };

  Eco.collect = function (state, b) {
    const def = C.buildings[b.type];
    if (!def.produces || b.stored < 1) return 0;
    const got = Eco.add(state, def.produces, Math.floor(b.stored));
    b.stored -= got;
    state.stats.collected += got;
    if (got > 0) CS.Bus.emit('collected', { id: b.id, res: def.produces, amount: got });
    return got;
  };

  Eco.collectAll = function (state) {
    const total = { credits: 0, energy: 0 };
    state.base.buildings.forEach(function (b) {
      const def = C.buildings[b.type];
      if (def.produces) total[def.produces] += Eco.collect(state, b);
    });
    return total;
  };

  // True when a generator holds enough to be worth collecting (the bubble over it, the Collect badge).
  Eco.ready = function (b) {
    const def = C.buildings[b.type];
    return !!def.produces && Base.isFunctional(b) && b.stored >= Math.max(5, Base.levelDef(b.type, b.level).buffer * 0.02);
  };

  Eco.engineers = function (state) {
    let total = 0, busy = 0;
    state.base.buildings.forEach(function (b) {
      if (b.type === 'station') total++;
      if (b.timer) busy++;
    });
    return { total: total, busy: busy, free: Math.max(0, total - busy) };
  };

  Eco.buildCost = function (state, type) {
    const def = C.buildings[type];
    const cost = {};
    if (def.buildCostByCount) cost[def.res] = def.buildCostByCount[Math.min(Base.count(state, type), def.buildCostByCount.length - 1)];
    else cost[def.res] = def.levels[0].cost;
    return cost;
  };

  Eco.isInstant = function (type, level) {
    const def = C.buildings[type];
    if (type === 'station' && level === 1) return true;
    return !!def.instant || Base.levelDef(type, level).time === 0;
  };

  Eco.canBuild = function (state, type) {
    const def = C.buildings[type];
    const core = Base.coreLevel(state);
    const max = Base.maxCount(type, core);
    const count = Base.count(state, type);
    const cost = Eco.buildCost(state, type);
    const out = { ok: false, cost: cost, count: count, max: max };
    if (max === 0) { out.reason = 'Unlocks at Command Core Lv ' + Base.unlockCore(type); out.locked = true; return out; }
    if (count >= max) { out.reason = 'Limit reached. Upgrade the Command Core to build more'; out.maxed = true; return out; }
    if (def.levels[0].core > core) { out.reason = 'Requires Command Core Lv ' + def.levels[0].core; out.locked = true; return out; }
    if (!Eco.isInstant(type, 1) && Eco.engineers(state).free === 0) { out.reason = 'All Engineers are busy'; return out; }
    const af = Eco.canAfford(state, cost);
    if (!af.ok) { out.reason = 'Need ' + U.fmt(af.short) + ' more ' + Eco.resName(af.res); out.short = af; return out; }
    out.ok = true;
    return out;
  };

  Eco.place = function (state, type, x, y, rot, now) {
    const chk = Eco.canBuild(state, type);
    if (!chk.ok) return chk;
    const pl = Base.canPlaceAt(state, type, x, y, rot);
    if (!pl.ok) return pl;
    Eco.spend(state, chk.cost);
    const instant = Eco.isInstant(type, 1);
    const def = C.buildings[type];
    const b = Base.newBuilding(state, type, x, y, def.rotatable || def.size[0] === def.size[1] ? rot : 0, instant ? 1 : 0, instant ? 'active' : 'building');
    if (instant) CS.Player.addXp(state, 1);
    else b.timer = { start: now, end: now + def.levels[0].time * 1000, to: 1, cost: chk.cost };
    if (def.produces) b.prodAt = now;
    if (type !== 'wall') state.stats.builds++;
    CS.Bus.emit('build:placed', { type: type, id: b.id });
    return { ok: true, b: b };
  };

  Eco.upgradeInfo = function (state, b) {
    const def = C.buildings[b.type];
    const info = { maxed: b.level >= def.levels.length, next: b.level + 1, ok: false };
    if (info.maxed) { info.reason = 'Max level reached'; return info; }
    if (b.level < 1) { info.reason = 'Still under construction'; return info; }
    const L = def.levels[b.level];
    info.cost = {}; info.cost[def.res] = L.cost;
    info.time = L.time;
    info.reqCore = L.core;
    const instant = Eco.isInstant(b.type, b.level + 1);
    if (b.status !== 'active') info.reason = 'Already being upgraded';
    else if (b.ruined) info.reason = 'Repair it first';
    else if (b.type !== 'core' && L.core > Base.coreLevel(state)) { info.reason = 'Requires Command Core Lv ' + L.core; info.locked = true; }
    else if (b.type === 'lab' && state.research.active) info.reason = 'Finish the current research first';
    else if (!instant && Eco.engineers(state).free === 0) info.reason = 'All Engineers are busy';
    else {
      const af = Eco.canAfford(state, info.cost);
      if (!af.ok) { info.reason = 'Need ' + U.fmt(af.short) + ' more ' + Eco.resName(af.res); info.short = af; }
    }
    info.ok = !info.reason;
    return info;
  };

  Eco.startUpgrade = function (state, b, now) {
    const info = Eco.upgradeInfo(state, b);
    if (!info.ok) return info;
    Eco.spend(state, info.cost);
    if (info.time === 0) {
      b.level++;
      b.dmg = 0;
      CS.Player.addXp(state, 1);
    } else {
      b.status = 'upgrading';
      b.timer = { start: now, end: now + info.time * 1000, to: b.level + 1, cost: info.cost };
    }
    if (b.type !== 'wall') state.stats.builds++;
    CS.Bus.emit('build:upgrade', { id: b.id, type: b.type });
    return { ok: true };
  };

  // Walls are numerous, so they can be upgraded in bulk: every affordable wall of one level.
  Eco.wallBatch = function (state, level) {
    const walls = state.base.buildings.filter(function (b) { return b.type === 'wall' && b.level === level && !b.ruined; });
    const L = C.buildings.wall.levels[level];
    if (!L) return { walls: walls, n: 0, cost: 0, reason: 'Max level reached' };
    if (L.core > Base.coreLevel(state)) return { walls: walls, n: 0, cost: L.cost, reason: 'Requires Command Core Lv ' + L.core };
    const n = Math.min(walls.length, Math.floor(state.res.credits / L.cost));
    return { walls: walls, n: n, cost: L.cost, reason: n ? null : 'Need ' + U.fmt(L.cost - state.res.credits) + ' more Credits' };
  };

  Eco.upgradeWalls = function (state, level) {
    const batch = Eco.wallBatch(state, level);
    for (let i = 0; i < batch.n; i++) {
      batch.walls[i].level++;
      batch.walls[i].dmg = 0;
    }
    if (batch.n) {
      state.res.credits -= batch.n * batch.cost;
      CS.Player.addXp(state, batch.n);
      CS.Bus.emit('build:upgrade', { type: 'wall', n: batch.n });
    }
    return batch.n;
  };

  Eco.cancel = function (state, b) {
    if (!b.timer) return;
    const cost = b.timer.cost || {};
    RES.forEach(function (r) { if (cost[r]) Eco.add(state, r, Math.floor(cost[r] * C.cancelRefund)); });
    if (b.status === 'building') {
      state.base.buildings = state.base.buildings.filter(function (o) { return o !== b; });
    } else {
      b.status = 'active';
      b.timer = null;
    }
  };

  Eco.missingHp = function (state, b) {
    return b.ruined ? Base.maxHp(state, b) : Math.min(Base.maxHp(state, b), b.dmg || 0);
  };

  Eco.repairCost = function (state, b) {
    const m = Eco.missingHp(state, b);
    if (m <= 0) return null;
    return { credits: Math.max(C.repair.minCost, Math.ceil(m * C.repair.creditsPerHp)) };
  };

  Eco.repairNow = function (state, b) {
    const cost = Eco.repairCost(state, b);
    if (!cost) return { ok: false, reason: 'Nothing to repair' };
    const af = Eco.canAfford(state, cost);
    if (!af.ok) return { ok: false, reason: 'Need ' + U.fmt(af.short) + ' more Credits' };
    Eco.spend(state, cost);
    b.dmg = 0;
    b.ruined = false;
    CS.Bus.emit('repaired', { id: b.id });
    return { ok: true };
  };

  Eco.repairAllCost = function (state) {
    let total = 0;
    state.base.buildings.forEach(function (b) { const c = Eco.repairCost(state, b); if (c) total += c.credits; });
    return total;
  };

  Eco.move = function (state, b, x, y, rot) {
    const chk = Base.canPlaceAt(state, b.type, x, y, rot, b.id);
    if (!chk.ok) return chk;
    b.x = x; b.y = y; b.rot = rot ? 1 : 0;
    return { ok: true };
  };

  Eco.repairRate = function (state) {
    let rate = 0;
    state.base.buildings.forEach(function (b) {
      if (b.type === 'station' && b.level >= 1 && !b.ruined) rate += Base.levelDef('station', b.level).repair;
    });
    return rate;
  };

  // ---------------------------------------------------------------- time advance
  const REPAIR_ORDER = { core: 0, defense: 1, trap: 1, economy: 2, army: 3, wall: 4 };

  function produce(state, dt, scale, report) {
    const m = CS.Research.mult(state, 'extraction');
    state.base.buildings.forEach(function (b) {
      const def = C.buildings[b.type];
      if (!def.produces || !Base.isFunctional(b)) return;
      const L = Base.levelDef(b.type, b.level);
      const before = b.stored;
      b.stored = Math.min(L.buffer, b.stored + L.rate / 60 * dt * m * scale);
      if (report) report.produced[def.produces] += b.stored - before;
    });
  }

  function repair(state, dt, events) {
    let pool = Eco.repairRate(state) * dt;
    if (pool <= 0) return;
    const damaged = state.base.buildings.filter(function (b) { return b.ruined || b.dmg > 0; });
    if (!damaged.length) return;
    damaged.sort(function (a, b) {
      return (a.ruined ? 0 : 10) + REPAIR_ORDER[C.buildings[a.type].category] - ((b.ruined ? 0 : 10) + REPAIR_ORDER[C.buildings[b.type].category]);
    });
    for (let i = 0; i < damaged.length && pool > 0; i++) {
      const b = damaged[i];
      if (b.ruined && !(b.dmg > 0)) b.dmg = Base.maxHp(state, b);
      const use = Math.min(pool, b.dmg);
      b.dmg -= use;
      pool -= use;
      if (b.dmg <= 0.01) {
        b.dmg = 0;
        if (b.ruined) {
          b.ruined = false;
          if (events) events.push({ type: 'repaired', id: b.id, btype: b.type });
        }
      }
    }
  }

  function completeTimers(state, t, events) {
    state.base.buildings.forEach(function (b) {
      if (!b.timer || b.timer.end > t) return;
      const wasNew = b.status === 'building';
      const secs = (b.timer.end - b.timer.start) / 1000;
      b.level = b.timer.to;
      b.status = 'active';
      b.timer = null;
      if (!b.ruined) b.dmg = 0;
      CS.Player.addXp(state, Math.round(Math.sqrt(secs)) + 1);
      if (events) events.push({ type: wasNew ? 'built' : 'upgraded', id: b.id, btype: b.type, level: b.level });
    });
  }

  /*
   * Advances every home-base system from t0 to t1 (ms timestamps). The interval is split at
   * each timer completion so, for example, a generator finished mid-absence only produces
   * after it was finished, and at each event start and end so an event's speed-ups cover exactly
   * its window. opts.prodScale shrinks production for capped offline absences.
   */
  Eco.advance = function (state, t0, t1, opts) {
    opts = opts || {};
    const events = opts.events || [];
    if (!(t1 > t0)) return events;
    if (CS.Admin) CS.Admin.apply(state, t0);
    const scale = opts.prodScale == null ? 1 : opts.prodScale;
    const marks = [];
    state.base.buildings.forEach(function (b) { if (b.timer && b.timer.end > t0 && b.timer.end < t1) marks.push(b.timer.end); });
    const ra = state.research.active;
    if (ra && ra.end > t0 && ra.end < t1) marks.push(ra.end);
    Array.prototype.push.apply(marks, CS.Events.marks(state, t0, t1));
    marks.sort(function (a, b) { return a - b; });
    marks.push(t1);
    completeTimers(state, t0, events);
    CS.Research.advance(state, t0, events);
    // Long gaps run in sub-steps so a building repaired mid-gap produces for the rest of it.
    const step = Math.max(C.offline.catchUpStepSec, (t1 - t0) / 1000 / 1500);
    let t = t0;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const prodX = CS.Events.mult(state, 'production', t), trainX = CS.Events.mult(state, 'training', t);
      while (t < m) {
        const left = (m - t) / 1000;
        const dt = left > step ? step : left;
        produce(state, dt * prodX, scale, opts.report);
        CS.Army.advance(state, dt * trainX, events);
        repair(state, dt, events);
        t = left > step ? t + step * 1000 : m;
      }
      completeTimers(state, t, events);
      CS.Research.advance(state, t, events);
    }
    return events;
  };

  CS.Eco = Eco;

  // ---------------------------------------------------------------- player progression
  CS.Player = {
    addXp: function (state, n) {
      const p = state.player;
      p.xp += n;
      let guard = 100;
      while (p.xp >= C.player.xpForLevel(p.level) && guard-- > 0) {
        p.xp -= C.player.xpForLevel(p.level);
        p.level++;
        CS.Bus.emit('player:level', { level: p.level });
      }
    },
    addRenown: function (state, n) { CS.League.change(state, n); }
  };
})(window.CS = window.CS || {});
