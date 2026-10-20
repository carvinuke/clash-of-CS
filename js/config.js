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
      buildAreaByCore: [22, 26, 30, 34, 38, 38, 40, 41, 42], // centered square the player may build in
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
        max: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        levels: levels({
          hp:    [1500, 1900, 2400, 3000, 3700, 4500, 5400, 6400, 7500],
          store: [1000, 1500, 2500, 4000, 6000, 8000, 10000, 12500, 15000],
          cost:  [0, 1500, 6000, 18000, 45000, 110000, 220000, 380000, 600000],
          time:  [0, 30, 120, 360, 900, 1800, 2700, 3600, 5400],
          core:  [1, 1, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      mint: {
        name: 'Credit Mint', category: 'economy', size: [3, 3], res: 'energy', produces: 'credits',
        desc: 'Presses Credits around the clock. Tap it to collect what it has stored.',
        max: [2, 3, 4, 5, 6, 6, 7, 7, 8],
        levels: levels({
          hp:     [400, 450, 520, 600, 680, 760, 850, 950, 1060, 1180],
          rate:   [15, 24, 38, 56, 80, 110, 145, 185, 230, 280],   // per minute
          buffer: [2400, 4000, 6500, 9500, 13000, 17000, 22000, 28000, 35000, 43000],
          cost:   [150, 450, 1200, 3000, 7000, 15000, 30000, 60000, 110000, 180000],
          time:   [10, 30, 90, 240, 600, 1200, 2400, 3600, 4800, 6000],
          core:   [1, 1, 2, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      well: {
        name: 'Energy Well', category: 'economy', size: [3, 3], res: 'credits', produces: 'energy',
        desc: 'Draws raw Energy from deep below. Energy trains troops and funds research.',
        max: [2, 3, 4, 5, 6, 6, 7, 7, 8],
        levels: levels({
          hp:     [400, 450, 520, 600, 680, 760, 850, 950, 1060, 1180],
          rate:   [15, 24, 38, 56, 80, 110, 145, 185, 230, 280],
          buffer: [2400, 4000, 6500, 9500, 13000, 17000, 22000, 28000, 35000, 43000],
          cost:   [150, 450, 1200, 3000, 7000, 15000, 30000, 60000, 110000, 180000],
          time:   [10, 30, 90, 240, 600, 1200, 2400, 3600, 4800, 6000],
          core:   [1, 1, 2, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      vault: {
        name: 'Credit Vault', category: 'economy', size: [3, 3], res: 'energy', stores: 'credits',
        desc: 'Raises how many Credits you can hold. Raiders steal from vaults, so protect them.',
        max: [1, 1, 2, 2, 3, 4, 4, 5, 5],
        levels: levels({
          hp:       [600, 700, 820, 960, 1120, 1300, 1500, 1750, 2000],
          capacity: [1500, 3000, 6000, 12000, 25000, 50000, 100000, 160000, 250000],
          cost:     [300, 800, 2000, 5000, 12000, 30000, 70000, 130000, 220000],
          time:     [10, 40, 120, 300, 720, 1500, 3000, 4200, 5400],
          core:     [1, 1, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      tank: {
        name: 'Energy Cell', category: 'economy', size: [3, 3], res: 'credits', stores: 'energy',
        desc: 'Raises how much Energy you can hold. Raiders drain cells they damage.',
        max: [1, 1, 2, 2, 3, 4, 4, 5, 5],
        levels: levels({
          hp:       [600, 700, 820, 960, 1120, 1300, 1500, 1750, 2000],
          capacity: [1500, 3000, 6000, 12000, 25000, 50000, 100000, 160000, 250000],
          cost:     [300, 800, 2000, 5000, 12000, 30000, 70000, 130000, 220000],
          time:     [10, 40, 120, 300, 720, 1500, 3000, 4200, 5400],
          core:     [1, 1, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      bunker: {
        name: 'Reserve Bunker', category: 'economy', size: [3, 3], res: 'energy', storesBoth: true,
        desc: 'Armoured strongroom that holds both Credits and Energy. Very tough, so raiders pay dearly to crack it.',
        max: [0, 0, 0, 0, 0, 0, 1, 1, 2],
        levels: levels({
          hp:    [2600, 3000, 3500],
          store: [60000, 100000, 150000],   // of each resource
          cost:  [120000, 220000, 360000],
          time:  [2400, 3600, 5400],
          core:  [7, 8, 9]
        })
      },
      barracks: {
        name: 'Barracks', category: 'army', size: [4, 3], rotatable: true, res: 'energy',
        desc: 'Trains troops. Each level unlocks a new unit type, and every Barracks you own speeds up training.',
        max: [1, 1, 2, 2, 3, 3, 4, 4, 4],
        levels: levels({
          hp:     [500, 580, 670, 770, 880, 1000],
          unlock: [['scout', 'ranger'], ['bruiser', 'lancer'], ['demo'], ['mage', 'gyro'], ['mender'], ['colossus']],
          cost:   [200, 1000, 4000, 12000, 30000, 60000],
          time:   [10, 60, 180, 480, 1200, 2400],
          core:   [1, 1, 2, 3, 4, 5]
        })
      },
      garrison: {
        name: 'Garrison', category: 'army', size: [4, 4], res: 'energy',
        desc: 'Houses your army. More and better Garrisons let you field a bigger force.',
        max: [1, 2, 2, 3, 3, 4, 4, 5, 5],
        levels: levels({
          hp:       [400, 460, 530, 610, 700, 800, 920, 1050],
          capacity: [20, 25, 30, 35, 40, 45, 50, 55],
          cost:     [250, 1200, 4000, 10000, 25000, 50000, 90000, 150000],
          time:     [10, 60, 180, 420, 900, 1800, 3000, 4200],
          core:     [1, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      lab: {
        name: 'Research Lab', category: 'army', size: [3, 3], res: 'energy',
        desc: 'Researches stronger troops, tougher defenses and better economy. Its level caps research.',
        max: [0, 1, 1, 1, 1, 1, 1, 1, 1],
        levels: levels({
          hp:   [500, 580, 670, 770, 880],
          cost: [1500, 5000, 15000, 40000, 90000],
          time: [60, 240, 600, 1500, 3000],
          core: [2, 3, 4, 5, 6]
        })
      },
      hall: {
        name: 'War Hall', category: 'army', size: [3, 3], res: 'energy', hero: 'marshal',
        desc: 'Seat of the Iron Marshal. Upgrading the hall raises his level; he cannot fight while it is upgrading.',
        max: [0, 1, 1, 1, 1, 1, 1, 1, 1],
        levels: levels({
          hp:   [700, 800, 920, 1050, 1200, 1380, 1580],
          cost: [3000, 9000, 20000, 45000, 85000, 140000, 220000],
          time: [120, 480, 1200, 2400, 3600, 4800, 6000],
          core: [2, 3, 4, 5, 6, 7, 8]
        })
      },
      lodge: {
        name: 'Huntress Lodge', category: 'army', size: [3, 3], res: 'energy', hero: 'huntress',
        desc: 'Home of the Storm Huntress. Upgrading the lodge raises her level; she cannot fight while it is upgrading.',
        max: [0, 0, 1, 1, 1, 1, 1, 1, 1],
        levels: levels({
          hp:   [600, 690, 790, 900, 1020, 1160, 1320],
          cost: [6000, 15000, 30000, 55000, 95000, 150000, 240000],
          time: [240, 720, 1500, 2700, 3600, 4800, 6000],
          core: [3, 4, 5, 6, 6, 7, 8]
        })
      },
      station: {
        name: 'Engineering Station', category: 'army', size: [2, 2], res: 'credits',
        desc: 'Home of one Engineer. Each Engineer runs one construction at a time and all stations repair damaged buildings.',
        max: [2, 3, 3, 4, 4, 5, 5, 6, 6],
        buildCostByCount: [0, 0, 1000, 4000, 10000, 25000], // price of the Nth station; stations build instantly
        levels: levels({
          hp:     [250, 300, 360, 430, 520],
          repair: [3, 5, 8, 12, 18],      // hit points restored per second (shared across damaged buildings)
          cost:   [0, 1500, 5000, 15000, 40000],
          time:   [0, 60, 240, 900, 1800],
          core:   [1, 2, 3, 5, 7]
        })
      },
      blaster: {
        name: 'Blaster Turret', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Reliable cannon that locks onto the nearest ground target and keeps firing until it falls. Cannot hit flying troops.',
        max: [2, 2, 3, 3, 4, 5, 5, 6, 6],
        attack: { kind: 'blaster', ground: true, range: 7, period: 0.8, targeting: 'nearest', projectileSpeed: 14 },
        levels: levels({
          hp:   [420, 500, 600, 720, 860, 1000, 1150, 1320, 1500],
          dmg:  [8, 10, 13, 17, 22, 28, 35, 43, 52],
          cost: [250, 1000, 4000, 10000, 25000, 55000, 100000, 160000, 240000],
          time: [10, 45, 120, 300, 720, 1500, 2700, 3600, 4800],
          core: [1, 1, 2, 3, 4, 5, 6, 7, 8]
        })
      },
      spire: {
        name: 'Sentry Spire', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Tall watchtower with a rapid repeating crossbow. Long reach, light bolts, and it shoots down flying troops.',
        max: [0, 1, 2, 3, 3, 4, 5, 5, 6],
        attack: { kind: 'spire', range: 8.5, period: 0.5, targeting: 'nearest', projectileSpeed: 18 },
        levels: levels({
          hp:   [380, 450, 540, 650, 780, 920, 1080, 1250, 1430],
          dmg:  [5, 6, 8, 10, 13, 16, 20, 24, 29],
          cost: [400, 1500, 5000, 12000, 28000, 60000, 110000, 170000, 250000],
          time: [15, 60, 150, 360, 800, 1600, 3000, 3600, 4800],
          core: [2, 2, 3, 3, 4, 5, 6, 7, 8]
        })
      },
      mortar: {
        name: 'Quake Mortar', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Lobs heavy shells at the densest group of attackers. Huge splash, slow reload, blind up close and to flying troops.',
        max: [0, 0, 1, 2, 2, 3, 3, 4, 4],
        attack: { kind: 'mortar', ground: true, range: 10, minRange: 3.5, period: 4, targeting: 'cluster', splash: 1.5, flight: 1.3 },
        levels: levels({
          hp:   [500, 600, 720, 860, 1000, 1180, 1380, 1600],
          dmg:  [35, 48, 62, 80, 100, 125, 150, 180],
          cost: [8000, 18000, 35000, 60000, 90000, 130000, 180000, 260000],
          time: [120, 360, 900, 1500, 2400, 3600, 4200, 5400],
          core: [3, 3, 4, 4, 5, 6, 7, 8]
        })
      },
      frost: {
        name: 'Frost Pylon', category: 'defense', size: [2, 2], res: 'credits',
        desc: 'Emits a freezing field that slows every attacker inside it and chills them for light damage.',
        max: [0, 0, 1, 1, 2, 2, 3, 3, 3],
        attack: { kind: 'frost', range: 4.5, period: 1, targeting: 'aura' },
        levels: levels({
          hp:   [450, 550, 660, 780, 920, 1080],
          dmg:  [3, 5, 7, 9, 11, 14],
          slow: [0.35, 0.42, 0.5, 0.58, 0.62, 0.66],
          cost: [6000, 15000, 35000, 70000, 120000, 200000],
          time: [120, 480, 1200, 2400, 3600, 4800],
          core: [3, 4, 5, 6, 7, 8]
        })
      },
      lance: {
        name: 'Arc Lance', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Locks a lightning beam on one target. The longer it holds, the harder it burns. Ideal against Bruisers.',
        max: [0, 0, 0, 1, 1, 2, 2, 3, 3],
        attack: { kind: 'lance', range: 7, period: 0.1, targeting: 'nearest', rampPerSec: 1, rampMax: 5 },
        levels: levels({
          hp:   [900, 1050, 1200, 1380, 1580],
          dmg:  [14, 19, 25, 32, 40],          // damage per second before ramp
          cost: [30000, 60000, 110000, 180000, 270000],
          time: [900, 1800, 3000, 4200, 5400],
          core: [4, 5, 6, 7, 8]
        })
      },
      flak: {
        name: 'Skyburst Battery', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Twin anti-air guns whose shells burst among flying troops, hurting every flyer nearby. Cannot hit ground troops.',
        max: [0, 0, 0, 1, 1, 2, 2, 3, 3],
        attack: { kind: 'flak', air: true, range: 9, period: 1.6, targeting: 'nearest', projectileSpeed: 12, splash: 1.4 },
        levels: levels({
          hp:   [800, 920, 1060, 1220, 1400],
          dmg:  [40, 52, 66, 82, 100],
          cost: [20000, 40000, 70000, 120000, 200000],
          time: [600, 1200, 2100, 3000, 4200],
          core: [4, 5, 6, 7, 8]
        })
      },
      rail: {
        name: 'Longshot Bastion', category: 'defense', size: [3, 3], res: 'credits',
        desc: 'Fortified rail gun with the longest reach of any defense. Picks out the toughest attacker in range and hits it very hard.',
        max: [0, 0, 0, 0, 0, 0, 1, 1, 2],
        attack: { kind: 'rail', range: 11, period: 3, targeting: 'toughest', projectileSpeed: 24 },
        levels: levels({
          hp:   [1500, 1750, 2000, 2300],
          dmg:  [180, 230, 290, 360],
          cost: [150000, 240000, 350000, 500000],
          time: [2400, 3600, 4800, 6000],
          core: [7, 7, 8, 9]
        })
      },
      mine: {
        name: 'Shock Mine', category: 'trap', size: [1, 1], res: 'credits', hidden: true, instant: true,
        desc: 'Hidden charge that detonates under attackers. Re-arms automatically after each battle.',
        max: [0, 2, 3, 4, 5, 6, 7, 8, 9],
        attack: { kind: 'mine', ground: true, range: 1.0, splash: 1.6, delay: 0.35 },
        levels: levels({
          hp:   [1, 1, 1, 1],
          dmg:  [70, 100, 140, 190],
          cost: [300, 2000, 8000, 20000],
          time: [0, 0, 0, 0],
          core: [2, 4, 6, 8]
        })
      },
      snare: {
        name: 'Sky Snare', category: 'trap', size: [1, 1], res: 'credits', hidden: true, instant: true,
        desc: 'Hidden launcher that fires a weighted net into the first flying troop above it. Re-arms after each battle.',
        max: [0, 0, 0, 2, 2, 3, 3, 4, 4],
        attack: { kind: 'mine', air: true, range: 1.4, splash: 1.2, delay: 0.2 },
        levels: levels({
          hp:   [1, 1, 1],
          dmg:  [200, 280, 380],
          cost: [4000, 12000, 30000],
          time: [0, 0, 0],
          core: [4, 6, 8]
        })
      },
      wall: {
        name: 'Wall', category: 'wall', size: [1, 1], res: 'credits', instant: true,
        desc: 'Blocks enemy movement. Attackers must break through or walk around. Drag to place a line.',
        max: [25, 50, 75, 100, 125, 150, 175, 200, 250],
        levels: levels({
          hp:   [300, 500, 800, 1200, 1800, 2600, 3600, 4800, 6200],
          cost: [50, 200, 600, 1500, 4000, 9000, 16000, 28000, 45000],
          time: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          core: [1, 2, 3, 4, 5, 6, 7, 8, 9]
        })
      }
    },

    buildMenu: [
      { id: 'economy', name: 'Economy', items: ['mint', 'well', 'vault', 'tank', 'bunker'] },
      { id: 'army', name: 'Army', items: ['barracks', 'garrison', 'lab', 'station', 'hall', 'lodge'] },
      { id: 'defense', name: 'Defense', items: ['blaster', 'spire', 'mortar', 'frost', 'lance', 'flak', 'rail'] },
      { id: 'walls', name: 'Walls & Traps', items: ['wall', 'mine', 'snare'] }
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
      },
      lancer: {
        name: 'Lancer', space: 3, speed: 2.0, range: 0.7, period: 1.2, target: 'any', time: 12,
        charge: 3,
        desc: 'Mounted spear rider. The first strike against each new target lands three times as hard.',
        hp: [160, 184, 212, 244, 280], dmg: [22, 25, 29, 33, 38], cost: [90, 105, 120, 135, 150]
      },
      gyro: {
        name: 'Gyrocopter', space: 5, speed: 1.6, range: 0.9, period: 2.2, target: 'any', time: 24,
        air: true, splash: 0.8,
        desc: 'Rotor craft that flies over walls and drops bombs. Blaster Turrets, Quake Mortars and Shock Mines cannot touch it, but Skyburst Batteries and Sky Snares are built to bring it down.',
        hp: [160, 184, 212, 244, 280], dmg: [36, 41, 47, 54, 62], cost: [380, 440, 500, 560, 620]
      },
      colossus: {
        name: 'Colossus', space: 18, speed: 0.75, range: 0.9, period: 2.4, target: 'defense', time: 90,
        splash: 1.2,
        desc: 'A walking siege engine with an enormous health pool. Marches on defenses and its stomp crushes everything around the target, walls included.',
        hp: [2400, 2700, 3050, 3450, 3900], dmg: [60, 68, 77, 87, 98], cost: [1800, 2000, 2200, 2400, 2600]
      },
      // Heroes: one of each, never trained. Their level is the level of their building
      // (War Hall, Huntress Lodge), so the arrays below have one entry per building level.
      marshal: {
        name: 'Iron Marshal', hero: true, space: 0, speed: 1.5, range: 0.8, period: 1.2, target: 'any',
        desc: 'Armoured commander with a war hammer. Fights whatever is closest and leads from the front.',
        hp: [900, 1100, 1350, 1650, 2000, 2400, 2850], dmg: [45, 55, 68, 82, 100, 120, 142]
      },
      huntress: {
        name: 'Storm Huntress', hero: true, space: 0, speed: 1.7, range: 4.5, period: 0.9, target: 'any',
        projectile: 'arrow',
        desc: 'Long-range archer whose storm-charged arrows outrange most defenses.',
        hp: [380, 460, 560, 680, 820, 980, 1160], dmg: [38, 46, 56, 68, 82, 98, 116]
      }
    },
    troopOrder: ['scout', 'ranger', 'bruiser', 'lancer', 'demo', 'mage', 'gyro', 'mender', 'colossus'],
    heroOrder: ['marshal', 'huntress'],

    // Hero abilities fire once per battle when the player taps the hero again after deploying it.
    // After a raid a hero rests: recovery time is recoverMin (by level) times the share of health lost.
    heroes: {
      marshal: {
        building: 'hall', recoverMin: [5, 7, 9, 11, 14, 16, 18],
        ability: {
          kind: 'rally', name: 'War Cry',
          desc: 'Heals the Marshal, calls in Scouts, and for a few seconds he and every troop near him hit harder and move faster.',
          sec: [8, 8, 9, 9, 10, 10, 11], heal: [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55], radius: 4, dmgMult: 1.5, speedMult: 1.3,
          summon: 'scout', summonN: [2, 2, 3, 3, 4, 4, 5]
        }
      },
      huntress: {
        building: 'lodge', recoverMin: [6, 8, 10, 12, 15, 17, 19],
        ability: {
          kind: 'cloak', name: 'Smoke Veil',
          desc: 'Vanishes in smoke: defenses lose track of her, she heals, and her arrows hit far harder until she reappears.',
          sec: [4, 4.5, 5, 5.5, 6, 6.5, 7], heal: [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6], dmgMult: 2.5
        }
      }
    },

    // ---------------------------------------------------------------- research
    research: {
      // Troop upgrades cost Energy. Level n+1 needs Research Lab level n.
      troops: {
        scout:   { cost: [500, 2000, 6000, 15000], time: [30, 120, 360, 900] },
        ranger:  { cost: [700, 2500, 7000, 18000], time: [40, 150, 420, 1000] },
        bruiser: { cost: [1500, 5000, 12000, 30000], time: [60, 240, 600, 1500] },
        demo:    { cost: [1200, 4000, 10000, 25000], time: [50, 200, 500, 1200] },
        mage:    { cost: [6000, 15000, 35000, 60000], time: [240, 600, 1200, 2400] },
        mender:  { cost: [10000, 25000, 50000, 90000], time: [300, 900, 1800, 3000] },
        lancer:  { cost: [2500, 7000, 16000, 35000], time: [90, 300, 720, 1500] },
        gyro:    { cost: [8000, 20000, 40000, 70000], time: [300, 720, 1500, 2700] },
        colossus:{ cost: [20000, 40000, 70000, 110000], time: [600, 1200, 2400, 3600] }
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
      guardRadius: 7,            // defending heroes chase raiders up to this far from their home
      renownWin: [8, 12, 16],    // per star count 1..3 (+2 per tier)
      renownLoss: 6
    },

    // ---------------------------------------------------------------- NPC world
    factions: {
      thorn:  { name: 'Thornwood Clans', color: '#6fcf4f', biome: 'meadow', aggression: 0.5, layouts: ['spread', 'ring'], troops: ['scout', 'ranger', 'bruiser', 'lancer'] },
      dune:   { name: 'Dune Reavers', color: '#f0b440', biome: 'desert', aggression: 1.0, layouts: ['compartments', 'ring'], troops: ['scout', 'bruiser', 'demo', 'lancer'] },
      mire:   { name: 'Mirewatch Coven', color: '#b98cff', biome: 'swamp', aggression: 0.8, layouts: ['spread', 'compartments'], troops: ['ranger', 'mage', 'demo', 'gyro'] },
      frost:  { name: 'Frostpeak Sentinels', color: '#8fd3ff', biome: 'snow', aggression: 0.6, layouts: ['fortress', 'compartments'], troops: ['bruiser', 'ranger', 'mage', 'colossus'] },
      cinder: { name: 'Cinder Legion', color: '#ff6b45', biome: 'volcanic', aggression: 1.2, layouts: ['fortress', 'ring'], troops: ['bruiser', 'demo', 'mage', 'scout', 'gyro', 'colossus'] }
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
      { id: 'obsidian-throne', name: 'Obsidian Throne', faction: 'cinder', tier: 5, leader: 'The Ashen King', pos: [0.66, 0.06] },
      { id: 'stormcrown-aerie', name: 'Stormcrown Aerie', faction: 'frost', tier: 6, leader: 'Skywarden Halvra', pos: [0.12, 0.1] },
      { id: 'duskmire-spire', name: 'Duskmire Spire', faction: 'mire', tier: 6, leader: 'The Pale Oracle', pos: [0.36, 0.05] },
      { id: 'ember-caldera', name: 'Ember Caldera', faction: 'cinder', tier: 6, leader: 'High Pyrarch Volkan', pos: [0.95, 0.4] }
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
        b: { blaster: [3, 3, 3, 4], spire: [3, 3, 3, 4], mortar: [2, 2, 2, 3], frost: [1, 1, 2, 2], lance: [1, 1, 1, 1], flak: [0, 1, 1, 1], mine: [3, 4, 2, 2], mint: [4, 5, 4, 5], well: [4, 5, 4, 5], vault: [2, 2, 4, 4], tank: [2, 2, 4, 4], barracks: [2, 2, 3, 4], garrison: [3, 3, 3, 4], lab: [1, 1, 3, 3], station: [3, 4, 2, 2] },
        loot: [11000, 15000], bonus: 3000, armyPower: 65 },
      { core: 5, area: 38, walls: [100, 125], wallLv: [4, 5],
        b: { blaster: [4, 4, 4, 5], spire: [3, 3, 4, 5], mortar: [2, 2, 3, 4], frost: [2, 2, 2, 3], lance: [1, 2, 1, 2], flak: [1, 1, 1, 2], mine: [4, 5, 2, 3], snare: [1, 2, 1, 1], mint: [5, 6, 5, 6], well: [5, 6, 5, 6], vault: [3, 3, 5, 5], tank: [3, 3, 5, 5], barracks: [3, 3, 4, 5], garrison: [3, 3, 4, 5], lab: [1, 1, 4, 4], station: [4, 4, 3, 3] },
        loot: [24000, 32000], bonus: 7000, armyPower: 95 },
      { core: 7, area: 40, walls: [130, 160], wallLv: [6, 7],
        b: { blaster: [5, 5, 6, 7], spire: [4, 5, 6, 7], mortar: [3, 3, 6, 7], frost: [2, 2, 4, 5], lance: [2, 2, 3, 4], flak: [2, 2, 3, 4], rail: [1, 1, 1, 2], mine: [5, 6, 3, 4], snare: [2, 3, 1, 2], mint: [6, 6, 7, 8], well: [6, 6, 7, 8], vault: [4, 4, 6, 7], tank: [4, 4, 6, 7], bunker: [1, 1, 1, 1], barracks: [3, 3, 5, 6], garrison: [4, 4, 5, 6], lab: [1, 1, 5, 5], station: [4, 5, 3, 4] },
        loot: [45000, 60000], bonus: 12000, armyPower: 130 }
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
      steal: { storageFraction: 0.12, collectorFraction: 0.4, capByCore: [400, 1200, 3500, 9000, 20000, 40000, 60000, 85000, 110000] },
      // Army housing space NPC raiders bring, by the player's Command Core level.
      armySpaceByCore: [8, 18, 28, 40, 55, 70, 85, 100, 115],
      troopLevelByCore: [1, 1, 2, 2, 3, 4, 4, 5, 5],
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

  CONFIG.deployOrder = CONFIG.troopOrder.concat(CONFIG.heroOrder);   // battle tray order and 1-9 keys
  CS.CONFIG = CONFIG;
})(window.CS = window.CS || {});
