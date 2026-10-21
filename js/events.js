/*
 * Limited-time events (Loot Frenzy, Bumper Harvest, War Drills, Raider Horde). Time is cut into
 * fixed windows and each window's event is rolled from the world seed, so the schedule needs no
 * saved state: reloads, offline catch-up and the UI all agree on what runs when.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U;
  const Ev = {};
  const HOUR = 3600000;

  function slotMs() { return C.events.slotHours * HOUR; }

  // The event rolled for window k, or null. {id, def, start, end, key}
  Ev.slot = function (state, k) {
    const E = C.events, rng = new U.Rng(U.hash('event:' + state.world.seed + ':' + k));
    if (!rng.chance(E.chance)) return null;
    const raids = C.attacks.modes[state.settings.raidMode].freq > 0;
    const ids = Object.keys(E.list).filter(function (id) { return raids || !E.list[id].raids; });
    let total = 0;
    ids.forEach(function (id) { total += E.list[id].weight; });
    let r = rng.next() * total, id = ids[ids.length - 1];
    for (let i = 0; i < ids.length; i++) { r -= E.list[ids[i]].weight; if (r <= 0) { id = ids[i]; break; } }
    const def = E.list[id], dur = def.hours * HOUR;
    const start = k * slotMs() + Math.floor(rng.next() * (slotMs() - dur) / 60000) * 60000;
    return { id: id, def: def, start: start, end: start + dur, key: k + ':' + id };
  };

  Ev.at = function (state, t) {
    const e = Ev.slot(state, Math.floor(t / slotMs()));
    return e && t >= e.start && t < e.end ? e : null;
  };

  // Effect multiplier at time t: 'loot', 'production', 'training' or 'raids'.
  Ev.mult = function (state, key, t) {
    const e = Ev.at(state, t);
    return e && e.def[key] || 1;
  };

  // The running event (if any) and the next ones, up to n in all.
  Ev.upcoming = function (state, t, n) {
    const out = [];
    for (let k = Math.floor(t / slotMs()), guard = 0; out.length < n && guard < 60; k++, guard++) {
      const e = Ev.slot(state, k);
      if (e && e.end > t) out.push(e);
    }
    return out;
  };

  // Event starts and ends strictly between t0 and t1, so time advances can split there.
  Ev.marks = function (state, t0, t1) {
    const out = [], ms = slotMs();
    // shortcut: absences longer than 400 windows (100 days) only split the most recent ones
    for (let k = Math.max(Math.floor(t0 / ms), Math.floor(t1 / ms) - 400); k <= Math.floor(t1 / ms); k++) {
      const e = Ev.slot(state, k);
      if (!e) continue;
      if (e.start > t0 && e.start < t1) out.push(e.start);
      if (e.end > t0 && e.end < t1) out.push(e.end);
    }
    return out;
  };

  // First event start or end after t (Infinity if none soon).
  Ev.nextChange = function (state, t) {
    const k0 = Math.floor(t / slotMs());
    for (let k = k0; k < k0 + 8; k++) {
      const e = Ev.slot(state, k);
      if (!e) continue;
      if (e.start > t) return e.start;
      if (e.end > t) return e.end;
    }
    return Infinity;
  };

  CS.Events = Ev;
})(window.CS = window.CS || {});
