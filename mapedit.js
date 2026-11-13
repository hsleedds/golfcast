/*!
 * MapEdit — Roundcast course map editor (standalone, dependency-free)
 * window.MapEdit = { mount(el, opts), getData(), setData(d) }
 *
 * Renderer: a built-in slippy map (tiles + drag-pan + pinch/wheel zoom + markers +
 * SVG polylines/polygons) is the PRIMARY renderer. Leaflet 1.9.4 can be used instead
 * with opts.renderer = "leaflet"; it is lazy-loaded from cdnjs and falls back to the
 * built-in renderer if it cannot load. No inline handlers, no injected <style>, no eval.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ geo */
  var R = 6371008.8, D2R = Math.PI / 180;
  function rnd(v) { return Math.round(v * 1e7) / 1e7; }
  function LL(lat, lon) { return { lat: rnd(lat), lon: rnd(lon) }; }
  function P(p) { // {lat,lon} | [lat,lon] -> {lat,lon} | null
    if (!p) return null;
    if (Array.isArray(p)) return (isFinite(p[0]) && isFinite(p[1])) ? { lat: +p[0], lon: +p[1] } : null;
    if (isFinite(p.lat) && isFinite(p.lon != null ? p.lon : p.lng)) return { lat: +p.lat, lon: +(p.lon != null ? p.lon : p.lng) };
    return null;
  }
  function dist(a, b) {
    a = P(a); b = P(b);
    var dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function xy(p, o) { p = P(p); return [(p.lon - o.lon) * D2R * R * Math.cos(o.lat * D2R), (p.lat - o.lat) * D2R * R]; }
  function unxy(v, o) { return { lat: o.lat + v[1] / R / D2R, lon: o.lon + v[0] / (R * Math.cos(o.lat * D2R)) / D2R }; }
  function along(from, to, m) { // point m metres from `to` continuing in direction from->to (negative = back toward from)
    var o = P(to), a = xy(from, o), len = Math.hypot(a[0], a[1]) || 1;
    return unxy([-a[0] / len * m, -a[1] / len * m], o);
  }
  function centroid(ring) {
    var pts = ring.map(P); if (!pts.length) return null;
    var o = pts[0], A = 0, cx = 0, cy = 0, v = pts.map(function (p) { return xy(p, o); });
    for (var i = 0; i < v.length; i++) {
      var p = v[i], q = v[(i + 1) % v.length], f = p[0] * q[1] - q[0] * p[1];
      A += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
    }
    if (Math.abs(A) < 1e-6) { // degenerate: mean
      var sx = 0, sy = 0; v.forEach(function (p) { sx += p[0]; sy += p[1]; });
      return unxy([sx / v.length, sy / v.length], o);
    }
    return unxy([cx / (3 * A), cy / (3 * A)], o);
  }
  function pip(pt, ring) {
    pt = P(pt); var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = P(ring[i]), b = P(ring[j]);
      if (((a.lat > pt.lat) !== (b.lat > pt.lat)) &&
        (pt.lon < (b.lon - a.lon) * (pt.lat - a.lat) / (b.lat - a.lat) + a.lon)) inside = !inside;
    }
    return inside;
  }
  function segDist(p, a, b, o) {
    var P0 = xy(p, o), A = xy(a, o), B = xy(b, o), dx = B[0] - A[0], dy = B[1] - A[1];
    var L2 = dx * dx + dy * dy, t = L2 ? ((P0[0] - A[0]) * dx + (P0[1] - A[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(P0[0] - A[0] - t * dx, P0[1] - A[1] - t * dy);
  }
  function lineDist(p, line) {
    var o = P(p);
    if (line.length === 1) return dist(p, line[0]);
    var m = Infinity;
    for (var i = 0; i < line.length - 1; i++) m = Math.min(m, segDist(p, line[i], line[i + 1], o));
    return m;
  }
  function pathLen(pts) { var s = 0; for (var i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

  /* ------------------------------------------------------------ mercator */
  function projW(lat, lon, z) {
    var s = 256 * Math.pow(2, z), sin = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
    return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function unprojW(x, y, z) {
    var s = 256 * Math.pow(2, z), n = Math.PI - 2 * Math.PI * y / s;
    return { lat: Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) / D2R, lon: x / s * 360 - 180 };
  }
  function tileUrl(layer, z, x, y) {
    return layer.url.replace('{z}', z).replace('{x}', x).replace('{y}', y)
      .replace('{s}', 'abc'.charAt((x + y) % 3)).replace('{key}', encodeURIComponent(layer.key || ''));
  }

  /* ----------------------------------------------------------------- dom */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ================================================= built-in slippy map */
  function createBuiltinMap(el, o) {
    o = o || {};
    el.classList.add('me-map', 'me-map-builtin');
    var tilePane = h('div', { class: 'me-tiles' }), mkPane = h('div', { class: 'me-markers' });
    var svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'me-svg');
    var attr = h('div', { class: 'me-attr' });
    el.appendChild(tilePane); el.appendChild(svg); el.appendChild(mkPane); el.appendChild(attr);

    var st = { c: { lat: 37.5665, lon: 126.978 }, z: 16, minZ: o.minZoom || 5, maxZ: o.maxZoom || 21, w: 0, h: 0, tl: [0, 0] };
    var layer = null, layerId = 0, tiles = new Map(), markers = new Set(), shapes = new Set();
    var clickFns = [], viewFns = [], raf = 0;

    function size() { st.w = el.clientWidth || 1; st.h = el.clientHeight || 1; }
    function calcTL() { var c = projW(st.c.lat, st.c.lon, st.z); st.tl = [c[0] - st.w / 2, c[1] - st.h / 2]; }
    function toPt(ll) { ll = P(ll); var w = projW(ll.lat, ll.lon, st.z); return [w[0] - st.tl[0], w[1] - st.tl[1]]; }
    function toLL(x, y) { return unprojW(st.tl[0] + x, st.tl[1] + y, st.z); }
    function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; render(); }); }

    function render() {
      size(); calcTL();
      svg.setAttribute('width', st.w); svg.setAttribute('height', st.h);
      svg.setAttribute('viewBox', '0 0 ' + st.w + ' ' + st.h);
      if (layer) renderTiles();
      markers.forEach(function (m) { m._pos(); });
      shapes.forEach(function (s) { s._draw(); });
      viewFns.forEach(function (f) { f(); });
    }
    function renderTiles() {
      var mz = layer.maxZoom || 19, tz = clamp(Math.round(st.z), 0, mz), s = Math.pow(2, st.z - tz), ts = 256 * s;
      var n = Math.pow(2, tz);
      var x0 = Math.floor(st.tl[0] / ts), x1 = Math.floor((st.tl[0] + st.w) / ts);
      var y0 = Math.max(0, Math.floor(st.tl[1] / ts)), y1 = Math.min(n - 1, Math.floor((st.tl[1] + st.h) / ts));
      var need = new Set(), allLoaded = true;
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
        var key = layerId + '/' + tz + '/' + x + '/' + y, t = tiles.get(key);
        if (!t) t = addTile(key, tz, x, y, n);
        need.add(key); if (!t.loaded && !t.failed) allLoaded = false;
      }
      tiles.forEach(function (t, key) {
        if (t.lid !== layerId || (!need.has(key) && (t.z === tz || allLoaded || Math.abs(t.z - tz) > 2))) {
          t.img.remove(); tiles.delete(key); return;
        }
        var sz = 256 * Math.pow(2, st.z - t.z), px = t.x * sz - st.tl[0], py = t.y * sz - st.tl[1];
        if (px > st.w || py > st.h || px + sz < 0 || py + sz < 0) { t.img.remove(); tiles.delete(key); return; }
        t.img.style.transform = 'translate3d(' + px + 'px,' + py + 'px,0)';
        t.img.style.width = t.img.style.height = (sz + 0.5) + 'px';
        t.img.style.zIndex = t.z === tz ? 2 : 1;
      });
    }
    function addTile(key, z, x, y, n) {
      var img = new Image(), t = { img: img, z: z, x: x, y: y, lid: layerId, loaded: false };
      img.className = 'me-tile'; img.alt = ''; img.draggable = false; img.decoding = 'async';
      img.addEventListener('load', function () { t.loaded = true; img.classList.add('on'); schedule(); });
      img.addEventListener('error', function () { t.failed = true; schedule(); });
      img.src = tileUrl(layer, z, ((x % n) + n) % n, y);
      tilePane.appendChild(img); tiles.set(key, t);
      return t;
    }

    function setZoomAround(z, px, py) {
      z = clamp(z, st.minZ, st.maxZ);
      var ll = toLL(px, py), w = projW(ll.lat, ll.lon, z);
      st.z = z; st.c = unprojW(w[0] - px + st.w / 2, w[1] - py + st.h / 2, z); calcTL(); schedule();
    }
    function panBy(dx, dy) {
      var c = projW(st.c.lat, st.c.lon, st.z);
      st.c = unprojW(c[0] + dx, c[1] + dy, st.z); calcTL(); schedule();
    }

    /* gestures */
    var ptrs = new Map(), g = null;
    function local(e) { var r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    el.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
      var p = local(e); ptrs.set(e.pointerId, p);
      if (ptrs.size === 1) g = { moved: false, pinch: false, s: p, l: p, t: Date.now() };
      else if (ptrs.size === 2) startPinch();
    });
    function startPinch() {
      var a = Array.from(ptrs.values()), mid = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
      g.pinch = true; g.d0 = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]) || 1; g.z0 = st.z; g.ll0 = toLL(mid[0], mid[1]);
    }
    el.addEventListener('pointermove', function (e) {
      if (!ptrs.has(e.pointerId) || !g) return;
      var p = local(e); ptrs.set(e.pointerId, p);
      if (ptrs.size === 1 && !g.pinch) {
        if (!g.moved && Math.hypot(p[0] - g.s[0], p[1] - g.s[1]) > 6) { g.moved = true; el.classList.add('me-grabbing'); }
        if (g.moved) { panBy(g.l[0] - p[0], g.l[1] - p[1]); g.l = p; }
      } else if (ptrs.size >= 2) {
        var a = Array.from(ptrs.values()), mid = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
        var d = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]) || 1;
        var z = clamp(g.z0 + Math.log2(d / g.d0), st.minZ, st.maxZ), w = projW(g.ll0.lat, g.ll0.lon, z);
        st.z = z; st.c = unprojW(w[0] - mid[0] + st.w / 2, w[1] - mid[1] + st.h / 2, z); calcTL(); schedule();
      }
    });
    function up(e) {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size === 1 && g) { g.l = Array.from(ptrs.values())[0]; g.moved = true; }
      if (ptrs.size === 0 && g) {
        el.classList.remove('me-grabbing');
        if (e.type === 'pointerup' && !g.moved && !g.pinch && Date.now() - g.t < 700) {
          var p = local(e), ll = toLL(p[0], p[1]);
          clickFns.forEach(function (f) { f({ lat: ll.lat, lon: ll.lon }); });
        }
        g = null;
      }
    }
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dz = -e.deltaY * (e.deltaMode === 1 ? 0.12 : 0.004);
      var p = local(e); setZoomAround(st.z + clamp(dz, -1, 1), p[0], p[1]);
    }, { passive: false });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    if (window.ResizeObserver) new ResizeObserver(schedule).observe(el); else window.addEventListener('resize', schedule);

    /* overlays */
    function marker(ll, mo) {
      mo = mo || {};
      var wrap = h('div', { class: 'me-mk ' + (mo.cls || '') + (mo.interactive || mo.draggable ? '' : ' me-mk-static'), title: mo.title || null });
      var inner = h('div', { class: 'me-mk-i', text: mo.label || '' });
      wrap.appendChild(inner);
      if (mo.caption) wrap.appendChild(h('div', { class: 'me-mk-cap', text: mo.caption }));
      mkPane.appendChild(wrap);
      var m = { ll: P(ll), el: wrap };
      m._pos = function () { var p = toPt(m.ll); wrap.style.transform = 'translate3d(' + p[0] + 'px,' + p[1] + 'px,0)'; };
      m.set = function (v) { m.ll = P(v); m._pos(); };
      m.remove = function () { wrap.remove(); markers.delete(m); };
      if (mo.draggable || mo.interactive) {
        var d = null;
        wrap.addEventListener('pointerdown', function (e) {
          if (e.button > 0) return;
          e.stopPropagation(); e.preventDefault();
          try { wrap.setPointerCapture(e.pointerId); } catch (_) { /* */ }
          var q = local(e), p = toPt(m.ll);
          d = { id: e.pointerId, moved: false, s: q, off: [p[0] - q[0], p[1] - q[1]] };
        });
        wrap.addEventListener('pointermove', function (e) {
          if (!d || d.id !== e.pointerId || !mo.draggable) return;
          var q = local(e);
          if (!d.moved) { if (Math.hypot(q[0] - d.s[0], q[1] - d.s[1]) < 4) return; d.moved = true; wrap.classList.add('me-dragging'); if (mo.onDragStart) mo.onDragStart(); }
          var ll2 = toLL(q[0] + d.off[0], q[1] + d.off[1]); m.ll = ll2; m._pos();
          if (mo.onDrag) mo.onDrag({ lat: ll2.lat, lon: ll2.lon });
        });
        var end = function (e) {
          if (!d || d.id !== e.pointerId) return;
          var moved = d.moved; d = null; wrap.classList.remove('me-dragging');
          if (moved) { if (mo.onDragEnd) mo.onDragEnd({ lat: m.ll.lat, lon: m.ll.lon }); }
          else if (e.type === 'pointerup' && mo.onClick) mo.onClick();
        };
        wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
      }
      markers.add(m); m._pos();
      return m;
    }
    function shape(pts, so) {
      so = so || {};
      var path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'me-shp ' + (so.cls || '') + (so.kind === 'poly' ? ' me-poly' : ' me-line'));
      svg.appendChild(path);
      var s = { pts: pts.map(P) };
      s._draw = function () {
        if (!s.pts.length) { path.setAttribute('d', ''); return; }
        var d = s.pts.map(function (p, i) { var q = toPt(p); return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('');
        path.setAttribute('d', d + (so.kind === 'poly' ? 'Z' : ''));
      };
      s.set = function (v) { s.pts = v.map(P); s._draw(); };
      s.remove = function () { path.remove(); shapes.delete(s); };
      shapes.add(s); s._draw();
      return s;
    }

    size(); calcTL();
    return {
      kind: 'builtin',
      setLayer: function (l) { layer = l; layerId++; attr.textContent = l && l.attribution ? l.attribution : ''; schedule(); },
      setView: function (ll, z) { st.c = P(ll); if (z != null) st.z = clamp(z, st.minZ, st.maxZ); size(); calcTL(); schedule(); },
      getCenter: function () { return { lat: st.c.lat, lon: st.c.lon }; },
      getZoom: function () { return st.z; },
      zoomBy: function (d) { size(); setZoomAround(st.z + d, st.w / 2, st.h / 2); },
      fitBounds: function (pts, pad, maxZ) {
        pts = pts.map(P).filter(Boolean); if (!pts.length) return;
        size(); pad = pad == null ? 40 : pad;
        var pd = Array.isArray(pad) ? pad : [pad, pad, pad, pad]; // top, right, bottom, left
        var w = pts.map(function (p) { return projW(p.lat, p.lon, 0); });
        var xs = w.map(function (v) { return v[0]; }), ys = w.map(function (v) { return v[1]; });
        var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs), miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
        var zx = Math.log2(Math.max(1, st.w - pd[1] - pd[3]) / Math.max(1e-9, maxx - minx));
        var zy = Math.log2(Math.max(1, st.h - pd[0] - pd[2]) / Math.max(1e-9, maxy - miny));
        st.z = clamp(Math.min(zx, zy, maxZ || 18), st.minZ, st.maxZ);
        var k = Math.pow(2, st.z), cx = (minx + maxx) / 2 * k + (pd[1] - pd[3]) / 2, cy = (miny + maxy) / 2 * k + (pd[2] - pd[0]) / 2;
        st.c = unprojW(cx, cy, st.z); calcTL(); schedule();
      },
      onClick: function (f) { clickFns.push(f); },
      onView: function (f) { viewFns.push(f); },
      marker: marker, shape: shape,
      project: function (ll) { size(); calcTL(); return toPt(ll); },
      unproject: function (x, y) { return toLL(x, y); },
      renderNow: render, invalidate: schedule,
      destroy: function () { el.innerHTML = ''; }
    };
  }

  /* ================================================ Leaflet adapter (opt) */
  var LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  function loadLeaflet(o) {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    return new Promise(function (resolve, reject) {
      var base = o.leafletBase || LEAFLET, sri = o.leafletSri || {};
      var link = h('link', { rel: 'stylesheet', href: base + 'leaflet.min.css', crossorigin: 'anonymous', integrity: sri.css || null, referrerpolicy: 'no-referrer' });
      var s = h('script', { src: base + 'leaflet.min.js', crossorigin: 'anonymous', integrity: sri.js || null, referrerpolicy: 'no-referrer' });
      var to = setTimeout(function () { reject(new Error('timeout')); }, o.leafletTimeout || 8000);
      s.addEventListener('load', function () { clearTimeout(to); window.L ? resolve(window.L) : reject(new Error('no L')); });
      s.addEventListener('error', function () { clearTimeout(to); reject(new Error('load error')); });
      document.head.appendChild(link); document.head.appendChild(s);
    });
  }
  function createLeafletMap(el, o) {
    var L = window.L; el.classList.add('me-map', 'me-map-leaflet');
    var map = L.map(el, { zoomControl: false, maxZoom: 21, minZoom: 5, zoomSnap: 0.25, doubleClickZoom: false });
    var tl = null, clickFns = [], viewFns = [];
    map.on('click', function (e) { clickFns.forEach(function (f) { f({ lat: e.latlng.lat, lon: e.latlng.lng }); }); });
    map.on('move zoom', function () { viewFns.forEach(function (f) { f(); }); });
    function ll2(p) { p = P(p); return [p.lat, p.lon]; }
    return {
      kind: 'leaflet',
      setLayer: function (l) {
        if (tl) map.removeLayer(tl);
        tl = L.tileLayer(l.url.replace('{key}', encodeURIComponent(l.key || '')), { maxNativeZoom: l.maxZoom || 19, maxZoom: 21, attribution: l.attribution || '' }).addTo(map);
      },
      setView: function (p, z) { map.setView(ll2(p), z == null ? map.getZoom() : z, { animate: false }); },
      getCenter: function () { var c = map.getCenter(); return { lat: c.lat, lon: c.lng }; },
      getZoom: function () { return map.getZoom(); },
      zoomBy: function (d) { map.setZoom(map.getZoom() + d); },
      fitBounds: function (pts, pad, maxZ) { pts = pts.map(P).filter(Boolean); var pd = Array.isArray(pad) ? pad : [pad || 40, pad || 40, pad || 40, pad || 40]; if (pts.length) map.fitBounds(pts.map(ll2), { paddingTopLeft: [pd[3], pd[0]], paddingBottomRight: [pd[1], pd[2]], maxZoom: maxZ || 18, animate: false }); },
      onClick: function (f) { clickFns.push(f); },
      onView: function (f) { viewFns.push(f); },
      marker: function (p, mo) {
        mo = mo || {};
        var box = h('div', { class: 'me-mk ' + (mo.cls || '') + (mo.interactive || mo.draggable ? '' : ' me-mk-static') }, [h('div', { class: 'me-mk-i', text: mo.label || '' }), mo.caption ? h('div', { class: 'me-mk-cap', text: mo.caption }) : null]);
        var m = L.marker(ll2(p), { icon: L.divIcon({ className: 'me-lmk', html: box, iconSize: null }), draggable: !!mo.draggable, interactive: !!(mo.interactive || mo.draggable), keyboard: false }).addTo(map);
        var cv = function (e) { var q = e.target.getLatLng(); return { lat: q.lat, lon: q.lng }; };
        if (mo.onDragStart) m.on('dragstart', mo.onDragStart);
        if (mo.onDrag) m.on('drag', function (e) { mo.onDrag(cv(e)); });
        if (mo.onDragEnd) m.on('dragend', function (e) { mo.onDragEnd(cv(e)); });
        if (mo.onClick) m.on('click', function (e) { L.DomEvent.stopPropagation(e); mo.onClick(); });
        return { el: box, set: function (v) { m.setLatLng(ll2(v)); }, remove: function () { m.remove(); } };
      },
      shape: function (pts, so) {
        so = so || {};
        var cls = 'me-shp ' + (so.cls || '') + (so.kind === 'poly' ? ' me-poly' : ' me-line');
        var s = (so.kind === 'poly' ? L.polygon : L.polyline)(pts.map(ll2), { className: cls, interactive: false }).addTo(map);
        return { set: function (v) { s.setLatLngs(v.map(ll2)); }, remove: function () { s.remove(); } };
      },
      project: function (p) { var q = map.latLngToContainerPoint(ll2(p)); return [q.x, q.y]; },
      unproject: function (x, y) { var q = map.containerPointToLatLng([x, y]); return { lat: q.lat, lon: q.lng }; },
      renderNow: function () { map.invalidateSize(false); }, invalidate: function () { map.invalidateSize(false); },
      destroy: function () { map.remove(); }
    };
  }

  /* ============================================================ data model */
  var PARS = [3, 4, 5, 6];
  var HZ = { bunker: 1, water: 1, ob: 1 };
  var TEE_LABELS = ['블루', '화이트', '레드', '블랙', '골드', '그린'];
  var TEE_COLORS = { black: '블랙', blue: '블루', white: '화이트', red: '레드', gold: '골드', yellow: '골드', green: '그린', silver: '실버', champion: '블랙', back: '블랙', regular: '화이트', ladies: '레드' };

  function emptyHole(n) { return { n: n, par: null, tees: [], green: { front: null, center: null, back: null }, path: [], hazards: [], src: 'user' }; }
  function emptyNine(name) { var hs = []; for (var i = 1; i <= 9; i++) hs.push(emptyHole(i)); return { name: name, holes: hs }; }
  function normPt(p) { p = P(p); return p ? LL(p.lat, p.lon) : null; }
  function normRing(r) { return Array.isArray(r) ? r.map(P).filter(Boolean).map(function (p) { return [rnd(p.lat), rnd(p.lon)]; }) : null; }
  /* 투그린: HOLE.greens = [{id:"L",label:"좌",...},{id:"R",label:"우",...}] only when two greens; HOLE.green mirrors greens[0]. */
  var TWIN = [{ id: 'L', label: '좌' }, { id: 'R', label: '우' }];
  function normGreen(g) {
    g = g || {};
    var o = { front: normPt(g.front), center: normPt(g.center), back: normPt(g.back) };
    var poly = normRing(g.poly); if (poly && poly.length >= 3) o.poly = poly;
    return o;
  }
  function syncGreen(hl) { // HOLE.green := copy of greens[0]
    if (!hl.greens) return;
    var g0 = hl.greens[0];
    hl.green = { front: g0.front, center: g0.center, back: g0.back };
    if (g0.poly) hl.green.poly = g0.poly;
  }
  function addTwin(hl) { // single green -> 좌 green, empty 우 green
    if (hl.greens) return false;
    hl.greens = [copyGreen(hl.green, { id: 'L', label: '좌' }), { id: 'R', label: '우', front: null, center: null, back: null }];
    syncGreen(hl); return true;
  }
  function dropTwin(hl) { if (!hl.greens) return; hl.green = copyGreen(hl.greens[0]); delete hl.greens; }
  /* club greenMode "one": no hole has greens. "two": every hole has greens unless hole.oneGreen. */
  function conformHole(hl, mode) {
    if (mode === 'two') { if (hl.oneGreen) dropTwin(hl); else addTwin(hl); }
    else { dropTwin(hl); delete hl.oneGreen; }
  }
  function G(hl, side) { return hl.greens ? hl.greens[side ? 1 : 0] : hl.green; }
  function sides(hl) { return hl.greens ? [0, 1] : [0]; }
  function copyGreen(g, extra) {
    var o = extra || {};
    o.front = g.front; o.center = g.center; o.back = g.back;
    if (g.poly) o.poly = g.poly.map(function (p) { return p.slice(); });
    return o;
  }
  function normHole(src, n) {
    var hl = emptyHole(n); if (!src) return hl;
    hl.par = PARS.indexOf(+src.par) >= 0 ? +src.par : null;
    hl.tees = (src.tees || []).map(function (t, i) { var p = normPt(t); return p && { lat: p.lat, lon: p.lon, label: String(t.label || TEE_LABELS[i] || ('티' + (i + 1))) }; }).filter(Boolean);
    hl.green = normGreen(src.green);
    if (Array.isArray(src.greens) && src.greens.length >= 2) {
      hl.greens = [0, 1].map(function (i) { var sg = src.greens[i] || {}, g = normGreen(sg); g.id = TWIN[i].id; g.label = String(sg.label || TWIN[i].label); return g; });
      syncGreen(hl);
    }
    hl.path = normRing(src.path) || [];
    hl.hazards = (src.hazards || []).map(function (z) {
      if (!z || !HZ[z.type]) return null;
      var ring = normRing(z.poly); if (ring && ring.length >= 3) return { type: z.type, poly: ring };
      var p = normPt(z.pt); return p ? { type: z.type, pt: p } : null;
    }).filter(Boolean);
    hl.src = src.src === 'osm' ? 'osm' : 'user';
    if (src.oneGreen === true) hl.oneGreen = true;
    return hl;
  }
  function normalize(d, o) {
    d = d || {}; o = o || {};
    var out = { v: 1, club: String(d.club || o.club || ''), greenMode: d.greenMode === 'two' ? 'two' : 'one', center: normPt(d.center) || normPt(o.center) || null, updated: d.updated || new Date().toISOString(), nines: [] };
    var nines = Array.isArray(d.nines) && d.nines.length ? d.nines : (o.nineNames || ['OUT', 'IN']).map(function (n) { return { name: n }; });
    nines.forEach(function (nn, ni) {
      var srcH = Array.isArray(nn.holes) ? nn.holes : [], holes = [];
      for (var i = 1; i <= 9; i++) {
        var s = srcH.filter(function (x) { return x && +x.n === i; })[0] || (srcH[i - 1] && srcH[i - 1].n == null ? srcH[i - 1] : null);
        holes.push(normHole(s, i));
      }
      holes.forEach(function (hl) { conformHole(hl, out.greenMode); });
      out.nines.push({ name: String(nn.name || ('코스' + (ni + 1))), holes: holes });
    });
    return out;
  }
  function exportData(d) {
    return {
      v: 1, club: d.club, greenMode: d.greenMode === 'two' ? 'two' : 'one', center: d.center ? { lat: d.center.lat, lon: d.center.lon } : null, updated: d.updated,
      nines: d.nines.map(function (nn) {
        return {
          name: nn.name, holes: nn.holes.map(function (hl) {
            var o = { n: hl.n, par: hl.par, tees: hl.tees.map(function (t) { return { lat: t.lat, lon: t.lon, label: t.label }; }), green: copyGreen(G(hl, 0)) };
            if (hl.greens) o.greens = hl.greens.map(function (g, i) { return copyGreen(g, { id: TWIN[i].id, label: g.label || TWIN[i].label }); });
            if (hl.path.length) o.path = hl.path.map(function (p) { return p.slice(); });
            if (hl.hazards.length) o.hazards = hl.hazards.map(function (z) { return z.poly ? { type: z.type, poly: z.poly.map(function (p) { return p.slice(); }) } : { type: z.type, pt: { lat: z.pt.lat, lon: z.pt.lon } }; });
            o.src = hl.src;
            if (hl.oneGreen && d.greenMode === 'two') o.oneGreen = true;
            return JSON.parse(JSON.stringify(o));
          })
        };
      })
    };
  }
  function greenEnd(hl, side) { var g = G(hl, side); return g.center || g.back || g.front; }
  function route(hl, ti, side) {
    var t = hl.tees[ti || 0], e = greenEnd(hl, side), pts = [];
    if (t) pts.push(t); hl.path.forEach(function (p) { pts.push(P(p)); }); if (e) pts.push(e);
    return pts;
  }
  function holeLen(hl, ti, side) { var t = hl.tees[ti || 0], c = G(hl, side).center; if (!t || !c) return null; return pathLen([t].concat(hl.path.map(P), [c])); }
  function greenDone(g) { return !!(g.front && g.center && g.back); }
  function greenAny(g) { return !!(g.front || g.center || g.back); }
  function status(hl) {
    var gs = sides(hl).map(function (i) { return G(hl, i); });
    if (hl.tees.length && gs.every(greenDone)) return 'done';
    return (hl.tees.length || gs.some(greenAny) || hl.path.length || hl.hazards.length) ? 'part' : 'empty';
  }
  function holePoints(hl) {
    var pts = hl.tees.slice();
    sides(hl).forEach(function (i) {
      var g = G(hl, i);
      ['front', 'center', 'back'].forEach(function (k) { if (g[k]) pts.push(g[k]); });
      if (g.poly) g.poly.forEach(function (p) { pts.push(P(p)); });
    });
    hl.path.forEach(function (p) { pts.push(P(p)); });
    return pts;
  }

  /* ============================================================ OSM import */
  function buildQuery(c, r) {
    var a = '(around:' + r + ',' + c.lat.toFixed(6) + ',' + c.lon.toFixed(6) + ')';
    return '[out:json][timeout:25];' +
      '(way["leisure"="golf_course"]' + a + ';relation["leisure"="golf_course"]' + a + ';)->.gc;' +
      '.gc out geom;' +
      '.gc map_to_area->.ga;' +
      '(nwr["golf"~"^(hole|green|tee|bunker|water_hazard|lateral_water_hazard|out_of_bounds)$"](area.ga);' +
      'nwr["golf"~"^(hole|green|tee|bunker|water_hazard|lateral_water_hazard|out_of_bounds)$"]' + a + ';);' +
      'out geom;';
  }
  function geomOf(e) { return (e.geometry || []).filter(function (g) { return g && isFinite(g.lat); }).map(function (g) { return { lat: g.lat, lon: g.lon }; }); }
  function joinRings(ways) { // stitch open member ways into closed rings
    var segs = ways.map(function (w) { return w.slice(); }).filter(function (w) { return w.length > 1; }), rings = [];
    var same = function (a, b) { return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9; };
    while (segs.length) {
      var ring = segs.shift(), guard = 0;
      while (!same(ring[0], ring[ring.length - 1]) && guard++ < 500) {
        var end = ring[ring.length - 1], k = -1, rev = false;
        for (var i = 0; i < segs.length; i++) {
          if (same(segs[i][0], end)) { k = i; break; }
          if (same(segs[i][segs[i].length - 1], end)) { k = i; rev = true; break; }
        }
        if (k < 0) break;
        var s = segs.splice(k, 1)[0]; if (rev) s.reverse();
        ring = ring.concat(s.slice(1));
      }
      rings.push(ring);
    }
    return rings;
  }
  function ringsOf(e) {
    if (e.type === 'way') return [geomOf(e)];
    if (e.type === 'relation') return joinRings((e.members || []).filter(function (m) { return m.type === 'way' && m.role !== 'inner'; }).map(geomOf));
    return [];
  }
  function openRing(r) { var a = r.slice(); if (a.length > 2 && dist(a[0], a[a.length - 1]) < 0.01) a.pop(); return a; }
  function repPoint(e) {
    if (e.type === 'node') return { lat: e.lat, lon: e.lon };
    var rs = ringsOf(e).filter(function (r) { return r.length; }); if (!rs.length) return null;
    return rs[0].length >= 3 ? centroid(openRing(rs[0])) : rs[0][0];
  }
  function isClosed(g) { return g.length >= 4 && dist(g[0], g[g.length - 1]) < 0.5; }
  function rayPoly(a, c, ring) { // intersections of line a->c (infinite) with ring; returns t (metres from c along a->c dir)
    var o = P(c), A = xy(a, o), len = Math.hypot(A[0], A[1]) || 1, d = [-A[0] / len, -A[1] / len], ts = [];
    var v = ring.map(function (p) { return xy(p, o); });
    for (var i = 0; i < v.length; i++) {
      var p = v[i], q = v[(i + 1) % v.length], e = [q[0] - p[0], q[1] - p[1]];
      var den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-12) continue;
      var t = (p[0] * e[1] - p[1] * e[0]) / den, u = (p[0] * d[1] - p[1] * d[0]) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
    }
    return { ts: ts.sort(function (x, y) { return x - y; }), at: function (t) { return unxy([d[0] * t, d[1] * t], o); } };
  }
  function importOsm(json, center, o) {
    o = o || {};
    var els = (json && json.elements) || [], radius = o.radius || 1500;
    var sum = { course: null, holes: 0, twin: 0, greens: 0, tees: 0, bunker: 0, water: 0, ob: 0, noPar: 0, noRef: 0, outside: 0, unassigned: 0, nines: [] };
    var courses = els.filter(function (e) { return e.tags && e.tags.leisure === 'golf_course' && e.type !== 'node'; }).map(function (e) {
      var rings = ringsOf(e).filter(function (r) { return r.length >= 3; }).map(openRing);
      return { e: e, rings: rings, c: rings.length ? centroid(rings[0]) : null };
    }).filter(function (c) { return c.rings.length; });
    var course = courses.filter(function (c) { return c.rings.some(function (r) { return pip(center, r); }); })[0];
    if (!course && courses.length) {
      course = courses.slice().sort(function (a, b) { return dist(center, a.c) - dist(center, b.c); })[0];
      if (dist(center, course.c) > 3000) course = null;
    }
    if (course) sum.course = course.e.tags.name || course.e.tags['name:ko'] || '골프장';
    function inside(p) {
      if (!p) return false;
      if (course) return course.rings.some(function (r) { return pip(p, r) || lineDist(p, r.concat([r[0]])) < 30; });
      return dist(center, p) <= radius;
    }
    var seen = {}, feats = els.filter(function (e) {
      var k = e.type + e.id; if (seen[k] || !e.tags || !e.tags.golf) return false; seen[k] = 1;
      var p = repPoint(e); e._p = p;
      if (!inside(p)) { sum.outside++; return false; }
      return true;
    });
    var by = function (t) { return feats.filter(function (e) { return e.tags.golf === t; }); };

    /* holes */
    var holes = by('hole').filter(function (e) { return e.type === 'way' && geomOf(e).length >= 2; }).map(function (e) {
      var ref = parseInt(e.tags.ref, 10), par = parseInt(e.tags.par, 10);
      return { e: e, ref: ref, par: PARS.indexOf(par) >= 0 ? par : null, line: geomOf(e), cname: e.tags['golf:course:name'] || e.tags['golf:course'] || '', tees: [], green: null, hz: [] };
    });
    sum.noRef = holes.filter(function (x) { return !(x.ref > 0); }).length;
    holes = holes.filter(function (x) { return x.ref > 0; });

    /* greens */
    var greens = by('green').map(function (e) {
      var ring = e.type === 'node' ? null : openRing(ringsOf(e)[0] || []);
      return { ring: ring && ring.length >= 3 ? ring : null, c: ring && ring.length >= 3 ? centroid(ring) : e._p, used: false };
    }).filter(function (g) { return g.c; });
    sum.greens = greens.length;
    function greenFor(p) {
      var best = null, bd = 70;
      greens.forEach(function (g) {
        if (g.used) return;
        var d = g.ring && pip(p, g.ring) ? 0 : dist(p, g.c);
        if (d < bd) { bd = d; best = g; }
      });
      return best;
    }
    holes.forEach(function (x) { // orient tee->green, match green
      var gEnd = greenFor(x.line[x.line.length - 1]), gStart = greenFor(x.line[0]);
      var de = gEnd ? dist(gEnd.c, x.line[x.line.length - 1]) : Infinity, ds = gStart ? dist(gStart.c, x.line[0]) : Infinity;
      if (ds < de) { x.line.reverse(); gEnd = gStart; }
      if (gEnd) { gEnd.used = true; x.green = gEnd; }
    });
    /* 투그린: a second unused green near this hole's end, >25 m from the first, and nearer to this hole than any other */
    holes.forEach(function (x) {
      if (!x.green) return;
      var end = x.line[x.line.length - 1], best = null, bd = 60;
      greens.forEach(function (g) {
        if (g.used) return;
        var d = Math.min(dist(g.c, end), dist(g.c, x.green.c));
        if (d >= bd || dist(g.c, x.green.c) <= 25) return;
        var closer = holes.some(function (y) { return y !== x && dist(g.c, y.line[y.line.length - 1]) < dist(g.c, end); });
        if (!closer) { bd = d; best = g; }
      });
      if (best) { best.used = true; x.green2 = best; sum.twin++; }
    });

    /* tees */
    var tees = by('tee').map(function (e) {
      var t = e.tags, lab = String(t.tee || t.colour || t.color || t['tee:colour'] || '').toLowerCase();
      return { p: e._p, label: TEE_COLORS[lab] || t['name:ko'] || (t.name && t.name.length <= 8 ? t.name : '') };
    }).filter(function (t) { return t.p; });
    sum.tees = tees.length;
    tees.forEach(function (t) {
      var best = null, bd = 120;
      holes.forEach(function (x) {
        var d = Math.min(dist(t.p, x.line[0]), x.line.length > 1 ? lineDist(t.p, x.line.slice(0, 2)) + 15 : Infinity);
        if (d < bd) { bd = d; best = x; }
      });
      if (best) best.tees.push(t); else sum.unassigned++;
    });

    /* hazards */
    var HMAP = { bunker: 'bunker', water_hazard: 'water', lateral_water_hazard: 'water', out_of_bounds: 'ob' };
    feats.filter(function (e) { return HMAP[e.tags.golf]; }).forEach(function (e) {
      var type = HMAP[e.tags.golf], z;
      if (e.type === 'node') z = { type: type, pt: LL(e.lat, e.lon) };
      else { var r = openRing(ringsOf(e)[0] || []); if (r.length < 3) return; z = { type: type, poly: r.map(function (p) { return [rnd(p.lat), rnd(p.lon)]; }) }; }
      sum[type]++;
      var lim = type === 'bunker' ? 70 : 150, best = null, bd = lim;
      holes.forEach(function (x) {
        var line = x.line.slice(); if (x.green) line.push(x.green.c); if (x.green2) line.push(x.green2.c);
        var d = lineDist(e._p, line); if (x.green && x.green.ring) d = Math.min(d, dist(e._p, x.green.c) - 10);
        if (d < bd) { bd = d; best = x; }
      });
      if (best) best.hz.push(z); else sum.unassigned++;
    });

    /* nine grouping */
    var named = holes.some(function (x) { return x.cname; }), dupRefs = false, refSeen = {};
    holes.forEach(function (x) { if (refSeen[x.ref]) dupRefs = true; refSeen[x.ref] = 1; });
    var groups = {}, order = [];
    holes.forEach(function (x) {
      var key, n;
      if (named && dupRefs && x.cname && x.ref <= 9) { key = 'c:' + x.cname; n = x.ref; }
      else { key = 'r:' + Math.floor((x.ref - 1) / 9); n = ((x.ref - 1) % 9) + 1; }
      if (!groups[key]) { groups[key] = { key: key, name: x.cname && key.charAt(0) === 'c' ? x.cname : null, idx: key.charAt(0) === 'r' ? +key.slice(2) : 100 + order.length, holes: {} }; order.push(key); }
      if (!groups[key].holes[n]) groups[key].holes[n] = x;
    });
    var gl = order.map(function (k) { return groups[k]; }).sort(function (a, b) { return a.idx - b.idx; });
    var defNames = gl.length <= 2 ? ['OUT', 'IN'] : null;
    var nines = gl.map(function (grp, gi) {
      var name = grp.name || (defNames ? defNames[gi] : '코스' + (gi + 1));
      var nine = emptyNine(name);
      Object.keys(grp.holes).forEach(function (n) {
        var x = grp.holes[n], hl = emptyHole(+n); if (+n < 1 || +n > 9) return;
        hl.par = x.par; if (x.par == null) sum.noPar++;
        hl.src = 'osm';
        var L = x.line, last = L[L.length - 1];
        hl.path = L.slice(1, -1).map(function (p) { return [rnd(p.lat), rnd(p.lon)]; });
        var c = x.green ? x.green.c : last;
        var prev = L.length >= 2 ? L[L.length - 2] : L[0];
        if (dist(prev, last) < 5 && L.length >= 3) prev = L[L.length - 3];
        var build = function (gr, cc) {
          var o = { front: null, center: normPt(cc), back: null };
          if (gr && gr.ring) {
            o.poly = gr.ring.map(function (p) { return [rnd(p.lat), rnd(p.lon)]; });
            var rp = rayPoly(prev, cc, gr.ring);
            if (rp.ts.length >= 2) { o.front = normPt(rp.at(rp.ts[0])); o.back = normPt(rp.at(rp.ts[rp.ts.length - 1])); }
          }
          if (!o.front) { o.front = normPt(along(prev, cc, -12)); o.back = normPt(along(prev, cc, 12)); }
          return o;
        };
        if (x.green2) {
          // left/right relative to play direction prev -> hole end (x east, y north: cross > 0 = left)
          var o0 = P(prev), dv = xy(last, o0), side = function (g) { var v = xy(g.c, o0); return dv[0] * v[1] - dv[1] * v[0]; };
          var pair = side(x.green) >= side(x.green2) ? [x.green, x.green2] : [x.green2, x.green];
          hl.greens = pair.map(function (gr, i) { var g = build(gr, gr.c); g.id = TWIN[i].id; g.label = TWIN[i].label; return g; });
          syncGreen(hl);
          c = pair[0].c;
        } else {
          hl.green = build(x.green, c);
        }
        var ts = x.tees.slice().sort(function (a, b) { return dist(b.p, c) - dist(a.p, c); });
        hl.tees = ts.map(function (t, i) { var p = normPt(t.p); return { lat: p.lat, lon: p.lon, label: t.label || TEE_LABELS[i] || ('티' + (i + 1)) }; });
        if (!hl.tees.length) { var p0 = normPt(L[0]); hl.tees = [{ lat: p0.lat, lon: p0.lon, label: '티' }]; }
        hl.hazards = x.hz;
        nine.holes[+n - 1] = hl;
        sum.holes++;
      });
      sum.nines.push({ name: name, holes: Object.keys(grp.holes).length });
      return nine;
    });
    var ccenter = course ? course.c : null;
    sum.greenMode = sum.holes && sum.twin * 2 > sum.holes ? 'two' : 'one';
    return { nines: nines, club: sum.course, center: ccenter ? normPt(ccenter) : null, greenMode: sum.greenMode, summary: sum };
  }

  /* ================================================================ editor */
  var TOOLS = [
    { id: 'tee', label: '티', glyph: 'T' },
    { id: 'front', label: '그린 앞', glyph: '앞' },
    { id: 'center', label: '그린 중앙', glyph: '중' },
    { id: 'back', label: '그린 뒤', glyph: '뒤' },
    { id: 'path', label: '경로점', sub: '도그렉', glyph: '◆' },
    { id: 'bunker', label: '벙커', glyph: 'B' },
    { id: 'water', label: '해저드(물)', glyph: 'W' },
    { id: 'ob', label: 'OB', glyph: 'OB' }
  ];
  var TOOL_NAME = {}; TOOLS.forEach(function (t) { TOOL_NAME[t.id] = t.label + (t.sub ? '(' + t.sub + ')' : ''); });
  var DEFAULT_TILES = [
    { name: '브이월드 항공', url: 'https://api.vworld.kr/req/wmts/1.0.0/{key}/Satellite/{z}/{y}/{x}.jpeg', key: '', maxZoom: 19, attribution: '© 국토교통부 브이월드' },
    { name: 'Esri 위성(테스트용)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, attribution: 'Esri' },
    { name: 'OSM', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap contributors' }
  ];
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { return null; } return null; }

  function Editor(root, opts) {
    var self = this;
    opts = opts || {};
    this.opts = opts;
    var layers = (opts.tiles || DEFAULT_TILES).filter(function (l) { return l && l.url && (l.url.indexOf('{key}') < 0 || l.key); });
    var data = normalize(opts.data, opts);
    var S = { ni: 0, hi: 0, side: 0, tool: 'tee', undo: [], dismissed: {}, layer: 0, renaming: false, twinOff: false, modeAsk: false };
    var map = null, layersDrawn = [], live = [], draftKey = opts.storageKey || ('mapedit:draft:' + (data.club || 'default'));
    var saveTimer = 0, toastTimer = 0;

    var restored = false;
    if (!opts.data && opts.restoreDraft !== false) {
      var raw = store(draftKey);
      if (raw) try { var dj = JSON.parse(raw); if (dj && dj.data) { data = normalize(dj.data, opts); restored = true; } } catch (_) { /* ignore */ }
    }
    var savedLayer = store('mapedit:layer'); layers.forEach(function (l, i) { if (l.name === savedLayer) S.layer = i; });

    /* ---------- DOM skeleton */
    root.innerHTML = '';
    root.classList.add('mapedit');
    var el = {};
    el.title = h('div', { class: 'me-club', text: data.club || '코스 맵 편집' });
    el.sub = h('div', { class: 'me-sub', text: '' });
    el.osmBtn = h('button', { class: 'me-btn me-btn-ghost me-osm', type: 'button', 'data-act': 'osm', text: '공개 지도에서 불러오기' });
    el.moreBtn = h('button', { class: 'me-btn me-btn-ghost me-icon', type: 'button', 'data-act': 'more', 'aria-label': '더보기', 'aria-haspopup': 'menu', text: '⋯' });
    el.saveBtn = h('button', { class: 'me-btn me-btn-gold', type: 'button', 'data-act': 'save', text: '저장' });
    el.file = h('input', { type: 'file', accept: 'application/json,.json', class: 'me-hidden' });
    el.menu = h('div', { class: 'me-menu', role: 'menu', hidden: true }, [
      h('button', { type: 'button', role: 'menuitem', 'data-act': 'export', text: 'JSON 내보내기' }),
      h('button', { type: 'button', role: 'menuitem', 'data-act': 'import', text: 'JSON 불러오기' }),
      h('button', { type: 'button', role: 'menuitem', 'data-act': 'rename', text: '나인 이름 변경' }),
      h('button', { type: 'button', role: 'menuitem', 'data-act': 'addnine', text: '나인 추가' }),
      h('button', { type: 'button', role: 'menuitem', 'data-act': 'delnine', class: 'me-danger', text: '현재 나인 삭제' })
    ]);
    var header = h('header', { class: 'me-head' }, [
      h('div', { class: 'me-brand' }, [el.title, el.sub]),
      h('div', { class: 'me-actions' }, [el.osmBtn, el.moreBtn, el.saveBtn, el.menu, el.file])
    ]);
    el.tabs = h('div', { class: 'me-tabs', role: 'tablist' });
    el.chips = h('div', { class: 'me-chips' });
    el.mode = h('div', { class: 'me-mode', role: 'radiogroup', 'aria-label': '그린 방식' });
    el.modeAsk = h('div', { class: 'me-modeask', hidden: true });
    el.par = h('div', { class: 'me-par', role: 'group', 'aria-label': '파' });
    el.par.appendChild(h('span', { class: 'me-lbl', text: 'PAR' }));
    PARS.forEach(function (p) { el.par.appendChild(h('button', { type: 'button', class: 'me-parbtn', 'data-par': String(p), text: String(p) })); });
    el.holeTitle = h('div', { class: 'me-holetitle' });
    el.parAll = h('button', { type: 'button', class: 'me-parall', 'data-act': 'parall', text: '파 한 번에' });
    var parRow = h('div', { class: 'me-inforow me-parrow' }, [el.holeTitle, h('div', { class: 'me-parwrap' }, [el.par, el.parAll])]);
    var nav = h('nav', { class: 'me-nav' }, [h('div', { class: 'me-navrow' }, [el.tabs, el.mode]), el.modeAsk, el.chips, parRow]);

    el.mapHost = h('div', { class: 'me-maphost' });
    el.hint = h('div', { class: 'me-hint', 'aria-live': 'polite' });
    el.toast = h('div', { class: 'me-toast', role: 'status', hidden: true });
    el.layerBtn = h('button', { class: 'me-fab me-layerbtn', type: 'button', 'data-act': 'layers', 'aria-label': '지도 종류' });
    el.layerList = h('div', { class: 'me-layerlist', hidden: true });
    el.helper = h('div', { class: 'me-helper', hidden: true });
    var zoomBox = h('div', { class: 'me-zoom' }, [
      h('button', { class: 'me-fab', type: 'button', 'data-act': 'zin', 'aria-label': '확대', text: '+' }),
      h('button', { class: 'me-fab', type: 'button', 'data-act': 'zout', 'aria-label': '축소', text: '−' }),
      h('button', { class: 'me-fab me-fit', type: 'button', 'data-act': 'fit', 'aria-label': '현재 홀 맞춤', title: '현재 홀 맞춤', text: '⌖' })
    ]);
    var mapWrap = h('div', { class: 'me-mapwrap' }, [el.mapHost, el.hint, h('div', { class: 'me-tr' }, [el.layerBtn, el.layerList]), zoomBox, el.helper, el.toast]);

    el.tools = h('div', { class: 'me-tools' });
    TOOLS.forEach(function (t) {
      el.tools.appendChild(h('button', { class: 'me-tool me-t-' + t.id, type: 'button', 'data-tool': t.id, 'aria-pressed': 'false' }, [
        h('span', { class: 'me-glyph', text: t.glyph }), h('span', { class: 'me-tl', text: t.label }), t.sub ? h('span', { class: 'me-ts', text: t.sub }) : null
      ]));
    });
    el.undoBtn = h('button', { class: 'me-tool me-t-undo', type: 'button', 'data-act': 'undo' }, [h('span', { class: 'me-glyph', text: '↶' }), h('span', { class: 'me-tl', text: '되돌리기' })]);
    el.clearBtn = h('button', { class: 'me-tool me-t-clear', type: 'button', 'data-act': 'clear' }, [h('span', { class: 'me-glyph', text: '✕' }), h('span', { class: 'me-tl', text: '홀 지우기' })]);
    el.tools.appendChild(el.undoBtn); el.tools.appendChild(el.clearBtn);

    el.dist = h('div', { class: 'me-dist' });
    var info = h('div', { class: 'me-info' }, [el.dist]);
    el.greenBar = h('div', { class: 'me-greenbar' });
    var panel = h('section', { class: 'me-panel' }, [el.tools, el.greenBar, info]);

    el.modal = h('div', { class: 'me-modal', hidden: true, role: 'dialog', 'aria-modal': 'true' });
    var tips = h('div', { class: 'me-tips' }, [h('b', { text: '사용법' }), h('ul', null, [
      h('li', { text: '티 → 그린 앞 → 중앙 → 뒤 순서로 탭하면 다음 홀로 넘어가요.' }),
      h('li', { text: '마커는 끌어서 옮기고, 실수는 되돌리기(Ctrl+Z)로 취소해요.' }),
      h('li', { text: '도그렉 홀은 경로점을 찍으면 실제 비거리로 계산돼요.' }),
      h('li', { text: '다른 홀 번호 배지를 탭하면 그 홀로 이동해요.' })
    ])]);
    var side = h('aside', { class: 'me-side' }, [header, nav, panel, tips]);
    root.appendChild(side); root.appendChild(mapWrap); root.appendChild(el.modal);

    /* ---------- helpers */
    function nine() { return data.nines[S.ni]; }
    function hole() { return nine().holes[S.hi]; }
    function snapshot() { return { d: JSON.stringify(data), ni: S.ni, hi: S.hi, side: S.side, tool: S.tool }; }
    function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 150) S.undo.shift(); }
    function toast(msg, ms) {
      el.toast.textContent = msg; el.toast.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.toast.hidden = true; }, ms || 2200);
    }
    function syncAll() { data.nines.forEach(function (nn) { nn.holes.forEach(syncGreen); }); }
    function isGreenTool(t) { return t === 'front' || t === 'center' || t === 'back'; }
    function sideName(x, si) { return x.greens ? (x.greens[si].label || TWIN[si].label) : ''; }
    function changed() {
      syncAll();
      data.updated = new Date().toISOString();
      renderAll();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        store(draftKey, JSON.stringify({ savedAt: new Date().toISOString(), data: exportData(data) }));
        el.sub.textContent = '임시저장됨 ' + new Date().toTimeString().slice(0, 5);
      }, opts.autosaveDelay == null ? 500 : opts.autosaveDelay);
    }
    function fmtM(m) { return m == null ? '–' : Math.round(m) + 'm'; }

    /* ---------- rendering */
    function renderTabs() {
      el.tabs.innerHTML = '';
      data.nines.forEach(function (nn, i) {
        if (S.renaming && i === S.ni) {
          var inp = h('input', { class: 'me-tab me-tab-edit', value: nn.name, maxlength: '16', 'aria-label': '나인 이름' });
          var commit = function () { if (!S.renaming) return; S.renaming = false; var v = inp.value.trim(); if (v && v !== nn.name) { pushUndo(); nn.name = v; changed(); } else renderTabs(); };
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { S.renaming = false; renderTabs(); } });
          inp.addEventListener('blur', commit);
          el.tabs.appendChild(inp); setTimeout(function () { inp.focus(); inp.select(); }, 0);
          return;
        }
        var done = nn.holes.filter(function (x) { return status(x) === 'done'; }).length;
        el.tabs.appendChild(h('button', { type: 'button', role: 'tab', class: 'me-tab' + (i === S.ni ? ' on' : ''), 'aria-selected': String(i === S.ni), 'data-nine': String(i) }, [
          h('span', { text: nn.name }), h('span', { class: 'me-tabn', text: done + '/9' })
        ]));
      });
      el.tabs.appendChild(h('button', { type: 'button', class: 'me-tab me-tab-add', 'data-act': 'addnine', 'aria-label': '나인 추가', text: '+ 나인' }));
    }
    function renderChips() {
      el.chips.innerHTML = '';
      nine().holes.forEach(function (x, i) {
        var len = holeLen(x, 0);
        el.chips.appendChild(h('button', { type: 'button', class: 'me-chip me-st-' + status(x) + (i === S.hi ? ' on' : ''), 'data-hole': String(i), 'aria-label': (i + 1) + '번 홀' }, [
          h('span', { class: 'me-chipn', text: String(x.n) }),
          h('span', { class: 'me-chipd', text: len != null ? String(Math.round(len)) : '·' }),
          h('span', { class: 'me-chipp' + (x.par ? '' : ' me-nopar'), text: x.par ? 'P' + x.par : 'P–' })
        ]));
      });
    }
    function renderTools() {
      Array.prototype.forEach.call(el.tools.querySelectorAll('[data-tool]'), function (b) {
        var on = b.getAttribute('data-tool') === S.tool; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      });
      el.undoBtn.disabled = !S.undo.length;
      var x = hole();
      renderMode();
      el.hint.textContent = nine().name + ' ' + x.n + '번 · 지도를 탭해 「' + (x.greens && isGreenTool(S.tool) ? sideName(x, S.side) + ' ' : '') + TOOL_NAME[S.tool] + '」 찍기';
      renderGreenBar();
    }
    function renderInfo() {
      var x = hole();
      el.holeTitle.textContent = nine().name + ' ' + x.n + '번 홀' + (x.src === 'osm' ? ' · 공개지도' : '');
      Array.prototype.forEach.call(el.par.querySelectorAll('[data-par]'), function (b) { b.classList.toggle('on', +b.getAttribute('data-par') === x.par); });
      el.dist.innerHTML = '';
      var sd = sides(x), anyC = sd.some(function (si) { return G(x, si).center; });
      if (!x.tees.length || !anyC) {
        el.dist.appendChild(h('span', { class: 'me-muted', text: x.tees.length ? '그린 중앙을 찍으면 거리가 표시돼요' : '티와 그린 중앙을 찍으면 거리가 표시돼요' }));
      } else {
        x.tees.forEach(function (t, i) {
          var kids = [h('span', { class: 'me-teel', text: t.label })];
          sd.forEach(function (si, k) {
            if (k) kids.push(h('span', { class: 'me-teel', text: '·' }));
            if (x.greens) kids.push(h('span', { class: 'me-teel', text: sideName(x, si) }));
            kids.push(h('b', { class: x.greens && si !== S.side ? 'me-off' : null, text: fmtM(holeLen(x, i, si)) }));
          });
          el.dist.appendChild(h('button', { type: 'button', class: 'me-teed', 'data-tee': String(i), title: '탭해서 티 이름 바꾸기' }, kids));
        });
      }
      var ga = G(x, S.side);
      if (ga.front && ga.back) el.dist.appendChild(h('span', { class: 'me-gd', text: (x.greens ? sideName(x, S.side) + ' ' : '') + '그린 깊이 ' + fmtM(dist(ga.front, ga.back)) }));
      if (x.hazards.length) el.dist.appendChild(h('span', { class: 'me-gd', text: '해저드 ' + x.hazards.length }));
      // helper (applies to the selected green side)
      var showHelp = ga.center && !ga.front && !ga.back && !S.dismissed[S.ni + ':' + S.hi + ':' + S.side];
      el.helper.hidden = !showHelp; el.helper.innerHTML = '';
      if (showHelp) {
        var ref = x.path.length ? P(x.path[x.path.length - 1]) : x.tees[0];
        el.helper.appendChild(h('span', { text: ref ? (x.greens ? sideName(x, S.side) + ' ' : '') + '그린 앞/뒤 ±12m 자동 채우기' : '티를 찍으면 앞/뒤 자동 채우기 가능' }));
        if (ref) el.helper.appendChild(h('button', { type: 'button', class: 'me-btn me-btn-gold me-sm', 'data-act': 'autofill', text: '채우기' }));
        el.helper.appendChild(h('button', { type: 'button', class: 'me-x', 'data-act': 'dismiss', 'aria-label': '닫기', text: '×' }));
      }
    }
    function renderMode() {
      var two = data.greenMode === 'two';
      el.mode.innerHTML = '';
      [['one', '원그린'], ['two', '투그린']].forEach(function (m) {
        var on = (m[0] === 'two') === two;
        el.mode.appendChild(h('button', { type: 'button', role: 'radio', class: on ? 'on' : '', 'aria-checked': String(on), 'data-mode': m[0], text: m[1] }));
      });
      el.modeAsk.hidden = !S.modeAsk; el.modeAsk.innerHTML = '';
      if (S.modeAsk) {
        el.modeAsk.appendChild(h('span', { text: '모든 홀의 우 그린을 지우고 좌 그린만 남길까요?' }));
        el.modeAsk.appendChild(h('button', { type: 'button', class: 'me-btn me-btn-ghost me-sm', 'data-act': 'mode-cancel', text: '취소' }));
        el.modeAsk.appendChild(h('button', { type: 'button', class: 'me-btn me-btn-gold me-sm', 'data-act': 'mode-ok', text: '원그린으로' }));
      }
    }
    function renderGreenBar() {
      var x = hole();
      el.greenBar.innerHTML = '';
      el.greenBar.hidden = data.greenMode !== 'two';
      if (el.greenBar.hidden) return;
      if (x.greens && S.twinOff) {
        el.greenBar.appendChild(h('span', { class: 'me-ask', text: '이 홀의 우 그린을 지우고 원그린으로 바꿀까요?' }));
        el.greenBar.appendChild(h('button', { type: 'button', class: 'me-btn me-btn-ghost me-sm', 'data-act': 'twinoff-cancel', text: '취소' }));
        el.greenBar.appendChild(h('button', { type: 'button', class: 'me-btn me-btn-gold me-sm', 'data-act': 'twinoff-ok', text: '바꾸기' }));
        return;
      }
      if (x.greens) {
        var seg = h('div', { class: 'me-seg', role: 'radiogroup', 'aria-label': '그린 선택' });
        [0, 1].forEach(function (si) {
          var g = x.greens[si];
          seg.appendChild(h('button', { type: 'button', role: 'radio', class: (si === S.side ? 'on ' : '') + (greenDone(g) ? 'done' : greenAny(g) ? 'part' : ''), 'aria-checked': String(si === S.side), 'data-side': String(si), text: sideName(x, si) + ' 그린' }));
        });
        el.greenBar.appendChild(seg);
      } else {
        el.greenBar.appendChild(h('span', { class: 'me-muted me-gbhint', text: '이 홀은 그린이 하나예요' }));
      }
      el.greenBar.appendChild(h('button', { type: 'button', class: 'me-check' + (x.oneGreen ? ' on' : ''), 'data-act': 'onegreen', role: 'checkbox', 'aria-checked': String(!!x.oneGreen) }, [
        h('span', { class: 'me-box', text: x.oneGreen ? '✓' : '' }), h('span', { text: '이 홀은 원그린' })
      ]));
    }
    function setMode(m) {
      if (m === data.greenMode) { S.modeAsk = false; renderMode(); return; }
      if (m === 'one') {
        var lose = data.nines.some(function (nn) { return nn.holes.some(function (x) { return x.greens && (greenAny(x.greens[1]) || x.greens[1].poly); }); });
        if (lose && !S.modeAsk) { S.modeAsk = true; renderMode(); return; }
      }
      pushUndo();
      S.modeAsk = false; S.twinOff = false; data.greenMode = m;
      data.nines.forEach(function (nn) { nn.holes.forEach(function (x) { if (m === 'two') delete x.oneGreen; conformHole(x, m); }); });
      toast(m === 'two' ? '투그린 코스로 설정했어요 — 좌/우 그린을 찍어 주세요' : '원그린 코스로 바꿨어요');
      selectHole(S.ni, S.hi, false);
      changed();
    }
    function renderLayers() {
      var l = layers[S.layer];
      el.layerBtn.textContent = l ? l.name : '지도 없음';
      el.layerList.innerHTML = '';
      layers.forEach(function (ly, i) { el.layerList.appendChild(h('button', { type: 'button', class: i === S.layer ? 'on' : '', 'data-layer': String(i), text: ly.name })); });
    }
    function clearLayers(arr) { arr.forEach(function (x) { x.remove(); }); arr.length = 0; }
    function drawLive() { // route line + distance badge for the active hole (redrawn while dragging)
      clearLayers(live);
      var x = hole();
      sides(x).forEach(function (si) {
        var dim = x.greens && si !== S.side ? ' me-dim' : '', g = G(x, si);
        x.tees.forEach(function (t, i) {
          var r = route(x, i, si); if (r.length < 2) return;
          if (i > 0) r = [t, r[1]];
          live.push(map.shape(r, { cls: (i === 0 ? 'me-route' : 'me-route2') + dim }));
        });
        if (g.front && g.back) live.push(map.shape([g.front, g.back], { cls: 'me-gline' + dim }));
      });
      // one distance badge at mid-route (two greens: "좌 371 · 우 362m", measured along the selected side's route)
      var lens = sides(x).map(function (si) { return holeLen(x, 0, si); });
      var bs = lens[S.side] != null ? S.side : lens.findIndex(function (v) { return v != null; });
      if (bs < 0) return;
      var r0 = route(x, 0, bs), len = lens[bs];
      if (r0.length < 2) return;
      var half = len / 2, acc = 0, mid = r0[0];
      for (var i = 1; i < r0.length; i++) {
        var d = dist(r0[i - 1], r0[i]);
        if (acc + d >= half) { var f = (half - acc) / (d || 1), a = r0[i - 1], b = r0[i]; mid = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }; break; }
        acc += d;
      }
      var label = x.greens ? sides(x).map(function (si) { return sideName(x, si) + ' ' + (lens[si] == null ? '–' : Math.round(lens[si])); }).join(' · ') + 'm' : fmtM(len);
      live.push(map.marker(mid, { cls: 'me-badge', label: label }));
    }
    function redrawMap() {
      if (!map) return;
      clearLayers(layersDrawn); clearLayers(live);
      var nn = nine();
      nn.holes.forEach(function (x, i) {
        if (i === S.hi) return;
        var r = route(x, 0);
        if (r.length >= 2) layersDrawn.push(map.shape(r, { cls: 'me-other' }));
        var at = greenEnd(x) || x.tees[0];
        if (at) layersDrawn.push(map.marker(at, { cls: 'me-holeno me-st-' + status(x), label: String(x.n), interactive: true, onClick: function () { selectHole(S.ni, i, true); } }));
      });
      var x = hole();
      x.hazards.forEach(function (z, zi) {
        if (z.poly) layersDrawn.push(map.shape(z.poly, { kind: 'poly', cls: 'me-hz-' + z.type }));
        else layersDrawn.push(map.marker(z.pt, dragOpts({ cls: 'me-m-hz me-hz-' + z.type, label: z.type === 'ob' ? 'OB' : z.type === 'water' ? 'W' : 'B' }, function (ll) { z.pt = LL(ll.lat, ll.lon); })));
      });
      sides(x).forEach(function (si) { var g = G(x, si); if (g.poly) layersDrawn.push(map.shape(g.poly, { kind: 'poly', cls: 'me-greenpoly' + (x.greens && si !== S.side ? ' me-dim' : '') })); });
      x.path.forEach(function (p, pi) {
        layersDrawn.push(map.marker(P(p), dragOpts({ cls: 'me-m-path', label: '' }, function (ll) { x.path[pi] = [rnd(ll.lat), rnd(ll.lon)]; })));
      });
      var order = sides(x).sort(function (a, b) { return (a === S.side) - (b === S.side); }); // active side drawn on top
      order.forEach(function (si) {
        var g = G(x, si), pre = x.greens ? sideName(x, si) : '', cls = x.greens ? ' me-twin' + (si !== S.side ? ' me-dim' : '') : '';
        [['front', '앞'], ['back', '뒤'], ['center', '중']].forEach(function (k) {
          var p = g[k[0]]; if (!p) return;
          layersDrawn.push(map.marker(p, dragOpts({ cls: 'me-m-g me-m-' + k[0] + cls, label: pre + k[1] }, function (ll) { g[k[0]] = LL(ll.lat, ll.lon); S.side = si; })));
        });
      });
      x.tees.forEach(function (t, ti) {
        layersDrawn.push(map.marker(t, dragOpts({ cls: 'me-m-tee me-tee' + ti, label: 'T', caption: t.label }, function (ll) { var q = LL(ll.lat, ll.lon); t.lat = q.lat; t.lon = q.lon; })));
      });
      drawLive();
    }
    function dragOpts(mo, apply) {
      mo.draggable = true;
      mo.onDragStart = function () { pushUndo(); };
      mo.onDrag = function (ll) { apply(ll); syncGreen(hole()); drawLive(); renderInfo(); };
      mo.onDragEnd = function (ll) { apply(ll); hole().src = 'user'; changed(); };
      return mo;
    }
    function renderAll() { renderTabs(); renderChips(); renderTools(); renderInfo(); renderLayers(); redrawMap(); el.title.textContent = data.club || '코스 맵 편집'; }

    /* ---------- actions */
    function fitHole(x) {
      var pts = holePoints(x || hole());
      if (pts.length >= 2) map.fitBounds(pts, [96, 64, 72, 44], 18.5);
      else if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 17));
    }
    function fitAll() {
      var pts = []; data.nines.forEach(function (nn) { nn.holes.forEach(function (x) { pts = pts.concat(holePoints(x)); }); });
      if (pts.length) map.fitBounds(pts, [60, 56, 30, 30], 18);
    }
    function selectHole(ni, hi, fit) {
      S.ni = ni; S.hi = hi; S.renaming = false; S.twinOff = false; S.side = 0;
      var x = hole(), first = function (g) { return !g.front ? 'front' : !g.center ? 'center' : !g.back ? 'back' : null; };
      if (!x.tees.length) S.tool = 'tee';
      else if (first(G(x, 0))) S.tool = first(G(x, 0));
      else if (x.greens && first(G(x, 1))) { S.side = 1; S.tool = first(G(x, 1)); }
      renderAll();
      if (fit && map && holePoints(x).length) fitHole(x);
    }
    function nextHole() {
      if (S.hi < 8) { S.hi++; } else if (S.ni < data.nines.length - 1) { S.ni++; S.hi = 0; } else { toast('마지막 홀이에요'); return false; }
      return true;
    }
    function advance(tool) {
      var x = hole(), g = G(x, S.side);
      if (tool === 'back') {
        if (x.greens && S.side === 0) { // 좌 뒤 -> 우 앞
          var r = x.greens[1]; S.side = 1;
          S.tool = !r.front ? 'front' : !r.center ? 'center' : !r.back ? 'back' : 'front';
          toast(sideName(x, 1) + ' 그린 「' + TOOL_NAME[S.tool] + '」을 찍어 주세요', 1600);
          return;
        }
        if (nextHole()) { S.side = 0; S.twinOff = false; S.tool = 'tee'; toast(nine().name + ' ' + hole().n + '번 홀 — 티를 찍어 주세요', 1600); }
        return;
      }
      var seq = { tee: ['front', 'center', 'back'], front: ['center', 'back'], center: ['back', 'front'] }[tool];
      if (!seq) return;
      for (var i = 0; i < seq.length; i++) if (!g[seq[i]]) { S.tool = seq[i]; return; }
    }
    function insertPath(x, p) {
      var a = x.tees[0], b = greenEnd(x), pt = [p.lat, p.lon];
      if (!a || !b) { x.path.push(pt); return; }
      var seq = [a].concat(x.path.map(P), [b]), best = 0, bd = Infinity;
      for (var i = 0; i < seq.length - 1; i++) {
        var d = dist(seq[i], p) + dist(p, seq[i + 1]) - dist(seq[i], seq[i + 1]);
        if (d < bd) { bd = d; best = i; }
      }
      x.path.splice(best, 0, pt);
    }
    function place(ll) {
      if (el.modal.hidden === false) return;
      closePopups();
      var x = hole(), p = LL(ll.lat, ll.lon), t = S.tool;
      pushUndo();
      if (t === 'tee') {
        if (x.tees.length >= 6) { S.undo.pop(); toast('티는 6개까지 넣을 수 있어요'); return; }
        x.tees.push({ lat: p.lat, lon: p.lon, label: TEE_LABELS[x.tees.length] || ('티' + (x.tees.length + 1)) });
      } else if (isGreenTool(t)) G(x, S.side)[t] = p;
      else if (t === 'path') insertPath(x, p);
      else if (HZ[t]) x.hazards.push({ type: t, pt: p });
      x.src = 'user';
      advance(t);
      changed();
    }
    function autofill() {
      var x = hole(), g = G(x, S.side), c = g.center, ref = x.path.length ? P(x.path[x.path.length - 1]) : x.tees[0];
      if (!c || !ref) return;
      pushUndo();
      g.front = normPt(along(ref, c, -12)); g.back = normPt(along(ref, c, 12)); x.src = 'user';
      toast('앞/뒤를 채웠어요 — 드래그로 조정할 수 있어요');
      advance('back');
      changed();
    }
    function undo() {
      var s = S.undo.pop(); if (!s) return;
      data = JSON.parse(s.d); S.ni = Math.min(s.ni, data.nines.length - 1); S.hi = s.hi; S.tool = s.tool; S.side = s.side || 0; S.twinOff = false; S.modeAsk = false;
      changed(); toast('되돌렸어요', 1200);
    }
    function clearHole() {
      var x = hole();
      if (status(x) === 'empty') return;
      pushUndo();
      var par = x.par, nh = emptyHole(x.n); nh.par = par; if (x.oneGreen) nh.oneGreen = true;
      conformHole(nh, data.greenMode); nine().holes[S.hi] = nh; S.tool = 'tee'; S.side = 0;
      changed(); toast(x.n + '번 홀을 지웠어요 · 되돌리기 가능');
    }
    function setLayer(i) {
      S.layer = i; if (layers[i]) store('mapedit:layer', layers[i].name);
      if (map && layers[i]) map.setLayer(layers[i]);
      renderLayers();
    }
    function closePopups() { el.menu.hidden = true; el.layerList.hidden = true; }

    function modal(title, body, buttons) {
      el.modal.innerHTML = '';
      var box = h('div', { class: 'me-dialog' }, [h('h3', { text: title })].concat(body, [h('div', { class: 'me-dlg-btns' }, buttons.map(function (b) {
        return h('button', { type: 'button', class: 'me-btn ' + (b.cls || 'me-btn-ghost'), 'data-dlg': b.id, text: b.label, on: { click: function () { el.modal.hidden = true; if (b.fn) b.fn(); } } });
      }))]));
      el.modal.appendChild(box); el.modal.hidden = false;
      var f = box.querySelector('.me-btn-gold') || box.querySelector('button'); if (f) f.focus();
    }

    // 9홀 파를 한 번에: 스코어카드를 보며 차례로 누르기. opts.onPars가 있으면 '스코어카드 파 정보로도 쓰기' 제공
    function parAllDialog() {
      var nn = nine(), cur = nn.holes.map(function (x) { return x.par; });
      var sumEl = h('div', { class: 'me-parsum' });
      function upd() { var f = cur.filter(function (v) { return v; }).length, t = cur.reduce(function (a, v) { return a + (v || 0); }, 0); sumEl.textContent = f === 9 ? '합계 PAR ' + t : f + '/9 입력 · 합계 ' + t; }
      var rows = h('div', { class: 'me-pargrid' });
      cur.forEach(function (v, i) {
        var row = h('div', { class: 'me-parline' }, [h('span', { class: 'me-parno', text: nn.holes[i].n + '번' })]);
        PARS.forEach(function (p) {
          row.appendChild(h('button', { type: 'button', class: 'me-parbtn' + (v === p ? ' on' : ''), text: String(p), on: { click: function () {
            cur[i] = cur[i] === p ? null : p;
            Array.prototype.forEach.call(row.querySelectorAll('.me-parbtn'), function (b) { b.classList.toggle('on', +b.textContent === cur[i]); });
            upd();
          } } }));
        });
        rows.appendChild(row);
      });
      upd();
      function apply() { pushUndo(); nn.holes.forEach(function (x, i) { x.par = cur[i] || null; }); changed(); }
      var btns = [{ id: 'cancel', label: '취소' }, { id: 'ok', label: '적용', cls: 'me-btn-gold', fn: function () { apply(); toast(nn.name + ' 파를 적용했어요'); } }];
      if (typeof opts.onPars === 'function') btns.splice(1, 0, { id: 'score', label: '적용 + 스코어카드 파로도 쓰기', fn: function () {
        if (cur.some(function (v) { return !v; })) { apply(); toast('9홀 파를 모두 입력해야 스코어카드 파로 쓸 수 있어요', 3200); return; }
        apply();
        Promise.resolve().then(function () { return opts.onPars({ nine: nn.name, index: S.ni, pars: cur.slice() }); })
          .then(function (msg) { toast(msg || (nn.name + ' 파를 스코어카드 파 정보에도 반영했어요'), 3200); })
          .catch(function (e) { toast('스코어카드 파 반영 실패: ' + ((e && e.message) || e || '오류'), 4000); });
      } });
      modal('파 한 번에 입력 · ' + nn.name, [h('p', { class: 'me-muted', text: '스코어카드를 보며 1번부터 차례로 누르세요. 다시 누르면 지워져요.' }), rows, sumEl], btns);
    }

    function osmImport() {
      if (el.osmBtn.disabled) return;
      var c = data.center || (map ? map.getCenter() : null);
      if (!c) return;
      el.osmBtn.disabled = true; el.osmBtn.textContent = '불러오는 중…';
      var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, opts.overpassTimeout || 30000);
      fetch(opts.overpassUrl || 'https://overpass-api.de/api/interpreter', {
        method: 'POST', body: 'data=' + encodeURIComponent(buildQuery(c, opts.radius || 1500)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, signal: ctl ? ctl.signal : undefined
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { showImport(importOsm(j, c, { radius: opts.radius })); })
        .catch(function (e) { modal('불러오기 실패', [h('p', { text: '공개 지도 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요. (' + (e && e.message || e) + ')' })], [{ id: 'close', label: '닫기', cls: 'me-btn-gold' }]); })
        .then(function () { clearTimeout(to); el.osmBtn.disabled = false; el.osmBtn.textContent = '공개 지도에서 불러오기'; });
    }
    function showImport(res) {
      var s = res.summary;
      self.lastImport = res;
      if (!s.holes) {
        modal('공개 지도 결과', [h('p', { text: '이 지역의 공개 지도(OSM)에는 홀 데이터가 없어요. 직접 찍어 주세요.' }),
          h('p', { class: 'me-muted', text: '그린 ' + s.greens + ' · 티 ' + s.tees + ' · 벙커 ' + s.bunker + ' (홀 선이 없어 매칭 불가)' })], [{ id: 'close', label: '닫기', cls: 'me-btn-gold' }]);
        return;
      }
      var rows = [
        ['골프장', s.course || '(경계 없음 · 반경 ' + ((opts.radius || 1500) / 1000) + 'km)'],
        ['홀', s.holes + '개 · ' + s.nines.map(function (n) { return n.name + ' ' + n.holes; }).join(' / ')],
        ['그린', s.greens + '개' + (s.twin ? ' (투그린 홀 ' + s.twin + '개)' : '')], ['티', s.tees + '개'],
        ['벙커', s.bunker + '개'], ['해저드(물)', s.water + '개'], ['OB', s.ob + '개']
      ];
      var notes = [];
      if (s.noPar) notes.push('파 정보 없는 홀 ' + s.noPar);
      if (s.noRef) notes.push('번호 없는 홀 ' + s.noRef + ' 제외');
      if (s.outside) notes.push('코스 밖 요소 ' + s.outside + ' 제외');
      if (s.unassigned) notes.push('홀 매칭 안 된 요소 ' + s.unassigned);
      var tbl = h('dl', { class: 'me-sum' }); rows.forEach(function (r) { tbl.appendChild(h('dt', { text: r[0] })); tbl.appendChild(h('dd', { text: r[1] })); });
      var modeNote = null;
      if (s.greenMode === 'two' && data.greenMode !== 'two') modeNote = '투그린 홀이 대부분이라 코스를 투그린으로 설정해요.';
      else if (s.twin && data.greenMode !== 'two') modeNote = '투그린 홀 ' + s.twin + '개는 좌 그린만 들어가요 (원그린 코스). 투그린이면 상단에서 바꿔 주세요.';
      var anyUser = data.nines.some(function (nn) { return nn.holes.some(function (x) { return status(x) !== 'empty'; }); });
      var body = [tbl];
      if (modeNote) body.push(h('p', { class: 'me-note', text: modeNote }));
      if (notes.length) body.push(h('p', { class: 'me-muted', text: notes.join(' · ') }));
      body.push(h('p', { class: 'me-muted', text: '공개 지도 데이터는 부정확할 수 있어요. 불러온 뒤 위성사진으로 확인해 주세요.' }));
      var btns = [{ id: 'cancel', label: '취소' }];
      if (anyUser) btns.push({ id: 'fill', label: '빈 홀만 채우기', fn: function () { applyImport(res, false); } });
      btns.push({ id: 'replace', label: anyUser ? '전체 덮어쓰기' : '불러오기', cls: 'me-btn-gold', fn: function () { applyImport(res, true); } });
      modal('공개 지도에서 찾은 정보', body, btns);
    }
    function applyImport(res, overwrite) {
      pushUndo();
      var n = 0, switched = false;
      if (res.greenMode === 'two' && data.greenMode !== 'two') { // OSM says mostly two-green: switch the club
        data.greenMode = 'two'; switched = true;
        data.nines.forEach(function (nn) { nn.holes.forEach(function (x) { conformHole(x, 'two'); }); });
      }
      res.nines.forEach(function (nn, i) {
        if (!data.nines[i]) { var ne = emptyNine(nn.name); ne.holes.forEach(function (x) { conformHole(x, data.greenMode); }); data.nines.push(ne); }
        var tgt = data.nines[i];
        if (overwrite && nn.name) tgt.name = nn.name;
        nn.holes.forEach(function (x, hi) {
          if (x.src !== 'osm') return;
          if (overwrite || status(tgt.holes[hi]) === 'empty') { var c = JSON.parse(JSON.stringify(x)); conformHole(c, data.greenMode); tgt.holes[hi] = c; n++; }
        });
      });
      if (!data.club && res.club) data.club = res.club;
      if (!data.center && res.center) data.center = res.center;
      changed();
      toast(n + '개 홀을 불러왔어요' + (switched ? ' · 투그린 코스로 설정' : ''));
      S.side = 0;
      if (map) fitAll();
    }

    function exportJson() {
      var d = self.getData(), blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      var a = h('a', { href: URL.createObjectURL(blob), download: (d.club || 'course') + '-map.json' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('JSON 파일을 내보냈어요');
    }
    function importJson(file) {
      var r = new FileReader();
      r.addEventListener('load', function () {
        try {
          var d = JSON.parse(r.result);
          if (!d || !Array.isArray(d.nines)) throw new Error('nines 없음');
          pushUndo(); data = normalize(d, opts); S.ni = 0; S.hi = 0; S.tool = 'tee';
          changed(); if (map) fitAll(); toast('JSON을 불러왔어요');
        } catch (e) { toast('JSON 형식이 올바르지 않아요'); }
      });
      r.readAsText(file);
    }
    function save() {
      var d = self.getData();
      store(draftKey, JSON.stringify({ savedAt: new Date().toISOString(), data: d }));
      if (typeof opts.onSave !== 'function') { toast('기기에 임시저장했어요'); return; }
      el.saveBtn.disabled = true;
      Promise.resolve().then(function () { return opts.onSave(d); })
        .then(function () { toast('저장했어요'); }, function (e) { toast('저장 실패: ' + (e && e.message || e)); })
        .then(function () { el.saveBtn.disabled = false; });
    }

    /* ---------- events (delegated, no inline handlers) */
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !root.contains(b)) return;
      if (b.hasAttribute('data-dlg')) return;
      var act = b.getAttribute('data-act');
      if (act !== 'more' && act !== 'layers') closePopups();
      if (b.hasAttribute('data-tool')) { S.tool = b.getAttribute('data-tool'); renderTools(); return; }
      if (b.hasAttribute('data-hole')) { selectHole(S.ni, +b.getAttribute('data-hole'), true); return; }
      if (b.hasAttribute('data-nine')) {
        var ni = +b.getAttribute('data-nine');
        if (ni === S.ni) { S.renaming = true; renderTabs(); return; }
        selectHole(ni, 0, true); return;
      }
      if (act === 'parall') { parAllDialog(); return; }
      if (b.hasAttribute('data-par')) {
        var p = +b.getAttribute('data-par'); pushUndo(); hole().par = hole().par === p ? null : p; changed(); return;
      }
      if (b.hasAttribute('data-mode')) { setMode(b.getAttribute('data-mode')); return; }
      if (b.hasAttribute('data-side')) {
        var x0 = hole(), si = +b.getAttribute('data-side'), g0 = G(x0, si);
        S.side = si;
        if (isGreenTool(S.tool) || x0.tees.length) S.tool = !g0.front ? 'front' : !g0.center ? 'center' : !g0.back ? 'back' : (isGreenTool(S.tool) ? S.tool : 'center');
        renderAll(); return;
      }
      if (b.hasAttribute('data-layer')) { setLayer(+b.getAttribute('data-layer')); el.layerList.hidden = true; return; }
      if (b.hasAttribute('data-tee')) {
        var x = hole(), t = x.tees[+b.getAttribute('data-tee')], all = TEE_LABELS;
        pushUndo(); t.label = all[(all.indexOf(t.label) + 1) % all.length]; changed(); return;
      }
      switch (act) {
        case 'osm': osmImport(); break;
        case 'more': el.menu.hidden = !el.menu.hidden; el.layerList.hidden = true; break;
        case 'save': save(); break;
        case 'export': exportJson(); break;
        case 'import': el.file.value = ''; el.file.click(); break;
        case 'rename': S.renaming = true; renderTabs(); break;
        case 'addnine':
          if (data.nines.length >= 6) { toast('나인은 6개까지 추가할 수 있어요'); break; }
          pushUndo(); var nn9 = emptyNine('코스' + (data.nines.length + 1)); nn9.holes.forEach(function (x) { conformHole(x, data.greenMode); }); data.nines.push(nn9); S.ni = data.nines.length - 1; S.hi = 0; S.tool = 'tee'; S.renaming = true; changed(); break;
        case 'delnine':
          if (data.nines.length <= 1) { toast('나인은 최소 1개가 필요해요'); break; }
          modal('나인 삭제', [h('p', { text: '「' + nine().name + '」 나인과 그 안의 9개 홀 정보를 지울까요? 되돌리기로 복구할 수 있어요.' })], [
            { id: 'cancel', label: '취소' },
            { id: 'ok', label: '삭제', cls: 'me-btn-gold', fn: function () { pushUndo(); data.nines.splice(S.ni, 1); S.ni = Math.max(0, S.ni - 1); S.hi = 0; changed(); } }
          ]); break;
        case 'mode-ok': setMode('one'); break;
        case 'mode-cancel': S.modeAsk = false; renderMode(); break;
        case 'onegreen': {
          var hx = hole();
          if (hx.oneGreen) { pushUndo(); delete hx.oneGreen; addTwin(hx); S.side = 0; changed(); break; }
          if (hx.greens && (greenAny(hx.greens[1]) || hx.greens[1].poly) && !S.twinOff) { S.twinOff = true; renderGreenBar(); break; }
          pushUndo(); dropTwin(hx); hx.oneGreen = true; S.side = 0; S.twinOff = false; changed(); break;
        }
        case 'twinoff-ok': { var hy = hole(); pushUndo(); dropTwin(hy); hy.oneGreen = true; S.side = 0; S.twinOff = false; changed(); break; }
        case 'twinoff-cancel': S.twinOff = false; renderGreenBar(); break;
        case 'undo': undo(); break;
        case 'clear': clearHole(); break;
        case 'autofill': autofill(); break;
        case 'dismiss': S.dismissed[S.ni + ':' + S.hi] = 1; renderInfo(); break;
        case 'layers': el.layerList.hidden = !el.layerList.hidden; el.menu.hidden = true; break;
        case 'zin': if (map) map.zoomBy(1); break;
        case 'zout': if (map) map.zoomBy(-1); break;
        case 'fit': if (map) { if (holePoints(hole()).length) fitHole(); else fitAll(); } break;
      }
    });
    el.file.addEventListener('change', function () { if (el.file.files && el.file.files[0]) importJson(el.file.files[0]); });
    document.addEventListener('keydown', this._key = function (e) {
      if (!root.isConnected) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); undo(); }
      if (e.key === 'Escape') { closePopups(); if (!el.modal.hidden) el.modal.hidden = true; }
    });

    /* ---------- map init */
    function initMap(adapter) {
      map = adapter;
      if (layers[S.layer]) map.setLayer(layers[S.layer]);
      var c = data.center || P(opts.center) || { lat: 37.5665, lon: 126.978 };
      map.setView(c, opts.zoom || 16);
      map.onClick(place);
      var anyPts = data.nines.some(function (nn) { return nn.holes.some(function (x) { return holePoints(x).length; }); });
      if (anyPts) { if (holePoints(hole()).length) fitHole(); else fitAll(); }
      redrawMap();
    }
    var want = opts.renderer || 'builtin';
    this.ready = (want === 'leaflet' ? loadLeaflet(opts).then(function () { initMap(createLeafletMap(el.mapHost, opts)); return 'leaflet'; }, function () {
      initMap(createBuiltinMap(el.mapHost, opts)); toast('Leaflet을 불러오지 못해 내장 지도로 표시해요'); return 'builtin';
    }) : Promise.resolve().then(function () { return 'builtin'; }));
    if (want !== 'leaflet') initMap(createBuiltinMap(el.mapHost, opts));
    if (!data.center && opts.center) data.center = normPt(opts.center);
    renderAll();
    if (restored) toast('임시저장본을 불러왔어요');

    /* ---------- public */
    this.getData = function () { return exportData(data); };
    this.setData = function (d) { pushUndo(); data = normalize(d, opts); S.ni = 0; S.hi = 0; S.tool = 'tee'; changed(); if (map) fitAll(); };
    this.clearDraft = function () { store(draftKey, null); };
    this.destroy = function () { document.removeEventListener('keydown', self._key); if (map) map.destroy(); root.innerHTML = ''; root.classList.remove('mapedit'); };
    this.debug = {
      get map() { return map; }, get state() { return S; },
      project: function (lat, lon) { var p = map.project({ lat: lat, lon: lon }), r = el.mapHost.getBoundingClientRect(); return { x: r.left + p[0], y: r.top + p[1] }; },
      unproject: function (x, y) { var r = el.mapHost.getBoundingClientRect(); return map.unproject(x - r.left, y - r.top); },
      setView: function (lat, lon, z) { map.setView({ lat: lat, lon: lon }, z); if (map.renderNow) map.renderNow(); },
      importOsm: importOsm
    };
  }

  var current = null;
  window.MapEdit = {
    version: '1.0.0',
    mount: function (el, opts) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) throw new Error('MapEdit.mount: element not found');
      if (current && current.root === el) current.destroy();
      current = new Editor(el, opts); current.root = el;
      return current;
    },
    getData: function () { return current ? current.getData() : null; },
    setData: function (d) { if (current) current.setData(d); },
    get instance() { return current; },
    util: { dist: dist, normalize: normalize, importOsm: importOsm, buildQuery: buildQuery, projW: projW, unprojW: unprojW }
  };
})();
