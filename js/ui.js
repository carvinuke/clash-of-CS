/*
 * User interface: village HUD, building inspector, menus (build, army, research, world map, log,
 * settings), battle HUDs, reports, event cards and tooltips. Everything is plain DOM styled by
 * style.css. Buttons carry a data-act attribute and one delegated click handler runs the matching
 * ACT entry, so markup can be re-rendered freely. Countdowns update in place through data-until /
 * data-from attributes. Elements marked data-inset="t|r|b|l" tell the camera which screen edges
 * the HUD covers, so framing a base keeps it clear of them.
 */
(function (CS) {
  'use strict';
  const C = CS.CONFIG, U = CS.U, Base = CS.Base, Eco = CS.Eco, Army = CS.Army, NPC = CS.NPC, Spr = CS.Sprites;
  const $ = U.$, esc = U.esc;
  const UI = { modal: null, arg: null, tab: 'economy', worldSel: null };
  const ACT = UI.ACT = {};   // click actions by data-act name; each section adds its own
  let G = null;

  // ---------------------------------------------------------------- icons & small pieces
  const ICON = CS.Icons.ICON;
  UI.ICON = ICON;

  function ic(name, cls) { return '<i class="ic ' + (cls || '') + '">' + ICON[name] + '</i>'; }

  function resIcon(r) { return ic(r === 'credits' ? 'credits' : 'energy'); }

  // The player's banner: a blue heater shield with a brass inlay, optionally carrying an emblem.
  function banner(inner) {
    return '<svg viewBox="0 0 32 36" aria-hidden="true">' +
      '<path d="M16 1.6 2.6 5.6v10.6c0 8.2 5.6 14.6 13.4 17.8 7.8-3.2 13.4-9.6 13.4-17.8V5.6z" fill="#2f6fc8" stroke="#0e0905" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<path d="M16 1.6 2.6 5.6v10.6c0 8.2 5.6 14.6 13.4 17.8z" fill="#fff" fill-opacity=".13"/>' +
      '<path d="M16 4.9 5.5 8.1v8.1c0 6.6 4.3 11.8 10.5 14.6 6.2-2.8 10.5-8 10.5-14.6V8.1z" fill="none" stroke="#d4a556" stroke-width="1.3"/>' +
      (inner || '') + '</svg>';
  }

  function costHtml(cost, st) {
    return Eco.RES.filter(function (r) { return cost && cost[r]; }).map(function (r) {
      const short = st && st.res[r] < cost[r];
      return '<span class="cost' + (short ? ' short' : '') + '">' + resIcon(r) + U.fmt(cost[r]) + '</span>';
    }).join(' ');
  }

  function stars(n, max) {
    let s = '';
    for (let i = 0; i < (max || 3); i++) s += ic(i < n ? 'star' : 'starOff', 'st');
    return '<span class="stars">' + s + '</span>';
  }

  function thumb(type, level, team, px) {
    return '<img class="thumb" alt="" draggable="false" src="' + Spr.thumb(type, level || 1, team, px || 96) + '">';
  }

  function troopImg(type, team, px) {
    return '<img class="tthumb" alt="" draggable="false" src="' + Spr.troopIcon(type, team, px || 72) + '">';
  }

  function spellImg(type, px) {
    return '<img class="tthumb" alt="" draggable="false" src="' + Spr.spellIcon(type, px || 72) + '">';
  }

  function until(t) { return '<span data-until="' + t + '">' + U.fmtTime((t - CS.Clock.now()) / 1000) + '</span>'; }

  function bar(from, to, cls) {
    const now = CS.Clock.now();
    const f = to > from ? U.clamp((now - from) / (to - from), 0, 1) : 1;
    return '<div class="bar ' + (cls || '') + '"><div data-from="' + from + '" data-to="' + to + '" style="width:' + (f * 100).toFixed(1) + '%"></div></div>';
  }

  function staticBar(f, cls) {
    return '<div class="bar ' + (cls || '') + '"><div style="width:' + (U.clamp(f, 0, 1) * 100).toFixed(1) + '%"></div></div>';
  }

  function hpClass(f) { return 'hpbar' + (f < 0.34 ? ' low' : f < 0.67 ? ' mid' : ''); }

  function ago(t) {
    const s = (CS.Clock.now() - t) / 1000;
    if (s < 60) return 'just now';
    return U.fmtTime(s).split(' ')[0] + ' ago';
  }

  // HUD values refresh several times a second; these skip DOM writes when nothing changed.
  function setText(id, v) {
    const el = $(id);
    v = String(v);
    if (el.textContent !== v) el.textContent = v;
  }
  function setWidth(id, f) {
    const w = (U.clamp(f || 0, 0, 1) * 100).toFixed(1) + '%';
    const el = $(id);
    if (el.style.width !== w) el.style.width = w;
  }
  function setHtml(el, html) {
    if (el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }

  // ---------------------------------------------------------------- event cards & tooltips
  // One card design for every notification: an icon, one line of text and a colored edge
  // (green good, red bad, brass info). Repeats of the newest card bump it instead of stacking.
  UI.toast = function (text, kind, icon) {
    const box = $('toasts');
    if (!box) return;
    const last = box.lastElementChild;
    if (last && last.dataset.text === text && !last.classList.contains('out')) {
      last.classList.remove('bump'); void last.offsetWidth; last.classList.add('bump');
      clearTimeout(last._t); last._t = setTimeout(function () { drop(last); }, 3400);
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.dataset.text = text;
    el.innerHTML = ic(icon || (kind === 'bad' ? 'warn' : kind === 'good' ? 'check' : 'info')) + '<span>' + esc(text) + '</span>';
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstElementChild);
    el._t = setTimeout(function () { drop(el); }, 3400);
  };
  function drop(el) {
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }

  function initTooltips() {
    const tip = $('tip');
    function show(el) {
      tip.innerHTML = el.dataset.tip;
      tip.classList.remove('hidden');
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 8;
      if (y < 4) y = r.bottom + 8;
      tip.style.left = U.clamp(x, 4, window.innerWidth - tw - 4) + 'px';
      tip.style.top = U.clamp(y, 4, window.innerHeight - th - 4) + 'px';
    }
    document.addEventListener('pointerover', function (e) {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el || e.pointerType === 'touch') { tip.classList.add('hidden'); return; }
      show(el);
    });
    document.addEventListener('pointerout', function (e) {
      if (e.target.closest && e.target.closest('[data-tip]')) tip.classList.add('hidden');
    });
    // keyboard users get the same hints on focus
    document.addEventListener('focusin', function (e) {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el && el.matches(':focus-visible')) show(el); else tip.classList.add('hidden');
    });
    document.addEventListener('focusout', function () { tip.classList.add('hidden'); });
    document.addEventListener('pointerdown', function () { tip.classList.add('hidden'); });
  }

  // ---------------------------------------------------------------- top bar
  function topbarHtml() {
    return '<button class="hb-player" data-act="stats" data-tip="<b>Commander level</b> rises with experience from building, research and battles. <b>Renown</b> rises with victories and successful defenses.">' +
      '<span class="crest">' + banner() + '<b id="tbLevel">1</b></span>' +
      '<span class="hb-pinfo"><span class="hb-name">Commander</span><span class="bar xp"><span id="tbXp"></span></span></span>' +
      '<span class="hb-renown">' + ic('renown') + '<b id="tbRenown">0</b></span></button>' +
      resBox('credits') + resBox('energy') +
      '<div class="hb-stat" id="tbEngBox" data-tip="Each Engineer runs one construction or upgrade at a time. Engineering Stations bring more.">' + ic('hammer') +
      '<span class="hb-sv"><b id="tbEng">0/0</b><small>Engineers</small></span></div>' +
      '<button class="hb-stat" data-act="army" data-tip="Army housing in use, plus troops still in training. Opens Army <kbd>T</kbd>">' + ic('army') +
      '<span class="hb-sv"><b id="tbArmy">0</b><small id="tbArmyL">Army</small></span></button>' +
      '<div class="hb-stat shield hidden" id="tbShield">' + ic('shield') + '<span class="hb-sv"><b id="tbShieldT"></b><small id="tbShieldL"></small></span></div>';
  }

  function resBox(r) {
    return '<div class="hb-res ' + r + '" id="tbRes_' + r + '" data-tip="' + (r === 'credits' ? 'Credits build and upgrade most structures. Stored in Credit Vaults and the Command Core.' : 'Energy trains troops, funds troop research and builds army buildings. Stored in Energy Cells and the Command Core.') + '">' +
      '<i class="ic" id="tbIcon_' + r + '">' + ICON[r] + '</i><div class="hb-rv"><div class="hb-line"><b id="tb_' + r + '">0</b><small id="tbCap_' + r + '"></small><span class="rate" id="tbRate_' + r + '"></span></div>' +
      '<div class="bar ' + r + '"><div id="tbBar_' + r + '"></div></div></div></div>';
  }

  function updateTopbar() {
    const st = G.state, p = st.player;
    setText('tbLevel', p.level);
    setWidth('tbXp', p.xp / C.player.xpForLevel(p.level));
    setText('tbRenown', U.fmt(p.renown));
    const cap = Eco.capacity(st), prod = Eco.production(st);
    Eco.RES.forEach(function (r) {
      setText('tb_' + r, U.fmt(st.res[r]));
      setWidth('tbBar_' + r, cap[r] ? st.res[r] / cap[r] : 0);
      setText('tbCap_' + r, '/ ' + U.fmt(cap[r]));
      setText('tbRate_' + r, '+' + U.fmt(prod[r] * 60) + '/h');
      $('tbRes_' + r).classList.toggle('full', st.res[r] >= cap[r]);
    });
    const eng = Eco.engineers(st);
    setText('tbEng', eng.free + '/' + eng.total);
    $('tbEngBox').classList.toggle('alert', eng.total > 0 && eng.free === 0);
    const q = Army.queueSpace(st);
    setText('tbArmy', Army.armySpace(st) + '/' + Army.capacity(st));
    setText('tbArmyL', q ? 'Army +' + q : 'Army');
    const th = st.threat, t = CS.Clock.now();
    let label = null, value = '', tip = 'Raiders will not attack while your shield is up.';
    if (th.protectionUntil > t) { label = 'Protected'; value = U.fmtTime((th.protectionUntil - t) / 1000); tip = 'New settlements are safe from raids for a while.'; }
    else if (th.shieldUntil > t) { label = 'Shield'; value = U.fmtTime((th.shieldUntil - t) / 1000); }
    else if (C.attacks.modes[st.settings.raidMode].freq === 0) { label = 'Raids'; value = 'Off'; tip = 'NPC raids are turned off in Settings.'; }
    const shield = $('tbShield');
    shield.classList.toggle('hidden', !label);
    if (label) {
      setText('tbShieldT', value);
      setText('tbShieldL', label);
      shield.dataset.tip = tip;
    }
  }

  // Where collected resources fly to (screen pixels), or null while the bar is hidden.
  UI.resourceAnchor = function (res) {
    const el = $('tbIcon_' + res);
    const r = el && el.getBoundingClientRect();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  };

  UI.bump = function (res) {
    const el = $('tbRes_' + res);
    if (!el) return;
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  };

  // ---------------------------------------------------------------- incoming raid card
  function updateThreat() {
    const el = $('threat');
    const st = G.state, t = CS.Clock.now();
    const n = st.threat.next;
    if (!(G.mode === 'village' && n && n.announced && n.at > t - 1000)) {
      if (el.className) el.className = '';
      return;
    }
    const s = NPC.def(n.attackerId), fac = NPC.faction(s);
    const repair = Eco.repairAllCost(st) > 0;
    setHtml(el, '<span class="tc-crest">' + CS.Icons.crest(s.faction, fac.color) + '</span>' +
      '<div class="tc-main" data-tip="Upgrade or repair your defenses now. Building and moving are locked while raiders attack.">' +
      '<span class="lbl">' + (n.kind === 'retaliation' ? 'Revenge raid' : 'Raid incoming') + '</span><b>' + esc(s.name) + '</b><small>' + esc(fac.name) + ' &middot; Tier ' + s.tier + '</small></div>' +
      '<div class="tc-time"><b id="tcTime"></b><small>until attack</small></div>' +
      '<div class="tc-act"><button class="sbtn" data-act="prepare">' + ic('shield') + 'Defenses</button>' +
      (repair ? '<button class="sbtn" data-act="repairAll">' + ic('wrench') + 'Repair</button>' : '') + '</div>');
    const left = Math.max(0, (n.at - t) / 1000);
    setText('tcTime', U.clockTime(left));
    const cls = 'show' + (left < 20 ? ' soon' : '');
    if (el.className !== cls) el.className = cls;
  }

  ACT.prepare = function () { UI.tab = 'defense'; ACT.build(); };

  // ---------------------------------------------------------------- nav rail & toolbar
  function navBtn(act, icon, label, key, cls) {
    return '<button class="nav ' + (cls || '') + '" data-act="' + act + '" data-tip="' + label + ' <kbd>' + key + '</kbd>">' + ic(icon) + '<span>' + label + '</span></button>';
  }

  function sideHtml() {
    return navBtn('world', 'sword', 'Attack', 'M', 'attack') + navBtn('army', 'army', 'Army', 'T') +
      navBtn('research', 'flask', 'Research', 'R') + navBtn('log', 'scroll', 'Log', 'L') + navBtn('settings', 'gear', 'Settings', 'Esc');
  }

  function toolBtn(act, icon, label, key, extra) {
    return '<button class="tool" data-act="' + act + '" data-tip="' + label + ' <kbd>' + key + '</kbd>">' + ic(icon) + '<span>' + label + '</span>' + (extra || '') + '</button>';
  }

  function bottomHtml() {
    return toolBtn('build', 'hammer', 'Build', 'B') + toolBtn('edit', 'move', 'Edit', 'E') + toolBtn('layouts', 'home', 'Layouts', 'P') +
      toolBtn('collect', 'sack', 'Collect', 'C', '<b class="badge" id="tbReady"></b>') + '<span id="repairWrap"></span>';
  }

  // Lights the rail or toolbar button whose menu or mode is open.
  function syncNav() {
    const m = UI.modal === 'help' ? 'settings' : UI.modal;
    document.querySelectorAll('#side .nav, #bottom .tool').forEach(function (b) {
      const a = b.dataset.act;
      const on = a === m || (a === 'edit' && G && G.edit) || (a === 'build' && G && G.place && !G.place.moveId);
      if (b.classList.contains('on') !== !!on) b.classList.toggle('on', !!on);
    });
  }

  function updateBottom() {
    const st = G.state;
    const busy = G.mode !== 'village';
    const build = document.querySelector('#bottom [data-act="build"]'), edit = document.querySelector('#bottom [data-act="edit"]');
    build.disabled = edit.disabled = busy;
    setHtml(edit, ic(G.edit ? 'check' : 'move') + '<span>' + (G.edit ? 'Done' : 'Edit') + '</span>');
    setText('tbReady', st.base.buildings.filter(Eco.ready).length || '');
    const cost = Eco.repairAllCost(st);
    setHtml($('repairWrap'), cost && !busy ? '<button class="tool repair" data-act="repairAll" data-tip="Repair every damaged building now. Engineering Stations also repair for free over time.">' +
      ic('wrench') + costHtml({ credits: cost }, st) + '</button>' : '');
    syncNav();
  }

  // ---------------------------------------------------------------- building inspector
  function statRows(b) {
    const st = G.state;
    const def = C.buildings[b.type];
    const lv = Math.max(1, b.level);
    const L = Base.levelDef(b.type, lv);
    const N = b.level >= 1 && b.level < def.levels.length ? def.levels[b.level] : null;
    const rows = [];
    function row(label, cur, next, fmt) {
      fmt = fmt || U.fmt;
      rows.push('<tr><td>' + label + '</td><td>' + fmt(cur) + '</td><td class="nx">' + (next != null && next !== cur ? '&rarr; ' + fmt(next) : '') + '</td></tr>');
    }
    const hpm = Base.hpMult(st, b.type);
    row('Hit points', Math.round(L.hp * hpm), N && Math.round(N.hp * hpm));
    if (b.type === 'core' || def.storesBoth) row('Storage (each)', L.store, N && N.store);
    if (b.type === 'core') {
      row('Build area', C.grid.buildAreaByCore[lv - 1], N && C.grid.buildAreaByCore[lv], function (v) { return v + '&times;' + v; });
    }
    if (def.produces) {
      const m = CS.Research.mult(st, 'extraction');
      row('Production', L.rate * m * 60, N && N.rate * m * 60, function (v) { return U.fmt(v) + '/h'; });
      row('Holds', L.buffer, N && N.buffer);
    }
    if (def.stores) {
      const m = CS.Research.mult(st, 'compression');
      row('Capacity', L.capacity * m, N && N.capacity * m);
    }
    if (b.type === 'garrison') row('Housing', L.capacity, N && N.capacity);
    if (b.type === 'barracks') {
      rows.push('<tr><td>Trains</td><td colspan="2">' + C.buildings.barracks.levels.slice(0, lv).reduce(function (a, l) { return a.concat(l.unlock); }, []).map(function (t) { return C.troops[t].name; }).join(', ') + '</td></tr>');
      if (N) rows.push('<tr><td>Next level</td><td colspan="2" class="nx">Unlocks ' + N.unlock.map(function (t) { return C.troops[t].name; }).join(', ') + '</td></tr>');
    }
    if (b.type === 'forge') {
      row('Spell space', L.capacity, N && N.capacity);
      rows.push('<tr><td>Brews</td><td colspan="2">' + def.levels.slice(0, lv).reduce(function (a, l) { return a.concat(l.unlock); }, []).map(function (t) { return C.spells[t].name; }).join(', ') + '</td></tr>');
      if (N && N.unlock.length) rows.push('<tr><td>Next level</td><td colspan="2" class="nx">Unlocks ' + N.unlock.map(function (t) { return C.spells[t].name; }).join(', ') + '</td></tr>');
      if (b.level >= 1) rows.push('<tr><td>Spell power</td><td colspan="2">Spells grow stronger with every Forge level</td></tr>');
    }
    if (b.type === 'station') row('Repairs', L.repair, N && N.repair, function (v) { return v + ' HP/s'; });
    if (def.hero) {
      const h = def.hero, T = C.troops[h], H = C.heroes[h], i = lv - 1, n = N ? lv : -1;
      rows.push('<tr><td>Hero</td><td colspan="2">' + esc(T.name) + '</td></tr>');
      row('Hero HP', T.hp[i], N && T.hp[n]);
      row('Hero damage', T.dmg[i], N && T.dmg[n]);
      row(esc(H.ability.name), H.ability.sec[i], N && H.ability.sec[n], function (v) { return v + 's'; });
      row('Full recovery', H.recoverMin[i], N && H.recoverMin[n], function (v) { return v + ' min'; });
      const hs = Army.heroStatus(st, h, CS.Clock.now());
      rows.push('<tr><td>Status</td><td colspan="2">' + (hs.code === 'ready' ? 'Ready for battle' : hs.code === 'resting' ? 'Resting, ' + until(CS.Clock.now() + hs.left * 1000) : hs.code === 'upgrading' ? 'Away while upgrading' : 'In ruins') + '</td></tr>');
    }
    if (def.attack) {
      const A = def.attack;
      const dm = CS.Research.mult(st, 'targeting');
      if (A.kind === 'lance') row('Damage', L.dmg * dm, N && N.dmg * dm, function (v) { return Math.round(v) + '/s, up to x' + A.rampMax; });
      else if (A.kind === 'mine') row('Blast damage', L.dmg * dm, N && N.dmg * dm, function (v) { return Math.round(v); });
      else row('Damage', L.dmg * dm, N && N.dmg * dm, function (v) { return Math.round(v) + (A.period ? ' every ' + A.period + 's' : ''); });
      if (L.slow) row('Slow', L.slow * 100, N && N.slow * 100, function (v) { return Math.round(v) + '%'; });
      if (A.shots > 1) rows.push('<tr><td>Volley</td><td colspan="2">' + A.shots + ' shots' + (A.spread ? ', scattered' : '') + '</td></tr>');
      if (A.chain) rows.push('<tr><td>Chain</td><td colspan="2">Arcs to ' + A.chain + ' targets, ' + Math.round((1 - A.falloff) * 100) + '% weaker each jump</td></tr>');
      if (A.kind === 'cone') rows.push('<tr><td>Breath</td><td colspan="2">Burns every troop in a cone</td></tr>');
      if (A.targeting === 'aura') rows.push('<tr><td>Aura</td><td colspan="2">Hits every troop in range at once</td></tr>');
      rows.push('<tr><td>Range</td><td colspan="2">' + (A.minRange ? A.minRange + '&ndash;' : '') + A.range + ' tiles' + (A.splash ? ', splash ' + A.splash : '') + '</td></tr>');
      rows.push('<tr><td>Targets</td><td colspan="2">' + (A.ground ? 'Ground only' : A.air ? 'Air only' : 'Ground and air') + (A.targeting === 'toughest' ? ', toughest first' : '') + '</td></tr>');
    }
    if (b.type === 'lab') rows.push('<tr><td>Research cap</td><td colspan="2">Upgrades up to Lv ' + (lv + 1) + '</td></tr>');
    return '<table class="stats">' + rows.join('') + '</table>';
  }

  function coreUnlocks(lv) {
    const out = [];
    Object.keys(C.buildings).forEach(function (t) {
      const a = Base.maxCount(t, lv), b = Base.maxCount(t, lv + 1);
      if (b > a) out.push((a === 0 ? 'New: ' : '+' + (b - a) + ' ') + C.buildings[t].name);
    });
    return out;
  }

  function panelHtml(b) {
    const st = G.state;
    const def = C.buildings[b.type];
    const maxHp = Base.maxHp(st, b);
    const hp = Base.hp(st, b);
    const hpf = maxHp ? hp / maxHp : 0;
    const busy = G.mode !== 'village';
    let status = '';
    if (b.ruined) status = '<div class="status bad">' + ic('skull') + 'Destroyed. Engineering Stations are rebuilding it' + (Eco.repairRate(st) ? '' : ' (build a station to repair)') + '.</div>';
    else if (b.status === 'building') status = '<div class="status">' + ic('hammer') + 'Under construction: ' + until(b.timer.end) + bar(b.timer.start, b.timer.end) + '</div>';
    else if (b.status === 'upgrading') status = '<div class="status">' + ic('up') + 'Upgrading to Lv ' + b.timer.to + ': ' + until(b.timer.end) + bar(b.timer.start, b.timer.end) + '</div>';
    else if (b.dmg > 0) status = '<div class="status warn">' + ic('wrench') + 'Damaged. Repairs are under way.</div>';
    let extra = '';
    if (def.produces && b.level >= 1) {
      const L = Base.levelDef(b.type, b.level);
      extra += '<div class="stored">' + resIcon(def.produces) + '<b>' + U.fmt(b.stored) + '</b><span class="muted">/ ' + U.fmt(L.buffer) + ' ready to collect</span>' + staticBar(b.stored / L.buffer, def.produces) + '</div>';
    }
    if (b.type === 'lab' && st.research.active) {
      const ra = st.research.active;
      extra += '<div class="status">' + ic('flask') + 'Researching ' + esc(CS.Research.describe(st, ra.key).name) + ': ' + until(ra.end) + bar(ra.start, ra.end) + '</div>';
    }
    if (b.type === 'wall') {
      const batch = Eco.wallBatch(st, b.level);
      if (!b.ruined && batch.walls.length > 1 && b.level < def.levels.length) {
        extra += '<div class="wallrow">' + batch.walls.length + ' walls at Lv ' + b.level + '. <button class="sbtn" data-act="wallsUp" data-level="' + b.level + '"' + (batch.n && !busy ? '' : ' disabled') + ' data-tip="' + esc(batch.reason || 'Upgrades as many walls of this level as you can afford') + '">' + ic('up') + 'Upgrade ' + (batch.n || 0) + ' for ' + U.fmt(batch.n * batch.cost) + '</button></div>';
      }
    }
    const up = Eco.upgradeInfo(st, b);
    let upHtml = '';
    if (up.maxed) upHtml = '<div class="maxed">Maximum level</div>';
    else if (b.level >= 1) {
      upHtml = '<button class="mbtn up" data-act="upgrade"' + (up.ok && !busy ? '' : ' disabled') + '><span>Upgrade to Lv ' + up.next + '</span>' +
        '<span class="sub">' + costHtml(up.cost, st) + '<span class="time">' + ic('clock') + (up.time ? U.fmtTime(up.time) : 'Instant') + '</span></span></button>';
      if (!up.ok && up.reason && b.status === 'active') upHtml += '<div class="req">' + esc(up.reason) + '</div>';
      if (b.type === 'core' && b.status === 'active') {
        const un = coreUnlocks(b.level);
        if (un.length) upHtml += '<div class="unlocks"><b>Next level:</b> ' + un.map(esc).join(', ') + ', bigger build area.</div>';
      }
    }
    const actions = [];
    if (def.produces && b.stored >= 1) actions.push('<button class="sbtn" data-act="collectOne">' + ic('sack') + 'Collect</button>');
    const rc = Eco.repairCost(st, b);
    if (rc && !busy) actions.push('<button class="sbtn" data-act="repair" data-tip="Repair instantly">' + ic('wrench') + 'Repair ' + costHtml(rc, st) + '</button>');
    if (!busy) actions.push('<button class="sbtn" data-act="move" data-tip="Move this building <kbd>E</kbd>">' + ic('move') + 'Move</button>');
    if (b.type === 'barracks' || b.type === 'garrison') actions.push('<button class="sbtn" data-act="army">' + ic('army') + 'Train</button>');
    if (b.type === 'lab') actions.push('<button class="sbtn" data-act="research">' + ic('flask') + 'Research</button>');
    if (b.type === 'forge') actions.push('<button class="sbtn" data-act="army">' + ic('flask') + 'Brew</button>');
    if (b.timer && !busy) actions.push('<button class="sbtn danger" data-act="cancelTimer">' + ic('close') + 'Cancel</button>');
    return '<div class="ph">' + thumb(b.type, Math.max(1, b.level), null, 116) +
      '<div class="pt"><h3>' + esc(def.name) + '</h3><div class="pl"><span>Level <b>' + b.level + '</b> of ' + def.levels.length + '</span></div>' +
      '<div class="hp">' + staticBar(hpf, hpClass(hpf)) + '<small>' + U.fmt(hp) + ' / ' + U.fmt(maxHp) + ' HP</small></div></div>' +
      '<button class="x" data-act="closePanel" aria-label="Close" data-tip="Close <kbd>Esc</kbd>">' + ICON.close + '</button></div>' +
      '<div class="pbody">' + status + extra + '<p class="desc">' + esc(def.desc) + '</p>' + statRows(b) +
      '<div class="pact">' + upHtml + (actions.length ? '<div class="row">' + actions.join('') + '</div>' : '') + '</div></div>';
  }

  function updatePanel(full) {
    const el = $('panel');
    const b = G.sel && G.mode !== 'raid' ? Base.find(G.state, G.sel) : null;
    if (!b) { el.classList.add('hidden'); el.dataset.key = el.dataset.id = ''; return; }
    const key = b.id + ':' + b.level + ':' + b.status + ':' + b.ruined + ':' + Math.floor(b.stored) + ':' + Math.round(b.dmg) + ':' + Math.floor(G.state.res.credits) + ':' + Math.floor(G.state.res.energy) + ':' + G.mode + ':' + !!G.state.research.active + ':' + Eco.engineers(G.state).free;
    if (!full && el.dataset.key === key) return;
    el.dataset.key = key;
    if (el.dataset.id !== b.id) {
      // open on the half of the screen the building is not on, so it stays in view
      const r = Base.rect(b), p = CS.Render.toScreen(r.x + r.w / 2, r.y + r.h / 2);
      el.dataset.id = b.id;
      el.dataset.side = p[0] > window.innerWidth / 2 ? 'l' : 'r';
    }
    const top = el.scrollTop;
    el.innerHTML = panelHtml(b);
    el.scrollTop = top;
    el.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- placement bar
  function updatePlacebar() {
    const el = $('placebar');
    const p = G.place;
    if (!p) { el.classList.add('hidden'); return; }
    const def = C.buildings[p.type];
    const moving = p.moveId ? Base.find(G.state, p.moveId) : null;
    const cost = p.moveId ? null : Eco.buildCost(G.state, p.type);
    setHtml(el, thumb(p.type, moving ? Math.max(1, moving.level) : 1, null, 88) +
      '<div class="pb-info"><div class="pb-t"><b>' + (p.moveId ? 'Move ' : '') + esc(def.name) + '</b>' + (cost ? costHtml(cost, G.state) : '') + '</div>' +
      '<small class="' + (p.ok ? 'ok' : 'bad') + '">' + (p.ok ? (p.type === 'wall' && !p.moveId ? 'Place one, or drag to lay a line' : 'Pick a spot on the map, then confirm') : esc(p.reason || '')) + '</small></div>' +
      (def.rotatable ? '<button class="cbtn" data-act="rotate" aria-label="Rotate" data-tip="Rotate <kbd>R</kbd>">' + ICON.rotate + '</button>' : '') +
      '<button class="cbtn ok" data-act="place" aria-label="Place" data-tip="Place <kbd>Enter</kbd>"' + (p.ok ? '' : ' disabled') + '>' + ICON.check + '</button>' +
      '<button class="cbtn no" data-act="cancelPlace" aria-label="Cancel" data-tip="Cancel <kbd>Esc</kbd>">' + ICON.close + '</button>');
    el.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- camera insets
  // Records how much of each screen edge the visible HUD covers, for the camera's framing.
  function measureInsets() {
    const I = { t: 0, r: 0, b: 0, l: 0 }, W = window.innerWidth, H = window.innerHeight;
    document.querySelectorAll('[data-inset]').forEach(function (el) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;   // hidden
      const s = el.dataset.inset;
      if (s === 't') I.t = Math.max(I.t, r.bottom);
      else if (s === 'b') I.b = Math.max(I.b, H - r.top);
      else if (s === 'r') I.r = Math.max(I.r, W - r.left);
      else if (s === 'l') I.l = Math.max(I.l, r.right);
    });
    Object.assign(CS.Render.insets, I);
  }
  UI.measureInsets = measureInsets;

  // ---------------------------------------------------------------- modals
  // One window at a time. Menus open in the space the village HUD leaves free (style.css
  // section 5), keep keyboard focus while open and hand it back when they close.
  const MODALS = {};
  let opener = null;   // what had focus before the window opened

  UI.open = function (name, arg) {
    if (G.paused && name !== 'confirm') return;
    if (!UI.modal) opener = document.activeElement;
    UI.modal = name;
    UI.arg = arg;
    const m = $('modal'), box = m.firstElementChild;
    m.className = 'm-' + name;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'mTitle');
    box.tabIndex = -1;
    renderModal();
    m.scrollTop = 0;
    box.focus({ preventScroll: true });
    CS.Audio.play('open');
    syncNav();
    CS.Bus.emit('ui:open', { name: name });
  };

  UI.close = function () {
    if (!UI.modal) return;
    const m = $('modal');
    const was = UI.modal, back = opener;
    UI.modal = null;
    opener = null;
    m.className = 'hidden';
    m.firstElementChild.innerHTML = '';
    if (UI.onClose) { const f = UI.onClose; UI.onClose = null; f(); }
    if (!UI.modal && back && back.isConnected) back.focus({ preventScroll: true });
    syncNav();
    CS.Bus.emit('ui:close', { name: was });
  };

  UI.closeAll = function () {
    UI.onClose = null;
    UI.close();
    if (G) G.sel = null;
    $('panel').classList.add('hidden');
  };

  function renderModal() {
    if (!UI.modal) return;
    const box = $('modal').firstElementChild;
    const scroll = box.querySelector('.mbody');
    const top = scroll ? scroll.scrollTop : 0;
    const a = document.activeElement;
    const again = a !== box && box.contains(a) ? sameControl(a) : null;
    box.innerHTML = MODALS[UI.modal](UI.arg);
    const nb = box.querySelector('.mbody');
    if (nb) nb.scrollTop = top;
    if (UI.modal === 'world') mountMap();
    if (again !== null) {
      const el = again && box.querySelector(again);
      (el && !el.disabled ? el : box).focus({ preventScroll: true });
    }
  }

  // The same control in the redrawn window, so keyboard focus survives the refreshes that game
  // events trigger.
  function sameControl(el) {
    if (!el.dataset.act && !el.dataset.range) return '';
    let s = el.tagName;
    Object.keys(el.dataset).forEach(function (k) {
      if (k !== 'tip') s += '[data-' + k.replace(/[A-Z]/g, '-$&').toLowerCase() + '="' + CSS.escape(el.dataset[k]) + '"]';
    });
    return s;
  }

  // Tab and Shift+Tab cycle through the open window instead of the HUD behind it.
  document.addEventListener('keydown', function (e) {
    if (!UI.modal) return;
    const box = $('modal').firstElementChild, a = document.activeElement;
    // Enter on a focused button presses that button; otherwise the game's Enter shortcut (which
    // answers Yes in a confirmation) would also fire on Cancel.
    if (e.key === 'Enter' && a.tagName === 'BUTTON' && box.contains(a)) { e.stopPropagation(); return; }
    if (e.key !== 'Tab') return;
    const list = Array.prototype.filter.call(box.querySelectorAll('button, input'), function (el) { return !el.disabled && el.offsetParent; });
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    const out = a === box || !box.contains(a);
    if (e.shiftKey ? out || a === first : out || a === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  });

  function head(title, icon, noClose, aside) {
    return '<div class="mh">' + (icon ? ic(icon) : '') + '<h2 id="mTitle">' + title + '</h2>' + (aside || '') +
      (noClose ? '' : '<button class="x" data-act="close" aria-label="Close" data-tip="Close <kbd>Esc</kbd>">' + ICON.close + '</button>') + '</div>';
  }

  // A readout in a window's title bar, such as the free Engineers in the Build menu.
  function hstat(icon, value, label, cls, tip) {
    return '<span class="hstat ' + (cls || '') + '"' + (tip ? ' data-tip="' + tip + '"' : '') + '>' + ic(icon) + '<b>' + value + '</b><small>' + label + '</small></span>';
  }

  // Why something cannot be done now. kind: 'lock' (and what unlocks it), 'short' of a resource, 'busy'.
  function why(text, kind, icon) {
    return '<span class="why ' + kind + '">' + ic(icon) + '<span>' + esc(text) + '</span></span>';
  }

  function notice(icon, html, cls) {
    return '<div class="notice' + (cls ? ' ' + cls : '') + '">' + ic(icon) + '<div>' + html + '</div></div>';
  }

  // ----- build menu
  function buildCard(st, type) {
    const def = C.buildings[type];
    const chk = Eco.canBuild(st, type);
    let state = 'ok', note = '';
    if (chk.locked) { state = 'locked'; note = why(chk.reason, 'lock', 'lock'); }
    else if (chk.maxed) { state = 'maxed'; note = why(chk.reason, 'lock', 'core'); }
    else if (chk.short) { state = 'short'; note = why(chk.reason, 'short', 'warn'); }
    else if (!chk.ok) { state = 'busy'; note = why(chk.reason, 'busy', 'hammer'); }
    const time = Eco.isInstant(type, 1) ? 'Instant' : U.fmtTime(def.levels[0].time);
    // unavailable cards stay clickable: the click explains why in an event card
    return '<button class="bcard ' + state + '" data-act="buildType" data-type="' + type + '"' + (chk.ok ? '' : ' aria-disabled="true"') + ' data-tip="' + esc(def.desc) + '">' +
      '<span class="bc-art">' + thumb(type, 1, null, 96) + '</span>' +
      '<span class="bc-count">' + (chk.locked ? ic('lock') : '<b>' + chk.count + '</b>/' + chk.max) + '</span>' +
      '<span class="bc-name">' + esc(def.name) + '</span>' +
      '<span class="bc-meta">' + costHtml(chk.cost, st) + '<span class="time">' + ic('clock') + time + '</span></span>' + note + '</button>';
  }

  MODALS.build = function () {
    const st = G.state;
    const eng = Eco.engineers(st);
    const tab = C.buildMenu.find(function (t) { return t.id === UI.tab; }) || C.buildMenu[0];
    const tabs = C.buildMenu.map(function (t) {
      return '<button class="tab' + (t === tab ? ' on' : '') + '" role="tab" aria-selected="' + (t === tab) + '" data-act="tab" data-tab="' + t.id + '">' + t.name + '</button>';
    }).join('');
    return head('Build', 'hammer', false, hstat('hammer', eng.free + '/' + eng.total, 'Engineers free', eng.free ? '' : 'warn',
      'Each Engineer runs one construction or upgrade at a time. Engineering Stations bring more.')) +
      '<div class="tabs" role="tablist">' + tabs + '</div>' +
      '<div class="mbody"><div class="bcards">' + tab.items.map(function (type) { return buildCard(st, type); }).join('') + '</div>' +
      '<p class="hint mfoot">Walls, mines and new Engineering Stations finish instantly and need no free Engineer.</p></div>';
  };

  // ----- army
  function troopCard(st, type) {
    const T = C.troops[type];
    const s = Army.stats(st, type);
    const unlocked = Army.isUnlocked(st, type);
    const heals = T.target === 'troop';
    const tip = esc(T.desc) + '<br>HP ' + s.hp + ' &middot; ' + (heals ? 'Heals ' + s.dmg + '/s' : 'DMG ' + s.dmg + (T.suicide ? ' (x' + T.wallMult + ' vs walls)' : '')) + ' &middot; Range ' + T.range + ' &middot; Speed ' + T.speed + (T.air ? ' &middot; Flying' : '');
    let act;
    if (!unlocked) act = why('Unlocks at Barracks Lv ' + Army.unlockLevel(type), 'lock', 'lock');
    else {
      const c1 = Army.canQueue(st, type, 1), c5 = Army.canQueue(st, type, 5);
      const btn = function (n, c) {
        return '<button class="sbtn" data-act="train" data-type="' + type + '" data-n="' + n + '" aria-label="Train ' + n + ' ' + esc(T.name) + '"' + (c.ok ? '' : ' disabled') + '>+' + n + '</button>';
      };
      act = '<span class="tk-train">' + btn(1, c1) + btn(5, c5) + '</span>' +
        (!c1.ok ? why(c1.reason, c1.short ? 'short' : 'busy', c1.short ? 'warn' : 'army') : !c5.ok ? why('+5: ' + c5.reason, c5.short ? 'short' : 'busy', c5.short ? 'warn' : 'army') : '');
    }
    return '<div class="tcard' + (unlocked ? '' : ' locked') + '" data-tip="' + tip + '">' +
      '<span class="tk-art">' + troopImg(type, null, 72) + '</span>' +
      '<div class="tk-main"><div class="tk-head"><b class="tk-name">' + esc(T.name) + '</b><span class="lv">Lv ' + Army.level(st, type) + '</span></div>' +
      '<div class="tk-meta">' + costHtml({ energy: s.cost }, unlocked ? st : null) + '<span class="space">' + ic('army') + T.space + '</span><span class="time">' + ic('clock') + U.fmtTime(Army.trainSeconds(st, type)) + '</span></div>' +
      '<div class="tk-stats"><span>HP <b>' + s.hp + '</b></span><span>' + (heals ? 'Heal' : 'DMG') + ' <b>' + s.dmg + '</b></span><span>' + (T.range < 1 ? 'Melee' : 'Range <b>' + T.range + '</b>') + '</span></div>' +
      act + '</div></div>';
  }

  // Heroes are not trained: the card says where the hero is and when it can fight next.
  function heroCard(st, h) {
    const T = C.troops[h], A = C.heroes[h].ability, home = C.buildings[C.heroes[h].building];
    const lv = Army.heroLevel(st, h), hs = Army.heroStatus(st, h, CS.Clock.now());
    const s = Army.stats(st, h, Math.max(1, lv));
    let status;
    if (hs.code === 'none') status = why('Build the ' + home.name + ' (Command Core Lv ' + Base.unlockCore(C.heroes[h].building) + ') to summon this hero', 'lock', 'lock');
    else if (hs.code === 'ruined') status = why('The ' + home.name + ' is in ruins. Repair it first.', 'busy', 'wrench');
    else if (hs.code === 'upgrading') status = why('Away while the ' + home.name + ' is upgrading', 'busy', 'hammer');
    else if (hs.code === 'resting') status = '<span class="tk-meta"><span class="time">' + ic('clock') + 'Resting, ready in&nbsp;<b>' + until(CS.Clock.now() + hs.left * 1000) + '</b></span></span>';
    else status = '<span class="why hero-ok">' + ic('check') + '<span>Ready. Joins every raid and guards your base.</span></span>';
    return '<div class="tcard' + (lv ? '' : ' locked') + '" data-tip="' + esc(T.desc) + '">' +
      '<span class="tk-art">' + troopImg(h, null, 72) + '</span>' +
      '<div class="tk-main"><div class="tk-head"><b class="tk-name">' + esc(T.name) + '</b>' + (lv ? '<span class="lv">Lv ' + lv + '</span>' : '') + '</div>' +
      '<div class="tk-stats"><span>HP <b>' + s.hp + '</b></span><span>DMG <b>' + s.dmg + '</b></span><span>' + (T.range < 1 ? 'Melee' : 'Range <b>' + T.range + '</b>') + '</span></div>' +
      '<div class="tk-stats"><span><b>' + esc(A.name) + ':</b> ' + esc(A.desc) + '</span></div>' +
      status + '</div></div>';
  }

  // Spells are brewed one at a time at the Spell Forge and cast anywhere during a raid.
  function spellEffect(type, lv) {
    const P = C.spells[type], i = U.clamp(lv, 1, 5) - 1;
    return type === 'heal' ? 'Heals <b>' + P.hps[i] + '</b>/s for ' + P.sec + 's'
      : type === 'rage' ? '<b>x' + P.dmgMult[i] + '</b> damage for ' + P.sec + 's'
        : type === 'freeze' ? 'Freezes for <b>' + P.sec[i] + 's</b>'
          : 'Blast <b>' + P.dmg[i] + '</b>';
  }
  function spellCard(st, type) {
    const P = C.spells[type], lv = Army.forgeLevel(st), need = Army.spellUnlockLevel(type), unlocked = lv >= need;
    let act;
    if (!lv) act = why('Build a Spell Forge (Command Core Lv ' + Base.unlockCore('forge') + ') to brew spells', 'lock', 'lock');
    else if (!unlocked) act = why('Unlocks at Spell Forge Lv ' + need, 'lock', 'lock');
    else {
      const chk = Army.canBrew(st, type);
      act = '<span class="tk-train"><button class="sbtn" data-act="brew" data-type="' + type + '" aria-label="Brew ' + esc(P.name) + '"' + (chk.ok ? '' : ' disabled') + '>+1</button></span>' +
        (chk.ok ? '' : why(chk.reason, chk.short ? 'short' : 'busy', chk.short ? 'warn' : 'flask'));
    }
    return '<div class="tcard' + (unlocked ? '' : ' locked') + '" data-tip="' + esc(P.desc) + '">' +
      '<span class="tk-art">' + spellImg(type, 72) + '</span>' +
      '<div class="tk-main"><div class="tk-head"><b class="tk-name">' + esc(P.name) + '</b>' + (lv ? '<span class="lv">Lv ' + lv + '</span>' : '') + '</div>' +
      '<div class="tk-meta">' + costHtml({ energy: Army.spellCost(st, type) }, unlocked ? st : null) + '<span class="space">' + ic('flask') + P.space + '</span><span class="time">' + ic('clock') + U.fmtTime(P.time) + '</span></div>' +
      '<div class="tk-stats"><span>' + spellEffect(type, Math.max(1, lv)) + '</span><span>Radius <b>' + P.radius + '</b></span></div>' +
      act + '</div></div>';
  }

  function spellsHtml(st) {
    const sp = st.spells, cap = Army.spellCapacity(st), f = Army.forge(st);
    const cards = '<div class="tcards">' + C.spellOrder.map(function (t) { return spellCard(st, t); }).join('') + '</div>';
    const head4 = '<div class="h4row"><h4>Spells</h4>' + (cap ? '<span class="h4side"><b>' + Army.spellSpace(st) + ' / ' + cap + '</b> Forge space</span>' : '') + '</div>';
    if (!f) return head4 + cards;
    const chips = C.spellOrder.filter(function (t) { return sp.units[t] > 0; }).map(function (t) {
      return '<span class="chipT" data-tip="' + esc(C.spells[t].name) + '">' + spellImg(t, 44) + '<b>' + sp.units[t] + '</b></span>';
    }).join('');
    let queue = '<p class="hint">Nothing brewing.</p>', total = '';
    if (sp.queue.length) {
      const now = CS.Clock.now(), on = Base.isFunctional(f);
      const need = C.spells[sp.queue[0].type].time, left = Math.max(0, need - sp.progress);
      queue = sp.queue.map(function (e, i) {
        const name = esc(C.spells[e.type].name);
        let prog = '';
        if (i === 0) prog = on ? '<span class="qnext">Next in ' + until(now + left * 1000) + '</span>' + bar(now - (need - left) * 1000, now + left * 1000, 'q') : why('The Spell Forge is not working', 'busy', 'warn');
        return '<div class="qrow">' + spellImg(e.type, 40) + '<div class="qmain"><span class="qname"><b>' + e.count + '&times;</b> ' + name + '</span>' + prog + '</div>' +
          '<button class="xs" data-act="unbrew" data-i="' + i + '" aria-label="Remove one ' + name + '" data-tip="Remove one (full refund)">' + ICON.close + '</button></div>';
      }).join('');
      total = on ? '<span class="h4side">All done in <b>' + until(now + Army.spellsRemaining(st) * 1000) + '</b></span>' : '<span class="h4side">Paused until the Spell Forge is working</span>';
    }
    return head4 + cards + '<div class="acols"><section><div class="h4row"><h4>Brewed spells</h4></div>' +
      (chips ? '<div class="chips">' + chips + '</div>' : '<p class="hint">No spells yet. Brewed spells go with you on every raid.</p>') + '</section>' +
      '<section><div class="h4row"><h4>Brewing</h4>' + total + '</div>' + queue + '</section></div>';
  }

  MODALS.army = function () {
    const st = G.state;
    const cap = Army.capacity(st), used = Army.armySpace(st), q = Army.queueSpace(st);
    const barracks = Army.activeBarracks(st);
    const w = function (v) { return (U.clamp(v / Math.max(1, cap), 0, 1) * 100).toFixed(1) + '%'; };
    const summary = '<div class="asum"><div class="asum-h">' + ic('army') + '<span class="lbl">Army housing</span>' +
      (q ? '<small>+' + q + ' in training</small>' : '') + '<b>' + used + ' / ' + cap + '</b></div>' +
      '<div class="bar army hbar"><div style="width:' + w(used) + '"></div><div class="q" style="width:' + w(Math.min(q, cap - used)) + '"></div></div>' +
      (barracks ? '<p class="hint">' + barracks + ' working Barracks' + (barracks > 1 ? ' train ' + barracks + 'x faster.' : '.') + ' Training continues while the game is closed.</p>'
        : why('You need a working Barracks to train troops.', 'busy', 'warn')) + '</div>';
    const chips = C.troopOrder.filter(function (t) { return st.army.units[t] > 0; }).map(function (t) {
      return '<span class="chipT" data-tip="' + esc(C.troops[t].name) + '">' + troopImg(t, null, 44) + '<b>' + st.army.units[t] + '</b></span>';
    }).join('');
    let queue = '<p class="hint">Nothing in training.</p>', total = '';
    if (st.army.queue.length) {
      const now = CS.Clock.now(), per = Math.max(1, barracks);
      const need = Army.trainSeconds(st, st.army.queue[0].type) / per;
      const left = Math.max(0, (Army.trainSeconds(st, st.army.queue[0].type) - st.army.progress) / per);
      queue = st.army.queue.map(function (e, i) {
        const name = esc(C.troops[e.type].name);
        let prog = '';
        if (i === 0) prog = barracks ? '<span class="qnext">Next in ' + until(now + left * 1000) + '</span>' + bar(now - (need - left) * 1000, now + left * 1000, 'q') : why('No working Barracks', 'busy', 'warn');
        return '<div class="qrow">' + troopImg(e.type, null, 40) + '<div class="qmain"><span class="qname"><b>' + e.count + '&times;</b> ' + name + '</span>' + prog + '</div>' +
          '<button class="xs" data-act="untrain" data-i="' + i + '" aria-label="Remove one ' + name + '" data-tip="Remove one (full refund)">' + ICON.close + '</button></div>';
      }).join('');
      total = barracks ? '<span class="h4side">All done in <b>' + until(now + Army.queueRemaining(st) * 1000) + '</b></span>' : '<span class="h4side">Paused until a Barracks is working</span>';
    }
    return head('Army', 'army') + '<div class="mbody">' + summary +
      '<h4>Train troops</h4><div class="tcards">' + C.troopOrder.map(function (t) { return troopCard(st, t); }).join('') + '</div>' +
      '<h4>Heroes</h4><div class="tcards">' + C.heroOrder.map(function (h) { return heroCard(st, h); }).join('') + '</div>' +
      '<div class="acols"><section><div class="h4row"><h4>Your army</h4><span class="h4side"><b>' + Army.totalUnits(st) + '</b> troops</span></div>' +
      (chips ? '<div class="chips">' + chips + '</div>' : '<p class="hint">No troops yet. Train some to raid enemy settlements.</p>') + '</section>' +
      '<section><div class="h4row"><h4>Training</h4>' + total + '</div>' + queue + '</section></div>' + spellsHtml(st) + '</div>';
  };

  // ----- research
  const TECH_ICON = { plating: 'shield', targeting: 'target', extraction: 'pick', compression: 'crate', drills: 'bolt' };

  function gain(v) { return v == null ? '' : ' <span class="gain">&rarr; ' + v + '</span>'; }

  function researchArt(key) {
    return '<span class="r-art">' + (C.troops[key] ? troopImg(key, null, 48) : ic(TECH_ICON[key] || 'flask')) + '</span>';
  }

  function researchRow(st, d) {
    const chk = CS.Research.canStart(st, d.key);
    let effect;
    if (d.kind === 'troop') {
      const a = Army.stats(st, d.key, d.level), b = d.maxed ? null : Army.stats(st, d.key, d.level + 1);
      effect = 'HP ' + a.hp + gain(b && b.hp) + ' &middot; ' + (C.troops[d.key].target === 'troop' ? 'Heal ' : 'DMG ') + a.dmg + gain(b && b.dmg);
    } else {
      const per = C.research.techs[d.key].per;
      effect = esc(d.desc) + ' +' + Math.round(d.level * per * 100) + '%' + gain(d.maxed ? null : '+' + Math.round((d.level + 1) * per * 100) + '%');
    }
    let side;
    if (d.maxed) side = '<span class="rmax">' + ic('star') + 'Max level</span>';
    else {
      const cost = {}; cost[d.res] = d.cost;
      side = '<span class="rcost">' + costHtml(cost, st) + '<span class="time">' + ic('clock') + U.fmtTime(d.time) + '</span></span>' +
        '<button class="sbtn" data-act="doResearch" data-key="' + d.key + '"' + (chk.ok ? '' : ' disabled') + ' aria-label="Research ' + esc(d.name) + ' level ' + (d.level + 1) + '" data-tip="' + esc(chk.ok ? 'Start research' : chk.reason) + '">' + ic('up') + 'Lv ' + (d.level + 1) + '</button>';
    }
    const note = d.locked ? why(d.locked, 'lock', 'lock') : chk.short ? why(chk.reason, 'short', 'warn') : '';
    return '<div class="rrow' + (d.locked ? ' locked' : '') + (d.maxed ? ' done' : '') + '">' + researchArt(d.key) +
      '<div class="r-main"><div class="r-head"><b class="r-name">' + esc(d.name) + '</b><span class="lv">Lv ' + d.level + '/' + d.max + '</span></div>' +
      '<span class="r-eff">' + effect + '</span>' + note + '</div><div class="r-side">' + side + '</div></div>';
  }

  MODALS.research = function () {
    const st = G.state;
    const lab = CS.Research.lab(st);
    const ra = st.research.active;
    let top;
    if (ra) {
      const d = CS.Research.describe(st, ra.key);
      top = '<div class="ractive">' + researchArt(ra.key) + '<div class="ra-main"><span class="lbl">Researching</span>' +
        '<span class="r-head"><b class="r-name">' + esc(d.name) + '</b><span class="lv">Lv ' + (d.level + 1) + '</span></span>' + bar(ra.start, ra.end, 'q') + '</div>' +
        '<div class="ra-side"><span class="time">' + ic('clock') + until(ra.end) + '</span>' +
        '<button class="sbtn danger" data-act="cancelResearch" data-tip="Stop and get half of the cost back">' + ic('close') + 'Cancel</button></div></div>';
    } else if (!lab) top = notice('info', 'Build a Research Lab to unlock research' + (Base.unlockCore('lab') > Base.coreLevel(st) ? ' (available at Command Core Lv ' + Base.unlockCore('lab') + ')' : ' from the Build menu') + '.');
    else if (!Base.isFunctional(lab)) top = notice('warn', (lab.ruined ? 'The Research Lab is in ruins.' : 'The Research Lab is being upgraded.') + ' New research can start once it is working again.', 'warn');
    else top = '<div class="ractive idle">' + ic('flask') + '<span>The lab is free. Pick an upgrade below.</span></div>';
    const list = CS.Research.list(st);
    const rows = function (kind) { return list.filter(function (d) { return d.kind === kind; }).map(function (d) { return researchRow(st, d); }).join(''); };
    return head('Research Lab', 'flask', false, lab ? hstat('flask', 'Lv ' + lab.level, 'Research Lab', '', 'A higher lab level unlocks higher research levels.') : '') +
      '<div class="mbody">' + top + '<h4>Troop training</h4>' + rows('troop') + '<h4>Settlement technology</h4>' + rows('tech') + '</div>';
  };

  // ----- world map
  // The map is painted in code once per shape and per revealed tier, then reused: the ground
  // palettes of the battlefields, ink borders between territories, landmarks, roads, and
  // hatched fog over the tiers the player has not reached yet.
  const HOME_POS = [0.5, 0.93];
  const MAP_INK = '#2b1e12';
  const maps = {};

  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; }

  // Smooth value noise on a wrapping n x n lattice.
  function valueNoise(seed, n) {
    const rng = new U.Rng(seed), v = new Float32Array(n * n);
    for (let i = 0; i < v.length; i++) v[i] = rng.next();
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      let fx = x - xi, fy = y - yi;
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const x0 = (xi % n + n) % n, y0 = (yi % n + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
      const a = v[y0 * n + x0], b = v[y0 * n + x1], c = v[y1 * n + x0], d = v[y1 * n + x1];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
  }

  // Roads: each settlement links to the nearest one of the tier before it (tier 1 to home).
  function mapRoads(aspect, maxTier) {
    return C.settlements.map(function (s) {
      const prev = s.tier === 1 ? [{ pos: HOME_POS }] : C.settlements.filter(function (o) { return o.tier === s.tier - 1; });
      let from = prev[0], best = Infinity;
      prev.forEach(function (o) { const d = U.dist(o.pos[0], o.pos[1], s.pos[0], s.pos[1]); if (d < best) { best = d; from = o; } });
      const ax = from.pos[0] * aspect, ay = from.pos[1], bx = s.pos[0] * aspect, by = s.pos[1];
      const bend = U.hash(s.id) & 1 ? 0.14 : -0.14;
      const cx = (ax + bx) / 2 - (by - ay) * bend, cy = (ay + by) / 2 + (bx - ax) * bend;
      const pts = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16, k = 1 - t;
        pts.push([k * k * ax + 2 * k * t * cx + t * t * bx, k * k * ay + 2 * k * t * cy + t * t * by]);
      }
      return { ax: ax, ay: ay, cx: cx, cy: cy, bx: bx, by: by, pts: pts, fog: s.tier > maxTier };
    });
  }

  function drawMap(aspect, maxTier) {
    const H = 760, W = Math.round(H * aspect);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const BIO = CS.Render.BIOMES;
    // one territory per settlement plus the player's home; coordinates in map heights
    const sites = C.settlements.concat(C.bosses).map(function (s) { return { x: s.pos[0] * aspect, y: s.pos[1], biome: C.factions[s.faction].biome, fog: s.tier > maxTier }; });
    sites.push({ x: HOME_POS[0] * aspect, y: HOME_POS[1], biome: 'home', fog: false });
    const n = sites.length;
    const sx = new Float64Array(n), sy = new Float64Array(n), span = new Float64Array(n * n);
    sites.forEach(function (p, i) { sx[i] = p.x; sy[i] = p.y; });
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) span[i * n + j] = 2 * Math.hypot(sx[i] - sx[j], sy[i] - sy[j]);
    const pal = sites.map(function (p) { const b = BIO[p.biome]; return [hexRgb(b.wild), hexRgb(b.lush), hexRgb(b.dry), hexRgb(b.bg)]; });
    const nz = valueNoise(7, 64);
    const WARP = 0.05;
    function nearest(u, v) {
      const wu = u + (nz(u * 7, v * 7) - 0.5) * WARP, wv = v + (nz(u * 7 + 23, v * 7 + 41) - 0.5) * WARP;
      let d1 = 1e9, a = 0;
      for (let k = 0; k < n; k++) { const dx = sx[k] - wu, dy = sy[k] - wv, dd = dx * dx + dy * dy; if (dd < d1) { d1 = dd; a = k; } }
      return a;
    }

    // ---- ground, territory borders and fog, pixel by pixel
    const img = g.createImageData(W, H), px = img.data;
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / H;
        const wu = u + (nz(u * 7, v * 7) - 0.5) * WARP, wv = v + (nz(u * 7 + 23, v * 7 + 41) - 0.5) * WARP;
        let d1 = 1e9, d2 = 1e9, a = 0, b = 0;
        for (let k = 0; k < n; k++) {
          const dx = sx[k] - wu, dy = sy[k] - wv, dd = dx * dx + dy * dy;
          if (dd < d1) { d2 = d1; b = a; d1 = dd; a = k; } else if (dd < d2) { d2 = dd; b = k; }
        }
        const e = (d2 - d1) / span[a * n + b];   // distance to the border with the next territory
        const P = pal[a], other = sites[a].biome !== sites[b].biome;
        // large lush and dry patches, as on the battlefields
        const m = nz(u * 3 + 11, v * 3 + 5);
        const to = m < 0.42 ? P[1] : P[2];
        let t = m < 0.42 ? Math.min(1, (0.42 - m) * 3.2) : m > 0.6 ? Math.min(1, (m - 0.6) * 3.2) : 0;
        t *= 0.8;
        let r = P[0][0] + (to[0] - P[0][0]) * t, gr = P[0][1] + (to[1] - P[0][1]) * t, bl = P[0][2] + (to[2] - P[0][2]) * t;
        // painterly mottling and a little paper grain
        const f = (nz(u * 40 + 3, v * 40 + 7) - 0.5) * 14 + ((x * 7919 ^ y * 104729) & 7) - 3.5;
        r += f; gr += f; bl += f;
        // a darker wash along the border, then the ink line itself (dotted inside one biome)
        const band = other ? 0.03 : 0.016;
        if (e < band) {
          t = 1 - e / band; t = t * t * (other ? 0.42 : 0.22);
          r += (P[3][0] - r) * t; gr += (P[3][1] - gr) * t; bl += (P[3][2] - bl) * t;
        }
        t = ((other ? 0.0021 : 0.0013) - e) * H + 0.5;
        if (t > 0 && (other || (x + y) >> 2 & 1)) {
          t = Math.min(1, t) * (other ? 0.82 : 0.5);
          r += (43 - r) * t; gr += (30 - gr) * t; bl += (18 - bl) * t;
        }
        // unexplored tiers: faded toward parchment and hatched
        if (sites[a].fog) {
          const l = r * 0.3 + gr * 0.55 + bl * 0.15;
          r = l * 0.5 + 84; gr = l * 0.5 + 76; bl = l * 0.5 + 60;
          if (((x - y) % 10 + 10) % 10 < 1.5) { r *= 0.84; gr *= 0.84; bl *= 0.84; }
        }
        // the sheet darkens slightly toward its edges
        const ed = Math.min(u, aspect - u, v, 1 - v);
        if (ed < 0.05) { t = 1 - ed / 0.05; t = t * t * 0.38; r -= r * t; gr -= gr * t; bl -= bl * t; }
        const i = (y * W + x) * 4;
        px[i] = r; px[i + 1] = gr; px[i + 2] = bl; px[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // ---- landmarks: ink-outlined like the rest of the art, lit from the upper left
    g.lineJoin = 'round'; g.lineCap = 'round';
    function ink(w) { g.strokeStyle = MAP_INK; g.lineWidth = w || 1.6; g.stroke(); }
    function tri(x0, y0, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); }
    function dot(x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }
    function tree(x, y, s, col) {
      g.fillStyle = '#6b4a2f'; g.fillRect(x - 1.2 * s, y - 5 * s, 2.4 * s, 5 * s);
      dot(x, y - 8.5 * s, 5.8 * s); g.fillStyle = col; g.fill(); ink();
      dot(x - 2.2 * s, y - 10.6 * s, 2 * s); g.fillStyle = Spr.shade(col, 0.22); g.fill();
    }
    function pine(x, y, s, col, snow) {
      g.fillStyle = '#6b4a2f'; g.fillRect(x - s, y - 3 * s, 2 * s, 3 * s);
      tri(x - 6.5 * s, y - 2.5 * s, x, y - 18 * s, x + 6.5 * s, y - 2.5 * s); g.fillStyle = col; g.fill(); ink();
      if (snow) { tri(x - 2.8 * s, y - 11.5 * s, x, y - 18 * s, x + 2.8 * s, y - 11.5 * s); g.fillStyle = '#f3f7fa'; g.fill(); }
    }
    function peak(x, y, s, body, cap) {
      const w = 13 * s, h = 19 * s;
      tri(x - w, y, x, y - h, x + w, y); g.fillStyle = body; g.fill();
      tri(x, y - h, x + w, y, x + 2 * s, y); g.fillStyle = Spr.shade(body, -0.24); g.fill();
      if (cap) {
        g.beginPath(); g.moveTo(x - w * 0.4, y - h * 0.6); g.lineTo(x, y - h); g.lineTo(x + w * 0.4, y - h * 0.6);
        g.lineTo(x + w * 0.14, y - h * 0.52); g.lineTo(x - w * 0.08, y - h * 0.64); g.closePath(); g.fillStyle = cap; g.fill();
      }
      g.beginPath(); g.moveTo(x - w, y); g.lineTo(x, y - h); g.lineTo(x + w, y); ink();
    }
    function volcano(x, y, s) {
      const w = 24 * s, h = 27 * s, top = 5 * s;
      g.beginPath(); g.moveTo(x - w, y); g.lineTo(x - top, y - h); g.lineTo(x + top, y - h); g.lineTo(x + w, y); g.closePath(); g.fillStyle = '#5a4d47'; g.fill();
      tri(x + top, y - h, x + w, y, x + 3 * s, y); g.fillStyle = '#3d3431'; g.fill();
      g.beginPath(); g.moveTo(x - 1.5 * s, y - h); g.lineTo(x - 4 * s, y - h * 0.62); g.lineTo(x - 1 * s, y - h * 0.46); g.lineTo(x - 6 * s, y - h * 0.12);
      g.strokeStyle = '#ff7a2e'; g.lineWidth = 2.4 * s; g.stroke();
      g.beginPath(); g.ellipse(x, y - h, top, 1.8 * s, 0, 0, Math.PI * 2); g.fillStyle = '#ffa04a'; g.fill(); ink(1.3);
      g.beginPath(); g.moveTo(x - w, y); g.lineTo(x - top, y - h); g.moveTo(x + top, y - h); g.lineTo(x + w, y); ink();
    }
    function dune(x, y, s) {
      g.beginPath(); g.moveTo(x - 12 * s, y); g.quadraticCurveTo(x - 3 * s, y - 9 * s, x + 12 * s, y); g.quadraticCurveTo(x, y - 3 * s, x - 12 * s, y);
      g.fillStyle = 'rgba(255, 243, 214, 0.4)'; g.fill();
      g.beginPath(); g.moveTo(x - 12 * s, y); g.quadraticCurveTo(x - 3 * s, y - 9 * s, x + 12 * s, y); ink(1.3);
    }
    function cactus(x, y, s) {
      const path = function () {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 12 * s);
        g.moveTo(x, y - 6 * s); g.lineTo(x - 4 * s, y - 6 * s); g.lineTo(x - 4 * s, y - 9.5 * s);
        g.moveTo(x, y - 4 * s); g.lineTo(x + 4 * s, y - 4 * s); g.lineTo(x + 4 * s, y - 8 * s);
      };
      path(); g.strokeStyle = MAP_INK; g.lineWidth = 5.2 * s; g.stroke();
      path(); g.strokeStyle = '#79a64f'; g.lineWidth = 2.8 * s; g.stroke();
    }
    function rock(x, y, s, col) {
      g.beginPath(); g.moveTo(x - 6 * s, y); g.lineTo(x - 4 * s, y - 4.5 * s); g.lineTo(x + 1 * s, y - 6 * s); g.lineTo(x + 5.5 * s, y - 2.5 * s); g.lineTo(x + 5 * s, y); g.closePath();
      g.fillStyle = col; g.fill(); ink(1.3);
    }
    function reeds(x, y, s) {
      g.beginPath();
      for (let i = -1; i <= 1; i++) { g.moveTo(x + i * 2.6 * s, y); g.lineTo(x + i * 4 * s, y - (i ? 8 : 11) * s); }
      g.strokeStyle = '#334a20'; g.lineWidth = 1.7 * s; g.stroke();
    }
    function pond(x, y, s) {
      g.beginPath(); g.ellipse(x, y, 13 * s, 5.5 * s, 0, 0, Math.PI * 2); g.fillStyle = '#5d8c84'; g.fill(); ink(1.4);
      g.beginPath(); g.moveTo(x - 7 * s, y - 1.6 * s); g.lineTo(x - 1.5 * s, y - 1.6 * s); g.strokeStyle = 'rgba(255, 255, 255, 0.5)'; g.lineWidth = 1.4; g.stroke();
    }
    function snag(x, y, s) {
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 12 * s); g.moveTo(x, y - 6 * s); g.lineTo(x - 4.5 * s, y - 10.5 * s); g.moveTo(x, y - 8.5 * s); g.lineTo(x + 4 * s, y - 12.5 * s);
      g.strokeStyle = '#2a211d'; g.lineWidth = 2.2 * s; g.stroke();
    }
    function lava(x, y, s) {
      g.beginPath(); g.moveTo(x - 8 * s, y); g.lineTo(x - 3 * s, y - 2 * s); g.lineTo(x + 1 * s, y + 1 * s); g.lineTo(x + 7 * s, y - 1.5 * s);
      g.strokeStyle = MAP_INK; g.lineWidth = 3.6 * s; g.stroke(); g.strokeStyle = '#ff8a3d'; g.lineWidth = 1.8 * s; g.stroke();
    }
    const GLYPH = {
      home: function (x, y, r, s) { if (r < 0.5) tree(x, y, s, r < 0.25 ? '#4e9a3c' : '#559f3f'); else if (r < 0.62) pine(x, y, s, '#2f7a45'); },
      meadow: function (x, y, r, s) { if (r < 0.5) tree(x, y, s, r < 0.25 ? '#4e9a3c' : '#4a9440'); else if (r < 0.66) pine(x, y, s, '#2f7a45'); else if (r < 0.72) rock(x, y, s, '#a29a8c'); },
      swamp: function (x, y, r, s) { if (r < 0.3) tree(x, y, s, '#5d7f39'); else if (r < 0.55) reeds(x, y, s); else if (r < 0.64) pond(x, y, s); },
      desert: function (x, y, r, s) { if (r < 0.4) dune(x, y, s); else if (r < 0.52) cactus(x, y, s); else if (r < 0.6) rock(x, y, s, '#b8a07e'); },
      snow: function (x, y, r, s) { if (r < 0.5) peak(x, y, s * 1.25, '#9aa6b2', '#f3f7fa'); else if (r < 0.72) pine(x, y, s, '#2f6e4a', true); },
      volcanic: function (x, y, r, s) { if (r < 0.45) peak(x, y, s * 1.15, '#5e524c', null); else if (r < 0.6) snag(x, y, s); else if (r < 0.7) lava(x, y, s); }
    };
    const roads = mapRoads(aspect, maxTier);
    // keep landmarks off the settlements, their name plates and the roads
    function clear(u, v) {
      for (let k = 0; k < n; k++) {
        const dx = u - sx[k], dy = v - sy[k];
        if (dx * dx + dy * dy < 0.0049 || (dy > 0 && dy < 0.11 && Math.abs(dx) < 0.14)) return false;
      }
      return roads.every(function (rd) { return rd.pts.every(function (p) { return Math.abs(p[0] - u) > 0.03 || Math.abs(p[1] - v) > 0.03; }); });
    }
    const rng = new U.Rng(4242), step = 30, marks = [];
    for (let gy = step * 0.6; gy < H; gy += step) {
      for (let gx = step * 0.5; gx < W; gx += step) {
        const x = gx + (rng.next() - 0.5) * step * 0.9, y = gy + (rng.next() - 0.5) * step * 0.9, r = rng.next(), s = 0.85 + rng.next() * 0.35;
        const u = x / H, v = y / H;
        if (Math.min(u, aspect - u, v, 1 - v) < 0.04 || !clear(u, v)) continue;
        const k = nearest(u, v);
        marks.push({ x: x, y: y, r: r, s: s, biome: sites[k].biome, fog: sites[k].fog });
      }
    }
    // one volcano where the Cinder Legion lives
    const vu = 0.77 * aspect, vv = 0.18;
    if (sites[nearest(vu, vv)].biome === 'volcanic') marks.push({ x: vu * H, y: vv * H, volcano: true, fog: sites[nearest(vu, vv)].fog });
    marks.sort(function (p, q) { return p.y - q.y; });
    marks.forEach(function (p) {
      g.globalAlpha = p.fog ? 0.45 : 1;
      if (p.volcano) volcano(p.x, p.y, 1.1); else GLYPH[p.biome](p.x, p.y, p.r, p.s);
    });
    g.globalAlpha = 1;

    // ---- roads: worn ground under a dashed ink track; roads into fog are faint
    roads.forEach(function (rd) {
      g.beginPath(); g.moveTo(rd.ax * H, rd.ay * H); g.quadraticCurveTo(rd.cx * H, rd.cy * H, rd.bx * H, rd.by * H);
      g.setLineDash([]); g.lineWidth = 6; g.strokeStyle = rd.fog ? 'rgba(240, 226, 190, 0.18)' : 'rgba(244, 228, 186, 0.42)'; g.stroke();
      g.setLineDash([7, 6]); g.lineWidth = 2.2; g.strokeStyle = rd.fog ? 'rgba(43, 30, 18, 0.35)' : 'rgba(43, 30, 18, 0.8)'; g.stroke();
    });
    g.setLineDash([]);

    // ---- compass rose in the free lower-left corner
    const cx = 0.07 * aspect * H, cy = 0.87 * H, R = 0.045 * H;
    g.save(); g.translate(cx, cy);
    for (let i = 0; i < 4; i++) {
      g.rotate(i ? Math.PI / 2 : 0);
      tri(0, -R, R * 0.22, 0, -R * 0.22, 0); g.fillStyle = i % 2 ? '#efe2c4' : '#d4a556'; g.fill(); ink(1.3);
      tri(0, -R, R * 0.22, 0, 0, 0); g.fillStyle = 'rgba(43, 30, 18, 0.28)'; g.fill();
    }
    g.restore();
    dot(cx, cy, R * 0.16); g.fillStyle = '#efe2c4'; g.fill(); ink(1.2);
    g.fillStyle = MAP_INK; g.font = '400 ' + Math.round(R * 0.62) + 'px "Bree Serif", Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText('N', cx, cy - R - 4);
    return cv;
  }

  function mountMap() {
    const host = document.querySelector('.wmap .wbg');
    if (!host) return;
    const r = host.getBoundingClientRect();
    const aspect = r.height ? Math.round(r.width / r.height * 4) / 4 : 1.5;   // the map's shape, to a quarter
    const tier = NPC.unlockedTier(G.state);
    const key = aspect + ':' + tier;
    if (!maps[key]) maps[key] = drawMap(aspect, tier);
    host.appendChild(maps[key]);
    // labels of settlements near the edge slide inward instead of being cut off
    const box = host.parentNode.getBoundingClientRect();
    host.parentNode.querySelectorAll('.nl').forEach(function (nl) {
      const b = nl.getBoundingClientRect();
      if (!b.width) return;
      const dx = Math.max(0, box.left + 4 - b.left) - Math.max(0, b.right + 4 - box.right);
      if (dx) nl.style.transform = 'translateX(' + Math.round(dx) + 'px)';
    });
  }

  function kv(label, html, cls) {
    return '<div class="kv' + (cls ? ' ' + cls : '') + '"><span class="lbl">' + label + '</span><div class="kv-v">' + html + '</div></div>';
  }

  function pips(n) {
    let s = '';
    for (let i = 0; i < 3; i++) s += '<i' + (i < n ? ' class="on"' : '') + '></i>';
    return '<span class="pips" aria-label="' + n + ' of 3">' + s + '</span>';
  }

  MODALS.world = function () {
    const st = G.state, t = CS.Clock.now();
    const maxTier = NPC.unlockedTier(st);
    if (!UI.worldSel) {
      const open = C.settlements.filter(function (s) { return NPC.isUnlocked(st, s); });
      const fresh = open.find(function (s) { return !NPC.rec(st, s.id).wins; });
      UI.worldSel = (fresh || open[0]).id;
    }
    let nodes = C.settlements.map(function (s) {
      const rec = NPC.rec(st, s.id), fac = NPC.faction(s);
      const open = s.tier <= maxTier;
      const reb = open && rec.rebuildUntil > t;
      const sel = UI.worldSel === s.id;
      return '<button class="node' + (open ? '' : ' locked') + (reb ? ' reb' : '') + (sel ? ' sel' : '') + '" style="left:' + (s.pos[0] * 100) + '%;top:' + (s.pos[1] * 100) + '%" data-act="node" data-id="' + s.id + '"' +
        ' aria-pressed="' + sel + '" aria-label="' + esc(s.name) + ', tier ' + s.tier + (open ? '' : ', locked') + (reb ? ', rebuilding' : '') + (rec.stars ? ', ' + rec.stars + ' of 3 stars' : '') + '">' +
        '<span class="pin">' + CS.Icons.crest(s.faction, fac.color) + '<b class="tno">' + s.tier + '</b>' + (open ? (reb ? '<i class="nb">' + ICON.hammer + '</i>' : '') : '<i class="nb">' + ICON.lock + '</i>') + '</span>' +
        '<span class="nl">' + esc(s.name) + (rec.stars ? stars(rec.stars) : '') + (reb ? '<small>' + until(rec.rebuildUntil) + '</small>' : '') + '</span></button>';
    }).join('');
    // boss strongholds: optional, each with a one-time reward
    nodes += C.bosses.map(function (s) {
      const rec = NPC.rec(st, s.id), fac = NPC.faction(s);
      const open = s.tier <= maxTier, reb = open && rec.rebuildUntil > t, sel = UI.worldSel === s.id;
      return '<button class="node boss' + (open ? '' : ' locked') + (reb ? ' reb' : '') + (sel ? ' sel' : '') + (rec.claimed ? ' claimed' : '') + '" style="left:' + (s.pos[0] * 100) + '%;top:' + (s.pos[1] * 100) + '%" data-act="node" data-id="' + s.id + '"' +
        ' aria-pressed="' + sel + '" aria-label="' + esc(s.name) + ', boss stronghold, tier ' + s.tier + (open ? '' : ', locked') + (rec.claimed ? ', reward claimed' : '') + '">' +
        '<span class="pin">' + CS.Icons.crest(s.faction, fac.color) + '<i class="nb boss-b">' + (open ? ICON.skull : ICON.lock) + '</i></span>' +
        '<span class="nl">' + esc(s.name) + (rec.stars ? stars(rec.stars) : '') + (reb ? '<small>' + until(rec.rebuildUntil) + '</small>' : '') + '</span></button>';
    }).join('');
    const home = '<div class="node home" style="left:' + HOME_POS[0] * 100 + '%;top:' + HOME_POS[1] * 100 + '%"><span class="pin">' +
      banner(ICON.home.replace('<svg ', '<svg x="8" y="8.4" width="16" height="16" color="#f5ead2" ')) + '</span><span class="nl">Your base</span></div>';
    const wins = NPC.winsInTier(st, maxTier);
    const reveal = maxTier < C.tiers.length - 1 ? hstat('flag', wins + '/' + C.world.unlockWins, 'wins to reveal Tier ' + (maxTier + 1), '', 'Win against ' + C.world.unlockWins + ' different Tier ' + maxTier + ' settlements to reveal the next tier.') : hstat('flag', 'All', 'tiers revealed');
    return head('World Map', 'sword', false, reveal) + '<div class="mbody"><div class="world"><div class="wmap"><div class="wbg"></div>' + nodes + home + '</div>' + worldDetail(UI.worldSel) + '</div></div>';
  };

  function worldDetail(id) {
    const st = G.state, t = CS.Clock.now();
    const s = NPC.def(id), rec = NPC.rec(st, id), fac = NPC.faction(s);
    const chk = G.raidStatus(id);
    const open = NPC.isUnlocked(st, s);
    let body;
    if (!open) body = notice('lock', esc(chk.reason) + '.');
    else {
      const diff = NPC.difficulty(st, s);
      const defs = NPC.defenseSummary(st, s);
      const chips = Object.keys(defs).filter(function (type) { return !C.buildings[type].boss; }).map(function (type) {
        const d = defs[type];
        return '<span class="dchip" data-tip="' + esc(C.buildings[type].name) + ' &times;' + d.n + ', up to Lv ' + d.maxLv + '">' + thumb(type, d.maxLv, fac.color, 48) +
          '<span><b>&times;' + d.n + '</b><small>Lv ' + d.maxLv + '</small></span></span>';
      }).join('');
      const boss = s.defense ? C.buildings[s.defense] : null;
      body = (boss ? kv('Boss', '<span class="dchip boss" data-tip="' + esc(boss.desc) + '">' + thumb(s.defense, Math.min(boss.levels.length, 1 + rec.fortify), fac.color, 48) + '<span><b>' + esc(boss.name) + '</b><small>' + esc(boss.desc) + '</small></span></span>') +
        kv('Reward', rec.claimed ? '<small>' + ic('check') + 'Claimed. You can still raid it for loot.</small>' : costHtml({ credits: s.reward.credits, energy: s.reward.energy }) + '<small>+' + s.reward.renown + ' renown, +' + s.reward.xp + ' XP, once, for your first victory</small>', 'reward') : '') +
        kv('Difficulty', '<b class="diff ' + diff.cls + '">' + diff.label + '</b><small>for your current army</small>') +
        kv('Available loot', costHtml(NPC.loot(st, s, t)) + '<small>+' + U.fmt(C.tiers[s.tier].bonus) + ' of each for a 3-star win</small>') +
        kv('Defenses', chips ? '<span class="dchips">' + chips + '</span>' : '<small>None</small>') +
        kv('Record', '<span><b>' + rec.wins + '</b> won &middot; <b>' + rec.losses + '</b> lost</span>' + (rec.stars ? stars(rec.stars) : '') + (rec.fortify ? '<small>Fortified &times;' + rec.fortify + ' after your victories</small>' : '')) +
        (rec.hostility ? kv('Hostility', pips(rec.hostility) + '<small>They may raid you in revenge.</small>', 'hostile') : '') +
        (chk.rebuilding ? notice('hammer', 'Rebuilding after your raid. Opens again in ' + until(chk.rebuilding) + '.') : '');
    }
    let action;
    if (chk.ok) action = '<button class="mbtn attack" data-act="attack" data-id="' + id + '">' + ic('sword') + '<span>Attack with ' + Army.totalUnits(st) + ' troops</span></button>';
    else if (chk.noArmy && open) action = '<button class="mbtn" data-act="army">' + ic('army') + '<span>Train troops first</span></button>';
    else if (chk.rebuilding) action = '<button class="mbtn" disabled>' + ic('hammer') + '<span>Rebuilding</span></button>';
    else action = '<button class="mbtn" disabled>' + ic(open ? 'sword' : 'lock') + '<span>' + (open ? esc(chk.reason) : 'Locked') + '</span></button>';
    return '<div class="wdetail"><div class="wd-h"><span class="wd-crest">' + CS.Icons.crest(s.faction, fac.color) + '</span>' +
      '<div class="wd-t"><span class="lbl">' + (s.defense ? 'Boss stronghold &middot; ' : '') + 'Tier ' + s.tier + '</span><h3>' + esc(s.name) + '</h3><small>' + esc(fac.name) + ' &middot; led by ' + esc(s.leader) + '</small></div></div>' +
      '<div class="wd-b">' + body + '</div><div class="wd-act">' + action +
      '<p class="hint">' + (s.defense ? 'Boss strongholds never raid you and do not count toward revealing tiers.' : 'Win ' + C.world.unlockWins + ' raids in a tier to reveal the next one. Defeated settlements rebuild stronger and richer.') + '</p></div></div>';
  }

  // ----- log
  const LOG_ICON = { info: 'info', world: 'scroll', defense: 'shield', raid: 'skull', victory: 'star', defeat: 'warn' };
  MODALS.log = function () {
    const st = G.state, s = st.stats;
    const cell = function (label, value) { return '<div class="lstat"><span class="lbl">' + label + '</span><b>' + value + '</b></div>'; };
    const rows = st.log.map(function (e) {
      return '<li class="lrow ' + e.kind + '">' + ic(LOG_ICON[e.kind] || 'info') + '<span>' + esc(e.text) + '</span><small>' + ago(e.t) + '</small></li>';
    }).join('');
    return head('Event Log', 'scroll') + '<div class="mbody"><div class="lstats">' +
      cell('Raids won', s.raidsWon) + cell('Raids lost', s.raidsLost) + cell('Defenses held', s.defended) + cell('Times raided', s.raided) +
      cell('Loot taken', '<span class="cost">' + resIcon('credits') + U.fmt(s.lootCredits) + '</span><span class="cost">' + resIcon('energy') + U.fmt(s.lootEnergy) + '</span>') +
      cell('Lost to raiders', U.fmt(s.stolen)) + '</div>' +
      '<h4>Recent events</h4>' + (rows ? '<ul class="lrows">' + rows + '</ul>' : '<p class="hint">Nothing has happened yet.</p>') + '</div>';
  };

  // ----- settings
  function srow(label, sub, control, cls) {
    return '<div class="srow' + (cls ? ' ' + cls : '') + '"><div class="sl"><b>' + label + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>' + control + '</div>';
  }

  function toggle(key, label, sub) {
    const on = !!G.state.settings[key];
    return srow(label, sub, '<button class="switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="' + label + '" data-act="setting" data-key="' + key + '"><span></span></button>');
  }

  function group(title, rows) { return '<h4>' + title + '</h4><div class="sgroup">' + rows + '</div>'; }

  MODALS.settings = function () {
    const st = G.state;
    const modes = Object.keys(C.attacks.modes).map(function (k) {
      const on = st.settings.raidMode === k;
      return '<button class="seg' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" data-act="raidMode" data-v="' + k + '">' + C.attacks.modes[k].label + '</button>';
    }).join('');
    const ok = CS.State.storageAvailable();
    const status = ok ? '<span class="sstat">' + ic('check') + (st.savedAt ? 'Saved ' + ago(st.savedAt) : 'Not saved yet') + '</span>' : '<span class="sstat bad">' + ic('warn') + 'Saving is blocked</span>';
    const sub = ok ? 'Progress is saved in this browser. The game also saves automatically every ' + C.autosaveSec + ' seconds and whenever you leave the tab.'
      : 'This browser is blocking local storage, so progress cannot be saved.';
    return head('Settings', 'gear') + '<div class="mbody">' +
      group('Audio', toggle('sfx', 'Sound effects') + toggle('music', 'Music') +
        srow('Volume', '', '<input type="range" min="0" max="1" step="0.05" value="' + st.settings.volume + '" data-range="volume" aria-label="Volume">')) +
      group('Display', toggle('showGrid', 'Always show the grid', 'The grid always appears while building or editing.')) +
      group('Raids', srow('NPC raids on your base', 'How often enemy settlements attack you. Shields, a protection period and loot caps always apply.',
        '<div class="segs" role="radiogroup" aria-label="NPC raids on your base">' + modes + '</div>', 'col')) +
      group('Base layouts', srow('Ready-made layouts', 'Three proven layouts for your Command Core level. Your buildings move into place.',
        '<button class="sbtn" data-act="layouts">' + ic('home') + 'Browse</button>')) +
      group('Saving', srow(status, sub, '<button class="sbtn" data-act="saveNow">Save now</button>') +
        srow('Backup file', 'Download your whole game as a file, or restore one you downloaded earlier.',
          '<span class="sbtns"><button class="sbtn" data-act="backup">Download</button><button class="sbtn" data-act="restorePick">Restore</button></span>' +
          '<input type="file" id="restoreFile" accept=".json,application/json" hidden>') +
        '<div class="srow acts"><button class="sbtn" data-act="help">' + ic('help') + 'Controls &amp; help</button><button class="sbtn danger" data-act="resetGame">Start a new game</button></div>') +
      '<p class="hint mfoot" data-act="secret">Clash of CS runs entirely in your browser with no internet connection or accounts.</p></div>';
  };

  // ----- base layouts
  // Isometric thumbnail of a preset, drawn from its slots on the core level's build area.
  function presetSvg(core, i) {
    const area = Base.buildArea(core), n = area.size;
    const rects = CS.Presets.layout(core, i).map(function (b) {
      const cat = C.buildings[b.type].category;
      if (cat === 'trap') return '';
      const sz = Base.size(b.type, b.rot);
      return '<rect class="pv-' + cat + '" x="' + b.x + '" y="' + b.y + '" width="' + sz[0] + '" height="' + sz[1] + '"/>';
    }).join('');
    return '<svg class="pv" viewBox="' + -n + ' ' + area.x0 + ' ' + 2 * n + ' ' + n + '" aria-hidden="true"><g transform="matrix(1 0.5 -1 0.5 0 0)">' +
      '<rect class="pv-ground" x="' + area.x0 + '" y="' + area.y0 + '" width="' + n + '" height="' + n + '"/>' + rects + '</g></svg>';
  }

  MODALS.layouts = function () {
    const core = Base.coreLevel(G.state);
    const cards = CS.Presets.STYLES.map(function (p, i) {
      return '<div class="preset">' + presetSvg(core, i) + '<b>' + p.name + '</b><small>' + p.desc + '</small>' +
        '<button class="mbtn primary" data-act="usePreset" data-i="' + i + '"' + (G.mode !== 'village' ? ' disabled' : '') + '><span>Use this layout</span></button></div>';
    }).join('');
    return head('Base Layouts &middot; Core Lv ' + core, 'home') + '<div class="mbody"><p class="lead">Pick a layout and every building you own moves into place. ' +
      'Spots for buildings you have not built yet stay open, so new ones slot in later. Each Command Core level has its own three layouts.</p>' +
      '<div class="presets">' + cards + '</div>' +
      '<p class="hint pv-key"><i class="pv-core"></i>Core <i class="pv-defense"></i>Defenses <i class="pv-economy"></i>Resources <i class="pv-army"></i>Army <i class="pv-wall"></i>Walls</p></div>';
  };

  // ----- admin
  MODALS.adminCode = function () {
    return head('Restricted', 'lock') + '<div class="mbody"><p class="ctext">Enter the access code.</p>' +
      '<input id="adminCode" class="code" type="password" autocomplete="off" aria-label="Access code">' +
      '<div class="mact"><button class="mbtn ghost" data-act="close">Cancel</button><button class="mbtn primary" data-act="adminEnter">Enter</button></div></div>';
  };

  MODALS.admin = function () {
    const c = G.state.cheats;
    const sw = function (key, label, sub) {
      return srow(label, sub, '<button class="switch' + (c[key] ? ' on' : '') + '" role="switch" aria-checked="' + c[key] + '" aria-label="' + label + '" data-act="cheat" data-key="' + key + '"><span></span></button>');
    };
    const btn = function (act, icon, label) { return '<button class="sbtn" data-act="adminDo" data-v="' + act + '">' + ic(icon) + label + '</button>'; };
    return head('Admin Panel', 'core') + '<div class="mbody">' +
      group('Cheats', sw('rich', 'Infinite resources', 'Credits and Energy never run out.') +
        sw('instant', 'Instant everything', 'Construction, upgrades, training and research finish at once.') +
        sw('heroes', 'Tireless heroes', 'Heroes are ready again right after every battle.')) +
      group('One-time actions', '<div class="srow acts">' + btn('maxBase', 'up', 'Max out every building') + btn('fillArmy', 'army', 'Fill the army') +
        btn('shield', 'shield', '24 hour shield') + btn('unshield', 'close', 'Remove shield') + '</div>') +
      group('Force a raid', srow('Attacker', 'Raiders strike your base right now, even through a shield.',
        '<span class="sbtns"><select class="code pick" data-pick="raid" aria-label="Attacker"><option value="">Random</option>' +
        C.settlements.map(function (s) { return '<option value="' + s.id + '"' + (UI.raidPick === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
        '</select>' + btn('raid', 'sword', 'Attack me') + '</span>')) + '</div>';
  };

  const KEYS = [
    ['Camera', [['Move the camera', 'Drag, arrow keys or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>'], ['Zoom', 'Mouse wheel, pinch or <kbd>+</kbd><kbd>-</kbd>'],
      ['Recenter on your base', '<kbd>Space</kbd>']]],
    ['Village', [['Inspect, collect, upgrade', 'Click or tap a building'], ['Build menu', '<kbd>B</kbd>'], ['Edit mode (move buildings)', '<kbd>E</kbd>'], ['Base layouts', '<kbd>P</kbd>'],
      ['Rotate while placing, otherwise Research', '<kbd>R</kbd>'], ['Place the building', '<kbd>Enter</kbd>'], ['Army and training', '<kbd>T</kbd>'], ['World map', '<kbd>M</kbd>'],
      ['Event log', '<kbd>L</kbd>'], ['Collect all resources', '<kbd>C</kbd>'], ['Controls and help', '<kbd>H</kbd>'], ['Close or cancel, otherwise Settings', '<kbd>Esc</kbd>']]],
    ['Raids', [['Pick a troop', '<kbd>1</kbd>&ndash;<kbd>6</kbd>'], ['Deploy troops', 'Tap, or hold for a stream'], ['Deploy at the cursor', '<kbd>Space</kbd>'], ['Battle speed', '<kbd>F</kbd>']]]
  ];

  MODALS.help = function () {
    const keys = function (grp) {
      return '<h4>' + grp[0] + '</h4><table class="keys">' + grp[1].map(function (k) { return '<tr><td>' + k[0] + '</td><td>' + k[1] + '</td></tr>'; }).join('') + '</table>';
    };
    const steps = ['Generators fill up over time. Tap them to collect into your storages.',
      'Each Engineer works on one construction at a time. Build more Engineering Stations for more Engineers.',
      'Train troops at the Barracks, then raid settlements from the World Map. Destroy half the buildings or the Command Core to win.',
      'Raiders attack your base after the protection period. Defenses fight automatically, destroyed buildings are rebuilt by your Engineering Stations, and a shield follows every raid.',
      'While the game is closed, production (up to ' + C.offline.maxProductionHours + ' hours), training, construction and research continue. A few raids may happen too.'];
    return head('Controls &amp; Help', 'help') + '<div class="mbody"><div class="help"><div>' + keys(KEYS[0]) + keys(KEYS[1]) + '</div>' +
      '<div>' + keys(KEYS[2]) + '<h4>How to play</h4><ol class="steps">' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol></div></div></div>';
  };

  // ----- confirm
  MODALS.confirm = function (o) {
    return head(esc(o.title || 'Are you sure?'), o.danger ? 'warn' : 'help', true) + '<div class="mbody"><p class="ctext">' + esc(o.text) + '</p>' +
      '<div class="mact"><button class="mbtn ghost" data-act="confirmNo">' + esc(o.no || 'Cancel') + '</button>' +
      '<button class="mbtn ' + (o.danger ? 'danger' : 'primary') + '" data-act="confirmYes">' + esc(o.yes || 'Confirm') + '</button></div></div>';
  };

  UI.confirm = function (o, onYes) {
    UI._confirm = onYes;
    UI.open('confirm', o);
  };

  // ----- defense report
  function defenseHtml(rep, compact) {
    const st = G.state;
    const s = NPC.def(rep.attackerId);
    const counts = {};
    rep.destroyed.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    const lost = Object.keys(counts).map(function (t) { return esc(C.buildings[t].name) + (counts[t] > 1 ? ' &times;' + counts[t] : ''); }).join(', ');
    let top = '';
    if (rep.top) {
      const lv = Base.ofType(st, rep.top.type).reduce(function (m, b) { return Math.max(m, b.level); }, 1);
      top = '<div class="dr-line"><span class="lbl">Top defender</span><span class="dr-top">' + thumb(rep.top.type, lv, null, 48) + esc(C.buildings[rep.top.type].name) + '<small>' + U.fmt(rep.top.dmg) + ' damage</small></span></div>';
    }
    return '<div class="dreport ' + (rep.defended ? 'held' : 'lost') + (compact ? ' compact' : '') + '">' +
      '<div class="dr-h"><span class="dr-crest">' + (s ? CS.Icons.crest(s.faction, NPC.faction(s).color) : ICON.skull) + '</span>' +
      '<div class="dr-t"><span class="lbl">' + (rep.defended ? 'Raid repelled' : 'Base raided') + (rep.raidKind === 'retaliation' ? ' &middot; revenge' : '') + '</span>' +
      '<b>' + esc(rep.attacker) + '</b><small>' + esc(rep.faction) + (rep.leader ? ' &middot; led by ' + esc(rep.leader) : '') + (compact ? ' &middot; ' + ago(rep.at) : '') + '</small></div>' +
      '<div class="dr-stars" data-tip="Stars the raiders earned">' + stars(rep.stars) + '</div></div>' +
      '<div class="dr-grid"><div><span class="lbl">Damage</span><b>' + U.pct(rep.destruction) + '%</b>' + staticBar(rep.destruction, 'dmg') + '</div>' +
      '<div><span class="lbl">Raiders defeated</span><b>' + rep.killed + ' / ' + rep.raiders + '</b></div>' +
      '<div><span class="lbl">Stolen</span><b>' + (rep.stolen.credits + rep.stolen.energy ? costHtml(rep.stolen) : 'Nothing') + '</b></div>' +
      '<div><span class="lbl">Renown</span><b class="' + (rep.renown > 0 ? 'good' : rep.renown < 0 ? 'bad' : '') + '">' + (rep.renown > 0 ? '+' : '') + rep.renown + '</b></div></div>' +
      (lost ? '<div class="dr-line"><span class="lbl">Destroyed</span><span>' + lost + '</span></div>' : '') + top +
      (rep.heroes || []).map(function (g) {
        return '<div class="dr-line"><span class="lbl">Hero</span><span class="dr-top">' + troopImg(g.type, null, 40) + esc(C.troops[g.type].name) +
          '<small>' + U.fmt(g.dealt) + ' damage &middot; ' + (g.hp <= 0 ? 'fell, now resting' : g.hp < 1 ? 'wounded, now resting' : 'unhurt') + '</small></span></div>';
      }).join('') + '</div>';
  }

  MODALS.defense = function (rep) {
    const st = G.state;
    const cost = Eco.repairAllCost(st);
    const shield = st.threat.shieldUntil > CS.Clock.now();
    return head(rep.defended ? 'Your defenses held!' : 'Your base was raided', rep.defended ? 'shield' : 'warn', true) + '<div class="mbody">' + defenseHtml(rep) +
      (shield ? notice('shield', 'A shield protects you from raids for ' + until(st.threat.shieldUntil) + '.') : '') +
      (cost ? notice('wrench', 'Engineering Stations repair damage automatically' + (Eco.repairRate(st) ? ' (' + Eco.repairRate(st) + ' HP/s)' : '') + '. You can also repair everything now.') : '') +
      '<div class="mact">' + (cost ? '<button class="mbtn" data-act="defRepair">' + ic('wrench') + '<span>Repair now</span>' + costHtml({ credits: cost }, st) + '</button>' : '') +
      '<button class="mbtn primary" data-act="close"><span>Continue</span></button></div></div>';
  };

  UI.defenseReport = function (rep) {
    if (UI.modal === 'results') return;
    UI.open('defense', rep);
  };

  // ----- away report
  function arow(icon, title, html) { return '<div class="arow">' + ic(icon) + '<div><b>' + title + '</b>' + html + '</div></div>'; }

  MODALS.away = function (rep) {
    const st = G.state;
    const parts = [];
    const prod = rep.produced.credits + rep.produced.energy;
    if (prod > 0) parts.push(arow('sack', 'Produced', '<span class="arow-v">' + costHtml(rep.produced) + '</span><small>Waiting in your generators.' + (rep.capped ? ' Production while away is capped at ' + C.offline.maxProductionHours + ' hours.' : '') + '</small>'));
    const done = rep.built.map(function (e) { return C.buildings[e.btype].name + ' built'; }).concat(rep.upgraded.map(function (e) { return C.buildings[e.btype].name + ' Lv ' + e.level; }));
    if (done.length) parts.push(arow('hammer', 'Construction finished', '<small>' + esc(done.join(', ')) + '</small>'));
    const tr = Object.keys(rep.trained);
    if (tr.length) parts.push(arow('army', 'Troops trained', '<small>' + tr.map(function (t) { return rep.trained[t] + ' ' + C.troops[t].name + (rep.trained[t] > 1 ? 's' : ''); }).join(', ') + '</small>'));
    if (rep.research.length) parts.push(arow('flask', 'Research complete', '<small>' + rep.research.map(function (e) { return esc(CS.Research.describe(st, e.key).name) + ' Lv ' + e.level; }).join(', ') + '</small>'));
    if (rep.repaired) parts.push(arow('wrench', 'Rebuilt', '<small>' + rep.repaired + ' destroyed building' + (rep.repaired > 1 ? 's were' : ' was') + ' restored by your Engineers.</small>'));
    const raids = rep.raids.map(function (r) { return defenseHtml(r, true); }).join('');
    const seen = {};
    rep.news.forEach(function (n) { seen[n] = (seen[n] || 0) + 1; });
    const lines = Object.keys(seen).slice(-6);
    const news = lines.length ? '<h4>World news</h4><ul class="news">' + lines.map(function (n) { return '<li>' + esc(n) + (seen[n] > 1 ? ' <b>(&times;' + seen[n] + ')</b>' : '') + '</li>'; }).join('') + '</ul>' : '';
    return head('Welcome back, Commander', 'home', true) + '<div class="mbody"><p class="lead">You were away for <b>' + U.fmtTime(rep.seconds) + '</b>.</p>' +
      (parts.length ? '<div class="arows">' + parts.join('') + '</div>' : '') + (raids ? '<h4>Raids on your base</h4><div class="draids">' + raids + '</div>' : '') + news +
      '<div class="mact">' + (prod > 0 ? '<button class="mbtn ghost" data-act="close"><span>Continue</span></button><button class="mbtn primary" data-act="awayCollect">' + ic('sack') + '<span>Collect all</span></button>'
        : '<button class="mbtn primary" data-act="close"><span>Continue</span></button>') + '</div></div>';
  };

  // Reports wait until nothing else is open; UI.tick shows the next one.
  UI.awayReport = function (rep) {
    if (UI.modal || G.paused) UI.queue.push(rep);
    else UI.open('away', rep);
  };
  UI.queue = [];


  Object.assign(ACT, {
    tab: function (el) { UI.tab = el.dataset.tab; renderModal(); CS.Audio.play('click'); },
    buildType: function (el) { if (G.build(el.dataset.type)) UI.close(); },
    help: function () { UI.open('help'); },
    close: function () { UI.close(); },
    train: function (el) { G.train(el.dataset.type, Number(el.dataset.n)); },
    untrain: function (el) { G.untrain(Number(el.dataset.i)); },
    brew: function (el) { G.brew(el.dataset.type); },
    unbrew: function (el) { G.unbrew(Number(el.dataset.i)); },
    doResearch: function (el) { G.research(el.dataset.key); },
    cancelResearch: function () { UI.confirm({ title: 'Cancel research?', text: 'Stop the current research and get half of its cost back?', yes: 'Cancel it', no: 'Keep going', danger: true }, function () { G.cancelResearch(); UI.open('research'); }); },
    node: function (el) { UI.worldSel = el.dataset.id; renderModal(); CS.Audio.play('click'); },
    attack: function (el) { G.startRaid(el.dataset.id); },
    setting: function (el) { G.setSetting(el.dataset.key, !G.state.settings[el.dataset.key]); CS.Audio.play('click'); },
    raidMode: function (el) { G.setSetting('raidMode', el.dataset.v); CS.Audio.play('click'); },
    saveNow: function () { const ok = G.save(); UI.toast(ok ? 'Game saved' : 'Saving failed. Storage may be full or blocked.', ok ? 'good' : 'bad', ok ? 'check' : 'warn'); renderModal(); },
    resetGame: function () {
      UI.confirm({ title: 'Start a new game?', text: 'Your settlement, army and progress will be erased for good.', yes: 'Erase everything', danger: true }, function () {
        setTimeout(function () {
          UI.confirm({ title: 'Really erase?', text: 'Last chance. There is no way to recover the old settlement afterwards.', yes: 'Yes, start over', danger: true }, function () { G.newGame(); });
        }, 0);
      });
    },
    layouts: function () { UI.open('layouts'); },
    usePreset: function (el) {
      const i = Number(el.dataset.i);
      UI.confirm({ title: 'Use the ' + CS.Presets.STYLES[i].name + ' layout?', text: 'Every building in your base moves to this layout. Your current arrangement is not kept.', yes: 'Rearrange' },
        function () { G.applyPreset(i); });
    },
    backup: function () {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([G.backupJson()], { type: 'application/json' }));
      a.download = 'clash-of-cs-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      UI.toast('Backup downloaded', 'good', 'check');
    },
    restorePick: function () { $('restoreFile').click(); },
    secret: function () {
      const t = performance.now();
      UI._taps = (UI._taps || []).filter(function (x) { return t - x < 3000; }).concat(t);
      if (UI._taps.length < 7) return;
      UI._taps = [];
      UI.open(UI.adminOk ? 'admin' : 'adminCode');
      const f = $('adminCode');
      if (f) f.focus();
    },
    adminEnter: function () {
      const f = $('adminCode');
      if (f && f.value.trim().toLowerCase() === CS.Admin.CODE) { UI.adminOk = true; UI.open('admin'); return; }
      UI.toast('Wrong code', 'bad', 'lock');
      if (f) { f.value = ''; f.focus(); }
    },
    cheat: function (el) { G.cheat(el.dataset.key, !G.state.cheats[el.dataset.key]); CS.Audio.play('click'); },
    adminDo: function (el) { G.adminAction(el.dataset.v); CS.Audio.play('click'); },
    confirmYes: function () { const f = UI._confirm; UI._confirm = null; UI.close(); if (f) f(); },
    confirmNo: function () { UI._confirm = null; UI.close(); },
    awayCollect: function () { G.collectAll(); UI.close(); },
    defRepair: function () { G.repairAll(); renderModal(); }
  });

  // ---------------------------------------------------------------- battle HUD
  // Raid HUD: the target and its loot (top left), the clock (top centre), destruction with the
  // three victory conditions (top right), a hint, the troop bar (bottom left) and the battle
  // controls (bottom right). Every value is read from the live battle.
  function sumOf(o) { let n = 0; Object.keys(o || {}).forEach(function (k) { n += o[k]; }); return n; }
  function setClass(el, c) { if (el.className !== c) el.className = c; }
  function setTxt(el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }

  const RAID_END = { wiped: 'Every building destroyed', time: 'Time ran out', troops: 'No troops left', retreat: 'You ended the battle' };

  function lootRow(r) {
    return '<div class="bh-lr">' + resIcon(r) + '<b id="bhGot_' + r + '">0</b><div class="bar ' + r + '"><div id="bhBar_' + r + '"></div></div><small id="bhLeft_' + r + '"></small></div>';
  }

  function goal(i, label, tip) {
    return '<li id="bhGoal' + i + '" data-tip="' + tip + '">' + ic('starOff') + '<span>' + label + '</span></li>';
  }

  function battleHudHtml() {
    const half = U.pct(C.battle.winDestruction);
    return '<div class="bh-top" data-inset="t">' +
      '<div class="bh-target plaque"><div class="bh-id"><span class="bh-crest" id="bhCrest"></span><div class="bh-idt"><b id="bhName"></b><small id="bhSub"></small><small class="bh-diff" id="bhDiff"></small></div></div>' +
      '<div class="bh-loot"><span class="lbl">Loot taken</span>' + lootRow('credits') + lootRow('energy') + '</div></div>' +
      '<div class="bh-clock plaque" id="bhClock"><span class="lbl" id="bhPhase"></span><b id="bhTime"></b><small id="bhNote"></small></div>' +
      '<div class="bh-score plaque"><div class="bh-pct"><b id="bhPct">0%</b><span class="lbl">Destroyed</span></div><ul class="bh-goals" aria-label="Victory stars">' +
      goal(0, half + '%', 'Destroy ' + half + '% of the buildings') + goal(1, 'Core', 'Destroy the Command Core') + goal(2, '100%', 'Destroy every building') + '</ul></div></div>' +
      '<div class="bh-bottom" data-inset="b">' +
      '<div class="bh-troops plaque"><div class="bh-count"><b id="bhCount">0</b><span class="lbl">Troops left</span></div><div class="bh-tlist" id="bhTroops"></div></div>' +
      '<p class="bh-hint" id="bhHint"></p>' +
      '<div class="bh-ctrl plaque"><button class="mbtn bh-speed" data-act="speed" id="bhSpeed" data-tip="Battle speed <kbd>F</kbd>">' + ic('speed') + '<span>1x</span></button>' +
      '<button class="mbtn" data-act="endBattle" id="bhEnd"></button></div></div>';
  }

  function defHudHtml() {
    const half = U.pct(C.battle.winDestruction);
    return '<div class="dh-who" id="dhWho"><span class="dh-crest" id="dhCrest"></span><div class="dh-wt"><span class="lbl" id="dhKind"></span><b id="dhName"></b></div></div>' +
      '<div class="dh-stats"><div class="dh-stat"><b id="dhTime">0:00</b><small>left</small></div>' +
      '<div class="dh-stat" id="dhDmg" data-tip="The raiders win at ' + half + '% damage or by destroying your Command Core."><b>0%</b><small>damage</small></div>' +
      '<div class="dh-stat"><b id="dhLeft">0</b><small>raiders left</small></div></div>' +
      '<div class="dh-act"><button class="sbtn bh-speed" data-act="speed" id="dhSpeed" data-tip="Battle speed <kbd>F</kbd>">' + ic('speed') + '<span>1x</span></button>' +
      '<button class="sbtn" data-act="skipDefense" id="dhSkip" data-tip="Resolve the rest of the fight instantly">' + ic('skip') + '<span>Skip</span></button></div>';
  }

  function speedBtn(el, cls) {
    setTxt(el.lastElementChild, G.speed + 'x');
    setAttr(el, 'aria-label', 'Battle speed ' + G.speed + 'x');
    setClass(el, cls + (G.speed > 1 ? ' fast' : ''));
  }

  UI.refreshBattle = function () { updateBattleHud(); };

  function updateBattleHud() {
    const b = G.battle || G.lastBattle;
    if (!b || G.mode !== 'raid') return;
    const Bt = CS.Battle, s = NPC.def(b.targetId), fac = NPC.faction(s);
    setText('bhName', s.name);
    setText('bhSub', 'Tier ' + s.tier + ' · ' + fac.name);
    setHtml($('bhCrest'), CS.Icons.crest(s.faction, fac.color));
    const d = b.meta.difficulty;
    setHtml($('bhDiff'), d ? '<b class="d-' + esc(d.toLowerCase()) + '">' + esc(d) + '</b> for your army' : '');
    // loot taken against what the standing buildings still hold
    const left = { credits: 0, energy: 0 };
    b.buildings.forEach(function (c) { if (c.lootLeft) { left.credits += c.lootLeft.credits; left.energy += c.lootLeft.energy; } });
    Eco.RES.forEach(function (r) {
      const got = b.loot[r], all = got + left[r];
      setText('bhGot_' + r, U.fmt(got));
      setText('bhLeft_' + r, all < 1 ? 'none' : left[r] < 1 ? 'all taken' : U.fmt(left[r]) + ' left');
      setWidth('bhBar_' + r, all ? got / all : 0);
    });
    // the clock stands still while scouting and turns urgent in the last 30 seconds
    const tl = Bt.timeLeft(b), scout = b.phase === 'scout';
    setText('bhPhase', b.ended ? 'Battle over' : scout ? 'Scouting' : 'Battle ends in');
    setText('bhTime', U.clockTime(tl));
    setText('bhNote', scout && !b.ended ? 'Deploy to start' : '');
    setClass($('bhClock'), 'bh-clock plaque' + (b.ended ? ' over' : scout ? ' scout' : tl <= 30 ? ' urgent' : ''));
    const f = Bt.destruction(b);
    setText('bhPct', U.pct(f) + '%');
    [f >= C.battle.winDestruction, !!b.coreDown, f >= 1].forEach(function (met, i) {
      const li = $('bhGoal' + i);
      if (li.classList.contains('met') === met) return;
      li.classList.toggle('met', met);
      li.firstElementChild.innerHTML = ICON[met ? 'star' : 'starOff'];
    });
    updateTroops(b);
    speedBtn($('bhSpeed'), 'mbtn bh-speed');
    const end = $('bhEnd'), dep = b.deployedAny;
    setClass(end, 'mbtn' + (dep && !b.ended ? ' danger' : ''));   // a finished battle's button reads as disabled
    setHtml(end, ic(dep ? 'flag' : 'home') + '<span>' + (dep ? 'End battle' : 'Return home') + '</span>');
    end.disabled = b.ended;
    const spell = C.spells[G.troopSel] && b.spells[G.troopSel] > 0 ? C.spells[G.troopSel] : null;
    setText('bhHint', b.ended ? '' : spell ? 'Tap anywhere to cast ' + spell.name + '. ' + spell.desc : scout ? 'Look around, pick a troop, then tap outside the red zone. Hold to deploy a stream of troops.'
      : Bt.poolTotal(b) ? 'Destroy ' + U.pct(C.battle.winDestruction) + '% of the buildings or the Command Core to win.'
        : Bt.spellsLeft(b) ? 'All troops deployed. Pick a spell and tap anywhere to cast it.' : 'All troops deployed.');
  }

  // One button per troop type brought, numbered like the 1-6 keys. Rebuilt only when that set
  // changes, so a focused button keeps focus while counts update.
  function updateTroops(b) {
    const box = $('bhTroops');
    const list = G.tray(b);
    if (box.dataset.key !== list.join()) {
      box.dataset.key = list.join();
      box.classList.toggle('dense', list.length > 12);
      box.innerHTML = list.map(function (t, i) {
        const P = C.spells[t];
        return '<button class="tbtn' + (P ? ' spell' : '') + '" data-act="troop" data-type="' + t + '" data-tip="' + esc(P ? P.name + ': ' + P.desc : C.troops[t].name) + ' <kbd>' + (i + 1) + '</kbd>">' +
          '<kbd>' + (i + 1) + '</kbd><span class="lv"></span>' + (P ? spellImg(t, 56) : troopImg(t, null, 56)) + '<b></b></button>';
      }).join('');
    }
    Array.prototype.forEach.call(box.children, function (el) {
      const t = el.dataset.type;
      if (C.spells[t]) {
        const n = b.spells[t] || 0, on = !b.ended && n > 0 && G.troopSel === t;
        if (on && !el.classList.contains('on')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        setClass(el, 'tbtn spell' + (on ? ' on' : ''));
        el.disabled = b.ended || !n;
        setAttr(el, 'aria-pressed', String(on));
        setAttr(el, 'aria-label', C.spells[t].name + ', ' + n + ' left, level ' + b.spellLv);
        setTxt(el.querySelector('.lv'), 'Lv ' + b.spellLv);
        setTxt(el.querySelector('b'), n);
        return;
      }
      const n = b.pool[t] || 0, lv = b.troopLv[t] || 1;
      const on = !b.ended && n > 0 && G.troopSel === t;
      if (on && !el.classList.contains('on')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // a deployed hero's button becomes its ability button until the ability is spent
      const ab = C.heroes[t] && !n && CS.Battle.abilityReady(b, t);
      setClass(el, 'tbtn' + (on ? ' on' : '') + (C.heroes[t] ? ' hero' : '') + (ab ? ' ab' : ''));
      el.disabled = b.ended || (!n && !ab);
      setAttr(el, 'aria-pressed', String(on));
      setAttr(el, 'aria-label', C.troops[t].name + (ab ? ': use ' + C.heroes[t].ability.name : ', ' + n + ' left') + ', level ' + lv);
      setTxt(el.querySelector('.lv'), 'Lv ' + lv);
      setTxt(el.querySelector('b'), ab ? C.heroes[t].ability.name : n);
    });
    setText('bhCount', CS.Battle.poolTotal(b));
  }

  function defenseHudUpdate() {
    const el = $('defhud');
    const b = G.battle;
    if (G.mode !== 'defense' || !b) { el.classList.add('hidden'); return; }
    const Bt = CS.Battle, s = NPC.def(b.attackerId), fac = NPC.faction(s), f = Bt.destruction(b);
    setHtml($('dhCrest'), CS.Icons.crest(s.faction, fac.color));
    setAttr($('dhWho'), 'data-tip', esc(fac.name) + ' &middot; Tier ' + s.tier);
    setText('dhKind', b.meta.raidKind === 'retaliation' ? 'Revenge raid' : 'Raid in progress');
    setText('dhName', s.name);
    setText('dhTime', U.clockTime(Bt.timeLeft(b)));
    const dmg = $('dhDmg');
    setTxt(dmg.firstElementChild, U.pct(f) + '%');
    setClass(dmg, 'dh-stat' + (f >= C.battle.winDestruction || b.coreDown ? ' bad' : ''));
    setText('dhLeft', b.units.length + b.ai.length);
    speedBtn($('dhSpeed'), 'sbtn bh-speed');
    $('dhSkip').disabled = b.ended;
    el.classList.remove('hidden');
  }

  function starRow(n) {
    let s = '';
    for (let i = 0; i < 3; i++) s += '<i class="ic' + (i < n ? ' lit' : '') + '" style="--i:' + i + '">' + ICON[i < n ? 'star' : 'starOff'] + '</i>';
    return '<span class="rs-stars" role="img" aria-label="' + n + ' of 3 stars">' + s + '</span>';
  }

  // ----- end-of-battle ribbon: the verdict, read from the finished battle, shown until its report opens
  let ribbon = null, ribbonFor = null, ribbonT = 0;
  function hideRibbon() {
    clearTimeout(ribbonT);
    if (ribbon) ribbon.classList.add('hidden');
  }
  CS.Bus.on('ui:open', hideRibbon);

  UI.battleOver = function (b) {
    if (!b || !b.ended || b === ribbonFor) return;
    ribbonFor = b;
    const res = CS.Battle.result(b), pct = U.pct(res.destruction);
    const raid = b.kind === 'attack', win = raid ? res.victory : !res.victory;
    const title = raid ? (win ? 'Victory' : 'Defeat') : (win ? 'Raid repelled' : 'Base raided');
    const sub = raid ? (res.reason === 'wiped' ? RAID_END.wiped : pct + '% destroyed · ' + (RAID_END[res.reason] || 'Battle over'))
      : pct + '% damage · ' + sumOf(res.lost) + ' of ' + sumOf(res.deployed) + ' raiders defeated';
    if (!ribbon) {
      ribbon = document.createElement('div');
      ribbon.setAttribute('role', 'status');
      document.body.appendChild(ribbon);
    }
    ribbon.className = 'bh-over ' + (win ? 'win' : 'lose');
    ribbon.innerHTML = (raid ? starRow(res.stars) : ic(win ? 'shield' : 'skull', 'bo-ic')) + '<h2>' + title + '</h2><p>' + esc(sub) + '</p>';
    clearTimeout(ribbonT);
    ribbonT = setTimeout(hideRibbon, 2600);   // fallback; opening the report hides it sooner
  };

  // ----- raid results
  function troopSummary(res) {
    const rows = C.deployOrder.filter(function (t) { return res.deployed[t] > 0; }).map(function (t) {
      const lost = res.lost[t] || 0;
      return '<tr><td>' + troopImg(t, null, 40) + esc(C.troops[t].name) + '</td><td>' + res.deployed[t] + '</td><td' + (lost ? ' class="bad"' : '') + '>' + lost + '</td></tr>';
    }).join('');
    return '<table class="rs-troops"><tr><th></th><th><span class="lbl">Deployed</span></th><th><span class="lbl">Lost</span></th></tr>' + rows + '</table>';
  }

  function spellSummary(res) {
    const used = C.spellOrder.filter(function (t) { return res.cast && res.cast[t] > 0; });
    if (!used.length) return '';
    return '<h4>Spells cast</h4><div class="chips">' + used.map(function (t) {
      return '<span class="chipT" data-tip="' + esc(C.spells[t].name) + '">' + spellImg(t, 40) + '<b>' + res.cast[t] + '</b></span>';
    }).join('') + '</div>';
  }

  function cell(label, value) { return '<div><span class="lbl">' + label + '</span><b>' + value + '</b></div>'; }

  MODALS.results = function (r) {
    const res = r.res, s = r.s, fac = NPC.faction(s), win = res.victory;
    const loot = Eco.RES.map(function (k) { return '<span class="cost">' + resIcon(k) + (r.gained[k] > 0 ? '+' : '') + U.fmt(r.gained[k]) + '</span>'; }).join('');
    const notes = r.notes.map(function (n) {
      const warn = /revenge|counterattack/i.test(n);
      return '<div class="notice' + (warn ? ' warn' : '') + '">' + ic(warn ? 'warn' : 'info') + '<span>' + esc(n) + '</span></div>';
    }).join('');
    const tips = r.tips.length ? '<div class="rs-tips"><h4>Why the raid failed</h4><ul>' + r.tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '';
    return '<div class="mh"><span class="rs-crest">' + CS.Icons.crest(s.faction, fac.color) + '</span><div class="rs-ht"><h2>' + esc(s.name) + '</h2><small class="rs-tier">Tier ' + s.tier + ' · ' + esc(fac.name) + '</small></div></div>' +
      '<div class="mbody results"><div class="rs-verdict ' + (win ? 'win' : 'lose') + '"><h3>' + (win ? 'Victory' : 'Defeat') + '</h3>' + starRow(res.stars) +
      '<p>' + esc(RAID_END[res.reason] || '') + '</p></div>' +
      '<div class="rs-stats">' + cell('Destroyed', U.pct(res.destruction) + '%') + cell('Buildings', res.destroyed + ' of ' + res.total) +
      cell('Command Core', res.coreDown ? 'Destroyed' : 'Standing') + cell('Battle time', U.fmtTime(res.seconds)) + '</div>' +
      '<div class="rs-cols"><section class="rs-box"><h4>Loot gained</h4><div class="rs-loot">' + loot + '</div>' +
      (r.bonus ? '<small>Includes a victory bonus of ' + U.fmt(r.bonus) + ' each.</small>' : '') +
      (r.reward ? '<small class="good">Includes the boss reward of ' + U.fmt(r.reward.credits) + ' each.</small>' : '') +
      (r.wasted > 0 ? '<small class="bad">' + U.fmt(r.wasted) + ' could not be stored. Your storages are full.</small>' : '') +
      '<h4>Renown</h4><div class="rs-renown ' + (r.renown > 0 ? 'up' : r.renown < 0 ? 'down' : '') + '">' + ic('renown') +
      (r.renown ? (r.renown > 0 ? '+' : '') + r.renown : 'Unchanged') + '</div></section>' +
      '<section class="rs-box"><h4>Troops</h4>' + troopSummary(res) + '<small>Survivors return to your army.</small>' + spellSummary(res) + '</section></div>' + notes + tips + '</div>' +
      '<div class="rs-foot"><button class="mbtn primary" data-act="home">' + ic('home') + '<span>Return home</span></button></div>';
  };

  UI.raidResults = function (r) {
    hideRibbon();
    UI.open('results', r);
    UI.onClose = function () { if (G.mode === 'raid') G.goHome(); };
    const home = document.querySelector('#modal [data-act="home"]');
    if (home) home.focus({ preventScroll: true });
  };

  Object.assign(ACT, {
    troop: function (el) { G.selectTroop(el.dataset.type); },
    speed: function () { G.toggleSpeed(); defenseHudUpdate(); },
    endBattle: function () {
      const b = G.battle;
      if (!b) return;
      if (!b.deployedAny) { G.endBattle(); return; }
      UI.confirm({ title: 'End the battle?', text: 'Your troops stop fighting and the result is counted now. Survivors come home.', yes: 'End battle', danger: true }, function () {
        G.endBattle();
      });
    },
    skipDefense: function () { G.skipDefense(); },
    home: function () { UI.onClose = null; UI.close(); G.goHome(); }
  });

  // ---------------------------------------------------------------- modes
  UI.enterVillage = function () {
    document.body.dataset.mode = 'village';
    $('hud').classList.remove('hidden');
    $('battlehud').classList.add('hidden');
    $('defhud').classList.add('hidden');
    UI.refresh(true);
    measureInsets();
  };

  UI.enterDefense = function () {
    document.body.dataset.mode = 'defense';
    $('hud').classList.remove('hidden');
    $('battlehud').classList.add('hidden');
    defenseHudUpdate();
    UI.refresh(true);
    measureInsets();
  };

  UI.enterRaid = function () {
    document.body.dataset.mode = 'raid';
    $('hud').classList.add('hidden');
    $('defhud').classList.add('hidden');
    $('battlehud').classList.remove('hidden');
    UI.refreshBattle();
    measureInsets();
  };

  // ---------------------------------------------------------------- title screen
  UI.showTitle = function (loaded) {
    const st = G.state;
    const el = $('title');
    const existing = loaded.status === 'loaded' || loaded.status === 'recovered';
    const msg = loaded.message ? '<div class="tnotice">' + ic('warn') + '<span>' + esc(loaded.message) + '</span></div>' : '';
    el.innerHTML = '<div class="tbox"><div class="logo"><span class="crestbig">' + banner(ICON.sword.replace('<svg ', '<svg x="7" y="7.4" width="18" height="18" ')) + '</span>' +
      '<h1 class="wordmark"><span class="w1">Clash</span><span class="w2">of</span><span class="w3">CS</span></h1></div>' +
      '<p class="tagline">Build your settlement. Train an army. Raid your rivals.</p>' + msg +
      (existing ? '<div class="tsave"><span>' + ic('star') + 'Commander <b>Lv ' + st.player.level + '</b></span><span>' + ic('core') + 'Command Core <b>Lv ' + Base.coreLevel(st) + '</b></span>' +
        '<span>' + ic('renown') + '<b>' + U.fmt(st.player.renown) + '</b> renown</span></div>' : '') +
      '<div class="tactions"><button class="mbtn primary big" data-act="play">' + ic('sword') + '<span>' + (existing ? 'Continue' : 'Play') + '</span></button>' +
      (existing ? '<button class="sbtn ghost" data-act="titleNew">Start a new game</button>' : '') + '</div>' +
      '<p class="foot">Runs fully offline. Your progress is saved in this browser.</p></div>';
    el.classList.remove('hidden');
    document.body.dataset.mode = 'title';
  };

  UI.hideTitle = function () { $('title').classList.add('hidden'); };

  // ---------------------------------------------------------------- refresh & tick
  UI.refresh = function (full) {
    if (!G || !G.state) return;
    updateTopbar();
    updateBottom();
    updatePanel(full);
    updatePlacebar();
    updateThreat();
    defenseHudUpdate();
    if (full && UI.modal && UI.modal !== 'confirm' && UI.modal !== 'results' && UI.modal !== 'away' && UI.modal !== 'defense' && UI.modal !== 'adminCode') renderModal();
  };

  UI.tick = function () {
    if (!G || !G.state) return;
    const t = CS.Clock.now();
    document.querySelectorAll('[data-until]').forEach(function (el) {
      el.textContent = U.fmtTime((Number(el.dataset.until) - t) / 1000);
    });
    document.querySelectorAll('[data-from]').forEach(function (el) {
      const a = Number(el.dataset.from), b = Number(el.dataset.to);
      el.style.width = (b > a ? U.clamp((t - a) / (b - a), 0, 1) * 100 : 100).toFixed(1) + '%';
    });
    updateTopbar();
    updateBottom();
    updatePanel(false);
    updatePlacebar();
    updateThreat();
    defenseHudUpdate();
    if (G.mode === 'raid') updateBattleHud();
    if (!UI.modal && UI.queue.length && !G.paused) UI.open('away', UI.queue.shift());
  };

  // ---------------------------------------------------------------- actions
  Object.assign(ACT, {
    build: function () { if (G.mode !== 'village') { UI.toast('Not while raiders are attacking your base', 'bad', 'shield'); return; } UI.open('build'); },
    edit: function () { G.toggleEdit(); updateBottom(); },
    collect: function () { G.collectAll(); },
    collectOne: function () { const b = CS.Base.find(G.state, G.sel); if (b) Eco.collect(G.state, b); UI.refresh(true); },
    repairAll: function () { G.repairAll(); },
    world: function () { UI.open('world'); },
    army: function () { UI.open('army'); },
    research: function () { UI.open('research'); },
    log: function () { UI.open('log'); },
    stats: function () { UI.open('log'); },
    settings: function () { UI.open('settings'); },
    closePanel: function () { G.select(null); },
    upgrade: function () { G.upgrade(G.sel); },
    wallsUp: function (el) { G.upgradeWalls(Number(el.dataset.level)); },
    move: function () { G.startMove(G.sel); },
    repair: function () { G.repair(G.sel); },
    cancelTimer: function () {
      const id = G.sel;
      UI.confirm({ title: 'Cancel?', text: 'Stop this construction and get half of its cost back?', yes: 'Cancel it', no: 'Keep building', danger: true }, function () { G.cancelTimer(id); });
    },
    place: function () { G.confirmPlace(); },
    rotate: function () { G.rotatePlace(); },
    cancelPlace: function () { G.cancelPlace(); },
    play: function () { G.play(); },
    titleNew: function () {
      UI.confirm({ title: 'Start over?', text: 'This erases your current settlement and all progress. This cannot be undone.', yes: 'Erase and start over', danger: true }, function () { G.newGame(); G.play(); });
    },
    tutNext: function () { CS.Tutorial.next(); },
    tutSkip: function () { CS.Tutorial.skip(); }
  });

  UI.init = function (game) {
    G = game;
    $('topbar').innerHTML = topbarHtml();
    $('side').innerHTML = sideHtml();
    $('bottom').innerHTML = bottomHtml();
    $('battlehud').innerHTML = battleHudHtml();
    $('defhud').innerHTML = defHudHtml();
    // the troop bar scrolls sideways under a mouse wheel when it holds more than fits
    $('bhTroops').addEventListener('wheel', function (e) {
      const el = e.currentTarget;
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('click', function (e) {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      const fn = ACT[el.dataset.act];
      if (!fn) return;
      e.preventDefault();
      CS.Audio.unlock();
      fn(el, e);
    });
    $('modal').addEventListener('pointerdown', function (e) {
      if (e.target.id !== 'modal') return;
      if (UI.modal === 'results' || UI.modal === 'confirm') return;
      UI.close();
    });
    document.addEventListener('input', function (e) {
      if (e.target.dataset && e.target.dataset.range === 'volume') {
        G.state.settings.volume = Number(e.target.value);
        CS.Audio.applySettings(G.state.settings);
      }
    });
    document.addEventListener('change', function (e) {
      if (e.target.dataset && e.target.dataset.range === 'volume') G.save();
      if (e.target.id === 'restoreFile') readRestore(e.target);
      if (e.target.dataset && e.target.dataset.pick === 'raid') UI.raidPick = e.target.value;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.id === 'adminCode') { e.preventDefault(); ACT.adminEnter(); }
    });
    window.addEventListener('resize', measureInsets);
    initTooltips();
  };

  function readRestore(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 5e6) { UI.toast('That file is too big to be a backup', 'bad', 'warn'); return; }
    const rd = new FileReader();
    rd.onerror = function () { UI.toast('The file could not be read', 'bad', 'warn'); };
    rd.onload = function () {
      let json;
      try { json = CS.State.readBackup(String(rd.result), CS.Clock.now()); } catch (err) { UI.toast(err.message, 'bad', 'warn'); return; }
      UI.confirm({ title: 'Restore this backup?', text: 'Your current game is replaced by the backup from ' + file.name + '. The game reloads to finish.', yes: 'Restore', danger: true },
        function () { G.restore(json); });
    };
    rd.readAsText(file);
  }

  CS.UI = UI;
})(window.CS = window.CS || {});
