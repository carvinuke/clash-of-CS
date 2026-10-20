/*
 * The game's icon set, shared by the HTML interface and the canvas (bubbles above buildings).
 * One style throughout: 24px grid, a warm dark ink outline, flat fills, and a single highlight on
 * the upper left, the same direction the sun lights the world from. Plain glyphs (check, close,
 * arrows) use currentColor so they follow the button text.
 */
(function (CS) {
  'use strict';
  const INK = '#2b1e12';
  const o = ' stroke="' + INK + '" stroke-width="1.5" stroke-linejoin="round"';
  const hl = function (d, w) { return '<path d="' + d + '" fill="none" stroke="#fff6d8" stroke-opacity=".75" stroke-width="' + (w || 1.3) + '" stroke-linecap="round"/>'; };
  const svg = function (body) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>'; };
  const STAR = 'm12 2.3 2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z';
  const GEM = 'M12 2 18.6 8.6 12 22 5.4 8.6z';
  const SWORD = '<path d="M3.2 3.2 6.3 3l9.2 9.2-3.3 3.3L3 6.3z" fill="#dfe5ea"' + o + '/><path d="m12 17.9 5.9-5.9" stroke="' + INK + '" stroke-width="3.8" stroke-linecap="round"/>' +
    '<path d="m12 17.9 5.9-5.9" stroke="#c99a46" stroke-width="1.9" stroke-linecap="round"/><path d="m16.4 16.4 3 3" stroke="' + INK + '" stroke-width="3.2" stroke-linecap="round"/>' +
    '<path d="m16.4 16.4 3 3" stroke="#7a4f2b" stroke-width="1.5" stroke-linecap="round"/><circle cx="20.1" cy="20.1" r="1.7" fill="#c99a46"' + o + ' stroke-width="1.2"/>';

  const ICON = {
    credits: svg('<circle cx="12" cy="12" r="9.6" fill="#e3ad33"' + o + '/><circle cx="12" cy="12" r="6.8" fill="#f5cb4c" stroke="#b07c17" stroke-width="1.2"/>' +
      '<path d="M14.7 9.5a3.4 3.4 0 1 0 0 5" fill="none" stroke="#7d500b" stroke-width="2.1" stroke-linecap="round"/>' + hl('M6.5 9.4a6.3 6.3 0 0 1 3.9-3.8')),
    energy: svg('<path d="' + GEM + '" fill="#9a5cf2"/><path d="M12 2 5.4 8.6H12z" fill="#d2adff"/><path d="M12 2 18.6 8.6H12z" fill="#ab78ff"/>' +
      '<path d="M18.6 8.6H12V22z" fill="#6d36c6"/><path d="' + GEM + '" fill="none"' + o + '/><path d="M5.6 8.6h12.8M12 8.6V22" stroke="' + INK + '" stroke-width=".9" stroke-opacity=".55"/>' + hl('M8.2 7.2 10.6 4.6', 1.1)),
    renown: svg('<path d="M7 5H4.6a2.6 2.6 0 0 0 3 3.8M17 5h2.4a2.6 2.6 0 0 1-3 3.8" fill="none" stroke="' + INK + '" stroke-width="1.5"/><path d="M7 3.4h10v4.8a5 5 0 0 1-10 0z" fill="#ecba3c"' + o + '/>' +
      '<path d="M10.6 13.1h2.8l.7 3.9H9.9z" fill="#c98f22"' + o + '/><rect x="7.2" y="17" width="9.6" height="3.6" rx=".8" fill="#8a5a2b"' + o + '/>' + hl('M9.3 5.4v2.4')),
    hammer: svg('<g transform="rotate(42 12 12)"><rect x="10.8" y="8.5" width="2.6" height="13.5" rx="1.1" fill="#a8743f"' + o + '/><path d="M5.6 3.6h12.2v6H5.6z" fill="#8e98a4"' + o + '/>' +
      '<path d="M5.6 6.6h12.2" stroke="' + INK + '" stroke-width=".9" stroke-opacity=".5"/></g>' + hl('M8.4 5.6 11.3 2.9')),
    army: svg('<path d="M12.2 7.3c-.7-2.4.8-4.8 3.6-5.3-1 1.6-1.1 3.4-.3 5.2" fill="#3f86e8"' + o + '/><path d="M4.8 15.2a7.2 7.2 0 0 1 14.4 0v2H4.8z" fill="#8e98a4"' + o + '/>' +
      '<rect x="3" y="16.6" width="18" height="3" rx=".9" fill="#5f6874"' + o + '/><path d="M12 9.6v7" stroke="' + INK + '" stroke-width="1.4"/>' + hl('M7.4 13.2a5.2 5.2 0 0 1 2.9-3.4')),
    shield: svg('<path d="M12 2.4 4.6 5v6.2c0 4.7 3.1 8.7 7.4 10.4 4.3-1.7 7.4-5.7 7.4-10.4V5z" fill="#2f6fc8"/><path d="M12 2.4 4.6 5v6.2c0 4.7 3.1 8.7 7.4 10.4z" fill="#5a9cf0"/>' +
      '<path d="M12 2.4 4.6 5v6.2c0 4.7 3.1 8.7 7.4 10.4 4.3-1.7 7.4-5.7 7.4-10.4V5z" fill="none"' + o + '/><circle cx="12" cy="10.6" r="2.1" fill="#e3ad33"' + o + ' stroke-width="1.2"/>'),
    clock: svg('<path d="M7.3 5h9.4c0 3.9-3.3 5.1-3.3 7s3.3 3.1 3.3 7H7.3c0-3.9 3.3-5.1 3.3-7S7.3 8.9 7.3 5z" fill="#e4f0f4"' + o + ' stroke-width="1.3"/>' +
      '<path d="M9.3 17.7h5.4c-.6-1.6-1.8-2.3-2.7-3.8-.9 1.5-2.1 2.2-2.7 3.8zM9.2 7.3h5.6c-.5 1.2-1.6 1.9-2.8 2.9-1.2-1-2.3-1.7-2.8-2.9z" fill="#e3ad33"/>' +
      '<rect x="5.3" y="2.4" width="13.4" height="2.8" rx=".9" fill="#a8743f"' + o + '/><rect x="5.3" y="18.8" width="13.4" height="2.8" rx=".9" fill="#a8743f"' + o + '/>'),
    star: svg('<path d="' + STAR + '" fill="#f2c043"' + o + '/>' + hl('M11.6 5.9 10.1 9l-3.3.5')),
    starOff: svg('<path d="' + STAR + '" fill="rgba(0,0,0,.32)" stroke="rgba(243,236,220,.4)" stroke-width="1.4" stroke-linejoin="round"/>'),
    sword: svg('<g transform="matrix(-1 0 0 1 24 0)">' + SWORD + '</g>' + SWORD),
    flask: svg('<path d="M10.2 2.9v5.6L5.1 18.1A2.3 2.3 0 0 0 7.1 21.5h9.8a2.3 2.3 0 0 0 2-3.4l-5.1-9.6V2.9z" fill="#e4f0f4"/><path d="M7.5 14.1h9l2.1 4.1a1.6 1.6 0 0 1-1.4 2.3H6.8a1.6 1.6 0 0 1-1.4-2.3z" fill="#4fc58a"/>' +
      '<circle cx="10.4" cy="17.3" r="1" fill="#c6f3da"/><circle cx="13.6" cy="15.9" r=".7" fill="#c6f3da"/><path d="M10.2 2.9v5.6L5.1 18.1A2.3 2.3 0 0 0 7.1 21.5h9.8a2.3 2.3 0 0 0 2-3.4l-5.1-9.6V2.9M9 2.9h6" fill="none"' + o + '/>' + hl('M9.3 11.4 7.8 14.2')),
    scroll: svg('<path d="M6.4 5.2h11v13.2a2.8 2.8 0 0 1-2.8 2.8H6.4z" fill="#efdfb6"' + o + '/><path d="M9.2 9.4h5.6M9.2 12.4h5.6M9.2 15.4h3.8" stroke="#8a6a3a" stroke-width="1.3" stroke-linecap="round"/>' +
      '<rect x="4.4" y="2.6" width="15" height="3.6" rx="1.8" fill="#d9bf86"' + o + '/><path d="M3.6 18.4h9.2a2.8 2.8 0 0 0 2.8 2.8H6.4a2.8 2.8 0 0 1-2.8-2.8z" fill="#d9bf86"' + o + '/>'),
    gear: svg('<path d="M10.3 2h3.4l.5 2.6 2.2 1 2.2-1.5 2.4 2.4-1.5 2.2 1 2.2 2.5.4v3.4l-2.5.5-1 2.2 1.5 2.2-2.4 2.4-2.2-1.5-2.2 1-.5 2.5h-3.4l-.4-2.5-2.3-1-2.1 1.5-2.4-2.4 1.5-2.2-1-2.2L2 13.7v-3.4l2.5-.4 1-2.2L4 5.5l2.4-2.4 2.2 1.5 2.2-1z" fill="#98a2ad"' + o + ' stroke-width="1.3"/>' +
      '<circle cx="12" cy="12" r="3.4" fill="#3b444d"' + o + ' stroke-width="1.2"/>' + hl('M6.6 9.2a6 6 0 0 1 2.6-2.7')),
    sack: svg('<path d="M8.1 7.6h7.8c2.8 2.4 4.7 5.5 4.7 8.5 0 3.3-3.4 5.3-8.6 5.3s-8.6-2-8.6-5.3c0-3 1.9-6.1 4.7-8.5z" fill="#c9995a"' + o + '/>' +
      '<path d="M8.1 7.6c.9-1.2 1-2.5.4-3.7 1.2.4 2.3.6 3.5.6s2.3-.2 3.5-.6c-.6 1.2-.5 2.5.4 3.7z" fill="#a97b42"' + o + '/><circle cx="12" cy="14.9" r="3.1" fill="#f2c043"' + o + ' stroke-width="1.2"/>' + hl('M6.5 13.6c.3-1.7 1.2-3.2 2.4-4.4')),
    wrench: svg('<path d="M14.6 3.3a5 5 0 0 0-6 6.3L3.1 15.1a1.9 1.9 0 0 0 0 2.7l.1.1a1.9 1.9 0 0 0 2.7 0l5.5-5.5a5 5 0 0 0 6.3-6l-3 3-2.6-.6-.6-2.6z" fill="#a9b3bd"' + o + '/>' + hl('M9.8 6.6a3.6 3.6 0 0 1 1.9-2.1')),
    up: svg('<path d="M12 2.8 4.4 11h4.7v9.8h5.8V11h4.7z" fill="#62c062"' + o + '/>' + hl('M8.4 9.8 12 6')),
    lock: svg('<path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8" fill="none" stroke="' + INK + '" stroke-width="3.4"/><path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8" fill="none" stroke="#98a2ad" stroke-width="1.6"/>' +
      '<rect x="5" y="10.2" width="14" height="11" rx="1.6" fill="#c99a46"' + o + '/><path d="M12 14.2v3" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>'),
    skull: svg('<path d="M12 2.6a8 8 0 0 0-8 8c0 3 1.5 4.7 3 5.8v3.4h10v-3.4c1.5-1.1 3-2.8 3-5.8a8 8 0 0 0-8-8z" fill="#ece3d1"' + o + '/>' +
      '<circle cx="8.9" cy="11" r="2" fill="' + INK + '"/><circle cx="15.1" cy="11" r="2" fill="' + INK + '"/><path d="M10 19.8v-2.2M14 19.8v-2.2" stroke="' + INK + '" stroke-width="1.4"/>'),
    core: svg('<path d="M6.6 21V10.4L12 6.6l5.4 3.8V21z" fill="#c4b9a5"' + o + '/><path d="M4.8 11.4 12 5.8l7.2 5.6" fill="none" stroke="' + INK + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M10.2 21v-3.4a1.8 1.8 0 0 1 3.6 0V21" fill="#5a3a22"' + o + ' stroke-width="1.1"/><path d="M12 .8l1.7 2.4L12 5.5l-1.7-2.3z" fill="#79b6ff"' + o + ' stroke-width="1"/>'),
    info: svg('<circle cx="12" cy="12" r="9.6" fill="#3f86e8"' + o + '/><path d="M12 10.4v6.6" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="6.9" r="1.6" fill="#fff"/>'),
    warn: svg('<path d="M12 2.6 1.9 20.6h20.2z" fill="#f2b13a"' + o + '/><path d="M12 9.2v5.2" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.4" fill="' + INK + '"/>'),
    help: svg('<circle cx="12" cy="12" r="9.6" fill="#3f86e8"' + o + '/><path d="M9.3 9.3a2.8 2.8 0 1 1 3.8 2.6c-.8.4-1.1 1-1.1 1.8v.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.4" fill="#fff"/>'),
    bolt: svg('<path d="M13.6 1.8 4.6 13.3h6.2l-1.3 8.9 9.9-12.4h-6.3z" fill="#f2c043"' + o + '/>'),
    // plain glyphs that take the button's text color
    move: svg('<path d="M12 2.5v19M2.5 12h19M12 2.5 9.2 5.3M12 2.5l2.8 2.8M12 21.5l-2.8-2.8M12 21.5l2.8-2.8M2.5 12l2.8-2.8M2.5 12l2.8 2.8M21.5 12l-2.8-2.8M21.5 12l-2.8 2.8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>'),
    rotate: svg('<path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4M19.6 3.4v4.8h-4.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
    check: svg('<path d="m4.5 12.5 4.6 4.6L19.5 6.7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
    speed: svg('<path d="M3.5 5.5v13l7.6-6.5zM12.4 5.5v13l7.6-6.5z" fill="currentColor"/>'),
    flag: svg('<path d="M5.5 21.5v-18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M5.5 4.2h12.6l-2.9 4 2.9 4H5.5" fill="currentColor"/>'),
    home: svg('<path d="M3.4 11.2 12 3.6l8.6 7.6M5.6 9.4v11.2h4.6v-6h3.6v6h4.6V9.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>'),
    chevron: svg('<path d="m9 5.5 6.5 6.5L9 18.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')
  };

  // Faction crests: a heater shield in the faction color with a simple emblem.
  const EMBLEM = {
    thorn: '<path d="M12 6.4c3 2 3.5 6 0 9.6-3.5-3.6-3-7.6 0-9.6zM12 8.6v7.2" fill="#f3ecdc" stroke="' + INK + '" stroke-width="1"/>',
    dune: '<circle cx="12" cy="11" r="2.6" fill="#f3ecdc" stroke="' + INK + '" stroke-width="1"/><path d="M12 5.6v1.6M12 14.8v1.6M6.6 11h1.6M15.8 11h1.6M8.2 7.2l1.1 1.1M14.7 12.7l1.1 1.1M8.2 14.8l1.1-1.1M14.7 9.3l1.1-1.1" stroke="#f3ecdc" stroke-width="1.4" stroke-linecap="round"/>',
    mire: '<path d="M14.2 6.6a4.8 4.8 0 1 0 0 8.8 3.8 3.8 0 1 1 0-8.8z" fill="#f3ecdc" stroke="' + INK + '" stroke-width="1"/>',
    frost: '<path d="M12 5.8v10.4M7.5 8.4l9 5.2M7.5 13.6l9-5.2M10.6 6.6 12 8l1.4-1.4M10.6 15.4 12 14l1.4 1.4" fill="none" stroke="#f3ecdc" stroke-width="1.5" stroke-linecap="round"/>',
    cinder: '<path d="M12 5.6c2.6 2.6 3.6 4.8 2.6 7.4a3 3 0 0 1-5.2 0c-.6-1.4 0-2.7 1-3.7.2 1.2.8 1.8 1.6 2 .3-2-.7-3.7 0-5.7z" fill="#f3ecdc" stroke="' + INK + '" stroke-width="1"/>'
  };
  function crest(factionId, color) {
    return svg('<path d="M12 2.4 4.4 5v6.4c0 4.7 3.2 8.6 7.6 10.2 4.4-1.6 7.6-5.5 7.6-10.2V5z" fill="' + color + '"/>' +
      '<path d="M12 2.4 4.4 5v6.4c0 4.7 3.2 8.6 7.6 10.2z" fill="#fff" fill-opacity=".18"/>' + (EMBLEM[factionId] || '') +
      '<path d="M12 2.4 4.4 5v6.4c0 4.7 3.2 8.6 7.6 10.2 4.4-1.6 7.6-5.5 7.6-10.2V5z" fill="none"' + o + '/>');
  }

  // Canvas copies of the colored icons, rasterized once at a given pixel size.
  const images = {};
  function image(name, px) {
    const key = name + '|' + px;
    let im = images[key];
    if (!im) {
      im = images[key] = new Image(px, px);
      im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ICON[name].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + px + '" height="' + px + '" '));
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  CS.Icons = { ICON: ICON, crest: crest, image: image, INK: INK };
})(window.CS = window.CS || {});
