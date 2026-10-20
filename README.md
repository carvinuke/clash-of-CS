# Clash of CS

A single-player strategy game that runs in your browser with no internet connection. Build a settlement on an isometric grid, collect Credits and Energy, train an army, and raid fifteen NPC settlements across five tiers while defending your own base from their counter-attacks.

There is nothing to install: no server, account, build step or download at runtime. All art is drawn in code with Canvas 2D and inline SVG, all sound is synthesized with the Web Audio API, and the two typefaces ship in the `fonts/` folder, so the whole game is a handful of plain HTML, CSS and JavaScript files.

## Play

1. On GitHub, click **Code → Download ZIP** (or clone the repository).
2. Unzip it anywhere.
3. Double-click `index.html`. It opens in your default browser and starts on the title screen.

It works in current versions of Chrome, Edge, Firefox and Safari, on desktop and on phones or tablets.

## How to play

- **Collect.** Credit Mints and Energy Wells fill up over time. Click one, or press **C** to collect everything. Vaults, Energy Cells and the Command Core decide how much you can hold.
- **Build and upgrade.** Open **Build**, pick a building and place it on a green spot. Construction takes one Engineer and finishes on a timer. Upgrading the Command Core unlocks new buildings, higher levels and more land.
- **Train.** The Barracks trains troops into your Garrison. Scouts go for resources, Rangers shoot from range, Bruisers tank for the army, Lancers charge in with a triple-strength first hit, Demolishers blow open walls, Arc Mages hit groups, Gyrocopters fly over walls (only Sentry Spires, Arc Lances and Frost Pylons can hit them), Menders heal and the Colossus stomps defenses flat.
- **Heroes.** Build the War Hall to summon the Iron Marshal and the Huntress Lodge for the Storm Huntress. Heroes are never trained or used up: they join every raid, level up with their building, and after a raid rest for a while depending on how hurt they got. Tap a deployed hero's button (or press its number) once per battle for its ability: the Marshal's War Cry heals him, calls in Scouts and rallies nearby troops; the Huntress's Smoke Veil hides her from defenses and powers up her arrows.
- **Raid.** Open the **World Map**, pick a settlement and attack. Look around first, then tap outside the red zone to deploy (hold to deploy a stream). Destroy half the buildings or the Command Core to win; stars, loot and renown depend on how much you destroy. Surviving troops come home.
- **Defend.** Once your starting protection runs out, NPC settlements raid you, more often if you raided them. A warning banner appears before each raid, and you watch the fight live with your defenses doing the work. Raiders can only take a capped share of your resources, never destroy your buildings for good, and leave a shield behind. Engineering Stations repair damage automatically.

A short tutorial walks through the first steps; you can skip it and press **H** for help at any time.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Move the camera | Drag | Arrow keys or WASD |
| Zoom | Mouse wheel or pinch | `+` and `-` |
| Inspect, collect, upgrade | Click or tap a building | |
| Recenter on your base | | Space |
| Build menu | Build button | B |
| Edit mode (move buildings) | Edit button | E |
| Rotate while placing | Rotate button | R |
| Confirm or cancel placement | Check or cross button | Enter or Esc |
| Lay a line of walls | Drag while placing a wall | |
| Attack (world map), army, research, log | Buttons on the right | M, T, R, L |
| Collect all | Collect button | C |
| Settings, close windows | Gear button | Esc |
| Pick a troop in a raid | Troop cards | 1 to 9 |
| Use a hero's ability | Tap the deployed hero's card | Its number key |
| Deploy troops | Tap, or hold for a stream | Space at the cursor |
| Battle speed | Speed button | F |

## Saving

The game saves to your browser's `localStorage` every 15 seconds, after every important action, and whenever you switch tabs or close the page. Reopening `index.html` shows a **Continue** button.

- Every few saves a backup copy is kept. If the main save is ever damaged, the backup is restored automatically and the title screen tells you. If both are unreadable, a new game starts and the damaged data is kept aside under a separate key instead of being deleted.
- The save keys are `clashOfCS.save`, `clashOfCS.save.backup` and `clashOfCS.save.corrupt`.
- Saves include any battle in progress, so a reload drops you back into the same fight.

## Starting over

Use **Settings → Start a new game** (it asks twice) or **Start a new game** on the title screen. Clearing your browser's site data for local files also erases the save.

## Time while you are away

Construction, upgrades, training, research and repairs run on real timestamps, so they keep going while the tab is in the background or the browser is closed. When you come back the game catches up in one quick step and shows a report.

- Production while away is capped at 8 hours, so collectors and storages decide how much you get back.
- At most 2 NPC raids are resolved per absence and no more than 8 per day. Each one is a real simulated battle against your current base, with the same loot caps and shields as a live raid.
- New settlements get 15 minutes of protection. **Settings → NPC raids** sets how often raids come (Off, Relaxed, Normal, Intense).
- If your computer's clock jumps backwards, time is never run in reverse; running timers just take that much longer to finish.

## Offline limitations

- **Saves live in one browser.** They do not sync between browsers, devices or browser profiles, and private or incognito windows usually discard them when closed. Some browsers (Firefox, for example) tie saves to the folder's location, so moving or renaming the folder starts a fresh game there.
- **Sound starts after your first click or key press**, because browsers block audio until you interact with the page.
- **Background tabs are throttled by the browser.** The game does not simulate while hidden; it catches up when you return, using the elapsed time.
- **Changing the system clock forward** advances the game by that amount, since there is no server to check the time against.
- There is no multiplayer, leaderboard or cloud backup. Everything happens on your device.

## Look and feel

The art is original: an ink-outlined, flat-shaded isometric style lit from the upper left, so every shadow falls down and to the right. A few rules keep it consistent when you add to it:

- Colour carries meaning. Gold is Credits, violet is Energy, green is health and gains, red is danger and attacks, blue is your side, brass marks what is selected or primary. The palette, type scale and components are CSS variables at the top of `style.css`.
- Bree Serif names things (buildings, settlements, titles); Signika is used for everything else, including every number.
- Icons come from `js/icons.js`, which the HTML interface and the canvas share. No emoji.
- Combat effects only show what the simulation actually did: damage and loot numbers, projectiles, flashes and destruction effects are all driven by battle events.
- The grid only appears while placing or editing buildings (or always, if you turn that on in Settings).

## Project structure

```
index.html        page shell; loads the scripts below in order (classic scripts, no modules)
style.css         interface styles: design tokens, components, HUD, menus, battle screens, phone layout
fonts/            Signika and Bree Serif (WOFF2) with their SIL Open Font License texts
js/config.js      every balance number: costs, timers, production, combat stats, NPC tiers, raid schedule
js/util.js        math, seeded random numbers, formatting, event bus, game clock
js/base.js        building definitions, footprints, levels and placement rules
js/research.js    troop upgrades and settlement technologies
js/army.js        unlocks, housing and the training queue
js/economy.js     resources, storage, construction, upgrades, repairs, timestamp-based time advance
js/state.js       new game, versioned save/load, validation and recovery of damaged saves, event log
js/pathfinding.js A* for troops (walls cost the time it takes to break them)
js/battle.js      fixed-tick, deterministic battle simulation for raids and defenses
js/npc.js         the fifteen settlements, their layouts, loot, difficulty and world activity
js/threat.js      scheduling NPC raids on your base and applying their results
js/timesys.js     catching up after an absence, including offline raids
js/audio.js       synthesized sound effects and music
js/icons.js       the shared SVG icon set and faction crests
js/sprites.js     procedural isometric art for buildings, walls, ruins and troops
js/render.js      renderer: baked terrain and trees, camera, shadows, overlays and battle effects
js/ui.js          HUD, building inspector, menus, world map, battle HUD, reports, notifications, tooltips
js/input.js       mouse, touch and keyboard input
js/tutorial.js    the first-time tutorial
js/main.js        boot, main loop, game modes and lifecycle (tab hidden, sleep, reload)
tests/            optional logic checks for developers (plain Node, no packages)
```

To rebalance the game, edit the numbers in `js/config.js` and reload the page. Existing saves keep working because saves are validated and missing fields are filled with defaults on load.

If you change the game logic and have Node.js installed, `node tests/logic-test.js` checks placement rules, timers, production caps, every settlement layout, battle determinism, offline raids and save recovery. The game itself never needs Node.

## Credits

Signika (by Anna Giedryś) and Bree Serif (by TypeTogether) are used under the SIL Open Font License 1.1; the license texts are in `fonts/`. Everything else, art included, is drawn by the game's own code.
