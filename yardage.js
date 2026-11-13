/*!
 * Yardage — yardage-book hole image generator (SVG) for Roundcast.
 * Plain ES2019, no dependencies. Exposes window.Yardage = { renderHole, holeStats, toPNG }.
 */
(function (root) {
  "use strict";

  var R = 6371008.8, D2R = Math.PI / 180, M2YD = 1.0936133;
  var uid = 0;

  /* ------------------------------------------------------------------ geo */
  function P(p) {
    if (!p) return null;
    if (Array.isArray(p)) return { lat: +p[0], lon: +p[1] };
    return { lat: +p.lat, lon: +(p.lon != null ? p.lon : p.lng) };
  }
  function hav(a, b) {
    var dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
    var s = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function initialBearing(a, b) {
    var f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    var y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  // local equirectangular projection (meters, x=east, y=north)
  function makeProj(o) {
    var k = Math.cos(o.lat * D2R), m = R * D2R;
    return {
      fwd: function (p) { return { x: (p.lon - o.lon) * m * k, y: (p.lat - o.lat) * m }; },
      inv: function (x, y) { return { lat: o.lat + y / m, lon: o.lon + x / (m * k) }; }
    };
  }

  /* ---------------------------------------------------------- hole model */
  function teeOf(hole, idx) {
    var tees = hole.tees || [];
    var t = tees[idx] || tees[0];
    if (!t) throw new Error("Yardage: hole has no tees");
    return { lat: +t.lat, lon: +(t.lon != null ? t.lon : t.lng), label: t.label || "" };
  }
  function normGreen(g, i) {
    g = g || {};
    var c = P(g.center) || P(g.front) || P(g.back);
    if (!c) throw new Error("Yardage: hole has no green point");
    return { id: g.id || (i === 1 ? "R" : i === 0 ? "L" : String(i)), label: g.label || "", front: P(g.front) || c, center: c, back: P(g.back) || c, poly: (g.poly || []).map(P) };
  }
  // all greens of a hole: hole.greens (2-green / 투그린 holes) or [hole.green]
  function greensOf(hole) {
    if (hole.greens && hole.greens.length > 1) return hole.greens.map(normGreen);
    var g = normGreen(hole.green || (hole.greens && hole.greens[0]), 0);
    g.id = (hole.green && hole.green.id) || ""; return [g];
  }
  function greenOf(hole, greenIdx) {
    var gs = greensOf(hole);
    return gs[Math.max(0, Math.min(gs.length - 1, greenIdx || 0))];
  }
  // play line: tee -> intermediate path points -> green center
  // (a path drawn to greens[0] is reused for the other green: its corner points are kept,
  //  only the final point is swapped for the active green's center)
  function playLine(hole, teeIdx, greenIdx) {
    var tee = teeOf(hole, teeIdx), g = greenOf(hole, greenIdx), allG = greensOf(hole);
    var tees = (hole.tees || []).map(P);
    var mids = (hole.path || []).map(P).filter(function (p) {
      for (var j = 0; j < allG.length; j++) if (hav(p, allG[j].center) < 8) return false;
      for (var i = 0; i < tees.length; i++) if (hav(p, tees[i]) < 8) return false;
      return true;
    });
    // drop intermediate points that are behind the chosen tee (e.g. forward tee past a corner)
    var d0 = hav(tee, g.center);
    mids = mids.filter(function (p) { return hav(p, g.center) < d0 - 5; });
    return [tee].concat(mids, [g.center]);
  }
  function polyLen(pts) { var s = 0; for (var i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]); return s; }
  function hazardPts(h) { return h.poly && h.poly.length ? h.poly.map(P) : (h.pt ? [P(h.pt)] : []); }

  // signed lateral offset (m, +left) and along-distance of point q vs. polyline (local xy)
  function lateral(lineXY, q) {
    var best = { d: Infinity, off: 0, along: 0 }, acc = 0;
    for (var i = 1; i < lineXY.length; i++) {
      var a = lineXY[i - 1], b = lineXY[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9, L = Math.sqrt(L2);
      var t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2, tc = Math.max(0, Math.min(1, t));
      var px = a.x + dx * tc, py = a.y + dy * tc, d = Math.hypot(q.x - px, q.y - py);
      if (d < best.d) best = { d: d, off: (dx * (q.y - a.y) - dy * (q.x - a.x)) / L, along: acc + tc * L };
      acc += L;
    }
    return best;
  }

  function holeStats(hole, teeIdx, greenIdx) {
    teeIdx = teeIdx || 0; greenIdx = greenIdx || 0;
    var gs = greensOf(hole);
    if (greenIdx >= gs.length) greenIdx = 0;
    var g = gs[greenIdx], line = playLine(hole, teeIdx, greenIdx), tee = line[0];
    var total = polyLen(line), last = line[line.length - 2], base = total - hav(last, g.center);
    var proj = makeProj(tee), lxy = line.map(proj.fwd);
    // dogleg: an intermediate point deviates >12 m from the tee→green chord, or turn >10°
    var dogleg = false;
    if (line.length > 2) {
      var chord = [lxy[0], lxy[lxy.length - 1]];
      for (var i = 1; i < lxy.length - 1; i++) {
        var dev = Math.abs(lateral(chord, lxy[i]).off);
        var a1 = Math.atan2(lxy[i].x - lxy[i - 1].x, lxy[i].y - lxy[i - 1].y), a2 = Math.atan2(lxy[i + 1].x - lxy[i].x, lxy[i + 1].y - lxy[i].y);
        var turn = Math.abs(((a2 - a1) / D2R + 540) % 360 - 180);
        if (dev > 12 || turn > 10) dogleg = true;
      }
    }
    var hz = (hole.hazards || []).map(function (h) {
      var pts = hazardPts(h);
      if (!pts.length) return null;
      var ds = pts.map(function (p) { return hav(tee, p); });
      var offs = pts.map(function (p) { return lateral(lxy, proj.fwd(p)).off; });
      var cx = 0, cy = 0; pts.forEach(function (p) { var q = proj.fwd(p); cx += q.x; cy += q.y; });
      var cOff = lateral(lxy, { x: cx / pts.length, y: cy / pts.length }).off;
      var mn = Math.min.apply(null, offs), mx = Math.max.apply(null, offs);
      var side = (mn < -4 && mx > 4) || Math.abs(cOff) < 6 ? "C" : (cOff > 0 ? "L" : "R");
      return { type: h.type || "bunker", reach_m: Math.min.apply(null, ds), carry_m: Math.max.apply(null, ds), side: side };
    }).filter(Boolean).sort(function (a, b) { return a.reach_m - b.reach_m; });
    var out = {
      total_m: total,
      toFront_m: base + hav(last, g.front),
      toCenter_m: total,
      toBack_m: base + hav(last, g.back),
      bearing_deg: initialBearing(tee, g.center),
      dogleg: dogleg,
      hazards: hz
    };
    if (gs.length > 1) {
      out.greenIdx = greenIdx;
      out.greens = gs.map(function (gg, i) { return { id: gg.id, label: gg.label, toCenter_m: polyLen(playLine(hole, teeIdx, i)) }; });
    }
    return out;
  }

  /* ------------------------------------------------------------- i18n */
  var I18N = {
    ko: { hole: function (n) { return n + "번 홀"; }, par: "PAR", F: "앞", C: "중앙", B: "뒤", you: "현재 위치", tee: "티", carry: "캐리", reach: "도달",
      rem: function (d) { return "남은 " + d; }, gside: { L: "좌", R: "우", C: "중" }, tees: { black: "블랙", blue: "블루", white: "화이트", red: "레드", gold: "골드", yellow: "옐로", green: "그린" }, dogleg: "도그렉" },
    en: { hole: function (n) { return "Hole " + n; }, par: "Par", F: "Front", C: "Center", B: "Back", you: "From you", tee: "tee", carry: "carry", reach: "reach",
      rem: function (d) { return d + " to go"; }, gside: { L: "Left", R: "Right", C: "Center" }, tees: {}, dogleg: "Dogleg" },
    ja: { hole: function (n) { return n + "番ホール"; }, par: "PAR", F: "手前", C: "センター", B: "奥", you: "現在地", tee: "ティー", carry: "キャリー", reach: "到達",
      rem: function (d) { return "残り" + d; }, gside: { L: "左", R: "右", C: "中" }, tees: { black: "ブラック", blue: "ブルー", white: "ホワイト", red: "レッド", gold: "ゴールド", yellow: "イエロー", green: "グリーン" }, dogleg: "ドッグレッグ" }
  };
  var TEE_COLORS = { black: "#1b1b1b", blue: "#2f6fd6", white: "#f4f4f4", red: "#d6453d", gold: "#d4ae5f", yellow: "#e8c93a", green: "#3c9a4e", silver: "#b9c0c4" };

  var THEMES = {
    dark: { bg: "#10201a", rough: "#17301f", rough2: "#1b3824", fairway: "#2f6b3f", fairway2: "#37784a", green: "#4f9a55", collar: "#3e8248",
      bunker: "#e6d3a3", bunkerEdge: "#c8b07a", water: "#3f7fb0", waterEdge: "#6aa3cf", bunkerText: "#e6d3a3", waterText: "#8cc3ec", tree: "#0c1a13", tree2: "#1f3f2a", treeOpacity: 0.9, tee: "#3f8a4d",
      text: "#efe9da", muted: "#a8b4a6", gold: "#d4ae5f", halo: "#0b1712", panel: "rgba(16,32,26,0.92)", line: "#efe9da", ob: "#f2f2f2", pos: "#5ec8ff" },
    light: { bg: "#f3eee2", rough: "#dfe6cc", rough2: "#d5dfbf", fairway: "#8fbf7c", fairway2: "#9dca8a", green: "#62ad5f", collar: "#7dbb72",
      bunker: "#f1e3b8", bunkerEdge: "#c9ad6d", water: "#5e9ccc", waterEdge: "#3d79a8", bunkerText: "#8a6a24", waterText: "#2a6a9e", tree: "#8aa97c", tree2: "#bccfab", treeOpacity: 0.8, tee: "#79b56f",
      text: "#1e2a22", muted: "#5b6a5f", gold: "#9a7226", halo: "#f8f5ec", panel: "rgba(243,238,226,0.94)", line: "#1e2a22", ob: "#3a3a3a", pos: "#0a84d6" }
  };
  var FONT = "'Noto Sans KR','Noto Sans CJK KR','Noto Sans JP','Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function f1(v) { return Math.round(v * 10) / 10; }
  function rng(seed) { var s = (seed * 2654435761) >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  /* ---------------------------------------------------------- tiles */
  function lon2tile(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2tile(lat, z) { var r = lat * D2R; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); }
  function tile2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tile2lat(y, z) { var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return Math.atan(Math.sinh(n)) / D2R; }
  function tileUrl(tpl, z, x, y) { return tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y); }

  /* ---------------------------------------------------------- render */
  function renderHole(hole, opts) {
    opts = opts || {};
    var W = opts.width || 360, H = opts.height || 640;
    var units = opts.units === "yd" ? "yd" : "m", uf = units === "yd" ? M2YD : 1;
    var L = I18N[opts.lang] || I18N.ko, lang = I18N[opts.lang] ? opts.lang : "ko";
    var T = THEMES[opts.theme === "light" ? "light" : "dark"];
    var teeIdx = opts.teeIdx || 0;
    var arcsU = opts.arcs || [100, 150, 200, 250];
    var id = "yd" + (++uid) + "_";
    var dist = function (m) { return Math.round(m * uf); };

    var allGreens = greensOf(hole), greenIdx = opts.greenIdx > 0 && opts.greenIdx < allGreens.length ? opts.greenIdx : 0;
    var st = holeStats(hole, teeIdx, greenIdx), g = allGreens[greenIdx], line = playLine(hole, teeIdx, greenIdx), tee = line[0];
    var allTees = (hole.tees || []).map(function (t, i) { return { p: P(t), label: (t.label || "").toLowerCase(), i: i }; });
    var pos = P(opts.pos);

    // projection & rotation (tee at bottom, green at top)
    var origin = { lat: (tee.lat + g.center.lat) / 2, lon: (tee.lon + g.center.lon) / 2 };
    var proj = makeProj(origin);
    var tXY = proj.fwd(tee), cXY = proj.fwd(g.center);
    var b = Math.atan2(cXY.x - tXY.x, cXY.y - tXY.y), cb = Math.cos(b), sb = Math.sin(b);
    function uv(p) { var q = proj.fwd(p); return { u: q.x * cb - q.y * sb, v: q.x * sb + q.y * cb }; }
    function xyOfUV(u, v) { return { x: u * cb + v * sb, y: -u * sb + v * cb }; }

    // green geometry (meters, uv)
    var gF = uv(g.front), gC = uv(g.center), gB = uv(g.back);
    var gLen = Math.max(18, Math.hypot(gB.u - gF.u, gB.v - gF.v) || 0);
    var gWid = Math.max(15, gLen * 0.8);
    var gAng = (gB.u - gF.u || gB.v - gF.v) ? Math.atan2(gB.u - gF.u, gB.v - gF.v) : 0; // angle of F→B from "up"
    var gPolyUV = g.poly.length > 2 ? g.poly.map(uv) : null;
    // inactive greens (투그린): same geometry recipe, drawn dimmer
    var others = allGreens.map(function (gg, i) {
      if (i === greenIdx) return null;
      var F = uv(gg.front), C = uv(gg.center), B = uv(gg.back), len = Math.max(18, Math.hypot(B.u - F.u, B.v - F.v) || 0);
      return { i: i, g: gg, F: F, C: C, B: B, len: len, wid: Math.max(15, len * 0.8), ang: (B.u - F.u || B.v - F.v) ? Math.atan2(B.u - F.u, B.v - F.v) : 0,
        poly: gg.poly.length > 2 ? gg.poly.map(uv) : null };
    }).filter(Boolean);

    // fit bbox
    var fit = [];
    function add(q, pad) { pad = pad || 0; fit.push({ u: q.u - pad, v: q.v - pad }, { u: q.u + pad, v: q.v + pad }); }
    line.forEach(function (p) { add(uv(p), 22); });
    allTees.forEach(function (t) { add(uv(t.p), 6); });
    add(gC, gLen / 2 + 6); add(gF, 4); add(gB, 8);
    if (gPolyUV) gPolyUV.forEach(function (q) { add(q, 4); });
    others.forEach(function (og) { add(og.C, og.len / 2 + 8); if (og.poly) og.poly.forEach(function (q) { add(q, 4); }); });
    (hole.fairway || []).forEach(function (poly) { poly.forEach(function (p) { add(uv(P(p)), 2); }); });
    (hole.hazards || []).forEach(function (h) { hazardPts(h).forEach(function (p) { add(uv(p), h.pt ? 10 : 3); }); });
    if (pos && hav(pos, g.center) < Math.max(650, st.total_m * 1.3)) add(uv(pos), 10);
    var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    fit.forEach(function (q) { umin = Math.min(umin, q.u); umax = Math.max(umax, q.u); vmin = Math.min(vmin, q.v); vmax = Math.max(vmax, q.v); });
    var minW = 110;
    if (umax - umin < minW) { var mid = (umax + umin) / 2; umin = mid - minW / 2; umax = mid + minW / 2; }

    var HEAD = 70, FOOT = 46, PADX = 30;
    var availW = W - PADX * 2, availH = H - HEAD - FOOT - 16;
    var s = Math.min(availW / (umax - umin), availH / (vmax - vmin));
    var uc = (umin + umax) / 2, vc = (vmin + vmax) / 2, cyScr = HEAD + 8 + availH / 2;
    function S(q) { return { x: W / 2 + (q.u - uc) * s, y: cyScr - (q.v - vc) * s }; }
    function SP(p) { return S(uv(p)); }
    function pts(arr) { return arr.map(function (q) { var o = S(q); return f1(o.x) + "," + f1(o.y); }).join(" "); }
    function screenToLatLon(x, y) { var u = (x - W / 2) / s + uc, v = (cyScr - y) / s + vc, q = xyOfUV(u, v); return proj.inv(q.x, q.y); }

    var lineUV = line.map(uv);
    // point along play line at along-distance d (meters, local)
    var segL = [], lineLen = 0;
    for (var i = 1; i < lineUV.length; i++) { var l = Math.hypot(lineUV[i].u - lineUV[i - 1].u, lineUV[i].v - lineUV[i - 1].v); segL.push(l); lineLen += l; }
    function along(d) {
      d = Math.max(0, Math.min(lineLen, d));
      for (var i = 0; i < segL.length; i++) {
        if (d <= segL[i] || i === segL.length - 1) { var t = segL[i] ? Math.min(1, d / segL[i]) : 0, a = lineUV[i], c = lineUV[i + 1];
          return { u: a.u + (c.u - a.u) * t, v: a.v + (c.v - a.v) * t, dir: Math.atan2(c.u - a.u, c.v - a.v) }; }
        d -= segL[i];
      }
      return lineUV[lineUV.length - 1];
    }
    function subLine(d0, d1) {
      var out = [along(d0)], acc = 0;
      for (var i = 0; i < segL.length; i++) { acc += segL[i]; if (acc > d0 && acc < d1) out.push(lineUV[i + 1]); }
      out.push(along(d1)); return out;
    }
    // along-distance of green front on the line
    var gFrontAlong = lineLen - Math.max(4, Math.hypot(gC.u - gF.u, gC.v - gF.v));

    var o = [];
    o.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" font-family="' + esc(FONT) + '" lang="' + lang + '">');
    // defs
    var stripe = Math.max(4, 11 * s);
    o.push("<defs>",
      '<clipPath id="' + id + 'clip"><rect width="' + W + '" height="' + H + '" rx="0"/></clipPath>',
      '<pattern id="' + id + 'fw" patternUnits="userSpaceOnUse" width="' + W + '" height="' + f1(stripe * 2) + '" y="' + f1(cyScr % (stripe * 2)) + '">',
      '<rect width="' + W + '" height="' + f1(stripe) + '" fill="' + T.fairway + '"/><rect y="' + f1(stripe) + '" width="' + W + '" height="' + f1(stripe) + '" fill="' + T.fairway2 + '"/></pattern>',
      '<radialGradient id="' + id + 'gr" cx="45%" cy="40%" r="65%"><stop offset="0" stop-color="' + T.fairway2 + '"/><stop offset="0.5" stop-color="' + T.green + '"/><stop offset="1" stop-color="' + T.green + '"/></radialGradient>',
      '<linearGradient id="' + id + 'hd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + T.bg + '" stop-opacity="0.97"/><stop offset="0.75" stop-color="' + T.bg + '" stop-opacity="0.9"/><stop offset="1" stop-color="' + T.bg + '" stop-opacity="0"/></linearGradient>',
      '<linearGradient id="' + id + 'ft" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="' + T.bg + '" stop-opacity="0.95"/><stop offset="0.7" stop-color="' + T.bg + '" stop-opacity="0.85"/><stop offset="1" stop-color="' + T.bg + '" stop-opacity="0"/></linearGradient>',
      "</defs>");
    o.push('<rect width="' + W + '" height="' + H + '" fill="' + T.bg + '"/>');
    o.push('<g clip-path="url(#' + id + 'clip)">');

    var imagery = opts.imagery && opts.imagery.tileUrl ? opts.imagery : null;
    if (imagery) {
      // tiles covering the rotated viewport
      var z = imagery.z || 18;
      var corners = [[0, 0], [W, 0], [0, H], [W, H]].map(function (c) { return screenToLatLon(c[0], c[1]); });
      var tx0, tx1, ty0, ty1, guard = 0;
      do {
        tx0 = Math.floor(Math.min.apply(null, corners.map(function (c) { return lon2tile(c.lon, z); })));
        tx1 = Math.floor(Math.max.apply(null, corners.map(function (c) { return lon2tile(c.lon, z); })));
        ty0 = Math.floor(Math.min.apply(null, corners.map(function (c) { return lat2tile(c.lat, z); })));
        ty1 = Math.floor(Math.max.apply(null, corners.map(function (c) { return lat2tile(c.lat, z); })));
        if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= (imagery.maxTiles || 120)) break;
        z--;
      } while (++guard < 6);
      var a = s * cb, bb = -s * sb, c = s * sb, d = s * cb;
      o.push('<g opacity="' + (imagery.opacity != null ? imagery.opacity : 1) + '">');
      for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) {
        var nw = proj.fwd({ lat: tile2lat(ty, z), lon: tile2lon(tx, z) }), se = proj.fwd({ lat: tile2lat(ty + 1, z), lon: tile2lon(tx + 1, z) });
        var p0 = S({ u: nw.x * cb - nw.y * sb, v: nw.x * sb + nw.y * cb });
        var tw = se.x - nw.x, th = nw.y - se.y, ov = 0.6 / s; // tiny overlap hides seams
        o.push('<image href="' + esc(tileUrl(imagery.tileUrl, z, tx, ty)) + '" x="0" y="0" width="' + (tw + ov).toFixed(3) + '" height="' + (th + ov).toFixed(3) +
          '" preserveAspectRatio="none" transform="matrix(' + [a, bb, c, d, p0.x, p0.y].map(function (v) { return v.toFixed(4); }).join(",") + ')"/>');
      }
      o.push("</g>");
      if (imagery.scrim !== false) o.push('<rect width="' + W + '" height="' + H + '" fill="' + T.bg + '" opacity="' + (imagery.scrim != null ? imagery.scrim : 0.12) + '"/>');
    } else {
      // ---- stylized course: rough corridor, trees, fairway
      var roughW = 90;
      var fullLine = lineUV.slice(0, -1).concat([gC, { u: gC.u + Math.sin(gAng) * (gLen / 2 + 10), v: gC.v + Math.cos(gAng) * (gLen / 2 + 10) }]);
      var roughLines = [fullLine].concat(others.map(function (og) {
        return [lineUV[Math.max(0, lineUV.length - 2)], og.C, { u: og.C.u + Math.sin(og.ang) * (og.len / 2 + 10), v: og.C.v + Math.cos(og.ang) * (og.len / 2 + 10) }];
      }));
      roughLines.forEach(function (rl) { o.push('<polyline points="' + pts(rl) + '" fill="none" stroke="' + T.rough + '" stroke-width="' + f1((roughW + 30) * s) + '" stroke-linejoin="round" stroke-linecap="round"/>'); });
      roughLines.forEach(function (rl) { o.push('<polyline points="' + pts(rl) + '" fill="none" stroke="' + T.rough2 + '" stroke-width="' + f1(roughW * s) + '" stroke-linejoin="round" stroke-linecap="round"/>'); });
      // trees: deterministic rows from the rough edge out to the frame edge
      var rnd = rng((hole.n || 1) * 7 + 3), treeSvg = [], nTrees = 0;
      var distToLine = function (q) {
        var m = Infinity;
        roughLines.forEach(function (rl) {
          for (var i = 1; i < rl.length; i++) {
            var a = rl[i - 1], c = rl[i], du = c.u - a.u, dv = c.v - a.v, L2 = du * du + dv * dv || 1e-9;
            var t = Math.max(0, Math.min(1, ((q.u - a.u) * du + (q.v - a.v) * dv) / L2));
            m = Math.min(m, Math.hypot(q.u - a.u - du * t, q.v - a.v - dv * t));
          }
        });
        return m;
      };
      var maxOff = Math.max(W, H) / s;
      for (var row = 0; row < 14 && nTrees < 1400; row++) {
        var baseOff = roughW / 2 + 10 + row * 15;
        if (baseOff > maxOff) break;
        var step = 11 + row * 1.5;
        for (var td = -40 - rnd() * step; td < lineLen + 40; td += step * (0.75 + rnd() * 0.6)) {
          var ap = along(td), nx = Math.cos(ap.dir), ny = -Math.sin(ap.dir);
          if (td < 0) { ap = { u: lineUV[0].u + Math.sin(ap.dir) * td, v: lineUV[0].v + Math.cos(ap.dir) * td, dir: ap.dir }; }
          if (td > lineLen) { ap = { u: ap.u + Math.sin(ap.dir) * (td - lineLen), v: ap.v + Math.cos(ap.dir) * (td - lineLen), dir: ap.dir }; }
          for (var side = -1; side <= 1; side += 2) {
            var off = side * (baseOff + rnd() * 10), r = 4.5 + rnd() * 4.5;
            var q = { u: ap.u + nx * off, v: ap.v + ny * off }, sp = S(q);
            if (sp.x < -15 || sp.x > W + 15 || sp.y < -15 || sp.y > H + 15) continue;
            if (distToLine(q) < roughW / 2 + 6 || Math.hypot(q.u - gC.u, q.v - gC.v) < gLen / 2 + 30) continue;
            var rs = Math.max(2.4, r * s);
            treeSvg.push('<circle cx="' + f1(sp.x) + '" cy="' + f1(sp.y) + '" r="' + f1(rs) + '" fill="' + T.tree2 + '"/>');
            treeSvg.push('<circle cx="' + f1(sp.x + rs * 0.22) + '" cy="' + f1(sp.y + rs * 0.22) + '" r="' + f1(rs * 0.6) + '" fill="' + T.tree + '" opacity="0.3"/>');
            nTrees++;
          }
        }
      }
      o.push('<g opacity="' + T.treeOpacity + '">' + treeSvg.join("") + "</g>");
      // fairway
      if (hole.fairway && hole.fairway.length) {
        hole.fairway.forEach(function (poly) { o.push('<polygon points="' + pts(poly.map(function (p) { return uv(P(p)); })) + '" fill="url(#' + id + 'fw)" stroke="' + T.fairway2 + '" stroke-width="1"/>'); });
      } else {
        var par = hole.par || 4;
        var fwStart = par <= 3 ? Math.max(0, gFrontAlong - 20) : Math.min(150, Math.max(60, lineLen * 0.25));
        var fwW = par <= 3 ? Math.max(14, gWid * 0.7) : 35;
        var fwEnd = gFrontAlong + 3;
        if (fwEnd > fwStart + 5) {
          var fl = subLine(fwStart, fwEnd);
          o.push('<polyline points="' + pts(fl) + '" fill="none" stroke="' + T.fairway + '" stroke-opacity="0.45" stroke-width="' + f1((fwW + 6) * s) + '" stroke-linejoin="round" stroke-linecap="round"/>');
          o.push('<polyline points="' + pts(fl) + '" fill="none" stroke="url(#' + id + 'fw)" stroke-width="' + f1(fwW * s) + '" stroke-linejoin="round" stroke-linecap="round"/>');
        }
      }
    }

    // ---- hazards (polys / points)
    (hole.hazards || []).forEach(function (h) {
      var type = h.type || "bunker", hp = hazardPts(h);
      if (!hp.length) return;
      if (type === "ob") {
        if (h.poly) {
          o.push('<polyline points="' + pts(hp.map(uv)) + '" fill="none" stroke="' + T.ob + '" stroke-width="1.6" stroke-dasharray="6 4" opacity="0.9"/>');
          hp.forEach(function (p) { var sp = SP(p); o.push('<circle cx="' + f1(sp.x) + '" cy="' + f1(sp.y) + '" r="2.4" fill="' + T.ob + '"/>'); });
          var mid = SP(hp[Math.floor(hp.length / 2)]);
          o.push(label(mid.x, mid.y - 6, "OB", 9.5, T.ob, "middle", 700));
        } else { var spo = SP(hp[0]); o.push('<rect x="' + f1(spo.x - 2) + '" y="' + f1(spo.y - 7) + '" width="4" height="14" fill="' + T.ob + '"/>'); }
        return;
      }
      var fill = type === "water" ? T.water : type === "tree" ? T.tree2 : T.bunker;
      var edge = type === "water" ? T.waterEdge : type === "tree" ? T.tree : T.bunkerEdge;
      if (h.poly && hp.length > 2) {
        o.push('<polygon points="' + pts(hp.map(uv)) + '" fill="' + fill + '" stroke="' + edge + '" stroke-width="' + (imagery ? 1.6 : 1) + '" stroke-linejoin="round"' + (imagery ? ' fill-opacity="0.35"' : "") + "/>");
      } else {
        var sp = SP(hp[0]), rr = Math.max(4, (type === "water" ? 14 : type === "tree" ? 7 : 6) * s);
        if (type === "tree" && !imagery) { o.push('<circle cx="' + f1(sp.x) + '" cy="' + f1(sp.y) + '" r="' + f1(rr) + '" fill="' + T.tree2 + '"/><circle cx="' + f1(sp.x + rr * 0.22) + '" cy="' + f1(sp.y + rr * 0.22) + '" r="' + f1(rr * 0.6) + '" fill="' + T.tree + '" opacity="0.3"/>'); return; }
        o.push('<circle cx="' + f1(sp.x) + '" cy="' + f1(sp.y) + '" r="' + f1(rr) + '" fill="' + fill + '" stroke="' + edge + '" stroke-width="1"' + (imagery ? ' fill-opacity="0.35"' : "") + "/>");
      }
    });

    // ---- greens (inactive ones first, dimmed)
    function greenShape(polyUV, C, wid, len, ang) {
      if (polyUV) return '<polygon points="' + pts(polyUV) + '" ';
      var gs = S(C);
      return '<ellipse cx="' + f1(gs.x) + '" cy="' + f1(gs.y) + '" rx="' + f1(wid / 2 * s) + '" ry="' + f1(len / 2 * s) + '" transform="rotate(' + f1(ang / D2R) + " " + f1(gs.x) + " " + f1(gs.y) + ')" ';
    }
    others.forEach(function (og) {
      var sh = greenShape(og.poly, og.C, og.wid, og.len, og.ang);
      if (imagery) o.push(sh + 'fill="none" stroke="' + T.text + '" stroke-width="1.3" stroke-dasharray="4 3" stroke-opacity="0.75"/>');
      else o.push('<g opacity="0.5">' + sh + 'fill="' + T.collar + '" stroke="' + T.collar + '" stroke-width="' + f1(Math.max(2, 3 * s)) + '" stroke-linejoin="round"/>' + sh + 'fill="' + T.green + '"/></g>');
      var oc = S(og.C);
      o.push('<circle cx="' + f1(oc.x) + '" cy="' + f1(oc.y) + '" r="1.8" fill="' + T.text + '" opacity="0.6"/>');
    });
    var gsvg = greenShape(gPolyUV, gC, gWid, gLen, gAng);
    if (imagery) o.push(gsvg + 'fill="none" stroke="' + T.text + '" stroke-width="1.6" stroke-opacity="0.9"/>');
    else {
      o.push(gsvg + 'fill="' + T.collar + '" stroke="' + T.collar + '" stroke-width="' + f1(Math.max(2, 3 * s)) + '" stroke-linejoin="round"/>');
      o.push(gsvg + 'fill="url(#' + id + 'gr)"/>');
    }

    // ---- tee pads (one small pad per tee, oriented with the first play segment)
    var dir0 = Math.atan2(lineUV[1].u - lineUV[0].u, lineUV[1].v - lineUV[0].v) / D2R;
    if (!imagery) allTees.forEach(function (t) {
      var sp = S(uv(t.p)), pw = Math.max(9, 11 * s), ph = Math.max(7, 7 * s);
      o.push('<rect x="' + f1(sp.x - pw / 2) + '" y="' + f1(sp.y - ph / 2) + '" width="' + f1(pw) + '" height="' + f1(ph) + '" rx="' + f1(Math.min(4, ph / 3)) +
        '" fill="' + T.tee + '" stroke="' + T.collar + '" transform="rotate(' + f1(dir0) + " " + f1(sp.x) + " " + f1(sp.y) + ')"/>');
    });

    // ---- label layout bookkeeping (all text is drawn last, on top)
    var boxes = [], lab = [];
    function hit(bx) { return bx.x0 < 4 || bx.x1 > W - 4 || bx.y0 < HEAD + 4 || bx.y1 > H - FOOT + 4 || boxes.some(function (q) { return !(bx.x1 < q.x0 || bx.x0 > q.x1 || bx.y1 < q.y0 || bx.y0 > q.y1); }); }
    function overlap(bx) {
      var sc = 0;
      boxes.forEach(function (q) { var ox = Math.min(bx.x1, q.x1) - Math.max(bx.x0, q.x0), oy = Math.min(bx.y1, q.y1) - Math.max(bx.y0, q.y0); if (ox > 0 && oy > 0) sc += ox * oy; });
      if (bx.x0 < 4 || bx.x1 > W - 4 || bx.y0 < HEAD + 4 || bx.y1 > H - FOOT + 4) sc += 1e6;
      return sc;
    }
    function boxAt(x, y, w, h, anchor) { var x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x; return { x0: x0, x1: x0 + w, y0: y - h / 2, y1: y + h / 2 }; }
    function textW(str, size) { var w = 0; for (var i = 0; i < str.length; i++) w += str.charCodeAt(i) > 0x2e80 ? size : size * 0.6; return w; }

    // obstacles: hazards, green, tees
    var hzScreen = (hole.hazards || []).map(function (h) {
      var hp = hazardPts(h); if (!hp.length) return null;
      var ds = hp.map(function (p) { return hav(pos || tee, p); });
      var sc = hp.map(SP), xs = sc.map(function (q) { return q.x; }), yy = sc.map(function (q) { return q.y; });
      var r = h.pt ? Math.max(4, 7 * s) : 0;
      var e = { type: h.type || "bunker", reach: Math.min.apply(null, ds), carry: Math.max.apply(null, ds),
        x0: Math.min.apply(null, xs) - r, x1: Math.max.apply(null, xs) + r, y0: Math.min.apply(null, yy) - r, y1: Math.max.apply(null, yy) + r };
      if (e.type !== "ob") boxes.push({ x0: e.x0, x1: e.x1, y0: e.y0, y1: e.y1 });
      return e;
    }).filter(Boolean);
    var fs = S(gC), sF = S(gF), sB = S(gB);
    var gExt = (gPolyUV || [gF, gB, { u: gC.u - gWid / 2, v: gC.v }, { u: gC.u + gWid / 2, v: gC.v }]).map(S);
    var gBox = { x0: Math.min.apply(null, gExt.map(function (q) { return q.x; })) - 3, x1: Math.max.apply(null, gExt.map(function (q) { return q.x; })) + 3,
      y0: Math.min.apply(null, gExt.map(function (q) { return q.y; })) - 22, y1: Math.max.apply(null, gExt.map(function (q) { return q.y; })) + 3 };
    boxes.push(gBox);
    var otherBoxes = others.map(function (og) {
      var ext = (og.poly || [og.F, og.B, { u: og.C.u - og.wid / 2, v: og.C.v }, { u: og.C.u + og.wid / 2, v: og.C.v }]).map(S);
      var bx = { x0: Math.min.apply(null, ext.map(function (q) { return q.x; })) - 3, x1: Math.max.apply(null, ext.map(function (q) { return q.x; })) + 3,
        y0: Math.min.apply(null, ext.map(function (q) { return q.y; })) - 3, y1: Math.max.apply(null, ext.map(function (q) { return q.y; })) + 3 };
      boxes.push(bx); return bx;
    });
    allTees.forEach(function (t) { var sp = S(uv(t.p)); boxes.push({ x0: sp.x - 6, x1: sp.x + 6, y0: sp.y - 6, y1: sp.y + 6 }); });

    // ---- distance arcs from tee
    var teeUV = lineUV[0];
    var arcEnds = [];
    arcsU.forEach(function (ru) {
      var rm = ru / uf;
      if (rm < 30 || rm > st.total_m - 18) return;
      var dir = null;
      for (var dd = 0; dd <= lineLen; dd += 2) { var ap = along(dd); if (Math.hypot(ap.u - teeUV.u, ap.v - teeUV.v) >= rm) { dir = Math.atan2(ap.u - teeUV.u, ap.v - teeUV.v); break; } }
      if (dir == null) return;
      var half = Math.min(0.6, 42 / rm), seg = [];
      for (var k = 0; k <= 28; k++) { var an = dir - half + (2 * half * k) / 28; seg.push({ u: teeUV.u + Math.sin(an) * rm, v: teeUV.v + Math.cos(an) * rm }); }
      o.push('<polyline points="' + pts(seg) + '" fill="none" stroke="' + T.gold + '" stroke-width="1.2" stroke-dasharray="3 4" stroke-linecap="round" opacity="0.9"/>');
      arcEnds.push({ ru: ru, R: S(seg[seg.length - 1]), L: S(seg[0]) });
    });

    // ---- play line + targets
    var playPts = pts(lineUV);
    o.push('<polyline points="' + playPts + '" fill="none" stroke="' + T.halo + '" stroke-opacity="0.45" stroke-width="3.2" stroke-linejoin="round"/>');
    o.push('<polyline points="' + playPts + '" fill="none" stroke="' + T.line + '" stroke-opacity="0.85" stroke-width="1.3" stroke-linejoin="round"/>');
    var accA = 0, targets = [];
    for (var ti = 1; ti < lineUV.length - 1; ti++) {
      accA += hav(line[ti - 1], line[ti]);
      var tsp = S(lineUV[ti]);
      o.push('<circle cx="' + f1(tsp.x) + '" cy="' + f1(tsp.y) + '" r="7" fill="none" stroke="' + T.gold + '" stroke-width="1.6"/><circle cx="' + f1(tsp.x) + '" cy="' + f1(tsp.y) + '" r="2" fill="' + T.gold + '"/>');
      boxes.push({ x0: tsp.x - 8, x1: tsp.x + 8, y0: tsp.y - 8, y1: tsp.y + 8 });
      targets.push({ p: tsp, d: accA, rem: st.total_m - accA });
    }

    // tee markers
    allTees.forEach(function (t) {
      var sp = S(uv(t.p)), sel = t.i === teeIdx || (teeIdx >= allTees.length && t.i === 0);
      var col = TEE_COLORS[t.label] || T.text;
      o.push('<circle cx="' + f1(sp.x) + '" cy="' + f1(sp.y) + '" r="' + (sel ? 4.6 : 3) + '" fill="' + col + '" stroke="' + (sel ? T.gold : T.halo) + '" stroke-width="' + (sel ? 1.8 : 1) + '"/>');
    });

    // flag + F/B dots
    o.push('<g><line x1="' + f1(fs.x) + '" y1="' + f1(fs.y) + '" x2="' + f1(fs.x) + '" y2="' + f1(fs.y - 20) + '" stroke="' + T.text + '" stroke-width="1.4"/>' +
      '<path d="M' + f1(fs.x) + "," + f1(fs.y - 20) + " l11,3.5 l-11,3.5 z" + '" fill="#e0483e"/><circle cx="' + f1(fs.x) + '" cy="' + f1(fs.y) + '" r="1.8" fill="' + T.text + '"/></g>');
    [sF, sB].forEach(function (q) { o.push('<circle cx="' + f1(q.x) + '" cy="' + f1(q.y) + '" r="2.2" fill="' + T.text + '" stroke="' + T.halo + '" stroke-width="1"/>'); });

    var fromPos = !!pos;
    var dF = fromPos ? hav(pos, g.front) : st.toFront_m, dC = fromPos ? hav(pos, g.center) : st.toCenter_m, dB = fromPos ? hav(pos, g.back) : st.toBack_m;

    // ---- golfer position (dot + line to pin + pill)
    if (pos) {
      var ps = SP(pos);
      if (ps.x > 0 && ps.x < W && ps.y > HEAD && ps.y < H - FOOT) {
        o.push('<line x1="' + f1(ps.x) + '" y1="' + f1(ps.y) + '" x2="' + f1(fs.x) + '" y2="' + f1(fs.y) + '" stroke="' + T.pos + '" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.95"/>');
        o.push('<circle cx="' + f1(ps.x) + '" cy="' + f1(ps.y) + '" r="11" fill="' + T.pos + '" opacity="0.22"/><circle cx="' + f1(ps.x) + '" cy="' + f1(ps.y) + '" r="5.5" fill="' + T.pos + '" stroke="#fff" stroke-width="2"/>');
        boxes.push({ x0: ps.x - 10, x1: ps.x + 10, y0: ps.y - 10, y1: ps.y + 10 });
        placePill([[ps.x + 14, ps.y, "start"], [ps.x - 14, ps.y, "end"], [ps.x + 14, ps.y + 18, "start"], [ps.x - 14, ps.y + 18, "end"]],
          String(dist(dC)), T.pos, L.C, true);
      }
    }

    // ---- F/C/B stack beside the green, cleared of obstacles
    (function () {
      var ys = [sB.y, fs.y, sF.y], minGap = 15;
      if (ys[1] - ys[0] < minGap) ys[0] = ys[1] - minGap;
      if (ys[2] - ys[1] < minGap) ys[2] = ys[1] + minGap;
      var rows = [["B", dB, 11], ["C", dC, 15], ["F", dF, 11]];
      var wmax = Math.max.apply(null, rows.map(function (r) { return textW(L[r[0]], 9) + 3 + textW(String(dist(r[1])), r[2]); })) + 4;
      var y0 = ys[0] - 11, y1 = ys[2] + 6;
      function tryX(side) {
        var x = side > 0 ? gBox.x1 + 7 : gBox.x0 - 7;
        for (var k = 0; k < 40; k++) {
          var bx = side > 0 ? { x0: x, x1: x + wmax, y0: y0, y1: y1 } : { x0: x - wmax, x1: x, y0: y0, y1: y1 };
          if (!hit(bx)) return { x: x, bx: bx };
          x += side * 4;
        }
        return null;
      }
      // two-green holes: put the active green's block on the side away from the inactive green
      var pref = 1;
      if (others.length) { var ox = 0; others.forEach(function (og) { ox += S(og.C).x; }); pref = ox / others.length > fs.x ? -1 : 1; }
      var side = pref, r = tryX(pref);
      if (!r) { side = -pref; r = tryX(-pref); }
      if (!r) {
        side = pref;
        r = pref > 0 ? { x: Math.min(W - wmax - 6, gBox.x1 + 7) } : { x: Math.max(wmax + 6, gBox.x0 - 7) };
        r.bx = pref > 0 ? { x0: r.x, x1: r.x + wmax, y0: y0, y1: y1 } : { x0: r.x - wmax, x1: r.x, y0: y0, y1: y1 };
      }
      boxes.push(r.bx);
      rows.forEach(function (e, k) {
        var big = e[0] === "C";
        lab.push(label(r.x, ys[k] + (big ? 5 : 4), String(dist(e[1])), e[2], big ? T.gold : T.text, side > 0 ? "start" : "end", big ? 800 : 600, L[e[0]]));
      });
    })();

    // ---- inactive green(s): small dim pill with side label + center distance
    others.forEach(function (og, k) {
      var bx = otherBoxes[k], oc = S(og.C), outer = oc.x < fs.x ? -1 : 1, cy = oc.y;
      var Rr = [bx.x1 + 5, cy, "start"], Ll = [bx.x0 - 5, cy, "end"];
      var cand = outer > 0 ? [Rr, Ll] : [Ll, Rr];
      cand.push([oc.x, bx.y0 - 11, "middle"], [oc.x, bx.y1 + 11, "middle"], [cand[0][0], cy + 16, cand[0][2]], [cand[0][0], cy - 16, cand[0][2]], [cand[1][0], cy + 16, cand[1][2]]);
      var d = pos ? hav(pos, og.g.center) : st.greens[og.i].toCenter_m;
      placePill(cand, String(dist(d)), T.muted, greenName(og.g, false), false);
    });

    // ---- target (dogleg) pills
    targets.forEach(function (t) {
      placePill([[t.p.x + 12, t.p.y, "start"], [t.p.x - 12, t.p.y, "end"], [t.p.x + 12, t.p.y + 18, "start"], [t.p.x - 12, t.p.y - 18, "end"], [t.p.x + 12, t.p.y - 18, "start"]],
        String(dist(t.d)), T.gold, L.rem(dist(t.rem)), true);
    });

    // ---- hazard pills: reach–carry, on the outer side of the hazard
    hzScreen.filter(function (h) { return h.type === "bunker" || h.type === "water"; }).forEach(function (h) {
      var cy = (h.y0 + h.y1) / 2, outer = (h.x0 + h.x1) / 2 >= S(along(Math.min(lineLen, Math.max(0, lineLen * 0.5)))).x ? 1 : -1;
      // outer side relative to the play line at this height
      var nearest = null, best = Infinity;
      for (var dd = 0; dd <= lineLen; dd += 4) { var q = S(along(dd)); if (Math.abs(q.y - cy) < best) { best = Math.abs(q.y - cy); nearest = q; } }
      if (nearest) outer = (h.x0 + h.x1) / 2 >= nearest.x ? 1 : -1;
      var R = [h.x1 + 6, cy, "start"], Lf = [h.x0 - 6, cy, "end"];
      var cand = outer > 0 ? [R, Lf] : [Lf, R];
      var hcx = (h.x0 + h.x1) / 2, c0 = cand[0], c1 = cand[1];
      [14, -14, 28, -28].forEach(function (dy) { cand.push([c0[0], cy + dy, c0[2]], [c1[0], cy + dy, c1[2]]); });
      cand.push([hcx, h.y1 + 12, "middle"], [hcx, h.y0 - 12, "middle"]);
      [42, -42, 56, -56, 70].forEach(function (dy) { cand.push([c0[0], cy + dy, c0[2]], [c1[0], cy + dy, c1[2]]); });
      var reach = dist(h.reach), carry = dist(h.carry);
      var col = h.type === "water" ? T.waterText : T.bunkerText;
      placePill(cand, String(carry), col, carry - reach > 2 ? String(reach) + "–" : null, false);
    });

    // ---- arc labels (pick the end that is free)
    arcEnds.forEach(function (a) {
      var t = String(a.ru), w = textW(t, 10) + 2;
      var c = [[a.R.x + 4, a.R.y, "start"], [a.L.x - 4, a.L.y, "end"]];
      for (var i = 0; i < c.length; i++) {
        var bx = boxAt(c[i][0], c[i][1], w, 12, c[i][2]);
        if (!hit(bx) || i === c.length - 1) { boxes.push(bx); lab.push(label(c[i][0], c[i][1] + 3.5, t, 10, T.gold, c[i][2], 700)); break; }
      }
    });

    o.push(lab.join(""));
    o.push("</g>");

    // green name: short "좌"/"Left"/"左", long "좌 그린"/"Left green"/"左グリーン"
    function greenName(gg, long) {
      var side = L.gside[gg.id] || gg.label || gg.id || "";
      if (!long) return side;
      return lang === "en" ? side + " green" : lang === "ja" ? side + "グリーン" : side + " 그린";
    }
    // net turn direction of the play line: -1 left, +1 right
    function doglegDir() {
      var t = 0;
      for (var i = 1; i < lineUV.length - 1; i++) { var a = lineUV[i - 1], m = lineUV[i], c = lineUV[i + 1]; t += (m.u - a.u) * (c.v - m.v) - (m.v - a.v) * (c.u - m.u); }
      return t > 0 ? -1 : 1;
    }
    // place a pill at the first candidate that does not collide (falls back to the first)
    function placePill(cands, main, col, small, smallAfter) {
      var w = pillW(main, small);
      for (var i = 0; i < cands.length; i++) {
        var bx = boxAt(cands[i][0], cands[i][1], w, 17, cands[i][2]);
        if (!hit(bx)) { boxes.push(bx); lab.push(pill(cands[i][0], cands[i][1], main, cands[i][2], col, small, smallAfter)); return; }
      }
      // nothing is free: take the candidate with the least overlap
      var bestI = 0, bestS = Infinity;
      cands.forEach(function (c, i) { var sc = overlap(boxAt(c[0], c[1], w, 17, c[2])); if (sc < bestS) { bestS = sc; bestI = i; } });
      var c0 = cands[bestI]; boxes.push(boxAt(c0[0], c0[1], w, 17, c0[2])); lab.push(pill(c0[0], c0[1], main, c0[2], col, small, smallAfter));
    }
    function pillW(main, small) { return textW(main, 11) + (small ? textW(small, 8.5) + 4 : 0) + 12; }
    function pill(x, y, main, anchor, col, small, smallAfter) {
      var w = pillW(main, small), x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      var sm = small ? '<tspan font-size="8.5" font-weight="500" fill="' + T.muted + '"' + (smallAfter ? ' dx="4"' : "") + ">" + esc(small) + "</tspan>" : "";
      var mn = '<tspan' + (small && !smallAfter ? ' dx="2"' : "") + ">" + esc(main) + "</tspan>";
      return '<g><rect x="' + f1(x0) + '" y="' + f1(y - 8.5) + '" width="' + f1(w) + '" height="17" rx="8.5" fill="' + T.panel + '" stroke="' + col + '" stroke-opacity="0.6" stroke-width="1"/>' +
        '<text x="' + f1(x0 + 6) + '" y="' + f1(y + 3.8) + '" font-size="11" font-weight="700" fill="' + col + '">' + (smallAfter ? mn + sm : sm + mn) + "</text></g>";
    }

    // ---- header
    var title = L.hole(hole.n) + " · " + L.par + " " + (hole.par || "") + " · " + dist(st.total_m) + (lang === "en" ? " " : "") + units +
      (allGreens.length > 1 ? " · " + greenName(g, true) : "");
    var titleSize = Math.min(19, Math.floor((W - 18 - 66) / Math.max(1, textW(title, 1.04)) * 10) / 10);
    var teeName = (allTees[teeIdx] || allTees[0] || {}).label || "";
    var teeTxt = lang === "en" ? (teeName ? teeName.charAt(0).toUpperCase() + teeName.slice(1) + " tee" : "Tee") : ((L.tees[teeName] || teeName) + " " + L.tee).trim();
    o.push('<rect width="' + W + '" height="' + (HEAD + 14) + '" fill="url(#' + id + 'hd)"/>');
    o.push('<text x="18" y="31" font-size="' + titleSize + '" font-weight="800" fill="' + T.gold + '" letter-spacing="0.2">' + esc(title) + "</text>");
    var sub = (fromPos ? L.you : teeTxt) + "  ·  " + L.F + " " + dist(dF) + "  ·  " + L.C + " " + dist(dC) + "  ·  " + L.B + " " + dist(dB);
    o.push('<text x="18" y="53" font-size="11.5" font-weight="500" fill="' + (fromPos ? T.pos : T.muted) + '">' + esc(sub) + "</text>");
    var badge = (hole.nine || "") + (st.dogleg ? "" : "");
    if (badge) {
      o.push('<rect x="' + (W - 54) + '" y="16" width="38" height="20" rx="10" fill="none" stroke="' + T.gold + '" stroke-opacity="0.7"/>');
      o.push('<text x="' + (W - 35) + '" y="30" font-size="10.5" font-weight="700" fill="' + T.gold + '" text-anchor="middle" letter-spacing="0.8">' + esc(badge) + "</text>");
    }

    // ---- footer: scale bar + north arrow
    o.push('<rect y="' + (H - FOOT - 14) + '" width="' + W + '" height="' + (FOOT + 14) + '" fill="url(#' + id + 'ft)"/>');
    var target = 90 / s * uf, nice = [10, 20, 25, 50, 100, 200, 500], len = nice[0];
    nice.forEach(function (n) { if (n <= target) len = n; });
    var lpx2 = len / uf * s, by = H - 22;
    o.push('<g><rect x="18" y="' + (by - 3) + '" width="' + f1(lpx2 / 2) + '" height="4" fill="' + T.text + '"/><rect x="' + f1(18 + lpx2 / 2) + '" y="' + (by - 3) + '" width="' + f1(lpx2 / 2) + '" height="4" fill="none" stroke="' + T.text + '" stroke-width="1"/>' +
      label(18, by - 8, "0", 9, T.muted, "start", 500) + label(18 + lpx2, by - 8, len + (lang === "en" ? " " : "") + units, 9, T.muted, "middle", 600) + "</g>");
    var nx2 = W - 28, ny2 = H - 25, rot = -b / D2R;
    o.push('<g transform="translate(' + nx2 + "," + ny2 + ") rotate(" + f1(rot) + ')"><circle r="12" fill="none" stroke="' + T.muted + '" stroke-opacity="0.6"/>' +
      '<path d="M0,-10 L4.5,3 L0,0.5 L-4.5,3 Z" fill="' + T.gold + '"/><text y="-14" font-size="9" font-weight="800" fill="' + T.gold + '" text-anchor="middle" transform="rotate(' + f1(-rot) + ' 0 -17)">N</text></g>');
    if (st.dogleg) o.push(label(W - 48, H - 22, (L.dogleg) + (doglegDir() < 0 ? " ◀" : " ▶"), 9.5, T.muted, "end", 600));
    o.push("</svg>");
    return o.join("");

    // ---- helpers bound to theme
    function label(x, y, txt, size, fill, anchor, weight, prefix) {
      var t = esc(txt);
      if (prefix) t = '<tspan font-size="' + Math.max(8.5, Math.round(size * 0.66)) + '" font-weight="600" fill="' + T.muted + '">' + esc(prefix) + '</tspan><tspan dx="3">' + t + "</tspan>";
      return '<text x="' + f1(x) + '" y="' + f1(y) + '" font-size="' + size + '" font-weight="' + (weight || 600) + '" fill="' + fill + '" text-anchor="' + (anchor || "start") +
        '" stroke="' + T.halo + '" stroke-width="3" stroke-linejoin="round" paint-order="stroke" stroke-opacity="0.85">' + t + "</text>";
    }
  }

  /* ---------------------------------------------------------- PNG */
  function blobToDataURL(blob) {
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsDataURL(blob); });
  }
  function toPNG(svgString, scale) {
    scale = scale || 2;
    return new Promise(function (resolve, reject) {
      if (typeof document === "undefined") return reject(new Error("Yardage.toPNG requires a browser (document/canvas)"));
      // SVG rendered via <img> cannot load external resources: inline every <image href> as a data: URL first.
      var re = /<image\b[^>]*?\bhref="([^"]+)"/g, urls = {}, m;
      while ((m = re.exec(svgString))) if (!/^data:/.test(m[1])) urls[m[1].replace(/&amp;/g, "&")] = null;
      var list = Object.keys(urls);
      Promise.all(list.map(function (u) {
        return fetch(u, { mode: "cors", credentials: "omit" }).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.blob();
        }).then(blobToDataURL).then(function (d) { urls[u] = d; }).catch(function (e) {
          throw new Error("Yardage.toPNG: imagery tile could not be fetched with CORS (" + u + "): " + (e && e.message ? e.message : e) +
            ". The tile host must send Access-Control-Allow-Origin, and CSP connect-src/img-src must allow it.");
        });
      })).then(function () {
        var svg = svgString.replace(/(<image\b[^>]*?\bhref=")([^"]+)(")/g, function (all, a, u, c) { var k = u.replace(/&amp;/g, "&"); return urls[k] ? a + urls[k] + c : all; });
        var wm = /<svg[^>]*\bwidth="([\d.]+)"/.exec(svg), hm = /<svg[^>]*\bheight="([\d.]+)"/.exec(svg);
        var w = wm ? +wm[1] : 360, h = hm ? +hm[1] : 640;
        var url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
        var img = new Image();
        img.onload = function () {
          try {
            var cv = document.createElement("canvas"); cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
            var ctx = cv.getContext("2d"); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(url);
            cv.toBlob(function (b) { b ? resolve(b) : reject(new Error("Yardage.toPNG: canvas.toBlob returned null (tainted canvas?)")); }, "image/png");
          } catch (e) { URL.revokeObjectURL(url); reject(new Error("Yardage.toPNG: canvas export failed (" + e.message + ")")); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Yardage.toPNG: SVG could not be rasterized (check CSP img-src allows blob:)")); };
        img.src = url;
      }).catch(reject);
    });
  }

  var api = { renderHole: renderHole, holeStats: holeStats, toPNG: toPNG, _internal: { hav: hav, playLine: playLine } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Yardage = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
