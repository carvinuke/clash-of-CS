// Loads the game's logic scripts into a fake window and exercises them with plain Node (no packages).
// Run from the repository root: node tests/logic-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..');
const store = {};
const ctx = { console: Object.assign({}, console, { warn: function () {} }), Math, Date, JSON, Map, Set, Int32Array, Uint8Array, Uint32Array, Int8Array, Float64Array, Float32Array, Int16Array, Array, Object, Number, String, isFinite, Infinity, NaN, setTimeout, clearTimeout };
ctx.window = ctx;
ctx.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
vm.createContext(ctx);
const files = ['config','util','base','research','army','economy','admin','state','pathfinding','battle','npc','presets','threat','timesys'];
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

// Command Core Lv 7-9: every per-core table covers all core levels, and level gates stay within them.
{
  const C = CS.CONFIG, maxCore = C.buildings.core.levels.length;
  ok(maxCore === 9, 'Command Core has 9 levels');
  const short = Object.keys(C.buildings).filter(t => C.buildings[t].max.length !== maxCore);
  ok(!short.length, 'every building has a limit for each core level ' + short.join(','));
  const gates = Object.keys(C.buildings).filter(t => C.buildings[t].levels.some(L => L.core > maxCore));
  ok(!gates.length, 'no level needs a core level that does not exist ' + gates.join(','));
  ok([C.grid.buildAreaByCore, C.attacks.armySpaceByCore, C.attacks.troopLevelByCore, C.attacks.steal.capByCore].every(a => a.length === maxCore), 'per-core tables have 9 entries');
  for (const h of C.heroOrder) {
    const n = C.buildings[C.heroes[h].building].levels.length, T = C.troops[h], A = C.heroes[h].ability;
    ok(T.hp.length === n && T.dmg.length === n && C.heroes[h].recoverMin.length === n && A.sec.length === n && A.heal.length === n && (!A.summonN || A.summonN.length === n), h + ' has stats for all ' + n + ' home levels');
  }
  const g = CS.State.newGame(now);
  g.base.buildings.find(b => b.type === 'core').level = 9;
  ok(CS.Base.maxCount('wall', 9) === 250 && CS.Base.buildArea(9).size === 42, 'core 9: 250 walls and a 42x42 build area');
  const cap0 = CS.Eco.capacity(g);
  CS.Base.newBuilding(g, 'bunker', 12, 12, 0, 1, 'active');
  const cap1 = CS.Eco.capacity(g);
  ok(cap1.credits > cap0.credits && cap1.energy > cap0.energy, 'Reserve Bunker raises both storage caps');
  ok(CS.NPC.unlockedTier(g) === 1 && CS.CONFIG.tiers.length === 7, 'tier 6 exists and starts hidden');
}

// New defenses: the Skyburst Battery only hits flyers, the Sky Snare only triggers on flyers,
// and the Longshot Bastion fires at the toughest attacker in range.
{
  const mk = (type, troops, level) => CS.Battle.create({ kind: 'attack', seed: 5, timeLimit: 150, troops, troopLevels: {},
    buildings: [{ id: 1, type: 'core', level: 1, x: 20, y: 20, w: 4, h: 4 }, { id: 2, type, level: level || 1, x: 14, y: 21, w: type === 'snare' ? 1 : 3, h: type === 'snare' ? 1 : 3 }] });
  let b = mk('flak', { scout: 6 });
  for (let i = 0; i < 6; i++) CS.Battle.deploy(b, 'scout', 8.5, 20 + i * 0.5);
  CS.Battle.runToEnd(b);
  ok(!CS.Battle.result(b).dmg.flak && !CS.Battle.result(b).lost.scout, 'Skyburst Battery ignores ground troops');
  b = mk('flak', { gyro: 3 });
  for (let i = 0; i < 3; i++) CS.Battle.deploy(b, 'gyro', 8.5, 21 + i * 0.4);
  CS.Battle.runToEnd(b);
  let res = CS.Battle.result(b);
  ok(res.dmg.flak > 0 && res.lost.gyro > 0, 'Skyburst Battery shoots gyrocopters down (' + Math.round(res.dmg.flak) + ' dmg, ' + res.lost.gyro + ' lost)');
  b = mk('snare', { scout: 2 }, 1);
  CS.Battle.deploy(b, 'scout', 8.5, 21.5); CS.Battle.deploy(b, 'scout', 8.5, 22);
  CS.Battle.runToEnd(b);
  ok(!CS.Battle.result(b).dmg.snare, 'Sky Snare does not trigger on ground troops');
  b = mk('snare', { gyro: 1 }, 1);
  CS.Battle.deploy(b, 'gyro', 8.5, 21.5);
  CS.Battle.runToEnd(b);
  ok(CS.Battle.result(b).dmg.snare > 0, 'Sky Snare hits a gyrocopter');
  b = mk('rail', { scout: 6, bruiser: 1 });
  CS.Battle.deploy(b, 'bruiser', 6.5, 22);
  for (let i = 0; i < 6; i++) CS.Battle.deploy(b, 'scout', 6.5, 19 + i * 0.5);
  const rail = b.buildings.find(c => c.type === 'rail');
  let firstTarget = null;
  for (let i = 0; i < 600 && !firstTarget; i++) { CS.Battle.fastForward(b, 1); const p = b.proj.find(q => q.src === rail.id); if (p) firstTarget = CS.Battle.unit(b, p.tgt); }
  ok(firstTarget && firstTarget.type === 'bruiser', 'Longshot Bastion targets the toughest attacker first (' + (firstTarget && firstTarget.type) + ')');
}

// Spell Forge: brewing needs the forge, respects its space and unlocks, and finishes over time.
{
  const g = CS.State.newGame(now);
  g.base.buildings.find(b => b.type === 'core').level = 5;
  ok(!CS.Army.canBrew(g, 'heal').ok, 'no brewing without a Spell Forge');
  const sp = CS.Base.findFreeSpot(g, 'forge', 0, 22, 22);
  CS.Base.newBuilding(g, 'forge', sp.x, sp.y, 0, 3, 'active');
  g.res.energy = 100000;
  ok(['heal', 'rage', 'freeze', 'freeze'].every(t => CS.Army.brew(g, t).ok), 'Forge Lv 3 brews Mending Mist, Bloodrush and Frostbind');
  ok(!CS.Army.brew(g, 'heal').ok, 'brewing stops when the forge is full');
  ok(/Lv 4/.test(CS.Army.canBrew(g, 'thunder').reason), 'Thunderclap unlocks at Forge Lv 4');
  CS.Time.step(g, g.lastTick + 400000);
  ok(g.spells.units.heal === 1 && g.spells.units.freeze === 2 && !g.spells.queue.length, 'spells brew over time: ' + JSON.stringify(g.spells.units));
  const re = CS.State.sanitize(JSON.parse(JSON.stringify(g)), now);
  ok(re.spells.units.rage === 1 && re.spells.units.freeze === 2, 'brewed spells survive a save round trip');
}

// Spells in battle: freeze locks a defense, rage and heal work on troops, thunder hits buildings,
// and a battle with live spell zones restores deterministically.
{
  const b = CS.Battle.create({ kind: 'attack', seed: 9, timeLimit: 150, troops: { bruiser: 4 }, troopLevels: {}, spells: { heal: 1, rage: 1, freeze: 1, thunder: 1 }, spellLv: 4,
    buildings: [{ id: 1, type: 'core', level: 1, x: 20, y: 20, w: 4, h: 4 }, { id: 2, type: 'blaster', level: 3, x: 14, y: 21, w: 3, h: 3 }] });
  for (let i = 0; i < 4; i++) CS.Battle.deploy(b, 'bruiser', 8.5, 21 + i * 0.5);
  CS.Battle.fastForward(b, 150);
  const bl = b.buildings.find(c => c.type === 'blaster');
  ok(CS.Battle.cast(b, 'freeze', 15.5, 22.5).ok, 'Frostbind cast on the turret');
  ok(!CS.Battle.cast(b, 'freeze', 15.5, 22.5).ok, 'a spell cannot be cast more often than it was brought');
  const u0 = b.units.find(u => !u.dead);
  ok(CS.Battle.cast(b, 'rage', u0.x, u0.y).ok && CS.Battle.cast(b, 'heal', u0.x, u0.y).ok, 'Bloodrush and Mending Mist cast on the troops');
  CS.Battle.fastForward(b, 3);
  ok(bl.frz > 0, 'Frostbind freezes the turret');
  ok(b.units.some(u => u.rgT > 0), 'Bloodrush enrages troops');
  const hp0 = bl.hp;
  ok(CS.Battle.cast(b, 'thunder', 15.5, 22.5).ok && (bl.hp < hp0 || bl.dead), 'Thunderclap blasts the turret (' + Math.round(hp0 - bl.hp) + ' dmg)');
  const snap = CS.Battle.restore(JSON.parse(JSON.stringify(CS.Battle.serialize(b))));
  CS.Battle.runToEnd(b); CS.Battle.runToEnd(snap);
  const res = CS.Battle.result(b);
  ok(JSON.stringify(res) === JSON.stringify(CS.Battle.result(snap)), 'battle with spell zones restores deterministically');
  ok(JSON.stringify(res.cast) === JSON.stringify({ freeze: 1, rage: 1, heal: 1, thunder: 1 }), 'result counts the spells cast ' + JSON.stringify(res.cast));
}

// New defenses and troops.
{
  const mk = (type, troops, level, extra) => CS.Battle.create({ kind: 'attack', seed: 5, timeLimit: 150, troops, troopLevels: {},
    buildings: [{ id: 1, type: 'core', level: 1, x: 20, y: 20, w: 4, h: 4 }, { id: 2, type, level: level || 1, x: 14, y: 21, w: CS.Base.size(type, 0)[0], h: CS.Base.size(type, 0)[1] }].concat(extra || []) });
  for (const [type, army] of [['brazier', { scout: 6 }], ['hail', { scout: 6 }], ['tempest', { scout: 6 }], ['charge', { bruiser: 3 }], ['thornheart', { bruiser: 6 }], ['bombard', { bruiser: 6 }], ['idol', { bruiser: 6 }]]) {
    const b = mk(type, army);
    Object.keys(army).forEach(t => { for (let i = 0; i < army[t]; i++) CS.Battle.deploy(b, t, 8.5, 21 + i * 0.4); });
    CS.Battle.runToEnd(b);
    const res = CS.Battle.result(b);
    ok(res.dmg[type] > 0, CS.CONFIG.buildings[type].name + ' deals damage (' + Math.round(res.dmg[type]) + ')');
  }
  // the Ember Brazier is ground only
  let b = mk('brazier', { gyro: 2 });
  CS.Battle.deploy(b, 'gyro', 8.5, 22); CS.Battle.deploy(b, 'gyro', 8.5, 23);
  CS.Battle.runToEnd(b);
  ok(!CS.Battle.result(b).dmg.brazier, 'Ember Brazier cannot reach flyers');
  // the Tempest Coil chains between several troops
  b = mk('tempest', { bruiser: 4 }, 1);
  for (let i = 0; i < 4; i++) CS.Battle.deploy(b, 'bruiser', 8.5, 21 + i * 0.3);
  let hurt = 0;
  for (let i = 0; i < 900 && hurt < 2; i++) { CS.Battle.fastForward(b, 1); hurt = b.units.filter(u => u.hp < u.maxHp).length; }
  ok(hurt >= 2, 'Tempest Coil arcs to more than one troop (' + hurt + ')');
  // a Wall Vaulter hops a wall ring to reach the defense inside it
  const ring = [];
  for (let x = 12; x <= 18; x++) for (let y = 19; y <= 25; y++) if (x === 12 || x === 18 || y === 19 || y === 25) ring.push({ id: 100 + ring.length, type: 'wall', level: 3, x, y, w: 1, h: 1 });
  b = mk('blaster', { vaulter: 4 }, 1, ring);
  for (let i = 0; i < 4; i++) CS.Battle.deploy(b, 'vaulter', 6.5, 21 + i * 0.5);
  CS.Battle.fastForward(b, 900);
  const tur = b.buildings.find(c => c.type === 'blaster');
  ok((tur.dead || tur.hp < tur.maxHp) && b.buildings.filter(c => c.type === 'wall').every(c => c.hp === c.maxHp), 'Wall Vaulters cross a wall ring without breaking it');
  // Trebuchets and Ember Drakes hurt buildings
  for (const t of ['trebuchet', 'drake']) {
    b = mk('mortar', { [t]: 2 }, 1);
    CS.Battle.deploy(b, t, 6.5, 21); CS.Battle.deploy(b, t, 6.5, 22);
    CS.Battle.runToEnd(b);
    ok(CS.Battle.result(b).destroyed > 0, CS.CONFIG.troops[t].name + ' destroys buildings (' + CS.Battle.result(b).destroyed + ')');
  }
}

// Layout presets keep the short-reach guards (Cinder Brazier, Tempest Coil) close to the Core.
{
  let far = [];
  for (let c = 2; c <= 9; c++) for (let i = 0; i < 3; i++) {
    const L = CS.Presets.layout(c, i), core = L.find(b => b.type === 'core');
    L.filter(b => b.type === 'brazier' || b.type === 'tempest').forEach(b => { const d = Math.hypot(b.x + 1 - core.x - 2, b.y + 1 - core.y - 2); if (d > 9) far.push(c + ':' + i + ' ' + b.type + ' ' + d.toFixed(1)); });
  }
  ok(!far.length, 'presets place braziers and tempest coils by the core ' + far.join(', '));
}

// Boss strongholds: each holds its boss defense, never retaliates and pays its reward once.
{
  for (const def of CS.CONFIG.bosses) {
    const lay = CS.NPC.layout(s, def);
    const grid = new Int32Array(S * S);
    let bad = 0;
    for (const b of lay) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { if (grid[y * S + x]) bad++; grid[y * S + x] = b.id; }
    ok(!bad && lay.filter(b => b.type === def.defense).length === 1 && lay.some(b => b.type === 'core'), def.id + ' layout holds its ' + CS.CONFIG.buildings[def.defense].name);
  }
  const g = CS.State.newGame(now);
  const def = CS.CONFIG.bosses[0], rec = CS.NPC.rec(g, def.id);
  ok(rec && !rec.claimed && CS.NPC.def(def.id) === def, 'boss stronghold has a record');
  CS.NPC.onRaidResult(g, def, { victory: true, stars: 3, destruction: 1, loot: { credits: 0, energy: 0 } }, now);
  ok(CS.NPC.rec(g, def.id).claimed && !CS.NPC.rec(g, def.id).hostility, 'a boss victory claims the reward and stirs no hostility');
  ok(CS.NPC.winsInTier(g, def.tier) === 0, 'boss wins do not count toward revealing tiers');
  raid(CS.NPC.def('briarheart-grove'), { bruiser: 10, ranger: 16, vaulter: 6, mender: 2 });
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
// Base presets: three complete, legal layouts per core level
function stateFrom(core, slots) {
  const st = CS.State.newGame(Date.now());
  st.base.buildings = []; st.base.nextId = 1;
  slots.forEach(p => CS.Base.newBuilding(st, p.type, p.x, p.y, p.rot, p.type === 'core' ? core : 1, 'active'));
  return st;
}
function legal(st) {
  return st.base.buildings.every(b => CS.Base.canPlaceAt(st, b.type, b.x, b.y, b.rot, b.id).ok);
}
let presetsOk = true;
for (let core = 1; core <= CS.CONFIG.buildings.core.levels.length; core++) {
  for (let i = 0; i < CS.Presets.STYLES.length; i++) {
    const L = CS.Presets.layout(core, i);
    const short = Object.keys(CS.CONFIG.buildings).filter(t => L.filter(p => p.type === t).length !== CS.Base.maxCount(t, core));
    const st = stateFrom(core, L);
    if (short.length || !legal(st)) { presetsOk = false; console.log('  preset core', core, 'style', i, 'short:', short.join(',')); }
  }
}
ok(presetsOk, 'every core level has 3 presets holding its full building allowance, all legal');
s = stateFrom(9, CS.Presets.layout(9, 0));
const n9 = s.base.buildings.length;
r = CS.Presets.apply(s, 2);
const slots2 = new Set(CS.Presets.layout(9, 2).map(p => p.type + p.x + ',' + p.y));
ok(r.ok && s.base.buildings.length === n9 && legal(s) && s.base.buildings.every(b => slots2.has(b.type + b.x + ',' + b.y)), 'full core 9 base moves onto another preset');
s = CS.State.newGame(Date.now());
r = CS.Presets.apply(s, 1);
ok(r.ok && s.base.buildings.length === 9 && legal(s), 'starter base applies a preset, missing buildings skipped');
// Admin cheats
s = CS.State.newGame(Date.now());
let t = Date.now();
CS.Admin.set(s, 'rich', true);
CS.Eco.advance(s, t, t + 1000);
ok(s.res.credits >= CS.Admin.RICH && s.res.energy >= CS.Admin.RICH, 'infinite resources');
CS.Admin.set(s, 'instant', true);
r = CS.Eco.startUpgrade(s, CS.Base.core(s), t + 1000);
CS.Eco.advance(s, t + 1000, t + 1200);
ok(r.ok && CS.Base.coreLevel(s) === 2, 'instant upgrade finishes on the next tick');
CS.Admin.set(s, 'rich', false);
ok(s.res.credits <= CS.Eco.capacity(s).credits, 'turning infinite resources off clamps to storage');
CS.Admin.maxBase(s);
ok(s.base.buildings.every(b => b.level === CS.Base.maxLevel(b.type)), 'max out every building');
ok(CS.Admin.fillArmy(s) > 0 && CS.Army.armySpace(s) <= CS.Army.capacity(s), 'fill army stays within housing');
// Backup files
const good = JSON.stringify({ v: CS.CONFIG.saveVersion, savedAt: t, state: CS.State.newGame(t) });
let restored = JSON.parse(CS.State.readBackup(good, t + 5));
ok(restored.state.base.buildings.length === 9 && restored.state.lastTick === t + 5, 'valid backup accepted');
const bad = ['not json', '{"hello":1}', JSON.stringify({ v: 99, state: CS.State.newGame(t) }), JSON.stringify({ v: 2, state: { base: 5 } })];
ok(bad.every(txt => { try { CS.State.readBackup(txt, t); return false; } catch (e) { return /backup/.test(e.message); } }), 'bad backup files rejected with a reason');
ok(CS.State.restore(good) && store[CS.CONFIG.saveKey] === good, 'restore writes the save');

console.log(fails ? fails + ' FAILURES' : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
