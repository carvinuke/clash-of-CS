/*
 * Admin panel cheats. Toggles live in state.cheats and are applied at the start of every time
 * advance (Eco.advance), so they also hold through offline catch-up.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, Base = CS.Base, Eco = CS.Eco;
  const Admin = {};

  Admin.CODE = 'overlord';      // typed into the prompt that 7 quick taps on the Settings footer open
  Admin.RICH = 999999999;

  Admin.apply = function (state, t) {
    const c = state.cheats;
    if (c.rich) Eco.RES.forEach(function (r) { state.res[r] = Math.max(state.res[r], Admin.RICH); });
    if (c.instant) {
      state.base.buildings.forEach(function (b) { if (b.timer) b.timer.end = Math.min(b.timer.end, t); });
      const ra = state.research.active;
      if (ra) ra.end = Math.min(ra.end, t);
      let need = 0;
      state.army.queue.forEach(function (q) { need += CS.Army.trainSeconds(state, q.type) * q.count; });
      state.army.progress = Math.max(state.army.progress, need);
      state.spells.progress = Math.max(state.spells.progress, CS.Army.spellsRemaining(state) + state.spells.progress);
    }
    if (c.heroes) Object.keys(state.heroes).forEach(function (h) { state.heroes[h].readyAt = 0; });
  };

  Admin.set = function (state, key, on) {
    state.cheats[key] = !!on;
    if (key === 'rich' && !on) {
      const cap = Eco.capacity(state);
      Eco.RES.forEach(function (r) { state.res[r] = Math.min(state.res[r], cap[r]); });
    }
  };

  // Every building to its top level, finished and undamaged.
  Admin.maxBase = function (state) {
    state.base.buildings.forEach(function (b) {
      b.level = Base.maxLevel(b.type);
      b.status = 'active'; b.timer = null; b.dmg = 0; b.ruined = false;
    });
  };

  // Fills free housing with an even mix of the troops the Barracks has unlocked. Returns the count added.
  Admin.fillArmy = function (state) {
    const A = CS.Army;
    const types = Object.keys(C.troops).filter(function (t) { return !C.troops[t].hero && A.isUnlocked(state, t); });
    let free = A.capacity(state) - A.armySpace(state) - A.queueSpace(state), added = 0, more = true;
    while (more) {
      more = false;
      types.forEach(function (t) {
        if (A.space(t) > free) return;
        state.army.units[t] = (state.army.units[t] || 0) + 1;
        free -= A.space(t); added++; more = true;
      });
    }
    return added;
  };

  Admin.shield = function (state, now) {
    state.threat.shieldUntil = Math.max(state.threat.shieldUntil, now + 24 * 3600000);
    state.threat.next = null;
  };

  CS.Admin = Admin;
})(window.CS = window.CS || {});
