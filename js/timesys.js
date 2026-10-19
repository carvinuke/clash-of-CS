/*
 * Time system: advances the world between two timestamps. Live play calls it with small gaps;
 * returning after the tab was hidden or the browser was closed calls it with the whole absence,
 * resolving raids that came due in chronological order between production segments. Work is
 * bounded (capped production time, capped raid count, bounded battle ticks) so even a return
 * after weeks finishes instantly.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, Eco = CS.Eco, NPC = CS.NPC, Threat = CS.Threat;
  const Time = {};

  function newReport(t0, t1) {
    return {
      from: t0, to: t1, seconds: (t1 - t0) / 1000,
      produced: { credits: 0, energy: 0 }, events: [], raids: [], news: [],
      built: [], upgraded: [], trained: {}, research: [], repaired: 0, capped: false
    };
  }

  function summarize(report) {
    report.events.forEach(function (e) {
      if (e.type === 'built') report.built.push(e);
      else if (e.type === 'upgraded') report.upgraded.push(e);
      else if (e.type === 'trained') report.trained[e.troop] = (report.trained[e.troop] || 0) + 1;
      else if (e.type === 'research') report.research.push(e);
      else if (e.type === 'repaired') report.repaired++;
    });
    report.produced.credits = Math.floor(report.produced.credits);
    report.produced.energy = Math.floor(report.produced.energy);
  }

  // Advances `state` from state.lastTick to t1. opts.allowRaids enables offline raid resolution.
  Time.catchUp = function (state, t1, opts) {
    opts = opts || {};
    const t0 = state.lastTick;
    const report = newReport(t0, t1);
    if (!(t1 > t0)) { state.lastTick = Math.min(t0, t1); return report; }
    const absence = (t1 - t0) / 1000;
    const maxSec = C.offline.maxProductionHours * 3600;
    const prodScale = Math.min(1, maxSec / absence);
    report.capped = prodScale < 1;
    const eopts = { prodScale: prodScale, report: report, events: report.events };
    let cursor = t0;
    if (opts.allowRaids && absence >= C.attacks.offline.minAbsenceSec && Threat.freq(state) > 0) {
      let count = 0;
      while (count < C.attacks.offline.maxPerAbsence) {
        const plan = Threat.plan(state, cursor);
        if (!plan || plan.at > t1) break;
        const at = Math.max(cursor, plan.at);
        Eco.advance(state, cursor, at, eopts);
        NPC.advanceWorld(state, cursor, at, report);
        state.threat.next = null;
        report.raids.push(Threat.resolveOffline(state, plan, at));
        cursor = at;
        count++;
      }
      const pending = state.threat.next;
      if (count >= C.attacks.offline.maxPerAbsence && pending && pending.at <= t1) {
        // Enough raids for one absence: give the returning player breathing room instead.
        state.threat.next = null;
        state.threat.shieldUntil = Math.max(state.threat.shieldUntil, t1 + 5 * 60000);
      }
    }
    Eco.advance(state, cursor, t1, eopts);
    NPC.advanceWorld(state, cursor, t1, report);
    state.lastTick = t1;
    summarize(report);
    return report;
  };

  // Small live step. Returns the list of timer events (buildings finished, troops trained...).
  Time.step = function (state, now) {
    const t0 = state.lastTick;
    if (now <= t0) { state.lastTick = Math.min(t0, now); return []; }
    const events = Eco.advance(state, t0, now);
    NPC.advanceWorld(state, t0, now, null);
    state.lastTick = now;
    return events;
  };

  Time.isNotable = function (report) {
    return report.raids.length || report.built.length || report.upgraded.length || report.research.length ||
      Object.keys(report.trained).length || report.produced.credits + report.produced.energy >= 50 || report.news.length;
  };

  CS.Time = Time;
})(window.CS = window.CS || {});
