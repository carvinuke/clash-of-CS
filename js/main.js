/*
 * Game controller: boots the game, owns the main loop and the current mode (village, defense,
 * raid), turns player actions into system calls, builds the render scene every frame and keeps
 * time honest when the tab is hidden, the computer sleeps or the page is reloaded.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base, Eco = CS.Eco, Army = CS.Army, Bt = CS.Battle;
  const NPC = CS.NPC, Threat = CS.Threat, Time = CS.Time, R = CS.Render;
  const S = C.grid.size, TEAM = '#3f86e8';
  // Approximate sprite heights (px) used for click picking and for placing bars above buildings.
  const ZTOP = { core: 92, spire: 92, lance: 64, well: 58, tank: 58, lab: 62, mint: 56, barracks: 54, garrison: 48, station: 46, blaster: 40, mortar: 34, frost: 52, vault: 40, mine: 10, wall: 30 };

  const G = {
    mode: 'village',        // 'village' | 'defense' (NPC raid on the home base) | 'raid' (player attack)
    paused: true,           // true while the title screen is up
    state: null, battle: null, lastBattle: null, result: null,
    speed: 1, acc: 0, ending: 0, battleWall: 0,
    sel: null, place: null, edit: false, troopSel: null,
    hover: null, zoneFlash: -9, time: 0, pending: []
  };

  function now() { return CS.Clock.now(); }
  function sfx(name, o) { CS.Audio.play(name, o); }
  function toast(text, kind) { CS.UI.toast(text, kind); }
  function fail(reason) { toast(reason, 'bad'); sfx('error'); return false; }
  function refresh() { CS.UI.refresh(true); }

  function blocked() {
    if (G.mode === 'defense') return fail('Not while raiders are attacking your base');
    if (G.mode === 'raid') return fail('Finish the battle first');
    return false;
  }

  G.save = function () {
    const st = G.state;
    if (!st) return false;
    st.battle = G.battle ? Bt.serialize(G.battle) : null;
    const ok = CS.State.save(st, now());
    st.battle = null;
    return ok;
  };

  // ---------------------------------------------------------------- ground & camera
  G.refreshGround = function () {
    const b = G.battle || G.lastBattle;
    if (G.mode === 'raid' && b) {
      const s = NPC.def(b.targetId);
      const a = C.tiers[s.tier].area, a0 = Math.floor((S - a) / 2);
      R.setGround(b.biome, { x0: a0, y0: a0, x1: a0 + a, y1: a0 + a }, U.hash(s.id) + 3);
    } else {
      R.setGround('home', Base.buildArea(Base.coreLevel(G.state)), G.state.createdAt % 9973 + 1);
    }
  };

  // Frames the buildings (not the whole build area) so a small village is not tiny on screen.
  G.home = function () {
    G.refreshGround();
    let x0 = S, y0 = S, x1 = 0, y1 = 0;
    G.state.base.buildings.forEach(function (b) {
      const r = Base.rect(b);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    if (x1 <= x0) { x0 = y0 = S / 2 - 6; x1 = y1 = S / 2 + 6; }
    R.fitArea(Math.max(14, x1 - x0, y1 - y0) + 3, (x0 + x1) / 2, (y0 + y1) / 2);
  };

  // ---------------------------------------------------------------- selection & picking
  function rectsHome() {
    return G.state.base.buildings.map(function (b) {
      const r = Base.rect(b);
      return { id: b.id, type: b.type, x: r.x, y: r.y, w: r.w, h: r.h };
    });
  }

  // Front-most building whose footprint, swept up to its sprite height, covers the screen point.
  function pick(sx, sy, list) {
    let best = null, bestD = -Infinity;
    list.forEach(function (b) {
      const top = (ZTOP[b.type] || 40) * 0.8;
      for (let z = 0; z <= top; z += 6) {
        const t = R.toTile(sx, sy + z * R.cam.zoom);
        if (t[0] >= b.x && t[0] < b.x + b.w && t[1] >= b.y && t[1] < b.y + b.h) {
          const d = b.x + b.w / 2 + b.y + b.h / 2;
          if (d > bestD) { bestD = d; best = b; }
          break;
        }
      }
    });
    return best;
  }

  G.pickAt = function (sx, sy) {
    if (G.mode === 'raid') {
      const b = G.battle || G.lastBattle;
      if (!b) return null;
      return pick(sx, sy, b.buildings.filter(function (c) { return !c.dead && !(c.trap && c.hidden); }));
    }
    const hit = pick(sx, sy, rectsHome());
    return hit ? hit.id : null;
  };

  G.select = function (id) {
    const st = G.state;
    const b = id ? Base.find(st, id) : null;
    G.sel = b ? b.id : null;
    if (b) {
      if (C.buildings[b.type].produces && b.stored >= 1) Eco.collect(st, b);
      else sfx('click');
    }
    refresh();
  };

  // ---------------------------------------------------------------- building actions
  function footprintAt(type, rot, tx, ty) {
    const s = Base.size(type, rot);
    return { x: Math.round(tx - s[0] / 2), y: Math.round(ty - s[1] / 2), w: s[0], h: s[1] };
  }

  function validatePlace() {
    const p = G.place;
    if (!p) return;
    const s = Base.size(p.type, p.rot);
    p.w = s[0]; p.h = s[1];
    const chk = Base.canPlaceAt(G.state, p.type, p.x, p.y, p.rot, p.moveId || undefined);
    p.ok = chk.ok;
    p.reason = chk.reason;
    if (p.ok && !p.moveId) {
      const can = Eco.canBuild(G.state, p.type);
      if (!can.ok) { p.ok = false; p.reason = can.reason; }
    }
  }

  G.build = function (type) {
    if (blocked()) return false;
    const chk = Eco.canBuild(G.state, type);
    if (!chk.ok) return fail(chk.reason);
    const c = R.toTile(R.W / 2, R.H / 2);
    const spot = Base.findFreeSpot(G.state, type, 0, c[0], c[1]) || footprintAt(type, 0, c[0], c[1]);
    G.place = { type: type, rot: 0, x: spot.x, y: spot.y, moveId: 0, line: null };
    G.sel = null;
    validatePlace();
    sfx('click');
    refresh();
    return true;
  };

  G.startMove = function (id) {
    if (blocked()) return false;
    const b = Base.find(G.state, id);
    if (!b) return false;
    G.place = { type: b.type, rot: b.rot, x: b.x, y: b.y, moveId: b.id, level: b.level, line: null };
    G.sel = null;
    validatePlace();
    refresh();
    return true;
  };

  G.movePlace = function (tx, ty) {
    const p = G.place;
    if (!p) return;
    const f = footprintAt(p.type, p.rot, tx, ty);
    if (f.x === p.x && f.y === p.y) return;
    p.x = f.x; p.y = f.y;
    validatePlace();
  };

  G.rotatePlace = function () {
    const p = G.place;
    if (!p) return;
    const def = C.buildings[p.type];
    if (!def.rotatable) { toast(def.name + ' cannot be rotated', 'info'); return; }
    p.rot = p.rot ? 0 : 1;
    validatePlace();
    sfx('click');
    refresh();
  };

  G.cancelPlace = function () {
    const p = G.place;
    G.place = null;
    if (p && p.moveId) G.sel = p.moveId;
    refresh();
  };

  // Next free tile for walls and mines so they can be laid one after another.
  function nextSpot(p) {
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let i = 0; i < dirs.length; i++) {
      const x = p.x + dirs[i][0], y = p.y + dirs[i][1];
      if (Base.canPlaceAt(G.state, p.type, x, y, 0).ok) return { x: x, y: y };
    }
    return { x: p.x, y: p.y };
  }

  G.confirmPlace = function () {
    const p = G.place;
    if (!p) return false;
    if (blocked()) return false;
    const st = G.state;
    validatePlace();
    if (!p.ok) return fail(p.reason || 'Cannot place here');
    if (p.moveId) {
      const b = Base.find(st, p.moveId);
      const r = b ? Eco.move(st, b, p.x, p.y, p.rot) : { ok: false, reason: 'Building is gone' };
      if (!r.ok) return fail(r.reason);
      sfx('place');
      R.emit('dust', p.x + p.w / 2, p.y + p.h / 2);
      G.place = null;
      G.sel = G.edit ? null : b.id;
    } else {
      const r = Eco.place(st, p.type, p.x, p.y, p.rot, now());
      if (!r.ok) return fail(r.reason);
      const instant = Eco.isInstant(p.type, 1);
      sfx(instant ? 'place' : 'build');
      R.emit('dust', p.x + p.w / 2, p.y + p.h / 2);
      if (p.type === 'wall' || p.type === 'mine') {
        const n = nextSpot(p);
        p.x = n.x; p.y = n.y;
        validatePlace();
        if (!Eco.canBuild(st, p.type).ok) { G.place = null; }
      } else {
        G.place = null;
        G.sel = r.b.id;
        if (!instant) toast(C.buildings[p.type].name + ' construction started', 'good');
      }
    }
    G.save();
    refresh();
    return true;
  };

  // Straight run of wall tiles from the placement start to (tx, ty).
  G.wallLine = function (x0, y0, tx, ty) {
    const x1 = Math.floor(tx), y1 = Math.floor(ty);
    const horiz = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
    const n = Math.min(24, horiz ? Math.abs(x1 - x0) : Math.abs(y1 - y0));
    const sx = horiz ? Math.sign(x1 - x0) : 0, sy = horiz ? 0 : Math.sign(y1 - y0);
    const st = G.state, occ = Base.occupancy(st.base.buildings);
    const can = Eco.canBuild(st, 'wall');
    let budget = can.ok ? Math.min(Math.floor(st.res.credits / Eco.buildCost(st, 'wall').credits), can.max - can.count) : 0;
    const out = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + sx * i, y = y0 + sy * i;
      let ok = Base.canPlaceAt(st, 'wall', x, y, 0, undefined, occ).ok;
      if (ok) { ok = budget > 0; budget--; }
      out.push({ x: x, y: y, ok: ok });
    }
    return out;
  };

  G.placeLine = function (line) {
    if (blocked()) return 0;
    let n = 0, reason = null;
    line.forEach(function (t) {
      if (reason && reason !== 'Space is occupied') return;
      const r = Eco.place(G.state, 'wall', t.x, t.y, 0, now());
      if (r.ok) n++; else reason = r.reason;
    });
    if (n) {
      sfx('place');
      const last = line[line.length - 1];
      R.emit('dust', last.x + 0.5, last.y + 0.5);
      toast(n + (n === 1 ? ' wall' : ' walls') + ' placed', 'good');
      G.save();
    } else if (reason) fail(reason);
    if (G.place) {
      const end = line[line.length - 1];
      G.place.line = null;
      G.place.x = end.x; G.place.y = end.y;
      validatePlace();
      if (!Eco.canBuild(G.state, 'wall').ok) G.place = null;
    }
    refresh();
    return n;
  };

  G.toggleEdit = function (on) {
    if (on === undefined) on = !G.edit;
    if (on && blocked()) return;
    G.edit = !!on;
    if (!G.edit && G.place && G.place.moveId) G.cancelPlace();
    G.sel = null;
    if (G.edit) toast('Edit mode: drag buildings to move them. R rotates, Esc leaves edit mode.', 'info');
    refresh();
  };

  G.upgrade = function (id) {
    if (blocked()) return false;
    const b = Base.find(G.state, id);
    if (!b) return false;
    const r = Eco.startUpgrade(G.state, b, now());
    if (!r.ok) return fail(r.reason);
    sfx(b.status === 'upgrading' ? 'build' : 'complete');
    toast(b.status === 'upgrading' ? 'Upgrading ' + Base.name(b.type) + ' to Lv ' + (b.level + 1) : Base.name(b.type) + ' upgraded to Lv ' + b.level, 'good');
    if (b.type === 'core' && b.status === 'active') G.refreshGround();
    G.save();
    refresh();
    return true;
  };

  G.upgradeWalls = function (level) {
    if (blocked()) return 0;
    const n = Eco.upgradeWalls(G.state, level);
    if (!n) { fail(Eco.wallBatch(G.state, level).reason || 'Nothing to upgrade'); return 0; }
    sfx('complete');
    toast(n + (n === 1 ? ' wall' : ' walls') + ' upgraded to Lv ' + (level + 1), 'good');
    G.save();
    refresh();
    return n;
  };

  G.cancelTimer = function (id) {
    if (blocked()) return;
    const b = Base.find(G.state, id);
    if (!b || !b.timer) return;
    const wasNew = b.status === 'building';
    Eco.cancel(G.state, b);
    toast((wasNew ? 'Construction' : 'Upgrade') + ' cancelled. Half of the cost was refunded.', 'info');
    if (wasNew) G.sel = null;
    G.save();
    refresh();
  };

  G.repair = function (id) {
    if (blocked()) return false;
    const b = Base.find(G.state, id);
    if (!b) return false;
    const r = Eco.repairNow(G.state, b);
    if (!r.ok) return fail(r.reason);
    sfx('build');
    G.save();
    refresh();
    return true;
  };

  G.repairAll = function () {
    if (blocked()) return 0;
    const st = G.state;
    const list = st.base.buildings.filter(function (b) { return Eco.repairCost(st, b); });
    if (!list.length) { toast('Nothing needs repairs', 'info'); return 0; }
    list.sort(function (a, b) { return (b.ruined ? 1 : 0) - (a.ruined ? 1 : 0); });
    let n = 0, short = null;
    list.forEach(function (b) {
      const r = Eco.repairNow(st, b);
      if (r.ok) n++; else short = r.reason;
    });
    if (n) { sfx('build'); toast(n + ' building' + (n === 1 ? '' : 's') + ' repaired' + (short ? '. ' + short + ' for the rest' : ''), 'good'); }
    else fail(short);
    G.save();
    refresh();
    return n;
  };

  G.collectAll = function () {
    const got = Eco.collectAll(G.state);
    if (got.credits + got.energy <= 0) { toast('Nothing to collect yet', 'info'); return got; }
    const cap = Eco.capacity(G.state);
    const full = (got.credits === 0 && G.state.res.credits >= cap.credits) || (got.energy === 0 && G.state.res.energy >= cap.energy);
    if (full) toast('Some storage is full. Build or upgrade storages to hold more.', 'info');
    G.save();
    refresh();
    return got;
  };

  // ---------------------------------------------------------------- army & research
  G.train = function (type, n) {
    const r = Army.queueTroop(G.state, type, n || 1);
    if (!r.ok) return fail(r.reason);
    sfx('train');
    refresh();
    return true;
  };

  G.untrain = function (index) {
    Army.dequeue(G.state, index);
    sfx('click');
    refresh();
  };

  G.research = function (key) {
    const r = CS.Research.start(G.state, key, now());
    if (!r.ok) return fail(r.reason);
    sfx('build');
    const d = CS.Research.describe(G.state, key);
    toast('Researching ' + d.name + ' Lv ' + (d.level + 1), 'good');
    G.save();
    refresh();
    return true;
  };

  G.cancelResearch = function () {
    CS.Research.cancel(G.state);
    toast('Research cancelled. Half of the cost was refunded.', 'info');
    G.save();
    refresh();
  };

  // ---------------------------------------------------------------- settings & new game
  G.setSetting = function (key, value) {
    const st = G.state;
    const prev = st.settings[key];
    st.settings[key] = value;
    if (key === 'raidMode' && prev !== value) {
      if (Threat.freq(st) <= 0) Threat.cancelPlans(st);
      else if (st.threat.next && !st.threat.next.announced) st.threat.next = null;   // re-plan at the new pace
    }
    CS.Audio.applySettings(st.settings);
    G.save();
    refresh();
  };

  G.newGame = function () {
    CS.State.clear();
    G.battle = null; G.lastBattle = null; G.result = null;
    G.mode = 'village'; G.sel = null; G.place = null; G.edit = false; G.speed = 1;
    G.state = CS.State.newGame(now());
    CS.Audio.applySettings(G.state.settings);
    R.fx.length = 0;
    G.home();
    G.save();
    CS.UI.closeAll();
    CS.UI.enterVillage();
    CS.Tutorial.restart();
    CS.Audio.music('village');
    refresh();
    toast('A new settlement was founded', 'good');
  };

  // ---------------------------------------------------------------- raids (player attacks)
  G.firstTroop = function () {
    const b = G.battle;
    if (!b) return null;
    for (let i = 0; i < C.troopOrder.length; i++) if (b.pool[C.troopOrder[i]] > 0) return C.troopOrder[i];
    return null;
  };

  G.raidStatus = function (id) {
    const st = G.state, s = NPC.def(id), t = now();
    if (!s) return { ok: false, reason: 'Unknown settlement' };
    if (!NPC.isUnlocked(st, s)) return { ok: false, locked: true, reason: 'Win ' + C.world.unlockWins + ' raids against tier ' + (s.tier - 1) + ' settlements to reach it' };
    const rec = NPC.rec(st, id);
    if (rec.rebuildUntil > t) return { ok: false, rebuilding: rec.rebuildUntil, reason: s.name + ' is rebuilding after your last victory' };
    if (Army.totalUnits(st) <= 0) return { ok: false, noArmy: true, reason: 'You have no troops. Train some in the Army menu first' };
    if (G.mode !== 'village') return { ok: false, reason: G.mode === 'defense' ? 'Defend your base first' : 'Finish the current battle first' };
    return { ok: true };
  };

  G.startRaid = function (id) {
    const st = G.state, t = now();
    const chk = G.raidStatus(id);
    if (!chk.ok) return fail(chk.reason);
    const s = NPC.def(id);
    const brought = {};
    Object.keys(st.army.units).forEach(function (k) { if (st.army.units[k] > 0) brought[k] = st.army.units[k]; });
    const levels = {};
    C.troopOrder.forEach(function (k) { levels[k] = CS.Research.level(st, k); });
    const diff = NPC.difficulty(st, s);
    G.battle = Bt.create({
      kind: 'attack', seed: (U.hash(id) ^ (t % 2147483647)) >>> 0, biome: NPC.faction(s).biome, name: s.name,
      targetId: id, buildings: NPC.battleBuildings(st, s, t), troops: brought, troopLevels: levels,
      timeLimit: C.battle.raidSeconds, meta: { brought: brought, difficulty: diff.label, tier: s.tier }
    });
    G.lastBattle = null; G.result = null;
    G.mode = 'raid'; G.acc = 0; G.speed = 1; G.ending = 0; G.battleWall = t;
    G.sel = null; G.place = null; G.edit = false;
    G.troopSel = G.firstTroop();
    R.fx.length = 0;
    G.refreshGround();
    R.fitArea(C.tiers[s.tier].area + 6);
    CS.UI.closeAll();
    CS.UI.enterRaid();
    CS.Audio.music('battle');
    sfx('horn');
    CS.Bus.emit('raid:start', { id: id });
    G.save();
    return true;
  };

  G.selectTroop = function (type) {
    const b = G.battle;
    if (!b || !(b.pool[type] > 0)) return;
    G.troopSel = type;
    sfx('click');
    CS.UI.refreshBattle();
  };

  G.deployAt = function (tx, ty, quiet) {
    const b = G.battle;
    if (G.mode !== 'raid' || !b || b.ended) return false;
    if (!G.troopSel || !(b.pool[G.troopSel] > 0)) G.troopSel = G.firstTroop();
    if (!G.troopSel) { if (!quiet) toast('All troops are deployed', 'info'); return false; }
    const r = Bt.deploy(b, G.troopSel, tx, ty);
    if (!r.ok) {
      if (r.reason === 'zone') {
        G.zoneFlash = G.time;
        if (!quiet) { sfx('error'); toast('Troops can only be deployed outside the red zone', 'bad'); }
      }
      return false;
    }
    if (!(b.pool[G.troopSel] > 0)) G.troopSel = G.firstTroop();
    CS.Bus.emit('raid:deploy', {});
    CS.UI.refreshBattle();
    return true;
  };

  G.toggleSpeed = function () {
    G.speed = G.speed >= C.battle.maxSpeed ? 1 : G.speed + 1;
    sfx('click');
    CS.UI.refreshBattle();
  };

  G.endBattle = function () {
    const b = G.battle;
    if (!b || b.ended || G.mode !== 'raid') return;
    Bt.surrender(b);
    if (b.endReason === 'cancel') finishBattle();
    else G.ending = performance.now() + 300;
  };

  G.goHome = function () {
    G.battle = null; G.lastBattle = null; G.result = null;
    G.mode = 'village'; G.ending = 0; G.speed = 1;
    R.fx.length = 0;
    CS.UI.closeAll();
    CS.UI.enterVillage();
    CS.Audio.music('village');
    G.home();
    G.save();
    refresh();
  };

  function sum(o) { let n = 0; Object.keys(o || {}).forEach(function (k) { n += o[k]; }); return n; }

  // Short, specific advice after a failed raid.
  function explainLoss(res, b) {
    const tips = [];
    const pct = Math.round(res.destruction * 100);
    if (res.reason === 'time') tips.push('Time ran out at ' + pct + '% destruction. Deploy sooner and from more than one side.');
    else if (res.reason === 'troops') tips.push('Every troop you deployed was defeated at ' + pct + '% destruction.');
    else if (res.reason === 'retreat') tips.push('You ended the battle at ' + pct + '% destruction. Half of the buildings must fall to win.');
    let top = null;
    Object.keys(res.dmg).forEach(function (k) { if (!top || res.dmg[k] > res.dmg[top]) top = k; });
    if (top) tips.push('The ' + C.buildings[top].name + ' did the most damage to your army.');
    const walls = b.buildings.filter(function (c) { return c.wall && !c.dead; }).length;
    if (walls > 8 && !res.deployed.demo) tips.push(Army.isUnlocked(G.state, 'demo') ? 'Bring Demolishers to blast through the walls.' : 'Walls slowed you down. Barracks Lv 3 unlocks Demolishers, which blow walls apart.');
    if ((top === 'blaster' || top === 'spire' || top === 'lance') && !res.deployed.bruiser) tips.push(Army.isUnlocked(G.state, 'bruiser') ? 'Send Bruisers first so they soak up turret fire.' : 'Upgrade your Barracks to Lv 2 to train Bruisers that can tank turret fire.');
    if (top === 'mortar') tips.push('Quake Mortars punish clumps of troops. Spread your deployment out.');
    if (top === 'mine') tips.push('Hidden Shock Mines caught your troops. A few Scouts sent first can set them off.');
    if (b.meta.difficulty === 'Hard' || b.meta.difficulty === 'Deadly') tips.push('This settlement was rated ' + b.meta.difficulty + ' for your army. Train more troops or research upgrades before trying again.');
    return tips.slice(0, 4);
  }

  function finishRaid(b) {
    const st = G.state, t = now();
    const res = Bt.result(b);
    const s = NPC.def(b.targetId);
    G.battle = null;
    G.lastBattle = b;
    G.ending = 0;
    if (res.reason === 'cancel') { G.goHome(); return; }
    const brought = b.meta.brought || {};
    Object.keys(brought).forEach(function (k) {
      st.army.units[k] = Math.max(0, (st.army.units[k] || 0) - brought[k] + (res.survived[k] || 0));
    });
    const T = C.tiers[s.tier];
    const bonus = res.victory ? Math.round(T.bonus * res.stars / 3) : 0;
    const want = { credits: res.loot.credits + bonus, energy: res.loot.energy + bonus };
    const gained = { credits: Eco.add(st, 'credits', want.credits), energy: Eco.add(st, 'energy', want.energy) };
    const wasted = want.credits - gained.credits + want.energy - gained.energy;
    let renown = 0;
    if (res.victory) renown = C.battle.renownWin[res.stars - 1] + 2 * (s.tier - 1);
    else if (sum(res.deployed) > 0) renown = -Math.min(C.battle.renownLoss, st.player.renown);
    CS.Player.addRenown(st, renown);
    CS.Player.addXp(st, res.victory ? 4 + res.stars * 2 * s.tier : 1);
    if (res.victory) st.stats.raidsWon++; else st.stats.raidsLost++;
    st.stats.lootCredits += gained.credits;
    st.stats.lootEnergy += gained.energy;
    const notes = NPC.onRaidResult(st, s, res, t);
    CS.Log.add(st, res.victory ? 'victory' : 'defeat', (res.victory ? 'Victory at ' : 'Defeat at ') + s.name + ': ' +
      Math.round(res.destruction * 100) + '% destroyed, ' + res.stars + (res.stars === 1 ? ' star, ' : ' stars, ') +
      U.fmt(gained.credits) + ' Credits and ' + U.fmt(gained.energy) + ' Energy looted.', t);
    G.result = {
      s: s, res: res, gained: gained, bonus: bonus, wasted: wasted, renown: renown, notes: notes,
      tips: res.victory ? [] : explainLoss(res, b), difficulty: b.meta.difficulty
    };
    sfx(res.victory ? 'victory' : 'defeat');
    CS.Audio.music(null);
    CS.Bus.emit('raid:end', { victory: res.victory });
    G.save();
    CS.UI.raidResults(G.result);
  }

  // ---------------------------------------------------------------- NPC raids on the home base
  G.startDefense = function (plan) {
    const st = G.state;
    if (G.place) G.place = null;
    G.edit = false;
    G.battle = Threat.buildDefense(st, plan, now());
    G.mode = 'defense'; G.acc = 0; G.speed = 1; G.ending = 0; G.battleWall = now();
    R.fx.length = 0;
    G.refreshGround();
    CS.UI.closeAll();
    CS.UI.enterDefense();
    CS.Audio.music('battle');
    sfx('siren');
    G.save();
  };

  function finishDefense(b) {
    const report = Threat.applyDefense(G.state, b, now());
    G.battle = null;
    G.ending = 0;
    G.mode = 'village';
    G.sel = null;
    CS.UI.enterVillage();
    CS.Audio.music('village');
    sfx(report.defended ? 'victory' : 'defeat');
    G.save();
    refresh();
    CS.UI.defenseReport(report);
  }

  function finishBattle() {
    const b = G.battle;
    if (!b) return;
    if (b.kind === 'attack') finishRaid(b);
    else finishDefense(b);
  }

  G.skipDefense = function () {
    const b = G.battle;
    if (!b || b.kind !== 'defense' || b.ended) return;
    Bt.fastForward(b, b.limit - b.tick + 1);
    Bt.takeEvents(b);
    finishBattle();
  };

  const threatCtx = {
    busy: false,
    onWarning: function (plan) {
      const s = NPC.def(plan.attackerId);
      sfx('warning');
      if (G.mode === 'raid') toast('Scouts report raiders from ' + s.name + ' near your base. They will strike once you return.', 'bad');
      else if (plan.kind === 'retaliation') toast(s.leader + ' of ' + s.name + ' seeks revenge!', 'bad');
      refresh();
    },
    onLaunch: function (plan) { G.startDefense(plan); }
  };

  // ---------------------------------------------------------------- time
  function handleEvents(events, quiet) {
    if (!events.length) return;
    let trained = 0, coreChanged = false;
    events.forEach(function (e) {
      if (e.type === 'built' || e.type === 'upgraded') {
        if (e.btype === 'core') coreChanged = true;
        if (!quiet) {
          const b = Base.find(G.state, e.id);
          toast(Base.name(e.btype) + (e.type === 'built' ? ' is ready' : ' reached Lv ' + e.level), 'good');
          if (b) {
            const r = Base.rect(b);
            R.emit('text', r.x + r.w / 2, r.y + r.h / 2, 60, { text: e.type === 'built' ? 'Built!' : 'Lv ' + e.level, col: '#ffe066' });
          }
        }
      } else if (e.type === 'trained') trained++;
      else if (e.type === 'research' && !quiet) {
        const d = CS.Research.describe(G.state, e.key);
        toast(d.name + ' research complete (Lv ' + e.level + ')', 'good');
      } else if (e.type === 'repaired' && !quiet) toast(Base.name(e.btype) + ' has been rebuilt', 'info');
    });
    if (!quiet) {
      if (events.some(function (e) { return e.type !== 'trained'; })) sfx('complete');
      else if (trained) sfx('trainDone', { quiet: true });
      if (trained && !G.state.army.queue.length) toast('Training complete. Your army is ready.', 'good');
    }
    events.forEach(function (e) { CS.Bus.emit('time:' + e.type, e); });
    if (coreChanged) { G.refreshGround(); if (!quiet) toast('Your Command Core grew. More buildings and land are available!', 'good'); }
    refresh();
  }

  function fastForwardBattle(sec) {
    const b = G.battle;
    if (!b || b.ended || b.phase !== 'fight' || !(sec > 0)) return;
    Bt.fastForward(b, Math.min(Math.ceil(sec * Bt.TR), b.limit - b.tick + 1));
    Bt.takeEvents(b);
  }

  // Brings everything up to the current time after a gap (hidden tab, sleep, reload).
  G.sync = function (reason) {
    const st = G.state;
    if (!st) return null;
    const t = now();
    if (G.battle && !G.paused && G.battleWall) {
      const bsec = (t - G.battleWall) / 1000;
      if (bsec > 1) fastForwardBattle(bsec);
    }
    G.battleWall = t;
    if (G.battle && G.battle.ended) finishBattle();
    const gap = (t - st.lastTick) / 1000;
    if (gap <= 3) { handleEvents(Time.step(st, t)); return null; }
    const rep = Time.catchUp(st, t, { allowRaids: !G.battle });
    handleEvents(rep.events, true);
    if (gap >= C.offline.reportAfterSec && Time.isNotable(rep)) {
      if (G.paused) G.pending.push(rep); else CS.UI.awayReport(rep);
    }
    G.save();
    return rep;
  };

  // ---------------------------------------------------------------- scene building
  function tilesOf(list) {
    const set = new Set();
    list.forEach(function (b) { if (b.type === 'wall' && !b.dead && !b.ruined) set.add(b.y * S + b.x); });
    return set;
  }

  function wallMask(set, x, y) {
    return (set.has(y * S + x + 1) ? 1 : 0) | (set.has((y + 1) * S + x) ? 2 : 0);
  }

  function aimInfo(b, c, info, dt, beams) {
    const A = c.atk;
    if (!A) return;
    const tgt = c.tgt ? Bt.unit(b, c.tgt) : null;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    if (A.kind === 'blaster' || A.kind === 'spire' || A.kind === 'mortar') {
      info.angle = R.aimAngle(c.id, tgt ? Math.atan2(tgt.y - cy, tgt.x - cx) : null, dt);
      info.recoil = R.recoilAmount(c.id);
    } else if (A.kind === 'lance') {
      info.firing = !!tgt && c.func;
      if (info.firing) beams.push({ x0: cx, y0: cy, z0: 60, x1: tgt.x, y1: tgt.y, z1: 12 });
    } else if (A.kind === 'frost') info.pulse = R.pulseAmount(c.id);
    else if (A.kind === 'mine') { info.hidden = false; info.triggered = !c.armed; }
  }

  function idleAngle(id) { return Math.sin(G.time * 0.35 + id * 1.7) * 1.4 + 0.8; }

  function homeScene(dt, scene) {
    const st = G.state, t = now();
    const bat = G.battle && G.battle.kind === 'defense' ? G.battle : null;
    const walls = tilesOf(st.base.buildings);
    const eng = Eco.engineers(st);
    let idle = eng.free;
    const cap = Eco.capacity(st);
    const types = C.troopOrder.filter(function (k) { return st.army.units[k] > 0; });
    const units = Army.totalUnits(st);
    const ra = st.research.active;
    let trainShown = false;
    st.base.buildings.forEach(function (b) {
      const r = Base.rect(b);
      const def = C.buildings[b.type];
      const o = { id: b.id, type: b.type, level: b.status === 'building' ? 0 : b.level, rot: b.rot, x: r.x, y: r.y, w: r.w, h: r.h, team: TEAM, ruin: b.ruined, barZ: ZTOP[b.type] };
      const info = { team: TEAM, active: Base.isFunctional(b), upgrading: b.status === 'upgrading' };
      o.info = info;
      if (b.type === 'wall') o.mask = wallMask(walls, b.x, b.y);
      const bb = bat ? Bt.building(bat, b.id) : null;
      if (bb) {
        o.ruin = bb.dead;
        o.hpFrac = bb.hp / bb.maxHp;
        o.hitFlash = bat.tick - bb.hitT < 3;
        aimInfo(bat, bb, info, dt, scene.beams);
        if (bb.trap && bb.spent) return;
      } else {
        if (!b.ruined && b.dmg > 0) o.hpFrac = Base.hp(st, b) / Base.maxHp(st, b);
        if (def.attack && (def.attack.kind === 'blaster' || def.attack.kind === 'spire' || def.attack.kind === 'mortar')) info.angle = idleAngle(b.id);
      }
      if (G.place && G.place.moveId === b.id) o.alpha = 0.3;
      if (def.produces) {
        const L = Base.levelDef(b.type, b.level);
        info.fill = b.stored / L.buffer;
        if (!bat && Base.isFunctional(b) && b.stored >= Math.max(5, L.buffer * 0.02)) o.bubble = def.produces;
      } else if (def.stores) info.fill = cap[def.stores] ? st.res[def.stores] / cap[def.stores] : 0;
      else if (b.type === 'garrison') { info.troops = units; info.troopTypes = types; }
      else if (b.type === 'lab') info.busy = !!ra;
      else if (b.type === 'station') { info.idle = idle > 0 && !b.ruined; if (info.idle) idle--; }
      else if (b.type === 'barracks') info.active = info.active && st.army.queue.length > 0;
      if (b.ruined && !bat) o.bubble = 'repair';
      if (b.timer) {
        const total = b.timer.end - b.timer.start;
        o.timer = { frac: total > 0 ? U.clamp((t - b.timer.start) / total, 0, 1) : 1, text: U.fmtTime((b.timer.end - t) / 1000) };
      } else if (b.type === 'lab' && ra) {
        o.timer = { frac: U.clamp((t - ra.start) / (ra.end - ra.start), 0, 1), text: U.fmtTime((ra.end - t) / 1000) };
      } else if (b.type === 'barracks' && st.army.queue.length && !trainShown && Base.isFunctional(b)) {
        trainShown = true;
        const head = st.army.queue[0];
        o.timer = { frac: U.clamp(st.army.progress / Army.trainSeconds(st, head.type), 0, 1), text: U.fmtTime(Army.queueRemaining(st)) };
      }
      scene.buildings.push(o);
    });
    if (bat) battleUnits(bat, scene, NPC.faction(NPC.def(bat.attackerId)).color);
    // placement ghost and highlights
    const p = G.place;
    if (p) {
      scene.grid = true;
      if (p.line) {
        p.line.forEach(function (tl) {
          scene.buildings.push({ id: -1, type: 'wall', level: 1, rot: 0, x: tl.x, y: tl.y, w: 1, h: 1, team: TEAM, alpha: 0.75, mask: 0, info: { team: TEAM } });
          scene.highlights.push({ x: tl.x, y: tl.y, w: 1, h: 1, fill: tl.ok ? 'rgba(80,255,120,0.3)' : 'rgba(255,60,60,0.35)', stroke: tl.ok ? 'rgba(120,255,150,0.9)' : 'rgba(255,90,90,0.9)' });
        });
      } else {
        scene.ghost = { id: -1, type: p.type, level: p.level || 1, rot: p.rot, x: p.x, y: p.y, w: p.w, h: p.h, team: TEAM, alpha: 0.78, mask: p.type === 'wall' ? wallMask(walls, p.x, p.y) : 0, info: { team: TEAM, angle: 0.8, active: true, fill: 0.5 }, barZ: ZTOP[p.type] };
        scene.highlights.push({ x: p.x, y: p.y, w: p.w, h: p.h, fill: p.ok ? 'rgba(80,255,120,0.28)' : 'rgba(255,60,60,0.32)', stroke: p.ok ? 'rgba(120,255,150,0.95)' : 'rgba(255,90,90,0.95)' });
        const A = C.buildings[p.type].attack;
        if (A && A.range > 1.5) scene.ranges.push({ x: p.x + p.w / 2, y: p.y + p.h / 2, r: A.range, min: A.minRange });
      }
    }
    if (G.edit) scene.grid = true;
    if (G.sel) {
      const b = Base.find(st, G.sel);
      if (b) {
        const r = Base.rect(b);
        scene.highlights.push({ x: r.x, y: r.y, w: r.w, h: r.h, fill: 'rgba(255,255,255,0.12)', stroke: 'rgba(255,255,255,0.85)' });
        const A = C.buildings[b.type].attack;
        if (A && A.range > 1.5) scene.ranges.push({ x: r.x + r.w / 2, y: r.y + r.h / 2, r: A.range, min: A.minRange });
      }
    }
    if (st.settings.showGrid && !bat) scene.grid = true;
    scene.gridAlpha = p || G.edit ? 0.22 : 0.09;
    scene.area = Base.buildArea(Base.coreLevel(st));
  }

  function battleUnits(b, scene, team) {
    const a = U.clamp(G.acc / Bt.TICK, 0, 1);
    b.units.forEach(function (u) {
      const moving = Math.abs(u.x - u.px) + Math.abs(u.y - u.py) > 1e-4;
      const since = b.tick - u.atkT;
      scene.units.push({
        id: u.id, type: u.type, team: team, x: u.px + (u.x - u.px) * a, y: u.py + (u.y - u.py) * a,
        face: u.face, idle: !moving, atk: since < 9 ? since / 9 : null, hit: b.tick - u.hitT < 3,
        lv: u.lv, skin: u.id % 4, hp: u.hp, maxHp: u.maxHp
      });
    });
    b.proj.forEach(function (p) {
      if (p.k === 'shell') { scene.projectiles.push({ k: 'shell', x: p.x, y: p.y, f: p.dur ? p.t / p.dur : 1 }); return; }
      const tgt = p.tb ? Bt.building(b, p.tgt) : Bt.unit(b, p.tgt);
      if (!tgt) return;
      const tx = p.tb ? tgt.x + tgt.w / 2 : tgt.x, ty = p.tb ? tgt.y + tgt.h / 2 : tgt.y;
      const done = U.dist(p.sx, p.sy, p.x, p.y), left = U.dist(p.x, p.y, tx, ty);
      const f = done + left > 0 ? done / (done + left) : 1;
      const z0 = p.k === 'bolt' ? 62 : p.k === 'ball' ? 26 : 13, z1 = p.tb ? 22 : 10;
      const d = left || 1;
      scene.projectiles.push({ k: p.k, x: p.x, y: p.y, z: z0 + (z1 - z0) * f, dx: (tx - p.x) / d * 0.5, dy: (ty - p.y) / d * 0.5, dz: (z0 - z1) * 0.04 });
    });
    scene.unitBars = true;
  }

  function raidScene(dt, scene) {
    const b = G.battle || G.lastBattle;
    const s = NPC.def(b.targetId);
    const team = NPC.faction(s).color;
    const walls = tilesOf(b.buildings);
    b.buildings.forEach(function (c) {
      if (c.trap && (c.hidden || c.spent)) return;
      const info = { team: team, active: c.func };
      const o = { id: c.id, type: c.type, level: c.level, rot: c.rot, x: c.x, y: c.y, w: c.w, h: c.h, team: team, ruin: c.dead, info: info, barZ: ZTOP[c.type] };
      if (c.wall) o.mask = wallMask(walls, c.x, c.y);
      o.hpFrac = c.hp / c.maxHp;
      o.hitFlash = b.tick - c.hitT < 3;
      const def = C.buildings[c.type];
      if (def.produces || def.stores) info.fill = c.lootLeft ? Math.min(1, (c.lootLeft.credits + c.lootLeft.energy) / 2500) : 0.3;
      else if (c.type === 'garrison') { info.troops = 3; info.troopTypes = NPC.faction(s).troops; }
      else if (c.type === 'station') info.idle = !c.dead;
      aimInfo(b, c, info, dt, scene.beams);
      if (c.atk && (c.atk.kind === 'blaster' || c.atk.kind === 'spire' || c.atk.kind === 'mortar') && !c.tgt && b.phase === 'scout') info.angle = idleAngle(c.id);
      scene.buildings.push(o);
    });
    battleUnits(b, scene, TEAM);
    if (G.battle && !G.battle.ended) {
      const flash = Math.max(0, 1 - (G.time - G.zoneFlash) / 0.9);
      scene.deployMask = Bt.deployMask(b);
      scene.deployAlpha = 0.13 + 0.3 * flash;
    }
    if (G.hover && G.hover.id) {
      const c = Bt.building(b, G.hover.id);
      if (c && c.atk && !c.dead && c.atk.range > 1.5) scene.ranges.push({ x: c.x + c.w / 2, y: c.y + c.h / 2, r: c.atk.range, min: c.atk.minRange, col: 'rgba(255,120,90,0.7)', fill: 'rgba(255,80,60,0.06)' });
    }
  }

  function buildScene(dt) {
    const scene = { buildings: [], units: [], projectiles: [], beams: [], highlights: [], ranges: [], ghost: null };
    if (G.mode === 'raid' && (G.battle || G.lastBattle)) raidScene(dt, scene);
    else homeScene(dt, scene);
    return scene;
  }

  // ---------------------------------------------------------------- battle events -> effects and sound
  function battleEvents(b, events) {
    const home = b.kind === 'defense';
    events.forEach(function (e) {
      switch (e.t) {
        case 'deploy': R.emit('poof', e.x, e.y); sfx('deploy'); break;
        case 'destroyed': {
          R.emit('debris', e.x, e.y, 0, { w: e.w, n: e.k === 'wall' ? 6 : 16 });
          if (e.k !== 'wall') R.emit('boom', e.x, e.y, 10, { r: Math.min(2, e.w / 2) });
          const def = C.buildings[e.k];
          if (!home && (def.produces || def.stores || e.k === 'core')) R.emit('coins', e.x, e.y, 30, { col: def.produces === 'energy' || def.stores === 'energy' ? '#c48bff' : '#f2c23a' });
          sfx(e.k === 'wall' ? 'wallBreak' : 'destroy');
          if (e.k === 'core') R.emit('text', e.x, e.y, 90, { text: home ? 'Core destroyed!' : 'Core down!', col: '#ffd34d', size: 20 });
          break;
        }
        case 'death': R.emit('poof', e.x, e.y); sfx('death'); break;
        case 'hit': R.emit('spark', e.x, e.y, 12); sfx('hit'); break;
        case 'shoot': sfx(e.k === 'orb' ? 'orb' : 'bow'); break;
        case 'fire':
          R.recoil(e.id);
          if (e.k === 'blaster') R.emit('muzzle', e.x, e.y, 30);
          sfx(e.k);
          break;
        case 'boom': R.emit('boom', e.x, e.y, 4, { r: e.r, col: e.k === 'mine' ? '#ffe36e' : undefined }); sfx(e.k === 'shell' ? 'mortarHit' : 'boom'); break;
        case 'impact': if (e.k === 'orb') R.emit('spark', e.x, e.y, 14, { col: '#d79bff' }); else if (e.k === 'ball') R.emit('spark', e.x, e.y, 12, { col: '#ffcf70' }); break;
        case 'mineArm': R.emit('text', e.x, e.y, 20, { text: '!', col: '#ff5a4a', size: 18 }); sfx('mine'); break;
        case 'frost': R.pulse(e.id); sfx('frost'); break;
        case 'heal': R.emit('heal', e.x, e.y); sfx('heal'); break;
        case 'end': break;
      }
    });
  }

  function stepBattle(dt) {
    const b = G.battle;
    if (!b.ended && b.phase === 'fight') {
      G.acc += dt * G.speed;
      let n = 0;
      while (G.acc >= Bt.TICK && n < 12 && !b.ended) { Bt.step(b); G.acc -= Bt.TICK; n++; }
      if (G.acc > Bt.TICK * 2) G.acc = 0;
    }
    battleEvents(b, Bt.takeEvents(b));
    if (b.ended) {
      if (!G.ending) G.ending = performance.now() + 1500;
      else if (performance.now() >= G.ending) finishBattle();
    }
  }

  // ---------------------------------------------------------------- main loop
  let lastFrame = 0, stepAcc = 0, threatAcc = 0, saveAcc = 0, uiAcc = 0;
  const reported = {};

  function update(dt) {
    const st = G.state, t = now();
    stepAcc += dt;
    if (stepAcc >= 0.2) {
      stepAcc = 0;
      if (t - st.lastTick > 3000) G.sync('drift');
      else handleEvents(Time.step(st, t));
    }
    if (G.battle && !G.paused) {
      stepBattle(dt);
      G.battleWall = now();
    }
    threatAcc += dt;
    if (threatAcc >= 1 && !G.paused) {
      threatAcc = 0;
      threatCtx.busy = !!G.battle || G.mode !== 'village';
      if (!G.battle) Threat.update(st, t, threatCtx);
      else if (st.threat.next) Threat.update(st, t, threatCtx);
    }
    saveAcc += dt;
    if (saveAcc >= C.autosaveSec) { saveAcc = 0; G.save(); }
    uiAcc += dt;
    if (uiAcc >= 0.25) { uiAcc = 0; CS.UI.tick(); CS.Tutorial.update(); }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    let dt = lastFrame ? (ts - lastFrame) / 1000 : 1 / 60;
    lastFrame = ts;
    if (dt > 2.5) { G.sync('gap'); dt = 1 / 60; }    // the computer slept or the browser froze the tab
    dt = Math.min(dt, 0.1);
    G.time += dt;
    try {
      update(dt);
      if (G.paused) R.cam.x += Math.sin(G.time * 0.15) * 0.15;
      R.draw(buildScene(dt), G.time, dt);
    } catch (e) {
      const key = String(e && e.message);
      if (!reported[key]) { reported[key] = true; console.error(e); }
    }
  }

  // ---------------------------------------------------------------- visibility & lifecycle
  function onHidden() {
    if (!G.state) return;
    G.hiddenAt = now();
    G.save();
    CS.Audio.suspend();
  }

  function onVisible() {
    lastFrame = 0;
    CS.Audio.resume();
    G.sync('visible');
  }

  G.play = function () {
    if (!G.paused) return;
    G.paused = false;
    G.battleWall = now();
    CS.Audio.unlock();
    CS.UI.hideTitle();
    if (G.mode === 'raid') { CS.UI.enterRaid(); CS.Audio.music('battle'); }
    else if (G.mode === 'defense') { CS.UI.enterDefense(); CS.Audio.music('battle'); }
    else { CS.UI.enterVillage(); CS.Audio.music('village'); }
    const pending = G.pending;
    G.pending = [];
    pending.forEach(function (rep) { CS.UI.awayReport(rep); });
    if (G.result) CS.UI.raidResults(G.result);
    CS.Tutorial.start();
    refresh();
  };

  // Restores a battle saved mid-fight, advancing it by the time the game was closed.
  function resumeBattle(t) {
    const st = G.state, snap = st.battle;
    st.battle = null;
    if (!snap) return;
    try {
      const b = Bt.restore(snap);
      G.battle = b;
      G.mode = b.kind === 'attack' ? 'raid' : 'defense';
      const away = Math.max(0, (t - (st.savedAt || t)) / 1000);
      if (away > 1) fastForwardBattle(away);
      if (b.kind === 'attack') G.troopSel = G.firstTroop();
      if (b.ended) finishBattle();
    } catch (e) {
      console.warn('Could not resume the saved battle', e);
      G.battle = null;
      G.mode = 'village';
    }
  }

  G.boot = function () {
    R.init(U.$('view'));
    const t = now();
    const loaded = CS.State.load(t);
    G.state = loaded.state;
    CS.Audio.init(G.state.settings);
    CS.UI.init(G);
    CS.Input.init(G);
    CS.Tutorial.init(G);
    resumeBattle(t);
    G.sync('load');
    G.refreshGround();
    if (G.mode === 'raid' && (G.battle || G.lastBattle)) R.fitArea(C.tiers[NPC.def((G.battle || G.lastBattle).targetId).tier].area + 6);
    else G.home();
    CS.Bus.on('collected', function (e) {
      const b = Base.find(G.state, e.id);
      if (!b) return;
      const r = Base.rect(b);
      R.emit('text', r.x + r.w / 2, r.y + r.h / 2, 64, { text: '+' + U.fmt(e.amount), col: e.res === 'credits' ? '#ffd84a' : '#d9a6ff' });
      R.emit('coins', r.x + r.w / 2, r.y + r.h / 2, 40, { col: e.res === 'credits' ? '#f2c23a' : '#c48bff' });
      sfx(e.res === 'credits' ? 'coins' : 'energy');
    });
    CS.Bus.on('player:level', function (e) { toast('Commander level ' + e.level + '!', 'good'); sfx('levelup'); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) onHidden(); else onVisible(); });
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('pageshow', function (e) { if (e.persisted) onVisible(); });
    window.addEventListener('focus', function () { if (G.state && now() - G.state.lastTick > 3000) G.sync('focus'); });
    window.addEventListener('beforeunload', function () { G.save(); });
    window.addEventListener('resize', function () { R.resize(); });
    G.save();
    CS.UI.showTitle(loaded);
    requestAnimationFrame(frame);
  };

  // Test hook: lets automated checks inspect the game and simulate time passing.
  window.__clash = {
    G: G, CS: CS,
    advance: function (ms) { CS.Clock.offset += ms; return G.sync('debug'); },
    hide: onHidden, show: onVisible
  };

  CS.Game = G;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', G.boot);
  else G.boot();
})(window.CS = window.CS || {});
