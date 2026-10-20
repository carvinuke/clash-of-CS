/*
 * Real-time battle simulation shared by player raids and NPC attacks on the home base.
 *
 * The simulation runs in fixed ticks (CONFIG.battle.tickRate per second) and keeps all of its
 * state in plain data (no references between objects, ids only) so a battle can be saved to
 * localStorage mid-fight, restored after a reload and fast-forwarded deterministically. All
 * randomness comes from the battle's own seeded generator. Rendering never changes the outcome:
 * the renderer only reads state and the short-lived event list.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U;
  const TR = C.battle.tickRate, TICK = 1 / TR;
  const S = C.grid.size;
  const B = { TR: TR, TICK: TICK };

  function rnd(b) {
    let t = (b.seed = (b.seed + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function tileOf(x, y) {
    const tx = U.clamp(Math.floor(x), 0, S - 1), ty = U.clamp(Math.floor(y), 0, S - 1);
    return ty * S + tx;
  }

  // Runtime-only event log for the renderer; damage numbers get their own share so a long
  // fight never crowds out deaths and explosions.
  function ev(b, e) {
    const rt = b._rt;
    if (rt.silent) return;
    if (rt.events.length < (e.t === 'dmg' ? 400 : 800)) rt.events.push(e);
  }

  // ---------------------------------------------------------------- creation
  /*
   * o: { kind: 'attack'|'defense', seed, biome, name, targetId, attackerId,
   *      buildings: [{id,type,level,x,y,w,h,rot,hp?,func?,loot?}], troops: {type: n},
   *      troopLevels: {type: lv}, timeLimit (s), maxDestruction, defHpMult, defDmgMult,
   *      guards: [{type, lv, x, y}] (heroes defending the home base) }
   */
  B.create = function (o) {
    const b = {
      v: 1,
      kind: o.kind,
      seed: (o.seed >>> 0) || 1,
      biome: o.biome || 'meadow',
      name: o.name || '',
      targetId: o.targetId || null,
      attackerId: o.attackerId || null,
      tick: 0,
      limit: Math.round(o.timeLimit * TR),
      maxDestruction: o.maxDestruction || 1,
      phase: o.kind === 'attack' ? 'scout' : 'fight',
      buildings: [], units: [], proj: [], ai: [], guards: [],
      nextId: 1,
      pool: {}, deployed: {}, lost: {},
      deployedAny: false,
      troopLv: Object.assign({}, o.troopLevels || {}),
      loot: { credits: 0, energy: 0 },
      destroyed: 0, total: 0, coreDown: false,
      ended: false, endReason: null,
      stats: { dmg: {} },
      meta: o.meta || {}
    };
    Object.keys(o.troops || {}).forEach(function (t) { if (o.troops[t] > 0) b.pool[t] = o.troops[t]; });
    o.buildings.forEach(function (s) { addBuilding(b, s, o); });
    (o.guards || []).forEach(function (g) { addGuard(b, g); });
    b.total = b.buildings.filter(function (c) { return !c.wall && !c.trap; }).length;
    hydrate(b);
    return b;
  };

  function addBuilding(b, s, o) {
    const def = C.buildings[s.type];
    const lv = U.clamp(s.level || 1, 1, def.levels.length);
    const L = def.levels[lv - 1];
    const hpMult = (def.category === 'defense' || def.category === 'wall') ? (o.defHpMult || 1) : 1;
    const maxHp = Math.max(1, Math.round(L.hp * hpMult));
    const loot = s.loot ? { credits: s.loot.credits || 0, energy: s.loot.energy || 0 } : null;
    const c = {
      id: s.id, type: s.type, level: lv, x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot || 0,
      maxHp: maxHp, hp: s.hp != null ? U.clamp(s.hp, 1, maxHp) : maxHp,
      dead: false, func: s.func !== false,
      wall: def.category === 'wall', trap: def.category === 'trap',
      def: def.category === 'defense' || def.category === 'trap',
      res: !!(def.produces || def.stores), core: s.type === 'core',
      loot: loot, lootLeft: loot ? { credits: loot.credits, energy: loot.energy } : null,
      hidden: !!s.hidden, atk: null, cd: 0, tgt: 0, ramp: 0, armed: true, trig: -1, spent: false, hitT: -999
    };
    if (def.attack) {
      const A = def.attack;
      c.atk = {
        kind: A.kind, range: A.range, minRange: A.minRange || 0,
        period: Math.max(1, Math.round((A.period || 1) * TR)),
        dmg: L.dmg * (o.defDmgMult || 1), splash: A.splash || 0, slow: L.slow || 0, ground: !!A.ground,
        speed: (A.projectileSpeed || 0) * TICK,
        flight: Math.round((A.flight || 0) * TR), delay: Math.round((A.delay || 0) * TR),
        rampPerSec: A.rampPerSec || 0, rampMax: A.rampMax || 1
      };
      c.cd = Math.floor(rnd(b) * c.atk.period);
    }
    b.buildings.push(c);
  }

  // A defending hero: stands at its home and fights raiders that come within guardRadius of it.
  function addGuard(b, g) {
    const T = C.troops[g.type];
    const i = U.clamp(g.lv || 1, 1, T.hp.length) - 1;
    b.guards.push({
      id: b.nextId++, type: g.type, lv: i + 1, x: g.x, y: g.y, px: g.x, py: g.y, hx: g.x, hy: g.y,
      hp: T.hp[i], maxHp: T.hp[i], dmg: T.dmg[i], period: Math.max(1, Math.round(T.period * TR)),
      range: T.range, speed: T.speed * TICK, cd: 0, tgt: 0, dead: false, face: 1, atkT: -999, hitT: -999, dealt: 0
    });
  }

  // ---------------------------------------------------------------- runtime (not saved)
  function hydrate(b) {
    b._rt = {
      occ: new Int32Array(S * S), deploy: new Uint8Array(S * S),
      bById: new Map(), units: new Map(), pathCache: new Map(),
      events: [], silent: false, anyDead: false, cells: new Map()
    };
    b.buildings.forEach(function (c) { b._rt.bById.set(c.id, c); });
    b.units.forEach(function (u) { if (!u.dead) b._rt.units.set(u.id, u); });
    rebuildOcc(b);
    rebuildDeploy(b);
    return b;
  }

  function rebuildOcc(b) {
    const occ = b._rt.occ;
    occ.fill(0);
    b.buildings.forEach(function (c, i) {
      if (c.dead || c.trap) return;
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) occ[y * S + x] = i + 1;
    });
  }

  // Troops may only be dropped on tiles that are not next to a standing building.
  function rebuildDeploy(b) {
    const dep = b._rt.deploy;
    const m = C.grid.deployMargin;
    dep.fill(1);
    b.buildings.forEach(function (c) {
      if (c.dead || c.trap) return;
      const x0 = Math.max(0, c.x - m), y0 = Math.max(0, c.y - m);
      const x1 = Math.min(S, c.x + c.w + m), y1 = Math.min(S, c.y + c.h + m);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) dep[y * S + x] = 0;
    });
  }

  B.serialize = function (b) {
    return JSON.parse(JSON.stringify(b, function (k, v) { return k === '_rt' ? undefined : v; }));
  };

  B.isValidSnapshot = function (s) {
    return !!s && typeof s === 'object' && s.v === 1 && (s.kind === 'attack' || s.kind === 'defense') &&
      Array.isArray(s.buildings) && Array.isArray(s.units) && Array.isArray(s.proj) && Array.isArray(s.ai) &&
      isFinite(s.tick) && isFinite(s.limit) && s.buildings.every(function (c) { return c && C.buildings[c.type]; }) &&
      s.units.every(function (u) { return u && C.troops[u.type]; }) &&
      (!s.guards || (Array.isArray(s.guards) && s.guards.every(function (g) { return g && C.troops[g.type]; })));
  };

  B.restore = function (snap) { return hydrate(snap); };

  B.takeEvents = function (b) {
    const e = b._rt.events;
    b._rt.events = [];
    return e;
  };

  B.building = function (b, id) { return b._rt.bById.get(id) || null; };
  B.unit = function (b, id) { return b._rt.units.get(id) || null; };
  B.guard = function (b, id) {
    const gs = b.guards || [];
    for (let i = 0; i < gs.length; i++) if (gs[i].id === id && !gs[i].dead) return gs[i];
    return null;
  };
  B.timeLeft = function (b) { return Math.max(0, (b.limit - b.tick) / TR); };
  B.destruction = function (b) { return b.total ? b.destroyed / b.total : 1; };
  B.poolTotal = function (b) {
    let n = 0;
    Object.keys(b.pool).forEach(function (k) { n += b.pool[k]; });
    return n;
  };
  B.deployMask = function (b) { return b._rt.deploy; };

  // ---------------------------------------------------------------- deployment
  B.canDeploy = function (b, x, y) {
    if (!(x >= 0.05 && y >= 0.05 && x < S - 0.05 && y < S - 0.05)) return false;
    return b._rt.deploy[tileOf(x, y)] === 1;
  };

  // summoned: brought in by a hero's ability; not part of the player's army, so never counted in
  // deployed, lost or survived.
  function spawnUnit(b, type, x, y, summoned) {
    const T = C.troops[type];
    const lv = U.clamp(b.troopLv[type] || 1, 1, T.hp.length);
    const i = lv - 1;
    const u = {
      id: b.nextId++, type: type, lv: lv, x: x, y: y, px: x, py: y, sx: x, sy: y,
      hp: T.hp[i], maxHp: T.hp[i], dmg: T.dmg[i],
      period: T.period ? Math.max(1, Math.round(T.period * TR)) : 1,
      range: T.range, speed: T.speed * TICK,
      cd: 0, tgt: 0, tgtU: 0, obs: 0, path: null, pi: 0, slowT: 0, slowF: 0,
      dead: false, face: 1, atkT: -999, hitT: -999, stuck: 0, repathAt: 0, born: b.tick,
      ox: (rnd(b) - 0.5) * 0.36, oy: (rnd(b) - 0.5) * 0.36,
      air: !!T.air, sum: summoned ? 1 : 0, chg: 0,
      ab: 0, abT: 0, hideT: 0, buffT: 0       // hero ability used / aura ticks left / cloak ticks left / rally buff ticks left
    };
    b.units.push(u);
    b._rt.units.set(u.id, u);
    if (!summoned) {
      b.deployed[type] = (b.deployed[type] || 0) + 1;
      b.deployedAny = true;
    }
    ev(b, { t: 'deploy', x: x, y: y, k: type });
    return u;
  }

  B.deploy = function (b, type, x, y) {
    if (b.ended) return { ok: false, reason: 'ended' };
    if (!(b.pool[type] > 0)) return { ok: false, reason: 'none' };
    if (!B.canDeploy(b, x, y)) return { ok: false, reason: 'zone' };
    b.pool[type]--;
    spawnUnit(b, type, x, y);
    if (b.phase === 'scout') b.phase = 'fight';
    return { ok: true };
  };

  B.begin = function (b) { if (b.phase === 'scout') b.phase = 'fight'; };

  // The deployed, living hero of this type, or null.
  B.hero = function (b, type) {
    for (let i = 0; i < b.units.length; i++) if (b.units[i].type === type && !b.units[i].dead && !b.units[i].sum) return b.units[i];
    return null;
  };

  B.abilityReady = function (b, type) {
    const u = B.hero(b, type);
    return !!u && !u.ab && !b.ended;
  };

  // Fires a deployed hero's one ability for this battle.
  B.ability = function (b, type) {
    const u = B.hero(b, type), H = C.heroes[type];
    if (!H || !u || u.ab || b.ended) return { ok: false };
    const A = H.ability, i = U.clamp(u.lv, 1, A.sec.length) - 1;
    u.ab = 1;
    u.hp = Math.min(u.maxHp, u.hp + Math.round(u.maxHp * A.heal[i]));
    if (A.kind === 'rally') {
      u.abT = Math.round(A.sec[i] * TR);
      for (let k = 0; k < A.summonN[i]; k++) {
        const a = k / A.summonN[i] * Math.PI * 2 + rnd(b);
        const x = U.clamp(u.x + Math.cos(a) * 0.8, 0.1, S - 0.1), y = U.clamp(u.y + Math.sin(a) * 0.8, 0.1, S - 0.1);
        spawnUnit(b, A.summon, b._rt.occ[tileOf(x, y)] ? u.x : x, b._rt.occ[tileOf(x, y)] ? u.y : y, true);
      }
      ev(b, { t: 'ability', k: type, x: u.x, y: u.y, r: A.radius });
    } else {
      u.hideT = Math.round(A.sec[i] * TR);
      ev(b, { t: 'ability', k: type, x: u.x, y: u.y, r: 1 });
    }
    return { ok: true };
  };

  // Cloaked heroes cannot be targeted; ground-only defenses ignore flying troops.
  function canHit(A, u) { return !u.dead && !(u.hideT > 0) && !(A.ground && u.air); }   // "!(x > 0)": snapshots saved before heroes have no hideT

  B.surrender = function (b) { if (!b.ended) end(b, b.deployedAny ? 'retreat' : 'cancel'); };

  function nearDeploy(b, x, y) {
    const cx = Math.floor(x), cy = Math.floor(y);
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx, ty = cy + dy;
          if (tx < 0 || ty < 0 || tx >= S || ty >= S) continue;
          if (b._rt.deploy[ty * S + tx]) return { x: tx + 0.2 + rnd(b) * 0.6, y: ty + 0.2 + rnd(b) * 0.6 };
        }
      }
    }
    return null;
  }

  /*
   * NPC attack planner: scores approach directions (loot and the Command Core attract,
   * defenses repel), then schedules waves: tanks first, wall breakers behind them, then the rest.
   */
  B.planAI = function (b, army, delaySec) {
    const cands = [];
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2 + rnd(b) * 0.25;
      let px = -1, py = -1;
      for (let r = 3; r < S; r += 0.5) {
        const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
        if (x < 1 || y < 1 || x >= S - 1 || y >= S - 1) break;
        if (b._rt.deploy[tileOf(x, y)]) { px = x; py = y; break; }
      }
      if (px < 0) continue;
      let score = rnd(b) * 3;
      b.buildings.forEach(function (c) {
        if (c.dead || c.wall || c.trap) return;
        const d = Math.max(2, U.dist(px, py, c.x + c.w / 2, c.y + c.h / 2));
        if (c.atk && c.func) score -= 18 / d;
        else if (c.core) score += 26 / d;
        else if (c.res) score += 14 / d;
        else score += 4 / d;
      });
      cands.push({ x: px, y: py, a: a, score: score });
    }
    if (!cands.length) cands.push({ x: 1, y: 1, a: 0, score: 0 });
    cands.sort(function (p, q) { return q.score - p.score; });
    const points = [cands[0]];
    let space = 0;
    Object.keys(army).forEach(function (t) { space += (army[t] || 0) * C.troops[t].space; });
    if (space >= 24) {
      const second = cands.find(function (c) {
        let da = Math.abs(c.a - cands[0].a) % (Math.PI * 2);
        if (da > Math.PI) da = Math.PI * 2 - da;
        return da > Math.PI / 2;
      });
      if (second) points.push(second);
    }
    const order = ['colossus', 'bruiser', 'lancer', 'demo', 'scout', 'gyro', 'mage', 'ranger', 'mender'];
    const delays = { colossus: 0, bruiser: 0, lancer: 1.0, demo: 1.6, scout: 2.2, gyro: 2.6, mage: 3.0, ranger: 3.4, mender: 3.8 };
    let n = 0;
    order.forEach(function (type) {
      const cnt = army[type] || 0;
      for (let i = 0; i < cnt; i++) {
        const p = points[(i + n) % points.length];
        const spot = nearDeploy(b, p.x + (rnd(b) - 0.5) * 4, p.y + (rnd(b) - 0.5) * 4) || { x: p.x, y: p.y };
        const tick = Math.round(((delaySec == null ? 1 : delaySec) + delays[type] + i * 0.12) * TR);
        b.ai.push({ tick: tick, type: type, x: spot.x, y: spot.y });
      }
      n += cnt;
    });
    b.ai.sort(function (p, q) { return p.tick - q.tick; });
    b.meta.approach = points.map(function (p) { return { x: p.x, y: p.y }; });
  };

  function runAI(b) {
    while (b.ai.length && b.ai[0].tick <= b.tick) {
      const a = b.ai.shift();
      spawnUnit(b, a.type, a.x, a.y);
    }
  }

  // ---------------------------------------------------------------- damage
  function hurtBuilding(b, c, dmg) {
    if (c.dead) return;
    const before = c.hp;
    c.hp -= dmg;
    c.hitT = b.tick;
    const got = { credits: 0, energy: 0 };
    if (c.loot) {
      const frac = Math.min(before, dmg) / c.maxHp;
      ['credits', 'energy'].forEach(function (r) {
        if (c.lootLeft[r] > 0) {
          const take = Math.min(c.lootLeft[r], c.loot[r] * frac);
          c.lootLeft[r] -= take;
          b.loot[r] += take;
          got[r] = take;
        }
      });
    }
    ev(b, { t: 'dmg', id: c.id, b: 1, k: c.type, x: c.x + c.w / 2, y: c.y + c.h / 2, n: Math.min(before, dmg), lc: got.credits, le: got.energy });
    if (c.hp <= 0) destroyBuilding(b, c);
  }

  function destroyBuilding(b, c) {
    c.hp = 0;
    c.dead = true;
    let lc = 0, le = 0;
    if (c.loot) {
      lc = c.lootLeft.credits; le = c.lootLeft.energy;
      b.loot.credits += lc;
      b.loot.energy += le;
      c.lootLeft.credits = 0;
      c.lootLeft.energy = 0;
    }
    if (!c.wall && !c.trap) b.destroyed++;
    if (c.core) b.coreDown = true;
    rebuildOcc(b);
    rebuildDeploy(b);
    b._rt.pathCache.clear();
    ev(b, { t: 'destroyed', id: c.id, x: c.x + c.w / 2, y: c.y + c.h / 2, w: c.w, k: c.type, lc: lc, le: le });
  }

  function hurtUnit(b, u, dmg, src) {
    if (u.dead) return;
    const dealt = Math.min(u.hp, dmg);
    u.hp -= dmg;
    u.hitT = b.tick;
    if (src) b.stats.dmg[src.type] = (b.stats.dmg[src.type] || 0) + dealt;
    ev(b, { t: 'dmg', id: u.id, b: 0, k: u.type, x: u.x, y: u.y, n: dealt });
    if (u.hp <= 0) killUnit(b, u);
  }

  function killUnit(b, u) {
    u.dead = true;
    u.hp = 0;
    if (!u.sum) b.lost[u.type] = (b.lost[u.type] || 0) + 1;
    b._rt.units.delete(u.id);
    b._rt.anyDead = true;
    ev(b, { t: 'death', x: u.x, y: u.y, k: u.type });
  }

  function hurtGuard(b, g, dmg) {
    if (g.dead) return;
    const dealt = Math.min(g.hp, dmg);
    g.hp -= dmg;
    g.hitT = b.tick;
    ev(b, { t: 'dmg', id: g.id, b: 0, own: 1, k: g.type, x: g.x, y: g.y, n: dealt });
    if (g.hp <= 0) { g.hp = 0; g.dead = true; ev(b, { t: 'death', x: g.x, y: g.y, k: g.type }); }
  }

  // ---------------------------------------------------------------- troop behaviour
  function bById(b, id) { return b._rt.bById.get(id); }

  function inReach(u, c) { return U.distToRect(u.x, u.y, c.x, c.y, c.w, c.h) <= u.range + 0.08; }

  const RALLY = C.heroes.marshal.ability, CLOAK = C.heroes.huntress.ability;

  function moveToward(u, tx, ty) {
    const sp = u.speed * (u.slowT > 0 ? 1 - u.slowF : 1) * (u.buffT > 0 ? RALLY.speedMult : 1);
    const dx = tx - u.x, dy = ty - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-6) u.face = dx - dy >= 0 ? 1 : -1;
    if (d <= sp) { u.x = tx; u.y = ty; return true; }
    u.x += dx / d * sp;
    u.y += dy / d * sp;
    return false;
  }

  function approach(u, c) {
    moveToward(u, U.clamp(u.x, c.x, c.x + c.w), U.clamp(u.y, c.y, c.y + c.h));
  }

  function dpsVs(u, T, c) {
    let d = T.suicide ? u.dmg * (c.wall ? T.wallMult : T.structMult) : u.dmg / (T.period || 1);
    if (T.bonusVsResource && c.res) d *= T.bonusVsResource;
    return Math.max(1, d);
  }

  function search(b, start, t, range, step, costFn, relaxed) {
    const occ = b._rt.occ;
    return CS.Path.search({
      w: S, h: S, start: start, step: step,
      tileCost: function (i) {
        const o = occ[i];
        if (!o) return 0;
        const c = b.buildings[o - 1];
        return c.id === t.id ? Infinity : costFn(c);
      },
      isGoal: function (i) {
        if (!relaxed && occ[i]) return false;
        return U.distToRect((i % S) + 0.5, ((i / S) | 0) + 0.5, t.x, t.y, t.w, t.h) <= range + 0.35;
      },
      heuristic: function (i) {
        return Math.max(0, U.distToRect((i % S) + 0.5, ((i / S) | 0) + 0.5, t.x, t.y, t.w, t.h) - range - 0.35) * step;
      }
    });
  }

  function computePath(b, u, T, t) {
    const start = tileOf(u.x, u.y);
    const key = t.id + ':' + start + ':' + u.type + ':' + u.lv;
    let path = b._rt.pathCache.get(key);
    if (!path) {
      const cost = function (c) {
        const brk = c.hp / dpsVs(u, T, c);
        return c.wall ? brk : brk + C.battle.wallBreakPenalty;
      };
      path = search(b, start, t, u.range, 1 / T.speed, cost, false) ||
        search(b, start, t, u.range, 1 / T.speed, cost, true) || [];
      b._rt.pathCache.set(key, path);
    }
    u.path = path;
    u.pi = 0;
  }

  // How many working defenses cover a building (used by careful troops such as Rangers).
  function coverage(b, c) {
    let n = 0;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    b.buildings.forEach(function (d) {
      if (d.dead || !d.atk || !d.func || d === c || d.trap) return;
      if (U.dist(cx, cy, d.x + d.w / 2, d.y + d.h / 2) <= d.atk.range + 1) n++;
    });
    return n;
  }

  function acquire(b, u, T) {
    u.tgt = 0; u.path = null; u.obs = 0;
    if (T.target === 'wall') return acquireDemo(b, u, T);
    if (T.air) u.path = [];
    let best = null, bestS = Infinity, pref = null, prefS = Infinity;
    b.buildings.forEach(function (c) {
      if (c.dead || c.wall || c.trap) return;
      let s = U.distToRect(u.x, u.y, c.x, c.y, c.w, c.h);
      if (T.careful) s += 3.5 * coverage(b, c);
      if (s < bestS) { bestS = s; best = c; }
      if ((T.target === 'defense' && c.def) || (T.target === 'resource' && c.res)) {
        if (s < prefS) { prefS = s; pref = c; }
      }
    });
    const t = pref || best;
    if (!t) return null;
    u.tgt = t.id;
    if (!T.air) computePath(b, u, T, t);
    return t;
  }

  // Demolishers look at the route a soldier would take and target the first wall on it.
  function acquireDemo(b, u, T) {
    let goal = null, gs = Infinity;
    b.buildings.forEach(function (c) {
      if (c.dead || c.wall || c.trap) return;
      const s = U.distToRect(u.x, u.y, c.x, c.y, c.w, c.h);
      if (s < gs) { gs = s; goal = c; }
    });
    let t = null;
    if (goal) {
      const probe = search(b, tileOf(u.x, u.y), goal, 0.6, 1 / 1.5, function (c) {
        return c.hp / 15 + (c.wall ? 0 : C.battle.wallBreakPenalty);
      }, false);
      if (probe) {
        for (let i = 0; i < probe.length && !t; i++) {
          const o = b._rt.occ[probe[i]];
          if (o && b.buildings[o - 1].wall) t = b.buildings[o - 1];
        }
      }
      if (!t) t = goal;
    } else {
      b.buildings.forEach(function (c) {
        if (c.dead || !c.wall) return;
        const s = U.distToRect(u.x, u.y, c.x, c.y, c.w, c.h);
        if (s < gs) { gs = s; t = c; }
      });
    }
    if (!t) return null;
    u.tgt = t.id;
    computePath(b, u, T, t);
    return t;
  }

  function demoBlast(b, u, T) {
    b.buildings.forEach(function (c) {
      if (c.dead || c.trap) return;
      if (U.distToRect(u.x, u.y, c.x, c.y, c.w, c.h) <= T.splash) hurtBuilding(b, c, u.dmg * (c.wall ? T.wallMult : T.structMult));
    });
    ev(b, { t: 'boom', x: u.x, y: u.y, r: T.splash, k: 'demo' });
    killUnit(b, u);
  }

  function attack(b, u, T, c) {
    u.face = (c.x + c.w / 2 - u.x) - (c.y + c.h / 2 - u.y) >= 0 ? 1 : -1;
    u.stuck = 0;
    if (u.cd > 0) return;
    u.cd = u.period;
    u.atkT = b.tick;
    if (T.suicide) { demoBlast(b, u, T); return; }
    let dmg = u.dmg;
    if (T.bonusVsResource && c.res) dmg *= T.bonusVsResource;
    if (u.buffT > 0) dmg *= RALLY.dmgMult;
    if (u.hideT > 0) dmg *= CLOAK.dmgMult;
    if (T.charge && u.chg !== c.id) { u.chg = c.id; dmg *= T.charge; ev(b, { t: 'charge', x: u.x, y: u.y }); }
    if (T.projectile) {
      b.proj.push({ id: b.nextId++, k: T.projectile, x: u.x, y: u.y, sx: u.x, sy: u.y, tx: 0, ty: 0, tgt: c.id, tb: 1, dmg: dmg, splash: T.splash || 0, spd: 10 * TICK, t: 0, dur: 0, src: 0 });
      ev(b, { t: 'shoot', x: u.x, y: u.y, k: T.projectile });
    } else if (T.splash) {
      // area strike centred on the point of contact: the gyro's bomb, the colossus's stomp
      const hx = U.clamp(u.x, c.x, c.x + c.w), hy = U.clamp(u.y, c.y, c.y + c.h);
      b.buildings.forEach(function (o) {
        if (!o.dead && !o.trap && U.distToRect(hx, hy, o.x, o.y, o.w, o.h) <= T.splash) hurtBuilding(b, o, dmg);
      });
      ev(b, { t: 'boom', x: hx, y: hy, r: T.splash, k: u.type });
    } else {
      hurtBuilding(b, c, dmg);
      ev(b, { t: 'hit', x: U.clamp(u.x, c.x, c.x + c.w), y: U.clamp(u.y, c.y, c.y + c.h), k: u.type });
    }
  }

  function followPath(b, u, T, t) {
    if (!u.path || u.pi >= u.path.length) {
      if (u.repathAt > b.tick) { approach(u, t); return; }
      u.repathAt = b.tick + TR;
      computePath(b, u, T, t);
      if (!u.path.length) { approach(u, t); return; }
    }
    const idx = u.path[u.pi];
    const o = b._rt.occ[idx];
    if (o) {
      const c = b.buildings[o - 1];
      if (!c.dead && c.id !== t.id) { u.obs = c.id; return; }
    }
    if (moveToward(u, (idx % S) + 0.5 + u.ox, ((idx / S) | 0) + 0.5 + u.oy)) u.pi++;
  }

  // Re-plans a troop that has made no progress for a few seconds so nothing stays stuck.
  function stuckCheck(b, u) {
    if ((b.tick + u.id) % TR !== 0) return;
    const moved = Math.abs(u.x - u.sx) + Math.abs(u.y - u.sy);
    u.sx = u.x; u.sy = u.y;
    if (moved < 0.15 && b.tick - u.atkT > TR) {
      if (++u.stuck >= 3) { u.stuck = 0; u.tgt = 0; u.obs = 0; u.path = null; }
    } else u.stuck = 0;
  }

  function updateMender(b, u, T) {
    let t = u.tgtU ? b._rt.units.get(u.tgtU) : null;
    if (!t || t.dead || b.tick % 15 === 0) {
      t = null;
      let best = Infinity;
      b.units.forEach(function (o) {
        if (o.dead || o === u || C.troops[o.type].target === 'troop') return;
        const s = (o.hp / o.maxHp) * 6 + U.dist(u.x, u.y, o.x, o.y) * 0.25;
        if (s < best) { best = s; t = o; }
      });
      u.tgtU = t ? t.id : 0;
    }
    if (t && U.dist(u.x, u.y, t.x, t.y) > 1) moveToward(u, t.x, t.y);
    if (u.cd === 0) {
      let healed = false;
      b.units.forEach(function (o) {
        if (o.dead || o === u || o.hp >= o.maxHp) return;
        if (U.dist(u.x, u.y, o.x, o.y) <= T.healRadius) { o.hp = Math.min(o.maxHp, o.hp + u.dmg); healed = true; }
      });
      if (healed) {
        u.cd = u.period;
        u.atkT = b.tick;
        ev(b, { t: 'heal', x: u.x, y: u.y, r: T.healRadius });
      }
    }
  }

  function nearestGuard(b, u, r) {
    let best = null, bd = r;
    b.guards.forEach(function (g) {
      if (g.dead) return;
      const d = U.dist(u.x, u.y, g.x, g.y);
      if (d <= bd) { bd = d; best = g; }
    });
    return best;
  }

  function fightGuard(b, u, T, g) {
    u.face = g.x - u.x - (g.y - u.y) >= 0 ? 1 : -1;
    u.stuck = 0;
    if (u.cd > 0) return;
    u.cd = u.period;
    u.atkT = b.tick;
    if (T.projectile) {
      b.proj.push({ id: b.nextId++, k: T.projectile, x: u.x, y: u.y, sx: u.x, sy: u.y, tx: 0, ty: 0, tgt: g.id, tb: 2, dmg: u.dmg, splash: 0, spd: 10 * TICK, t: 0, dur: 0, src: 0 });
      ev(b, { t: 'shoot', x: u.x, y: u.y, k: T.projectile });
    } else {
      hurtGuard(b, g, u.dmg);
      ev(b, { t: 'hit', x: g.x, y: g.y, k: u.type });
    }
  }

  // shortcut: guards walk straight lines through buildings; give them paths if that ever looks wrong.
  function updateGuard(b, g) {
    g.px = g.x; g.py = g.y;
    if (g.cd > 0) g.cd--;
    const T = C.troops[g.type], R = C.battle.guardRadius;
    const ok = function (u) { return u && !u.dead && !(u.air && !T.projectile) && U.dist(g.hx, g.hy, u.x, u.y) <= R; };
    let t = g.tgt ? b._rt.units.get(g.tgt) : null;
    if (!ok(t)) {
      t = null;
      let bd = Infinity;
      b.units.forEach(function (u) {
        if (!ok(u)) return;
        const d = U.dist(g.x, g.y, u.x, u.y);
        if (d < bd) { bd = d; t = u; }
      });
      g.tgt = t ? t.id : 0;
    }
    if (!t) { if (U.dist(g.x, g.y, g.hx, g.hy) > 0.2) moveToward(g, g.hx, g.hy); return; }
    if (U.dist(g.x, g.y, t.x, t.y) > g.range + 0.1) { moveToward(g, t.x, t.y); return; }
    g.face = t.x - g.x - (t.y - g.y) >= 0 ? 1 : -1;
    if (g.cd > 0) return;
    g.cd = g.period;
    g.atkT = b.tick;
    g.dealt += Math.min(t.hp, g.dmg);
    if (T.projectile) {
      b.proj.push({ id: b.nextId++, k: T.projectile, x: g.x, y: g.y, sx: g.x, sy: g.y, tx: 0, ty: 0, tgt: t.id, tb: 0, dmg: g.dmg, splash: 0, spd: 10 * TICK, t: 0, dur: 0, src: 0 });
      ev(b, { t: 'shoot', x: g.x, y: g.y, k: T.projectile });
    } else {
      hurtUnit(b, t, g.dmg, null);
      ev(b, { t: 'hit', x: t.x, y: t.y, k: g.type });
    }
  }

  // The War Cry aura: while it lasts, every troop within its radius (the Marshal included) is rallied.
  function rally(b, u) {
    u.abT--;
    const r2 = RALLY.radius * RALLY.radius;
    b.units.forEach(function (o) {
      if (o.dead) return;
      const dx = o.x - u.x, dy = o.y - u.y;
      if (dx * dx + dy * dy <= r2) o.buffT = Math.max(o.buffT, 2);
    });
  }

  function updateUnit(b, u) {
    u.px = u.x; u.py = u.y;
    if (u.cd > 0) u.cd--;
    if (u.slowT > 0 && --u.slowT === 0) u.slowF = 0;
    if (u.buffT > 0) u.buffT--;
    if (u.hideT > 0) u.hideT--;
    if (u.abT > 0) rally(b, u);
    const T = C.troops[u.type];
    if (T.target === 'troop') { updateMender(b, u, T); return; }
    // ground raiders fight back against a defending hero within reach (flyers and bombers ignore it)
    if (!T.air && !T.suicide && b.guards && b.guards.length) {
      const gd = nearestGuard(b, u, u.range + 0.4);
      if (gd) { fightGuard(b, u, T, gd); return; }
    }
    if (T.air) {
      // flyers ignore walls and paths: straight to the target, hovering over it while they bomb
      let t = u.tgt ? bById(b, u.tgt) : null;
      if (!t || t.dead) t = acquire(b, u, T);
      if (!t) return;
      if (inReach(u, t)) attack(b, u, T, t);
      else moveToward(u, t.x + t.w / 2, t.y + t.h / 2);
      return;
    }
    if (u.obs) {
      const ob = bById(b, u.obs);
      if (!ob || ob.dead) u.obs = 0;
      else {
        if (inReach(u, ob)) attack(b, u, T, ob);
        else { approach(u, ob); stuckCheck(b, u); }
        return;
      }
    }
    let t = u.tgt ? bById(b, u.tgt) : null;
    if (!t || t.dead) {
      t = acquire(b, u, T);
      if (!t) return;
    }
    if (inReach(u, t)) { attack(b, u, T, t); return; }
    followPath(b, u, T, t);
    stuckCheck(b, u);
  }

  // ---------------------------------------------------------------- defenses
  function inDefRange(A, cx, cy, u) {
    const d = U.dist(cx, cy, u.x, u.y);
    return d <= A.range && d >= A.minRange;
  }

  function pickNearest(b, A, cx, cy) {
    let best = null, bd = Infinity;
    b.units.forEach(function (u) {
      if (!canHit(A, u)) return;
      const d = U.dist(cx, cy, u.x, u.y);
      if (d <= A.range && d >= A.minRange && d < bd) { bd = d; best = u; }
    });
    return best;
  }

  // Mortar targeting: the attacker standing in the densest group.
  function pickCluster(b, A, cx, cy) {
    let best = null, bestN = -1, bestD = Infinity;
    const units = b.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!canHit(A, u) || !inDefRange(A, cx, cy, u)) continue;
      let n = 0;
      for (let j = 0; j < units.length; j++) {
        const o = units[j];
        if (!o.dead && !o.air && U.dist(u.x, u.y, o.x, o.y) <= A.splash) n++;
      }
      const d = U.dist(cx, cy, u.x, u.y);
      if (n > bestN || (n === bestN && d < bestD)) { best = u; bestN = n; bestD = d; }
    }
    return best;
  }

  function updateDefense(b, d) {
    const A = d.atk;
    if (!d.func || d.spent) return;
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    if (A.kind === 'mine') {
      if (d.armed) {
        for (let i = 0; i < b.units.length; i++) {
          const u = b.units[i];
          if (!u.dead && !u.air && u.type !== 'mender' && U.dist(cx, cy, u.x, u.y) <= A.range) {
            d.armed = false; d.trig = b.tick; d.hidden = false;
            ev(b, { t: 'mineArm', id: d.id, x: cx, y: cy });
            break;
          }
        }
      } else if (b.tick - d.trig >= A.delay) {
        b.units.forEach(function (u) { if (!u.dead && !u.air && U.dist(cx, cy, u.x, u.y) <= A.splash) hurtUnit(b, u, A.dmg, d); });
        d.spent = true;
        ev(b, { t: 'boom', x: cx, y: cy, r: A.splash, k: 'mine' });
      }
      return;
    }
    if (d.cd > 0) d.cd--;
    if (A.kind === 'frost') {
      if (d.cd > 0) return;
      let hit = 0;
      b.units.forEach(function (u) {
        if (!canHit(A, u) || U.dist(cx, cy, u.x, u.y) > A.range) return;
        hurtUnit(b, u, A.dmg, d);
        u.slowT = A.period + 6;
        u.slowF = Math.max(u.slowF, A.slow);
        hit++;
      });
      d.cd = A.period;
      d.tgt = hit ? 1 : 0;
      if (hit) ev(b, { t: 'frost', id: d.id, x: cx, y: cy, r: A.range });
      return;
    }
    let t = d.tgt ? b._rt.units.get(d.tgt) : null;
    if (t && (!canHit(A, t) || !inDefRange(A, cx, cy, t))) t = null;
    if (A.kind === 'mortar') {
      if (d.cd > 0) return;
      t = pickCluster(b, A, cx, cy);
      if (!t) return;
      d.cd = A.period;
      d.tgt = t.id;
      b.proj.push({ id: b.nextId++, k: 'shell', x: cx, y: cy, sx: cx, sy: cy, tx: t.x, ty: t.y, tgt: 0, tb: 0, dmg: A.dmg, splash: A.splash, spd: 0, t: 0, dur: Math.max(1, A.flight), src: d.id });
      ev(b, { t: 'fire', id: d.id, k: 'mortar', x: cx, y: cy });
      return;
    }
    if (!t) t = pickNearest(b, A, cx, cy);
    if (A.kind === 'lance') {
      if (!t) { d.tgt = 0; d.ramp = 0; return; }
      if (t.id !== d.tgt) { d.tgt = t.id; d.ramp = 0; }
      d.ramp++;
      hurtUnit(b, t, A.dmg * Math.min(A.rampMax, 1 + A.rampPerSec * d.ramp * TICK) * TICK, d);
      return;
    }
    d.tgt = t ? t.id : 0;
    if (!t || d.cd > 0) return;
    d.cd = A.period;
    b.proj.push({ id: b.nextId++, k: A.kind === 'blaster' ? 'ball' : 'bolt', x: cx, y: cy, sx: cx, sy: cy, tx: 0, ty: 0, tgt: t.id, tb: 0, dmg: A.dmg, splash: 0, spd: A.speed, t: 0, dur: 0, src: d.id });
    ev(b, { t: 'fire', id: d.id, k: A.kind, x: cx, y: cy });
  }

  // ---------------------------------------------------------------- projectiles
  function updateProjectiles(b) {
    const P = b.proj;
    let w = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      let keep = true;
      if (p.dur) {
        p.t++;
        const f = Math.min(1, p.t / p.dur);
        p.x = p.sx + (p.tx - p.sx) * f;
        p.y = p.sy + (p.ty - p.sy) * f;
        if (p.t >= p.dur) {
          keep = false;
          const src = bById(b, p.src);
          b.units.forEach(function (u) { if (!u.dead && !u.air && U.dist(p.tx, p.ty, u.x, u.y) <= p.splash) hurtUnit(b, u, p.dmg, src); });
          ev(b, { t: 'boom', x: p.tx, y: p.ty, r: p.splash, k: 'shell' });
        }
      } else {
        // tb: 1 = building, 2 = defending hero, 0 = attacking troop
        const bld = p.tb === 1;
        const target = bld ? bById(b, p.tgt) : p.tb === 2 ? B.guard(b, p.tgt) : b._rt.units.get(p.tgt);
        if (!target || target.dead) keep = false;
        else {
          const tx = bld ? target.x + target.w / 2 : target.x;
          const ty = bld ? target.y + target.h / 2 : target.y;
          const dx = tx - p.x, dy = ty - p.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const reach = bld ? Math.min(target.w, target.h) * 0.4 : 0.05;
          if (d <= p.spd + reach) {
            keep = false;
            if (p.tb === 2) hurtGuard(b, target, p.dmg);
            else if (bld) {
              if (p.splash) {
                b.buildings.forEach(function (c) {
                  if (!c.dead && !c.trap && U.distToRect(p.x, p.y, c.x, c.y, c.w, c.h) <= p.splash) hurtBuilding(b, c, p.dmg);
                });
              } else hurtBuilding(b, target, p.dmg);
            } else hurtUnit(b, target, p.dmg, bById(b, p.src));
            ev(b, { t: 'impact', x: p.x, y: p.y, k: p.k });
          } else {
            p.x += dx / d * p.spd;
            p.y += dy / d * p.spd;
          }
        }
      }
      if (keep) P[w++] = p;
    }
    P.length = w;
  }

  // ---------------------------------------------------------------- crowd separation
  function walkable(b, x, y) {
    if (x < 0.05 || y < 0.05 || x > S - 0.05 || y > S - 0.05) return false;
    return !b._rt.occ[tileOf(x, y)];
  }

  // Pushes overlapping troops apart (spatial hash keeps it linear in the troop count).
  function separate(b) {
    const units = b.units;
    if (units.length < 2) return;
    const cells = b._rt.cells;
    cells.clear();
    units.forEach(function (u) {
      if (u.dead || u.type === 'mender' || u.air) return;
      const k = tileOf(u.x, u.y);
      const arr = cells.get(k);
      if (arr) arr.push(u); else cells.set(k, [u]);
    });
    const R = 0.38, R2 = R * R;
    units.forEach(function (u) {
      if (u.dead || u.type === 'mender' || u.air) return;
      const tx = Math.floor(u.x), ty = Math.floor(u.y);
      let px = 0, py = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= S || y >= S) continue;
          const arr = cells.get(y * S + x);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const o = arr[i];
            if (o === u) continue;
            const ddx = u.x - o.x, ddy = u.y - o.y;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 >= R2) continue;
            if (d2 < 1e-8) { px += o.id < u.id ? 0.03 : -0.03; continue; }
            const d = Math.sqrt(d2);
            const f = (R - d) / d * 0.25;
            px += ddx * f; py += ddy * f;
          }
        }
      }
      if (px || py) {
        const nx = u.x + px, ny = u.y + py;
        if (walkable(b, nx, ny)) { u.x = nx; u.y = ny; }
      }
    });
  }

  // ---------------------------------------------------------------- step & end
  function end(b, reason) {
    b.ended = true;
    b.endReason = reason;
    ev(b, { t: 'end', reason: reason });
  }

  function checkEnd(b) {
    const destr = B.destruction(b);
    if (destr >= 1) return end(b, 'wiped');
    if (b.tick >= b.limit) return end(b, 'time');
    if (b.kind === 'defense' && destr >= b.maxDestruction) return end(b, 'withdraw');
    if (b.ai.length) return;
    for (let i = 0; i < b.units.length; i++) {
      const u = b.units[i];
      if (!u.dead && u.type !== 'mender') return;
    }
    let left = 0;
    Object.keys(b.pool).forEach(function (k) { if (k !== 'mender') left += b.pool[k]; });
    if (!left && b.deployedAny) end(b, 'troops');
  }

  B.step = function (b) {
    if (b.ended || b.phase !== 'fight') return;
    b.tick++;
    if (b.ai.length) runAI(b);
    const units = b.units;
    for (let i = 0; i < units.length; i++) if (!units[i].dead) updateUnit(b, units[i]);
    const gs = b.guards || [];
    for (let i = 0; i < gs.length; i++) if (!gs[i].dead) updateGuard(b, gs[i]);
    const bl = b.buildings;
    for (let i = 0; i < bl.length; i++) if (bl[i].atk && !bl[i].dead) updateDefense(b, bl[i]);
    updateProjectiles(b);
    separate(b);
    if (b._rt.anyDead) {
      b.units = b.units.filter(function (u) { return !u.dead; });
      b._rt.anyDead = false;
    }
    checkEnd(b);
  };

  // Advances a battle without rendering (offline resolution and catch-up after a hidden tab).
  B.fastForward = function (b, ticks) {
    const rt = b._rt;
    const silent = rt.silent;
    rt.silent = true;
    let n = 0;
    while (n < ticks && !b.ended && b.phase === 'fight') { B.step(b); n++; }
    rt.silent = silent;
    return n;
  };

  B.runToEnd = function (b) {
    B.begin(b);
    return B.fastForward(b, b.limit + 10);
  };

  B.result = function (b) {
    const destr = B.destruction(b);
    const stars = (destr >= C.battle.winDestruction ? 1 : 0) + (b.coreDown ? 1 : 0) + (destr >= 1 ? 1 : 0);
    const survived = {}, heroHp = {};
    b.units.forEach(function (u) { if (!u.dead && !u.sum) survived[u.type] = (survived[u.type] || 0) + 1; });
    // health each hero ended on (0 if it fell, 1 if it never left the tray)
    C.heroOrder.forEach(function (h) {
      if (b.pool[h] > 0) heroHp[h] = 1;
      else if (b.deployed[h]) { const u = B.hero(b, h); heroHp[h] = u ? u.hp / u.maxHp : 0; }
    });
    Object.keys(b.pool).forEach(function (k) { if (b.pool[k] > 0) survived[k] = (survived[k] || 0) + b.pool[k]; });
    return {
      destruction: destr, stars: stars, victory: destr >= C.battle.winDestruction || b.coreDown,
      coreDown: b.coreDown, loot: { credits: Math.floor(b.loot.credits), energy: Math.floor(b.loot.energy) },
      lost: Object.assign({}, b.lost), deployed: Object.assign({}, b.deployed), survived: survived,
      destroyed: b.destroyed, total: b.total, reason: b.endReason, seconds: b.tick / TR,
      dmg: Object.assign({}, b.stats.dmg), heroHp: heroHp,
      guards: (b.guards || []).map(function (g) { return { type: g.type, hp: g.hp / g.maxHp, dealt: Math.round(g.dealt) }; })
    };
  };

  CS.Battle = B;
})(window.CS = window.CS || {});
