/*
 * Grid A* used by troops. Costs are measured in seconds: walking a tile costs 1/speed and a tile
 * holding a wall or building costs the time needed to break it. Troops therefore walk around
 * walls when that is quicker and smash through them when it is not, and can never be sealed out.
 */
(function (CS) {
  'use strict';
  const PF = {};

  let gen = 0, size = 0;
  let gScore, visited, closed, came;

  function ensure(n) {
    if (n === size) return;
    size = n;
    gScore = new Float64Array(n);
    visited = new Uint32Array(n);
    closed = new Uint32Array(n);
    came = new Int32Array(n);
  }

  // Binary min-heap of [f, node] pairs (lazy deletion of stale entries).
  function Heap() { this.f = []; this.n = []; }
  Heap.prototype.push = function (f, node) {
    const F = this.f, N = this.n;
    let i = F.length;
    F.push(f); N.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p]; N[i] = N[p];
      i = p;
    }
    F[i] = f; N[i] = node;
  };
  Heap.prototype.pop = function () {
    const F = this.f, N = this.n;
    const top = N[0];
    const lf = F.pop(), ln = N.pop();
    const len = F.length;
    if (len) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mf = lf;
        if (l < len && F[l] < mf) { m = l; mf = F[l]; }
        if (r < len && F[r] < mf) { m = r; mf = F[r]; }
        if (m === i) break;
        F[i] = F[m]; N[i] = N[m];
        i = m;
      }
      F[i] = lf; N[i] = ln;
    }
    return top;
  };
  Heap.prototype.size = function () { return this.f.length; };

  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const SQRT2 = Math.SQRT2;

  /*
   * opts: {
   *   w, h, start (tile index),
   *   step: seconds per tile,
   *   tileCost(idx) -> extra seconds to enter (0 free, Infinity impassable),
   *   isGoal(idx) -> bool, heuristic(idx) -> seconds (admissible),
   *   maxNodes (optional)
   * }
   * Returns the list of tile indices after the start up to and including the goal, or null.
   */
  PF.search = function (o) {
    const W = o.w, H = o.h, n = W * H;
    ensure(n);
    gen++;
    if (gen > 4e9) { gen = 1; visited.fill(0); closed.fill(0); }
    const heap = new Heap();
    const maxNodes = o.maxNodes || n * 2;
    const start = o.start;
    gScore[start] = 0; visited[start] = gen; came[start] = -1;
    heap.push(o.heuristic(start), start);
    let expanded = 0;
    const freeCache = new Int8Array(n);    // 0 unknown, 1 free, 2 obstacle (for corner cutting)
    function isFree(i) {
      let v = freeCache[i];
      if (!v) { v = o.tileCost(i) === 0 ? 1 : 2; freeCache[i] = v; }
      return v === 1;
    }
    while (heap.size()) {
      const cur = heap.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (o.isGoal(cur)) {
        const path = [];
        let c = cur;
        while (c !== start && c >= 0) { path.push(c); c = came[c]; }
        path.reverse();
        return path;
      }
      if (++expanded > maxNodes) return null;
      const cx = cur % W, cy = (cur / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (closed[ni] === gen) continue;
        const diag = d >= 4;
        // No cutting corners past obstacles when moving diagonally.
        if (diag && (!isFree(cy * W + nx) || !isFree(ny * W + cx))) continue;
        const extra = o.tileCost(ni);
        if (extra === Infinity) continue;
        const g = gScore[cur] + (diag ? o.step * SQRT2 : o.step) + extra;
        if (visited[ni] !== gen || g < gScore[ni]) {
          visited[ni] = gen;
          gScore[ni] = g;
          came[ni] = cur;
          heap.push(g + o.heuristic(ni), ni);
        }
      }
    }
    return null;
  };

  CS.Path = PF;
})(window.CS = window.CS || {});
