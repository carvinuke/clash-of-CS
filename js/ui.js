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
    return toolBtn('build', 'hammer', 'Build', 'B') + toolBtn('edit', 'move', 'Edit', 'E') +
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
    if (b.type === 'core') {
      row('Storage (each)', L.store, N && N.store);
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
    if (b.type === 'station') row('Repairs', L.repair, N && N.repair, function (v) { return v + ' HP/s'; });
    if (def.attack) {
      const A = def.attack;
      const dm = CS.Research.mult(st, 'targeting');
      if (A.kind === 'lance') row('Damage', L.dmg * dm, N && N.dmg * dm, function (v) { return Math.round(v) + '/s, up to x' + A.rampMax; });
      else if (A.kind === 'mine') row('Blast damage', L.dmg * dm, N && N.dmg * dm, function (v) { return Math.round(v); });
      else row('Damage', L.dmg * dm, N && N.dmg * dm, function (v) { return Math.round(v) + (A.period ? ' every ' + A.period + 's' : ''); });
      if (L.slow) row('Slow', L.slow * 100, N && N.slow * 100, function (v) { return Math.round(v) + '%'; });
      rows.push('<tr><td>Range</td><td colspan="2">' + (A.minRange ? A.minRange + '&ndash;' : '') + A.range + ' tiles' + (A.splash ? ', splash ' + A.splash : '') + '</td></tr>');
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
  const MODALS = {};

  UI.open = function (name, arg) {
    if (G.paused && name !== 'confirm') return;
    UI.modal = name;
    UI.arg = arg;
    const m = $('modal');
    m.className = 'm-' + name;
    renderModal();
    m.scrollTop = 0;
    CS.Audio.play('open');
    syncNav();
    CS.Bus.emit('ui:open', { name: name });
  };

  UI.close = function () {
    if (!UI.modal) return;
    const m = $('modal');
    const was = UI.modal;
    UI.modal = null;
    m.className = 'hidden';
    m.firstElementChild.innerHTML = '';
    if (UI.onClose) { const f = UI.onClose; UI.onClose = null; f(); }
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
    box.innerHTML = MODALS[UI.modal](UI.arg);
    const nb = box.querySelector('.mbody');
    if (nb) nb.scrollTop = top;
    if (UI.modal === 'world') mountMap();
  }

  function head(title, icon, noClose) {
    return '<div class="mh">' + (icon ? ic(icon) : '') + '<h2>' + title + '</h2>' + (noClose ? '' : '<button class="x" data-act="close" aria-label="Close">' + ICON.close + '</button>') + '</div>';
  }

  // ----- build menu
  MODALS.build = function () {
    const st = G.state;
    const tabs = C.buildMenu.map(function (t) {
      return '<button class="tab' + (UI.tab === t.id ? ' on' : '') + '" data-act="tab" data-tab="' + t.id + '">' + t.name + '</button>';
    }).join('');
    const tab = C.buildMenu.find(function (t) { return t.id === UI.tab; }) || C.buildMenu[0];
    const eng = Eco.engineers(st);
    const cards = tab.items.map(function (type) {
      const def = C.buildings[type];
      const chk = Eco.canBuild(st, type);
      const time = Eco.isInstant(type, 1) ? 'Instant' : U.fmtTime(def.levels[0].time);
      let note = '';
      if (chk.locked) note = '<div class="lock">' + ic('lock') + esc(chk.reason) + '</div>';
      else if (chk.maxed) note = '<div class="lock">Built ' + chk.count + '/' + chk.max + '. Upgrade the Command Core for more.</div>';
      else if (!chk.ok) note = '<div class="short">' + esc(chk.reason) + '</div>';
      return '<button class="card' + (chk.ok ? '' : ' dis') + (chk.locked ? ' locked' : '') + '" data-act="buildType" data-type="' + type + '" data-tip="' + esc(def.desc) + '">' +
        thumb(type, 1, null, 96) + '<div class="cn">' + esc(def.name) + '</div>' +
        '<div class="cc">' + (chk.locked ? '' : chk.count + '/' + chk.max) + '</div>' +
        '<div class="cp">' + costHtml(chk.cost, st) + ' <span class="time">' + ic('clock') + time + '</span></div>' + note + '</button>';
    }).join('');
    return head('Build', 'hammer') + '<div class="tabs">' + tabs + '</div>' +
      '<div class="mbody"><p class="hint">Engineers free: <b>' + eng.free + '/' + eng.total + '</b>. Walls, mines and new Engineering Stations finish instantly.</p><div class="cards">' + cards + '</div></div>';
  };

  // ----- army
  MODALS.army = function () {
    const st = G.state;
    const cap = Army.capacity(st), used = Army.armySpace(st), q = Army.queueSpace(st);
    const barracks = Army.activeBarracks(st);
    const cards = C.troopOrder.map(function (type) {
      const T = C.troops[type];
      const s = Army.stats(st, type);
      const unlocked = Army.isUnlocked(st, type);
      const chk1 = Army.canQueue(st, type, 1), chk5 = Army.canQueue(st, type, 5);
      const tip = esc(T.desc) + '<br>HP ' + s.hp + ' &middot; ' + (T.target === 'troop' ? 'Heals ' + s.dmg + '/s' : 'DMG ' + s.dmg + (T.suicide ? ' (x' + T.wallMult + ' vs walls)' : '')) + ' &middot; Range ' + T.range + ' &middot; Speed ' + T.speed;
      return '<div class="tcard' + (unlocked ? '' : ' locked') + '" data-tip="' + tip + '">' + troopImg(type, null, 72) +
        '<div class="tn">' + esc(T.name) + ' <span class="lv">Lv ' + Army.level(st, type) + '</span></div>' +
        '<div class="tm">' + resIcon('energy') + U.fmt(s.cost) + ' &middot; ' + ic('army') + T.space + ' &middot; ' + U.fmtTime(Army.trainSeconds(st, type)) + '</div>' +
        (unlocked ? '<div class="row"><button class="sbtn" data-act="train" data-type="' + type + '" data-n="1"' + (chk1.ok ? '' : ' disabled') + '>+1</button><button class="sbtn" data-act="train" data-type="' + type + '" data-n="5"' + (chk5.ok ? '' : ' disabled') + '>+5</button></div>' +
          (chk1.ok ? '' : '<div class="short">' + esc(chk1.reason) + '</div>')
          : '<div class="lock">' + ic('lock') + 'Barracks Lv ' + Army.unlockLevel(type) + '</div>') + '</div>';
    }).join('');
    const have = C.troopOrder.filter(function (t) { return st.army.units[t] > 0; }).map(function (t) {
      return '<div class="chipT">' + troopImg(t, null, 44) + '<b>' + st.army.units[t] + '</b></div>';
    }).join('') || '<p class="hint">No troops yet. Train some to raid enemy settlements.</p>';
    let queue = '';
    if (st.army.queue.length) {
      const head0 = st.army.queue[0];
      const need = Army.trainSeconds(st, head0.type) / Math.max(1, barracks);
      const left = Math.max(0, (Army.trainSeconds(st, head0.type) - st.army.progress) / Math.max(1, barracks));
      const now = CS.Clock.now();
      queue = st.army.queue.map(function (e, i) {
        return '<div class="qitem">' + troopImg(e.type, null, 40) + '<b>&times;' + e.count + '</b>' +
          (i === 0 ? (barracks ? bar(now - (need - left) * 1000, now + left * 1000, 'q') : '<small class="bad">No working Barracks</small>') : '') +
          '<button class="xs" data-act="untrain" data-i="' + i + '" data-tip="Remove one (full refund)">' + ICON.close + '</button></div>';
      }).join('') + '<p class="hint">All training done in ' + until(now + Army.queueRemaining(st) * 1000) + '</p>';
    } else queue = '<p class="hint">Nothing in training.</p>';
    return head('Army', 'army') + '<div class="mbody army">' +
      '<div class="capline">' + ic('army') + 'Housing <b>' + used + (q ? ' + ' + q : '') + ' / ' + cap + '</b>' + staticBar((used + q) / Math.max(1, cap), 'army') + '</div>' +
      '<p class="hint">' + (barracks ? barracks + ' working Barracks' + (barracks > 1 ? ' train ' + barracks + 'x faster.' : '.') + ' Training continues while the game is closed.' : 'You need a working Barracks to train troops.') + '</p>' +
      '<div class="tcards">' + cards + '</div>' +
      '<div class="cols"><div><h4>Your army</h4><div class="chips">' + have + '</div></div><div><h4>Training</h4>' + queue + '</div></div></div>';
  };

  // ----- research
  MODALS.research = function () {
    const st = G.state;
    const lab = CS.Research.lab(st);
    const ra = st.research.active;
    let top = '';
    if (!lab) top = '<div class="notice">' + ic('info') + 'Build a Research Lab to unlock research' + (Base.unlockCore('lab') > Base.coreLevel(st) ? ' (available at Command Core Lv ' + Base.unlockCore('lab') + ')' : ' from the Build menu') + '.</div>';
    if (ra) {
      const d = CS.Research.describe(st, ra.key);
      top += '<div class="active-r">' + ic('flask') + '<div><b>' + esc(d.name) + ' Lv ' + (d.level + 1) + '</b> ' + until(ra.end) + bar(ra.start, ra.end) + '</div><button class="sbtn danger" data-act="cancelResearch">Cancel</button></div>';
    }
    function rowHtml(d) {
      let effect = '';
      if (d.kind === 'troop') {
        const a = Army.stats(st, d.key, d.level), b = d.maxed ? null : Army.stats(st, d.key, d.level + 1);
        effect = 'HP ' + a.hp + (b ? ' &rarr; ' + b.hp : '') + ', ' + (C.troops[d.key].target === 'troop' ? 'heal ' : 'DMG ') + a.dmg + (b ? ' &rarr; ' + b.dmg : '');
      } else {
        const per = C.research.techs[d.key].per;
        effect = esc(d.desc) + ' +' + Math.round(d.level * per * 100) + '%' + (d.maxed ? '' : ' &rarr; +' + Math.round((d.level + 1) * per * 100) + '%');
      }
      const chk = CS.Research.canStart(st, d.key);
      const cost = {}; if (d.cost) cost[d.res] = d.cost;
      return '<div class="rrow' + (d.locked ? ' locked' : '') + '">' + (d.kind === 'troop' ? troopImg(d.key, null, 48) : '<span class="techic">' + ICON.flask + '</span>') +
        '<div class="rinfo"><b>' + esc(d.name) + '</b> <span class="lv">Lv ' + d.level + '/' + d.max + '</span><small>' + effect + '</small></div>' +
        (d.maxed ? '<div class="maxed">Max</div>' : '<div class="ract"><button class="sbtn" data-act="doResearch" data-key="' + d.key + '"' + (chk.ok ? '' : ' disabled') + ' data-tip="' + esc(chk.ok ? 'Start research' : chk.reason) + '">' + costHtml(cost, st) + ' ' + ic('clock') + U.fmtTime(d.time) + '</button>' + (d.locked ? '<small class="bad">' + esc(d.locked) + '</small>' : '') + '</div>') + '</div>';
    }
    const list = CS.Research.list(st);
    return head('Research Lab', 'flask') + '<div class="mbody">' + top +
      '<h4>Troop training</h4>' + list.filter(function (d) { return d.kind === 'troop'; }).map(rowHtml).join('') +
      '<h4>Settlement technology</h4>' + list.filter(function (d) { return d.kind === 'tech'; }).map(rowHtml).join('') + '</div>';
  };

  // ----- world map
  let mapCanvas = null;
  const HOME_POS = [0.5, 0.93];
  const BIOME_COL = { meadow: [124, 186, 74], desert: [226, 192, 120], swamp: [108, 136, 70], snow: [228, 238, 246], volcanic: [104, 76, 66] };

  function drawMap() {
    const W = 600, H = 440, R = 3;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const lw = W / R, lh = H / R;
    const img = g.createImageData(lw, lh);
    const pts = C.settlements.map(function (s) { return { x: s.pos[0], y: s.pos[1], col: BIOME_COL[C.factions[s.faction].biome] }; });
    pts.push({ x: HOME_POS[0], y: HOME_POS[1], col: [142, 204, 92] });
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const fx = x / lw + Math.sin(y * 0.21) * 0.012 + Math.sin(x * 0.13 + y * 0.07) * 0.01;
        const fy = y / lh + Math.cos(x * 0.17) * 0.012;
        let best = null, bd = Infinity, second = Infinity;
        pts.forEach(function (p) {
          const d = (p.x - fx) * (p.x - fx) * 1.4 + (p.y - fy) * (p.y - fy);
          if (d < bd) { second = bd; bd = d; best = p; } else if (d < second) second = d;
        });
        const edge = Math.sqrt(second) - Math.sqrt(bd) < 0.012;
        const n = (Math.sin(x * 0.9) * Math.cos(y * 1.1) + Math.sin((x + y) * 0.37)) * 6;
        const i = (y * lw + x) * 4;
        const k = edge ? 0.82 : 1;
        img.data[i] = best.col[0] * k + n; img.data[i + 1] = best.col[1] * k + n; img.data[i + 2] = best.col[2] * k + n; img.data[i + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = lw; tmp.height = lh;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, 0, 0, W, H);
    // sea border and vignette
    const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(10,30,60,0.55)');
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    // roads: each settlement links to the closest one of the previous tier
    g.strokeStyle = 'rgba(92,62,30,0.75)'; g.lineWidth = 3; g.setLineDash([7, 6]);
    C.settlements.forEach(function (s) {
      let best = null, bd = Infinity;
      const prev = s.tier === 1 ? [{ pos: HOME_POS }] : C.settlements.filter(function (o) { return o.tier === s.tier - 1; });
      prev.forEach(function (o) { const d = U.dist(o.pos[0], o.pos[1], s.pos[0], s.pos[1]); if (d < bd) { bd = d; best = o; } });
      g.beginPath();
      g.moveTo(best.pos[0] * W, best.pos[1] * H);
      g.quadraticCurveTo((best.pos[0] + s.pos[0]) / 2 * W + 18, (best.pos[1] + s.pos[1]) / 2 * H, s.pos[0] * W, s.pos[1] * H);
      g.stroke();
    });
    g.setLineDash([]);
    // decorations per region
    const rng = new U.Rng(99);
    for (let i = 0; i < 140; i++) {
      const x = rng.next() * W, y = rng.next() * H;
      let best = null, bd = Infinity;
      pts.forEach(function (p) { const d = (p.x * W - x) * (p.x * W - x) + (p.y * H - y) * (p.y * H - y); if (d < bd) { bd = d; best = p; } });
      if (bd < 900) continue;
      const col = best.col;
      if (col === BIOME_COL.snow || col === BIOME_COL.volcanic) {
        g.fillStyle = col === BIOME_COL.snow ? '#b9c9d6' : '#3e2e29';
        g.beginPath(); g.moveTo(x - 9, y + 6); g.lineTo(x, y - 9); g.lineTo(x + 9, y + 6); g.fill();
        g.fillStyle = col === BIOME_COL.snow ? '#ffffff' : '#ff7a3c';
        g.beginPath(); g.moveTo(x - 3.5, y - 3); g.lineTo(x, y - 9); g.lineTo(x + 3.5, y - 3); g.fill();
      } else if (col === BIOME_COL.desert) {
        g.strokeStyle = 'rgba(160,120,60,0.6)'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x - 8, y); g.quadraticCurveTo(x, y - 5, x + 8, y); g.stroke();
      } else {
        g.fillStyle = col === BIOME_COL.swamp ? '#4c6a32' : '#3f8a3a';
        g.beginPath(); g.arc(x, y, 4 + rng.next() * 3, 0, Math.PI * 2); g.fill();
      }
    }
    return c;
  }

  function mountMap() {
    const host = document.querySelector('.wmap .wbg');
    if (!host) return;
    if (!mapCanvas) mapCanvas = drawMap();
    host.appendChild(mapCanvas);
  }

  MODALS.world = function () {
    const st = G.state, t = CS.Clock.now();
    const maxTier = NPC.unlockedTier(st);
    if (!UI.worldSel) {
      const open = C.settlements.filter(function (s) { return NPC.isUnlocked(st, s); });
      const fresh = open.find(function (s) { return !NPC.rec(st, s.id).wins; });
      UI.worldSel = (fresh || open[0]).id;
    }
    const nodes = C.settlements.map(function (s) {
      const rec = NPC.rec(st, s.id);
      const open = s.tier <= maxTier;
      const reb = rec.rebuildUntil > t;
      const fac = NPC.faction(s);
      return '<button class="node' + (open ? '' : ' locked') + (reb ? ' reb' : '') + (UI.worldSel === s.id ? ' sel' : '') + '" style="left:' + (s.pos[0] * 100) + '%;top:' + (s.pos[1] * 100) + '%;--fc:' + fac.color + '" data-act="node" data-id="' + s.id + '">' +
        '<span class="dot">' + (open ? s.tier : ICON.lock) + '</span><span class="nl">' + esc(s.name) + (rec.stars ? stars(rec.stars) : '') + '</span></button>';
    }).join('') + '<div class="node home" style="left:' + HOME_POS[0] * 100 + '%;top:' + HOME_POS[1] * 100 + '%"><span class="dot">' + ICON.home + '</span><span class="nl">Your base</span></div>';
    return head('World Map', 'sword') + '<div class="mbody world"><div class="wmap"><div class="wbg"></div>' + nodes + '</div>' + worldDetail(UI.worldSel) + '</div>';
  };

  function worldDetail(id) {
    const st = G.state, t = CS.Clock.now();
    const s = NPC.def(id);
    const rec = NPC.rec(st, id);
    const fac = NPC.faction(s);
    const chk = G.raidStatus(id);
    const open = NPC.isUnlocked(st, s);
    let body = '';
    if (!open) {
      body = '<div class="notice">' + ic('lock') + esc(chk.reason) + '.</div>';
    } else {
      const diff = NPC.difficulty(st, s);
      const loot = NPC.loot(st, s, t);
      const bonus = C.tiers[s.tier].bonus;
      const defs = NPC.defenseSummary(st, s);
      const defHtml = Object.keys(defs).map(function (type) {
        return '<span class="dchip" data-tip="' + esc(C.buildings[type].name) + ' (up to Lv ' + defs[type].maxLv + ')">' + thumb(type, defs[type].maxLv, fac.color, 48) + '<b>' + defs[type].n + '</b></span>';
      }).join('');
      const hostility = rec.hostility ? '<div class="hostile">' + ic('warn') + 'Hostility ' + '&#9679;'.repeat(rec.hostility) + '&#9675;'.repeat(3 - rec.hostility) + '. They may raid you in revenge.</div>' : '';
      body = '<div class="drow"><span class="diff ' + diff.cls + '">' + diff.label + '</span><span class="muted">for your current army</span></div>' +
        '<div class="loot"><span class="lbl">Available loot</span>' + costHtml(loot) + '<small>+' + U.fmt(bonus) + ' of each for a 3-star win</small></div>' +
        '<div class="defs"><span class="lbl">Defenses</span>' + (defHtml || '<i>none</i>') + '</div>' +
        '<div class="record">Record: <b>' + rec.wins + '</b> wins, <b>' + rec.losses + '</b> losses' + (rec.stars ? ' &middot; best ' + stars(rec.stars) : '') + (rec.fortify ? ' &middot; fortified x' + rec.fortify : '') + '</div>' + hostility;
      if (chk.rebuilding) body += '<div class="notice">' + ic('hammer') + 'Rebuilding after your raid. Opens again in ' + until(chk.rebuilding) + '.</div>';
    }
    const army = Army.totalUnits(st);
    let action;
    if (chk.ok) action = '<button class="mbtn attack" data-act="attack" data-id="' + id + '">' + ic('sword') + '<span>Attack with ' + army + ' troops</span></button>';
    else if (chk.noArmy && open) action = '<button class="mbtn" data-act="army">' + ic('army') + '<span>Train troops first</span></button>';
    else action = '<button class="mbtn" disabled>' + ic('sword') + '<span>' + (open ? esc(chk.reason) : 'Locked') + '</span></button>';
    return '<div class="wdetail" style="--fc:' + fac.color + '"><div class="wd-h"><span class="tier">Tier ' + s.tier + '</span><h3>' + esc(s.name) + '</h3>' +
      '<div class="muted">' + esc(fac.name) + ' &middot; led by ' + esc(s.leader) + '</div></div>' + body + action +
      '<p class="hint">Win ' + C.world.unlockWins + ' raids in a tier to reveal the next one. Defeated settlements rebuild stronger and richer.</p></div>';
  }

  // ----- log
  const LOG_ICON = { info: 'info', world: 'scroll', defense: 'shield', raid: 'skull', victory: 'star', defeat: 'warn' };
  MODALS.log = function () {
    const st = G.state;
    const rows = st.log.map(function (e) {
      return '<div class="lrow ' + e.kind + '">' + ic(LOG_ICON[e.kind] || 'info') + '<div><p>' + esc(e.text) + '</p><small>' + ago(e.t) + '</small></div></div>';
    }).join('') || '<p class="hint">Nothing has happened yet.</p>';
    const s = st.stats;
    return head('Event Log', 'scroll') + '<div class="mbody"><div class="statsline">Raids won <b>' + s.raidsWon + '</b> &middot; lost <b>' + s.raidsLost +
      '</b> &middot; defenses held <b>' + s.defended + '</b> &middot; times raided <b>' + s.raided + '</b> &middot; loot taken <b>' + U.fmt(s.lootCredits + s.lootEnergy) + '</b></div>' + rows + '</div>';
  };

  // ----- settings
  function toggle(key, label, sub) {
    const on = !!G.state.settings[key];
    return '<div class="srow"><div><b>' + label + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div><button class="switch' + (on ? ' on' : '') + '" data-act="setting" data-key="' + key + '" aria-pressed="' + on + '"><span></span></button></div>';
  }

  MODALS.settings = function () {
    const st = G.state;
    const modes = Object.keys(C.attacks.modes).map(function (k) {
      return '<button class="seg' + (st.settings.raidMode === k ? ' on' : '') + '" data-act="raidMode" data-v="' + k + '">' + C.attacks.modes[k].label + '</button>';
    }).join('');
    const saved = st.savedAt ? ago(st.savedAt) : 'never';
    const storage = CS.State.storageAvailable() ? 'Progress is saved in this browser (last save ' + saved + ').' : '<span class="bad">This browser is blocking local storage, so progress cannot be saved.</span>';
    return head('Settings', 'gear') + '<div class="mbody settings">' +
      toggle('sfx', 'Sound effects') + toggle('music', 'Music') +
      '<div class="srow"><div><b>Volume</b></div><input type="range" min="0" max="1" step="0.05" value="' + st.settings.volume + '" data-range="volume" aria-label="Volume"></div>' +
      toggle('showGrid', 'Always show the grid', 'The grid always appears while building or editing.') +
      '<div class="srow col"><div><b>NPC raids on your base</b><small>How often enemy settlements attack you. Shields, a protection period and loot caps always apply.</small></div><div class="segs">' + modes + '</div></div>' +
      '<div class="srow col"><div><b>Saving</b><small>' + storage + ' The game also saves automatically every ' + C.autosaveSec + ' seconds and whenever you leave the tab.</small></div>' +
      '<div class="row"><button class="sbtn" data-act="saveNow">Save now</button><button class="sbtn" data-act="help">' + ic('help') + 'Controls &amp; help</button><button class="sbtn danger" data-act="resetGame">Start a new game</button></div></div>' +
      '<p class="hint">Clash of CS runs entirely in your browser with no internet connection or accounts.</p></div>';
  };

  MODALS.help = function () {
    const keys = [['Drag / arrow keys / WASD', 'Move the camera'], ['Mouse wheel / pinch / + -', 'Zoom'], ['Click or tap a building', 'Inspect, collect, upgrade'], ['B', 'Build menu'], ['E', 'Edit mode (move buildings)'], ['R', 'Rotate while placing, otherwise Research'], ['T', 'Army and training'], ['M', 'World map'], ['L', 'Event log'], ['C', 'Collect all resources'], ['Esc', 'Close / cancel'], ['1-6', 'Pick a troop during a raid'], ['Tap or hold', 'Deploy troops during a raid'], ['Space', 'Deploy at the cursor (raid) or recenter'], ['F', 'Battle speed']];
    return head('Controls & Help', 'help') + '<div class="mbody help"><table class="keys">' + keys.map(function (k) { return '<tr><td><kbd>' + k[0] + '</kbd></td><td>' + k[1] + '</td></tr>'; }).join('') + '</table>' +
      '<h4>How to play</h4><ul><li>Generators fill up over time. Tap them to collect into your storages.</li><li>Each Engineer works on one construction at a time. Build more Engineering Stations for more Engineers.</li>' +
      '<li>Train troops at the Barracks, then raid settlements from the World Map. Destroy half the buildings or the Command Core to win.</li>' +
      '<li>Raiders attack your base after the protection period. Defenses fight automatically, destroyed buildings are rebuilt by your Engineering Stations, and a shield follows every raid.</li>' +
      '<li>While the game is closed, production (up to ' + C.offline.maxProductionHours + ' hours), training, construction and research continue. A few raids may happen too.</li></ul></div>';
  };

  // ----- confirm
  MODALS.confirm = function (o) {
    return head(esc(o.title || 'Are you sure?'), 'warn', true) + '<div class="mbody"><p>' + esc(o.text) + '</p><div class="row end"><button class="sbtn" data-act="confirmNo">' + esc(o.no || 'Cancel') + '</button><button class="sbtn ' + (o.danger ? 'danger' : 'primary') + '" data-act="confirmYes">' + esc(o.yes || 'Confirm') + '</button></div></div>';
  };

  UI.confirm = function (o, onYes) {
    UI._confirm = onYes;
    UI.open('confirm', o);
  };

  // ----- defense report
  function defenseHtml(rep, compact) {
    const pct = Math.round(rep.destruction * 100);
    const destroyed = {};
    rep.destroyed.forEach(function (t) { destroyed[t] = (destroyed[t] || 0) + 1; });
    const dlist = Object.keys(destroyed).map(function (t) { return C.buildings[t].name + (destroyed[t] > 1 ? ' x' + destroyed[t] : ''); }).join(', ');
    return '<div class="dreport ' + (rep.defended ? 'win' : 'lose') + '"><div class="dh">' + ic(rep.defended ? 'shield' : 'skull') + '<div><b>' + (rep.defended ? 'Raid repelled' : 'Base raided') + '</b> by ' + esc(rep.attacker) +
      (rep.raidKind === 'retaliation' ? ' <span class="tag">revenge</span>' : '') + '<small>' + esc(rep.faction) + (compact ? ' &middot; ' + ago(rep.at) : '') + '</small></div>' + stars(rep.stars) + '</div>' +
      '<div class="dgrid"><div><span>Damage</span><b>' + pct + '%</b></div><div><span>Raiders defeated</span><b>' + rep.killed + ' / ' + rep.raiders + '</b></div>' +
      '<div><span>Stolen</span><b>' + (rep.stolen.credits + rep.stolen.energy ? costHtml(rep.stolen) : 'nothing') + '</b></div><div><span>Renown</span><b class="' + (rep.renown > 0 ? 'good' : rep.renown < 0 ? 'bad' : '') + '">' + (rep.renown > 0 ? '+' : '') + rep.renown + '</b></div></div>' +
      (dlist ? '<small>Destroyed: ' + esc(dlist) + '</small>' : '') +
      (rep.top ? '<small>Top defender: ' + esc(C.buildings[rep.top.type].name) + ' (' + U.fmt(rep.top.dmg) + ' damage)</small>' : '') + '</div>';
  }

  MODALS.defense = function (rep) {
    const st = G.state;
    const cost = Eco.repairAllCost(st);
    const shield = Math.max(0, (st.threat.shieldUntil - CS.Clock.now()) / 1000);
    return head(rep.defended ? 'Your defenses held!' : 'Your base was raided', rep.defended ? 'shield' : 'warn', true) + '<div class="mbody">' + defenseHtml(rep) +
      (shield ? '<div class="notice">' + ic('shield') + '<div>A shield protects you from raids for ' + U.fmtTime(shield) + '.</div></div>' : '') +
      (cost ? '<div class="notice">' + ic('wrench') + '<div>Engineering Stations repair damage automatically' + (Eco.repairRate(st) ? ' (' + Eco.repairRate(st) + ' HP/s)' : '') + '. Repair everything now for ' + costHtml({ credits: cost }, st) + '?</div></div>' : '') +
      '<div class="row end">' + (cost ? '<button class="sbtn" data-act="defRepair">' + ic('wrench') + 'Repair now</button>' : '') + '<button class="mbtn primary" data-act="close"><span>Continue</span></button></div></div>';
  };

  UI.defenseReport = function (rep) {
    if (UI.modal === 'results') return;
    UI.open('defense', rep);
  };

  // ----- away report
  MODALS.away = function (rep) {
    const st = G.state;
    const parts = [];
    const prod = rep.produced.credits + rep.produced.energy;
    if (prod > 0) parts.push('<div class="arow">' + ic('sack') + '<div><b>Produced</b> ' + costHtml(rep.produced) + '<small>Waiting in your generators.' + (rep.capped ? ' Production while away is capped at ' + C.offline.maxProductionHours + ' hours.' : '') + '</small></div></div>');
    const done = rep.built.map(function (e) { return C.buildings[e.btype].name + ' built'; }).concat(rep.upgraded.map(function (e) { return C.buildings[e.btype].name + ' Lv ' + e.level; }));
    if (done.length) parts.push('<div class="arow">' + ic('hammer') + '<div><b>Construction finished</b><small>' + esc(done.join(', ')) + '</small></div></div>');
    const tr = Object.keys(rep.trained);
    if (tr.length) parts.push('<div class="arow">' + ic('army') + '<div><b>Troops trained</b><small>' + tr.map(function (t) { return rep.trained[t] + ' ' + C.troops[t].name + (rep.trained[t] > 1 ? 's' : ''); }).join(', ') + '</small></div></div>');
    if (rep.research.length) parts.push('<div class="arow">' + ic('flask') + '<div><b>Research complete</b><small>' + rep.research.map(function (e) { return esc(CS.Research.describe(st, e.key).name) + ' Lv ' + e.level; }).join(', ') + '</small></div></div>');
    if (rep.repaired) parts.push('<div class="arow">' + ic('wrench') + '<div><b>Rebuilt</b><small>' + rep.repaired + ' destroyed building' + (rep.repaired > 1 ? 's were' : ' was') + ' restored by your Engineers.</small></div></div>');
    const raids = rep.raids.map(function (r) { return defenseHtml(r, true); }).join('');
    const seen = {};
    rep.news.forEach(function (n) { seen[n] = (seen[n] || 0) + 1; });
    const lines = Object.keys(seen).slice(-6);
    const news = lines.length ? '<h4>World news</h4><ul class="news">' + lines.map(function (n) { return '<li>' + esc(n) + (seen[n] > 1 ? ' <b>(x' + seen[n] + ')</b>' : '') + '</li>'; }).join('') + '</ul>' : '';
    return head('Welcome back, Commander', 'home', true) + '<div class="mbody away"><p class="muted">You were away for <b>' + U.fmtTime(rep.seconds) + '</b>.</p>' + parts.join('') +
      (raids ? '<h4>Raids on your base</h4>' + raids : '') + news +
      '<div class="row end">' + (prod > 0 ? '<button class="sbtn" data-act="awayCollect">' + ic('sack') + 'Collect all</button>' : '') + '<button class="mbtn primary" data-act="close"><span>Continue</span></button></div></div>';
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
    confirmYes: function () { const f = UI._confirm; UI._confirm = null; UI.close(); if (f) f(); },
    confirmNo: function () { UI._confirm = null; UI.close(); },
    awayCollect: function () { G.collectAll(); UI.close(); },
    defRepair: function () { G.repairAll(); renderModal(); }
  });

  // ---------------------------------------------------------------- battle HUD
  function battleHudHtml() {
    return '<div class="bh-top" data-inset="t"><div class="bh-target"><b id="bhName"></b><small id="bhSub"></small><div class="bh-loot" id="bhLoot"></div></div>' +
      '<div class="bh-timer"><small id="bhPhase"></small><b id="bhTime"></b></div>' +
      '<div class="bh-score"><b id="bhPct">0%</b><span id="bhStars"></span></div></div>' +
      '<div class="bh-hint" id="bhHint"></div>' +
      '<div class="bh-bottom" data-inset="b"><div class="bh-troops" id="bhTroops"></div><div class="bh-ctrl">' +
      '<button class="cbtn" data-act="speed" id="bhSpeed" data-tip="Battle speed <kbd>F</kbd>">' + ICON.speed + '<b>1x</b></button>' +
      '<button class="mbtn danger" data-act="endBattle" id="bhEnd">' + ic('flag') + '<span>End battle</span></button></div></div>';
  }

  function defHudHtml() {
    return '<div class="dh-l">' + ic('warn') + '<div><b id="dhName"></b><small id="dhInfo"></small></div></div>' +
      '<button class="cbtn" data-act="speed" id="dhSpeed" aria-label="Battle speed" data-tip="Battle speed <kbd>F</kbd>">' + ICON.speed + '<b>1x</b></button>' +
      '<button class="sbtn" data-act="skipDefense" data-tip="Resolve the rest of the fight instantly">Skip</button>';
  }

  UI.refreshBattle = function () {
    const b = G.battle || G.lastBattle;
    if (!b || G.mode !== 'raid') return;
    const troops = C.troopOrder.filter(function (t) { return (b.meta.brought || {})[t] > 0; }).map(function (t, i) {
      const n = b.pool[t] || 0;
      return '<button class="tbtn' + (G.troopSel === t ? ' on' : '') + (n ? '' : ' empty') + '" data-act="troop" data-type="' + t + '" data-tip="' + esc(C.troops[t].name) + ' <kbd>' + (i + 1) + '</kbd>">' + troopImg(t, null, 56) + '<b>' + n + '</b><span class="lvl">' + (b.troopLv[t] || 1) + '</span></button>';
    }).join('');
    $('bhTroops').innerHTML = troops;
    $('bhSpeed').querySelector('b').textContent = G.speed + 'x';
    const endBtn = $('bhEnd');
    endBtn.querySelector('span').textContent = b.deployedAny ? 'End battle' : 'Return home';
    endBtn.className = 'mbtn ' + (b.deployedAny ? 'danger' : '');
    endBtn.querySelector('.ic').innerHTML = b.deployedAny ? ICON.flag : ICON.home;
    updateBattleHud();
  };

  function updateBattleHud() {
    const b = G.battle || G.lastBattle;
    if (!b) return;
    const Bt = CS.Battle;
    const pct = Math.floor(Bt.destruction(b) * 100);
    if (G.mode === 'raid') {
      const s = NPC.def(b.targetId);
      $('bhName').textContent = s.name;
      $('bhSub').textContent = 'Tier ' + s.tier + ' · ' + NPC.faction(s).name + ' · ' + (b.meta.difficulty || '');
      let lc = 0, le = 0;
      b.buildings.forEach(function (c) { if (c.lootLeft) { lc += c.lootLeft.credits; le += c.lootLeft.energy; } });
      $('bhLoot').innerHTML = '<span class="lbl">Loot taken</span><span class="cost">' + resIcon('credits') + U.fmt(b.loot.credits) + '<small>/ ' + U.fmt(lc + b.loot.credits) + '</small></span><span class="cost">' + resIcon('energy') + U.fmt(b.loot.energy) + '<small>/ ' + U.fmt(le + b.loot.energy) + '</small></span>';
      $('bhPhase').textContent = b.phase === 'scout' ? 'Scouting: deploy to start' : 'Battle ends in';
      $('bhTime').textContent = U.clockTime(Bt.timeLeft(b));
      $('bhPct').textContent = pct + '%';
      const st = (Bt.destruction(b) >= C.battle.winDestruction ? 1 : 0) + (b.coreDown ? 1 : 0) + (Bt.destruction(b) >= 1 ? 1 : 0);
      $('bhStars').innerHTML = stars(st);
      const left = Bt.poolTotal(b);
      $('bhHint').textContent = b.ended ? '' : b.phase === 'scout' ? 'Look around, pick a troop below, then tap outside the red zone. Hold to deploy a stream of troops.'
        : left ? 'Destroy 50% of the buildings or the Command Core to win.' : 'All troops deployed.';
    }
  }

  function defenseHudUpdate() {
    const el = $('defhud');
    const b = G.battle;
    if (G.mode !== 'defense' || !b) { el.classList.add('hidden'); return; }
    const s = NPC.def(b.attackerId);
    const alive = b.units.length + b.ai.length;
    el.classList.remove('hidden');
    $('dhName').textContent = 'Raid by ' + s.name;
    $('dhInfo').innerHTML = U.clockTime(CS.Battle.timeLeft(b)) + ' &middot; ' + Math.floor(CS.Battle.destruction(b) * 100) + '% damage &middot; ' + alive + ' raiders';
    $('dhSpeed').querySelector('b').textContent = G.speed + 'x';
  }

  // ----- raid results
  function troopSummary(map, cls) {
    return C.troopOrder.filter(function (t) { return map[t] > 0; }).map(function (t) {
      return '<div class="chipT ' + (cls || '') + '">' + troopImg(t, null, 40) + '<b>' + map[t] + '</b></div>';
    }).join('') || '<span class="muted">none</span>';
  }

  MODALS.results = function (r) {
    const res = r.res;
    const pct = Math.round(res.destruction * 100);
    const head0 = '<div class="banner ' + (res.victory ? 'win' : 'lose') + '"><h2>' + (res.victory ? 'Victory!' : 'Defeat') + '</h2>' + stars(res.stars) +
      '<div class="pct">' + pct + '% destroyed</div><div class="muted">' + esc(r.s.name) + ' &middot; ' + res.destroyed + ' of ' + res.total + ' buildings &middot; ' + U.fmtTime(res.seconds) + '</div></div>';
    const loot = '<div class="rbox"><h4>Loot</h4><div class="big">' + costHtml(r.gained) + '</div>' +
      (r.bonus ? '<small>Includes a victory bonus of ' + U.fmt(r.bonus) + ' each.</small>' : '') +
      (r.wasted > 0 ? '<small class="bad">' + U.fmt(r.wasted) + ' could not be stored. Your storages are full.</small>' : '') + '</div>';
    const troops = '<div class="rbox"><h4>Troops</h4><div class="trow"><span>Deployed</span>' + troopSummary(res.deployed) + '</div><div class="trow"><span>Lost</span>' + troopSummary(res.lost, 'lost') + '</div>' +
      '<small>Survivors return to your army.</small></div>';
    const ren = '<div class="renown ' + (r.renown > 0 ? 'up' : r.renown < 0 ? 'down' : '') + '">' + ic('renown') + (r.renown ? (r.renown > 0 ? '+' : '') + r.renown + ' renown' : 'Renown unchanged') + '</div>';
    const notes = r.notes.map(function (n) { return '<div class="note">' + ic('warn') + esc(n) + '</div>'; }).join('');
    const tips = r.tips.length ? '<div class="rbox tips"><h4>Why the raid failed</h4><ul>' + r.tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '';
    return '<div class="mbody results">' + head0 + '<div class="rgrid">' + loot + troops + '</div>' + ren + notes + tips +
      '<div class="row end"><button class="mbtn primary" data-act="home">' + ic('home') + '<span>Return home</span></button></div></div>';
  };

  UI.raidResults = function (r) {
    UI.open('results', r);
    UI.onClose = function () { if (G.mode === 'raid') G.goHome(); };
  };

  Object.assign(ACT, {
    troop: function (el) { G.selectTroop(el.dataset.type); },
    speed: function () { G.toggleSpeed(); defenseHudUpdate(); },
    endBattle: function () {
      const b = G.battle;
      if (!b) return;
      if (b.deployedAny) UI.confirm({ title: 'End the battle?', text: 'Your troops stop fighting and the result is counted now. Survivors come home.', yes: 'End battle', danger: true }, function () { G.endBattle(); });
      else G.endBattle();
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
    if (full && UI.modal && UI.modal !== 'confirm' && UI.modal !== 'results' && UI.modal !== 'away' && UI.modal !== 'defense') renderModal();
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
    });
    window.addEventListener('resize', measureInsets);
    initTooltips();
  };

  CS.UI = UI;
})(window.CS = window.CS || {});
