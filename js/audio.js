/*
 * Sound: every effect and both music themes are synthesized with the Web Audio API, so the game
 * needs no audio files. The audio context starts on the first click or key press, as browsers
 * require. Repeated battle sounds are rate-limited so big fights stay pleasant.
 */
(function (CS) {
  'use strict';
  const A = { ctx: null, settings: { sfx: true, music: true, volume: 0.7 }, theme: null };
  let master = null, sfxBus = null, musicBus = null, noiseBuf = null;
  const last = {};
  const GAP = { hit: 70, blaster: 90, spire: 70, bow: 60, orb: 80, death: 60, frost: 350, heal: 260, deploy: 45, coins: 110, energy: 110, boom: 90, destroy: 120, wallBreak: 90, mortar: 150, mortarHit: 120, mine: 120, trainDone: 400, click: 40, flame: 160, zap: 120, thunder: 200 };

  A.init = function (settings) { A.settings = settings; };

  A.unlock = function () {
    if (A.ctx) {
      if (A.ctx.state === 'suspended' && !document.hidden) A.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { A.ctx = new AC(); } catch (e) { return; }
    const ctx = A.ctx;
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp);
    comp.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    A.applySettings(A.settings);
    A.nextTime = ctx.currentTime + 0.1;
    setInterval(schedule, 100);
  };

  A.applySettings = function (s) {
    A.settings = s || A.settings;
    if (!A.ctx) return;
    const t = A.ctx.currentTime;
    master.gain.setTargetAtTime(A.settings.volume, t, 0.05);
    sfxBus.gain.setTargetAtTime(A.settings.sfx ? 1 : 0, t, 0.02);
    musicBus.gain.setTargetAtTime(A.settings.music ? 0.32 : 0, t, 0.3);
  };

  A.suspend = function () { if (A.ctx && A.ctx.state === 'running') A.ctx.suspend(); };
  A.resume = function () {
    if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume();
    if (A.ctx) A.nextTime = Math.max(A.nextTime, A.ctx.currentTime + 0.05);
  };

  // ---------------------------------------------------------------- synthesis primitives
  function env(g, t, vol, att, dec) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + att + dec);
  }

  function tone(o) {
    const ctx = A.ctx, t = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.att || 0.005) + o.dur);
    env(g, t, o.vol || 0.2, o.att || 0.005, o.dur);
    let node = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.lp;
      osc.connect(f); node = f;
    }
    node.connect(g);
    g.connect(o.bus || sfxBus);
    osc.start(t);
    osc.stop(t + (o.att || 0.005) + o.dur + 0.05);
  }

  function noise(o) {
    const ctx = A.ctx, t = ctx.currentTime + (o.delay || 0);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;
    f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(o.f || 1200, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    f.Q.value = o.q || 0.7;
    env(g, t, o.vol || 0.2, o.att || 0.004, o.dur);
    src.connect(f); f.connect(g); g.connect(o.bus || sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.dur + 0.1);
  }

  function chord(notes, o) {
    notes.forEach(function (n, i) { tone(Object.assign({}, o, { f: mtof(n), delay: (o.delay || 0) + i * (o.spread || 0) })); });
  }

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // ---------------------------------------------------------------- effects
  const FX = {
    click: function () { tone({ f: 820, f2: 600, dur: 0.05, type: 'triangle', vol: 0.12 }); },
    open: function () { tone({ f: 520, f2: 780, dur: 0.08, type: 'triangle', vol: 0.1 }); },
    error: function () { tone({ f: 180, dur: 0.16, type: 'square', vol: 0.08, lp: 900 }); tone({ f: 140, dur: 0.16, type: 'square', vol: 0.06, lp: 900, delay: 0.09 }); },
    place: function () { noise({ f: 500, f2: 120, dur: 0.18, vol: 0.4 }); tone({ f: 120, f2: 60, dur: 0.15, vol: 0.3 }); },
    build: function () {
      for (let i = 0; i < 3; i++) { noise({ f: 2400, f2: 900, dur: 0.06, vol: 0.25, filter: 'bandpass', q: 2, delay: i * 0.13 }); tone({ f: 300, f2: 180, dur: 0.05, type: 'triangle', vol: 0.15, delay: i * 0.13 }); }
    },
    complete: function () { chord([72, 76, 79, 84], { dur: 0.25, type: 'triangle', vol: 0.11, spread: 0.07 }); },
    train: function () { tone({ f: 220, f2: 330, dur: 0.1, type: 'square', vol: 0.06, lp: 1400 }); noise({ f: 900, dur: 0.05, vol: 0.12 }); },
    trainDone: function () { tone({ f: 660, dur: 0.07, type: 'triangle', vol: 0.06 }); },
    coins: function () { tone({ f: 1320, dur: 0.08, type: 'triangle', vol: 0.12 }); tone({ f: 1760, dur: 0.14, type: 'triangle', vol: 0.12, delay: 0.06 }); tone({ f: 2093, dur: 0.12, type: 'sine', vol: 0.06, delay: 0.12 }); },
    energy: function () { tone({ f: 300, f2: 1400, dur: 0.22, type: 'sawtooth', vol: 0.06, lp: 2200 }); tone({ f: 900, f2: 1800, dur: 0.18, type: 'sine', vol: 0.06, delay: 0.05 }); },
    levelup: function () { chord([67, 72, 76, 79, 84], { dur: 0.35, type: 'triangle', vol: 0.12, spread: 0.09 }); },
    horn: function () { tone({ f: 196, dur: 0.6, type: 'sawtooth', vol: 0.09, att: 0.08, lp: 1100 }); tone({ f: 294, dur: 0.7, type: 'sawtooth', vol: 0.08, att: 0.08, lp: 1100, delay: 0.32 }); },
    deploy: function () { noise({ f: 1800, f2: 400, dur: 0.12, vol: 0.12, filter: 'bandpass', q: 1.5 }); tone({ f: 480, f2: 260, dur: 0.06, type: 'triangle', vol: 0.06 }); },
    destroy: function () { noise({ f: 1800, f2: 80, dur: 0.9, vol: 0.55 }); tone({ f: 90, f2: 35, dur: 0.6, vol: 0.4 }); },
    wallBreak: function () { noise({ f: 2600, f2: 300, dur: 0.3, vol: 0.32, filter: 'bandpass', q: 0.8 }); },
    death: function () { tone({ f: 420, f2: 160, dur: 0.16, type: 'triangle', vol: 0.08 }); },
    hit: function () { noise({ f: 3000, f2: 1200, dur: 0.05, vol: 0.12, filter: 'bandpass', q: 2 }); },
    bow: function () { tone({ f: 900, f2: 300, dur: 0.07, type: 'triangle', vol: 0.06 }); },
    orb: function () { tone({ f: 500, f2: 1600, dur: 0.18, type: 'sine', vol: 0.08 }); },
    blaster: function () { noise({ f: 1400, f2: 120, dur: 0.22, vol: 0.4 }); tone({ f: 110, f2: 50, dur: 0.16, vol: 0.3 }); },
    spire: function () { tone({ f: 1200, f2: 500, dur: 0.06, type: 'square', vol: 0.04, lp: 2600 }); noise({ f: 4000, dur: 0.03, vol: 0.06, filter: 'highpass' }); },
    mortar: function () { tone({ f: 80, f2: 40, dur: 0.35, vol: 0.45 }); noise({ f: 600, f2: 100, dur: 0.3, vol: 0.3 }); },
    mortarHit: function () { noise({ f: 1200, f2: 60, dur: 0.7, vol: 0.5 }); tone({ f: 70, f2: 30, dur: 0.5, vol: 0.4 }); },
    boom: function () { noise({ f: 1600, f2: 70, dur: 0.6, vol: 0.5 }); tone({ f: 100, f2: 40, dur: 0.4, vol: 0.35 }); },
    mine: function () { tone({ f: 1500, dur: 0.05, type: 'square', vol: 0.06, lp: 3000 }); tone({ f: 1500, dur: 0.05, type: 'square', vol: 0.06, lp: 3000, delay: 0.12 }); },
    frost: function () { tone({ f: 2400, f2: 1600, dur: 0.4, type: 'sine', vol: 0.04 }); noise({ f: 6000, dur: 0.3, vol: 0.05, filter: 'highpass' }); },
    flame: function () { noise({ f: 900, f2: 300, dur: 0.35, vol: 0.18, filter: 'bandpass', q: 0.7 }); },
    zap: function () { tone({ f: 1800, f2: 400, dur: 0.12, type: 'sawtooth', vol: 0.05, lp: 4000 }); noise({ f: 5000, dur: 0.08, vol: 0.08, filter: 'highpass' }); },
    thunder: function () { noise({ f: 4000, f2: 90, dur: 0.9, vol: 0.5 }); tone({ f: 70, f2: 30, dur: 0.7, vol: 0.4 }); },
    heal: function () { chord([84, 88], { dur: 0.2, type: 'sine', vol: 0.05, spread: 0.05 }); },
    warning: function () { for (let i = 0; i < 3; i++) { tone({ f: 880, dur: 0.12, type: 'square', vol: 0.06, lp: 2000, delay: i * 0.3 }); tone({ f: 660, dur: 0.12, type: 'square', vol: 0.06, lp: 2000, delay: i * 0.3 + 0.15 }); } },
    siren: function () { for (let i = 0; i < 2; i++) tone({ f: 500, f2: 900, dur: 0.5, type: 'sawtooth', vol: 0.07, lp: 1800, delay: i * 0.55 }); FX.horn(); },
    victory: function () { chord([60, 64, 67], { dur: 0.25, type: 'triangle', vol: 0.12, spread: 0.12 }); chord([72, 76, 79, 84], { dur: 0.7, type: 'triangle', vol: 0.11, delay: 0.4, spread: 0.02 }); },
    defeat: function () { chord([64, 60, 57, 52], { dur: 0.45, type: 'triangle', vol: 0.11, spread: 0.28 }); }
  };

  A.play = function (name) {
    if (!A.ctx || !A.settings.sfx || A.ctx.state !== 'running' || !FX[name]) return;
    const t = performance.now();
    if (GAP[name] && last[name] && t - last[name] < GAP[name]) return;
    last[name] = t;
    try { FX[name](); } catch (e) { /* a dropped sound effect is harmless */ }
  };

  // ---------------------------------------------------------------- music
  // Each theme is a four-bar loop: chords (MIDI notes) plus a short melody per bar.
  const THEMES = {
    village: {
      bpm: 88,
      chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]],
      melody: [[76, null, 79, null, 81, null, 79, 76], [72, null, 76, null, 79, null, 76, null], [72, null, 69, null, 72, 74, 76, null], [74, null, 71, null, 67, null, null, null]]
    },
    battle: {
      bpm: 126,
      chords: [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 56, 59]],
      melody: [[69, 72, 76, 72, 69, null, 76, 74], [72, 69, 65, 69, 72, null, 77, 76], [74, 71, 67, 71, 74, null, 79, 77], [76, null, 75, null, 71, null, 68, null]]
    }
  };

  function voice(f, t, dur, type, vol, lp) {
    const ctx = A.ctx;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (lp) {
      const fl = ctx.createBiquadFilter();
      fl.type = 'lowpass'; fl.frequency.value = lp;
      osc.connect(fl); fl.connect(g);
    } else osc.connect(g);
    g.connect(musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function drum(t, kind) {
    const ctx = A.ctx;
    if (kind === 'kick') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.setValueAtTime(130, t);
      osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(g); g.connect(musicBus);
      osc.start(t); osc.stop(t + 0.25);
      return;
    }
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = kind === 'hat' ? 'highpass' : 'bandpass';
    f.frequency.value = kind === 'hat' ? 7000 : 1800;
    const vol = kind === 'hat' ? 0.06 : 0.22, dur = kind === 'hat' ? 0.04 : 0.14;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(musicBus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  function schedule() {
    const ctx = A.ctx;
    if (!ctx || !A.theme || ctx.state !== 'running' || !A.settings.music) return;
    const T = THEMES[A.theme];
    const six = 60 / T.bpm / 4;
    if (A.nextTime < ctx.currentTime) A.nextTime = ctx.currentTime + 0.05;
    while (A.nextTime < ctx.currentTime + 0.4) {
      const s = A.step || 0, t = A.nextTime;
      const barI = Math.floor(s / 16) % 4, pos = s % 16;
      const ch = T.chords[barI];
      if (A.theme === 'village') {
        if (pos === 0) ch.forEach(function (n) { voice(mtof(n), t, six * 15, 'triangle', 0.05, 1200); });
        if (pos % 8 === 0) voice(mtof(ch[0] - 24), t, six * 7, 'sine', 0.16);
        if (pos % 2 === 0) {
          const m = T.melody[barI][pos / 2];
          if (m) voice(mtof(m), t, six * 3, 'triangle', 0.07, 2600);
          else voice(mtof(ch[(pos / 2) % 3] + 12), t, six * 1.6, 'sine', 0.035);
        }
      } else {
        if (pos % 4 === 0) drum(t, 'kick');
        if (pos % 8 === 4) drum(t, 'snare');
        if (pos % 2 === 0) drum(t, 'hat');
        if (pos % 2 === 0) voice(mtof(ch[0] - 24 + (pos % 4 === 2 ? 12 : 0)), t, six * 1.7, 'sawtooth', 0.07, 600);
        if (pos % 2 === 0) { const m = T.melody[barI][pos / 2]; if (m) voice(mtof(m), t, six * 1.8, 'square', 0.03, 1800); }
        if (pos === 0) ch.forEach(function (n) { voice(mtof(n), t, six * 6, 'sawtooth', 0.025, 900); });
      }
      A.nextTime += six;
      A.step = s + 1;
    }
  }

  // name: 'village' | 'battle' | null (silence)
  A.music = function (name) {
    if (A.theme === name) return;
    A.theme = name;
    A.step = 0;
    if (A.ctx) A.nextTime = A.ctx.currentTime + 0.15;
  };

  CS.Audio = A;
})(window.CS = window.CS || {});
