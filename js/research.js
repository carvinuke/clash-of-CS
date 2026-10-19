/*
 * Research Lab: troop upgrades (Energy) and settlement technologies (Credits).
 * One research runs at a time; completion is timestamp based so it finishes while away.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base;
  const R = {};

  R.lab = function (state) {
    return state.base.buildings.find(function (b) { return b.type === 'lab' && b.level >= 1; }) || null;
  };

  R.labLevel = function (state) {
    const lab = R.lab(state);
    return lab ? lab.level : 0;
  };

  R.level = function (state, key) {
    const v = state.research.levels[key];
    if (C.troops[key]) return v || 1;
    return v || 0;
  };

  R.mult = function (state, techKey) {
    return 1 + R.level(state, techKey) * C.research.techs[techKey].per;
  };

  // Everything the research screen needs to show for one entry.
  R.describe = function (state, key) {
    const isTroop = !!C.troops[key];
    const lv = R.level(state, key);
    const table = isTroop ? C.research.troops[key] : C.research.techs[key];
    const maxLv = isTroop ? table.cost.length + 1 : table.cost.length;
    const idx = isTroop ? lv - 1 : lv;          // index of the next upgrade in the cost table
    const info = {
      key: key, kind: isTroop ? 'troop' : 'tech',
      name: isTroop ? C.troops[key].name : table.name,
      desc: isTroop ? C.troops[key].desc : table.desc,
      level: lv, max: maxLv, maxed: lv >= maxLv,
      res: isTroop ? 'energy' : table.res,
      cost: null, time: 0, locked: null
    };
    if (info.maxed) return info;
    info.cost = table.cost[idx];
    info.time = table.time[idx];
    const needLab = isTroop ? lv : table.lab[idx];
    if (isTroop && CS.Army && !CS.Army.isUnlocked(state, key)) info.locked = 'Unlock in Barracks first';
    else if (R.labLevel(state) < needLab) info.locked = 'Requires Research Lab Lv ' + needLab;
    return info;
  };

  R.list = function (state) {
    const keys = C.troopOrder.concat(Object.keys(C.research.techs));
    return keys.map(function (k) { return R.describe(state, k); });
  };

  R.canStart = function (state, key) {
    const lab = R.lab(state);
    if (!lab) return { ok: false, reason: 'Build a Research Lab first' };
    if (!Base.isFunctional(lab)) return { ok: false, reason: lab.ruined ? 'The Research Lab is in ruins' : 'The Research Lab is being upgraded' };
    if (state.research.active) return { ok: false, reason: 'Research already in progress' };
    const info = R.describe(state, key);
    if (info.maxed) return { ok: false, reason: 'Already at max level' };
    if (info.locked) return { ok: false, reason: info.locked };
    const cost = {}; cost[info.res] = info.cost;
    const afford = CS.Eco.canAfford(state, cost);
    if (!afford.ok) return { ok: false, reason: 'Need ' + U.fmt(afford.short) + ' more ' + CS.Eco.resName(info.res), short: afford };
    return { ok: true, info: info, cost: cost };
  };

  R.start = function (state, key, now) {
    const chk = R.canStart(state, key);
    if (!chk.ok) return chk;
    CS.Eco.spend(state, chk.cost);
    state.research.active = { key: key, start: now, end: now + chk.info.time * 1000, cost: chk.cost };
    CS.Bus.emit('research:started', { key: key });
    return { ok: true };
  };

  R.cancel = function (state) {
    const a = state.research.active;
    if (!a) return;
    Object.keys(a.cost || {}).forEach(function (r) { CS.Eco.add(state, r, Math.floor(a.cost[r] * C.cancelRefund)); });
    state.research.active = null;
  };

  // Called by the time system; completes research whose timer ran out before `t`.
  R.advance = function (state, t, events) {
    const a = state.research.active;
    if (!a || a.end > t) return;
    state.research.levels[a.key] = R.level(state, a.key) + 1;
    state.research.active = null;
    CS.Player.addXp(state, Math.round(Math.sqrt((a.end - a.start) / 1000)) + 3);
    if (events) events.push({ type: 'research', key: a.key, level: state.research.levels[a.key] });
  };

  CS.Research = R;
})(window.CS = window.CS || {});
