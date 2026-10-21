// Balance simulator: runs many seeded headless raids at every Command Core level and prints
// win rates, destruction, loot and per-troop / per-defense efficiency tables.
// Run from the repository root: node tests/balance-sim.js [cores, e.g. 1-9 or 4,5] [runs per matchup]
// SIM_MONO=a,b limits the single-troop armies to those troops. SIM_DEFENSE_ONLY=1 skips the attack matchups and only simulates NPC raids on the home base.
// Players are modelled as "maxed for their core": every building at the best level that core allows,
// troops researched to the Lab cap, heroes and spells at their building's level.
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
const store = {};
const ctx = { console: Object.assign({}, console, { warn: function () {} }), Math, Date, JSON, Map, Set, Int32Array, Uint8Array, Uint32Array, Int8Array, Float64Array, Float32Array, Int16Array, Array, Object, Number, String, isFinite, Infinity, NaN, setTimeout, clearTimeout };
ctx.window = ctx;
ctx.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
vm.createContext(ctx);
for (const f of ['config', 'util', 'base', 'research', 'army', 'economy', 'admin', 'state', 'pathfinding', 'battle', 'npc', 'goals', 'presets', 'threat', 'timesys'])
  vm.runInContext(fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
const CS = ctx.CS, C = CS.CONFIG, B = CS.Battle, TR = C.battle.tickRate;
const MAXCORE = C.buildings.core.levels.length;

function parseCores(a) {
  if (!a) return Array.from({ length: MAXCORE }, (_, i) => i + 1);
  return a.split(',').flatMap(p => { const m = p.split('-').map(Number); return m.length > 1 ? Array.from({ length: m[1] - m[0] + 1 }, (_, i) => m[0] + i) : m; });
}
const CORES = parseCores(process.argv[2]);
const RUNS = Number(process.argv[3]) || 4;

// ---------------------------------------------------------------- player model
function maxLv(type, core) { return C.buildings[type].levels.filter(l => l.core <= core).length; }
function player(L) {
  const g = maxLv('garrison', L), lab = maxLv('lab', L), bar = maxLv('barracks', L), forge = maxLv('forge', L);
  const cap = CS.Base.maxCount('garrison', L) * (g ? C.buildings.garrison.levels[g - 1].capacity : 0);
  const unlocked = [];
  for (let i = 0; i < bar; i++) unlocked.push(...C.buildings.barracks.levels[i].unlock);
  const troopLv = {};
  unlocked.forEach(t => troopLv[t] = Math.min(C.troops[t].hp.length, lab + 1));
  const heroes = {};
  C.heroOrder.forEach(h => { const lv = maxLv(C.heroes[h].building, L); if (lv) { heroes[h] = 1; troopLv[h] = lv; } });
  const spells = [];
  for (let i = 0; i < forge; i++) spells.push(...C.buildings.forge.levels[i].unlock);
  const spellCap = forge ? C.buildings.forge.levels[forge - 1].capacity : 0;
  return { L, cap, lab, unlocked, troopLv, heroes, spells, spellCap, forge };
}

// Typical mixed army: a tank line, wall breakers, a healer and damage dealers filling the rest.
function mixedArmy(P) {
  const has = t => P.unlocked.includes(t), army = {};
  let left = P.cap;
  const add = (t, n) => { n = Math.min(n, Math.floor(left / C.troops[t].space)); if (n > 0) { army[t] = (army[t] || 0) + n; left -= n * C.troops[t].space; } };
  if (has('colossus')) add('colossus', Math.floor(P.cap * 0.25 / 18));
  if (has('bruiser')) add('bruiser', Math.max(1, Math.floor(P.cap * (has('colossus') ? 0.1 : 0.25) / 5)));
  if (has('demo')) add('demo', Math.max(1, Math.round(P.cap / 25)));
  if (has('mender') && P.cap >= 60) add('mender', 1);
  if (has('drake')) add('drake', Math.floor(P.cap * 0.2 / 16));
  const dps = ['mage', 'lancer', 'vaulter', 'ranger', 'trebuchet'].filter(has);
  let k = 0, guard = 999;
  const pool = dps.length ? dps : ['scout'];
  while (left > 0 && guard--) { const t = pool[k++ % pool.length]; if (C.troops[t].space <= left) add(t, 1); else if (has('ranger')) add('ranger', left); else add('scout', left); if (left && !pool.some(t => C.troops[t].space <= left)) { add('ranger', left); add('scout', left); break; } }
  return army;
}
function monoArmy(P, t) {
  const army = { [t]: Math.max(1, Math.floor(P.cap / C.troops[t].space)) };
  return army;
}
function armyCost(P, army) {
  let e = 0;
  for (const t in army) if (!C.troops[t].hero) e += army[t] * C.troops[t].cost[(P.troopLv[t] || 1) - 1];
  return e;
}
function spellLoadout(P) {
  const out = {};
  if (!P.spells.length) return out;
  let left = P.spellCap, k = 0, guard = 50;
  const pref = ['rage', 'heal', 'freeze', 'thunder'].filter(s => P.spells.includes(s));
  while (left > 0 && guard--) { const s = pref[k++ % pref.length]; if (C.spells[s].space <= left) { out[s] = (out[s] || 0) + 1; left -= C.spells[s].space; } }
  return out;
}

// ---------------------------------------------------------------- simple attacker AI
// Deploys with the NPC planner, fires hero abilities at half health and casts a spell every few seconds.
function runAttack(b, army, heroes) {
  B.planAI(b, army, 0.3);
  const pts = b.meta.approach;
  Object.keys(heroes).forEach((h, i) => b.ai.push({ tick: Math.round((2 + i * 0.5) * TR), type: h, x: pts[0].x, y: pts[0].y }));
  b.ai.sort((p, q) => p.tick - q.tick);
  B.begin(b);
  let nextCast = 7 * TR;
  while (!b.ended) {
    B.step(b);
    for (const h of C.heroOrder) { const u = B.hero(b, h); if (u && !u.ab && u.hp < u.maxHp * 0.5) B.ability(b, h); }
    if (b.tick >= nextCast && Object.keys(b.spells).some(k => b.spells[k] > 0)) { castOne(b); nextCast = b.tick + 4 * TR; }
    if (b.tick > b.limit + 10) break;
  }
}
function centroid(b) {
  let x = 0, y = 0, n = 0;
  b.units.forEach(u => { if (!u.dead) { x += u.x; y += u.y; n++; } });
  return n ? { x: x / n, y: y / n, n } : null;
}
function castOne(b) {
  const c = centroid(b); if (!c) return;
  const defs = b.buildings.filter(d => d.atk && !d.dead && !d.wall);
  const nearest = defs.sort((p, q) => Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y))[0];
  for (const s of ['rage', 'heal', 'freeze', 'thunder']) {
    if (!(b.spells[s] > 0)) continue;
    if ((s === 'freeze' || s === 'thunder') && !nearest) continue;
    const at = (s === 'freeze' || s === 'thunder') ? { x: nearest.x + nearest.w / 2, y: nearest.y + nearest.h / 2 } : c;
    if (B.cast(b, s, at.x, at.y).ok) return;
  }
}

// ---------------------------------------------------------------- matchups
const now = Date.UTC(2026, 0, 1);
function worldState(renown) { const s = CS.State.newGame(now); s.player.renown = renown || 0; return s; }
function tierFor(L) { let t = 1; C.tiers.forEach((T, i) => { if (T && T.core <= L) t = i; }); return t; }

function attackOnce(P, def, fort, gen, seed, army, renown) {
  const s = worldState(renown);
  const rec = CS.NPC.rec(s, def.id); rec.fortify = fort; rec.gen = gen;
  const buildings = CS.NPC.battleBuildings(s, def, now);
  const heroes = {};
  Object.keys(army).forEach(t => { if (C.troops[t].hero) heroes[t] = 1; });
  const troops = {}; Object.keys(army).forEach(t => { if (!C.troops[t].hero) troops[t] = army[t]; });
  const b = B.create({ kind: 'attack', seed, buildings, troops: {}, troopLevels: P.troopLv, timeLimit: C.battle.raidSeconds,
    spells: spellLoadout(P), spellLv: P.forge || 1 });
  runAttack(b, troops, heroes);
  const r = B.result(b);
  const lostCost = Object.keys(r.lost).reduce((e, t) => e + (C.troops[t].hero ? 0 : r.lost[t] * C.troops[t].cost[(P.troopLv[t] || 1) - 1]), 0);
  return { stars: r.stars, win: r.victory ? 1 : 0, destr: r.destruction, loot: r.loot.credits + r.loot.energy, lostCost, sec: r.seconds, dmg: r.dmg };
}

function homeState(L, preset) {
  const s = CS.State.newGame(now);
  s.base.buildings = CS.Presets.layout(L, preset).map((p, k) => ({ id: k + 1, type: p.type, level: p.type === 'core' ? L : Math.max(1, maxLv(p.type, L)), x: p.x, y: p.y, rot: p.rot,
    status: 'active', timer: null, dmg: 0, ruined: false, stored: C.buildings[p.type].produces ? 500 : 0 }));
  s.base.nextId = s.base.buildings.length + 1;
  const lab = maxLv('lab', L);
  Object.keys(C.research.techs).forEach(k => { s.research.levels[k] = C.research.techs[k].lab.filter(l => l <= lab).length; });
  s.stats.defended = 1;
  s.res.credits = s.res.energy = CS.Eco.capacity(s).credits * 0.6;
  return s;
}
function defenseOnce(L, preset, attacker, seed, renown) {
  const s = homeState(L, preset); s.player.renown = renown || 0;
  const b = CS.Threat.buildDefense(s, { attackerId: attacker.id, kind: 'random' }, now + seed * 7919000);
  B.runToEnd(b);
  const r = B.result(b);
  return { destr: r.destruction, held: r.destruction < C.battle.winDestruction && !r.coreDown ? 1 : 0, dmg: r.dmg, army: b.meta.army };
}

// ---------------------------------------------------------------- report
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
const pct = v => (v * 100).toFixed(0).padStart(3) + '%';
for (const L of CORES) {
  const P = player(L), T = tierFor(L), rows = {};
  const onTier = C.settlements.filter(d => d.tier === T);
  const mixed = Object.assign(mixedArmy(P), P.heroes);
  console.log(`\n=== Core ${L}  cap ${P.cap}  lab ${P.lab}  forge ${P.forge}  tier ${T}  army ${JSON.stringify(mixed)} spells ${JSON.stringify(spellLoadout(P))}`);
  if (!process.env.SIM_DEFENSE_ONLY) {
  // mixed army vs on-tier settlements at each fortification
  for (let fort = 0; fort <= 3; fort++) {
    const res = [];
    onTier.forEach(def => { for (let i = 0; i < RUNS; i++) res.push(attackOnce(P, def, fort, i, 1000 + i * 31 + fort, mixed)); });
    rows['fort' + fort] = res;
    console.log(`  mixed vs tier ${T} fort ${fort}: win ${pct(mean(res.map(r => r.win)))} stars ${mean(res.map(r => r.stars)).toFixed(2)} destr ${pct(mean(res.map(r => r.destr)))} loot ${Math.round(mean(res.map(r => r.loot)))} lost ${Math.round(mean(res.map(r => r.lostCost)))} / ${armyCost(P, mixed)}`);
  }
  if (T > 1) {
    const below = C.settlements.filter(d => d.tier === T - 1), res = [];
    below.forEach(def => { for (let i = 0; i < RUNS; i++) res.push(attackOnce(P, def, 1, i, 2000 + i, mixed)); });
    console.log(`  mixed vs tier ${T - 1} fort 1: win ${pct(mean(res.map(r => r.win)))} destr ${pct(mean(res.map(r => r.destr)))} loot ${Math.round(mean(res.map(r => r.loot)))}`);
  }
  if (T < C.tiers.length - 1) {
    const above = C.settlements.filter(d => d.tier === T + 1), res = [];
    above.forEach(def => { for (let i = 0; i < RUNS; i++) res.push(attackOnce(P, def, 0, i, 3000 + i, mixed)); });
    console.log(`  mixed vs tier ${T + 1} fort 0: win ${pct(mean(res.map(r => r.win)))} destr ${pct(mean(res.map(r => r.destr)))} loot ${Math.round(mean(res.map(r => r.loot)))}`);
  }
  // bosses at or below this tier
  C.bosses.filter(bd => bd.tier <= T && bd.tier >= T - 1).forEach(bd => {
    const res = []; for (let i = 0; i < RUNS * 2; i++) res.push(attackOnce(P, CS.NPC.def(bd.id), 0, i, 4000 + i, mixed));
    console.log(`  mixed vs boss ${bd.id} (t${bd.tier}): win ${pct(mean(res.map(r => r.win)))} destr ${pct(mean(res.map(r => r.destr)))}`);
  });
  // league scaling: the same army at higher trophy counts
  [0, 500, 1300, 2600].forEach(tr => {
    const res = []; onTier.forEach(def => { for (let i = 0; i < RUNS; i++) res.push(attackOnce(P, def, 1, i, 5000 + i, mixed, tr)); });
    console.log(`  league ${String(tr).padStart(4)} trophies fort 1: win ${pct(mean(res.map(r => r.win)))} destr ${pct(mean(res.map(r => r.destr)))} loot ${Math.round(mean(res.map(r => r.loot)))}`);
  });
  // mono armies: destruction per army, per energy
  var mono = {};
  P.unlocked.filter(t => !process.env.SIM_MONO || process.env.SIM_MONO.split(',').includes(t)).forEach(t => {
    const army = Object.assign(monoArmy(P, t), P.heroes), res = [];
    onTier.forEach(def => { for (let i = 0; i < RUNS; i++) res.push(attackOnce(P, def, 1, i, 6000 + i, army)); });
    mono[t] = { destr: mean(res.map(r => r.destr)), win: mean(res.map(r => r.win)), cost: armyCost(P, army) };
  });
  // the heroes alone and the same with no heroes, to see what they add
  const noHero = mixedArmy(P), resNH = [];
  onTier.forEach(def => { for (let i = 0; i < RUNS; i++) resNH.push(attackOnce(P, def, 1, i, 1000 + i * 31 + 1, noHero)); });
  console.log(`  mixed without heroes fort 1: win ${pct(mean(resNH.map(r => r.win)))} destr ${pct(mean(resNH.map(r => r.destr)))}  (with heroes ${pct(mean(rows.fort1.map(r => r.destr)))})`);
  console.log('  mono armies (fort 1, heroes included): ' + Object.keys(mono).map(t => `${t} ${pct(mono[t].destr)} w${pct(mono[t].win)} ${mono[t].cost}e`).join(' | '));
  }
  // NPC raids on a maxed home base (3 presets)
  const dres = [];
  const attackers = C.settlements.filter(d => d.tier <= T && d.tier >= T - 1);
  for (let p = 0; p < 3; p++) attackers.forEach((a, k) => { for (let i = 0; i < Math.max(1, RUNS / 2); i++) dres.push(defenseOnce(L, p, a, 7 + i * 13 + k + p * 101)); });
  const dmgBy = {}, counts = {};
  CS.Presets.layout(L, 0).forEach(p => { if (C.buildings[p.type].attack) counts[p.type] = (counts[p.type] || 0) + 1; });
  dres.forEach(r => Object.keys(r.dmg).forEach(k => dmgBy[k] = (dmgBy[k] || 0) + r.dmg[k] / dres.length));
  console.log(`  NPC raids on maxed home: held ${pct(mean(dres.map(r => r.held)))} destr ${pct(mean(dres.map(r => r.destr)))}  (n=${dres.length}) army e.g. ${JSON.stringify(dres[0].army)}`);
  const leagueD = []; for (let p = 0; p < 3; p++) attackers.slice(0, 2).forEach((a, k) => leagueD.push(defenseOnce(L, p, a, 99 + k + p, 2600)));
  console.log(`  NPC raids at Legend league: held ${pct(mean(leagueD.map(r => r.held)))} destr ${pct(mean(leagueD.map(r => r.destr)))}`);
  console.log('  defense damage per raid, per building (and per 1k credits invested): ' + Object.keys(dmgBy).filter(k => counts[k]).sort((a, b) => dmgBy[b] / counts[b] - dmgBy[a] / counts[a]).map(k => {
    const lv = maxLv(k, L), invest = C.buildings[k].levels.slice(0, lv).reduce((s, l) => s + l.cost, 0);
    return `${k} ${Math.round(dmgBy[k] / counts[k])} (${(dmgBy[k] / counts[k] / Math.max(1, invest / 1000)).toFixed(1)})`;
  }).join(' | '));
}
