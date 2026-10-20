/*
 * Clash of CS - central configuration.
 * Every balance number (costs, timers, production, combat stats, NPC tiers and the
 * raid schedule) lives here so the game can be rebalanced without touching the systems.
 * Times are in seconds unless the key says otherwise.
 */
(function (CS) {
  'use strict';

  // Turns column arrays into one object per level: {hp:[1,2], cost:[3,4]} -> [{hp:1,cost:3},{hp:2,cost:4}]
  function levels(cols) {
    const keys = Object.keys(cols);
    const n = cols[keys[0]].length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = {};
      keys.forEach(function (k) { o[k] = cols[k][i]; });
      out.push(o);
    }
    return out;
  }

  const CONFIG = {
    saveKey: 'clashOfCS.save',
    saveVersion: 2,
    autosaveSec: 15,

    grid: {
      size: 44,                                // map is size x size tiles
      buildAreaByCore: [22, 26, 30, 34, 38, 38], // centered square the player may build in
      deployMargin: 1                          // troops cannot be dropped this close to buildings
    },

    start: {
      credits: 750,
      energy: 750,
      troops: { scout: 6, ranger: 4 }
    },

    offline: {
      maxProductionHours: 8,   // production while away is capped at this much time
      reportAfterSec: 45,      // absences longer than this get a "while you were away" report
      catchUpStepSec: 60       // sub-step used when advancing long gaps (repairs can finish mid-gap)
    },

    repair: {
      creditsPerHp: 0.35,      // instant repair price
      minCost: 10
    },

    cancelRefund: 0.5,

    // ---------------------------------------------------------------- buildings
    buildings: {
      core: {
        name: 'Command Core', category: 'core', size: [4, 4], res: 'credits',
        desc: 'The heart of your settlement. Upgrading it unlocks new buildings, higher levels and more land. Destroying it wins a raid.',
        max: [1, 1, 1, 1, 1, 1],
        levels: levels({
          hp:    [1500, 1900, 2400, 3000, 3700, 4500],
          store: [1000, 1500, 2500, 4000, 6000, 8000],
          cost:  [0, 1500, 6000, 18000, 45000, 110000],
          time:  [0, 30, 120, 360, 900, 1800],
          core:  [1, 1, 2, 3, 4, 5]
        })
      },
      mint: {
        name: 'Credit Mint', category: 'economy', size: [3, 3], res: 'energy', produces: 'credits',
        desc: 'Presses Credits around the clock. Tap it to collect what it has stored.',
        max: [2, 3, 4, 5, 6, 6],
        levels: levels({
          hp:     [400, 450, 520, 600, 680, 760, 850, 950],
          rate:   [15, 24, 38, 56, 80, 110, 145, 185],   // per minute
          buffer: [2400, 4000, 6500, 9500, 13000, 17000, 22000, 28000],
          cost:   [150, 450, 1200, 3000, 7000, 15000, 30000, 60000],
          time:   [10, 30, 90, 240, 600, 1200, 2400, 3600],
          core:   [1, 1, 2, 2, 3, 4, 5, 6]
        })
      },
      well: {
        name: 'Energy Well', category: 'economy', size: [3, 3], res: 'credits', produces: 'energy',
        desc: 'Draws raw Energy from deep below. Energy trains troops and funds research.',
        max: [2, 3, 4, 5, 6, 6],
        levels: levels({
          hp:     [400, 450, 520, 600, 680, 760, 850, 950],
          rate:   [15, 24, 38, 56, 80, 110, 145, 185],
          buffer: [2400, 4000, 6500, 9500, 13000, 17000, 22000, 28000],
          cost:   [150, 450, 1200, 3000, 7000, 15000, 30000, 60000],
          time:   [10, 30, 90, 240, 600, 1200, 2400, 3600],
          core:   [1, 1, 2, 2, 3, 4, 5, 6]
        })
      },
      vault: {
        name: 'Credit Vault', category: 'economy', size: [3, 3], res: 'energy', stores: 'credits',
        desc: 'Raises how many Credits you can hold. Raiders steal from vaults, so protect them.',
        max: [1, 1, 2, 2, 3, 4],
        levels: levels({
          hp:       [600, 700, 820, 960, 1120, 1300, 1500],
          capacity: [1500, 3000, 6000, 12000, 25000, 50000, 100000],
          cost:     [300, 800, 2000, 5000, 12000, 30000, 70000],
          time:     [10, 40, 120, 300, 720, 1500, 3000],
          core:     [1, 1, 2, 3, 4, 5, 6]
        })
      },
      tank: {
        name: 'Energy Cell', category: 'economy', size: [3, 3], res: 'credits', stores: 'energy',
        desc: 'Raises how much Energy you can hold. Raiders drain cells they damage.',
        max: [1, 1, 2, 2, 3, 4],
        levels: levels({
          hp:       [600, 700, 820, 960, 1120, 1300, 1500],
          capacity: [1500, 3000, 6000, 12000, 25000, 50000, 100000],
          cost:     [300, 800, 2000, 5000, 12000, 30000, 70000],
          time:     [10, 40, 120, 300, 720, 1500, 3000],
          core:     [1, 1, 2, 3, 4, 5, 6]
        })
      },
      barracks: {
        name: 'Barracks', category: 'army', size: [4, 3], rotatable: true, res: 'energy',
        desc: 'Trains troops. Each level unlocks a new unit type, and every Barracks you own speeds up training.',
        max: [1, 1, 2, 2, 3, 3],
        levels: levels({
          hp:     [500, 580, 670, 770, 880],
          unlock: [['scout', 'ranger'], ['bruiser'], ['demo'], ['mage'], ['mender']],
          cost:   [200, 1000, 4000, 12000, 30000],
          time:   [10, 60, 180, 480, 1200],
          core:   [1, 1, 2, 3, 4]
        })
      },
      garrison: {
        name: 'Garrison', category: 'army', size: [4, 4], res: 'energy',
        desc: 'Houses your army. More and better Garrisons let you field a bigger force.',
        max: [1, 2, 2, 3, 3, 4],
        levels: levels({
          hp:       [400, 460, 530, 610, 700, 800],
          capacity: [20, 25, 30, 35, 40, 45],
          cost:     [250, 1200, 4000, 10000, 25000, 50000],
          time:     [10, 60, 180, 420, 900, 1800],
          core:     [1, 2, 3, 4, 5, 6]
        })
      },
      lab: {
        name: 'Research Lab', category: 'army', size: [3, 3], res: 'energy',
        desc: 'Researches stronger troops, tougher defenses and better economy. Its level caps research.',
        max: [0, 1, 1, 1, 1, 1],
        levels: levels({
          hp:   [500, 580, 670, 770, 880],
          cost: [1500, 5000, 15000, 40000, 90000],
          time: [60, 240, 600, 1500, 3000],
          core: [2, 3, 4, 5, 6]
        })
      },
      station: {
        name: 'Engineering Station', category: 'army', size: [2, 2], res: 'credits',
        desc: 'Home of one Engineer. Each Engineer runs one construction at a time and all stations repair damaged buildings.',
        max: [2, 3, 3, 4, 4, 5],
        buildCostByCount: [0, 0, 1000, 4000, 10000], // price of the Nth station; stations build instantly
        levels: levels({
          hp:     [250, 300, 360, 430],
          repair: [3, 5, 8, 12],      // hit points restored per second (shared across damaged buildings)
          cost:   [0, 1500, 5000, 15000],
          time:   [0, 60, 240, 900],
          core:   [1, 2, 3, 5]
        })
      },
      blaster: {
        name: 'Blaster Turret', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Reliable cannon that locks onto the nearest ground target and keeps firing until it falls.',
        max: [2, 2, 3, 3, 4, 5],
        attack: { kind: 'blaster', range: 7, period: 0.8, targeting: 'nearest', projectileSpeed: 14 },
        levels: levels({
          hp:   [420, 500, 600, 720, 860, 1000, 1150],
          dmg:  [8, 10, 13, 17, 22, 28, 35],
          cost: [250, 1000, 4000, 10000, 25000, 55000, 100000],
          time: [10, 45, 120, 300, 720, 1500, 2700],
          core: [1, 1, 2, 3, 4, 5, 6]
        })
      },
      spire: {
        name: 'Sentry Spire', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Tall watchtower with a rapid repeating crossbow. Long reach, light bolts.',
        max: [0, 1, 2, 3, 3, 4],
        attack: { kind: 'spire', range: 8.5, period: 0.5, targeting: 'nearest', projectileSpeed: 18 },
        levels: levels({
          hp:   [380, 450, 540, 650, 780, 920, 1080],
          dmg:  [5, 6, 8, 10, 13, 16, 20],
          cost: [400, 1500, 5000, 12000, 28000, 60000, 110000],
          time: [15, 60, 150, 360, 800, 1600, 3000],
          core: [2, 2, 3, 3, 4, 5, 6]
        })
      },
      mortar: {
        name: 'Quake Mortar', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Lobs heavy shells at the densest group of attackers. Huge splash, slow reload, blind up close.',
        max: [0, 0, 1, 2, 2, 3],
        attack: { kind: 'mortar', range: 10, minRange: 3.5, period: 4, targeting: 'cluster', splash: 1.5, flight: 1.3 },
        levels: levels({
          hp:   [500, 600, 720, 860, 1000, 1180],
          dmg:  [35, 48, 62, 80, 100, 125],
          cost: [8000, 18000, 35000, 60000, 90000, 130000],
          time: [120, 360, 900, 1500, 2400, 3600],
          core: [3, 3, 4, 4, 5, 6]
        })
      },
      frost: {
        name: 'Frost Pylon', category: 'defense', size: [2, 2], res: 'credits',
        desc: 'Emits a freezing field that slows every attacker inside it and chills them for light damage.',
        max: [0, 0, 1, 1, 2, 2],
        attack: { kind: 'frost', range: 4.5, period: 1, targeting: 'aura' },
        levels: levels({
          hp:   [450, 550, 660, 780],
          dmg:  [3, 5, 7, 9],
          slow: [0.35, 0.42, 0.5, 0.58],
          cost: [6000, 15000, 35000, 70000],
          time: [120, 480, 1200, 2400],
          core: [3, 4, 5, 6]
        })
      },
      lance: {
        name: 'Arc Lance', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Locks a lightning beam on one target. The longer it holds, the harder it burns. Ideal against Bruisers.',
        max: [0, 0, 0, 1, 1, 2],
        attack: { kind: 'lance', range: 7, period: 0.1, targeting: 'nearest', rampPerSec: 1, rampMax: 5 },
        levels: levels({
          hp:   [900, 1050, 1200],
          dmg:  [14, 19, 25],          // damage per second before ramp
          cost: [30000, 60000, 110000],
          time: [900, 1800, 3000],
          core: [4, 5, 6]
        })
      },
      mine: {
        name: 'Shock Mine', category: 'trap', size: [1, 1], res: 'credits', hidden: true, instant: true,
        desc: 'Hidden charge that detonates under attackers. Re-arms automatically after each battle.',
        max: [0, 2, 3, 4, 5, 6],
        attack: { kind: 'mine', range: 1.0, splash: 1.6, delay: 0.35 },
        levels: levels({
          hp:   [1, 1, 1],
          dmg:  [70, 100, 140],
          cost: [300, 2000, 8000],
          time: [0, 0, 0],
          core: [2, 4, 6]
        })
      },
      wall: {
        name: 'Wall', category: 'wall', size: [1, 1], res: 'credits', instant: true,
        desc: 'Blocks enemy movement. Attackers must break through or walk around. Drag to place a line.',
        max: [25, 50, 75, 100, 125, 150],
        levels: levels({
          hp:   [300, 500, 800, 1200, 1800, 2600],
          cost: [50, 200, 600, 1500, 4000, 9000],
          time: [0, 0, 0, 0, 0, 0],
          core: [1, 2, 3, 4, 5, 6]
        })
      }
    },

    buildMenu: [
      { id: 'economy', name: 'Economy', items: ['mint', 'well', 'vault', 'tank'] },
      { id: 'army', name: 'Army', items: ['barracks', 'garrison', 'lab', 'station'] },
      { id: 'defense', name: 'Defense', items: ['blaster', 'spire', 'mortar', 'frost', 'lance'] },
      { id: 'walls', name: 'Walls & Traps', items: ['wall', 'mine'] }
    ],

    // ---------------------------------------------------------------- troops
    // speed in tiles/second, range in tiles, period = seconds between attacks.
    troops: {
      scout: {
        name: 'Scout', space: 1, speed: 2.6, range: 0.6, period: 0.8, target: 'resource', time: 4,
        bonusVsResource: 2,
        desc: 'Cheap and fast. Rushes generators and storages and hits them twice as hard.',
        hp: [50, 57, 65, 75, 86], dmg: [9, 10, 12, 13, 15], cost: [25, 30, 35, 40, 45]
      },
      ranger: {
        name: 'Ranger', space: 1, speed: 1.7, range: 3.5, period: 0.9, target: 'any', careful: true, time: 6,
        projectile: 'arrow',
        desc: 'Fires from range and prefers targets away from enemy turrets.',
        hp: [36, 41, 47, 54, 62], dmg: [8, 9, 10, 12, 14], cost: [40, 48, 56, 64, 72]
      },
      bruiser: {
        name: 'Bruiser', space: 5, speed: 1.1, range: 0.7, period: 1.6, target: 'defense', time: 20,
        desc: 'A walking fortress. Heads straight for defenses and soaks up their fire.',
        hp: [420, 480, 550, 630, 720], dmg: [26, 30, 34, 39, 45], cost: [220, 260, 300, 340, 380]
      },
      demo: {
        name: 'Demolisher', space: 2, speed: 2.2, range: 0.5, period: 0, target: 'wall', time: 10,
        suicide: true, splash: 1.4, wallMult: 14, structMult: 2,
        desc: 'Sprints to the wall blocking your army and blows it apart. Deals double damage to buildings too.',
        hp: [34, 39, 45, 52, 60], dmg: [24, 28, 32, 37, 42], cost: [120, 140, 160, 180, 200]
      },
      mage: {
        name: 'Arc Mage', space: 4, speed: 1.4, range: 3, period: 1.4, target: 'any', time: 18,
        projectile: 'orb', splash: 0.9,
        desc: 'Hurls crackling orbs that splash across clustered buildings.',
        hp: [90, 104, 120, 138, 158], dmg: [30, 35, 40, 46, 53], cost: [300, 350, 400, 450, 500]
      },
      mender: {
        name: 'Mender', space: 10, speed: 1.3, range: 4, period: 1, target: 'troop', time: 40,
        healRadius: 1.8,
        desc: 'Field medic drone. Follows the most wounded troops and heals everyone nearby.',
        hp: [280, 320, 370, 425, 490], dmg: [28, 33, 38, 44, 50], cost: [600, 700, 800, 900, 1000]
      }
    },
    troopOrder: ['scout', 'ranger', 'bruiser', 'demo', 'mage', 'mender'],

    // ---------------------------------------------------------------- research
    research: {
      // Troop upgrades cost Energy. Level n+1 needs Research Lab level n.
      troops: {
        scout:   { cost: [500, 2000, 6000, 15000], time: [30, 120, 360, 900] },
        ranger:  { cost: [700, 2500, 7000, 18000], time: [40, 150, 420, 1000] },
        bruiser: { cost: [1500, 5000, 12000, 30000], time: [60, 240, 600, 1500] },
        demo:    { cost: [1200, 4000, 10000, 25000], time: [50, 200, 500, 1200] },
        mage:    { cost: [6000, 15000, 35000, 60000], time: [240, 600, 1200, 2400] },
        mender:  { cost: [10000, 25000, 50000, 90000], time: [300, 900, 1800, 3000] }
      },
      // Settlement technologies cost Credits. lab = Research Lab level needed per tech level.
      techs: {
        plating:    { name: 'Reinforced Plating', desc: 'Defense hit points', per: 0.08, res: 'credits', cost: [3000, 9000, 25000, 60000], time: [90, 300, 900, 1800], lab: [1, 2, 3, 4] },
        targeting:  { name: 'Targeting Matrix', desc: 'Defense damage', per: 0.08, res: 'credits', cost: [3000, 9000, 25000, 60000], time: [90, 300, 900, 1800], lab: [1, 2, 3, 4] },
        extraction: { name: 'Deep Extraction', desc: 'Resource production', per: 0.10, res: 'credits', cost: [2000, 7000, 20000, 50000], time: [60, 240, 720, 1500], lab: [1, 2, 3, 4] },
        compression:{ name: 'Compression Storage', desc: 'Storage capacity', per: 0.10, res: 'credits', cost: [2500, 8000, 22000, 55000], time: [60, 240, 720, 1500], lab: [1, 2, 3, 4] },
        drills:     { name: 'Rapid Drills', desc: 'Troop training speed', per: 0.15, res: 'credits', cost: [2000, 6000, 18000, 45000], time: [60, 240, 720, 1500], lab: [1, 2, 3, 4] }
      }
    },

    // ---------------------------------------------------------------- battles
    battle: {
      tickRate: 30,              // simulation steps per second
      raidSeconds: 150,          // player attacks
      defenseSeconds: 90,        // NPC raids on the home base
      winDestruction: 0.5,       // destruction needed for a win (or destroy the Command Core)
      maxSpeed: 3,
      wallBreakPenalty: 30,      // extra path cost (seconds) for walking through non-wall buildings
      renownWin: [8, 12, 16],    // per star count 1..3 (+2 per tier)
      renownLoss: 6
    },

    // ---------------------------------------------------------------- NPC world
    factions: {
      thorn:  { name: 'Thornwood Clans', color: '#6fcf4f', biome: 'meadow', aggression: 0.5, layouts: ['spread', 'ring'], troops: ['scout', 'ranger', 'bruiser'] },
      dune:   { name: 'Dune Reavers', color: '#f0b440', biome: 'desert', aggression: 1.0, layouts: ['compartments', 'ring'], troops: ['scout', 'bruiser', 'demo'] },
      mire:   { name: 'Mirewatch Coven', color: '#b98cff', biome: 'swamp', aggression: 0.8, layouts: ['spread', 'compartments'], troops: ['ranger', 'mage', 'demo'] },
      frost:  { name: 'Frostpeak Sentinels', color: '#8fd3ff', biome: 'snow', aggression: 0.6, layouts: ['fortress', 'compartments'], troops: ['bruiser', 'ranger', 'mage'] },
      cinder: { name: 'Cinder Legion', color: '#ff6b45', biome: 'volcanic', aggression: 1.2, layouts: ['fortress', 'ring'], troops: ['bruiser', 'demo', 'mage', 'scout'] }
    },

    // Fixed roster of opponents. pos = position on the world map (0..1).
    settlements: [
      { id: 'mossy-hollow', name: 'Mossy Hollow', faction: 'thorn', tier: 1, leader: 'Elder Bramwick', pos: [0.37, 0.62] },
      { id: 'driftwood-camp', name: 'Driftwood Camp', faction: 'mire', tier: 1, leader: 'Old Nessa', pos: [0.62, 0.66] },
      { id: 'pebblebrook', name: 'Pebblebrook Outpost', faction: 'thorn', tier: 1, leader: 'Warden Tibbs', pos: [0.5, 0.78] },
      { id: 'sandscar-den', name: 'Sandscar Den', faction: 'dune', tier: 2, leader: 'Raider Khessa', pos: [0.72, 0.5] },
      { id: 'bramble-keep', name: 'Bramble Keep', faction: 'thorn', tier: 2, leader: 'Thane Orrin', pos: [0.26, 0.48] },
      { id: 'rustgate-post', name: 'Rustgate Post', faction: 'dune', tier: 2, leader: 'Sergeant Vrell', pos: [0.67, 0.83] },
      { id: 'glimmerfen', name: 'Glimmerfen', faction: 'mire', tier: 3, leader: 'Witch Ysolde', pos: [0.2, 0.74] },
      { id: 'ironroot-hold', name: 'Ironroot Hold', faction: 'frost', tier: 3, leader: 'Marshal Dunmore', pos: [0.4, 0.33] },
      { id: 'sunscald-bastion', name: 'Sunscald Bastion', faction: 'dune', tier: 3, leader: 'Emir Qadeth', pos: [0.84, 0.66] },
      { id: 'frostspire-citadel', name: 'Frostspire Citadel', faction: 'frost', tier: 4, leader: 'Lady Isenreth', pos: [0.28, 0.2] },
      { id: 'basalt-watch', name: 'Basalt Watch', faction: 'cinder', tier: 4, leader: 'Captain Skarn', pos: [0.78, 0.3] },
      { id: 'hagmoor', name: 'Hagmoor Sanctum', faction: 'mire', tier: 4, leader: 'Matron Gloam', pos: [0.1, 0.55] },
      { id: 'howling-ridge', name: 'Howling Ridge', faction: 'frost', tier: 5, leader: 'Jarl Vintergrim', pos: [0.52, 0.12] },
      { id: 'cinderforge', name: 'Cinderforge', faction: 'cinder', tier: 5, leader: 'Forgemaster Kael', pos: [0.88, 0.16] },
      { id: 'obsidian-throne', name: 'Obsidian Throne', faction: 'cinder', tier: 5, leader: 'The Ashen King', pos: [0.66, 0.06] }
    ],

    // What an NPC settlement of each tier looks like. [min,max] counts and levels.
    tiers: [
      null,
      { core: 1, area: 22, walls: [6, 14], wallLv: [1, 1],
        b: { blaster: [1, 1, 1, 1], mint: [2, 2, 1, 2], well: [1, 2, 1, 2], vault: [1, 1, 1, 1], tank: [1, 1, 1, 1], barracks: [1, 1, 1, 1], garrison: [1, 1, 1, 1], station: [1, 1, 1, 1] },
        loot: [900, 1200], bonus: 200, armyPower: 10 },
      { core: 2, area: 26, walls: [24, 36], wallLv: [1, 2],
        b: { blaster: [2, 2, 1, 2], spire: [1, 1, 1, 2], mine: [1, 2, 1, 1], mint: [3, 3, 2, 3], well: [2, 3, 2, 3], vault: [1, 1, 2, 2], tank: [1, 1, 2, 2], barracks: [1, 1, 1, 2], garrison: [1, 2, 1, 2], lab: [1, 1, 1, 1], station: [2, 2, 1, 1] },
        loot: [2200, 3200], bonus: 500, armyPower: 22 },
      { core: 3, area: 30, walls: [44, 60], wallLv: [2, 3],
        b: { blaster: [3, 3, 2, 3], spire: [2, 2, 2, 3], mortar: [1, 1, 1, 1], frost: [1, 1, 1, 1], mine: [2, 3, 1, 1], mint: [3, 4, 3, 4], well: [3, 4, 3, 4], vault: [2, 2, 3, 3], tank: [2, 2, 3, 3], barracks: [2, 2, 2, 3], garrison: [2, 2, 2, 3], lab: [1, 1, 2, 2], station: [2, 3, 1, 2] },
        loot: [5000, 7000], bonus: 1200, armyPower: 40 },
      { core: 4, area: 34, walls: [70, 90], wallLv: [3, 4],
        b: { blaster: [3, 3, 3, 4], spire: [3, 3, 3, 4], mortar: [2, 2, 2, 3], frost: [1, 1, 2, 2], lance: [1, 1, 1, 1], mine: [3, 4, 2, 2], mint: [4, 5, 4, 5], well: [4, 5, 4, 5], vault: [2, 2, 4, 4], tank: [2, 2, 4, 4], barracks: [2, 2, 3, 4], garrison: [3, 3, 3, 4], lab: [1, 1, 3, 3], station: [3, 4, 2, 2] },
        loot: [11000, 15000], bonus: 3000, armyPower: 65 },
      { core: 5, area: 38, walls: [100, 125], wallLv: [4, 5],
        b: { blaster: [4, 4, 4, 5], spire: [3, 3, 4, 5], mortar: [2, 2, 3, 4], frost: [2, 2, 2, 3], lance: [1, 2, 1, 2], mine: [4, 5, 2, 3], mint: [5, 6, 5, 6], well: [5, 6, 5, 6], vault: [3, 3, 5, 5], tank: [3, 3, 5, 5], barracks: [3, 3, 4, 5], garrison: [3, 3, 4, 5], lab: [1, 1, 4, 4], station: [4, 4, 3, 3] },
        loot: [24000, 32000], bonus: 7000, armyPower: 95 }
    ],

    world: {
      unlockWins: 2,           // victories in a tier needed to unlock the next tier
      lootRegenMin: 40,        // minutes for a settlement's loot to fully recover
      rebuildMin: 4,           // after a defeat the settlement is closed while it rebuilds
      maxFortify: 3,           // each defeat makes a settlement up to +2 levels tougher (and richer)
      fortifyLootBonus: 0.2,
      newsEveryMin: [8, 16],   // independent NPC activity
      maxNewsPerCatchUp: 6
    },

    // ---------------------------------------------------------------- NPC raids on the home base
    attacks: {
      protectionMin: 15,               // new settlements are safe for this long
      shieldMin: { defended: 8, raided: 20 },
      minIntervalMin: 10,              // never two raids closer together than this
      randomPerHour: 2,                // expected random raids per hour once eligible
      firstRaidDelayMin: [2, 5],       // the first raid ever comes this soon after protection ends
      warningSec: 75,                  // live raids are announced this far in advance
      retaliation: { base: 0.35, perHostility: 0.2, delayMin: [3, 8] },
      offline: { minAbsenceSec: 120, maxPerAbsence: 2, maxPerDay: 8 },
      maxDestruction: 0.6,             // raiders withdraw once this much of the base is down
      steal: { storageFraction: 0.12, collectorFraction: 0.4, capByCore: [400, 1200, 3500, 9000, 20000, 40000] },
      // Army housing space NPC raiders bring, by the player's Command Core level.
      armySpaceByCore: [8, 18, 28, 40, 55, 70],
      troopLevelByCore: [1, 1, 2, 2, 3, 4],
      modes: {
        off: { label: 'Off', freq: 0 },
        relaxed: { label: 'Relaxed', freq: 0.5 },
        normal: { label: 'Normal', freq: 1 },
        intense: { label: 'Intense', freq: 2 }
      }
    },

    player: {
      xpForLevel: function (lv) { return Math.round(40 * Math.pow(lv, 1.6)); }
    }
  };

  CS.CONFIG = CONFIG;
})(window.CS = window.CS || {});
