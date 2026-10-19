/*
 * Game state: creating a new game, versioned save/load to localStorage, validation and
 * recovery of damaged saves, and the event log.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base;
  const State = {};

  const STARTER_LAYOUT = [
    ['core', 20, 20], ['mint', 15, 21], ['well', 26, 21], ['garrison', 20, 14],
    ['barracks', 20, 26], ['station', 15, 16], ['station', 27, 16], ['vault', 16, 26], ['tank', 25, 26]
  ];

  function blankState(now) {
    return {
      version: C.saveVersion,
      createdAt: now,
      lastTick: now,
      savedAt: 0,
      player: { level: 1, xp: 0, renown: 0 },
      res: { credits: C.start.credits, energy: C.start.energy },
      base: { buildings: [], nextId: 1 },
      army: { units: {}, queue: [], progress: 0 },
      research: { levels: {}, active: null },
      world: { settlements: {}, nextNewsAt: now + 10 * 60000, seed: (now % 100000) + 7 },
      threat: {
        protectionUntil: now + C.attacks.protectionMin * 60000,
        shieldUntil: 0, lastRaidAt: 0, next: null, retaliations: [],
        dayKey: 0, dayCount: 0
      },
      stats: { raidsWon: 0, raidsLost: 0, defended: 0, raided: 0, lootCredits: 0, lootEnergy: 0, stolen: 0 },
      log: [],
      tutorial: { step: 0, done: false },
      settings: { sfx: true, music: true, volume: 0.7, raidMode: 'normal', showGrid: true },
      battle: null
    };
  }

  State.newGame = function (now) {
    const s = blankState(now);
    STARTER_LAYOUT.forEach(function (e) {
      const b = Base.newBuilding(s, e[0], e[1], e[2], 0, 1, 'active');
      if (C.buildings[e[0]].produces) b.stored = 120;
    });
    Object.keys(C.start.troops).forEach(function (t) { s.army.units[t] = C.start.troops[t]; });
    CS.NPC.ensureWorld(s);
    CS.Log.add(s, 'info', 'Your settlement was founded. A protective shield keeps raiders away for ' + C.attacks.protectionMin + ' minutes.');
    return s;
  };

  // ---------------------------------------------------------------- validation & recovery
  const MIGRATIONS = {
    // 0: function (s) { ...; s.version = 1; return s; }
  };

  function num(v, def, min, max) {
    v = Number(v);
    if (!isFinite(v)) v = def;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  }

  // Repairs anything structurally wrong so a damaged save still produces a playable game.
  State.sanitize = function (raw, now) {
    if (!raw || typeof raw !== 'object' || !raw.base || !Array.isArray(raw.base.buildings)) throw new Error('Save has no base');
    let s = raw;
    let guard = 20;
    while ((s.version || 0) < C.saveVersion && guard-- > 0) {
      const m = MIGRATIONS[s.version || 0];
      if (!m) break;
      s = m(s);
    }
    const fresh = blankState(now);
    U.fillDefaults(s, fresh);
    s.version = C.saveVersion;
    ['credits', 'energy'].forEach(function (r) { s.res[r] = num(s.res[r], 0, 0, 1e12); });
    s.player.level = num(s.player.level, 1, 1, 999);
    s.player.xp = num(s.player.xp, 0, 0);
    s.player.renown = num(s.player.renown, 0, 0);
    s.lastTick = num(s.lastTick, now, 0);
    if (s.lastTick > now) s.lastTick = now;      // clock moved backwards: never run time in reverse

    // Buildings: drop unknown types, clamp fields, resolve overlaps.
    const S = C.grid.size;
    const seen = {};
    let maxId = 0;
    const kept = [];
    s.base.buildings.forEach(function (b) {
      if (!b || !C.buildings[b.type]) return;
      const def = C.buildings[b.type];
      b.level = Math.round(num(b.level, 1, 0, def.levels.length));
      b.rot = b.rot ? 1 : 0;
      b.x = Math.round(num(b.x, 0, 0, S - 1));
      b.y = Math.round(num(b.y, 0, 0, S - 1));
      b.dmg = num(b.dmg, 0, 0);
      b.ruined = !!b.ruined;
      b.stored = num(b.stored, 0, 0);
      if (['active', 'building', 'upgrading'].indexOf(b.status) < 0) b.status = 'active';
      if (b.status !== 'active') {
        if (!b.timer || !isFinite(b.timer.end) || !isFinite(b.timer.start)) { b.status = 'active'; b.timer = null; }
        else b.timer.to = Math.round(num(b.timer.to, b.level + 1, 1, def.levels.length));
      } else b.timer = null;
      if (b.level === 0 && b.status === 'active') b.level = 1;
      if (!isFinite(b.id) || seen[b.id]) b.id = 0;
      if (b.id) { seen[b.id] = true; maxId = Math.max(maxId, b.id); }
      kept.push(b);
    });
    kept.forEach(function (b) { if (!b.id) { b.id = ++maxId; seen[b.id] = true; } });
    s.base.nextId = Math.max(num(s.base.nextId, 1, 1), maxId + 1);

    // Exactly one core.
    const cores = kept.filter(function (b) { return b.type === 'core'; });
    s.base.buildings = kept.filter(function (b) { return b.type !== 'core' || b === cores[0]; });
    if (!cores.length) {
      s.base.buildings.unshift({ id: s.base.nextId++, type: 'core', level: 1, x: 20, y: 20, rot: 0, status: 'active', timer: null, dmg: 0, ruined: false, stored: 0 });
    }

    // Re-place anything overlapping or outside the build area.
    const placed = [];
    const all = s.base.buildings.slice().sort(function (a, b) { return a.type === 'core' ? -1 : b.type === 'core' ? 1 : 0; });
    s.base.buildings = [];
    all.forEach(function (b) {
      s.base.buildings = placed.slice();
      const ok = Base.canPlaceAt(s, b.type, b.x, b.y, b.rot, b.id).ok;
      if (!ok) {
        const spot = Base.findFreeSpot(s, b.type, b.rot, S / 2, S / 2, b.id);
        if (!spot) return;               // no room at all: drop it rather than break the game
        b.x = spot.x; b.y = spot.y;
      }
      placed.push(b);
    });
    s.base.buildings = placed;

    // Army.
    const units = {};
    Object.keys(s.army.units || {}).forEach(function (t) { if (C.troops[t]) units[t] = Math.round(num(s.army.units[t], 0, 0, 9999)); });
    s.army.units = units;
    s.army.queue = (Array.isArray(s.army.queue) ? s.army.queue : []).filter(function (q) {
      return q && C.troops[q.type] && q.count > 0;
    }).map(function (q) { return { type: q.type, count: Math.round(num(q.count, 1, 1, 999)), unitCost: num(q.unitCost, 0, 0) }; });
    s.army.progress = num(s.army.progress, 0, 0);

    // Research.
    const levels = {};
    Object.keys(s.research.levels || {}).forEach(function (k) {
      if (C.troops[k]) levels[k] = Math.round(num(s.research.levels[k], 1, 1, C.troops[k].hp.length));
      else if (C.research.techs[k]) levels[k] = Math.round(num(s.research.levels[k], 0, 0, C.research.techs[k].cost.length));
    });
    s.research.levels = levels;
    const ra = s.research.active;
    if (ra && (!(C.troops[ra.key] || C.research.techs[ra.key]) || !isFinite(ra.end))) s.research.active = null;

    if (!C.attacks.modes[s.settings.raidMode]) s.settings.raidMode = 'normal';
    if (!Array.isArray(s.log)) s.log = [];
    if (!Array.isArray(s.threat.retaliations)) s.threat.retaliations = [];
    if (s.threat.next && (!isFinite(s.threat.next.at) || !CS.NPC.def(s.threat.next.attackerId))) s.threat.next = null;
    CS.NPC.ensureWorld(s);
    if (s.battle && !CS.Battle.isValidSnapshot(s.battle)) s.battle = null;
    return s;
  };

  // ---------------------------------------------------------------- storage
  let storageOk = true;
  let saveCount = 0;

  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  State.storageAvailable = function () { return storageOk && !!storage(); };

  State.save = function (state, now) {
    const ls = storage();
    if (!ls || !state) { storageOk = false; return false; }
    try {
      state.savedAt = now || CS.Clock.now();
      const json = JSON.stringify({ v: C.saveVersion, savedAt: state.savedAt, state: state });
      ls.setItem(C.saveKey, json);
      if (saveCount++ % 6 === 0) ls.setItem(C.saveKey + '.backup', json);
      storageOk = true;
      return true;
    } catch (e) {
      console.warn('Save failed', e);
      storageOk = false;
      return false;
    }
  };

  function parse(json, now) {
    const wrapper = JSON.parse(json);
    if (!wrapper || typeof wrapper !== 'object') throw new Error('Bad save wrapper');
    return State.sanitize(wrapper.state, now);
  }

  // Returns {state, status, message}. status: 'loaded' | 'new' | 'recovered' | 'reset'
  State.load = function (now) {
    const ls = storage();
    if (!ls) {
      storageOk = false;
      return { state: State.newGame(now), status: 'new', message: 'Your browser blocked local storage, so progress cannot be saved this session.' };
    }
    let json = null;
    try { json = ls.getItem(C.saveKey); } catch (e) { json = null; }
    if (!json) return { state: State.newGame(now), status: 'new' };
    try {
      return { state: parse(json, now), status: 'loaded' };
    } catch (e) {
      console.warn('Save was unreadable, trying the backup', e);
      try { ls.setItem(C.saveKey + '.corrupt', json); } catch (e2) { /* storage full; nothing more to keep */ }
      let backup = null;
      try { backup = ls.getItem(C.saveKey + '.backup'); } catch (e3) { backup = null; }
      if (backup) {
        try {
          return { state: parse(backup, now), status: 'recovered', message: 'Your latest save was damaged, so the most recent backup was restored.' };
        } catch (e4) { /* fall through to a new game */ }
      }
      return { state: State.newGame(now), status: 'reset', message: 'Your save could not be read, so a new settlement was started. The damaged data was kept aside.' };
    }
  };

  State.clear = function () {
    const ls = storage();
    if (!ls) return;
    try {
      ls.removeItem(C.saveKey);
      ls.removeItem(C.saveKey + '.backup');
    } catch (e) { /* ignore */ }
  };

  CS.State = State;

  // ---------------------------------------------------------------- event log
  CS.Log = {
    add: function (state, kind, text, t) {
      state.log.unshift({ t: t || CS.Clock.now(), kind: kind, text: text });
      if (state.log.length > 80) state.log.length = 80;
      CS.Bus.emit('log:add', state.log[0]);
    }
  };
})(window.CS = window.CS || {});
