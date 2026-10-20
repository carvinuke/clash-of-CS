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
      hp: T.hp[i], dmg: T.dmg[i], cost: T.cost ? T.cost[i] : 0, space: T.space, speed: T.speed, range: T.range,
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
    A.advanceSpells(state, dtSec, events);
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

  // ---------------------------------------------------------------- heroes
  // A hero exists once its building stands; its level is that building's level. state.heroes[h].readyAt
  // is when it has recovered from its last battle (timestamp, so it heals while the game is closed).
  A.heroHome = function (state, h) {
    const type = C.heroes[h].building;
    return state.base.buildings.find(function (b) { return b.type === type && b.level >= 1; }) || null;
  };

  A.heroLevel = function (state, h) {
    const b = A.heroHome(state, h);
    return b ? b.level : 0;
  };

  // {code: 'none'|'upgrading'|'ruined'|'resting'|'ready', left: seconds of rest remaining}
  A.heroStatus = function (state, h, now) {
    const b = A.heroHome(state, h);
    if (!b) return { code: 'none', left: 0 };
    if (b.ruined) return { code: 'ruined', left: 0 };
    if (!Base.isFunctional(b)) return { code: 'upgrading', left: 0 };
    const rec = state.heroes[h];
    const left = rec ? (rec.readyAt - now) / 1000 : 0;
    return left > 0 ? { code: 'resting', left: left } : { code: 'ready', left: 0 };
  };

  A.heroReady = function (state, h, now) { return A.heroStatus(state, h, now).code === 'ready'; };

  A.heroRestSec = function (state, h) {
    const lv = Math.max(1, A.heroLevel(state, h));
    return C.heroes[h].recoverMin[lv - 1] * 60;
  };

  // hp: {hero: fraction of health left} for the heroes that took part in a battle.
  A.heroesRest = function (state, hp, now) {
    Object.keys(hp || {}).forEach(function (h) {
      if (!C.heroes[h]) return;
      const lost = U.clamp(1 - hp[h], 0, 1);
      state.heroes[h] = { readyAt: lost > 0 ? now + lost * A.heroRestSec(state, h) * 1000 : 0 };
    });
  };

  // ---------------------------------------------------------------- spells
  // The Spell Forge brews one spell at a time into state.spells (same shape as the army: units,
  // queue, progress). Its level unlocks spells, sets the slots and is the level of every spell cast.
  A.forge = function (state) {
    return state.base.buildings.find(function (b) { return b.type === 'forge' && b.level >= 1; }) || null;
  };

  A.forgeLevel = function (state) { const f = A.forge(state); return f ? f.level : 0; };

  A.spellCapacity = function (state) { const f = A.forge(state); return f ? Base.levelDef('forge', f.level).capacity : 0; };

  A.spellSpace = function (state) {
    let n = 0;
    Object.keys(state.spells.units).forEach(function (t) { n += (state.spells.units[t] || 0) * C.spells[t].space; });
    state.spells.queue.forEach(function (q) { n += q.count * C.spells[q.type].space; });
    return n;
  };

  A.spellUnlockLevel = function (type) {
    const L = C.buildings.forge.levels;
    for (let i = 0; i < L.length; i++) if (L[i].unlock.indexOf(type) >= 0) return i + 1;
    return 99;
  };

  A.spellCost = function (state, type) {
    const P = C.spells[type];
    return P.cost[U.clamp(A.forgeLevel(state), 1, P.cost.length) - 1];
  };

  A.canBrew = function (state, type) {
    const P = C.spells[type];
    if (!P) return { ok: false, reason: 'Unknown spell' };
    const f = A.forge(state);
    if (!f) return { ok: false, reason: 'Build a Spell Forge first' };
    if (f.level < A.spellUnlockLevel(type)) return { ok: false, reason: 'Unlocks at Spell Forge Lv ' + A.spellUnlockLevel(type) };
    if (A.spellCapacity(state) - A.spellSpace(state) < P.space) return { ok: false, reason: 'The Spell Forge is full' };
    const cost = { energy: A.spellCost(state, type) };
    const af = CS.Eco.canAfford(state, cost);
    if (!af.ok) return { ok: false, reason: 'Need ' + U.fmt(af.short) + ' more Energy', short: af };
    return { ok: true, cost: cost };
  };

  A.brew = function (state, type) {
    const chk = A.canBrew(state, type);
    if (!chk.ok) return chk;
    CS.Eco.spend(state, chk.cost);
    const q = state.spells.queue, last = q[q.length - 1];
    if (last && last.type === type && last.unitCost === chk.cost.energy) last.count++;
    else q.push({ type: type, count: 1, unitCost: chk.cost.energy });
    CS.Bus.emit('train:queued', { type: type, n: 1 });
    return { ok: true };
  };

  A.unbrew = function (state, index) {
    const sp = state.spells, q = sp.queue[index];
    if (!q) return;
    CS.Eco.add(state, 'energy', q.unitCost);
    if (--q.count <= 0) {
      sp.queue.splice(index, 1);
      if (index === 0) sp.progress = 0;
    }
  };

  A.spellsRemaining = function (state) {
    let total = -state.spells.progress;
    state.spells.queue.forEach(function (q) { total += C.spells[q.type].time * q.count; });
    return Math.max(0, total);
  };

  // Brewing pauses while the forge is upgrading or in ruins.
  A.advanceSpells = function (state, dtSec, events) {
    const sp = state.spells;
    if (!sp.queue.length) { sp.progress = 0; return; }
    const f = A.forge(state);
    if (!f || !Base.isFunctional(f)) return;
    sp.progress += dtSec;
    let guard = 1000;
    while (sp.queue.length && guard-- > 0) {
      const head = sp.queue[0], need = C.spells[head.type].time;
      if (sp.progress < need) break;
      sp.progress -= need;
      sp.units[head.type] = (sp.units[head.type] || 0) + 1;
      if (events) events.push({ type: 'brewed', spell: head.type });
      if (--head.count <= 0) sp.queue.shift();
    }
    if (!sp.queue.length) sp.progress = 0;
  };

  CS.Army = A;
})(window.CS = window.CS || {});
