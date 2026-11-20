'use strict';

/**
 * 视频角色定位的核心算法（纯函数，无 DOM，可在 Node 里单测）。
 *
 * 问题：同一片地形，在「视频里博主的小地图」和「你游戏里的小地图」上各出现一次。
 * 两张小地图都**固定北朝上**，所以它们之间只差「缩放 + 平移」。平移就是「博主相对你站在哪」。
 *
 * 流程（每次更新）：
 *   1. 两张图都取梯度幅值：只看地形轮廓，不看颜色亮度（视频压缩、HDR、昼夜都会改颜色）；
 *      中心 0.3R 以内是各自的玩家箭头 / 视锥，挖掉；鲜艳的图标（任务标记、队友、锚点）也挖掉。
 *   2. **带遮罩的归一化互相关**（Padfield 2012，FFT 实现）：对每一个平移量，
 *      只在两边都有效的像素上算 NCC（-1~1）。窗口边缘、图标留下的空洞都不参与，
 *      所以不会出现「两张图的圆形窗口自己和自己对齐」→ 点被吸到正中心的假匹配。
 *   3. 缩放由粗到细搜：博主的小地图可能是放大过的「地图贴片」，比例事先不知道；
 *      各个候选比例给出的屏幕位置必须一致（fuseScales），比例要攒够互相一致的帧才锁定。
 *
 * 不认识的地方（离路线太远、视频在过场 / 菜单）NCC 低、各比例的答案对不上 → 不画点。
 * 这正好用来「只有跟上路线才显示点」。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GifaLocate = api;
})(typeof self !== 'undefined' ? self : this, () => {
  /* ---------------- FFT（基 2，原地，迭代） ---------------- */

  const twiddleCache = new Map();

  function twiddles(n) {
    let t = twiddleCache.get(n);
    if (!t) {
      t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2), rev: new Uint32Array(n) };
      for (let i = 0; i < n / 2; i += 1) {
        t.cos[i] = Math.cos((2 * Math.PI * i) / n);
        t.sin[i] = Math.sin((2 * Math.PI * i) / n);
      }
      const bits = Math.log2(n);
      for (let i = 0; i < n; i += 1) {
        let r = 0;
        for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
        t.rev[i] = r;
      }
      twiddleCache.set(n, t);
    }
    return t;
  }

  /** 一维 FFT：re/im 是长度 n 的视图（n 为 2 的幂），inverse=true 时不做 1/n 缩放 */
  function fft1(re, im, inverse) {
    const n = re.length;
    const { cos, sin, rev } = twiddles(n);
    for (let i = 0; i < n; i += 1) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k += 1) {
          const wr = cos[k * step];
          const wi = sign * sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /** 二维 FFT（N×N，行优先），原地 */
  function fft2(re, im, n, inverse) {
    const rr = new Float64Array(n);
    const ri = new Float64Array(n);
    for (let y = 0; y < n; y += 1) {
      const o = y * n;
      fft1(re.subarray(o, o + n), im.subarray(o, o + n), inverse);
    }
    for (let x = 0; x < n; x += 1) {
      for (let y = 0; y < n; y += 1) {
        rr[y] = re[y * n + x];
        ri[y] = im[y * n + x];
      }
      fft1(rr, ri, inverse);
      for (let y = 0; y < n; y += 1) {
        re[y * n + x] = rr[y];
        im[y * n + x] = ri[y];
      }
    }
  }

  function spectrum(real, n) {
    const re = Float64Array.from(real);
    const im = new Float64Array(n * n);
    fft2(re, im, n, false);
    return { re, im };
  }

  /* ---------------- 预处理 ---------------- */

  function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /**
   * 环形权重：r < 0.3R 全挖掉（玩家箭头、视锥），之后升到 1，到 outer 再降到 0。
   * R = 小地图半径（像素），cover = 实际采到的半径（视频里小地图贴边时可能不足 R）。
   */
  function ringMask(n, R, cover) {
    const m = new Float64Array(n * n);
    const c = (n - 1) / 2;
    const outer = Math.min(0.94 * R, cover || Infinity, c);
    const inner = 0.3 * R;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const r = Math.hypot(x - c, y - c);
        m[y * n + x] = smoothstep(inner, inner + 0.12 * R, r) * (1 - smoothstep(outer - 0.12 * R, outer, r));
      }
    }
    return m;
  }

  /**
   * 图标遮罩膨胀 2px：Sobel 的 3×3 窗口会把图标边缘「带」到外圈一像素，
   * 不膨胀的话图标轮廓仍然会以一圈强梯度的形式参与匹配。
   */
  function dilate(skip, n, radius) {
    const out = new Uint8Array(n * n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (!skip[y * n + x]) continue;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= n) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const xx = x + dx;
            if (xx >= 0 && xx < n) out[yy * n + xx] = 1;
          }
        }
      }
    }
    return out;
  }

  /**
   * 从 RGBA 里拆出灰度和「像图标的像素」。
   * 原神小地图的地形颜色都偏灰、偏暗；传送锚点、任务标记、队友、神瞳这些图标是高饱和、高亮度的。
   * 图标在两边小地图上不一定一致（任务标记、队友只在一边有），必须排除在匹配之外。
   */
  function splitRgba(data, n) {
    const gray = new Float64Array(n * n);
    const skip = new Uint8Array(n * n);
    for (let i = 0, p = 0; i < n * n; i += 1, p += 4) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mx > 150 && mx - mn > 0.45 * mx) skip[i] = 1; // 鲜艳的彩色图标
      else if (mn > 235) skip[i] = 1; // 纯白描边 / 文字
    }
    return { gray, skip };
  }

  /**
   * 灰度 → Sobel 梯度幅值；权重 = 环形窗口 ×（不是图标）。
   * 返回带遮罩 NCC 需要的三个频谱：w、w·g、w·g²。
   */
  function prepare(gray, n, mask, skip) {
    const w = new Float64Array(n * n);
    const sk = skip ? dilate(skip, n, 2) : null;
    for (let i = 0; i < w.length; i += 1) w[i] = sk && sk[i] ? 0 : mask[i];
    const g = new Float64Array(n * n);
    for (let y = 1; y < n - 1; y += 1) {
      for (let x = 1; x < n - 1; x += 1) {
        const i = y * n + x;
        const gx = gray[i - n + 1] + 2 * gray[i + 1] + gray[i + n + 1] - gray[i - n - 1] - 2 * gray[i - 1] - gray[i + n - 1];
        const gy = gray[i + n - 1] + 2 * gray[i + n] + gray[i + n + 1] - gray[i - n - 1] - 2 * gray[i - n] - gray[i - n + 1];
        g[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    // 数值稳定：先按加权均值、标准差归一（NCC 本身对线性变换不变，这一步只防止大数相减丢精度）
    let sw = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < g.length; i += 1) {
      sw += w[i];
      s1 += w[i] * g[i];
      s2 += w[i] * g[i] * g[i];
    }
    const mean = sw > 0 ? s1 / sw : 0;
    const std = sw > 0 ? Math.sqrt(Math.max(1e-9, s2 / sw - mean * mean)) : 1;
    const wg = new Float64Array(n * n);
    const wgg = new Float64Array(n * n);
    for (let i = 0; i < g.length; i += 1) {
      const v = (g[i] - mean) / std;
      wg[i] = w[i] * v;
      wgg[i] = w[i] * v * v;
    }
    return {
      W: spectrum(w, n),
      WG: spectrum(wg, n),
      WGG: spectrum(wgg, n),
      weight: sw,
      // 归一化之前的纹理强度：大海、雪地、纯色过场几乎为 0
      texture: std
    };
  }

  /* ---------------- 带遮罩的归一化互相关 ---------------- */

  /** X·conj(Y) */
  function cmulConj(X, Y, i) {
    return [X.re[i] * Y.re[i] + X.im[i] * Y.im[i], X.im[i] * Y.re[i] - X.re[i] * Y.im[i]];
  }

  /**
   * 两个「结果为实数」的逆变换装进一次复数逆变换：IFFT(A + iB) = a + ib（a、b 为实数）。
   * 带遮罩 NCC 要 6 个逆变换，这样只做 3 次。
   */
  function inversePair(A, B, n) {
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    for (let i = 0; i < n * n; i += 1) {
      re[i] = A[0][i] - B[1][i];
      im[i] = A[1][i] + B[0][i];
    }
    fft2(re, im, n, true);
    const k = 1 / (n * n);
    for (let i = 0; i < n * n; i += 1) {
      re[i] *= k;
      im[i] *= k;
    }
    return [re, im];
  }

  function products(G, V, n) {
    // 6 个互相关的频域乘积：c(u) = Σ_x game(x)·video(x − u)
    const keys = [
      [G.W, V.W], // N  ：重叠的总权重
      [G.WG, V.W], // SF ：游戏图在重叠区的和
      [G.W, V.WG], // SG ：视频图在重叠区的和
      [G.WGG, V.W], // SFF
      [G.W, V.WGG], // SGG
      [G.WG, V.WG] // SFG
    ];
    return keys.map(([X, Y]) => {
      const r = new Float64Array(n * n);
      const im = new Float64Array(n * n);
      for (let i = 0; i < n * n; i += 1) {
        const [a, b] = cmulConj(X, Y, i);
        r[i] = a;
        im[i] = b;
      }
      return [r, im];
    });
  }

  /**
   * 返回 { dx, dy, ncc, second, psr }：
   *   video 里的点 p 对应 game 里的 p + (dx, dy)，即博主在你小地图上的位置 = 你的中心 + (dx, dy)；
   *   ncc     峰值（-1~1）
   *   second  离峰 6px 以外的最高值 —— 峰不够「独一无二」说明地形有重复 / 太平
   */
  function maskedNcc(game, video, n, maxShift, minOverlap, exclude = 6) {
    const P = products(game, video, n);
    const [N, SF] = inversePair(P[0], P[1], n);
    const [SG, SFF] = inversePair(P[2], P[3], n);
    const [SGG, SFG] = inversePair(P[4], P[5], n);
    const need = minOverlap * Math.min(game.weight, video.weight);
    const surf = new Float64Array(n * n).fill(-2);
    let best = -2;
    let bi = 0;
    let s = 0;
    let s2 = 0;
    let cnt = 0;
    for (let y = 0; y < n; y += 1) {
      const sy = y > n / 2 ? y - n : y;
      for (let x = 0; x < n; x += 1) {
        const sx = x > n / 2 ? x - n : x;
        if (sx * sx + sy * sy > maxShift * maxShift) continue;
        const i = y * n + x;
        const ov = N[i];
        if (ov < need) continue;
        const num = SFG[i] - (SF[i] * SG[i]) / ov;
        const d1 = SFF[i] - (SF[i] * SF[i]) / ov;
        const d2 = SGG[i] - (SG[i] * SG[i]) / ov;
        if (d1 <= 1e-9 || d2 <= 1e-9) continue;
        const v = num / Math.sqrt(d1 * d2);
        surf[i] = v;
        s += v;
        s2 += v * v;
        cnt += 1;
        if (v > best) {
          best = v;
          bi = i;
        }
      }
    }
    if (cnt < 9) return { dx: 0, dy: 0, ncc: 0, second: 0, psr: 0 };
    const bx = bi % n;
    const by = (bi / n) | 0;
    let second = -2;
    for (let i = 0; i < n * n; i += 1) {
      if (surf[i] < -1.5) continue;
      const x = i % n;
      const y = (i / n) | 0;
      const ddx = Math.min(Math.abs(x - bx), n - Math.abs(x - bx));
      const ddy = Math.min(Math.abs(y - by), n - Math.abs(y - by));
      if (ddx * ddx + ddy * ddy <= exclude * exclude) continue;
      if (surf[i] > second) second = surf[i];
    }
    const mean = s / cnt;
    const std = Math.sqrt(Math.max(1e-12, s2 / cnt - mean * mean));

    // 亚像素：峰两侧各一点做抛物线拟合（邻点无效时不修正）
    const at = (x, y) => surf[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
    const sub = (l, c, r) => {
      if (l < -1.5 || r < -1.5) return 0;
      const d = l - 2 * c + r;
      return Math.abs(d) < 1e-12 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
    };
    const fx = sub(at(bx - 1, by), best, at(bx + 1, by));
    const fy = sub(at(bx, by - 1), best, at(bx, by + 1));
    return {
      dx: (bx > n / 2 ? bx - n : bx) + fx,
      dy: (by > n / 2 ? by - n : by) + fy,
      ncc: best,
      second: Math.max(-1, second),
      psr: (best - mean) / std
    };
  }

  /* ---------------- 单次匹配 / 多比例 ---------------- */

  // 「第二高峰」至少离主峰这么远（单位：小地图半径）。真实地形的峰很宽，6px 外还是主峰自己的山坡，
  // 拿它当「第二高峰」会让真匹配的独特度看起来很低；0.25R 以外才是真正的另一个候选位置。
  let EXCLUDE_R = 0.25;
  let MIN_OVERLAP = 0.18;

  const maskCache = new Map();
  function cachedMask(n, R, cover) {
    const key = `${n}|${R}|${cover || 0}`;
    let m = maskCache.get(key);
    if (!m) {
      m = ringMask(n, R, cover);
      if (maskCache.size > 16) maskCache.clear();
      maskCache.set(key, m);
    }
    return m;
  }

  /** 视频小地图只做一次预处理，后面和每个比例的游戏小地图各比一次 */
  function videoSpec(video, n, R) {
    return prepare(video.gray, n, cachedMask(n, R, video.cover), video.skip);
  }

  function matchOne(vSpec, game, scale, n, R, opts = {}) {
    const gSpec = prepare(game.gray, n, cachedMask(n, R, 0), game.skip);
    // minOverlap：重叠的有效像素至少占较少一方的这么多。曾经是 0.3 —— 真实数据里视频那边有不少图标被挖掉，
    // 两边又各挖了中心一圈，博主在你小地图半径一半处时重叠只剩 ~25%，真位置直接被排除在搜索之外。
    const r = maskedNcc(gSpec, vSpec, n, (opts.maxShift || 0.7) * R, opts.minOverlap ?? MIN_OVERLAP, opts.exclude ?? EXCLUDE_R * R);
    r.scale = scale;
    r.texture = Math.min(vSpec.texture, gSpec.texture);
    return r;
  }

  function matchAll(video, games, n, R, opts = {}) {
    const vSpec = videoSpec(video, n, R);
    return games.map((g) => matchOne(vSpec, g, g.scale, n, R, opts));
  }

  /** 单帧：取 NCC 最高的那个比例（只有一个候选、或调试时用） */
  function matchMinimaps(video, games, n, R, opts = {}) {
    return matchAll(video, games, n, R, opts).reduce((a, b) => (b.ncc > a.ncc ? b : a));
  }

  /**
   * 把各个比例的结果合成一个，并判断可不可信。
   *
   * 关键性质：在比例 s 下，N×N 图上的 1 像素 = 屏幕上 (红圈半径 × s / R) 像素，
   * 所以「点该画在屏幕哪」只取决于 u = (dx·s, dy·s)，与用哪个比例算出来无关。
   * 真匹配时相邻的几个比例会给出几乎相同的 u；凑出来的假峰各比例的 u 会四处乱跳。
   * 组内按 NCC⁴ 加权：最接近真实比例的那个对得最齐，让它主导位置。
   */
  function fuseScales(results, R, opts = {}) {
    const tol = (opts.tol ?? 0.055) * R;
    const minNcc = opts.minNcc ?? 0.45;
    const pts = results
      .filter((r) => r && r.ncc >= minNcc)
      .map((r) => ({ x: r.dx * r.scale, y: r.dy * r.scale, r }));
    let group = [];
    for (const p of pts) {
      const g = pts.filter((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
      if (g.length > group.length) group = g;
    }
    if (!group.length) return { dx: 0, dy: 0, ncc: 0, second: 0, psr: 0, support: 0 };
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (const p of group) {
      const w = Math.pow(Math.max(0.01, p.r.ncc), 4);
      sw += w;
      sx += w * p.x;
      sy += w * p.y;
    }
    const top = group.reduce((a, b) => (b.r.ncc > a.r.ncc ? b : a)).r;
    return { dx: sx / sw, dy: sy / sw, ncc: top.ncc, second: top.second, psr: top.psr, support: group.length };
  }

  /* ---------------- 一帧完整定位（比例由粗到细 + 锁定） ---------------- */

  // 博主的小地图可能是放大 / 缩小过的「地图贴片」，和你游戏里原生小地图的缩放关系事先不知道，
  // 所以学习阶段按约 11% 一档的对数网格大范围搜（0.6× ~ 1.65×），锁定之后只在学到的比例附近细搜。
  const COARSE = [0.6, 0.67, 0.74, 0.82, 0.91, 1.0, 1.1, 1.22, 1.35, 1.5, 1.65];
  const FINE = [0.97, 0.985, 1, 1.015, 1.03];
  // 锁定比例需要的「互相一致的可信帧」数量，以及一致的容差
  const LOCK_VOTES = 5;
  const LOCK_TOL = 0.03;
  // 可信门槛：峰值够高、比 0.25R 以外的第二候选高出一截（独一无二）、至少 4 个相邻比例给出同一位置。
  // 用真实截图标定（2026-11-20）：真匹配 NCC 0.56 / 独特度 0.31 / 4 个比例一致；
  // 同一张真实小地图旋转、镜像后（真实纹理但对不上）最接近的一个是 0.52 / 0.22 / 3。
  // 合成地图上真匹配 NCC 能到 0.9，但真实画面（视频压缩、博主的地图样式、你小地图的半透明底）只有 0.5~0.6，
  // 所以不能只看 NCC 高低，「独一无二 + 多比例一致」才是主要依据。
  const TRUST = { ncc: 0.5, margin: 0.2, support: 4 };

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function isTrusted(f) {
    return f.support >= TRUST.support && f.ncc >= TRUST.ncc && f.ncc - f.second >= TRUST.margin;
  }

  /**
   * state（跨帧，按视频保存）：
   *   scale   当前的缩放比例估计（锁定后可以持久化，下次直接用）
   *   locked  比例已经被足够多的、互相一致的可信帧确认 —— 只有锁定之后才会画点
   *   hist    最近可信帧的最佳比例
   * sampleGame(scale) → { gray, skip }：按给定比例从最新截屏里裁出游戏小地图
   */
  function locateFrame(video, sampleGame, n, R, state = {}, opts = {}) {
    const vSpec = videoSpec(video, n, R);
    state.frames = (state.frames || 0) + 1;
    state.hist = state.hist || [];
    // 锁定后平时只在比例附近细搜；连续 3 帧对不上（转场、换了地图贴片布局）或者每 12 帧，做一次完整粗搜
    const narrow = state.locked && state.frames % 12 !== 0 && (state.miss || 0) < 3;
    const coarse = narrow ? [state.scale] : opts.coarse || COARSE;
    let best = null;
    for (const s of coarse) {
      const r = matchOne(vSpec, sampleGame(s), s, n, R, opts);
      if (!best || r.ncc > best.ncc) best = r;
    }
    const fine = FINE.map((k) => {
      const s = best.scale * k;
      return k === 1 ? best : matchOne(vSpec, sampleGame(s), s, n, R, opts);
    });
    const fused = fuseScales(fine, R, { tol: opts.tol ?? 0.04 });
    const top = fine.reduce((a, b) => (b.ncc > a.ncc ? b : a));
    const trusted = isTrusted(fused);

    if (narrow) state.miss = trusted ? 0 : (state.miss || 0) + 1;
    else state.miss = 0;

    if (trusted) {
      state.hist.push(top.scale);
      if (state.hist.length > 9) state.hist.shift();
    }
    if (state.hist.length) {
      const med = median(state.hist);
      const close = state.hist.filter((s) => Math.abs(s / med - 1) <= LOCK_TOL);
      // 某些地形在两种缩放下长得很像，单帧会被「错比例 + 错位移」骗；但换个位置这种巧合就不成立了。
      // 所以必须攒够 LOCK_VOTES 个互相一致的可信帧才锁定，锁定之前一个点都不画。
      if (close.length >= LOCK_VOTES) {
        state.locked = true;
        state.scale = median(close);
      } else if (!state.locked) {
        state.scale = med;
      }
    }
    const agrees = !!state.locked && Math.abs(top.scale / state.scale - 1) <= 0.04;
    fused.trusted = trusted && agrees;
    fused.scale = top.scale;
    fused.locked = !!state.locked;
    return fused;
  }

  /**
   * 时序确认：单帧的峰可能是巧合。最近几次可信结果里至少 2 次落在同一处（4px 内）
   * 才显示；位置做指数平滑，免得点在原地抖。
   */
  function createTracker(opts = {}) {
    const agreePx = opts.agreePx || 4;
    // 丢失匹配后点还留多久。两边的人都在走，留久了就是一个「过期」的错点；
    // 0.75 秒（约 3 次更新）够盖住偶尔一两帧没认出来，又不至于跑偏太多
    const keepMs = opts.keepMs || 750;
    const hist = [];
    let shown = null;
    let lastGood = 0;
    return {
      push(r, now) {
        const trusted = !!(r && r.trusted);
        if (trusted) hist.push({ x: r.dx, y: r.dy, t: now });
        while (hist.length && now - hist[0].t > 1200) hist.shift();
        if (hist.length > 4) hist.shift();
        const last = hist[hist.length - 1];
        // 只有「这一帧带来了新的可信结果」才能确认 / 移动点。
        // 曾经的 bug：每帧都拿历史里的旧结果重新判一致，没有新证据也算「刚确认过」，
        // 点就钉在原地不动、也不过期，而真实位置早就走远了。
        const agree = trusted && hist.filter((h) => Math.hypot(h.x - last.x, h.y - last.y) <= agreePx).length >= 2;
        if (agree) {
          lastGood = now;
          if (!shown || Math.hypot(shown.x - last.x, shown.y - last.y) > 3 * agreePx) shown = { x: last.x, y: last.y };
          else shown = { x: shown.x + 0.5 * (last.x - shown.x), y: shown.y + 0.5 * (last.y - shown.y) };
        } else if (shown && now - lastGood > keepMs) {
          shown = null;
        }
        // held = 这一帧没有新的可信结果，点是沿用上一帧的（叠加层把它画淡一点）
        return shown ? { x: shown.x, y: shown.y, held: now !== lastGood } : null;
      },
      reset() {
        hist.length = 0;
        shown = null;
      }
    };
  }

  /**
   * 「博主最后出现的位置」：博主的小地图消失（进任务 / 过场 / 视频暂停）之后，
   * 把他最后被认出来的位置继续标在你的小地图上，直到你走到那里。
   *
   * 难点是点存的是「相对你」的位置，你一走就不对了。所以要跟踪你自己的移动：
   * 拿你现在的小地图和「锚点时刻」的小地图比（同一个游戏、同一个缩放，比例恒为 1，比对视频容易得多），
   * 得到你挪了多少 d，那么博主的位置 = d + 锚点时记下的相对位置 u。
   * 走出去太远（≥ 0.45R）就把锚点换成现在这一帧（链式里程计），重叠永远够。
   * 单位和位置点一样：比例 1 下的切片像素（屏幕偏移 = 值 × 红圈半径 / R）。
   */
  function createLastSeen(opts = {}) {
    // 同一个游戏小地图自己比，真匹配 NCC 一般 0.85~1；换了个地方（传送）凑出来的假峰在 0.45~0.65
    const minNcc = opts.minNcc ?? 0.8;
    const minMargin = opts.minMargin ?? 0.12;
    const reanchorR = opts.reanchor ?? 0.45;
    const arriveR = opts.arrive ?? 0.15;
    // 对不上：1.5 秒内沿用上一个位置；之后先不画（打开菜单 / 剧情对话 / 读条时你的小地图会变样），
    // 但锚点留着，回到原处又能对上就接着画；60 秒都对不上（传送走了）才真正丢掉
    const hideMs = opts.hideMs ?? 1500;
    const lostMs = opts.lostMs ?? 60000;
    const stepR = opts.step ?? 0.2; // 两帧之间最多挪多远（小地图半径的比例）还算「连贯」
    const contNcc = opts.contNcc ?? 0.75;
    const maxAgeMs = opts.maxAgeMs ?? 15 * 60 * 1000;
    let anchor = null;
    let last = null;

    function clear() {
      anchor = null;
      last = null;
    }

    return {
      /** 可信的实时匹配：记下这一刻你的小地图（比例 1）和博主相对你的位置 u */
      setAnchor(game, u, now) {
        anchor = { gray: game.gray, skip: game.skip, u: { x: u.x, y: u.y }, born: now, lostSince: 0, lastD: { x: 0, y: 0 } };
        last = { x: u.x, y: u.y };
      },
      clear,
      get active() {
        return !!anchor;
      },
      /** 博主小地图不见了：用你现在的小地图（比例 1）跟踪你的移动，返回博主最后位置相对你现在的位置 */
      track(game, n, R, now) {
        if (!anchor) return { target: null };
        if (now - anchor.born > maxAgeMs) {
          clear();
          return { target: null, expired: true };
        }
        const res = matchAll({ gray: anchor.gray, skip: anchor.skip, cover: R }, [{ scale: 1, gray: game.gray, skip: game.skip }], n, R, {
          maxShift: 0.9
        })[0];
        // 自己和自己比，峰很高但「第二高峰」也常常很高（路、河这类重复纹理）。
        // 所以除了独特度，再认「和上一帧的位移连贯」：人 0.35 秒走不远，跟上一帧差不多的峰就是真的。
        const near = anchor.lastD && Math.hypot(res.dx - anchor.lastD.x, res.dy - anchor.lastD.y) <= stepR * R;
        const ok = (res.ncc >= minNcc && res.ncc - res.second >= minMargin) || (near && res.ncc >= contNcc);
        if (ok) {
          anchor.lostSince = 0;
          anchor.lastD = { x: res.dx, y: res.dy };
          // 锚点时刻你站的位置，在你现在的小地图上是 (dx, dy)；博主在那个位置再加 u
          const t = { x: res.dx + anchor.u.x, y: res.dy + anchor.u.y };
          last = t;
          if (Math.hypot(t.x, t.y) <= arriveR * R) {
            clear();
            return { target: null, arrived: true };
          }
          if (Math.hypot(res.dx, res.dy) >= reanchorR * R && res.ncc >= minNcc) {
            anchor.gray = game.gray;
            anchor.skip = game.skip;
            anchor.u = t;
            anchor.lastD = { x: 0, y: 0 };
          }
          return { target: t, held: false, ncc: res.ncc };
        }
        // 这一帧没对上（转镜头时视锥扫过、打开菜单……）：先沿用上一个位置，久了先藏起来，太久才放弃
        if (!anchor.lostSince) anchor.lostSince = now;
        const gap = now - anchor.lostSince;
        if (gap > lostMs) {
          clear();
          return { target: null, lost: true };
        }
        if (gap > hideMs) return { target: null, hidden: true, ncc: res.ncc };
        return { target: last, held: true, ncc: res.ncc };
      }
    };
  }

  return {
    createLastSeen,
    fft2,
    ringMask,
    splitRgba,
    prepare,
    maskedNcc,
    matchAll,
    matchMinimaps,
    fuseScales,
    locateFrame,
    createTracker,
    isTrusted,
    COARSE,
    FINE,
    TRUST
  };
});
