import { parseTemplate, buildKmz, missionStats, distanceM, ACTIONS, DEFAULT_DRONE_ENUM } from './wpml.js';

// ================= 저장소 =================
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast('저장 공간이 부족합니다.'); return false; } },
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function defaultSettings() {
  return { speed: 5, finishAction: 'goHome', rcLost: 'goBack', pathMode: 'keep', headingMode: 'path', defaultHeight: 30, defaultGimbal: -30, nextHeight: 30, nextGimbal: -30, nextAction: 'none', hoverSec: 5 };
}
function newMission(name) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id: uid(),
    name: name || `미션 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    createdAt: Date.now(), updatedAt: Date.now(), settings: defaultSettings(), points: [], takeoff: null,
  };
}

const state = {
  missions: LS.get('wp.missions', []),
  currentId: LS.get('wp.current', null),
  template: null, // 파싱된 템플릿
  fix: null, prevFix: null, geoError: null, watching: false,
  measuring: null, // {start, samples, timer}
  map: null, mapLayers: null,
  guide: LS.get('wp.guide', { ctrl: 'rc', done: {} }),
  editIndex: -1,
};
if (!state.missions.length) state.missions.push(newMission());
if (!state.missions.find((m) => m.id === state.currentId)) state.currentId = state.missions[0].id;
const M = () => state.missions.find((m) => m.id === state.currentId);
function save() { const m = M(); m.updatedAt = Date.now(); LS.set('wp.missions', state.missions); LS.set('wp.current', state.currentId); }
// 오래된 저장 데이터 보정
state.missions.forEach((m) => { m.settings = { ...defaultSettings(), ...m.settings }; });

// ================= 공통 UI =================
let toastTimer;
function toast(msg, actionLabel, action, ms = 3500) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { action(); t.classList.add('hidden'); };
    t.appendChild(b);
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + 'km' : Math.round(m) + 'm');
const fmtDur = (s) => { s = Math.round(s); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; };

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'list') { renderList(); setTimeout(initMap, 30); }
  if (name === 'export') renderExport();
  if (name === 'guide') renderGuide();
  LS.set('wp.tab', name);
}
$$('.tabbar button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); switchTab(g.dataset.goto); }
  if (e.target.matches('[data-close]') || e.target.classList.contains('sheet')) {
    e.target.closest('.sheet')?.classList.add('hidden');
  }
});

// ================= GPS =================
// 데모 모드(?demo): 실제 GPS 없이 집에서 사용법을 연습할 수 있도록 가짜 위치를 만든다.
const DEMO = new URLSearchParams(location.search).has('demo');
const demo = { lat: 37.566535, lng: 126.977969, alt: 38 };
function startDemoGps() {
  setInterval(() => {
    const j = () => (Math.random() - 0.5) * 0.00002;
    onPos({ coords: { latitude: demo.lat + j(), longitude: demo.lng + j(), accuracy: 2.5 + Math.random() * 2, altitude: demo.alt + Math.random(), altitudeAccuracy: 5, speed: 0, heading: null }, timestamp: Date.now() });
  }, 1000);
}
function demoMove() { // 등록 후 다음 지점으로 약 60~90m 이동
  const a = Math.random() * Math.PI * 2, d = 0.0006 + Math.random() * 0.0003;
  demo.lat += Math.sin(a) * d; demo.lng += Math.cos(a) * d * 1.25; demo.alt += (Math.random() - 0.4) * 6;
}

function startGps() {
  if (DEMO) { startDemoGps(); toast('🧪 데모 모드: 가짜 GPS로 연습 중입니다', null, null, 5000); return; }
  if (!('geolocation' in navigator)) { state.geoError = 'unsupported'; renderGps(); return; }
  if (!window.isSecureContext) { state.geoError = 'insecure'; renderGps(); return; }
  navigator.geolocation.watchPosition(onPos, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  state.watching = true;
}
function onPos(pos) {
  const c = pos.coords;
  const f = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy, speed: c.speed, heading: c.heading, time: pos.timestamp || Date.now() };
  if ((f.speed === null || Number.isNaN(f.speed)) && state.fix) {
    const dt = (f.time - state.fix.time) / 1000;
    f.speed = dt > 0.5 ? distanceM(state.fix, f) / dt : state.fix.speed;
  }
  state.prevFix = state.fix;
  state.fix = f;
  state.geoError = null;
  if (state.measuring) state.measuring.samples.push(f);
  renderGps();
  updateMeMarker();
}
function onGeoErr(err) {
  state.geoError = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
  renderGps();
}
// 위치 신호가 오래되면 상태 갱신
setInterval(renderGps, 2000);

function accLevel(acc) { return acc <= 5 ? 'ok' : acc <= 15 ? 'warn' : 'bad'; }
function isFresh() { return state.fix && Date.now() - state.fix.time < 15000; }
function isMoving() { return state.fix && (state.fix.speed || 0) > 2; }

function setHint(text, level = '') {
  const h = $('#hint');
  h.textContent = text;
  h.className = 'hint ' + level;
}

function renderGps() {
  const f = state.fix, m = M(), n = m.points.length;
  const dot = $('#gpsDot'), btn = $('#registerBtn');
  if (state.geoError && !isFresh()) {
    dot.className = 'dot dot-bad';
    $('#gpsAcc').textContent = '--';
    const msg = {
      unsupported: '이 브라우저는 위치 기능을 지원하지 않습니다.',
      insecure: '⚠️ GPS는 https:// 주소에서만 동작합니다. 앱을 HTTPS로 배포한 주소로 접속하세요.',
      denied: '⛔ 위치 권한이 거부되었습니다. 브라우저 주소창의 자물쇠(또는 설정 › 사이트 권한 › 위치)에서 “허용”으로 바꾼 뒤 새로고침하세요.',
      timeout: 'GPS 응답이 없습니다. 휴대폰의 위치(GPS) 기능이 켜져 있는지 확인하세요.',
      unavailable: '위치를 가져올 수 없습니다. 휴대폰 위치 설정을 “높은 정확도”로 켜 주세요.',
    }[state.geoError];
    $('#gpsSub').textContent = '신호 없음';
    setHint(msg, 'bad');
    btn.disabled = true;
    return;
  }
  if (!f) {
    dot.className = 'dot dot-off';
    $('#gpsSub').textContent = 'GPS 신호 찾는 중…';
    setHint('📡 GPS 신호를 찾는 중입니다. 위치 권한 요청이 뜨면 “허용”을 누르고, 하늘이 트인 곳에서 잠시 기다리세요.');
    btn.disabled = true;
    return;
  }
  const lvl = accLevel(f.acc);
  const fresh = isFresh();
  dot.className = 'dot ' + (fresh ? 'dot-' + lvl : 'dot-off');
  $('#gpsAcc').textContent = '±' + (f.acc < 10 ? f.acc.toFixed(1) : Math.round(f.acc)) + 'm';
  const bar = $('#accBar');
  bar.style.width = Math.max(5, Math.min(100, 100 - (f.acc - 3) * 3.5)) + '%';
  bar.style.background = `var(--${lvl === 'ok' ? 'ok' : lvl === 'warn' ? 'warn' : 'bad'})`;
  const kmh = (f.speed || 0) * 3.6;
  $('#gpsSpeed').textContent = kmh < 1 ? '정지' : Math.round(kmh) + 'km/h';
  const last = m.points[n - 1];
  const dPrev = last ? distanceM(last, f) : null;
  $('#gpsPrev').textContent = dPrev === null ? '-' : fmtDist(dPrev);
  $('#gpsSub').textContent = `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}` + (fresh ? '' : ' (신호 끊김)');
  btn.disabled = !fresh || !!state.measuring;
  $('#registerSub').textContent = `WP ${n + 1} · 높이 ${$('#heightInput').value}m`;
  renderTerrainHint();
  if (state.measuring) return; // 측정 중에는 측정 안내 유지

  // 실시간 안내 문구
  if (!fresh) return setHint('📡 위치 신호가 끊겼습니다. 실내·지하·터널이라면 밖으로 나오세요.', 'bad');
  if (isMoving()) return setHint(`🚗 이동 중(${Math.round(kmh)}km/h)입니다. 등록할 지점에 정차한 뒤 누르면 정확도가 좋아집니다.`, 'warn');
  if (lvl === 'bad') return setHint(`⚠️ 정확도가 낮습니다(±${Math.round(f.acc)}m). 건물·나무·차량 지붕 아래를 피하고 10~20초 기다려 보세요.`, 'warn');
  if (dPrev !== null && dPrev < 3) return setHint(`↔️ 이전 지점(WP${n})과 ${dPrev.toFixed(1)}m 떨어져 있습니다. 다음 지점으로 이동하세요.`, 'warn');
  if (n === 0) return setHint('✅ 준비 완료! 첫 번째 지점(WP1)에 서서 높이를 확인하고 아래 등록 버튼을 누르세요.', 'ok');
  if (n === 1) return setHint('👍 WP1 등록됨. 다음 지점으로 이동해 WP2를 등록하세요. (최소 2개 필요)', 'ok');
  setHint(`✅ ${n}개 등록됨. 다음 지점에서 계속 등록하거나, 끝났으면 아래 ‘내보내기’ 탭으로 가세요.`, 'ok');
}

function renderTerrainHint() {
  const m = M(), f = state.fix, el = $('#terrainHint');
  if (!m.takeoff) { el.classList.remove('hidden'); el.innerHTML = '💡 높이는 <b>이륙 지점 기준</b>입니다. 이륙할 곳에서 <b>🛫 이륙 지점 기록</b>을 눌러 두면 현재 위치의 지면 고도차를 참고로 보여드립니다.'; return; }
  if (!f) { el.classList.add('hidden'); return; }
  const d = distanceM(m.takeoff, f);
  let txt = `🛫 이륙 지점에서 ${fmtDist(d)}`;
  if (f.alt !== null && f.alt !== undefined && m.takeoff.alt !== null && m.takeoff.alt !== undefined) {
    const diff = f.alt - m.takeoff.alt;
    const h = Number($('#heightInput').value) || 0;
    const sign = diff >= 0 ? '+' : '';
    txt += ` · 지면 고도차 약 <b>${sign}${Math.round(diff)}m</b> (휴대폰 GPS 고도라 오차 ±10m 이상)`;
    if (Math.abs(diff) >= 5) txt += `<br>→ 이 지점 지면 위 실제 높이 ≈ <b>${Math.round(h - diff)}m</b>`;
    if (h - diff < 15) txt += ' <b style="color:var(--bad)">⚠️ 지면과 너무 가깝습니다</b>';
  } else txt += ' · (이 기기는 고도 정보를 제공하지 않음)';
  if (d > 1500) txt += '<br>⚠️ 이륙 지점에서 멀어 조종기 신호가 약해질 수 있습니다.';
  el.innerHTML = txt;
  el.classList.remove('hidden');
}

// ================= 등록 =================
const heightInput = $('#heightInput');
function setHeight(v) {
  v = Math.max(2, Math.min(500, Math.round(Number(v) || 0)));
  heightInput.value = v;
  M().settings.nextHeight = v; save();
  $$('#heightChips button').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === v));
  renderGps();
}
$$('.stepper button').forEach((b) => (b.onclick = () => setHeight(Number(heightInput.value) + Number(b.dataset.step))));
$$('#heightChips button').forEach((b) => (b.onclick = () => setHeight(b.dataset.h)));
heightInput.onchange = () => setHeight(heightInput.value);

function setAction(a) {
  M().settings.nextAction = a; save();
  $$('#actionChips button').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
  $('#hoverRow').classList.toggle('hidden', a !== 'hover');
}
$$('#actionChips button').forEach((b) => (b.onclick = () => setAction(b.dataset.a)));
$('#gimbalInput').oninput = (e) => { $('#gimbalVal').textContent = e.target.value + '°'; M().settings.nextGimbal = Number(e.target.value); save(); };
$('#hoverInput').onchange = (e) => { M().settings.hoverSec = Math.max(1, Number(e.target.value) || 5); save(); };

$('#registerBtn').onclick = () => {
  if (!isFresh()) return;
  const f = state.fix;
  if (f.acc > 15 && !confirm(`현재 GPS 정확도가 ±${Math.round(f.acc)}m로 낮습니다.\n그래도 등록할까요?\n(취소 후 잠시 기다리면 정확도가 좋아질 수 있습니다)`)) return;
  const precise = $('#preciseChk').checked && !isMoving();
  if (!precise) return addPoint([f], false);
  startMeasuring();
};

function startMeasuring() {
  const DURATION = 5000;
  const btn = $('#registerBtn'), ring = $('#progressRing'), circle = ring.querySelector('circle');
  state.measuring = { start: Date.now(), samples: state.fix ? [state.fix] : [] };
  btn.classList.add('measuring'); btn.disabled = true; ring.classList.remove('hidden');
  setHint('🎯 정밀 측정 중… 휴대폰을 들고 제자리에 가만히 서 있으세요.', '');
  const tick = () => {
    if (!state.measuring) return;
    const t = Date.now() - state.measuring.start;
    circle.style.strokeDashoffset = String(289 * (1 - Math.min(1, t / DURATION)));
    $('#registerText').textContent = `🎯 측정 중 ${Math.ceil((DURATION - t) / 1000)}초`;
    if (t >= DURATION) {
      const samples = state.measuring.samples;
      state.measuring = null;
      btn.classList.remove('measuring'); ring.classList.add('hidden'); circle.style.strokeDashoffset = '289';
      $('#registerText').textContent = '📍 이 위치 등록';
      addPoint(samples.length ? samples : [state.fix], true);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function averageFix(samples) {
  // 정확도 가중 평균 (w = 1/acc²), 최근 값 위주
  let sw = 0, lat = 0, lng = 0, alt = 0, altW = 0;
  for (const s of samples) {
    const w = 1 / Math.max(1, s.acc) ** 2;
    sw += w; lat += s.lat * w; lng += s.lng * w;
    if (s.alt !== null && s.alt !== undefined) { alt += s.alt * w; altW += w; }
  }
  const best = Math.min(...samples.map((s) => s.acc));
  return { lat: lat / sw, lng: lng / sw, alt: altW ? alt / altW : null, acc: samples.length > 1 ? Math.max(best * 0.8, 1) : best, n: samples.length };
}

function addPoint(samples, precise) {
  const m = M(), s = m.settings;
  const avg = averageFix(samples);
  const p = {
    id: uid(), lat: avg.lat, lng: avg.lng, gpsAlt: avg.alt, accuracy: avg.acc, samples: avg.n, precise,
    height: Number(heightInput.value) || s.defaultHeight,
    gimbal: Number($('#gimbalInput').value),
    action: s.nextAction, hoverSec: s.hoverSec, memo: '', time: Date.now(),
  };
  m.points.push(p);
  save();
  navigator.vibrate?.([60, 40, 60]);
  toast(`WP${m.points.length} 등록 완료 (±${p.accuracy.toFixed(1)}m, 높이 ${p.height}m)`, '메모 추가', () => openEdit(m.points.length - 1), 4000);
  // 녹화 시작 후에는 다음 지점 기본 동작을 '없음'으로
  if (s.nextAction === 'startRecord' || s.nextAction === 'stopRecord') setAction('none');
  if (DEMO) setTimeout(demoMove, 1500);
  renderAll();
}

$('#undoBtn').onclick = () => {
  const m = M();
  const p = m.points.pop();
  if (!p) return;
  save(); renderAll();
  toast(`WP${m.points.length + 1} 삭제됨`, '되돌리기', () => { m.points.push(p); save(); renderAll(); });
};

$('#takeoffBtn').onclick = () => {
  if (!isFresh()) return toast('GPS 신호를 기다린 뒤 눌러 주세요.');
  const m = M(), f = state.fix;
  if (m.takeoff && !confirm('이륙 지점을 현재 위치로 다시 기록할까요?')) return;
  m.takeoff = { lat: f.lat, lng: f.lng, alt: f.alt, acc: f.acc, time: Date.now() };
  save(); renderAll();
  toast('🛫 이륙 지점 기록됨 (높이 계산 참고용, 미션에는 포함되지 않음)');
};

// ================= 목록 / 지도 =================
function renderList() {
  const m = M(), pts = m.points;
  $('#listEmpty').classList.toggle('hidden', pts.length > 0);
  const st = missionStats(m);
  $('#stats').innerHTML = `<div><b>${pts.length}</b><small>웨이포인트</small></div><div><b>${fmtDist(st.dist)}</b><small>총 거리</small></div><div><b>${fmtDur(st.duration)}</b><small>예상 비행(${m.settings.speed}m/s)</small></div>`;
  $('#wpList').innerHTML = pts.map((p, i) => {
    const d = i ? fmtDist(distanceM(pts[i - 1], p)) : '시작';
    const act = (p.action && p.action !== 'none' ? ' · ' + ACTIONS[p.action] + (p.action === 'hover' ? ` ${p.hoverSec}s` : '') : '') +
      (p.heading !== null && p.heading !== undefined ? ` · 기수 ${Math.round(p.heading)}°` : '');
    const g = p.gimbal ?? m.settings.defaultGimbal;
    return `<li><span class="wp-num">${i + 1}</span><div class="wp-body"><b>${p.height}m</b> <small class="muted">짐벌 ${g}°${act}</small>
      <div>${esc(p.memo) || `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`} · ${d} · ±${(p.accuracy ?? 0).toFixed(1)}m</div></div>
      <button class="edit" data-i="${i}">편집</button></li>`;
  }).join('');
  $$('#wpList .edit').forEach((b) => (b.onclick = () => openEdit(Number(b.dataset.i))));
  drawMap();
}

function initMap() {
  if (state.map || !window.L || !$('#tab-list').classList.contains('active')) return drawMap();
  const el = $('#map');
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: true });
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' });
  sat.addTo(map);
  L.control.layers({ '위성': sat, '일반 지도': osm }).addTo(map);
  state.map = map;
  state.mapLayers = L.layerGroup().addTo(map);
  map.setView([36.5, 127.8], 7);
  drawMap(true);
}

function drawMap(fit = true) {
  if (!state.map) return;
  const m = M(), pts = m.points, layer = state.mapLayers;
  layer.clearLayers();
  if (pts.length > 1) L.polyline(pts.map((p) => [p.lat, p.lng]), { color: '#facc15', weight: 4, opacity: .9 }).addTo(layer);
  pts.forEach((p, i) => {
    const cls = i === 0 ? 'first' : i === pts.length - 1 ? 'last' : '';
    const mk = L.marker([p.lat, p.lng], {
      draggable: true,
      icon: L.divIcon({ className: '', html: `<div class="wp-marker ${cls}" style="width:28px;height:28px">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    }).addTo(layer);
    mk.bindTooltip(`WP${i + 1} · ${p.height}m`, { direction: 'top', offset: [0, -14] });
    mk.on('click', () => openEdit(i));
    mk.on('dragend', (e) => {
      const old = { lat: p.lat, lng: p.lng };
      const ll = e.target.getLatLng();
      p.lat = ll.lat; p.lng = ll.lng; save(); renderList();
      toast(`WP${i + 1} 위치를 옮겼습니다 (${fmtDist(distanceM(old, p))})`, '되돌리기', () => { p.lat = old.lat; p.lng = old.lng; save(); renderList(); });
    });
  });
  if (m.takeoff) L.circleMarker([m.takeoff.lat, m.takeoff.lng], { radius: 9, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).bindTooltip('이륙 지점').addTo(layer);
  updateMeMarker();
  if (fit) {
    const all = pts.map((p) => [p.lat, p.lng]);
    if (m.takeoff) all.push([m.takeoff.lat, m.takeoff.lng]);
    if (all.length > 1) state.map.fitBounds(all, { padding: [30, 30], maxZoom: 18 });
    else if (all.length === 1) state.map.setView(all[0], 17);
    else if (state.fix) state.map.setView([state.fix.lat, state.fix.lng], 17);
  }
  setTimeout(() => state.map.invalidateSize(), 50);
}
let meMarker;
function updateMeMarker() {
  if (!state.map || !state.fix) return;
  const ll = [state.fix.lat, state.fix.lng];
  if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 1000 });
  meMarker.setLatLng(ll);
  if (!state.map.hasLayer(meMarker)) meMarker.addTo(state.map);
}

// ---- 편집 시트 ----
function openEdit(i) {
  const m = M(), p = m.points[i];
  if (!p) return;
  state.editIndex = i;
  $('#editTitle').textContent = `WP${i + 1} 편집`;
  $('#eHeight').value = p.height;
  $('#eGimbal').value = p.gimbal ?? '';
  $('#eAction').value = p.action || 'none';
  $('#eHover').value = p.hoverSec || 5;
  $('#eMemo').value = p.memo || '';
  $('#eHeading').value = p.heading ?? '';
  $('#eInfo').textContent = `${p.lat.toFixed(7)}, ${p.lng.toFixed(7)} · 정확도 ±${(p.accuracy ?? 0).toFixed(1)}m${p.precise ? ` (정밀 ${p.samples}회 평균)` : ''} · ${new Date(p.time).toLocaleString('ko-KR')}`;
  $('#eUp').disabled = i === 0;
  $('#eDown').disabled = i === m.points.length - 1;
  $('#editSheet').classList.remove('hidden');
}
$('#eSave').onclick = () => {
  const p = M().points[state.editIndex];
  const h = Number($('#eHeight').value);
  if (!(h >= 2 && h <= 500)) return toast('높이는 2~500m 사이로 입력하세요.');
  p.height = Math.round(h * 10) / 10;
  const g = $('#eGimbal').value;
  p.gimbal = g === '' ? null : Math.max(-90, Math.min(0, Number(g)));
  p.action = $('#eAction').value;
  p.hoverSec = Math.max(1, Number($('#eHover').value) || 5);
  p.memo = $('#eMemo').value.trim();
  const hd = $('#eHeading').value;
  p.heading = hd === '' ? null : ((((Number(hd) + 180) % 360) + 360) % 360) - 180; // -180~180
  save(); $('#editSheet').classList.add('hidden'); renderAll();
};
function movePoint(dir) {
  const pts = M().points, i = state.editIndex, j = i + dir;
  if (j < 0 || j >= pts.length) return;
  [pts[i], pts[j]] = [pts[j], pts[i]];
  save(); renderAll(); openEdit(j);
}
$('#eUp').onclick = () => movePoint(-1);
$('#eDown').onclick = () => movePoint(1);
$('#eDelete').onclick = () => {
  const m = M(), i = state.editIndex;
  const [p] = m.points.splice(i, 1);
  save(); $('#editSheet').classList.add('hidden'); renderAll();
  toast(`WP${i + 1} 삭제됨`, '되돌리기', () => { m.points.splice(i, 0, p); save(); renderAll(); });
};

// ================= 미션 관리 =================
$('#missionBtn').onclick = () => { renderMissionList(); $('#sheet').classList.remove('hidden'); };
function renderMissionList() {
  $('#missionList').innerHTML = state.missions.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((m) =>
    `<li data-id="${m.id}" class="${m.id === state.currentId ? 'on' : ''}"><span>${esc(m.name)}</span><small>${m.points.length}개 · ${new Date(m.updatedAt).toLocaleDateString('ko-KR')}</small></li>`).join('');
  $$('#missionList li').forEach((li) => (li.onclick = () => { state.currentId = li.dataset.id; save(); loadMissionUI(); $('#sheet').classList.add('hidden'); }));
}
$('#newMissionBtn').onclick = () => {
  const name = prompt('새 미션 이름', newMission().name);
  if (name === null) return;
  const m = newMission(name.trim() || undefined);
  const cur = M();
  if (cur) m.settings = { ...cur.settings }; // 이전 설정 이어받기
  state.missions.push(m); state.currentId = m.id; save(); loadMissionUI(); $('#sheet').classList.add('hidden');
  toast('새 미션을 만들었습니다.');
};
$('#renameMissionBtn').onclick = () => {
  const m = M(); const name = prompt('미션 이름', m.name);
  if (name && name.trim()) { m.name = name.trim(); save(); renderMissionList(); loadMissionUI(); }
};
$('#deleteMissionBtn').onclick = () => {
  const m = M();
  if (!confirm(`“${m.name}” (${m.points.length}개 지점)을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  state.missions = state.missions.filter((x) => x.id !== m.id);
  if (!state.missions.length) state.missions.push(newMission());
  state.currentId = state.missions[0].id; save(); renderMissionList(); loadMissionUI();
};

// ================= 내보내기 =================
const settingInputs = { setSpeed: 'speed', setFinish: 'finishAction', setRcLost: 'rcLost', setPath: 'pathMode', setHeading: 'headingMode', setDefH: 'defaultHeight', setDefG: 'defaultGimbal' };
Object.entries(settingInputs).forEach(([id, key]) => {
  $('#' + id).onchange = (e) => {
    const v = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    M().settings[key] = v; save(); renderExport();
    if (key === 'defaultHeight') toast('기본 높이는 새로 등록하는 지점에 적용됩니다.');
  };
});

function renderExport() {
  const m = M(), s = m.settings;
  Object.entries(settingInputs).forEach(([id, key]) => { $('#' + id).value = s[key]; });
  const tpl = state.template;
  $('#tplBadge').textContent = tpl ? '준비됨' : '없음';
  $('#tplBadge').className = 'badge' + (tpl ? ' ok' : '');
  const info = $('#tplInfo');
  if (tpl) {
    const i = tpl.info;
    info.innerHTML = `📄 <b>${esc(tpl.filename)}</b><br>WPML ${esc(i.wpmlVersion)} · 기체 코드 ${esc(i.droneEnum ?? '없음')}${i.droneSubEnum ? '-' + esc(i.droneSubEnum) : ''} · 원래 웨이포인트 ${i.placemarks}개 · 높이 기준 ${esc(i.heightMode || '-')}<br><button class="ghost" id="tplClear" style="margin-top:6px">템플릿 지우기</button>`;
    info.classList.remove('hidden');
    $('#tplClear').onclick = () => { state.template = null; localStorage.removeItem('wp.template'); renderExport(); };
  } else info.classList.add('hidden');

  // 검사
  const checks = [];
  const pts = m.points;
  checks.push(pts.length >= 2 ? ['ok', `웨이포인트 ${pts.length}개`] : ['bad', `웨이포인트가 ${pts.length}개입니다. 최소 2개 필요합니다.`]);
  checks.push(tpl ? ['ok', '템플릿 사용 (DJI Fly 형식 유지, 파일 이름 자동 일치)'] : ['warn', '템플릿 없음 → 실험적 생성. 가능하면 템플릿을 넣으세요.']);
  if (tpl && tpl.info.droneEnum && tpl.info.droneEnum !== DEFAULT_DRONE_ENUM) checks.push(['warn', `템플릿 기체 코드가 ${tpl.info.droneEnum}입니다 (Mavic 4 Pro 확인값 ${DEFAULT_DRONE_ENUM}). 다른 기체로 만든 미션이 아닌지 확인하세요.`]);
  if (tpl && tpl.info.heightMode && tpl.info.heightMode !== 'relativeToStartPoint') checks.push(['warn', `템플릿 높이 기준이 '${tpl.info.heightMode}'입니다. 이 앱의 높이는 이륙 지점 기준입니다.`]);
  const low = pts.filter((p) => p.height < 10).length;
  if (low) checks.push(['warn', `높이 10m 미만 지점 ${low}개 — 장애물 충돌 주의`]);
  const high = pts.filter((p) => p.height > 150).length;
  if (high) checks.push(['warn', `높이 150m 초과 지점 ${high}개 — 국내 비행고도 제한(150m) 초과, 승인 필요`]);
  const bad = pts.filter((p) => (p.accuracy ?? 0) > 15).length;
  if (bad) checks.push(['warn', `GPS 정확도 낮은 지점 ${bad}개 — 목록 탭 지도에서 위치를 확인·드래그 보정하세요`]);
  const st = missionStats(m);
  if (pts.length >= 2) checks.push(['ok', `총 ${fmtDist(st.dist)}, 예상 ${fmtDur(st.duration)}, 최고 ${st.maxH}m`]);
  if (st.duration > 25 * 60) checks.push(['warn', '예상 비행 시간이 25분을 넘습니다. 배터리 잔량을 고려해 미션을 나누세요.']);
  $('#checks').innerHTML = checks.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join('');
  $('#buildBtn').disabled = pts.length < 2;
}

function b64FromBuf(buf) {
  const u8 = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function bufFromB64(b64) { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8.buffer; }

$('#tplInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    state.template = await parseTemplate(buf, file.name);
    if ($('#tplRemember').checked) LS.set('wp.template', { filename: file.name, b64: b64FromBuf(buf) });
    toast('템플릿을 읽었습니다: ' + file.name);
    markGuide('tpl');
  } catch (err) {
    alert('템플릿을 읽지 못했습니다.\n' + err.message);
  }
  renderExport();
};
async function loadSavedTemplate() {
  const t = LS.get('wp.template', null);
  if (!t) return;
  try { state.template = await parseTemplate(bufFromB64(t.b64), t.filename); } catch { localStorage.removeItem('wp.template'); }
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function shareFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; } catch (e) { if (e.name === 'AbortError') return true; }
  }
  return false;
}

$('#buildBtn').onclick = async () => {
  const m = M();
  const btn = $('#buildBtn');
  btn.disabled = true; btn.textContent = '만드는 중…';
  try {
    const mission = { ...m, settings: { ...m.settings, pathMode: m.settings.pathMode === 'keep' ? null : m.settings.pathMode } };
    const outName = $('#outName').value.trim();
    const res = await buildKmz(mission, state.template, { droneEnum: $('#droneEnum').value.trim() || DEFAULT_DRONE_ENUM });
    let filename = res.filename;
    if (!state.template && outName) filename = /\.kmz$/i.test(outName) ? outName : outName + '.kmz';
    state.lastBuild = { blob: res.blob, filename };
    download(res.blob, filename);
    const box = $('#buildResult');
    box.innerHTML = `✅ <b>KMZ 생성 완료</b><br>파일 이름: <code>${esc(filename)}</code> (${(res.blob.size / 1024).toFixed(1)}KB)<br>
      이 파일을 조종기의 <b>같은 이름 파일이 있는 waypoint 폴더</b>에 덮어쓰세요. 다운로드 폴더에 같은 이름이 있으면 브라우저가 “(1)”을 붙이니 이름을 꼭 확인하세요.
      <div class="row-btns"><button class="ghost" id="shareKmz">📤 공유(카톡/메일/드라이브)</button><button class="ghost" data-goto="guide">🧭 다음 단계 안내</button></div>`;
    box.classList.remove('hidden');
    $('#shareKmz').onclick = async () => { if (!(await shareFile(res.blob, filename, filename))) toast('이 브라우저는 파일 공유를 지원하지 않습니다. 다운로드된 파일을 사용하세요.'); };
    markGuide('build');
  } catch (err) {
    alert('KMZ 생성 실패\n' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '📦 KMZ 만들기';
  }
};

$('#exportJsonBtn').onclick = async () => {
  const m = M();
  const blob = new Blob([JSON.stringify({ app: 'field-waypoint', version: 1, mission: m }, null, 1)], { type: 'application/json' });
  const name = `${m.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  if (!(await shareFile(blob, name, m.name))) download(blob, name);
};
$('#importJson').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const m = data.mission || data;
    if (!Array.isArray(m.points)) throw new Error('미션 형식이 아닙니다.');
    m.id = uid(); m.settings = { ...defaultSettings(), ...m.settings }; m.updatedAt = Date.now();
    if (state.missions.some((x) => x.name === m.name)) m.name += ' (가져옴)';
    state.missions.push(m); state.currentId = m.id; save(); loadMissionUI(); switchTab('export');
    toast(`“${m.name}” 불러옴 (${m.points.length}개 지점)`);
  } catch (err) { alert('불러오기 실패: ' + err.message); }
};

// ================= 가이드 =================
const P = (...parts) => `<div class="path">${parts.map((p) => `<span>${p}</span>`).join('<i>›</i>')}</div>`;
function guideSteps(ctrl) {
  const field = {
    id: 'field', where: '스마트폰 · 현장', title: '현장에서 웨이포인트 등록',
    body: `<ol><li>이 앱의 <b>등록</b> 탭에서 이륙할 곳에 서서 <b>🛫 이륙 지점 기록</b>(선택)</li>
      <li>지점마다 이동 → GPS가 <b style="color:var(--ok)">초록</b>이 될 때까지 대기 → 높이 확인 → <b>📍 이 위치 등록</b></li>
      <li>차량이면 <b>정차 후</b> 등록. 최소 2개 이상.</li></ol>`,
    action: ['등록 탭으로', 'register'],
  };
  const dummy = {
    id: 'dummy', where: ctrl === 'rc' ? '조종기' : '휴대폰 DJI Fly', title: 'DJI Fly에서 더미 미션 만들기',
    body: `<ol><li>DJI Fly 실행 → 카메라 화면 왼쪽의 <b>웨이포인트 아이콘</b> 탭 (기체 연결 없이도 가능)</li>
      <li>지도에서 아무 곳이나 <b>웨이포인트 2개</b> 찍기</li>
      <li><b>저장 후 종료</b> → 미션 목록에서 이름 확인(예: 날짜/시간)</li></ol>
      <div class="tip">💡 한 번 만든 더미 미션을 ‘슬롯’처럼 계속 덮어써도 됩니다. 미션을 여러 개 보관하려면 매번 새 더미를 만드세요.<br>
      기체를 날려서 지점을 찍으면 미션 폴더 안 <b>image</b> 폴더에 지점 사진 미리보기가 생깁니다. 덮어쓴 뒤에도 옛 사진이 미리보기로 남을 수 있지만 비행 경로와는 무관합니다.</div>`,
  };
  const findPath = {
    rc: {
      id: 'copy', where: 'PC', title: '조종기를 PC에 연결해 더미 파일 찾기',
      body: `<ol><li>조종기를 켜고 <b>USB-C 케이블</b>로 PC에 연결 (충전 전용 케이블은 안 됨)</li>
        <li>조종기 화면에 USB 알림이 뜨면 <b>파일 전송</b> 선택</li>
        <li>PC 파일 탐색기에서 이동:</li></ol>
        ${P('내 PC', 'DJI RC 2 (조종기 이름)', '내부 저장소', 'Android', 'data', 'dji.go.v5', 'files', 'waypoint')}
        <ol start="4"><li>보기를 <b>자세히</b>로 바꾸고 <b>수정한 날짜</b>로 정렬 → <b>가장 최근 폴더</b> 열기<br>
        <small class="muted">(예: 1A2B3C4D-…처럼 긴 이름 — 폴더 안에 같은 이름의 .kmz와 image 폴더가 있음)</small></li>
        <li>안에 있는 <b>.kmz 파일</b>(폴더와 같은 긴 이름)을 PC 바탕화면으로 <b>복사</b></li></ol>
        <div class="tip">💡 조종기가 PC에 안 보이면: 다른 USB 케이블/포트 사용, 조종기 화면 잠금 해제, Windows에서 ‘휴대용 장치’ 항목 확인.</div>`,
    },
    ios: {
      id: 'copy', where: 'iPhone / PC', title: 'DJI Fly 미션 파일 찾기',
      body: `<ol><li><b>iPhone 파일 앱</b> › 나의 iPhone에 <b>DJI Fly</b> 폴더가 보이면 바로 사용:</li></ol>
        ${P('나의 iPhone', 'DJI Fly', 'wayline_mission')}
        <ol start="2"><li>보이지 않으면 PC 연결: Windows는 <b>Apple 기기(Apple Devices)</b> 앱 › 파일, Mac은 <b>Finder</b> › iPhone › 파일 › DJI Fly</li>
        <li><b>가장 최근 폴더</b> 안의 <b>.kmz 파일</b>을 복사 (iPhone 안에서 하면 ‘다운로드’ 폴더 등에 복사)</li></ol>`,
    },
    android: {
      id: 'copy', where: 'PC', title: '휴대폰을 PC에 연결해 더미 파일 찾기',
      body: `<ol><li>Android 11 이상은 휴대폰 파일 앱에서 Android/data 접근이 막혀 있어 <b>PC 연결</b>을 권장합니다.</li>
        <li>USB 연결 → 휴대폰 알림에서 <b>파일 전송</b> 선택 → PC 탐색기:</li></ol>
        ${P('내 PC', '휴대폰', '내장 메모리', 'Android', 'data', 'dji.go.v5', 'files', 'waypoint')}
        <ol start="3"><li><b>수정한 날짜</b> 정렬 → 가장 최근 폴더의 <b>.kmz</b> 복사</li></ol>`,
    },
  }[ctrl];
  const tpl = {
    id: 'tpl', where: 'PC 또는 폰', title: '템플릿 넣기',
    body: `<ol><li>이 앱을 PC 브라우저(또는 폰)에서 열고 <b>내보내기</b> 탭 → <b>📂 템플릿 KMZ 선택</b> → 방금 복사한 파일</li>
      <li><b>현장 미션이 폰에만 있다면</b>: 폰의 내보내기 탭 › <b>미션 파일(.json) 저장/공유</b> → 카톡 ‘나에게 보내기’ 등으로 PC에 전달 → PC에서 <b>미션 파일 불러오기</b></li>
      <li>또는 반대로 템플릿 파일을 폰으로 보내 폰에서 바로 만들어도 됩니다. 한 번 넣은 템플릿은 저장되어 다음부터 생략 가능.</li></ol>`,
    action: ['내보내기 탭으로', 'export'],
  };
  const build = {
    id: 'build', where: 'PC 또는 폰', title: 'KMZ 만들기',
    body: `<ol><li>미션 설정(속도·완료 동작)을 확인하고 <b>📦 KMZ 만들기</b></li>
      <li>템플릿과 <b>같은 파일 이름</b>으로 다운로드됩니다. 이름 뒤에 “(1)” 등이 붙었다면 지워서 원래 이름과 똑같이 만드세요.</li></ol>`,
    action: ['내보내기 탭으로', 'export'],
  };
  const replace = {
    id: 'replace', where: ctrl === 'ios' ? 'iPhone / PC' : 'PC', title: '같은 폴더에 덮어쓰기',
    body: `<ol><li>만든 KMZ를 3단계에서 연 <b>그 폴더</b>에 붙여넣기</li>
      <li>“파일 바꾸기(덮어쓰기)” 선택</li>
      <li>폴더 안에 kmz가 <b>하나만</b> 있고 이름이 원래와 같은지 확인</li></ol>
      <div class="tip">⚠️ 다른 폴더(다른 미션)에 넣으면 목록에 안 나타나거나 엉뚱한 미션이 바뀝니다.</div>`,
  };
  const fly = {
    id: 'fly', where: ctrl === 'rc' ? '조종기' : '휴대폰', title: 'DJI Fly에서 확인 후 비행',
    body: `<ol><li>DJI Fly를 <b>완전히 종료</b>(최근 앱에서 밀어서 닫기) 후 다시 실행</li>
      <li>웨이포인트 › 미션 목록에서 해당 미션 열기</li>
      <li>지도에서 <b>지점 위치·순서·높이</b>를 하나씩 확인 (높이는 이륙 지점 기준)</li>
      <li>기체 연결 → 이륙 지점이 계획과 같은지 확인 → 미션 시작</li></ol>
      <div class="tip">✈️ 첫 비행은 낮은 속도로, 장애물 회피 켜고, 눈으로 기체를 보면서 진행하세요. 비행금지·제한구역과 고도 제한(150m)을 확인하세요.</div>`,
  };
  return [field, dummy, findPath, tpl, build, replace, fly];
}
function markGuide(id) {
  const d = (state.guide.done[state.guide.ctrl] ||= []);
  if (!d.includes(id)) d.push(id);
  LS.set('wp.guide', state.guide);
}
function renderGuide() {
  const ctrl = state.guide.ctrl;
  $$('#ctrlChips button').forEach((b) => b.classList.toggle('on', b.dataset.c === ctrl));
  const steps = guideSteps(ctrl);
  const done = state.guide.done[ctrl] || [];
  if (M().points.length >= 2 && !done.includes('field')) done.push('field');
  const cur = steps.findIndex((s) => !done.includes(s.id));
  $('#guideBar').style.width = (done.filter((d) => steps.some((s) => s.id === d)).length / steps.length) * 100 + '%';
  $('#guideSteps').innerHTML = steps.map((s, i) => {
    const isDone = done.includes(s.id);
    return `<li class="${isDone ? 'done' : ''} ${i === cur ? 'current' : ''}" id="g-${s.id}">
      <div class="g-head"><span class="g-n">${i + 1}</span><span class="g-title">${s.title}</span><span class="g-where">${s.where}</span></div>
      ${i === cur || !isDone ? `<div class="g-body">${s.body}</div>` : ''}
      <div class="g-actions">
        ${s.action ? `<button class="ghost" data-goto="${s.action[1]}">${s.action[0]}</button>` : ''}
        <button class="${isDone ? 'ghost' : 'primary'}" data-gdone="${s.id}">${isDone ? '다시 하기' : '완료 ✓'}</button>
      </div></li>`;
  }).join('') + `<li><button class="ghost" id="guideReset" style="width:100%">처음부터 다시 (새 미션 업로드)</button></li>`;
  $$('[data-gdone]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.gdone, list = (state.guide.done[ctrl] ||= []);
    const k = list.indexOf(id);
    if (k >= 0) list.splice(k, 1); else list.push(id);
    LS.set('wp.guide', state.guide); renderGuide();
    const next = document.querySelector('.guide-steps li.current');
    next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  $('#guideReset').onclick = () => { state.guide.done[ctrl] = []; LS.set('wp.guide', state.guide); renderGuide(); window.scrollTo(0, 0); };
}
$$('#ctrlChips button').forEach((b) => (b.onclick = () => { state.guide.ctrl = b.dataset.c; LS.set('wp.guide', state.guide); renderGuide(); }));

// ================= 튜토리얼(코치마크) =================
const COACH = [
  { sel: '#hint', title: '실시간 안내', text: '지금 무엇을 하면 되는지 여기에 계속 표시됩니다. 색이 초록이면 등록해도 좋은 상태예요.' },
  { sel: '#gpsCard', title: 'GPS 정확도', text: '초록(±5m 이내)일 때 등록하세요. 노랑은 보통, 빨강은 부정확합니다. 건물·나무 아래, 차 안에서는 낮아집니다.' },
  { sel: '#heightCard', title: '높이 입력', text: '이 지점에서 드론이 날 높이(m)입니다. 기준은 “이륙 지점”! 언덕 위처럼 지면이 높은 곳이면 그만큼 더해 주세요.' },
  { sel: '#actionCard', title: '동작과 짐벌', text: '도착했을 때 사진 촬영, 녹화 시작/종료, 대기 등을 정하고 카메라 각도(짐벌)를 맞춥니다. 나중에 목록에서 바꿀 수 있어요.' },
  { sel: '.register-wrap', title: '등록 버튼', text: '지점에 도착해 누르면 등록됩니다. “정밀 등록”은 5초 동안 제자리에서 평균을 내 더 정확해요. 실수하면 “마지막 지점 취소”.' },
  { sel: '.tabbar', title: '다음 단계', text: '목록: 지도에서 확인·수정 / 내보내기: DJI Fly용 KMZ 만들기 / 가이드: 조종기에 넣는 방법을 단계별로 안내합니다.' },
];
let coachI = 0;
function showCoach(i) {
  coachI = i;
  const step = COACH[i];
  if (!step) return endCoach();
  switchTabSilently('register');
  const el = $(step.sel);
  if (getComputedStyle(el).position !== 'fixed') {
    const top = el.getBoundingClientRect().top + window.scrollY - $('.topbar').offsetHeight - 12;
    window.scrollTo(0, Math.max(0, top - 40));
  }
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect(), pad = 6;
    const hole = $('#coachHole');
    Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    $('#coachStep').textContent = `${i + 1} / ${COACH.length}`;
    $('#coachTitle').textContent = step.title;
    $('#coachText').textContent = step.text;
    $('#coachNext').textContent = i === COACH.length - 1 ? '시작하기' : '다음';
    const box = $('#coachBox');
    $('#coach').classList.remove('hidden');
    const bh = box.offsetHeight, vh = window.innerHeight;
    box.style.top = (r.bottom + 16 + bh < vh ? r.bottom + 16 : Math.max(12, r.top - bh - 16)) + 'px';
  });
}
function switchTabSilently(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
}
function endCoach() { $('#coach').classList.add('hidden'); LS.set('wp.tutorialDone', true); window.scrollTo(0, 0); }
$('#coachNext').onclick = () => showCoach(coachI + 1);
$('#coachSkip').onclick = endCoach;
$('#helpBtn').onclick = () => showCoach(0);
window.addEventListener('resize', () => { if (!$('#coach').classList.contains('hidden')) showCoach(coachI); });

// ================= 화면 켜짐 유지 =================
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 무시 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

// ================= 렌더 =================
function loadMissionUI() {
  const m = M(), s = m.settings;
  $('#missionName').textContent = m.name;
  heightInput.value = s.nextHeight ?? s.defaultHeight;
  $$('#heightChips button').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === Number(heightInput.value)));
  $('#gimbalInput').value = s.nextGimbal ?? s.defaultGimbal;
  $('#gimbalVal').textContent = $('#gimbalInput').value + '°';
  $('#hoverInput').value = s.hoverSec;
  setAction(s.nextAction || 'none');
  renderAll();
}
function renderAll() {
  const m = M();
  $('#missionName').textContent = m.name;
  $('#undoBtn').disabled = !m.points.length;
  $('#takeoffBtn').textContent = m.takeoff ? '🛫 이륙 지점 다시 기록' : '🛫 이륙 지점 기록';
  const c = $('#countBadge'); c.textContent = m.points.length; c.classList.toggle('hidden', !m.points.length);
  renderGps();
  if ($('#tab-list').classList.contains('active')) renderList();
  if ($('#tab-export').classList.contains('active')) renderExport();
  if ($('#tab-guide').classList.contains('active')) renderGuide();
}

// ================= 시작 =================
(async function init() {
  loadMissionUI();
  await loadSavedTemplate();
  startGps();
  keepAwake();
  const tab = LS.get('wp.tab', 'register');
  switchTab(['register', 'list', 'export', 'guide'].includes(tab) ? tab : 'register');
  if (!LS.get('wp.tutorialDone', false)) setTimeout(() => showCoach(0), 600);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
