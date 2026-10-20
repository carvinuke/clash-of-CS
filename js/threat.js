/*
 * NPC raids on the home base: scheduling (protection, shields, minimum spacing, random raids,
 * retaliation), building the defense battle from the live base, and applying its outcome.
 * The same code resolves raids live (rendered) and offline (headless, bounded simulation).
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base, NPC = CS.NPC;
  const T = {};
  const DAY = 86400000;

  T.freq = function (state) { return C.attacks.modes[state.settings.raidMode].freq; };

  T.eligibleFrom = function (state) {
    const th = state.threat;
    return Math.max(th.protectionUntil || 0, th.shieldUntil || 0, (th.lastRaidAt || 0) + C.attacks.minIntervalMin * 60000);
  };

  function pickAttacker(state) {
    const maxTier = NPC.unlockedTier(state);
    const cands = C.settlements.filter(function (s) { return s.tier <= maxTier; });
    let total = 0;
    const w = cands.map(function (s) {
      const v = NPC.faction(s).aggression * (1 + NPC.rec(state, s.id).hostility);
      total += v;
      return v;
    });
    let r = Math.random() * total;
    for (let i = 0; i < cands.length; i++) { r -= w[i]; if (r <= 0) return cands[i]; }
    return cands[cands.length - 1] || null;
  }

  // Plans the next raid if none is planned. Returns the plan (or null when raids are off).
  T.plan = function (state, from) {
    const th = state.threat;
    if (th.next) return th.next;
    const freq = T.freq(state);
    if (freq <= 0) { th.retaliations = []; return null; }
    const elig = Math.max(from, T.eligibleFrom(state));
    let best = null, fromRetaliation = false;
    th.retaliations.sort(function (a, b) { return a.at - b.at; });
    if (th.retaliations.length) {
      best = { at: Math.max(elig, th.retaliations[0].at), attackerId: th.retaliations[0].id, kind: 'retaliation' };
      fromRetaliation = true;
    }
    const firstEver = !(state.stats.defended + state.stats.raided);
    let at;
    if (firstEver) {
      const d = C.attacks.firstRaidDelayMin;
      at = elig + U.lerp(d[0], d[1], Math.random()) * 60000;
    } else {
      const meanMin = 60 / (C.attacks.randomPerHour * freq);
      at = elig - Math.log(1 - Math.random()) * meanMin * 60000;
    }
    if (!best || at < best.at) {
      const a = pickAttacker(state);
      if (a) { best = { at: at, attackerId: a.id, kind: 'random' }; fromRetaliation = false; }
    }
    if (fromRetaliation) th.retaliations.shift();
    if (!best) return null;
    // Respect the daily cap by sliding the raid into the next day.
    const day = Math.floor(best.at / DAY);
    if (th.dayKey === day && th.dayCount >= C.attacks.offline.maxPerDay) best.at = (day + 1) * DAY + Math.random() * 3600000;
    best.announced = false;
    th.next = best;
    return best;
  };

  /*
   * Live scheduler, called about once a second during play.
   * ctx: { busy: bool (player is fighting), onWarning(plan), onLaunch(plan) }
   */
  T.update = function (state, now, ctx) {
    const th = state.threat;
    if (T.freq(state) <= 0) { th.next = null; th.retaliations = []; return null; }
    const n = th.next || T.plan(state, now);
    if (!n) return null;
    if (!n.announced && now >= n.at - C.attacks.warningSec * 1000) {
      n.announced = true;
      if (now > n.at - 10000) n.at = now + 10000;       // always give at least a short warning
      ctx.onWarning(n);
      return n;
    }
    if (now >= n.at) {
      if (ctx.busy) { n.at = now + 20000; return n; }   // the raiders wait for you to come home
      th.next = null;
      ctx.onLaunch(n);
    }
    return n;
  };

  T.cancelPlans = function (state) {
    state.threat.next = null;
    state.threat.retaliations = [];
  };

  // ---------------------------------------------------------------- the defense battle
  T.buildDefense = function (state, plan, now) {
    const s = NPC.def(plan.attackerId);
    const seed = ((now / 1000) ^ U.hash(s.id)) >>> 0;
    const rng = new U.Rng(seed);
    const steal = C.attacks.steal;
    const cap = steal.capByCore[Base.coreLevel(state) - 1];
    const list = [];
    const holders = { credits: [], energy: [] };
    const collectors = { credits: [], energy: [] };
    state.base.buildings.forEach(function (b) {
      if (b.ruined) return;
      const def = C.buildings[b.type];
      const sz = Base.size(b.type, b.rot);
      const maxHp = Base.maxHp(state, b);
      const o = {
        id: b.id, type: b.type, level: Math.max(1, b.level), x: b.x, y: b.y, w: sz[0], h: sz[1], rot: b.rot,
        hp: Math.max(1, maxHp - (b.dmg || 0)), func: Base.isFunctional(b), loot: null
      };
      if (def.produces && b.stored >= 1) collectors[def.produces].push({ o: o, amt: b.stored });
      if ((def.stores || def.storesBoth || b.type === 'core') && b.level >= 1) {
        if (!def.stores) { holders.credits.push(o); holders.energy.push(o); }
        else holders[def.stores].push(o);
      }
      list.push(o);
    });
    ['credits', 'energy'].forEach(function (r) {
      const pool = Math.min(cap, state.res[r] * steal.storageFraction);
      const weights = holders[r].map(function (o) {
        const L = Base.levelDef(o.type, o.level);
        return L.capacity || L.store;
      });
      const wsum = weights.reduce(function (a, b) { return a + b; }, 0);
      holders[r].forEach(function (o, i) {
        o.loot = o.loot || { credits: 0, energy: 0 };
        o.loot[r] += wsum ? pool * weights[i] / wsum : 0;
      });
      let ctot = 0;
      collectors[r].forEach(function (c) { ctot += c.amt * steal.collectorFraction; });
      const cscale = ctot > cap * 0.5 ? cap * 0.5 / ctot : 1;
      collectors[r].forEach(function (c) {
        c.o.loot = c.o.loot || { credits: 0, energy: 0 };
        c.o.loot[r] += c.amt * steal.collectorFraction * cscale;
      });
    });
    const army = NPC.attackArmy(state, s.id, rng);
    // rested heroes stand guard on their platforms
    const guards = [];
    C.heroOrder.forEach(function (h) {
      if (!CS.Army.heroReady(state, h, now)) return;
      const home = CS.Army.heroHome(state, h), sz = Base.size(home.type, home.rot);
      guards.push({ type: h, lv: home.level, x: home.x + sz[0] / 2, y: home.y + sz[1] / 2 });
    });
    const battle = CS.Battle.create({
      kind: 'defense', seed: seed, biome: 'home', name: s.name, attackerId: s.id,
      buildings: list, troops: {}, troopLevels: NPC.troopLevels(state),
      timeLimit: C.battle.defenseSeconds, maxDestruction: C.attacks.maxDestruction, guards: guards,
      defHpMult: CS.Research.mult(state, 'plating'), defDmgMult: CS.Research.mult(state, 'targeting'),
      meta: { raidKind: plan.kind, army: army }
    });
    CS.Battle.planAI(battle, army, 1.5);
    return battle;
  };

  function sum(o) { let n = 0; Object.keys(o).forEach(function (k) { n += o[k]; }); return n; }

  // Writes a finished defense back into the home base and returns a combat report.
  T.applyDefense = function (state, battle, now) {
    const res = CS.Battle.result(battle);
    const s = NPC.def(battle.attackerId);
    const stolen = { credits: 0, energy: 0 };
    const destroyed = [];
    battle.buildings.forEach(function (bb) {
      const b = Base.find(state, bb.id);
      if (!b) return;
      const def = C.buildings[b.type];
      if (def.category !== 'trap') {
        const maxHp = Base.maxHp(state, b);
        if (bb.dead) {
          b.ruined = true;
          b.dmg = maxHp;
          destroyed.push(b.type);
        } else b.dmg = Math.max(0, Math.round(maxHp * (1 - bb.hp / bb.maxHp)));
      }
      if (!bb.loot) return;
      ['credits', 'energy'].forEach(function (r) {
        const took = bb.loot[r] - bb.lootLeft[r];
        if (!(took > 0)) return;
        if (def.produces === r) {
          const t = Math.min(b.stored, took);
          b.stored -= t;
          stolen[r] += t;
        } else {
          const t = Math.min(state.res[r], took);
          state.res[r] -= t;
          stolen[r] += t;
        }
      });
    });
    stolen.credits = Math.floor(stolen.credits);
    stolen.energy = Math.floor(stolen.energy);
    const defended = !res.victory;
    const th = state.threat;
    th.lastRaidAt = now;
    th.shieldUntil = now + (defended ? C.attacks.shieldMin.defended : C.attacks.shieldMin.raided) * 60000;
    const day = Math.floor(now / DAY);
    if (th.dayKey !== day) { th.dayKey = day; th.dayCount = 0; }
    th.dayCount++;
    const rec = NPC.rec(state, s.id);
    rec.hostility = Math.max(0, rec.hostility - 1);
    const renown = defended ? 5 : -(3 + res.stars * 3);
    CS.Player.addRenown(state, renown);
    if (defended) state.stats.defended++; else state.stats.raided++;
    state.stats.stolen += stolen.credits + stolen.energy;
    const heroHp = {};
    res.guards.forEach(function (g) { heroHp[g.type] = g.hp; });
    CS.Army.heroesRest(state, heroHp, now);
    let top = null;
    Object.keys(res.dmg).forEach(function (k) { if (!top || res.dmg[k] > top.dmg) top = { type: k, dmg: Math.round(res.dmg[k]) }; });
    const report = {
      attacker: s.name, attackerId: s.id, leader: s.leader, faction: NPC.faction(s).name,
      raidKind: battle.meta.raidKind, defended: defended, stars: res.stars,
      destruction: res.destruction, stolen: stolen, destroyed: destroyed,
      raiders: sum(res.deployed), killed: sum(res.lost), top: top, renown: renown,
      reason: res.reason, at: now, heroes: res.guards
    };
    const pct = U.pct(res.destruction);
    CS.Log.add(state, defended ? 'defense' : 'raid', defended
      ? 'You repelled a raid by ' + s.name + ' (' + pct + '% damage). ' + report.killed + ' raiders fell.'
      : s.name + ' raided your base: ' + pct + '% destroyed, ' + U.fmt(stolen.credits) + ' Credits and ' + U.fmt(stolen.energy) + ' Energy stolen.', now);
    return report;
  };

  T.resolveOffline = function (state, plan, at) {
    const battle = T.buildDefense(state, plan, at);
    CS.Battle.runToEnd(battle);
    const report = T.applyDefense(state, battle, at);
    report.offline = true;
    return report;
  };

  CS.Threat = T;
})(window.CS = window.CS || {});
