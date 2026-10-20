/*
 * Trophy leagues, achievements and daily goals. Progress reads the cumulative counters in
 * state.stats (plus a few derived values), so it keeps counting during offline catch-up.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U;

  // ---------------------------------------------------------------- leagues
  const League = {};

  League.index = function (trophies) {
    let i = 0;
    while (i + 1 < C.leagues.length && trophies >= C.leagues[i + 1].min) i++;
    return i;
  };

  League.of = function (state) { return C.leagues[League.index(state.player.renown)]; };

  // Applies a trophy change and pays the one-time reward of every league reached for the first time.
  League.change = function (state, n) {
    const p = state.player, from = League.index(p.renown);
    p.renown = Math.max(0, p.renown + n);
    if (n > 0) state.stats.trophiesWon += n;
    p.bestRenown = Math.max(p.bestRenown, p.renown);
    const to = League.index(p.renown);
    let first = false;
    while (p.bestLeague < to) {
      const L = C.leagues[++p.bestLeague];
      first = true;
      if (L.reward) { CS.Eco.add(state, 'credits', L.reward); CS.Eco.add(state, 'energy', L.reward); }
      CS.Log.add(state, 'victory', 'Promoted to the ' + L.name + ' League for the first time' +
        (L.reward ? ': ' + U.fmt(L.reward) + ' Credits and ' + U.fmt(L.reward) + ' Energy awarded.' : '.'));
    }
    if (to !== from) CS.Bus.emit('league:change', { from: from, to: to, first: first });
  };

  CS.League = League;

  // ---------------------------------------------------------------- shared progress values
  const Goals = {};

  Goals.value = function (state, stat) {
    const s = state.stats;
    if (stat === 'loot') return s.lootCredits + s.lootEnergy;
    if (stat === 'core') return CS.Base.coreLevel(state);
    if (stat === 'bestTrophies') return state.player.bestRenown;
    if (stat === 'bosses') return C.bosses.filter(function (b) { return CS.NPC.rec(state, b.id).claimed; }).length;
    if (stat === 'research') {
      let n = 0;
      Object.keys(state.research.levels).forEach(function (k) { n += state.research.levels[k] - (C.troops[k] ? 1 : 0); });
      return n;
    }
    return s[stat] || 0;
  };

  function pay(state, reward) {
    const got = { credits: 0, energy: 0 };
    ['credits', 'energy'].forEach(function (r) { if (reward[r]) got[r] = CS.Eco.add(state, r, reward[r]); });
    if (reward.xp) CS.Player.addXp(state, reward.xp);
    return got;
  }

  Goals.text = function (def, n) { return def.text.replace('{n}', U.fmt(n)).replace('{s}', n === 1 ? '' : 's'); };

  // ---------------------------------------------------------------- achievements
  Goals.achievement = function (state, a) {
    const claimed = state.achievements[a.id] || 0, v = Goals.value(state, a.stat);
    const done = a.tiers.filter(function (t) { return v >= t; }).length;
    return { claimed: claimed, done: done, value: v, target: a.tiers[Math.min(claimed, a.tiers.length - 1)], ready: done > claimed, maxed: claimed >= a.tiers.length };
  };

  Goals.claimAchievement = function (state, id) {
    const a = C.achievements.find(function (x) { return x.id === id; });
    if (!a) return null;
    const st = Goals.achievement(state, a);
    if (!st.ready) return null;
    const reward = C.achievementRewards[st.claimed];
    state.achievements[id] = st.claimed + 1;
    pay(state, reward);
    return reward;
  };

  // ---------------------------------------------------------------- daily goals
  function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

  // Today's goals, picked afresh (and the old ones dropped) the first time it is read on a new day.
  Goals.daily = function (state, now) {
    const D = state.daily, key = dayKey(now);
    if (D.day === key) return D;
    const core = CS.Base.coreLevel(state);
    const raids = C.attacks.modes[state.settings.raidMode].freq > 0;
    const pool = C.daily.goals.filter(function (g) { return !(g.core > core) && (raids || !g.raids); });
    new U.Rng(U.hash(key + ':' + state.world.seed)).shuffle(pool);
    const reward = C.daily.rewardByCore[core - 1];
    D.day = key;
    D.bonus = 0;
    D.goals = pool.slice(0, C.daily.count).map(function (g) {
      return { id: g.id, n: g.nByCore ? g.nByCore[core - 1] : g.n, base: Goals.value(state, g.stat), reward: reward, claimed: 0 };
    });
    return D;
  };

  Goals.dailyGoal = function (state, g) {
    const def = C.daily.goals.find(function (x) { return x.id === g.id; });
    const v = Math.min(g.n, Math.max(0, Goals.value(state, def.stat) - g.base));
    return { def: def, text: Goals.text(def, g.n), value: v, ready: v >= g.n && !g.claimed };
  };

  Goals.claimDaily = function (state, i, now) {
    const g = Goals.daily(state, now).goals[i];
    if (!g || !Goals.dailyGoal(state, g).ready) return null;
    g.claimed = 1;
    const reward = {};
    reward[Goals.dailyGoal(state, g).def.res] = g.reward;
    pay(state, reward);
    return reward;
  };

  Goals.bonusReady = function (state, now) {
    const D = Goals.daily(state, now);
    return !D.bonus && D.goals.length > 0 && D.goals.every(function (g) { return g.claimed; });
  };

  Goals.claimBonus = function (state, now) {
    if (!Goals.bonusReady(state, now)) return null;
    const D = state.daily, amt = D.goals[0].reward * C.daily.bonusMult;
    D.bonus = 1;
    const reward = { credits: amt, energy: amt };
    pay(state, reward);
    return reward;
  };

  // How many rewards wait to be claimed (the Goals button badge).
  Goals.claimable = function (state, now) {
    let n = 0;
    C.achievements.forEach(function (a) { const s = Goals.achievement(state, a); n += s.done - s.claimed; });
    Goals.daily(state, now).goals.forEach(function (g) { if (Goals.dailyGoal(state, g).ready) n++; });
    if (Goals.bonusReady(state, now)) n++;
    return n;
  };

  // Save repair: keeps known achievements and a well-formed day, otherwise the day is picked again.
  Goals.sanitize = function (state) {
    const a = {};
    C.achievements.forEach(function (x) {
      const v = Math.round(Number(state.achievements[x.id]) || 0);
      if (v > 0) a[x.id] = U.clamp(v, 0, x.tiers.length);
    });
    state.achievements = a;
    const D = state.daily;
    const ok = typeof D.day === 'string' && Array.isArray(D.goals) && D.goals.every(function (g) {
      return g && C.daily.goals.some(function (x) { return x.id === g.id; }) && isFinite(g.n) && g.n > 0 && isFinite(g.base) && isFinite(g.reward);
    });
    if (!ok) { D.day = ''; D.goals = []; }
    D.bonus = D.bonus ? 1 : 0;
  };

  CS.Goals = Goals;
})(window.CS = window.CS || {});
