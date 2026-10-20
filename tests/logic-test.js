// Loads the game's logic scripts into a fake window and exercises them with plain Node (no packages).
// Run from the repository root: node tests/logic-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..');
const store = {};
const ctx = { console: Object.assign({}, console, { warn: function () {} }), Math, Date, JSON, Map, Set, Int32Array, Uint8Array, Uint32Array, Int8Array, Float64Array, Float32Array, Int16Array, Array, Object, Number, String, isFinite, Infinity, NaN, setTimeout, clearTimeout };
ctx.window = ctx;
ctx.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
vm.createContext(ctx);
const files = ['config','util','base','research','army','economy','state','pathfinding','battle','npc','threat','timesys'];
for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
const CS = ctx.CS;
let fails = 0;
function ok(cond, msg) { if (!cond) { fails++; console.log('FAIL:', msg); } else console.log('ok  :', msg); }

const now = Date.now();
let s = CS.State.newGame(now);
ok(s.base.buildings.length === 9, 'starter base has 9 buildings');
ok(CS.Army.capacity(s) === 20 && CS.Army.armySpace(s) === 10, 'army capacity 20, used 10');
// Placement rules
const occ = CS.Base.occupancy(s.base.buildings);
ok(!CS.Base.canPlaceAt(s, 'blaster', 20, 20, 0).ok, 'cannot place on the core');
ok(!CS.Base.canPlaceAt(s, 'blaster', 2, 2, 0).ok, 'cannot place outside build area');
ok(CS.Base.canPlaceAt(s, 'blaster', 12, 26, 0).ok, 'can place blaster at free spot');
const credits0 = s.res.credits;
let r = CS.Eco.place(s, 'blaster', 12, 26, 0, now);
ok(r.ok && s.res.credits === credits0 - 250, 'blaster placed and 250 credits deducted');
ok(r.b.status === 'building' && r.b.level === 0, 'blaster under construction');
r = CS.Eco.place(s, 'blaster', 12, 26, 0, now);
ok(!r.ok, 'second blaster at same spot rejected: ' + r.reason);
// Engineers: 2 stations -> second construction allowed, third blocked
let sp = CS.Base.findFreeSpot(s, 'mint', 0, 20, 20);
r = CS.Eco.place(s, 'mint', sp.x, sp.y, 0, now);
ok(r.ok, 'second mint placed (2nd engineer)');
sp = CS.Base.findFreeSpot(s, 'well', 0, 20, 20);
r = CS.Eco.place(s, 'well', sp.x, sp.y, 0, now);
ok(!r.ok && /Engineer/.test(r.reason), 'third construction blocked: ' + r.reason);
// Walls are instant
r = CS.Eco.place(s, 'wall', 11, 11, 0, now);
ok(r.ok && r.b.level === 1 && r.b.status === 'active', 'wall instant');
// Advance 20s: constructions finish
CS.Time.step(s, now + 20000);
const bl = s.base.buildings.find(b => b.type === 'blaster');
ok(bl.level === 1 && bl.status === 'active', 'blaster finished after 20s');
// Production respects buffer and storage
const mint = s.base.buildings.find(b => b.type === 'mint');
CS.Time.catchUp(s, now + 20000 + 3600 * 1000 * 10, { allowRaids: false });
ok(mint.stored <= CS.CONFIG.buildings.mint.levels[0].buffer + 1e-6, 'mint buffer capped: ' + mint.stored.toFixed(1));
s.res.credits = 0;
const cap = CS.Eco.capacity(s).credits;
const got = CS.Eco.collect(s, mint);
ok(s.res.credits <= cap && got > 0, 'collect respects storage cap (' + got + ' of buffer, cap ' + cap + ')');
// Training
const e0 = s.res.energy = 2000;
r = CS.Army.queueTroop(s, 'scout', 5);
ok(r.ok && s.res.energy === e0 - 125, 'queued 5 scouts for 125 energy');
r = CS.Army.queueTroop(s, 'scout', 10);
ok(!r.ok, 'queue beyond capacity rejected: ' + r.reason);
CS.Time.step(s, s.lastTick + 60000);
ok(s.army.units.scout === 11 && s.army.queue.length === 0, 'scouts trained: ' + s.army.units.scout);

// Layout generation for all settlements
const S = CS.CONFIG.grid.size;
for (const def of CS.CONFIG.settlements) {
  for (let gen = 0; gen < 4; gen++) {
    const rec = CS.NPC.rec(s, def.id); rec.gen = gen; rec.fortify = Math.min(gen, 2);
    const lay = CS.NPC.layout(s, def);
    const grid = new Int32Array(S * S);
    const area = CS.CONFIG.tiers[def.tier].area, a0 = (S - area) / 2;
    let bad = 0;
    for (const b of lay) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      if (x < a0 || y < a0 || x >= a0 + area || y >= a0 + area) bad++;
      if (grid[y * S + x]) bad++; grid[y * S + x] = b.id;
    }
    if (gen === 0) {
      const counts = {}; lay.forEach(b => counts[b.type] = (counts[b.type] || 0) + 1);
      console.log('   ', def.tier, def.id.padEnd(20), CS.NPC.archetype(def, rec).padEnd(13), JSON.stringify(counts));
    }
    if (bad) ok(false, 'layout ' + def.id + ' gen ' + gen + ' has ' + bad + ' bad tiles');
    ok(lay.some(b => b.type === 'core'), 'layout ' + def.id + ' gen ' + gen + ' has a core');
  }
  const rec = CS.NPC.rec(s, def.id); rec.gen = 0; rec.fortify = 0;
}

// Battle: starter army vs each tier 1 settlement, deploying everything at a legal spot
function raid(def, army) {
  const b = CS.Battle.create({ kind: 'attack', seed: 42, buildings: CS.NPC.battleBuildings(s, def, now), troops: army, troopLevels: {}, timeLimit: 150 });
  let deployed = 0;
  for (const t of Object.keys(army)) for (let i = 0; i < army[t]; i++) {
    let placed = false;
    for (let k = 0; k < 400 && !placed; k++) { const x = 2 + (k % 40) + 0.5, y = 2.5 + Math.floor(k / 40); if (CS.Battle.deploy(b, t, x, y).ok) placed = true; }
    if (placed) deployed++;
  }
  const t0 = Date.now();
  CS.Battle.runToEnd(b);
  const res = CS.Battle.result(b);
  console.log('   raid', def.id, JSON.stringify({ stars: res.stars, destr: Math.round(res.destruction * 100), loot: res.loot, lost: res.lost, reason: res.reason, sec: res.seconds.toFixed(1), ms: Date.now() - t0 }));
  return res;
}
for (const def of CS.CONFIG.settlements.filter(d => d.tier === 1)) {
  const res = raid(def, { scout: 6, ranger: 4 });
  ok(res.destroyed > 0, 'starter army destroys something at ' + def.id);
}
raid(CS.NPC.def('bramble-keep'), { scout: 20, ranger: 10, bruiser: 4 });
raid(CS.NPC.def('ironroot-hold'), { bruiser: 6, demo: 6, ranger: 14, scout: 10 });
raid(CS.NPC.def('cinderforge'), { bruiser: 12, demo: 10, mage: 10, ranger: 20, mender: 2 });

raid(CS.NPC.def('glimmerfen'), { lancer: 8, gyro: 6, colossus: 1, ranger: 10 });

// Flying troops: a Blaster Turret (ground only) never hurts a Gyrocopter; a Sentry Spire does.
{
  const mk = type => CS.Battle.create({ kind: 'attack', seed: 3, timeLimit: 150, troops: { gyro: 2 }, troopLevels: {},
    buildings: [{ id: 1, type: 'core', level: 1, x: 20, y: 20, w: 4, h: 4 }, { id: 2, type, level: 3, x: 14, y: 21, w: 3, h: 3 }] });
  for (const type of ['blaster', 'spire']) {
    const b = mk(type);
    CS.Battle.deploy(b, 'gyro', 8.5, 22); CS.Battle.deploy(b, 'gyro', 8.5, 23);
    CS.Battle.runToEnd(b);
    const res = CS.Battle.result(b);
    if (type === 'blaster') ok(!res.dmg.blaster && !res.lost.gyro && res.destruction === 1, 'blaster cannot hit gyrocopters (destroyed ' + Math.round(res.destruction * 100) + '%)');
    else ok(res.dmg.spire > 0, 'spire shoots gyrocopters (' + Math.round(res.dmg.spire) + ' dmg)');
  }
}

// Heroes: status, abilities, summons that never join the army, and recovery after a raid.
{
  const h = CS.State.newGame(now);
  ok(CS.Army.heroStatus(h, 'marshal', now).code === 'none', 'no hero without its hall');
  const hall = CS.Base.newBuilding(h, 'hall', 12, 26, 0, 1, 'active');
  ok(CS.Army.heroLevel(h, 'marshal') === 1 && CS.Army.heroReady(h, 'marshal', now), 'War Hall summons a level 1 Iron Marshal');
  const def = CS.NPC.def('pebblebrook');
  const b = CS.Battle.create({ kind: 'attack', seed: 11, buildings: CS.NPC.battleBuildings(h, def, now), troops: { scout: 4, marshal: 1, huntress: 1 }, troopLevels: { marshal: 1, huntress: 1 }, timeLimit: 150 });
  ok(!CS.Battle.ability(b, 'marshal').ok, 'ability needs a deployed hero');
  CS.Battle.deploy(b, 'marshal', 3.5, 3.5); CS.Battle.deploy(b, 'huntress', 3.5, 4.5);
  for (let i = 0; i < 4; i++) CS.Battle.deploy(b, 'scout', 4.5 + i * 0.3, 3.5);
  CS.Battle.fastForward(b, 240);
  const u = CS.Battle.hero(b, 'marshal');
  const before = b.units.length;
  ok(CS.Battle.ability(b, 'marshal').ok && !CS.Battle.ability(b, 'marshal').ok, 'War Cry fires once');
  ok(b.units.length === before + 2 && b.units.filter(x => x.sum).length === 2, 'War Cry calls in 2 Scouts');
  ok(CS.Battle.ability(b, 'huntress').ok && CS.Battle.hero(b, 'huntress').hideT > 0, 'Smoke Veil cloaks the Huntress');
  ok(u.abT > 0, 'rally aura running');
  const snap = CS.Battle.restore(JSON.parse(JSON.stringify(CS.Battle.serialize(b))));
  CS.Battle.runToEnd(b); CS.Battle.runToEnd(snap);
  const res = CS.Battle.result(b);
  ok(JSON.stringify(res) === JSON.stringify(CS.Battle.result(snap)), 'battle with abilities restores deterministically');
  ok(res.deployed.scout === 4 && !(res.survived.scout > 4), 'summoned Scouts never count as deployed or survivors');
  ok(res.heroHp.marshal >= 0 && res.heroHp.marshal <= 1 && 'huntress' in res.heroHp, 'hero health reported: ' + JSON.stringify(res.heroHp));
  CS.Army.heroesRest(h, { marshal: 0.5 }, now);
  const st = CS.Army.heroStatus(h, 'marshal', now);
  ok(st.code === 'resting' && Math.abs(st.left - 150) < 1, 'half-health Marshal rests 2.5 of 5 minutes (' + st.left + 's)');
  ok(CS.Army.heroReady(h, 'marshal', now + 151000), 'Marshal ready after resting');
  hall.status = 'upgrading';
  ok(CS.Army.heroStatus(h, 'marshal', now + 999999).code === 'upgrading', 'hero away while its hall upgrades');
}

// Heroes defend the home base: they guard their platform, fight raiders and rest afterwards.
{
  const h = CS.State.newGame(now);
  h.base.buildings.find(b => b.type === 'core').level = 3;
  const sp = CS.Base.findFreeSpot(h, 'hall', 0, 22, 22);
  CS.Base.newBuilding(h, 'hall', sp.x, sp.y, 0, 3, 'active');
  const b = CS.Threat.buildDefense(h, { attackerId: 'sandscar-den', kind: 'random' }, now);
  ok(b.guards.length === 1 && b.guards[0].type === 'marshal', 'ready Marshal stands guard in a defense');
  const snap = CS.Battle.restore(JSON.parse(JSON.stringify(CS.Battle.serialize(b))));
  CS.Battle.runToEnd(b); CS.Battle.runToEnd(snap);
  const res = CS.Battle.result(b);
  ok(JSON.stringify(res) === JSON.stringify(CS.Battle.result(snap)), 'defense with a guard restores deterministically');
  ok(res.guards[0].dealt > 0, 'Marshal hurt the raiders: ' + JSON.stringify(res.guards[0]));
  const rep = CS.Threat.applyDefense(h, b, now);
  const st = CS.Army.heroStatus(h, 'marshal', now);
  ok(rep.heroes.length === 1 && (res.guards[0].hp < 1 ? st.code === 'resting' : st.code === 'ready'), 'hero rest follows the defense (' + st.code + ')');
  const b2 = CS.Threat.buildDefense(h, { attackerId: 'sandscar-den', kind: 'random' }, now);
  ok(b2.guards.length === (st.code === 'ready' ? 1 : 0), 'a resting hero does not defend');
}

// Serialization round trip mid-battle
{
  const def = CS.NPC.def('pebblebrook');
  const b = CS.Battle.create({ kind: 'attack', seed: 7, buildings: CS.NPC.battleBuildings(s, def, now), troops: { scout: 6, ranger: 4 }, troopLevels: {}, timeLimit: 150 });
  for (let i = 0; i < 6; i++) CS.Battle.deploy(b, 'scout', 3.5 + i * 0.3, 3.5);
  for (let i = 0; i < 4; i++) CS.Battle.deploy(b, 'ranger', 3.5, 4.5 + i * 0.3);
  CS.Battle.fastForward(b, 300);
  const snap = JSON.parse(JSON.stringify(CS.Battle.serialize(b)));
  ok(CS.Battle.isValidSnapshot(snap), 'snapshot valid');
  const b2 = CS.Battle.restore(snap);
  CS.Battle.runToEnd(b); CS.Battle.runToEnd(b2);
  const r1 = CS.Battle.result(b), r2 = CS.Battle.result(b2);
  ok(JSON.stringify(r1) === JSON.stringify(r2), 'restored battle resolves identically (deterministic)');
}

// Defense battle and offline catch-up with raids
s.threat.protectionUntil = 0;
s.threat.shieldUntil = 0;
s.threat.lastRaidAt = 0;
s.threat.next = null;
const before = { credits: s.res.credits, energy: s.res.energy };
const t1 = s.lastTick + 6 * 3600 * 1000;
const t0 = Date.now();
const rep = CS.Time.catchUp(s, t1, { allowRaids: true });
console.log('   catch-up ms', Date.now() - t0, 'raids', rep.raids.length, JSON.stringify(rep.raids.map(x => ({ who: x.attacker, def: x.defended, d: Math.round(x.destruction * 100), stolen: x.stolen, killed: x.killed, raiders: x.raiders }))));
console.log('   produced', JSON.stringify(rep.produced), 'news', rep.news.length, 'capped', rep.capped);
ok(rep.raids.length >= 1 && rep.raids.length <= 2, 'offline raids happened and are capped at 2');
ok(s.base.buildings.length >= 9, 'no building deleted by raids');
// Long absence (30 days) finishes fast
const t2 = Date.now();
CS.Time.catchUp(s, s.lastTick + 30 * 86400000, { allowRaids: true });
ok(Date.now() - t2 < 2000, '30-day catch-up took ' + (Date.now() - t2) + 'ms');

// Save / load / corruption recovery
ok(CS.State.save(s, Date.now()), 'saved');
const loaded = CS.State.load(Date.now());
ok(loaded.status === 'loaded' && loaded.state.base.buildings.length === s.base.buildings.length, 'loaded save');
store[CS.CONFIG.saveKey] = '{not json';
const rec2 = CS.State.load(Date.now());
ok(rec2.status === 'recovered' || rec2.status === 'reset', 'corrupt save recovered: ' + rec2.status);
store[CS.CONFIG.saveKey] = JSON.stringify({ v: 1, state: { base: { buildings: [{ type: 'core', x: 999, y: -5, level: 'x' }, { type: 'bogus' }, { type: 'mint', x: 20, y: 20, level: 3 }] } } });
delete store[CS.CONFIG.saveKey + '.backup'];
const rec3 = CS.State.load(Date.now());
ok(rec3.status === 'loaded' && rec3.state.base.buildings.length === 2, 'garbage save sanitized: ' + rec3.status + ' ' + rec3.state.base.buildings.map(b => b.type + '@' + b.x + ',' + b.y).join(' '));
console.log(fails ? fails + ' FAILURES' : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
