'use strict';

// 喫煙所マップ
// DriveGuideApp の公衆トイレ表示と同じ方式: 全国データ（OSM＋自治体公式）を JSON で同梱し、
// Service Worker で端末に保持、端末内で近い順に探して Leaflet に表示する。通信は地図タイルだけ。

const KANTO_CENTER = [35.6, 139.45]; // 東京・神奈川・西関東
const KANTO_ZOOM = 10;
const LOCATED_ZOOM = 15;
const LIST_MAX = 30; // 一覧に出す件数（トイレ表示と同じ）
const LOCAL_SEARCH_DEG = 0.45; // 一覧の探索範囲（約50km、トイレ表示と同じ）
const PIN_MAX = 800; // 画面内に一度に置くピンの上限
const KIND_LABEL = ['種別不明', '紙巻き可', '加熱式のみ'];
const INDOOR_LABEL = ['屋内か屋外か不明', '屋内', '屋外'];
const DAY_JA = '月火水木金土日';

const el = {
  gate: document.getElementById('ageGate'),
  gateOk: document.getElementById('gateOk'),
  status: document.getElementById('status'),
  geoStatus: document.getElementById('geoStatus'),
  nearest: document.getElementById('nearest'),
  filterNote: document.getElementById('filterNote'),
  locate: document.getElementById('locate'),
  empty: document.getElementById('empty'),
  card: document.getElementById('card'),
  cardName: document.getElementById('cardName'),
  cardBody: document.getElementById('cardBody'),
  mapsLink: document.getElementById('mapsLink'),
  listTitle: document.getElementById('listTitle'),
  items: document.getElementById('items'),
};

const state = {
  data: null,
  filters: { paper: false, heated: false, indoor: false },
  pos: null,
  selected: null,
  located: false,
  heading: null,
};

const map = L.map('map', { zoomControl: true }).setView(KANTO_CENTER, KANTO_ZOOM);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

const markers = new Map(); // 地点番号 -> marker
const pinIcons = {};
let userMarker = null;

// ---------- 年齢注意（起動のたびに表示） ----------
el.gateOk.addEventListener('click', () => {
  el.gate.hidden = true;
});
el.gateOk.focus();

// ---------- データ ----------
const dataReady = fetch('./data/smoking-jp.json', { signal: AbortSignal.timeout(8000) })
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data || !Array.isArray(data.points)) throw new Error('bad data');
    state.data = data;
    render();
    return data;
  })
  .catch(() => {
    setStatus('データを読み込めませんでした。通信できる場所で一度開き直してください。');
    return null;
  });

function pointAt(i) {
  const p = state.data.points[i];
  return {
    id: i,
    lat: p[0] / 1e5,
    lon: p[1] / 1e5,
    name: p[2] || '喫煙所（名称の登録なし）',
    kind: p[3],
    indoor: p[4],
    src: p[5],
    hours: p[6] >= 0 ? state.data.hours[p[6]] : null,
    desc: p[7],
    asof: p[8],
  };
}

function passes(p) {
  const f = state.filters;
  // 種別が分からない地点は消さない（「種別不明」と明示して残す）
  if (f.paper || f.heated) {
    const kind = p[3];
    if (kind === 1 && !f.paper) return false;
    if (kind === 2 && !f.heated) return false;
  }
  if (f.indoor && p[4] === 2) return false; // はっきり屋外の地点だけ外す
  return true;
}

// ---------- 「今使える」（時間データがある地点だけ） ----------
function openState(hours, now = new Date()) {
  if (!hours || !hours.r) return null;
  const day = (now.getDay() + 6) % 7; // 月=0
  const prev = (day + 6) % 7;
  const min = now.getHours() * 60 + now.getMinutes();
  let open = false;
  for (const [mask, from, to] of hours.r) {
    if ((mask >> day) & 1 && min >= from && min < to) open = true;
    if ((mask >> prev) & 1 && to > 1440 && min + 1440 < to) open = true; // 前日からの深夜営業
  }
  return open;
}

function openNote(hours) {
  const notes = [];
  if (hours.ph) notes.push('祝日は休み');
  if (hours.n) notes.push(hours.n);
  return notes.length ? `（${notes.join('／')}）` : '';
}

// ---------- 描画 ----------
function svgCigarette() {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="2" y="13" width="4" height="4" fill="#f0a24a"/>' +
    '<rect x="6" y="13" width="12" height="4" fill="#fff"/>' +
    '<rect x="18" y="13" width="2" height="4" fill="#f05a32"/>' +
    '<path d="M19 11c-1.6-1.2 1.6-2.4 0-3.8s1.6-2.4 0-3.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>'
  );
}

function pinIcon(kind, open) {
  const key = `${kind}_${open ? 1 : 0}`;
  if (!pinIcons[key]) {
    pinIcons[key] = L.divIcon({
      className: `smk-pin smk-k${kind}${open ? ' smk-open' : ''}`,
      html: svgCigarette(),
      iconSize: [30, 30],
      popupAnchor: [0, -15],
    });
  }
  return pinIcons[key];
}

function badge(text, cls) {
  const span = document.createElement('span');
  span.className = `badge ${cls}`;
  span.textContent = text;
  return span;
}

function sourceNames(item) {
  return item.src.map((i) => state.data.sources[i]).filter(Boolean);
}

// ポップアップとカードで共通の中身
function detailNodes(item, { compact }) {
  const wrap = document.createElement('div');
  wrap.className = compact ? 'popup' : 'info';
  const add = (label, value) => {
    const p = document.createElement('p');
    if (label) {
      const b = document.createElement('b');
      b.textContent = `${label}: `;
      p.appendChild(b);
    }
    if (value instanceof Node) p.appendChild(value);
    else p.append(String(value));
    wrap.appendChild(p);
    return p;
  };
  if (compact) {
    const t = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = item.name;
    t.appendChild(strong);
    wrap.appendChild(t);
  }
  const kindLine = document.createElement('span');
  kindLine.append(badge(KIND_LABEL[item.kind], `k${item.kind}`), ` ${INDOOR_LABEL[item.indoor]}`);
  add('種別', kindLine);
  if (item.hours) {
    const line = document.createElement('span');
    const open = openState(item.hours);
    if (open !== null) line.append(badge(open ? '今使える' : '時間外', open ? 'open' : 'closed'));
    line.append(item.hours.t + (open !== null ? openNote(item.hours) : '（時間の判定はしていません）'));
    add('時間', line);
  }
  if (item.desc && !compact) add('説明', item.desc);
  const srcs = sourceNames(item);
  add('出典', srcs.map((s) => `${s.name}（${s.license}）`).join(' ＋ '));
  add('データ時点', item.asof || '不明');
  const caution = document.createElement('p');
  caution.className = 'caution';
  caution.textContent = '情報が古い場合があります。現地の表示・ルールに従ってください。';
  wrap.appendChild(caution);
  if (compact) {
    // 経路案内: DriveGuideApp のトイレ表示と同じ飛ばし方（mapsUrl を href にした target="_blank" のリンク）
    const go = document.createElement('a');
    go.className = 'popup-go';
    go.href = mapsUrl(item);
    go.target = '_blank';
    go.rel = 'noopener';
    go.textContent = 'ここへ行く（Googleマップで案内）';
    wrap.appendChild(go);
  }
  return wrap;
}

// DriveGuideApp（public/app.js の mapsUrl）と同一
function mapsUrl(item) {
  return (
    'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
    encodeURIComponent(`${item.lat},${item.lon}`)
  );
}

function referencePoint() {
  if (state.pos && map.getBounds().contains([state.pos.lat, state.pos.lon])) return state.pos;
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

function render() {
  if (!state.data) return;
  const pts = state.data.points;
  const b = map.getBounds().pad(0.1);
  const s = b.getSouth() * 1e5, n = b.getNorth() * 1e5, w = b.getWest() * 1e5, e = b.getEast() * 1e5;
  const c = map.getCenter();
  const inView = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p[0] < s || p[0] > n || p[1] < w || p[1] > e || !passes(p)) continue;
    inView.push(i);
  }
  if (inView.length > PIN_MAX) {
    const d = (i) => (pts[i][0] / 1e5 - c.lat) ** 2 + (pts[i][1] / 1e5 - c.lng) ** 2;
    inView.sort((a, b2) => d(a) - d(b2));
    inView.length = PIN_MAX;
  }
  renderMarkers(inView);
  // 画面内に1件も無ければ正直に知らせる（無い地点は作らない）
  const strictInView = inView.some((i) => map.getBounds().contains([pts[i][0] / 1e5, pts[i][1] / 1e5]));
  el.empty.hidden = strictInView;
  renderList();
  updateStatus(inView.length);
  updateNearestButton();
}

function renderMarkers(ids) {
  const want = new Set(ids);
  for (const [id, marker] of markers) {
    if (want.has(id) && marker.__openKey === openKeyOf(id)) continue;
    marker.remove();
    markers.delete(id);
  }
  for (const id of ids) {
    if (markers.has(id)) continue;
    const item = pointAt(id);
    const open = openState(item.hours) === true;
    const marker = L.marker([item.lat, item.lon], { icon: pinIcon(item.kind, open), keyboard: true, title: item.name });
    marker.__openKey = openKeyOf(id);
    marker.bindPopup(() => detailNodes(pointAt(id), { compact: true }), { maxWidth: 280 });
    marker.on('click', () => select(id, false));
    marker.addTo(map);
    markers.set(id, marker);
  }
}

function openKeyOf(id) {
  const p = state.data.points[id];
  return p[6] >= 0 ? String(openState(state.data.hours[p[6]])) : 'x';
}

function haversine(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

// トイレ表示と同じ探し方: ±0.45度の矩形で絞り、近い順に30件
function nearest(pos) {
  const cosLat = Math.cos((pos.lat * Math.PI) / 180);
  const near = [];
  const pts = state.data.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const dLat = p[0] / 1e5 - pos.lat;
    if (dLat > LOCAL_SEARCH_DEG || dLat < -LOCAL_SEARCH_DEG) continue;
    const dLon = (p[1] / 1e5 - pos.lon) * cosLat;
    if (dLon > LOCAL_SEARCH_DEG || dLon < -LOCAL_SEARCH_DEG) continue;
    if (!passes(p)) continue;
    near.push({ score: dLat * dLat + dLon * dLon, i });
  }
  near.sort((a, b) => a.score - b.score);
  return near.slice(0, LIST_MAX).map(({ i }) => i);
}

function renderList() {
  const ref = referencePoint();
  const isUser = ref === state.pos;
  el.listTitle.textContent = isUser ? '現在地から近い喫煙所' : '地図の中心から近い喫煙所';
  const ids = nearest(ref);
  const rows = document.createDocumentFragment();
  if (!ids.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'この付近に登録地点がありません（データが少ない地域です）';
    rows.appendChild(li);
  }
  for (const id of ids) {
    const item = pointAt(id);
    const li = document.createElement('li');
    if (id === state.selected) li.classList.add('selected');
    const button = document.createElement('button');
    button.type = 'button';
    const open = openState(item.hours);
    button.append(badge(KIND_LABEL[item.kind], `k${item.kind}`));
    if (open !== null) button.append(badge(open ? '今使える' : '時間外', open ? 'open' : 'closed'));
    const title = document.createElement('span');
    title.textContent = item.name;
    const dist = document.createElement('span');
    dist.className = 'dist';
    dist.textContent = ` (${formatDistance(haversine(ref, item))})`;
    button.append(title, dist);
    button.addEventListener('click', () => select(id, true));
    li.appendChild(button);
    rows.appendChild(li);
  }
  el.items.replaceChildren(rows);
}

function select(id, fly) {
  state.selected = id;
  const item = pointAt(id);
  el.card.hidden = false;
  el.cardName.textContent = item.name;
  el.cardBody.replaceChildren(detailNodes(item, { compact: false }));
  el.mapsLink.href =
    'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + encodeURIComponent(`${item.lat},${item.lon}`);
  if (fly) {
    map.setView([item.lat, item.lon], Math.max(map.getZoom(), 17));
    const open = () => markers.get(id) && markers.get(id).openPopup();
    map.once('moveend', () => setTimeout(open, 0));
    open();
  }
  el.items.querySelectorAll('li').forEach((li) => li.classList.remove('selected'));
}

function updateStatus(count) {
  const d = state.data;
  const where = state.pos ? '' : '（現在地なし：地図を動かして探せます）';
  setStatus(`表示中 ${count}件／全国 ${d.points.length}件を内蔵（データ作成 ${d.built}）${where}`);
}

function setStatus(text) {
  el.status.textContent = text;
}

function updateFilterNote() {
  const f = state.filters;
  const notes = [];
  if (f.paper || f.heated) notes.push('種別が分からない地点も「種別不明」として表示しています。');
  if (f.indoor) notes.push('屋内か屋外か不明な地点も表示しています（はっきり屋外の地点だけ外しています）。');
  el.filterNote.hidden = !notes.length;
  el.filterNote.textContent = notes.join(' ');
}

document.querySelectorAll('.chip').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.filter;
    state.filters[key] = !state.filters[key];
    button.setAttribute('aria-pressed', String(state.filters[key]));
    updateFilterNote();
    render();
  });
});

map.on('moveend', render);
setInterval(render, 60000); // 「今使える」を1分ごとに更新

// ---------- 現在地 ----------
// DriveGuideApp の startGeolocation / onPosition と同じ手順:
//   読み込み直後に開始 → 概略位置（getCurrentPosition, 高精度なし, 5秒）→ GPS（watchPosition, 高精度）。
//   位置が届くたびに map.setView(現在地, Math.max(今のズーム, 15)) で現在地へ寄せる。
//   取れないときは、状態表示に通常の文字色で案内を出す（http の LAN はブラウザ制限の案内）。
const geoLog = []; // 取得の成否（アプリの不具合か、ブラウザ制限かを切り分けるため）

function logGeo(event, detail = {}) {
  const entry = { t: new Date().toISOString(), event, secure: window.isSecureContext, ...detail };
  geoLog.push(entry);
  console.info('[喫煙所マップ] 位置情報', entry);
}

function setGeoStatus(text) {
  el.geoStatus.hidden = !text;
  el.geoStatus.textContent = text;
}

// 取れなかった理由を、落ち着いた言葉で伝える。http の LAN アドレスはブラウザ側の制限であることを明示する
function geoFailureText(error) {
  if (!window.isSecureContext) {
    return `このアドレス（${location.origin}）では、ブラウザの安全上の制限により位置情報が使えないため、現在地は表示していません。アプリの不具合ではありません。https で公開した後は、そのまま使えます。今すぐ使う場合は、Chrome で chrome://flags を開き、「Insecure origins treated as secure」にこのアドレスを登録してください。それまでは、地図を動かして探せます。`;
  }
  if (error && error.code === 1) return '位置情報の利用が許可されていないため、現在地は表示していません。ブラウザや端末の設定で許可すると使えます。それまでは、地図を動かして探せます。';
  if (error && error.code === 3) return '現在地の測位に時間がかかっています。少し待ってから、もう一度「現在地」を押してください。';
  return '今は現在地を測位できませんでした。電波の届く場所で、もう一度「現在地」を押してください。';
}

// 「最寄り」を押した直後だけ、追従（位置が届くたびに現在地へ寄せる動き）を一時停止する。
// 最寄りの地点とポップアップ（「ここへ行く」）を押せるように残すため。時間がたてば次の測位から追従に戻る。
const NEAREST_FOLLOW_PAUSE_MS = 10000;
let followPausedUntil = 0;
function followPaused() {
  return Date.now() < followPausedUntil;
}

function centerOn(pos) {
  map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), LOCATED_ZOOM));
}

function onPosition(position, source) {
  const pos = { lat: position.coords.latitude, lon: position.coords.longitude };
  const first = state.pos == null;
  const { heading, speed } = position.coords; // 走行中の進行方向（最寄りの「前方」判定用。DriveGuideApp と同じ）
  state.heading = speed >= AHEAD_SPEED_MS && Number.isFinite(heading) ? heading : null;
  state.pos = pos;
  if (first) logGeo('ok', { source, accuracy: Math.round(position.coords.accuracy) });
  if (!userMarker) userMarker = L.marker([pos.lat, pos.lon], { title: '現在地' }).addTo(map);
  else userMarker.setLatLng([pos.lat, pos.lon]);
  if (!followPaused()) centerOn(pos); // DriveGuideApp と同じく、位置が届くたびに現在地へ寄せる（「最寄り」直後の一時停止中は除く）
  if (first) setGeoStatus('');
  render();
}

function onGeoError(error, source) {
  logGeo('error', { source, code: error && error.code, message: error && error.message });
  if (state.pos) return; // 一度取れていれば、前の現在地のまま使う
  setGeoStatus(geoFailureText(error));
}

let watching = false;
function startGeolocation() {
  if (!('geolocation' in navigator)) {
    logGeo('unsupported');
    setGeoStatus('この端末・ブラウザは位置情報に対応していないため、現在地は表示していません。地図を動かして探せます。');
    return;
  }
  if (watching) return;
  watching = true;
  logGeo('start');
  // GPS の測位を待たず、まず端末が持っている概略位置で寄せる（DriveGuideApp と同じ）
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (state.pos == null) onPosition(position, 'coarse');
    },
    (error) => logGeo('coarse-error', { code: error.code, message: error.message }),
    { enableHighAccuracy: false, maximumAge: 600000, timeout: 5000 },
  );
  navigator.geolocation.watchPosition(
    (position) => onPosition(position, 'gps'),
    (error) => {
      watching = false;
      onGeoError(error, 'gps');
    },
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}

// 「現在地」ボタン: 押したら測位し直して現在地へ寄せる。失敗したら必ず表示する（何も起きない状態にしない）
el.locate.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    startGeolocation();
    return;
  }
  followPausedUntil = 0; // 「最寄り」直後の一時停止中でも、押したらすぐ現在地へ戻す
  if (state.pos) centerOn(state.pos); // 前回の現在地へすぐ寄せ、測位できたら置き換える
  setGeoStatus('現在地を取得しています…');
  logGeo('button');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.located = true;
      onPosition(position, 'button');
      centerOn(state.pos);
      setGeoStatus('');
      logGeo('button-ok', { accuracy: Math.round(position.coords.accuracy) });
    },
    (error) => {
      logGeo('button-error', { code: error.code, message: error.message });
      setGeoStatus(geoFailureText(error));
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
  );
  startGeolocation(); // 追跡が止まっていれば再開する
});

// ---------- 「最寄り」ボタン ----------
// DriveGuideApp の nearestToilet() / updateToiletButton() と同じ選び方: 現在地から近い順の先頭。
// 走行中（秒速3m以上で進行方向あり）は、5km以内・左右75度以内の「前方」を優先する。ラベルに距離を出すのも同じ。
// 違い（指示による）: 押すと Google マップへ飛ばず、地図をその地点へ動かしてポップアップを開く（案内ボタンをそのまま押せる）。
// 探す対象は、チップで絞り込んだ後の地点（一覧と同じ nearest()、約50km以内）。
const AHEAD_SPEED_MS = 3;
const AHEAD_ANGLE_DEG = 75;
const AHEAD_MAX_M = 5000;

function bearing(from, to) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function nearestSpot(pos) {
  if (!state.data || !pos) return null;
  const items = nearest(pos).map((id) => ({ ...pointAt(id), distance: haversine(pos, pointAt(id)) }));
  if (!items.length) return null;
  if (state.heading != null) {
    const ahead = items.find((item) => {
      if (item.distance > AHEAD_MAX_M) return false;
      const diff = Math.abs(bearing(pos, item) - state.heading) % 360;
      return Math.min(diff, 360 - diff) <= AHEAD_ANGLE_DEG;
    });
    if (ahead) return { item: ahead, ahead: true };
  }
  return { item: items[0], ahead: false };
}

function updateNearestButton() {
  const target = state.pos ? nearestSpot(state.pos) : null;
  el.nearest.textContent = target
    ? `最寄り（${target.ahead ? '前方 ' : ''}${formatDistance(target.item.distance)}）`
    : '最寄り';
}

function goNearest(pos, note) {
  const target = nearestSpot(pos);
  if (!target) {
    logGeo('nearest-none');
    setGeoStatus('現在地から約50km以内に、条件に合う登録地点がありません（データが少ない地域です）。');
    return;
  }
  setGeoStatus(note || '');
  logGeo('nearest-ok', { id: target.item.id, distance: Math.round(target.item.distance), ahead: target.ahead });
  select(target.item.id, true); // 地点へ移動してポップアップを開く（一覧から選んだときと同じ）
  followPausedUntil = Date.now() + NEAREST_FOLLOW_PAUSE_MS; // この間は測位が届いても現在地へ戻さない
  logGeo('follow-paused', { ms: NEAREST_FOLLOW_PAUSE_MS });
}

el.nearest.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    logGeo('unsupported');
    setGeoStatus('この端末・ブラウザは位置情報に対応していないため、現在地は表示していません。地図を動かして探せます。');
    return;
  }
  setGeoStatus('現在地を取得して、最寄りの喫煙所を探しています…');
  logGeo('nearest');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.located = true; // 最寄りへ移動するので、現在地への寄せは行わない
      onPosition(position, 'nearest');
      goNearest(state.pos);
    },
    (error) => {
      logGeo('nearest-error', { code: error.code, message: error.message });
      if (state.pos) {
        goNearest(state.pos, `${geoFailureText(error)} 前回の現在地から探しました。`);
        return;
      }
      setGeoStatus(geoFailureText(error));
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
  );
  startGeolocation(); // 追跡が止まっていれば再開する
});

startGeolocation(); // 起動時に現在地の取得を試みる（DriveGuideApp と同じく読み込み直後）

// ---------- オフライン用 ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

window.__smk = { dataReady, state, map, geoLog, startGeolocation, followPaused }; // 動作確認用
