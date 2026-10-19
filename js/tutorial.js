/*
 * First-time tutorial: a short coach card that walks a new player through collecting,
 * building, training and a first raid. Steps advance on game events, can be skipped at any
 * time, and the position is saved with the game.
 */
(function (CS) {
  'use strict';
  const Tut = {};
  let G = null;

  const STEPS = [
    { text: 'Welcome, Commander! This is your settlement. Drag to look around, and scroll or pinch to zoom.', next: true },
    { text: 'Your Credit Mint and Energy Well have been busy. Tap one of them, or press Collect, to gather what they made.', target: '[data-act="collect"]', on: 'collected' },
    {
      text: 'Raiders will come once your protection runs out. Open Build, pick a Blaster Turret from the Defense tab and place it near your Command Core.',
      target: '[data-act="build"]', on: 'build:placed', when: function (d) { return d.type === 'blaster'; },
      skip: function (st) { return st.base.buildings.some(function (b) { return b.type === 'blaster'; }); }
    },
    { text: 'Construction takes time and each Engineer handles one job. Meanwhile, open Army and train a few more troops.', target: '[data-act="army"]', on: 'train:queued' },
    { text: 'Ready to fight? Open the World Map and attack Mossy Hollow, a lightly defended camp nearby.', target: '[data-act="world"]', on: 'raid:start' },
    { text: 'Pick a troop at the bottom and tap the ground outside the red zone. Hold to send a stream. Destroy half the buildings or the Command Core to win.', mode: 'raid', target: '.bh-troops', on: 'raid:deploy' },
    { text: 'Loot goes to your storages and surviving troops come home. Upgrade the Command Core to unlock more buildings and land. Good luck, Commander!', next: true, last: true }
  ];

  function st() { return G.state.tutorial; }

  function render() {
    const el = document.getElementById('coach');
    const t = st();
    document.querySelectorAll('.pulse').forEach(function (n) { n.classList.remove('pulse'); });
    if (!G || G.paused || t.done || t.step >= STEPS.length) { el.classList.add('hidden'); return; }
    const s = STEPS[t.step];
    const mode = s.mode || 'village';
    const hidden = G.mode !== mode || (CS.UI.modal && CS.UI.modal !== 'world' && CS.UI.modal !== 'build' && CS.UI.modal !== 'army');
    if (hidden) { el.classList.add('hidden'); return; }
    const key = t.step + ':' + G.mode;
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.innerHTML = '<div class="ch-step">Tutorial ' + (t.step + 1) + '/' + STEPS.length + '</div><p>' + s.text + '</p><div class="row">' +
        (s.next ? '<button class="sbtn primary" data-act="tutNext">' + (s.last ? 'Finish' : 'Next') + '</button>' : '') +
        (s.last ? '' : '<button class="sbtn ghost" data-act="tutSkip">Skip tutorial</button>') + '</div>';
    }
    el.classList.remove('hidden');
    if (s.target && !CS.UI.modal) {
      const n = document.querySelector(s.target);
      if (n) n.classList.add('pulse');
    }
  }

  function advance() {
    const t = st();
    t.step++;
    if (t.step >= STEPS.length) t.done = true;
    render();
  }

  Tut.init = function (game) {
    G = game;
    ['collected', 'build:placed', 'train:queued', 'raid:start', 'raid:deploy'].forEach(function (name) {
      CS.Bus.on(name, function (d) {
        const t = st();
        if (t.done) return;
        const s = STEPS[t.step];
        if (s && s.on === name && (!s.when || s.when(d || {}))) advance();
      });
    });
  };

  Tut.start = function () { render(); };

  Tut.update = function () {
    if (!G || !G.state) return;
    const t = st();
    if (!t.done) {
      const s = STEPS[t.step];
      if (s && s.skip && s.skip(G.state)) { advance(); return; }
    }
    render();
  };

  Tut.next = function () { CS.Audio.play('click'); advance(); };

  Tut.skip = function () {
    st().done = true;
    CS.Audio.play('click');
    render();
    CS.UI.toast('Tutorial skipped. Press H any time for controls and tips.', 'info');
  };

  Tut.restart = function () {
    G.state.tutorial = { step: 0, done: false };
    document.getElementById('coach').dataset.key = '';
    render();
  };

  CS.Tutorial = Tut;
})(window.CS = window.CS || {});
