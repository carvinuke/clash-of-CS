/*
 * Army management: troop unlocks, housing capacity and the training queue.
 * Training progress advances with elapsed time, so it keeps going while the game is closed.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base;
  const A = {};

  A.capacity = function (state) {
    let cap = 0;
    state.base.buildings.forEach(function (b) {
      if (b.type === 'garrison' && b.level >= 1) cap += Base.levelDef('garrison', b.level).capacity;
    });
    return cap;
  };

  A.space = function (type) { return C.troops[type].space; };

  A.armySpace = function (state) {
    let n = 0;
    Object.keys(state.army.units).forEach(function (t) { n += (state.army.units[t] || 0) * A.space(t); });
    return n;
  };

  A.queueSpace = function (state) {
    let n = 0;
    state.army.queue.forEach(function (q) { n += q.count * A.space(q.type); });
    return n;
  };

  A.totalUnits = function (state) {
    let n = 0;
    Object.keys(state.army.units).forEach(function (t) { n += state.army.units[t] || 0; });
    return n;
  };

  A.barracksLevel = function (state) {
    let lv = 0;
    state.base.buildings.forEach(function (b) { if (b.type === 'barracks') lv = Math.max(lv, b.level); });
    return lv;
  };

  // Troop type -> barracks level that unlocks it.
  A.unlockLevel = function (type) {
    const L = C.buildings.barracks.levels;
    for (let i = 0; i < L.length; i++) if (L[i].unlock.indexOf(type) >= 0) return i + 1;
    return 99;
  };

  A.isUnlocked = function (state, type) { return A.barracksLevel(state) >= A.unlockLevel(type); };

  A.level = function (state, type) { return CS.Research.level(state, type); };

  A.stats = function (state, type, level) {
    const T = C.troops[type];
    const i = U.clamp(level || A.level(state, type), 1, T.hp.length) - 1;
    return {
      hp: T.hp[i], dmg: T.dmg[i], cost: T.cost[i], space: T.space, speed: T.speed, range: T.range,
      period: T.period, dps: T.period ? T.dmg[i] / T.period : T.dmg[i]
    };
  };

  A.trainSeconds = function (state, type) {
    return C.troops[type].time / CS.Research.mult(state, 'drills');
  };

  A.activeBarracks = function (state) {
    return state.base.buildings.filter(function (b) { return b.type === 'barracks' && Base.isFunctional(b); }).length;
  };

  A.canQueue = function (state, type, n) {
    n = n || 1;
    if (!C.troops[type]) return { ok: false, reason: 'Unknown troop' };
    if (!A.isUnlocked(state, type)) return { ok: false, reason: 'Unlocks at Barracks Lv ' + A.unlockLevel(type) };
    const free = A.capacity(state) - A.armySpace(state) - A.queueSpace(state);
    if (free < A.space(type) * n) return { ok: false, reason: 'Not enough Garrison space' };
    const cost = { energy: A.stats(state, type).cost * n };
    const af = CS.Eco.canAfford(state, cost);
    if (!af.ok) return { ok: false, reason: 'Need ' + U.fmt(af.short) + ' more Energy', short: af };
    return { ok: true, cost: cost };
  };

  A.queueTroop = function (state, type, n) {
    n = n || 1;
    const chk = A.canQueue(state, type, n);
    if (!chk.ok) return chk;
    CS.Eco.spend(state, chk.cost);
    const unitCost = chk.cost.energy / n;
    const last = state.army.queue[state.army.queue.length - 1];
    if (last && last.type === type && last.unitCost === unitCost) last.count += n;
    else state.army.queue.push({ type: type, count: n, unitCost: unitCost });
    CS.Bus.emit('train:queued', { type: type, n: n });
    return { ok: true };
  };

  // Removes one unit from a queue entry and refunds it in full.
  A.dequeue = function (state, index) {
    const q = state.army.queue[index];
    if (!q) return;
    CS.Eco.add(state, 'energy', q.unitCost);
    q.count--;
    if (q.count <= 0) {
      state.army.queue.splice(index, 1);
      if (index === 0) state.army.progress = 0;
    }
  };

  A.advance = function (state, dtSec, events) {
    const army = state.army;
    if (!army.queue.length) { army.progress = 0; return; }
    const barracks = A.activeBarracks(state);
    if (!barracks) return;
    army.progress += dtSec * barracks;
    let guard = 1000;
    while (army.queue.length && guard-- > 0) {
      const head = army.queue[0];
      const need = A.trainSeconds(state, head.type);
      if (army.progress < need) break;
      army.progress -= need;
      army.units[head.type] = (army.units[head.type] || 0) + 1;
      head.count--;
      if (events) events.push({ type: 'trained', troop: head.type });
      if (head.count <= 0) army.queue.shift();
    }
    if (!army.queue.length) army.progress = 0;
  };

  // Seconds until the whole queue is done (for display).
  A.queueRemaining = function (state) {
    const barracks = Math.max(1, A.activeBarracks(state));
    let total = -state.army.progress;
    state.army.queue.forEach(function (q) { total += A.trainSeconds(state, q.type) * q.count; });
    return Math.max(0, total / barracks);
  };

  CS.Army = A;
})(window.CS = window.CS || {});
