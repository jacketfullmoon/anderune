/* Quest — real-world location LARP. Multiplayer via backend.js (Firebase). */

// ---------- boot screen ----------
const SPLASH_LINES = ['waking up the wildlife…', 'burying treasure…', 'teaching bears to hold a grudge…',
  'polishing swords…', 'scattering coins around town…', 'checking who else is out there…', 'unrolling the map…'];
(function splash() {
  const line = document.getElementById('splash-line');
  let i = 0;
  line.textContent = SPLASH_LINES[Math.floor(Math.random() * SPLASH_LINES.length)];
  const spin = setInterval(() => { i++; line.textContent = SPLASH_LINES[(i + 3) % SPLASH_LINES.length]; }, 1400);
  window.hideSplash = () => {
    clearInterval(spin);
    const el = document.getElementById('splash');
    if (el && !el.classList.contains('gone')) { el.classList.add('gone'); setTimeout(() => el.remove(), 600); }
  };
  setTimeout(() => window.hideSplash(), 7000);   // never trap anyone behind it
})();

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function distM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
function ago(t) { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; }
// Move a lat/lng point a given distance (metres) and bearing (degrees, 0 = east, ccw).
function offsetLL(pos, meters, bearingDeg) {
  const ang = (bearingDeg * Math.PI) / 180;
  return {
    lat: pos.lat + (Math.sin(ang) * meters) / 111320,
    lng: pos.lng + (Math.cos(ang) * meters) / (111320 * Math.cos(pos.lat * Math.PI / 180)),
  };
}

// ---------- backend + state ----------
const BUILD = 30;   // bump with each upload; shown in your profile
const B = Backend;
const COL = { names: 'qm_usernames', players: 'qm_players', req: 'qm_requests', battles: 'qm_battles', chats: 'qm_chats', quests: 'qm_quests' };
let ME = null;       // my uid
let S = null;        // my player doc
let others = {};     // uid -> other player docs
let myPos = null;
let realGps = false;
let unsubs = [];

const newPlayer = (name) => ({
  name, look: { skin: '#f1c27d', hair: 'short', hairColor: '#4a2a12', shirt: '#3b82f6', bg: '#cfe8ff', top: 'tee' },
  equipped: { hat: null, face: null, neck: null }, bag: { potion: 2 },
  coins: 120, hp: 34, lvl: 5, xp: 0, claimed: [], friends: [],
  stats: { battles: 0, wins: 0, treasures: 0, quests: 0 }, medals: [], quest: null,
  sp: 0, spFrac: 0, mineAt: 0, base: { atk: 0, def: 0, spec: 0, talk: 0 },
  photo: null, special: { name: '', emoji: '✨' },
  lat: null, lng: null, seen: Date.now(), created: Date.now(),
});
function gear(p, k) { return Object.values(p.equipped || {}).reduce((t, id) => t + ((id && ITEMS[id] && ITEMS[id][k]) || 0), 0); }
const trained = (p, k) => ((p && p.base) || {})[k] || 0;
const statsFor = (p) => ({
  atk: 5 + Math.floor(p.lvl / 2) + gear(p, 'atk') + trained(p, 'atk'),
  def: 1 + Math.floor(p.lvl / 3) + gear(p, 'def') + trained(p, 'def'),
  max: 24 + p.lvl * 2 + trained(p, 'def') * 2,
  spec: 1.6 + trained(p, 'spec') * 0.05,     // special attack multiplier
  talk: trained(p, 'talk') * 0.04,           // better odds of talking your way out
  lvl: p.lvl,
});
// XP for beating someone: bigger when they outrank you, small when you punch down.
const xpFor = (foeLvl, myLvl) => Math.max(5, Math.round((10 + foeLvl * 5) * Math.min(2, Math.max(0.35, foeLvl / Math.max(1, myLvl)))));
const xpNeeded = (lvl) => 80 + Math.max(0, lvl - 5) * 45;
const maxHp = () => 24 + S.lvl * 2;
const count = (id, p = S) => (p && p.bag && p.bag[id]) || 0;
const isFriend = (uid) => !!(S && S.friends && S.friends.includes(uid));
const isAdmin = (p) => !!(p && p.name && ADMIN_NAMES.includes(p.name.toLowerCase()));
const myAvatar = () => portrait(S);
const avatarOf = (p) => portrait(p);

// Apply locally right away, then save.
function upd(patch) { applyPatch(S, patch); onMyChange(); return B.update(COL.players, ME, patch).catch((e) => console.warn(e)); }

// ---------- map ----------
// Same vector basemap as the gas app. At night we keep the style and tint the canvas dark,
// because OpenFreeMap's own dark style drops almost all the streets and labels.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const map = new maplibregl.Map({
  container: 'map', style: MAP_STYLE,
  center: [START.lng, START.lat], zoom: 14.5, attributionControl: { compact: true },
  maxBounds: [[REGION.west, REGION.south], [REGION.east, REGION.north]],   // the game world
  minZoom: 8.5,
});
const inRegion = (p) => !!p && p.lng > REGION.west && p.lng < REGION.east && p.lat > REGION.south && p.lat < REGION.north;
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
// Small helpers so the rest of the code can keep thinking in {lat, lng}.
const LL = (p) => [p.lng, p.lat];
const panTo = (p) => map.easeTo({ center: LL(p), duration: 600 });
const jumpTo = (p, zoom) => map.jumpTo({ center: LL(p), zoom: zoom ?? map.getZoom() });
const flyTo = (p, zoom) => map.flyTo({ center: LL(p), zoom: zoom ?? map.getZoom(), duration: 1500 });
// Build a DOM marker.
function marker(html, p, opts = {}) {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.style.cursor = opts.onClick ? 'pointer' : '';
  if (opts.onClick) el.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(); });
  const m = new maplibregl.Marker({ element: el, anchor: 'center', draggable: !!opts.draggable });
  m.setLngLat(LL(p)).addTo(map);
  if (opts.onDragEnd) m.on('dragend', () => { const ll = m.getLngLat(); opts.onDragEnd({ lat: ll.lat, lng: ll.lng }); });
  return m;
}

// A player shows as their character icon (or uploaded photo) with 👣 footprints trailing behind.
function colorFor(uid) {
  let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { solid: `hsl(${h} 72% 45%)`, light: `hsl(${h} 72% 60%)` };
}
function bearing(a, b) {
  const y = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180), x = b.lat - a.lat;
  return (Math.atan2(y, x) * 180) / Math.PI;
}
// Face for a player: uploaded photo if they have one, otherwise their character.
function portrait(p) {
  if (p && p.emoji) return `<div class="emoji-sprite">${p.emoji}</div>`;
  if (p && p.monster) return monsterSVG(p.monster);
  return p && p.photo ? `<img class="pic" src="${p.photo}" alt="">` : avatarSVG((p && p.look) || {}, (p && p.equipped) || {});
}
function trailLayer(uid, p, opts) {
  const col = opts.me ? { solid: '#2f6fff', light: '#5b8dff' } : colorFor(uid);
  const markers = [];
  const pts = (p.trail || []).slice(-8);
  const path = pts.concat([{ lat: p.lat, lng: p.lng }]);
  for (let i = 0; i < pts.length; i++) {
    const op = (0.22 + 0.6 * (i / Math.max(1, pts.length - 1))).toFixed(2);
    const rot = bearing(path[i], path[i + 1]).toFixed(0);
    markers.push(marker(`<div class="foot" style="opacity:${op};transform:rotate(${rot}deg)">👣</div>`, pts[i]));
  }
  markers.push(marker(
    `<div class="mk ${opts.me ? 'mk-me' : ''} ${opts.friend ? 'mk-friend' : ''}" style="--c:${col.solid};--cl:${col.light}">
      <div class="mk-avatar">${portrait(p)}</div><div class="mk-label">${esc(p.name)}</div></div>`,
    p, { onClick: opts.onClick, draggable: opts.draggable, onDragEnd: opts.onDragEnd }));
  return { markers, head: markers[markers.length - 1], remove() { markers.forEach((m) => m.remove()); } };
}

// ---------- map theme ----------
// Same OpenStreetMap data, repainted. "Tidy" warms the map and hides the sidewalk
// clutter so players, chests and monsters are the loudest things on screen.
const MAP_PREFS = (() => {
  try { return { style: 'tidy', ...JSON.parse(localStorage.getItem('qm_map') || '{}') }; } catch { return { style: 'tidy' }; }
})();
const saveMapPrefs = () => { try { localStorage.setItem('qm_map', JSON.stringify(MAP_PREFS)); } catch {} };
const TIDY = {
  day: { bg:'#f8f0df', land:'#f8f0df', res:'#f4ead6', park:'#8fe0ab', parkLine:'#4fb97a', water:'#86d8f2',
    waterLine:'#4fb8dd', hospital:'#ffc9d4', school:'#ffe4a8', sand:'#ffeec2', bldg:'#ece2d2', bldgLine:'#cdbfa8',
    motor:'#ffa552', trunk:'#ffc98a', second:'#ffe0b0', minor:'#ffffff', minorCase:'#e3d8c4',
    rail:'#c9bdd8', text:'#3d3350', halo:'#ffffff', waterText:'#2d7d99', parkText:'#2f7a4d', boundary:'#d98aa8' },
  night: { bg:'#151233', land:'#151233', res:'#1a1640', park:'#1e5a43', parkLine:'#2f9a6c', water:'#123a63',
    waterLine:'#2f7fb0', hospital:'#5a2740', school:'#57451f', sand:'#3b3324', bldg:'#221d4c', bldgLine:'#3f3673',
    motor:'#e8834a', trunk:'#b9763f', second:'#6a5a44', minor:'#4a4480', minorCase:'#2a2558',
    rail:'#6d5f9e', text:'#efe9ff', halo:'#0d0a24', waterText:'#8fd8ff', parkText:'#7fe0a8', boundary:'#a8557a' },
};
const MAP_HIDE = /path|pedestrian|footway|cycle|sidewalk|steps|crossing|track/;
let styleBackup = null;
function backupStyle() {
  if (styleBackup) return;
  styleBackup = {};
  map.getStyle().layers.forEach((l) => { styleBackup[l.id] = JSON.parse(JSON.stringify(l.paint || {})); });
}
function applyMapTheme() {
  if (!map.isStyleLoaded()) return;
  backupStyle();
  const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (e) {} };
  const show = (id, on) => { try { map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); } catch (e) {} };
  document.body.classList.toggle('classic-map', MAP_PREFS.style !== 'tidy');
  if (MAP_PREFS.style !== 'tidy') {                       // put the original colours back
    map.getStyle().layers.forEach((l) => {
      show(l.id, true);
      const p = styleBackup[l.id] || {};
      Object.keys(p).forEach((k) => set(l.id, k, p[k]));
      if (l.type === 'raster') set(l.id, 'raster-opacity', 1);
    });
    return;
  }
  const P = TIDY[isNight ? 'night' : 'day'];
  map.getStyle().layers.forEach((l) => {
    const id = l.id, t = l.type;
    if (MAP_HIDE.test(id) && t !== 'fill') return show(id, false);   // sidewalks and footpaths
    show(id, true);
    if (t === 'background') return set(id, 'background-color', P.bg);
    if (t === 'raster') return set(id, 'raster-opacity', 0);
    if (t === 'fill-extrusion') { set(id, 'fill-extrusion-color', P.bldg); return set(id, 'fill-extrusion-opacity', .85); }
    if (t === 'fill') {
      if (/water|ocean/.test(id)) return set(id, 'fill-color', P.water);
      if (/building/.test(id)) { set(id, 'fill-color', P.bldg); return set(id, 'fill-outline-color', P.bldgLine); }
      if (/park|wood|grass|forest|pitch|golf|cemetery/.test(id)) return set(id, 'fill-color', P.park);
      if (/hospital/.test(id)) return set(id, 'fill-color', P.hospital);
      if (/school|university|college/.test(id)) return set(id, 'fill-color', P.school);
      if (/sand|beach/.test(id)) return set(id, 'fill-color', P.sand);
      if (/residential/.test(id)) return set(id, 'fill-color', P.res);
      return set(id, 'fill-color', P.land);
    }
    if (t === 'line') {
      if (/boundary|admin/.test(id)) { set(id, 'line-color', P.boundary); return set(id, 'line-opacity', .7); }
      if (/waterway|river|stream|canal/.test(id)) return set(id, 'line-color', P.waterLine);
      if (/park_outline/.test(id)) return set(id, 'line-color', P.parkLine);
      if (/rail/.test(id)) return set(id, 'line-color', P.rail);
      if (/casing|outline/.test(id)) return set(id, 'line-color', P.minorCase);
      if (/motorway/.test(id)) return set(id, 'line-color', P.motor);
      if (/trunk|primary/.test(id)) return set(id, 'line-color', P.trunk);
      if (/secondary|tertiary/.test(id)) return set(id, 'line-color', P.second);
      return set(id, 'line-color', P.minor);
    }
    if (t === 'symbol') {
      if (/water|marine|ocean/.test(id)) { set(id, 'text-color', P.waterText); return set(id, 'text-halo-color', P.halo); }
      if (/park/.test(id)) { set(id, 'text-color', P.parkText); return set(id, 'text-halo-color', P.halo); }
      set(id, 'text-color', P.text); set(id, 'text-halo-color', P.halo); set(id, 'text-halo-width', 1.8);
    }
  });
}
map.on('load', applyMapTheme);
map.on('styledata', () => { if (map.isStyleLoaded()) applyMapTheme(); });

// Dark map after 7pm, back to daylight at 6am.
// The sun climbs the arc through the day and the moon takes over at night —
// so you can see at a glance how long you have before it flips.
const DAY_START = 6, NIGHT_START = 19;
function updateSkyArc() {
  const arc = $('#sky-arc'), body = $('#sky-body');
  if (!arc || arc.classList.contains('hidden')) return;
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
  const night = h >= NIGHT_START || h < DAY_START;
  const t = night
    ? ((h >= NIGHT_START ? h - NIGHT_START : h + 24 - NIGHT_START) / (24 - NIGHT_START + DAY_START))
    : (h - DAY_START) / (NIGHT_START - DAY_START);
  const f = Math.max(0, Math.min(1, t));
  // walk the same shallow arc the SVG draws: circle centred below the bar
  const cx = 80, r = 110, cy = 50 + Math.sqrt(r * r - 70 * 70);
  const a0 = Math.atan2(50 - cy, 10 - cx), a1 = Math.atan2(50 - cy, 150 - cx);
  const ang = a0 + f * (a1 - a0);
  const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
  body.textContent = night ? '🌙' : '☀️';
  body.style.left = (x / 160) * 100 + '%';
  body.style.top = (y / 54) * 100 + '%';
  arc.title = night ? 'Sunrise at 6am' : 'Nightfall at 7pm';
}
setInterval(updateSkyArc, 30000);

let isNight = null;
function updateNight() {
  const h = new Date().getHours(), night = h >= 19 || h < 6;
  if (night === isNight) return;
  isNight = night;
  document.body.classList.toggle('night', night);
  applyMapTheme();
  updateSkyArc();
}
updateNight();
setInterval(updateNight, 60000);

let meLayer = null, meKey = '';
function renderMe() {
  if (!S || !myPos) return;
  const p = { ...S, lat: myPos.lat, lng: myPos.lng, trail: myTrail };
  const key = JSON.stringify([myPos, myTrail.length, S.name, S.look, S.equipped, S.photo, realGps]);
  if (meLayer && key === meKey) return;
  meKey = key;
  if (meLayer) meLayer.remove();
  meLayer = trailLayer(ME, p, { me: true, draggable: !realGps, onClick: openProfile,
    onDragEnd: (q) => setPos(q, false) });
}

let lastPush = { t: 0, p: null };
let myTrail = [];
function pushPos(force) {
  if (!ME || !myPos) return;
  const moved = !lastPush.p || distM(lastPush.p, myPos) > 15;
  if (!force && !moved && Date.now() - lastPush.t < 60000) return;
  if (!force && Date.now() - lastPush.t < 5000) return;
  lastPush = { t: Date.now(), p: myPos };
  const tail = myTrail[myTrail.length - 1];
  if (!tail || distM(tail, myPos) > 20) {
    myTrail = [...myTrail, { lat: myPos.lat, lng: myPos.lng, t: Date.now() }].slice(-8);
  }
  B.update(COL.players, ME, { lat: myPos.lat, lng: myPos.lng, seen: Date.now(), trail: myTrail }).catch(() => {});
}
setInterval(() => pushPos(false), 20000);

function setPos(p, pan = true) {
  myPos = { lat: p.lat, lng: p.lng };
  if (restStops.length) { renderStops(); fetchStops(false); }
  pushPos(false);
  renderMe();
  if (pan) panTo(p);
  checkProximity();
}

// treasures & shops
const treasureMarkers = {};
const chestHtml = (t) => `<div class="mk-poi chest ${S && (S.claimed || []).includes(t.id) ? 'claimed' : ''}">${CHEST_SVG}</div>`;
TREASURES.forEach((t) => { treasureMarkers[t.id] = marker(chestHtml(t), t, { onClick: () => openTreasure(t) }); });
let claimedKey = '';
function renderChests() {
  const k = (S.claimed || []).join();
  if (k === claimedKey) return; claimedKey = k;
  TREASURES.forEach((t) => { treasureMarkers[t.id].getElement().innerHTML = chestHtml(t); });
}
SHOPS.forEach((s) => marker(`<div class="mk-poi">${s.ico}</div>`, s, { onClick: () => openShop(s) }));

// other players
const playerMarkers = {};
function renderOthers() {
  const now = Date.now();
  for (const [uid, p] of Object.entries(others)) {
    const show = p.lat != null && now - (p.seen || 0) < ONLINE_WINDOW_MS;
    const m = playerMarkers[uid];
    if (!show) { if (m) { m.layer.remove(); delete playerMarkers[uid]; } continue; }
    const key = JSON.stringify([p.lat, p.lng, p.trail, p.name, p.look, p.equipped, p.photo, isFriend(uid)]);
    if (m && m.key === key) continue;
    if (m) m.layer.remove();
    const layer = trailLayer(uid, p, { friend: isFriend(uid), onClick: () => openPlayer(uid) });
    playerMarkers[uid] = { layer, key };
  }
  for (const uid of Object.keys(playerMarkers)) if (!others[uid]) { playerMarkers[uid].layer.remove(); delete playerMarkers[uid]; }
}
setInterval(() => ME && renderOthers(), 30000);

// ---------- GPS ----------
const locStatus = $('#loc-status');
let watchId = null;
function setStatus(txt) { locStatus.textContent = txt; locStatus.classList.toggle('hidden', !txt); }
function startGps(fromTap, silent) {
  if (!navigator.geolocation || !window.isSecureContext) { setStatus('📍 Location unavailable — drag yourself to move'); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  setStatus('Finding you…');
  watchId = navigator.geolocation.watchPosition((p) => {
    const first = !realGps;
    realGps = true; setStatus('');
    if (!inRegion({ lat: p.coords.latitude, lng: p.coords.longitude })) {
      setStatus('📍 Outside the game area');
      if (first) toast(`🗺️ You're outside ${REGION.name}, which is all Anderune covers so far. The map will stay in LA.`, null, 9000);
      return;
    }
    setPos({ lat: p.coords.latitude, lng: p.coords.longitude }, first);
    if (first) jumpTo({ lat: p.coords.latitude, lng: p.coords.longitude }, 16);
    if (sheetKind === 'lochelp') { closeSheet(); toast('📍 Location is on — you\'re on the map for real now.', null, 5000); }
  }, (e) => {
    if (realGps && e.code !== e.PERMISSION_DENIED) return;
    navigator.geolocation.clearWatch(watchId); watchId = null;
    realGps = false; renderMe();
    setStatus('📍 Location off — drag yourself to move');
    if (e.code === e.PERMISSION_DENIED) {
      if (silent) { if (sheetKind === 'lochelp') toast('Still blocked — check step 2 and 3.', null, 3500); return; }
      if (fromTap) showLocationHelp();
      else toast('📍 Location is blocked, so others can\'t see where you really are.', [['How to fix', 'primary', showLocationHelp], ['Later', '', null]]);
    } else if (fromTap) toast(e.code === e.TIMEOUT ? 'Location timed out. Try again outside.' : "Couldn't find your location.");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
$('#locate-btn').onclick = () => { if (realGps && myPos) map.easeTo({ center: LL(myPos), zoom: 16 }); else startGps(true); };
function showLocationHelp() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  openSheet(`
    <h2>📍 Location is blocked</h2>
    <p>Your ${ios ? 'iPhone' : 'browser'} is blocking this site from using your location. Turn it on, then come straight back — it switches on by itself when you return.</p>
    ${ios ? `<ol style="padding-left:20px;line-height:1.6;font-size:14px;margin:0 0 12px">
      <li><b>Settings → Privacy &amp; Security → Location Services</b>: make sure it's <b>On</b>.</li>
      <li>On that same screen, scroll to <b>Safari Websites</b> (or <b>Chrome</b>) → <b>While Using the App</b>, and turn on <b>Precise Location</b>.</li>
      <li>In Safari, tap the <b>page menu</b> icon next to the address bar → <b>Website Settings</b> → <b>Location</b> → <b>Allow</b>.</li>
      </ol>
      <p class="sub">Apple doesn't let a website open Settings for you — you have to tap it yourself. But leave this open: the moment you come back, Anderune checks again.</p>`
    : `<p>Click the icon next to the address bar, set <b>Location</b> to <b>Allow</b>.</p>`}
    <div class="btns"><button class="btn primary" id="retry">📍 Try again</button><button class="btn" id="reload">Reload page</button></div>
    <div class="btns"><button class="btn" id="stay">Keep playing without it</button></div>
  `, 'lochelp');
  $('#retry').onclick = () => { setStatus('Finding you…'); startGps(true); };
  $('#reload').onclick = () => location.reload();
  $('#stay').onclick = closeSheet;
}
// Coming back from the Settings app: check again without making them tap anything.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !ME || realGps) return;
  if (sheetKind === 'lochelp') setTimeout(() => startGps(false, true), 400);
});

// ---------- HUD ----------
function renderHud() {
  $('#btn-profile').innerHTML = myAvatar();
  $('#hud-coins').textContent = S.coins;
  const pct = Math.max(0, Math.min(100, S.hp / maxHp() * 100));
  $('#hud-hp').style.width = pct + '%';
  $('#hud-hp').style.background = pct < 25 ? '#ef4444' : pct < 50 ? '#f5b82e' : '';
}
function safely(fn) {
  return () => { try { fn(); } catch (e) { console.error(e); toast(`Something broke: ${esc(e.message)} (build ${BUILD})`, null, 8000); } };
}
$('#btn-profile').onclick = safely(openProfile);
$('#btn-bag').onclick = safely(openBag);
$('#btn-friends').onclick = safely(openFriends);
$('#btn-search').onclick = safely(() => openSearch(''));
$('#btn-stats').onclick = safely(openStats);
$('#btn-quests').onclick = safely(openQuests);
$('#btn-settings').onclick = safely(openSettings);
$('#sky-arc').onclick = () => {
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
  const night = h >= NIGHT_START || h < DAY_START;
  const until = night ? (h >= NIGHT_START ? 24 - h + DAY_START : DAY_START - h) : NIGHT_START - h;
  const hrs = Math.floor(until), mins = Math.round((until - hrs) * 60);
  toast(night ? `🌙 Night. Sunrise in ${hrs}h ${mins}m.` : `☀️ Daytime. Nightfall in ${hrs}h ${mins}m.`, null, 4000);
};
setInterval(() => { if (S && !inBattle && S.hp < maxHp()) upd({ hp: B.inc(1) }); }, 30000);

// ---------- toasts ----------
function toast(html, buttons, ttl = 4500) {
  const el = document.createElement('div');
  el.className = 'toast'; el.innerHTML = html;
  if (buttons) {
    const b = document.createElement('div'); b.className = 'btns';
    buttons.forEach(([label, cls, fn]) => {
      const btn = document.createElement('button'); btn.className = 'btn ' + cls; btn.textContent = label;
      btn.onclick = () => { el.remove(); fn && fn(); }; b.appendChild(btn);
    });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  if (ttl) setTimeout(() => el.remove(), buttons ? ttl * 2 : ttl);
  return el;
}

// ---------- sheet ----------
const sheet = $('#sheet'), sheetBody = $('#sheet-body'), backdrop = $('#sheet-backdrop');
let sheetKind = null, sheetRefresh = null, sheetCleanup = null;
function openSheet(html, kind, refresh) {
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
  const same = !sheet.classList.contains('hidden') && sheetBody.dataset.kind === kind, y = sheet.scrollTop;
  sheetKind = kind; sheetRefresh = refresh || null;
  sheetBody.dataset.kind = kind; sheetBody.innerHTML = html;
  sheet.classList.remove('hidden'); backdrop.classList.remove('hidden');
  if (!same) SFX.play('sheet');
  sheet.scrollTop = same ? y : 0;
}
function closeSheet() {
  sheet.classList.add('hidden'); backdrop.classList.add('hidden');
  sheetKind = null; sheetRefresh = null; sheetBody.dataset.kind = '';
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
}
backdrop.onclick = closeSheet;

// Pull the sheet down by its top edge to dismiss it.
(function dragToClose() {
  let start = null;
  const grabbable = (t) => t.closest('.sheet-grip') || t.closest('.sheet-grab') || (t === sheet || t === sheetBody);
  sheet.addEventListener('pointerdown', (e) => {
    if (sheet.scrollTop > 2 || !grabbable(e.target)) return;
    start = { y: e.clientY, t: Date.now() };
    sheet.classList.add('dragging');
    sheet.setPointerCapture(e.pointerId);
  });
  sheet.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dy = Math.max(0, e.clientY - start.y);
    sheet.style.transform = `translateY(${dy}px)`;
    sheet.style.opacity = String(Math.max(0.35, 1 - dy / 500));
  });
  const end = (e) => {
    if (!start) return;
    const dy = Math.max(0, (e.clientY || 0) - start.y), speed = dy / Math.max(1, Date.now() - start.t);
    start = null;
    sheet.classList.remove('dragging');
    sheet.style.transform = ''; sheet.style.opacity = '';
    if (dy > 110 || speed > 0.6) {
      sheet.classList.add('closing');
      setTimeout(() => { sheet.classList.remove('closing'); closeSheet(); }, 200);
    }
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
})();

// ---------- auth (same flow as the gas app) ----------
function validateUsername(name) {
  if (name.length < 3) return 'Too short — at least 3 characters';
  if (name.length > 20) return 'Too long — max 20 characters';
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return 'Only letters, numbers, and underscores';
  return null;
}
let justCreated = false;
(function setupAuth() {
  const modal = $('#auth-modal'), usernameIn = $('#username-input'), passwordIn = $('#password-input'), hintIn = $('#hint-input');
  const hint = $('#username-hint'), btn = $('#auth-submit'), disclaimer = $('#password-disclaimer');
  const tabCreate = $('#tab-create'), tabLogin = $('#tab-login'), forgotBtn = $('#forgot-btn'), hintReveal = $('#hint-reveal');
  let mode = 'create';
  const fail = (msg) => { hint.textContent = msg; hint.classList.add('error'); };
  function setMode(m) {
    mode = m;
    tabCreate.classList.toggle('active', m === 'create'); tabLogin.classList.toggle('active', m === 'login');
    $('#auth-title').textContent = m === 'create' ? 'Create your character' : 'Welcome back';
    btn.textContent = m === 'create' ? 'Create Account' : 'Log In';
    disclaimer.hidden = m !== 'create';
    hintIn.style.display = m === 'create' ? '' : 'none';
    forgotBtn.style.display = m === 'login' ? 'block' : 'none';
    hintReveal.classList.remove('visible'); hintReveal.textContent = '';
    hint.classList.remove('error');
    hint.textContent = m === 'create' ? '3–20 characters, letters/numbers/underscores only' : '';
    passwordIn.autocomplete = m === 'create' ? 'new-password' : 'current-password';
  }
  tabCreate.onclick = () => setMode('create');
  tabLogin.onclick = () => setMode('login');
  setMode('create');

  forgotBtn.onclick = async () => {
    const val = usernameIn.value.trim();
    if (!val) return fail('Enter your character name first');
    forgotBtn.textContent = 'Looking up…'; forgotBtn.disabled = true;
    try {
      const d = await B.get(COL.names, val.toLowerCase());
      hintReveal.textContent = !d ? 'No account found with that name.' : d.password_hint ? 'Your hint: ' + d.password_hint : 'No hint was saved for this account.';
    } catch { hintReveal.textContent = 'Could not look up your hint — try again.'; }
    hintReveal.classList.add('visible');
    forgotBtn.textContent = 'Forgot password? Show my hint'; forgotBtn.disabled = false;
  };

  async function attemptCreate() {
    const val = usernameIn.value.trim(), pass = passwordIn.value;
    const err = validateUsername(val); if (err) return fail(err);
    if (pass.length < 6) return fail('Password must be at least 6 characters');
    btn.disabled = true; btn.textContent = 'Creating…'; hint.classList.remove('error'); hint.textContent = '';
    try {
      const key = val.toLowerCase();
      if (await B.get(COL.names, key)) return fail('That name is taken — try another');
      justCreated = true;
      const uid = await B.signUp(val, pass);
      const h = hintIn.value.trim();
      await B.set(COL.names, key, { uid, name: val, created: Date.now(), ...(h ? { password_hint: h } : {}) });
      await B.set(COL.players, uid, newPlayer(val));
    } catch (e) {
      justCreated = false;
      fail(e.code === 'auth/email-already-in-use' ? 'That name is taken — try another' : e.message || 'Something went wrong — try again');
    } finally { btn.disabled = false; btn.textContent = mode === 'create' ? 'Create Account' : 'Log In'; }
  }
  async function attemptLogin() {
    const val = usernameIn.value.trim(), pass = passwordIn.value;
    if (!val) return fail('Enter your character name');
    if (!pass) return fail('Enter your password');
    btn.disabled = true; btn.textContent = 'Logging in…'; hint.classList.remove('error'); hint.textContent = '';
    try { await B.logIn(val, pass); }
    catch (e) {
      fail(['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(e.code)
        ? 'Name or password is incorrect' : e.message || 'Login failed');
    } finally { btn.disabled = false; btn.textContent = mode === 'create' ? 'Create Account' : 'Log In'; }
  }
  btn.onclick = () => (mode === 'create' ? attemptCreate() : attemptLogin());
  usernameIn.onkeydown = (e) => { if (e.key === 'Enter') passwordIn.focus(); };
  passwordIn.onkeydown = (e) => { if (e.key === 'Enter') { if (mode === 'create') hintIn.focus(); else attemptLogin(); } };
  hintIn.onkeydown = (e) => { if (e.key === 'Enter') attemptCreate(); };

  if (B.mode === 'unconfigured') { window.hideSplash && window.hideSplash(); modal.classList.add('hidden'); $('#setup-modal').classList.remove('hidden'); return; }
  B.onAuth((uid) => {
    setTimeout(() => window.hideSplash && window.hideSplash(), 350);
    if (uid) { modal.classList.add('hidden'); startSession(uid); }
    else { endSession(); modal.classList.remove('hidden'); }
  });
})();

// ---------- session ----------
let firstLoad = true;
function startSession(uid) {
  if (ME === uid) return;
  endSession();
  ME = uid; firstLoad = true;
  unsubs.push(B.watchDoc(COL.players, uid, (d) => {
    if (!d) return; // still being created
    S = d;
    if (firstLoad) {
      firstLoad = false;
      ['#side-btns', '#stat-pill', '#locate-btn', '#btn-settings', '#sky-arc'].forEach((s) => $(s).classList.remove('hidden'));
      updateSkyArc();
      myPos = S.lat != null ? { lat: S.lat, lng: S.lng } : { lat: START.lat, lng: START.lng };
      myTrail = Array.isArray(S.trail) ? S.trail : [];
      renderMe(); jumpTo(myPos, 16);
      pushPos(true);
      if (!inRegion(myPos)) {
        toast(`🗺️ Anderune only covers ${REGION.name} right now — there's nothing out here yet.`, null, 9000);
        myPos = { lat: START.lat, lng: START.lng };      // park the camera back in town
      }
      keepWilds();
      if (loadStopCache()) renderStops();
      fetchStops(false);
      startGps(false);
      if (justCreated) { justCreated = false; openProfile(); toast(`👋 Welcome, ${esc(S.name)}! Style your character, then go explore.`, null, 7000); }
    }
    onMyChange();
  }));
  unsubs.push(B.watchAll(COL.players, (list) => {
    others = {}; list.forEach((p) => { if (p.id !== ME) others[p.id] = p; });
    renderOthers();
    if ((sheetKind === 'friends' || sheetKind === 'player') && sheetRefresh) sheetRefresh();
  }));
  unsubs.push(B.watchWhere(COL.req, 'to', uid, onIncoming));
  unsubs.push(B.watchAll(COL.quests, (list) => {
    dbQuests = {}; list.forEach((q) => { if (!q.deleted) dbQuests[q.id] = q; });
    if (sheetKind === 'quests' && sheetRefresh) sheetRefresh();
  }));
}
function endSession() {
  unsubs.forEach((u) => u && u()); unsubs = [];
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; ME = null; S = null; others = {}; realGps = false; incoming = [];
  Object.values(playerMarkers).forEach((m) => m.layer.remove());
  for (const k in playerMarkers) delete playerMarkers[k];
  if (meLayer) { meLayer.remove(); meLayer = null; meKey = ''; }
  myTrail = [];
  ['#side-btns', '#stat-pill', '#locate-btn', '#btn-settings', '#sky-arc'].forEach((s) => $(s).classList.add('hidden'));
  Object.values(reqToasts).forEach((el) => el.remove());
  setStatus(''); closeSheet();
}
let leveling = false;
function onMyChange() {
  if (!S) return;
  // Level ups: each one grants 2 stat points, plus a point or two on its own.
  if (S.xp >= xpNeeded(S.lvl) && !leveling) {
    leveling = true;
    let lv = S.lvl, xp = S.xp, sp = S.sp || 0, levels = 0, gAtk = 0, gDef = 0;
    while (xp >= xpNeeded(lv) && levels < 20) {
      xp -= xpNeeded(lv); lv++; levels++; sp += 2;
      gAtk += randi(0, 1); gDef += randi(0, 1);
    }
    SFX.play('level');
    toast(`⭐ Level up! You're now Lv${lv}. +${levels * 2} stat points to spend` +
      (gAtk || gDef ? ` (and +${gAtk} ATK, +${gDef} DEF on your own).` : '.'), null, 7000);
    upd({ xp, lvl: lv, sp, hp: 24 + lv * 2 + (trained(S, 'def') + gDef) * 2,
      'base.atk': trained(S, 'atk') + gAtk, 'base.def': trained(S, 'def') + gDef });
    leveling = false;
  }
  for (const [slot, id] of Object.entries(S.equipped || {})) if (id && count(id) <= 0) upd({ ['equipped.' + slot]: null });
  renderHud(); renderMe(); renderChests(); renderQuestMarker();
  if (['bag', 'shop', 'treasure'].includes(sheetKind) && sheetRefresh) sheetRefresh();
}

// ---------- treasure ----------
function openTreasure(t) {
  if (!S) return;
  const d = distM(myPos, t), inRange = d <= CLAIM_RADIUS_M, claimed = (S.claimed || []).includes(t.id), it = ITEMS[t.item];
  openSheet(`
    <div class="row"><div style="font-size:42px">${claimed ? '📭' : '🧰'}</div>
      <div><h2>${esc(t.name)}</h2>
      <span class="pill ${inRange ? 'ok' : 'far'}">${inRange ? 'You are here!' : fmtDist(d) + ' away'}</span>
      <span class="pill">${claimed ? 'Opened' : it.rarity + ' chest'}</span></div></div>
    <p>${claimed ? `You already found the <b>${it.ico} ${esc(it.name)}</b> here.` : esc(t.hint)}</p>
    ${claimed ? '' : `<p class="sub">Reward: ${it.rarity} item + ${t.coins} coins. Get within ${CLAIM_RADIUS_M} m to open it.</p>`}
    <div class="btns">
      ${claimed ? '' : `<button class="btn primary" id="claim" ${inRange ? '' : 'disabled'}>Open chest</button>`}
      <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}&travelmode=walking">Directions</a>
    </div>
  `, 'treasure', () => openTreasure(t));
  const c = $('#claim'); if (c) c.onclick = () => claimTreasure(t);
}
function claimTreasure(t) {
  if ((S.claimed || []).includes(t.id) || distM(myPos, t) > CLAIM_RADIUS_M) return;
  const it = ITEMS[t.item];
  SFX.play('coin');
  closeSheet();
  upd({ claimed: B.union(t.id), ['bag.' + t.item]: B.inc(1), coins: B.inc(t.coins), xp: B.inc(40), 'stats.treasures': B.inc(1) });
  openSheet(`
    <div style="text-align:center">
      <div style="font-size:64px;margin:8px 0">${it.ico}</div>
      <h2>You found ${esc(it.name)}!</h2>
      <p>${esc(it.desc)}<br><b>+${t.coins} coins</b> · ${statLine(it)}</p>
      <div class="btns"><button class="btn primary" id="eq">Wear it now</button><button class="btn" id="later">Put in bag</button></div>
    </div>`, 'reward');
  $('#eq').onclick = () => { upd({ ['equipped.' + it.slot]: t.item }); openProfile(); };
  $('#later').onclick = closeSheet;
}
function statLine(it) {
  const s = [];
  if (it.atk) s.push(`+${it.atk} ATK`); if (it.def) s.push(`+${it.def} DEF`); if (it.heal) s.push(`+${it.heal} HP`);
  return s.join(' · ') || it.rarity;
}
const nudged = new Set();
function checkProximity() {
  if (!S || sheetKind || inBattle) return;
  checkQuestStep();
  checkWilds();
  checkRest();
  TREASURES.forEach((t) => {
    if (!(S.claimed || []).includes(t.id) && distM(myPos, t) <= CLAIM_RADIUS_M && !nudged.has(t.id)) {
      nudged.add(t.id);
      toast(`🧰 You're at <b>${esc(t.name)}</b>! A chest is here.`, [['Open it', 'primary', () => openTreasure(t)], ['Later', '', null]]);
    }
  });
}

// ---------- shop ----------
const SHOP_RADIUS_M = 80;
function openShop(s) {
  if (!S) return;
  const d = distM(myPos, s), here = d <= SHOP_RADIUS_M;
  openSheet(`
    <div class="row"><div style="font-size:42px">${s.ico}</div><div><h2>${esc(s.name)}</h2>
      <span class="pill ${here ? 'ok' : 'far'}">${here ? 'Open — you are here' : fmtDist(d) + ' away'}</span></div></div>
    <p>${esc(s.blurb)}</p>
    <div class="list">${s.stock.map((id) => { const it = ITEMS[id]; return `
      <div class="item"><div class="ico">${it.ico}</div><div class="grow"><b>${esc(it.name)}</b><span class="sub">${esc(it.desc)} ${statLine(it)}</span></div>
      <button class="btn gold" data-buy="${id}" ${here && S.coins >= it.price ? '' : 'disabled'}>🪙 ${it.price}</button></div>`; }).join('')}
    </div>
    ${here ? '' : '<p class="sub" style="margin-top:12px">Visit in person to buy.</p>'}
  `, 'shop', () => openShop(s));
  sheetBody.querySelectorAll('[data-buy]').forEach((b) => (b.onclick = () => {
    const it = ITEMS[b.dataset.buy];
    if (S.coins < it.price) return;
    upd({ coins: B.inc(-it.price), ['bag.' + b.dataset.buy]: B.inc(1) });
    toast(`Bought ${it.ico} ${esc(it.name)}`, null, 2000);
  }));
}

// ---------- bag ----------
function openBag() {
  const ids = Object.keys(S.bag || {}).filter((id) => count(id) > 0 && ITEMS[id]);
  openSheet(`
    <h2>🎒🍗 Bag &amp; items</h2>
    <p class="sub">Treasures found: ${(S.claimed || []).length}/${TREASURES.length} · Tap to wear or use.</p>
    ${ids.length ? `<div class="grid">${ids.map((id) => { const it = ITEMS[id]; const on = Object.values(S.equipped || {}).includes(id); return `
      <button class="slot ${on ? 'equipped' : ''}" data-id="${id}"><span class="ico">${it.ico}</span>${esc(it.name)}<small>${it.slot === 'use' ? '×' + count(id) : statLine(it)}</small></button>`; }).join('')}</div>`
      : '<div class="empty">Empty. Find chests or visit a shop.</div>'}
  `, 'bag', openBag);
  sheetBody.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => useOrEquip(b.dataset.id)));
}
function useOrEquip(id) {
  const it = ITEMS[id];
  if (it.slot !== 'use') return upd({ ['equipped.' + it.slot]: S.equipped[it.slot] === id ? null : id });
  if (id === 'map') {
    const left = TREASURES.filter((t) => !(S.claimed || []).includes(t.id));
    if (!left.length) return toast('No hidden treasures left!');
    const t = left.sort((a, b) => distM(myPos, a) - distM(myPos, b))[0];
    upd({ ['bag.' + id]: B.inc(-1) });
    toast(`🗺️ Nearest chest: <b>${esc(t.name)}</b> (${fmtDist(distM(myPos, t))}). ${esc(t.hint)}`, null, 8000);
    flyTo(t, 15); closeSheet(); return;
  }
  if (S.hp >= maxHp()) return toast('HP is already full.');
  upd({ hp: Math.min(maxHp(), S.hp + it.heal), ['bag.' + id]: B.inc(-1) });
  toast(`${it.ico} +${it.heal} HP`, null, 2000);
}

// ---------- profile / character creator ----------
// Pick a photo, then let them frame it before it becomes their icon.
function pickPhoto() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => cropPhoto(img);
      img.onerror = () => toast("Couldn't read that image.");
      img.src = reader.result;
    };
    reader.onerror = () => toast("Couldn't read that file.");
    reader.readAsDataURL(file);
  };
  input.click();
}

// Drag to move, pinch or slide to zoom; the circle shows what you'll get.
function cropPhoto(img) {
  openSheet(`
    <h2>📸 Frame your icon</h2>
    <p class="sub">Drag the photo to move it, and use the slider to zoom. The circle is what other players see.</p>
    <div id="cropbox"><div id="cropimg"></div><div id="cropmask"></div></div>
    <label class="field">Zoom</label>
    <input id="cropzoom" class="range" type="range" min="100" max="350" value="100">
    <div class="btns"><button class="btn primary" id="crop-ok">Use this photo</button><button class="btn" id="crop-cancel">Cancel</button></div>
  `, 'crop');
  const box = $('#cropbox'), holder = $('#cropimg'), zoom = $('#cropzoom');
  holder.appendChild(img);
  const C = box.clientWidth || 280;
  box.style.height = C + 'px';
  const base = Math.max(C / img.naturalWidth, C / img.naturalHeight);
  let z = 1, tx = 0, ty = 0;
  const draw = () => {
    const s = base * z, w = img.naturalWidth * s, h = img.naturalHeight * s;
    const maxX = Math.max(0, (w - C) / 2), maxY = Math.max(0, (h - C) / 2);
    tx = Math.max(-maxX, Math.min(maxX, tx)); ty = Math.max(-maxY, Math.min(maxY, ty));
    img.style.width = w + 'px'; img.style.height = h + 'px';
    img.style.left = (C / 2 - w / 2 + tx) + 'px'; img.style.top = (C / 2 - h / 2 + ty) + 'px';
  };
  draw();
  let drag = null;
  box.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, tx, ty }; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', (e) => { if (!drag) return; tx = drag.tx + (e.clientX - drag.x); ty = drag.ty + (e.clientY - drag.y); draw(); });
  ['pointerup', 'pointercancel'].forEach((ev) => box.addEventListener(ev, () => (drag = null)));
  zoom.oninput = () => { z = +zoom.value / 100; draw(); };
  $('#crop-cancel').onclick = openProfile;
  $('#crop-ok').onclick = () => {
    const out = 160, c = document.createElement('canvas');
    c.width = c.height = out;
    const s = base * z;
    // Map the visible square back onto the original photo.
    const sx = (img.naturalWidth * s / 2 - C / 2 - tx) / s, sy = (img.naturalHeight * s / 2 - C / 2 - ty) / s;
    c.getContext('2d').drawImage(img, sx, sy, C / s, C / s, 0, 0, out, out);
    let data = c.toDataURL('image/jpeg', 0.8);
    if (data.length > 220000) data = c.toDataURL('image/jpeg', 0.6);
    upd({ photo: data });
    toast('📸 Photo set as your icon', null, 2500);
    openProfile();
  };
}

function openProfile() {
  if (!S) return;
  const opt = (key, vals, swatch) => vals.map((v) => swatch
    ? `<button class="swatch ${S.look[key] === v ? 'sel' : ''}" style="background:${v}" data-k="${key}" data-v="${v}" aria-label="${v}"></button>`
    : `<button class="opt ${S.look[key] === v ? 'sel' : ''}" data-k="${key}" data-v="${v}">${
        key === 'hair' && HAIR_STYLES[v] ? HAIR_STYLES[v].label : key === 'top' && TOP_STYLES[v] ? TOP_STYLES[v].label : v}</button>`).join('');
  const gearOpts = ['hat', 'face', 'neck'].map((slot) => {
    const owned = Object.keys(S.bag || {}).filter((id) => ITEMS[id] && ITEMS[id].slot === slot && count(id) > 0);
    return `<button class="opt ${!S.equipped[slot] ? 'sel' : ''}" data-slot="${slot}" data-item="">No ${slot}</button>` +
      owned.map((id) => `<button class="opt ${S.equipped[slot] === id ? 'sel' : ''}" data-slot="${slot}" data-item="${id}">${ITEMS[id].ico} ${esc(ITEMS[id].name)}</button>`).join('');
  }).join('');
  const st = statsFor(S);
  openSheet(`
    <div class="row">
      <div class="big-avatar" id="av">${S.photo ? myAvatar() : `
        <div class="av-layer av-back">${avatarSVG(S.look, S.equipped, { hair: 'back' })}</div>
        <div class="av-layer av-head">${avatarSVG(S.look, S.equipped, { hair: 'none' })}</div>
        <div class="av-layer av-front">${avatarSVG(S.look, S.equipped, { hair: 'front' })}</div>`}</div>
      <div><h2>${esc(S.name)}</h2>
        <div class="sub">Lv${S.lvl} · XP ${S.xp}/${xpNeeded(S.lvl)}</div>
        <div class="xpbar"><div style="width:${Math.min(100, (S.xp / xpNeeded(S.lvl)) * 100)}%"></div></div>
        <div class="sub">HP ${S.hp}/${st.max} · ATK ${st.atk} · DEF ${st.def}</div>
        <div class="sub">🪙 ${S.coins} · 🤝 ${(S.friends || []).length} friends</div>
        ${isAdmin(S) ? '<div style="margin-top:4px"><span class="pill">⭐ Anderune master</span></div>' : ''}
        <div class="sub" style="font-size:11px;opacity:.7">build ${BUILD}</div></div>
    </div>
    ${(S.sp || 0) > 0 ? `<div class="sp-box">
      <b>🎯 ${S.sp} stat point${S.sp > 1 ? 's' : ''} to spend</b>
      <div class="sub">Put them wherever you like — they're yours for good.</div>
      <div class="sp-grid">
        <button class="btn" data-sp-add="atk">⚔️ Attack <small>+1</small></button>
        <button class="btn" data-sp-add="def">🛡️ Defense <small>+1</small></button>
        <button class="btn" data-sp-add="spec">✨ Special <small>+1</small></button>
        <button class="btn" data-sp-add="talk">💬 Negotiate <small>+1</small></button>
      </div></div>` : ''}
    <h3>📊 Stats</h3>
    <div class="statline"><span>⚔️ Attack</span><b>${st.atk}</b><span class="sub">${trained(S, 'atk')} trained</span></div>
    <div class="statline"><span>🛡️ Defense</span><b>${st.def}</b><span class="sub">${trained(S, 'def')} trained</span></div>
    <div class="statline"><span>✨ Special power</span><b>×${st.spec.toFixed(2)}</b><span class="sub">${trained(S, 'spec')} trained</span></div>
    <div class="statline"><span>💬 Negotiate</span><b>+${Math.round(st.talk * 100)}%</b><span class="sub">${trained(S, 'talk')} trained</span></div>
    <label class="field">Icon</label>
    <div class="photo-row">
      <button class="btn" id="photo-btn">📸 ${S.photo ? 'Change photo' : 'Use a photo'}</button>
      ${S.photo ? '<button class="btn" id="photo-clear">Use my character</button>' : ''}
    </div>
    <p class="sub" style="margin-top:8px">${S.photo ? 'Your photo is your map icon and battle portrait. Everyone playing can see it.' : 'Or build a character below.'}</p>
    <label class="field">Skin</label><div class="opts">${opt('skin', AVATAR_OPTIONS.skin, true)}</div>
    <label class="field">Hair</label><div class="opts">${opt('hair', AVATAR_OPTIONS.hair)}</div>
    <label class="field">Hair color</label><div class="opts">${opt('hairColor', AVATAR_OPTIONS.hairColor, true)}</div>
    <label class="field">Top</label><div class="opts">${opt('top', AVATAR_OPTIONS.top)}</div>
    <label class="field">Top color</label><div class="opts">${opt('shirt', AVATAR_OPTIONS.shirt, true)}</div>
    <label class="field">Icon background</label><div class="opts">${opt('bg', AVATAR_OPTIONS.bg, true)}</div>
    <label class="field">Gear (from treasures &amp; shops)</label><div class="opts">${gearOpts}</div>
    <h3>✨ Your special attack</h3>
    <p class="sub">Once per battle you can unleash this. Give it a name and a symbol.</p>
    <input class="text" id="sp-name" maxlength="24" placeholder="e.g. Zack Attack" value="${esc((S.special || {}).name || '')}">
    <div class="opts" style="margin-top:10px">${SPECIAL_EMOJI.map((e) => `
      <button class="opt sp-emoji ${(S.special || {}).emoji === e ? 'sel' : ''}" data-sp="${e}" style="font-size:20px;padding:6px 10px">${e}</button>`).join('')}</div>
    ${isAdmin(S) ? `<h3>🧪 Test battles</h3>
      <p class="sub">Practice runs, master. No coins, no XP, no record — just to see how a fight feels.</p>
      <div class="btns"><button class="btn blue" id="test-player">🧑 Fight a test player</button>
        <button class="btn" id="test-monster">🐻 Fight a test monster</button></div>` : ''}
    ${myParty().length ? `<p class="sub" style="margin-top:12px">🧑‍🤝‍🧑 In a party with <b>${myParty().map((u) => esc(others[u].name)).join(', ')}</b> until midnight — you fight together.
      <button class="sub" id="leave-party" style="text-decoration:underline">Leave party</button></p>` : ''}
    <div class="btns"><button class="btn primary" id="done">Done</button></div>
    <div class="btns"><button class="btn" id="logout">Log out</button></div>
  `, 'profile');
  sheetBody.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.k, v = b.dataset.v;
    if (S.look[k] === v) return;
    const nextLook = { ...S.look, [k]: v };
    if (!S.photo && (k === 'hair' || k === 'hairColor')) swapHair(nextLook);
    upd({ ['look.' + k]: v });
    // Update the picker in place so the avatar animation isn't cut off by a re-render.
    sheetBody.querySelectorAll(`[data-k="${k}"]`).forEach((o) => o.classList.toggle('sel', o.dataset.v === v));
    const head = $('#av') && $('#av').querySelector('.av-head');
    if (head && k !== 'hair' && k !== 'hairColor') head.innerHTML = avatarSVG(nextLook, S.equipped, { hair: 'none' });
  }));
  sheetBody.querySelectorAll('[data-slot]').forEach((b) => (b.onclick = () => { upd({ ['equipped.' + b.dataset.slot]: b.dataset.item || null }); openProfile(); }));
  sheetBody.querySelectorAll('[data-sp-add]').forEach((b) => (b.onclick = () => {
    if ((S.sp || 0) <= 0) return;
    const k = b.dataset.spAdd;
    upd({ sp: S.sp - 1, ['base.' + k]: trained(S, k) + 1, ...(k === 'def' ? { hp: Math.min(24 + S.lvl * 2 + (trained(S, 'def') + 1) * 2, S.hp + 2) } : {}) });
    SFX.play('level');
    openProfile();
  }));
  const tp = $('#test-player'); if (tp) tp.onclick = () => startTestBattle('player');
  const tm = $('#test-monster'); if (tm) tm.onclick = () => startTestBattle('monster');
  const spName = $('#sp-name');
  if (spName) spName.oninput = (e) => upd({ 'special.name': e.target.value.trim().slice(0, 24) });
  sheetBody.querySelectorAll('[data-sp]').forEach((b) => (b.onclick = () => {
    upd({ 'special.emoji': b.dataset.sp });
    sheetBody.querySelectorAll('[data-sp]').forEach((o) => o.classList.toggle('sel', o === b));
  }));
  const lp2 = $('#leave-party'); if (lp2) lp2.onclick = () => leaveParty();
  $('#photo-btn').onclick = pickPhoto;
  const pc = $('#photo-clear'); if (pc) pc.onclick = () => { upd({ photo: null }); openProfile(); };
  $('#done').onclick = closeSheet;
  $('#logout').onclick = () => { closeSheet(); B.logOut(); };
}

// One clean motion: the old hair slides off, the new style slides in behind it.
function swapHair(look) {
  const av = $('#av'); if (!av) return;
  const oldLayers = [...av.querySelectorAll('.av-back, .av-front')];
  const mk = (cls, html) => { const d = document.createElement('div'); d.className = `av-layer ${cls} av-anim av-in`; d.innerHTML = html; return d; };
  const back = mk('av-back', avatarSVG(look, S.equipped, { hair: 'back' }));
  const front = mk('av-front', avatarSVG(look, S.equipped, { hair: 'front' }));
  av.insertBefore(back, av.firstChild); // behind the head
  av.appendChild(front);
  oldLayers.forEach((el) => el.classList.add('av-anim'));
  void av.offsetWidth; // flush styles so both layers start from their off-screen position
  requestAnimationFrame(() => {
    oldLayers.forEach((el) => el.classList.add('av-out'));
    [back, front].forEach((el) => el.classList.remove('av-in'));
  });
  setTimeout(() => { oldLayers.forEach((el) => el.remove()); [back, front].forEach((el) => el.classList.remove('av-anim')); }, 520);
}

// ---------- players & friends ----------
const online = (p) => p.lat != null && Date.now() - (p.seen || 0) < ONLINE_WINDOW_MS;
function openPlayer(uid) {
  const p = others[uid]; if (!p) return;
  const d = online(p) && myPos ? distM(myPos, p) : Infinity, near = d <= NEARBY_RADIUS_M, friend = isFriend(uid);
  const pendingFriend = incoming.find((r) => r.from === uid && r.kind === 'friend' && r.status === 'pending');
  const inMyParty = myParty().includes(uid);
  openSheet(`
    <div class="row"><div class="big-avatar" style="width:90px;height:90px">${avatarOf(p)}</div>
      <div><h2>${esc(p.name)}</h2><div class="sub">Lv${p.lvl} · ${online(p) ? fmtDist(d) + ' away' : 'last seen ' + ago(p.seen || 0)}</div>
      <div style="margin-top:6px">${isAdmin(p) ? '<span class="pill">⭐ Anderune master</span>' : ''}${inMyParty ? '<span class="pill party-pill">In your party</span>' : ''}${friend ? '<span class="pill ok">Friend</span>' : ''}<span class="pill ${near ? 'ok' : 'far'}">${near ? 'Nearby' : online(p) ? 'Too far to battle' : 'Offline'}</span></div></div></div>
    <p>${near ? 'Send a request. They choose whether to accept.' : friend ? `Friends can chat from anywhere. Get within ${NEARBY_RADIUS_M} m to battle.` : `Get within ${NEARBY_RADIUS_M} m to battle or talk.`}</p>
    <div class="btns">
      <button class="btn primary" id="rq-battle" ${near ? '' : 'disabled'}>⚔️ Battle?</button>
      <button class="btn blue" id="rq-talk" ${near || friend ? '' : 'disabled'}>💬 Talk?</button>
    </div>
    ${friend ? '' : pendingFriend ? '<div class="btns"><button class="btn" id="acc-friend">🤝 Accept friend request</button></div>'
      : '<div class="btns"><button class="btn" id="rq-friend">🤝 Add friend</button></div>'}
    ${inMyParty ? '<div class="btns"><button class="btn" id="leave-party">🧑‍🤝‍🧑 Leave party</button></div>'
      : `<div class="btns"><button class="btn" id="rq-party" ${near ? '' : 'disabled'}>🧑‍🤝‍🧑 Ask to join party</button></div>`}
  `, 'player', () => openPlayer(uid));
  $('#rq-battle').onclick = () => sendRequest(uid, 'battle');
  $('#rq-talk').onclick = () => sendRequest(uid, 'talk');
  const f = $('#rq-friend'); if (f) f.onclick = () => sendRequest(uid, 'friend');
  const a = $('#acc-friend'); if (a) a.onclick = () => { closeSheet(); acceptRequest(pendingFriend); };
  const pt = $('#rq-party'); if (pt) pt.onclick = () => sendRequest(uid, 'party');
  const lp = $('#leave-party'); if (lp) lp.onclick = () => leaveParty();
}
function openFriends() {
  const row = (p) => {
    const on = online(p), d = on && myPos ? distM(myPos, p) : null;
    return `<div class="item" data-see="${p.id}"><div class="mini">${avatarOf(p)}</div><div class="grow"><b>${esc(p.name)}</b>
      <span class="sub">Lv${p.lvl} · ${on ? '🟢 ' + fmtDist(d) : '⚪ ' + ago(p.seen || 0)}${myParty().includes(p.id) ? ' · 🧑‍🤝‍🧑 in your party' : ''}</span></div><button class="btn">View</button></div>`;
  };
  const all = Object.values(others);
  const friends = all.filter((p) => isFriend(p.id)).sort((a, b) => (b.seen || 0) - (a.seen || 0));
  const nearby = all.filter((p) => !isFriend(p.id) && online(p)).sort((a, b) => distM(myPos, a) - distM(myPos, b));
  const reqs = incoming.filter((r) => ['friend', 'party', 'quest'].includes(r.kind) && r.status === 'pending');
  openSheet(`
    ${reqs.length ? `<h2>📨 Invites</h2><div class="list">${reqs.map((r) => `
      <div class="item"><div class="mini">${others[r.from] ? avatarOf(others[r.from]) : ''}</div><div class="grow"><b>${esc(r.fromName)}</b><span class="sub">${
        r.kind === 'friend' ? 'wants to be friends' : r.kind === 'party' ? 'asked if you want to join their party'
        : 'invited you to “' + esc((questById(r.questId) || {}).title || 'a quest') + '”'}</span></div>
      <button class="btn primary" data-acc="${r.id}">${r.kind === 'party' ? 'Yes' : 'Accept'}</button><button class="btn" data-dec="${r.id}">✕</button></div>`).join('')}</div>` : ''}
    <h2>🤝 Friends</h2>
    ${friends.length ? `<div class="list">${friends.map(row).join('')}</div>` : '<div class="empty">No friends yet. Tap a player on the map and add them.</div>'}
    <h3>📡 Players online</h3>
    ${nearby.length ? `<div class="list">${nearby.map(row).join('')}</div>` : '<div class="empty">Nobody else is online right now. Send your friends the link!</div>'}
    <div class="btns"><button class="btn blue" id="share">🔗 Invite friends</button></div>
  `, 'friends', openFriends);
  sheetBody.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => { const p = others[b.dataset.see]; if (online(p)) panTo(p); openPlayer(p.id); }));
  sheetBody.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => acceptRequest(incoming.find((r) => r.id === b.dataset.acc))));
  sheetBody.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => B.update(COL.req, b.dataset.dec, { status: 'declined' })));
  $('#share').onclick = async () => {
    const msg = `Join my party in Anderune! ${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text: msg });      // the link rides inside the text
      else { try { await navigator.clipboard.writeText(msg); toast('Invite copied — paste it to a friend.', null, 3000); } catch { showInviteText(msg); } }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // they closed the share sheet
      try { await navigator.clipboard.writeText(msg); toast('Invite copied — paste it to a friend.', null, 3000); }
      catch { showInviteText(msg); }
    }
  };
}

// If sharing and copying are both blocked, show the text so it can be copied by hand.
function showInviteText(msg) {
  openSheet(`
    <h2>🔗 Invite a friend</h2>
    <p class="sub">Copy this and send it however you like.</p>
    <input class="text" id="invite-text" value="${esc(msg)}" readonly>
    <div class="btns"><button class="btn primary" id="invite-copy">Copy</button><button class="btn" id="invite-done">Done</button></div>
  `, 'invitetext');
  const field = $('#invite-text');
  field.focus(); field.setSelectionRange(0, field.value.length);
  $('#invite-copy').onclick = () => {
    field.select();
    try { document.execCommand('copy'); toast('Copied!', null, 2000); } catch { toast('Press and hold the text to copy it.'); }
  };
  $('#invite-done').onclick = openFriends;
}

// ---------- requests ----------
const KIND = { battle: ['⚔️', 'battle'], talk: ['💬', 'talk'], friend: ['🤝', 'be friends'], trade: ['🔁', 'trade'], quest: ['📜', 'join a quest'], party: ['🧑‍🤝‍🧑', 'join their party'] };
async function sendRequest(uid, kind, extra = {}) {
  const p = others[uid]; if (!p) return;
  if (kind === 'battle' && S.hp < 6) return toast('You\'re too hurt to battle. Drink something from your bag first.');
  if (!(kind === 'trade' && sheetKind === 'talk')) closeSheet();
  const id = await B.add(COL.req, { from: ME, fromName: S.name, to: uid, toName: p.name, kind, status: 'pending', created: Date.now(), ...extra });
  if (kind === 'friend') toast(`🤝 Friend request sent to ${esc(p.name)}`, null, 2500);
  const waitNote = kind === 'party' || kind === 'quest' ? ' — it waits 10 min for them' : '';
  const w = kind === 'friend' ? null : toast(`${KIND[kind][0]} Asked <b>${esc(p.name)}</b> to ${KIND[kind][1]}…${waitNote}`, [['Cancel', '', () => B.update(COL.req, id, { status: 'cancelled' })]], 0);
  const LIVE_FOR = { battle: 120000, talk: 300000, trade: 180000, party: 600000, quest: 600000 };
  const timer = kind === 'friend' ? null : setTimeout(() => B.update(COL.req, id, { status: 'expired' }).catch(() => {}), LIVE_FOR[kind] || 60000);
  let un = null, done = false;
  un = B.watchDoc(COL.req, id, (r) => {
    if (!r || r.status === 'pending' || done) return;
    done = true; setTimeout(() => un && un(), 0); clearTimeout(timer); w && w.remove();
    if (r.status === 'accepted') {
      if (kind === 'battle') openBattle(r.battleId);
      else if (kind === 'talk') openTalk(uid);
      else if (kind === 'friend') toast(`🤝 ${esc(p.name)} accepted your friend request!`);
      else if (kind === 'party') toast(`🧑‍🤝‍🧑 ${esc(p.name)} joined your party! You fight together until midnight.`);
      else if (kind === 'trade') toast(`🔁 ${esc(p.name)} accepted the trade!`);
    } else if (r.status === 'declined') toast(`${esc(p.name)} said no this time.`);
    else if (r.status === 'expired') toast(`${esc(p.name)} didn't answer.`);
  });
}

let incoming = [];
const reqToasts = {};
function onIncoming(list) {
  incoming = list;
  const pending = list.filter((r) => r.status === 'pending');
  $('#friends-dot').classList.toggle('hidden', !pending.some((r) => ['friend', 'party', 'quest'].includes(r.kind)));
  for (const [id, el] of Object.entries(reqToasts)) if (!pending.some((r) => r.id === id)) { el.remove(); delete reqToasts[id]; }
  // A party member just needs to be dropped into the same fight.
  pending.filter((r) => r.kind === 'joinbattle').forEach((r) => {
    B.update(COL.req, r.id, { status: 'accepted' });
    if (!inBattle) openBattle(r.battleId);
  });
  pending.forEach((r) => {
    if (reqToasts[r.id] || r.shown || r.kind === 'joinbattle') return;
    const age = Date.now() - r.created;
    if (!['friend', 'party', 'quest', 'talk'].includes(r.kind) && age > 120000) return;
    if (r.kind === 'talk' && age > 300000) return;
    if ((r.kind === 'party' || r.kind === 'quest') && age > 600000) return;
    if (inBattle && r.kind === 'battle') return;
    const from = esc(r.fromName);
    const msg = r.kind === 'trade'
      ? `🔁 <b>${from}</b> offers ${ITEMS[r.give].ico} ${esc(ITEMS[r.give].name)} for your ${ITEMS[r.want].ico} ${esc(ITEMS[r.want].name)}`
      : r.kind === 'friend' ? `🤝 <b>${from}</b> sent you a friend request`
      : r.kind === 'quest' ? `📜 <b>${from}</b> invited you to the quest "${esc((questById(r.questId) || {}).title || 'a quest')}"`
      : r.kind === 'party' ? `🧑‍🤝‍🧑 <b>${from}</b> asked if you want to join their party.`
      : `${KIND[r.kind][0]} <b>${from}</b> wants to ${KIND[r.kind][1]}!`;
    SFX.play('ping');
    const plain = {
      talk: `${r.fromName} wants to talk`, battle: `${r.fromName} wants to battle you`,
      party: `${r.fromName} asked you to join their party`, friend: `${r.fromName} sent a friend request`,
      trade: `${r.fromName} offered you a trade`, quest: `${r.fromName} invited you to a quest`,
    }[r.kind] || 'Someone wants you in Anderune';
    NOTIFY.show('Anderune', plain, r.id);
    const yes = r.kind === 'party' ? 'Yes' : 'Accept', no = r.kind === 'party' ? 'No' : 'Decline';
    reqToasts[r.id] = toast(msg, [[yes, 'primary', () => { delete reqToasts[r.id]; acceptRequest(r); }],
      [no, '', () => { delete reqToasts[r.id]; B.update(COL.req, r.id, { status: 'declined' }); }]], 0);
    if (r.kind === 'friend') B.update(COL.req, r.id, { shown: true }).catch(() => {}); // pop up once; it stays in the Friends list
  });
  if (sheetKind === 'friends' && sheetRefresh) sheetRefresh();
}
async function acceptRequest(r) {
  if (!r) return;
  const cur = await B.get(COL.req, r.id);
  if (!cur || cur.status !== 'pending') return toast('That request is no longer active.');
  const opp = others[r.from] || (await B.get(COL.players, r.from));
  if (!opp) return;
  if (r.kind === 'battle') {
    if (S.hp < 6) { B.update(COL.req, r.id, { status: 'declined' }); return toast('You\'re too hurt to battle — heal first.'); }
    const id = await createBattle(r.from, opp);
    await B.update(COL.req, r.id, { status: 'accepted', battleId: id });
    openBattle(id);
  } else if (r.kind === 'talk') {
    await B.update(COL.req, r.id, { status: 'accepted' });
    openTalk(r.from);
  } else if (r.kind === 'friend') {
    await B.batch([
      { col: COL.players, id: ME, patch: { friends: B.union(r.from) } },
      { col: COL.players, id: r.from, patch: { friends: B.union(ME) } },
      { col: COL.req, id: r.id, patch: { status: 'accepted' } },
    ]);
    toast(`🤝 You and ${esc(r.fromName)} are now friends!`);
  } else if (r.kind === 'party') {
    const until = endOfDay();
    await B.batch([
      { col: COL.players, id: ME, patch: { party: { with: [r.from], until } } },
      { col: COL.players, id: r.from, patch: { party: { with: [ME], until } } },
      { col: COL.req, id: r.id, patch: { status: 'accepted' } },
    ]);
    toast(`🧑‍🤝‍🧑 You joined ${esc(r.fromName)}'s party. You fight together until midnight.`, null, 6000);
  } else if (r.kind === 'quest') {
    await B.update(COL.req, r.id, { status: 'accepted' });
    const q = questById(r.questId);
    if (!q) return toast('That quest is gone.');
    startQuest(q);
  } else if (r.kind === 'trade') {
    // r.give = what they give me, r.want = what they get from me
    if (count(r.want) <= 0) { B.update(COL.req, r.id, { status: 'declined' }); return toast(`You don't have a ${esc(ITEMS[r.want].name)} anymore.`); }
    if (count(r.give, opp) <= 0) { B.update(COL.req, r.id, { status: 'declined' }); return toast(`${esc(r.fromName)} doesn't have that item anymore.`); }
    await B.batch([
      { col: COL.players, id: ME, patch: { ['bag.' + r.want]: B.inc(-1), ['bag.' + r.give]: B.inc(1) } },
      { col: COL.players, id: r.from, patch: { ['bag.' + r.give]: B.inc(-1), ['bag.' + r.want]: B.inc(1) } },
      { col: COL.req, id: r.id, patch: { status: 'accepted' } },
    ]);
    chatSay(r.from, `Trade done: ${ITEMS[r.want].ico} ${ITEMS[r.want].name} ↔ ${ITEMS[r.give].ico} ${ITEMS[r.give].name}`, true);
    toast(`🔁 Trade done! You got ${ITEMS[r.give].ico} ${esc(ITEMS[r.give].name)}.`);
  }
}

// ---------- talk / trade ----------
const pairId = (a, b) => [a, b].sort().join('_');
function chatSay(uid, text, sys = false) {
  return B.set(COL.chats, pairId(ME, uid), { users: [ME, uid].sort(), msgs: B.union({ from: sys ? 'sys' : ME, text, t: Date.now() }) }, true);
}
function openTalk(uid) {
  const p = others[uid]; if (!p) return;
  const near = online(p) && distM(myPos, p) <= NEARBY_RADIUS_M;
  openSheet(`
    <div class="row"><div class="mini" style="width:48px;height:48px;border-radius:50%;overflow:hidden;background:#cfe8ff">${avatarOf(p)}</div>
      <div><h2 style="margin:0">${esc(p.name)}</h2><span class="sub">Lv${p.lvl}${isFriend(uid) ? ' · Friend' : ''}</span></div></div>
    <div class="chat" id="chat"><div class="msg sys">Say hi 👋</div></div>
    <div class="chips">
      <button class="chip" id="c-trade">🔁 Trade</button>
      ${isFriend(uid) ? '' : '<button class="chip" id="c-friend">🤝 Add friend</button>'}
      ${near ? '<button class="chip" id="c-battle">⚔️ Battle</button>' : ''}
    </div>
    <div id="trade-box"></div>
    <div class="row" style="margin-top:10px"><input class="text" id="say" placeholder="Say something…" maxlength="300" style="margin:0"><button class="btn blue" id="send" style="flex:none;min-width:0">Send</button></div>
  `, 'talk');
  const chat = $('#chat');
  sheetCleanup = B.watchDoc(COL.chats, pairId(ME, uid), (d) => {
    const msgs = ((d && d.msgs) || []).slice().sort((a, b) => a.t - b.t).slice(-80);
    if (!msgs.length) return;
    chat.innerHTML = msgs.map((m) => `<div class="msg ${m.from === 'sys' ? 'sys' : m.from === ME ? 'me' : 'them'}">${esc(m.text)}</div>`).join('');
    chat.scrollTop = chat.scrollHeight;
  });
  const send = () => { const v = $('#say').value.trim(); if (!v) return; $('#say').value = ''; chatSay(uid, v); };
  $('#send').onclick = send;
  $('#say').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  const f = $('#c-friend'); if (f) f.onclick = () => { f.remove(); sendRequest(uid, 'friend'); };
  const bt = $('#c-battle'); if (bt) bt.onclick = () => sendRequest(uid, 'battle');
  $('#c-trade').onclick = () => {
    const pp = others[uid] || p;
    const mine = Object.keys(S.bag || {}).filter((id) => count(id) > 0 && ITEMS[id]);
    const theirs = Object.keys(pp.bag || {}).filter((id) => count(id, pp) > 0 && ITEMS[id]);
    const opts = (ids, owner) => ids.map((id) => `<option value="${id}">${ITEMS[id].ico} ${esc(ITEMS[id].name)} (×${count(id, owner)})</option>`).join('');
    $('#trade-box').innerHTML = !mine.length || !theirs.length
      ? `<p class="sub" style="margin-top:10px">${!mine.length ? 'Your bag is empty.' : `${esc(pp.name)}'s bag is empty.`}</p>`
      : `<label class="field">You give</label><select class="text" id="t-give">${opts(mine, S)}</select>
         <label class="field">You get</label><select class="text" id="t-get">${opts(theirs, pp)}</select>
         <div class="btns"><button class="btn primary" id="t-send">Propose trade</button></div>`;
    const ts = $('#t-send'); if (ts) ts.onclick = () => {
      const give = $('#t-give').value, want = $('#t-get').value;
      $('#trade-box').innerHTML = '';
      chatSay(uid, `${S.name} offered ${ITEMS[give].ico} ${ITEMS[give].name} for ${ITEMS[want].ico} ${ITEMS[want].name}`, true);
      sendRequest(uid, 'trade', { give, want });
    };
  };
}

// ---------- battle (1-on-1, or a party fighting together) ----------
let inBattle = false, battleId = null, battleUnsub = null, curB = null, shownSeq = 0, animChain = Promise.resolve(), animating = false, waitTimer = null, acting = false;
const bt = { text: $('#bt-text'), menu: $('#bt-menu') };
$('#ar-toggle').onclick = () => toggleAR();
$('#ar-compass').onclick = async () => {
  const ok = await askOrientation();
  updateCompassChip();
  if (!ok || AR.heading == null) {
    toast('Your phone is not sharing its compass. On iPhone: Settings → Safari → Motion & Orientation Access (or reinstall the home-screen app), then turn AR off and on. Until then, drag left or right to aim.', null, 10000);
  }
};
// With no compass you can still place them by hand: drag the view to swing your aim.
(function arDragAim() {
  const arena = $('#arena');
  arena.addEventListener('pointerdown', (e) => {
    if (!AR.on || AR.heading != null || e.target.closest('button')) return;
    AR.drag = { x: e.clientX, start: AR.manual };
  });
  arena.addEventListener('pointermove', (e) => {
    if (!AR.drag) return;
    const dx = e.clientX - AR.drag.x;
    AR.manual = AR.drag.start - (dx / arena.clientWidth) * AR_HFOV;
    placeFoe();
  });
  ['pointerup', 'pointercancel'].forEach((ev) => arena.addEventListener(ev, () => (AR.drag = null)));
})();
const alive = (b, u) => b.hp[u] > 0;
const teamOf = (b, u) => b.teams[u];
const foesOf = (b, u) => b.p.filter((x) => teamOf(b, x) !== teamOf(b, u) && alive(b, x));
const matesOf = (b, u) => b.p.filter((x) => x !== u && teamOf(b, x) === teamOf(b, u));
const teamAlive = (b, t) => b.p.some((u) => teamOf(b, u) === t && alive(b, u));

// Everyone in a party fights together. Party lasts until the end of the day.
const partyOf = (p) => (p && p.party && p.party.until > Date.now() ? (p.party.with || []) : []);
const myParty = () => partyOf(S).filter((u) => others[u]);
const endOfDay = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };

async function createBattle(oppId, opp) {
  // Side 1 = whoever asked for the fight (plus their party). Side 2 = me (plus mine).
  const side1 = [oppId, ...partyOf(opp).filter((u) => u !== ME && others[u] && online(others[u]))].slice(0, 2);
  const side2 = [ME, ...myParty().filter((u) => !side1.includes(u) && online(others[u]))].slice(0, 2);
  const order = [side1[0], side2[0], side1[1], side2[1]].filter(Boolean);
  const dataOf = (u) => (u === ME ? S : others[u] || opp);
  const b = {
    p: order, teams: {}, names: {}, looks: {}, st: {}, hp: {}, def: {},
    status: 'active', created: Date.now(), updated: Date.now(),
    turn: order[0], truce: null, seq: 1, fx: null, result: null, lines: [],
  };
  order.forEach((u) => {
    const d = dataOf(u), st = statsFor(d);
    b.teams[u] = side1.includes(u) ? 1 : 2;
    b.names[u] = d.name; b.st[u] = st; b.special = b.special || {}; b.special[u] = d.special || null;
    b.looks[u] = { look: d.look, equipped: d.equipped, photo: d.photo || null };
    b.hp[u] = Math.max(1, Math.min(d.hp, st.max)); b.def[u] = false;
  });
  const names = (t) => order.filter((u) => b.teams[u] === t).map((u) => b.names[u]).join(' and ');
  b.lines = [`${names(1)} vs ${names(2)}!`, `${b.names[order[0]]} goes first.`];
  const id = await B.add(COL.battles, b);
  // Party members need to know which battle to open.
  order.filter((u) => u !== ME && u !== oppId).forEach((u) =>
    B.add(COL.req, { from: ME, fromName: S.name, to: u, kind: 'joinbattle', battleId: id, status: 'pending', created: Date.now() }));
  return id;
}

function openBattle(id) {
  closeSheet();
  if (battleId && battleId !== id) exitBattle();
  inBattle = true; battleId = id; curB = null; shownSeq = 0; animChain = Promise.resolve();
  bt.text.textContent = 'Loading battle…'; bt.menu.innerHTML = '';
  $('#foes').innerHTML = ''; $('#mine').innerHTML = '';
  $('#battle').classList.remove('hidden'); document.body.classList.add('in-battle');
  battleUnsub = B.watchDoc(COL.battles, id, onBattle);
}
function exitBattle() {
  stopAR(); closeBattleChatQuiet();
  clearInterval(AR.testDrift);
  battleUnsub && battleUnsub(); battleUnsub = null; clearTimeout(waitTimer); localB = null;
  $('#battle').classList.add('hidden'); document.body.classList.remove('in-battle'); inBattle = false; battleId = null; curB = null;
}

function fighterHtml(b, u) {
  return `<div class="fighter" data-uid="${u}">
    <div class="bt-card">
      <div class="bt-nameline"><span>${esc(b.names[u])}</span><span class="bt-lv">Lv${b.st[u].lvl}</span></div>
      <div class="bt-bar"><div></div></div>
      <div class="bt-hpnum"></div>
    </div>
    <div class="bt-spot"><div class="platform"></div><div class="bt-sprite">${portrait(b.looks[u])}</div></div>
  </div>`;
}
function buildFighters(b) {
  const mine = [ME, ...matesOf(b, ME)], foes = foesOf(b, ME).concat(b.p.filter((u) => teamOf(b, u) !== teamOf(b, ME) && !alive(b, u)));
  $('#mine').innerHTML = mine.map((u) => fighterHtml(b, u)).join('');
  $('#foes').innerHTML = [...new Set(foes)].map((u) => fighterHtml(b, u)).join('');
  const mySprite = document.querySelector(`#mine [data-uid="${ME}"] .bt-sprite`);
  if (mySprite && !b.looks[ME].photo && mySprite.firstElementChild) mySprite.firstElementChild.style.transform = 'scaleX(-1)';
}
function renderBars(b) {
  b.p.forEach((u) => {
    const el = document.querySelector(`.fighter[data-uid="${u}"]`);
    if (!el) return;
    const pct = Math.max(0, b.hp[u] / b.st[u].max * 100);
    const bar = el.querySelector('.bt-bar div');
    bar.style.width = pct + '%'; bar.className = pct < 25 ? 'low' : pct < 50 ? 'mid' : '';
    el.querySelector('.bt-hpnum').textContent = u === ME || matesOf(b, ME).includes(u) ? `${Math.max(0, b.hp[u])}/${b.st[u].max}` : '';
    el.classList.toggle('down', b.hp[u] <= 0);
    el.classList.toggle('turn', b.status === 'active' && b.turn === u);
    if (b.hp[u] <= 0) el.querySelector('.bt-sprite').classList.add('faint');
  });
}
// Hit animations: the weapon flies in, the target flashes red, shields bloom, specials orbit.
function applyFx(fx) {
  if (!fx) return;
  const layer = $('#fx-layer'), arena = $('#arena');
  const target = document.querySelector(`.fighter[data-uid="${fx.t}"] .bt-sprite`);
  if (!layer || !arena) return;
  const box = arena.getBoundingClientRect();
  const at = target ? target.getBoundingClientRect() : box;
  const tx = at.left + at.width / 2 - box.left, ty = at.top + at.height / 2 - box.top;
  const mine = fx.t !== ME;                       // a hit I landed comes from my side of the screen
  const spawn = (cls, text, style) => {
    const el = document.createElement('div');
    el.className = cls; el.textContent = text;
    Object.assign(el.style, style);
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1600);
    return el;
  };
  const hurt = () => {
    if (!target) return;
    target.classList.remove('hurt'); void target.offsetWidth; target.classList.add('hurt');
    setTimeout(() => target.classList.remove('hurt'), 700);
  };
  if (fx.k === 'hit') {
    SFX.play('swing'); setTimeout(() => SFX.play(fx.t === ME ? 'hurt' : 'hit'), 320);
    spawn('fx-strike ' + (mine ? 'out' : 'in'), fx.emoji || '⚔️', {
      left: tx + 'px', top: ty + 'px',
      '--from-x': (mine ? -box.width * 0.22 : box.width * 0.1) + 'px',
      '--from-y': (mine ? box.height * 0.42 : -box.height * 0.12) + 'px',
      '--spin': (fx.w === 'fist' ? '-8deg' : '-150deg'),
    });
    setTimeout(() => { hurt(); spawn('fx-pow', '💢', { left: tx + 'px', top: ty + 'px' }); }, 330);
  } else if (fx.k === 'special') {
    SFX.play('special');
    spawn('fx-orbit', fx.emoji || '✨', { left: tx + 'px', top: ty + 'px' });
    for (let i = 0; i < 8; i++) {
      spawn('fx-spark', '✨', { left: tx + 'px', top: ty + 'px',
        '--dx': Math.cos((i / 8) * 6.28) * 90 + 'px', '--dy': Math.sin((i / 8) * 6.28) * 90 + 'px',
        animationDelay: 420 + i * 25 + 'ms' });
    }
    setTimeout(() => { hurt(); spawn('fx-burst', fx.emoji || '💥', { left: tx + 'px', top: ty + 'px' }); }, 700);
  } else if (fx.k === 'shield') {
    SFX.play('shield');
    spawn('fx-shield', '🛡️', { left: box.width / 2 + 'px', top: box.height * 0.45 + 'px' });
  } else if (fx.k === 'heal') {
    SFX.play('heal');
    if (target) { target.classList.remove('heal'); void target.offsetWidth; target.classList.add('heal'); }
    spawn('fx-spark', '💚', { left: tx + 'px', top: ty + 'px', '--dx': '0px', '--dy': '-70px' });
  }
}

function onBattle(b) {
  if (!b) return;
  const first = !curB; curB = b;
  if (first) { buildFighters(b); renderBars(b); }
  if (b.seq !== shownSeq) {
    shownSeq = b.seq;
    const snap = JSON.parse(JSON.stringify(b)), lines = snap.lines || [];
    animChain = animChain.then(async () => {
      animating = true; bt.menu.innerHTML = '';
      for (let i = 0; i < lines.length; i++) {
        await say(lines[i]);
        if (i === 0) { applyFx(snap.fx); renderBars(snap); }
      }
      renderBars(snap);
      animating = false; showMenu();
    });
  } else if (!animating) showMenu();
}
async function say(msg) {
  bt.text.textContent = '';
  for (const ch of msg) { bt.text.textContent += ch; await sleep(16); }
  await sleep(700);
}
function menu(items, wide) {
  bt.menu.className = 'bt-menu' + (wide ? ' wide' : '');
  bt.menu.innerHTML = '';
  items.forEach(([label, fn, cls, disabled]) => {
    const b = document.createElement('button'); b.textContent = label; b.className = cls || 'b-blue'; b.disabled = !!disabled;
    b.onclick = () => { if (acting) return; bt.menu.innerHTML = ''; fn(); }; bt.menu.appendChild(b);
  });
}
function showMenu() {
  const b = curB; if (!b) return;
  clearTimeout(waitTimer);
  if (b.status === 'done') {
    const r = b.result || {};
    const iWon = r.winners && r.winners.includes(ME);
    SFX.play(iWon ? 'win' : r.winners ? 'lose' : 'ping');
    bt.text.textContent = iWon ? '🏆 You won!' : r.how === 'truce' ? '🤝 Called it a draw.' : r.winners ? 'You lost this one…' : 'The battle is over.';
    if (localB && !localB.handled) {
      localB.handled = true;
      const wildId = localB.wildId, questId = localB.questId;
      if (iWon && wildId) clearWild(wildId);
      else if (iWon && questId) setTimeout(() => finishQuest(questId), 400);
      else if (questId) setTimeout(() => toast('The boss is still standing. Heal up and try again.', null, 6000), 400);
    }
    return menu([['Back to map', exitBattle, 'b-blue']], true);
  }
  if (!alive(b, ME)) { bt.text.textContent = 'You are down. Your party fights on…'; bt.menu.innerHTML = ''; return; }
  if (b.turn !== ME) {
    bt.text.textContent = `Waiting for ${b.names[b.turn]}…`; bt.menu.innerHTML = '';
    waitTimer = setTimeout(() => menu([['🚪 Leave battle', () => act('leave'), 'b-gray']], true), 45000);
    return;
  }
  if (b.truce && teamOf(b, b.truce) !== teamOf(b, ME)) {
    bt.text.textContent = `${b.names[b.truce]} offers a truce. End the battle?`;
    return menu([['🤝 Accept', () => act('truce-yes'), 'b-green'], ['✊ Refuse', () => act('truce-no'), 'b-red']]);
  }
  bt.text.textContent = `What will ${b.names[ME]} do?`;
  menu([['⚔️ Attack', weaponMenu, 'b-red'], ['🛡️ Defend', () => act('defend'), 'b-blue'],
        ['✨ Act', actMenu, 'b-gold'], ['🏃 Run', () => act('run'), 'b-gray']]);
}
// With two enemies you choose who to hit.
function pickTarget(kind, extra = {}) {
  const b = curB, foes = foesOf(b, ME);
  if (foes.length < 2) return act(kind, { target: foes[0], ...extra });
  bt.text.textContent = 'Who do you go for?';
  menu([...foes.map((u) => [`${b.names[u]} (${b.hp[u]} HP)`, () => act(kind, { target: u, ...extra }), 'b-red']), ['↩ Back', showMenu, 'b-gray']], true);
}
// Swing with what you like — or spend your one special.
function weaponMenu() {
  const b = curB, sp = S.special || {}, used = (b.specUsed || {})[ME];
  bt.text.textContent = 'How do you hit them?';
  const items = Object.entries(WEAPONS).map(([id, w]) => [`${w.emoji} ${w.label}`, () => pickTarget('attack', { weapon: id }), 'b-red']);
  items.push([used ? '✨ Special (spent)' : `${sp.emoji || '✨'} ${sp.name || 'Special attack'}`,
    () => pickTarget('attack', { weapon: 'special' }), 'b-purple', !!used]);
  items.push(['↩ Back', showMenu, 'b-gray']);
  menu(items);
}
function actMenu() {
  const heal = ['bigpotion', 'potion', 'sunscreen'].find((id) => count(id) > 0);
  const human = curB && !curB.ai;
  bt.text.textContent = 'Act how?';
  menu([
    ['🤝 Truce', () => act('truce'), 'b-green'],
    [human ? '💬 Chat' : '💬 Taunt', human ? openBattleChat : () => act('praise'), 'b-blue'],
    ['💖 Praise', () => pickTarget('praise'), 'b-purple'],
    ['🪙 Pay 30', () => act('pay'), 'b-gold', S.coins < 30],
    [heal ? `${ITEMS[heal].ico} Use item` : '🎒 No items', () => act('item', { item: heal }), 'b-blue', !heal],
    ['↩ Back', showMenu, 'b-gray'],
  ]);
}
async function act(kind, arg) {
  if (!battleId || acting) return;
  if (localB) { acting = true; const r = resolveTurn(localB, kind, arg, ME); acting = false; return r ? applyLocal(r) : showMenu(); }
  acting = true;
  try {
    const ok = await B.tx(COL.battles, battleId, (b) => resolveTurn(b, kind, arg, ME));
    if (!ok) showMenu();
  } catch (e) { console.warn(e); toast('Connection hiccup — try again.'); showMenu(); }
  acting = false;
}
// Runs inside a transaction: returns the battle patch plus any player-doc updates.
function resolveTurn(b, kind, arg, actor) {
  const X = actor || ME;
  if (!b || b.status !== 'active') return null;
  if (kind !== 'leave' && b.turn !== X) return null;
  const n = b.names, st = b.st, hp = { ...b.hp }, def = { ...b.def }, lines = [], patch = {};
  const foes = b.p.filter((u) => b.teams[u] !== b.teams[X] && hp[u] > 0);
  const Y = (arg && arg.target && hp[arg.target] > 0) ? arg.target : foes.sort((a, c) => hp[c] - hp[a])[0];
  if (!Y) return null;
  const extra = {}; b.p.forEach((u) => (extra[u] = {}));
  let done = null, fx = null, keepTurn = false;
  switch (kind) {
    case 'attack': {
      const beast = X === AI;                                    // monsters claw, they don't carry swords
      const wid = beast ? 'claw' : ((arg && arg.weapon) || 'sword');
      const special = wid === 'special';
      if (special && (b.specUsed || {})[X]) return null;          // one per battle
      const wpn = beast ? { label: 'lunge', emoji: '🐾', dmg: 1, crit: 0.1 } : (WEAPONS[wid] || WEAPONS.sword);
      const spec = (b.special || {})[X] || {};
      const mult = special ? (X === ME ? statsFor(S).spec : 1.6) : wpn.dmg;
      let dmg = Math.max(1, Math.round((st[X].atk + randi(-2, 3) - st[Y].def) * mult));
      const crit = Math.random() < (special ? 0.2 : wpn.crit); if (crit) dmg = Math.round(dmg * 1.6);
      const blocked = def[Y]; if (blocked) dmg = Math.max(1, Math.floor(dmg / 2));
      hp[Y] = Math.max(0, hp[Y] - dmg); def[Y] = false;
      if (special) {
        patch[`specUsed.${X}`] = true;
        lines.push(`${n[X]} used ${spec.name || 'their special attack'}! (−${dmg} HP)`);
      } else if (beast) {
        lines.push(`${n[X]} lunged at ${n[Y]}! (−${dmg} HP)`);
      } else {
        lines.push(`${n[X]} hit ${n[Y]} with a ${wpn.label.toLowerCase()}! (−${dmg} HP)`);
      }
      if (crit) lines.push('A critical hit!');
      if (blocked) lines.push(`${n[Y]}'s guard softened the blow.`);
      fx = { t: Y, k: special ? 'special' : 'hit', w: wid,
        emoji: special ? (spec.emoji || '✨') : wpn.emoji, name: special ? (spec.name || 'Special') : wpn.label };
      if (hp[Y] <= 0) lines.push(`${n[Y]} fainted!`);
      break;
    }
    case 'defend':
      def[X] = true; hp[X] = Math.min(st[X].max, hp[X] + 2);
      lines.push(`${n[X]} raised their guard! (+2 HP)`); fx = { t: X, k: 'shield' }; break;
    case 'praise': {
      const line = ['Nice outfit!', 'Your gear is sick.', 'You hike fast!', 'Cool hat!'][randi(0, 3)];
      patch[`st.${Y}.atk`] = Math.max(2, st[Y].atk - 1);
      lines.push(`${n[X]}: "${line}"`, `${n[Y]} blushed. Their attack fell!`); break;
    }
    case 'truce': patch.truce = X; lines.push(`${n[X]} offered a truce.`); break;
    case 'truce-yes': done = { how: 'truce' }; lines.push(`${n[X]} accepted the truce. Good fight!`); break;
    case 'truce-no': patch.truce = null; keepTurn = true; lines.push(`${n[X]} refused the truce!`); break;
    case 'pay':
      if (X !== ME || S.coins < 30) return null;
      done = { how: 'paid', winners: b.p.filter((u) => b.teams[u] !== b.teams[X]) };
      extra[X].coins = B.inc(-30); extra[Y].coins = B.inc(30);
      lines.push(`${n[X]} paid ${n[Y]} 30 coins to end the battle.`); break;
    case 'item': {
      const id = arg && arg.item, it = ITEMS[id];
      if (X !== ME || !it || count(id) <= 0) return null;
      hp[X] = Math.min(st[X].max, hp[X] + it.heal); extra[X]['bag.' + id] = B.inc(-1);
      lines.push(`${n[X]} used ${it.name}! (+${it.heal} HP)`); fx = { t: X, k: 'heal' }; break;
    }
    case 'run':
      if (Math.random() < 0.55) { hp[X] = 0; lines.push(`${n[X]} got away safely!`); }
      else lines.push(`${n[X]} tried to run but couldn't get away!`);
      break;
    case 'leave': hp[X] = 0; lines.push(`${n[X]} left the battle.`); break;
    default: return null;
  }
  // A side loses when everyone on it is down.
  const sideUp = (t) => b.p.some((u) => b.teams[u] === t && hp[u] > 0);
  if (!done && (!sideUp(1) || !sideUp(2))) {
    const winTeam = sideUp(1) ? 1 : 2;
    const winners = b.p.filter((u) => b.teams[u] === winTeam), losers = b.p.filter((u) => b.teams[u] !== winTeam);
    const ranAway = kind === 'run' || kind === 'leave';
    done = { how: ranAway ? 'fled' : 'ko', winners, losers };
    if (!ranAway) {
      if (b.ai) {
        const prize = b.prize || 50, xp = b.xp || xpFor(st[Y] ? st[Y].lvl : S.lvl, S.lvl);
        if (winners.includes(ME)) {
          lines.push(`You won ${prize} coins and ${xp} XP!`);
          extra[ME].coins = B.inc(prize); extra[ME].xp = B.inc(xp); extra[ME]['stats.wins'] = B.inc(1);
        } else {
          const lost = Math.floor(S.coins * (b.lossPct != null ? b.lossPct : 0.25));
          lines.push(lost ? `You dropped ${lost} coins getting away.` : 'You limped away.');
          extra[ME].coins = B.inc(-lost); extra[ME].hp = Math.ceil(st[ME].max / 2);
        }
      } else {
        // Each loser forfeits 25% of their coins; the winning side splits the pot.
        const coinsOf = (u) => (u === ME ? S.coins : (others[u] || {}).coins || 0);
        let pot = 0;
        losers.forEach((u) => { const pay = Math.floor(coinsOf(u) * 0.25); pot += pay; extra[u].coins = B.inc(-pay); extra[u].hp = Math.ceil(st[u].max / 2); });
        const share = Math.floor(pot / winners.length);
        const loserLvl = Math.max(...losers.map((u) => st[u].lvl));
        winners.forEach((u) => {
          extra[u].coins = B.inc(share);
          extra[u].xp = B.inc(xpFor(loserLvl, st[u].lvl));
          extra[u]['stats.wins'] = B.inc(1);
        });
        const wName = winners.map((u) => n[u]).join(' and ');
        lines.push(pot ? (winners.length > 1 ? `${wName} split ${pot} coins — ${share} each!` : `${wName} won ${pot} coins!`) : `${wName} wins!`);
      }
    }
  }
  if (done) {
    patch.status = 'done'; patch.result = done;
    if (b.test) return { patch: Object.assign(patch, { hp, def, lines, fx, seq: b.seq + 1, updated: Date.now(), turn: X }), extra: [] };
    b.p.forEach((u) => { if (extra[u].hp === undefined) extra[u].hp = Math.max(1, hp[u]); extra[u]['stats.battles'] = B.inc(1); });
  }
  // Next living fighter in the rotation.
  let turn = X;
  if (!done && !keepTurn) {
    const i = b.p.indexOf(X);
    for (let k = 1; k <= b.p.length; k++) { const u = b.p[(i + k) % b.p.length]; if (hp[u] > 0) { turn = u; break; } }
  }
  Object.assign(patch, { hp, def, lines, fx, seq: b.seq + 1, updated: Date.now(), turn });
  const ops = b.p.filter((u) => u !== AI && Object.keys(extra[u]).length).map((u) => ({ col: COL.players, id: u, patch: extra[u] }));
  return { patch, extra: ops };
}

// ---------- search ----------
function openSearch(query = '', keepFocus = false) {
  const q = String(query || '').trim().toLowerCase();
  const hits = Object.values(others)
    .filter((p) => p.name && (!q || p.name.toLowerCase().includes(q)))
    .sort((a, b) => (online(b) - online(a)) || a.name.localeCompare(b.name))
    .slice(0, 30);
  openSheet(`
    <h2>🔍 Find a player</h2>
    <input class="text" id="q" placeholder="Search by character name…" value="${esc(query)}" autocomplete="off">
    ${hits.length ? `<div class="list">${hits.map((p) => `
      <div class="item" data-see="${p.id}"><div class="mini">${avatarOf(p)}</div><div class="grow"><b>${esc(p.name)}</b>
        <span class="sub">Lv${p.lvl} · ${online(p) ? '🟢 ' + fmtDist(distM(myPos, p)) : '⚪ ' + ago(p.seen || 0)}${isFriend(p.id) ? ' · friend' : ''}</span></div>
      <button class="btn">View</button></div>`).join('')}</div>`
      : `<div class="empty">${q ? 'Nobody by that name yet.' : 'No other players yet. Invite your friends!'}</div>`}
  `, 'search', () => openSearch($('#q') ? $('#q').value : query, true));
  const input = $('#q');
  input.oninput = () => { const v = input.value; clearTimeout(input._t); input._t = setTimeout(() => openSearch(v, true), 250); };
  input.focus({ preventScroll: true });          // pop the keyboard straight away
  if (keepFocus) input.setSelectionRange(input.value.length, input.value.length);
  sheetBody.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => { const p = others[b.dataset.see]; if (online(p)) panTo(p); openPlayer(p.id); }));
}

// ---------- accomplishments ----------
const statOf = (p, k) => ((p && p.stats) || {})[k] || 0;
function openStats() {
  const all = [{ ...S, id: ME }, ...Object.values(others)];
  const board = (k, label, ico) => {
    const top = all.filter((p) => statOf(p, k) > 0).sort((a, b) => statOf(b, k) - statOf(a, k)).slice(0, 5);
    return `<h3>${ico} ${label}</h3>${top.length ? top.map((p, i) => `
      <div class="rank"><span class="pos">${i + 1}</span><span class="mini">${avatarOf(p)}</span>
        <span>${esc(p.name)}${p.id === ME ? ' (you)' : ''}</span><span class="val">${statOf(p, k)}</span></div>`).join('')
      : '<div class="empty">Nobody yet — be the first.</div>'}`;
  };
  const medals = S.medals || [];
  openSheet(`
    <h2>🏅 Accomplishments</h2>
    <div class="row" style="gap:18px;flex-wrap:wrap">
      <div><div class="sub">Battles fought</div><b style="font-size:22px">${statOf(S, 'battles')}</b></div>
      <div><div class="sub">Battles won</div><b style="font-size:22px">${statOf(S, 'wins')}</b></div>
      <div><div class="sub">Treasures found</div><b style="font-size:22px">${statOf(S, 'treasures')}/${TREASURES.length}</b></div>
      <div><div class="sub">Quests finished</div><b style="font-size:22px">${statOf(S, 'quests')}</b></div>
    </div>
    <h3>🎖️ Medals</h3>
    ${medals.length ? `<div>${medals.map((m) => `<span class="medal">${esc(m)}</span>`).join('')}</div>`
      : '<div class="empty">Finish a quest line to earn your first medal.</div>'}
    ${board('wins', 'Most battles won', '⚔️')}
    ${board('treasures', 'Most treasures found', '🧰')}
    ${board('quests', 'Most quests finished', '📜')}
  `, 'stats', openStats);
}

// ---------- quests ----------
let dbQuests = {};
const AI = 'ai';
let localB = null, questMarker = null, questMarkerKey = '';
const allQuests = () => [...BUILTIN_QUESTS, ...Object.values(dbQuests)];
const questById = (id) => allQuests().find((q) => q.id === id);
const activeQuest = () => (S && S.quest ? questById(S.quest.id) : null);
const questStep = (q) => (q && S.quest ? q.steps[S.quest.step] : null);

function renderQuestMarker() {
  const q = activeQuest(), step = questStep(q);
  const key = step ? `${q.id}:${S.quest.step}` : '';
  if (key === questMarkerKey) return;
  questMarkerKey = key;
  if (questMarker) { questMarker.remove(); questMarker = null; }
  $('#quest-dot').classList.toggle('hidden', !step);
  if (!step) return;
  questMarker = marker(`<div class="mk mk-quest">${step.type === 'boss' ? '💀' : '🚩'}<div class="mk-label">${esc(step.name)}</div></div>`,
    step, { onClick: () => openQuests() });
}

function checkQuestStep() {
  const q = activeQuest(), step = questStep(q);
  if (!step || !myPos) return;
  if (distM(myPos, step) > CLAIM_RADIUS_M) return;
  if (nudged.has(questMarkerKey)) return;
  nudged.add(questMarkerKey);
  toast(`📜 You reached <b>${esc(step.name)}</b>`, [['Continue the quest', 'primary', () => doQuestStep()], ['Later', '', null]], 0);
}

function startQuest(q) {
  upd({ quest: { id: q.id, step: 0, items: [] } });
  closeSheet();
  toast(`📜 Quest started: <b>${esc(q.title)}</b>. First stop: ${esc(q.steps[0].name)}.`, null, 7000);
  flyTo(q.steps[0], 15);
}

function doQuestStep() {
  const q = activeQuest(), step = questStep(q);
  if (!q || !step || distM(myPos, step) > CLAIM_RADIUS_M) return;
  if (step.type === 'boss') {
    if (step.requires && !(S.quest.items || []).includes(step.requires)) {
      return toast(`You need the ${esc(step.requires)} first.`);
    }
    if (S.hp < 6) return toast('You are too hurt to fight. Heal up first.');
    return startBossBattle(q, step);
  }
  const patch = { 'quest.step': S.quest.step + 1 };
  if (step.grant) patch['quest.items'] = B.union(step.grant);
  upd(patch);
  openSheet(`
    <h2>${esc(step.name)}</h2>
    <p>${esc(step.text || '')}</p>
    ${step.grant ? `<p><span class="medal">🗝️ ${esc(step.grant)}</span><br><span class="sub">Added to your quest items.</span></p>` : ''}
    <p class="sub">Next: <b>${esc((q.steps[S.quest.step] || {}).name || 'finish the quest')}</b></p>
    <div class="btns"><button class="btn primary" id="ok">Onward</button></div>
  `, 'queststep');
  $('#ok').onclick = () => { closeSheet(); const nx = questStep(q); if (nx) flyTo(nx, 15); };
}

function finishQuest(questId) {
  const q = questById(questId) || activeQuest();
  if (!q) return;
  const r = q.reward || {};
  upd({ quest: null, medals: B.union(r.medal || '🎖️ Quest medal'), coins: B.inc(r.coins || 0), xp: B.inc(r.xp || 0), 'stats.quests': B.inc(1) });
  exitBattle();
  openSheet(`
    <div style="text-align:center">
      <div style="font-size:56px;margin:6px 0">🎖️</div>
      <h2>Quest complete!</h2>
      <p>${esc(q.title)}</p>
      <p><span class="medal">${esc(r.medal || 'Quest medal')}</span></p>
      <p class="sub">+${r.coins || 0} coins · +${r.xp || 0} XP</p>
      <div class="btns"><button class="btn primary" id="ok">Nice</button></div>
    </div>`, 'questdone');
  $('#ok').onclick = closeSheet;
}

function openQuests() {
  const q = activeQuest(), mine = allQuests().filter((x) => x.by === ME);
  const others_ = allQuests().filter((x) => x.by !== ME && (!q || x.id !== q.id));
  const card = (x) => `<div class="item" data-quest="${x.id}"><div class="ico">${x.builtin ? '📜' : '✍️'}</div>
    <div class="grow"><b>${esc(x.title)}</b><span class="sub">${x.steps.length} stops · by ${esc(x.byName || 'someone')}</span></div>
    <span class="lvl">Lv ${x.level}</span></div>`;
  openSheet(`
    <h2>📜 Quests</h2>
    ${q ? `<h3>Active</h3>
      <div class="sub" style="margin-bottom:8px">${esc(q.title)} · <span class="lvl">Lv ${q.level}</span></div>
      ${q.steps.map((st, i) => `<div class="step ${i < S.quest.step ? 'done' : i === S.quest.step ? 'now' : ''}">
        <span class="n">${i < S.quest.step ? '✓' : i + 1}</span>
        <div><b>${st.type === 'boss' ? '💀 ' : ''}${esc(st.name)}</b>
        <span class="sub">${i === S.quest.step ? fmtDist(distM(myPos, st)) + ' away' : esc(st.text || '')}</span></div></div>`).join('')}
      ${(S.quest.items || []).length ? `<p class="sub">Quest items: ${(S.quest.items || []).map((i) => `<span class="medal">🗝️ ${esc(i)}</span>`).join('')}</p>` : ''}
      <div class="btns"><button class="btn primary" id="show">Show next stop</button><button class="btn" id="invite">Invite a friend</button></div>
      <div class="btns"><button class="btn" id="abandon">Abandon quest</button></div>`
    : '<p class="sub">Pick a quest line, walk it in real life, and fight what waits at the end.</p>'}
    <h3>Quest lines</h3>
    <div class="list">${others_.map(card).join('') || '<div class="empty">None yet.</div>'}</div>
    ${mine.length ? `<h3>Written by you</h3><div class="list">${mine.map(card).join('')}</div>` : ''}
    <h3>⛏️ Mining</h3>
    <p class="sub">A logic puzzle cut into the rock. Crack a seam for coins and a fraction of a stat point — no walking required.</p>
    <div class="btns"><button class="btn gold" id="mine-go">⛏️ Mine a seam</button></div>
    <div class="btns"><button class="btn blue" id="make">✍️ Write a quest</button></div>
  `, 'quests', openQuests);
  $('#mine-go').onclick = () => openMine(true);
  sheetBody.querySelectorAll('[data-quest]').forEach((b) => (b.onclick = () => openQuest(questById(b.dataset.quest))));
  $('#make').onclick = openQuestBuilder;
  const sh = $('#show'); if (sh) sh.onclick = () => { closeSheet(); flyTo(questStep(q), 16); };
  const ab = $('#abandon'); if (ab) ab.onclick = () => { upd({ quest: null }); openQuests(); };
  const iv = $('#invite'); if (iv) iv.onclick = () => inviteToQuest(q);
}

function openQuest(q) {
  if (!q) return;
  const active = S.quest && S.quest.id === q.id;
  openSheet(`
    <div class="row"><div style="font-size:40px">${q.builtin ? '📜' : '✍️'}</div>
      <div><h2>${esc(q.title)}</h2><span class="lvl">Lv ${q.level}</span>
      <span class="sub"> · ${q.steps.length} stops · by ${esc(q.byName || 'someone')}</span></div></div>
    <p>${esc(q.blurb || '')}</p>
    ${q.steps.map((st, i) => `<div class="step"><span class="n">${i + 1}</span><div>
      <b>${st.type === 'boss' ? '💀 ' : ''}${esc(st.name)}</b>
      <span class="sub">${fmtDist(distM(myPos, st))} away${st.grant ? ' · gives ' + esc(st.grant) : ''}${st.boss ? ' · boss: ' + esc(st.boss.name) + ' (Lv' + st.boss.lvl + ')' : ''}</span></div></div>`).join('')}
    <p class="sub">Reward: <span class="medal">${esc((q.reward || {}).medal || 'medal')}</span> +${(q.reward || {}).coins || 0} coins</p>
    <div class="btns">
      ${active ? '<button class="btn" id="drop">Abandon</button>' : `<button class="btn primary" id="start">${S.quest ? 'Switch to this quest' : 'Start quest'}</button>`}
      <button class="btn blue" id="invite">Invite a friend</button>
    </div>
    ${!q.builtin && (isAdmin(S) || q.by === ME) ? '<div class="btns"><button class="btn" id="del-quest">🗑️ Delete this quest</button></div>' : ''}
  `, 'quest');
  const dq = $('#del-quest'); if (dq) dq.onclick = async () => {
    if (!confirm(`Delete “${q.title}”?`)) return;
    await B.update(COL.quests, q.id, { deleted: true });
    delete dbQuests[q.id];
    toast('Quest deleted.', null, 2500); openQuests();
  };
  const st = $('#start'); if (st) st.onclick = () => startQuest(q);
  const dr = $('#drop'); if (dr) dr.onclick = () => { upd({ quest: null }); openQuests(); };
  $('#invite').onclick = () => inviteToQuest(q);
}

function inviteToQuest(q) {
  const friends = Object.values(others).filter((p) => isFriend(p.id));
  if (!friends.length) return toast('Add a friend first, then you can invite them.');
  openSheet(`
    <h2>Invite to “${esc(q.title)}”</h2>
    <p class="sub">They get an invite and can run the quest with you.</p>
    <div class="list">${friends.map((p) => `<div class="item"><div class="mini">${avatarOf(p)}</div>
      <div class="grow"><b>${esc(p.name)}</b><span class="sub">${online(p) ? 'online' : 'last seen ' + ago(p.seen || 0)}</span></div>
      <button class="btn primary" data-inv="${p.id}">Invite</button></div>`).join('')}</div>
  `, 'questinvite');
  sheetBody.querySelectorAll('[data-inv]').forEach((b) => (b.onclick = () => { sendRequest(b.dataset.inv, 'quest', { questId: q.id }); }));
}

// ---------- quest builder ----------
let draftSteps = [];
function openQuestBuilder() {
  openSheet(`
    <h2>✍️ Write a quest</h2>
    <p class="sub">You're the Anderune master: pick real places, add a story, and end it with a monster of your own.</p>
    <label class="field">Title</label><input class="text" id="q-title" maxlength="40" placeholder="The Bay Cities Key">
    <label class="field">What's it about?</label><input class="text" id="q-blurb" maxlength="140" placeholder="A courier job across the Westside.">
    <label class="field">Difficulty</label>
    <select class="text" id="q-level">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">Level ${n}${n === 1 ? ' — easy stroll' : n === 5 ? ' — serious hike' : ''}</option>`).join('')}</select>
    <h3>Stops (${draftSteps.length})</h3>
    ${draftSteps.length ? draftSteps.map((st, i) => `<div class="step"><span class="n">${i + 1}</span>
      <div class="grow"><b>${st.type === 'boss' ? '💀 ' : ''}${esc(st.name)}</b>
      <span class="sub">${st.grant ? 'gives ' + esc(st.grant) : st.boss ? esc(st.boss.name) + ' Lv' + st.boss.lvl : esc(st.text || '')}</span></div>
      <button class="btn" data-del="${i}">✕</button></div>`).join('') : '<div class="empty">No stops yet. Add at least two.</div>'}
    <div class="btns"><button class="btn" id="add-go">➕ Add a stop</button><button class="btn" id="add-boss">💀 Add a boss</button></div>
    <label class="field">Medal for finishing</label><input class="text" id="q-medal" maxlength="30" placeholder="🐉 Wyrm of the West">
    <div class="btns"><button class="btn primary" id="q-save">Publish quest</button><button class="btn" id="q-cancel">Cancel</button></div>
  `, 'builder');
  sheetBody.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { draftSteps.splice(+b.dataset.del, 1); openQuestBuilder(); }));
  $('#add-go').onclick = () => addStep('go');
  $('#add-boss').onclick = () => addStep('boss');
  $('#q-cancel').onclick = () => { draftSteps = []; openQuests(); };
  $('#q-save').onclick = saveQuest;
  // keep typed values across re-renders
  ['q-title', 'q-blurb', 'q-medal'].forEach((id) => { if (draft[id]) $('#' + id).value = draft[id]; $('#' + id).oninput = (e) => (draft[id] = e.target.value); });
  if (draft['q-level']) $('#q-level').value = draft['q-level'];
  $('#q-level').onchange = (e) => (draft['q-level'] = e.target.value);
}
const draft = {};

async function addStep(type) {
  const where = await pickPlace(type === 'boss' ? 'Tap the map where the boss waits' : 'Tap the map where this stop is');
  if (!where) return openQuestBuilder();
  openSheet(`
    <h2>${type === 'boss' ? '💀 Boss stop' : '📍 New stop'}</h2>
    <p class="sub">${where.lat.toFixed(5)}, ${where.lng.toFixed(5)}</p>
    <label class="field">Place name</label><input class="text" id="s-name" maxlength="40" placeholder="Bay Cities Italian Deli">
    <label class="field">What happens here?</label><input class="text" id="s-text" maxlength="160" placeholder="Ask for the package under the counter.">
    ${type === 'go'
      ? `<label class="field">Key item they get (optional)</label><input class="text" id="s-grant" maxlength="30" placeholder="Brass Deli Key">`
      : `<label class="field">Monster name</label><input class="text" id="s-boss" maxlength="30" placeholder="The Pantry Wyrm">
         <label class="field">Monster level</label><select class="text" id="s-lvl">${[2, 4, 6, 8, 10, 12, 15].map((n) => `<option value="${n}"${n === 8 ? ' selected' : ''}>Lv ${n}</option>`).join('')}</select>
         <label class="field">Key item needed to unlock it (optional)</label><input class="text" id="s-req" maxlength="30" placeholder="Brass Deli Key">`}
    <div class="btns"><button class="btn primary" id="s-add">Add stop</button><button class="btn" id="s-cancel">Cancel</button></div>
  `, 'stepform');
  $('#s-cancel').onclick = openQuestBuilder;
  $('#s-add').onclick = () => {
    const name = $('#s-name').value.trim();
    if (!name) return toast('Give the place a name.');
    const step = { type, name, lat: where.lat, lng: where.lng, text: $('#s-text').value.trim() };
    if (type === 'go') { const g = $('#s-grant').value.trim(); if (g) step.grant = g; }
    else {
      const lvl = +$('#s-lvl').value, bn = $('#s-boss').value.trim() || 'Nameless Thing';
      step.boss = { name: bn, lvl, hp: 18 + lvl * 3, atk: 3 + Math.round(lvl * 0.8), def: 1 + Math.round(lvl * 0.35) };
      const req = $('#s-req').value.trim(); if (req) step.requires = req;
    }
    draftSteps.push(step);
    openQuestBuilder();
  };
}

// Let the player tap the map to choose a place.
function pickPlace(prompt) {
  return new Promise((resolve) => {
    closeSheet();
    const banner = document.createElement('div');
    banner.id = 'pick-banner';
    banner.innerHTML = `${prompt} · <u id="pick-here">use my spot</u> · <u id="pick-cancel">cancel</u>`;
    document.body.appendChild(banner);
    const done = (v) => { banner.remove(); map.off('click', onClick); resolve(v); };
    const onClick = (e) => done({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    map.on('click', onClick);
    banner.querySelector('#pick-here').onclick = () => done(myPos ? { ...myPos } : null);
    banner.querySelector('#pick-cancel').onclick = () => done(null);
  });
}

async function saveQuest() {
  const title = (draft['q-title'] || '').trim();
  if (!title) return toast('Give your quest a title.');
  if (draftSteps.length < 2) return toast('Add at least two stops.');
  const level = +(draft['q-level'] || 3);
  const q = {
    id: 'q_' + Math.random().toString(36).slice(2, 9),
    title, level, by: ME, byName: S.name,
    blurb: (draft['q-blurb'] || '').trim(),
    steps: draftSteps,
    reward: { medal: (draft['q-medal'] || '').trim() || '🎖️ ' + title, coins: 40 * level, xp: 20 * level },
    created: Date.now(),
  };
  await B.set(COL.quests, q.id, q);
  dbQuests[q.id] = q;
  draftSteps = []; ['q-title', 'q-blurb', 'q-medal'].forEach((k) => delete draft[k]);
  toast(`📜 “${esc(title)}” published! Invite a friend to run it.`, null, 6000);
  openQuest(q);
}

// ---------- boss battle (AI) ----------
function startBossBattle(q, step) {
  const boss = step.boss, sm = statsFor(S);
  closeSheet();
  localB = {
    p: [AI, ME], teams: { [AI]: 1, [ME]: 2 }, ai: true, status: 'active', questId: q.id, prize: Math.round(((q.reward || {}).coins || 60) * 0.3), xp: 40, // the rest comes from finishing the quest
    names: { [AI]: boss.name, [ME]: S.name },
    looks: { [AI]: { monster: boss.name }, [ME]: { look: S.look, equipped: S.equipped, photo: S.photo || null } },
    st: { [AI]: { atk: boss.atk, def: boss.def, max: boss.hp, lvl: boss.lvl }, [ME]: sm },
    hp: { [AI]: boss.hp, [ME]: S.hp }, def: { [AI]: false, [ME]: false },
    turn: ME, truce: null, seq: 1, fx: null, result: null,
    lines: [`${step.text || ''}`.trim() || `${boss.name} blocks your way!`, `${boss.name} attacks!`],
  };
  battleId = 'local'; inBattle = true; curB = null; shownSeq = 0; animChain = Promise.resolve();
  $('#foes').innerHTML = ''; $('#mine').innerHTML = '';
  $('#battle').classList.remove('hidden'); document.body.classList.add('in-battle');
  onBattle(localB);
}
function applyLocal(r) {
  applyPatch(localB, r.patch);
  (r.extra || []).forEach((o) => { if (o.id === ME) upd(o.patch); });
  onBattle(localB);
  if (localB.status === 'active' && localB.turn === AI) setTimeout(aiMove, 300);
}
function aiMove() {
  if (!localB || localB.status !== 'active' || localB.turn !== AI) return;
  if (animating) return setTimeout(aiMove, 400);
  if (localB.truce && localB.truce !== AI) {                 // they're deciding on your truce
    const hurt = 1 - localB.hp[AI] / localB.st[AI].max;
    const chance = 0.12 + 0.5 * hurt + statsFor(S).talk;
    const r0 = resolveTurn(localB, Math.random() < chance ? 'truce-yes' : 'truce-no', null, AI);
    return r0 ? applyLocal(r0) : setTimeout(aiMove, 400);
  }
  const lowHp = localB.hp[AI] / localB.st[AI].max < 0.3;
  const roll = Math.random();
  const kind = lowHp && roll < 0.35 ? 'defend' : roll < 0.78 ? 'attack' : roll < 0.9 ? 'defend' : 'praise';
  const r = resolveTurn(localB, kind, null, AI);
  if (r) applyLocal(r); else setTimeout(aiMove, 400);
}

// ---------- party ----------
function leaveParty() {
  const mates = myParty();
  const ops = [{ col: COL.players, id: ME, patch: { party: null } }];
  mates.forEach((u) => ops.push({ col: COL.players, id: u, patch: { party: null } }));
  B.batch(ops);
  applyPatch(S, { party: null }); onMyChange();
  toast('Party disbanded.', null, 2500);
  if (sheetKind === 'profile') openProfile(); else closeSheet();
}

// ---------- wild monsters ----------
// They roam near you so there's always something to fight, even with nobody else online.
let wilds = [], wildCooldown = 0;
// Is this spot out on the water? Tested against the map's real water polygons, so it
// works for places that aren't on screen — most monsters spawn outside the view.
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInPoly = (pt, rings) => rings.length > 0 && pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => pointInRing(pt, h));
function isWaterAt(pos) {
  try {
    const feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'water' });
    if (!feats.length) return null;                       // tiles not loaded yet — ask again later
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Polygon' && pointInPoly(pos, g.coordinates)) return true;
      if (g.type === 'MultiPolygon' && g.coordinates.some((c) => pointInPoly(pos, c))) return true;
    }
    return false;
  } catch { return null; }
}

// Turn a land monster into something that had no business being out there.
function makeSeaMonster(w) {
  const t = SEA_TYPES[randi(0, SEA_TYPES.length - 1)];
  const lvl = S.lvl + SEA_LEVEL_GAP + randi(0, 5);
  return Object.assign(w, t, {
    lvl, sea: true,
    hp: Math.round(10 + lvl * t.hpMul), atk: Math.round(2 + lvl * t.atkMul), def: Math.round(1 + lvl * t.defMul),
    coins: 6 + lvl * 4, xp: xpFor(lvl, S.lvl),
  });
}
// Back to something ordinary when it wanders ashore.
function makeLandMonster(w) {
  const t = WILD_TYPES[randi(0, WILD_TYPES.length - 1)];
  const lvl = Math.max(2, S.lvl + randi(-2, 1));
  return Object.assign(w, t, {
    lvl, sea: false,
    hp: Math.round(10 + lvl * t.hpMul), atk: Math.round(2 + lvl * t.atkMul), def: Math.round(1 + lvl * t.defMul),
    coins: 6 + lvl * 3, xp: xpFor(lvl, S.lvl),
  });
}
function spawnWild(near) {
  const t = WILD_TYPES[randi(0, WILD_TYPES.length - 1)];
  const lvl = Math.max(2, S.lvl + randi(-2, 1));
  const ang = rand(0, Math.PI * 2), dist = rand(70, 260);
  const pos = { lat: near.lat + (Math.sin(ang) * dist) / 111320,
                lng: near.lng + (Math.cos(ang) * dist) / (111320 * Math.cos(near.lat * Math.PI / 180)) };
  const w = {
    id: 'w' + Math.random().toString(36).slice(2, 8), ...t, lvl, sea: false, checked: false,
    hp: Math.round(10 + lvl * t.hpMul), atk: Math.round(2 + lvl * t.atkMul), def: Math.round(1 + lvl * t.defMul),
    coins: 6 + lvl * 3, xp: xpFor(lvl, S.lvl), pos, marker: null,
  };
  const water = isWaterAt(pos);
  if (water !== null) { w.checked = true; if (water) makeSeaMonster(w); }
  return w;
}
function renderWilds() {
  wilds.forEach((w) => {
    const water = isWaterAt(w.pos);         // they wander, so re-check which side of the shore they're on
    if (water !== null && water !== w.sea) {
      if (water) makeSeaMonster(w); else makeLandMonster(w);
      w.checked = true;
      if (w.marker) { w.marker.remove(); w.marker = null; }
    } else if (water !== null) w.checked = true;
    const html = `<div class="mk mk-wild ${w.sea ? 'sea' : ''}"><div class="wild-face">${w.emoji}</div>
      <div class="mk-label">${esc(w.name)} Lv${w.lvl}</div></div>`;
    if (!w.marker) w.marker = marker(html, w.pos, { onClick: () => openWild(w) });
    else w.marker.setLngLat(LL(w.pos));
  });
}
function keepWilds() {
  if (!S || !myPos) return;
  if (!inRegion(myPos)) { wilds.forEach((w) => w.marker && w.marker.remove()); wilds = []; return; }
  wilds = wilds.filter((w) => { if (distM(w.pos, myPos) < 900) return true; w.marker && w.marker.remove(); return false; });
  if (Date.now() >= wildCooldown) while (wilds.length < WILD_COUNT) wilds.push(spawnWild(myPos));
  renderWilds();
}
function wanderWilds() {
  if (!S || !myPos || inBattle) return;
  wilds.forEach((w) => {
    const step = rand(8, 22), ang = rand(0, Math.PI * 2);
    w.pos = { lat: w.pos.lat + (Math.sin(ang) * step) / 111320,
              lng: w.pos.lng + (Math.cos(ang) * step) / (111320 * Math.cos(w.pos.lat * Math.PI / 180)) };
  });
  keepWilds();
}
setInterval(wanderWilds, 4000);

const wildNudged = new Set();
function checkWilds() {
  const near = wilds.find((w) => distM(w.pos, myPos) <= WILD_RADIUS_M && !wildNudged.has(w.id));
  if (!near) return;
  wildNudged.add(near.id);
  toast(near.sea
    ? `${near.emoji} <b>${esc(near.name)}</b> (Lv${near.lvl}) is out on the water. Way out of your league.`
    : `${near.emoji} A <b>${esc(near.name)}</b> (Lv${near.lvl}) is right here!`,
    [['Fight it', 'primary', () => openWild(near)], ['Leave it', '', null]], 0);
}
function openWild(w) {
  const d = distM(myPos, w.pos), close = d <= WILD_RADIUS_M;
  openSheet(`
    <div class="row"><div class="wild-big">${w.emoji}</div>
      <div><h2>${esc(w.name)}</h2><span class="lvl">Lv ${w.lvl}</span>
      <span class="pill ${close ? 'ok' : 'far'}">${close ? 'Right here' : fmtDist(d) + ' away'}</span></div></div>
    <p>${esc(w.flavor)}</p>
    ${w.sea ? `<p class="danger">☠️ Lv ${w.lvl} — that's ${w.lvl - S.lvl} levels above you, out on the water. It will almost certainly kill you.</p>` : ''}
    <p class="sub">HP ${w.hp} · ATK ${w.atk} · DEF ${w.def} · beats you for ${w.coins} coins and ${w.xp} XP.</p>
    <div class="btns"><button class="btn primary" id="fight" ${close ? '' : 'disabled'}>⚔️ Fight it</button>
      <button class="btn" id="later">Leave it alone</button></div>
    ${close ? '' : '<p class="sub">Walk closer to start the fight.</p>'}
  `, 'wild', () => openWild(w));
  $('#fight').onclick = () => startWildBattle(w);
  $('#later').onclick = closeSheet;
}
function startWildBattle(w) {
  if (S.hp < 5) return toast('You are too hurt to fight. Heal up first.');
  closeSheet();
  const sm = statsFor(S);
  localB = {
    p: [AI, ME], teams: { [AI]: 1, [ME]: 2 }, ai: true, status: 'active', wildId: w.id,
    prize: w.coins, xp: w.xp, lossPct: 0.1,
    names: { [AI]: w.name, [ME]: S.name },
    looks: { [AI]: { emoji: w.emoji }, [ME]: { look: S.look, equipped: S.equipped, photo: S.photo || null } },
    st: { [AI]: { atk: w.atk, def: w.def, max: w.hp, lvl: w.lvl }, [ME]: sm },
    hp: { [AI]: w.hp, [ME]: S.hp }, def: { [AI]: false, [ME]: false },
    turn: ME, truce: null, seq: 1, fx: null, result: null,
    lines: [`A wild ${w.name} blocks your path!`],
  };
  battleId = 'local'; inBattle = true; curB = null; shownSeq = 0; animChain = Promise.resolve();
  $('#foes').innerHTML = ''; $('#mine').innerHTML = '';
  $('#battle').classList.remove('hidden'); document.body.classList.add('in-battle');
  onBattle(localB);
}
// A beaten monster wanders off and a new one shows up somewhere else.
function clearWild(id) {
  const i = wilds.findIndex((w) => w.id === id);
  if (i < 0) return;
  wilds[i].marker && wilds[i].marker.remove();
  wilds.splice(i, 1);
  wildCooldown = Date.now() + rand(25000, 70000); // the area stays quiet for a bit
}

// ---------- AR mode ----------
// The camera goes behind the fight, and the enemy is pinned to its real spot in the
// world using the compass, so you can look away from it and find it again.
const AR = { on: false, stream: null, video: null, raf: null, track: null, last: 0, heading: null, pitch: 0, tracking: false, manual: 0, drag: null };
const AR_W = 190;          // camera is drawn this wide, then stretched — chunky but readable
const AR_FPS = 24;
const AR_LEVELS = 10;      // colour steps per channel
const AR_HFOV = 58;        // rough horizontal field of view of a phone camera, in degrees
const AR_VFOV = 74;

function compassBearing(from, to) {
  const toR = Math.PI / 180, dLng = (to.lng - from.lng) * toR;
  const y = Math.sin(dLng) * Math.cos(to.lat * toR);
  const x = Math.cos(from.lat * toR) * Math.sin(to.lat * toR) - Math.sin(from.lat * toR) * Math.cos(to.lat * toR) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Where is the thing we're fighting, in the real world?
function foeSpot() {
  if (localB && localB.testPos) return localB.testPos;      // stand-in "player" for admin test battles
  if (localB && localB.wildId) { const w = wilds.find((x) => x.id === localB.wildId); if (w) return w.pos; }
  if (localB && localB.questId) { const q = questById(localB.questId); if (q && S.quest) return q.steps[S.quest.step]; }
  if (curB) {
    // the nearest enemy still standing, using wherever they actually are right now
    const foes = curB.p
      .filter((u) => curB.teams[u] !== curB.teams[ME] && curB.hp[u] > 0)
      .map((u) => others[u])
      .filter((p) => p && p.lat != null && Date.now() - (p.seen || 0) < ONLINE_WINDOW_MS);
    if (foes.length && myPos) return foes.sort((a, b) => distM(myPos, a) - distM(myPos, b))[0];
  }
  return null;
}
function onOrient(e) {
  const h = e.webkitCompassHeading != null ? e.webkitCompassHeading
    : (e.alpha != null ? 360 - e.alpha : null);
  if (h != null && !Number.isNaN(h)) AR.heading = h;
  if (e.beta != null) AR.pitch = e.beta;
  updateCompassChip();
  placeFoe();
}
// Tell the player plainly whether the phone is feeding us a compass.
function updateCompassChip() {
  const chip = $('#ar-compass');
  if (!chip) return;
  if (!AR.on) return chip.classList.add('hidden');
  chip.classList.remove('hidden');
  if (AR.heading != null) { chip.textContent = '🧭 Locked to the world'; chip.className = 'ok'; }
  else { chip.textContent = '🧭 No compass — tap to fix, or drag to aim'; chip.className = 'warn'; }
}
// Put the enemy (and its buttons) where they belong on screen for the way you're facing.
function placeFoe() {
  const anchor = $('#ar-anchor'), hint = $('#ar-hint'), arena = $('#arena');
  if (!AR.on || !anchor || !arena) return;
  const spot = foeSpot();
  if (AR.heading == null && spot && myPos && AR.manual) {  // no compass, but they've aimed by hand
    const w2 = arena.clientWidth;
    const x2 = (-AR.manual / (AR_HFOV / 2)) * (w2 / 2);
    anchor.style.setProperty('--ar-x', x2.toFixed(1) + 'px');
    anchor.classList.toggle('gone', Math.abs(AR.manual) > AR_HFOV / 2 + 6);
    hint.classList.toggle('hidden', Math.abs(AR.manual) <= AR_HFOV / 2 + 6);
    if (!hint.classList.contains('hidden')) {
      const nm = (curB && curB.names[curB.p.find((u) => u !== ME)]) || 'them';
      hint.textContent = AR.manual > 0 ? `◀ ${nm} is this way` : `${nm} is this way ▶`;
      hint.className = AR.manual > 0 ? 'left' : 'right';
    }
    return;
  }
  if (AR.heading == null || !spot || !myPos) {           // no compass: just sit centred
    anchor.style.setProperty('--ar-x', '0px');
    anchor.style.setProperty('--ar-y', '0px');
    anchor.classList.remove('gone'); hint.classList.add('hidden');
    return;
  }
  const w = arena.clientWidth, h = arena.clientHeight;
  let delta = compassBearing(myPos, spot) - AR.heading - AR.manual;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  const x = (delta / (AR_HFOV / 2)) * (w / 2);
  const tilt = Math.max(-40, Math.min(40, AR.pitch - 75));  // upright-ish phone = eye level
  const y = (tilt / (AR_VFOV / 2)) * (h / 2);
  const dist = distM(myPos, spot);
  const scale = Math.max(0.65, Math.min(1.35, 22 / Math.max(6, dist) + 0.7));
  anchor.style.setProperty('--ar-x', x.toFixed(1) + 'px');
  anchor.style.setProperty('--ar-y', Math.max(-h * 0.2, Math.min(h * 0.22, y)).toFixed(1) + 'px');
  anchor.style.setProperty('--ar-s', scale.toFixed(2));
  const offScreen = Math.abs(delta) > AR_HFOV / 2 + 6;
  anchor.classList.toggle('gone', offScreen);
  if (offScreen) {
    const name = (curB && curB.names[curB.p.find((u) => u !== ME)]) || 'them';
    hint.textContent = delta < 0 ? `◀ ${name} is this way` : `${name} is this way ▶`;
    hint.className = delta < 0 ? 'left' : 'right';
  } else hint.classList.add('hidden');
}
async function askOrientation() {
  try {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      const res = await D.requestPermission();
      if (res !== 'granted') return false;
    }
    window.addEventListener('deviceorientation', onOrient, true);
    window.addEventListener('deviceorientationabsolute', onOrient, true);   // Android
    AR.tracking = true;
    return true;
  } catch { return false; }
}

async function toggleAR() {
  if (AR.on) return stopAR();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('This browser has no camera access.');
  if (!window.isSecureContext) return toast('The camera needs an https:// page.');
  const btn = $('#ar-toggle');
  btn.textContent = '📷 …';
  const tracked = await askOrientation();   // must be asked from the tap, before the camera
  try {
    AR.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (e) {
    btn.textContent = '📷 AR';
    return toast(e && e.name === 'NotAllowedError'
      ? 'Camera is blocked. Safari → page menu → Website Settings → Camera → Allow.'
      : "Couldn't open the camera.", null, 7000);
  }
  AR.video = document.createElement('video');
  AR.video.playsInline = true; AR.video.muted = true; AR.video.srcObject = AR.stream;
  await AR.video.play().catch(() => {});
  AR.on = true;
  // players move while you fight them, so keep re-checking where they are
  AR.track = setInterval(placeFoe, 500);
  updateCompassChip();
  setTimeout(updateCompassChip, 2500);
  btn.textContent = '📷 AR on'; btn.classList.add('on');
  $('#arena').classList.add('ar'); document.body.classList.add('ar');
  ['#ar-canvas', '#ar-glow', '#ar-anchor'].forEach((id) => $(id).classList.remove('hidden'));
  // the enemy and its buttons now live at the monster's spot in the world
  $('#ar-anchor').appendChild($('#foes'));
  $('#ar-anchor').appendChild(bt.menu);
  placeFoe();
  drawAR();
  toast(tracked ? 'Point your phone around — they stay where they are.'
                : 'Point your phone at the street. (Motion access off, so they stay centred.)', null, 5000);
}
function stopAR() {
  AR.on = false;
  clearInterval(AR.track); AR.track = null;
  cancelAnimationFrame(AR.raf);
  if (AR.stream) AR.stream.getTracks().forEach((t) => t.stop());
  AR.stream = null; AR.video = null;
  if (AR.tracking) {
    window.removeEventListener('deviceorientation', onOrient, true);
    window.removeEventListener('deviceorientationabsolute', onOrient, true);
    AR.tracking = false;
  }
  AR.heading = null; AR.manual = 0;
  const chip = $('#ar-compass'); if (chip) chip.classList.add('hidden');
  const btn = $('#ar-toggle');
  if (btn) { btn.textContent = '📷 AR'; btn.classList.remove('on'); }
  const arena = $('#arena');
  if (arena) {                                   // put the fight back on the drawn field
    arena.classList.remove('ar');
    const foes = $('#foes'); if (foes) arena.appendChild(foes);
    const panel = document.querySelector('.bt-panel'); if (panel && bt.menu) panel.appendChild(bt.menu);
  }
  document.body.classList.remove('ar');
  ['#ar-canvas', '#ar-glow', '#ar-anchor', '#ar-hint'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); });
}
function drawAR() {
  AR.raf = requestAnimationFrame(drawAR);
  if (!AR.on || !AR.video || AR.video.readyState < 2) return;
  const now = performance.now();
  if (now - AR.last < 1000 / AR_FPS) return;
  AR.last = now;
  const c = $('#ar-canvas'), glow = $('#ar-glow'), arena = $('#arena');
  const ratio = arena.clientHeight / Math.max(1, arena.clientWidth);
  const w = AR_W, h = Math.round(AR_W * ratio);
  if (c.width !== w || c.height !== h) { c.width = glow.width = w; c.height = glow.height = h; }
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const vw = AR.video.videoWidth, vh = AR.video.videoHeight;
  if (!vw || !vh) return;
  // fill the screen from the camera's native wide frame: full height, sides cropped.
  // (Asking for a portrait-shaped frame is what made it look zoomed in before — iOS
  // delivers that by cropping into the sensor.)
  const scale = Math.max(w / vw, h / vh), dw = vw * scale, dh = vh * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(AR.video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  // posterise a little, so it reads as game art without turning to mush
  const img = ctx.getImageData(0, 0, w, h), d = img.data, step = 255 / (AR_LEVELS - 1);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.round(d[i] / step) * step;
    d[i + 1] = Math.round(d[i + 1] / step) * step;
    d[i + 2] = Math.round(d[i + 2] / step) * step;
  }
  ctx.putImageData(img, 0, 0);
  // Bloom: keep only the bright parts, the CSS blur turns them into glow.
  const gx = glow.getContext('2d', { willReadFrequently: true });
  gx.clearRect(0, 0, w, h);
  gx.drawImage(c, 0, 0);
  const gi = gx.getImageData(0, 0, w, h), gd = gi.data;
  for (let i = 0; i < gd.length; i += 4) {
    const lum = gd[i] * 0.299 + gd[i + 1] * 0.587 + gd[i + 2] * 0.114;
    if (lum < 186) { gd[i + 3] = 0; }
    else { gd[i + 3] = Math.min(255, (lum - 186) * 3.4); }
  }
  gx.putImageData(gi, 0, 0);
}

// ---------- talking mid-battle ----------
let bchatUnsub = null;
function openBattleChat() {
  const b = curB; if (!b || b.ai) return showMenu();
  const foe = b.p.find((u) => u !== ME && b.teams[u] !== b.teams[ME]);
  if (!foe) return showMenu();
  const box = document.createElement('div');
  box.id = 'bchat'; box.className = 'sheet-surface';
  box.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <b>💬 ${esc(b.names[foe])}</b><button class="btn" id="bc-close" style="flex:none;min-width:0;padding:6px 12px">Done</button>
    </div>
    <div class="chat" id="bc-log"></div>
    <div class="chips">
      <button class="chip" data-say="Good fight!">Good fight!</button>
      <button class="chip" data-say="Truce?">Truce?</button>
      <button class="chip" data-say="You're good — can I add you?">Can I add you?</button>
    </div>
    <div class="row" style="margin-top:8px"><input class="text" id="bc-in" placeholder="Say something…" maxlength="200" style="margin:0">
      <button class="btn blue" id="bc-send" style="flex:none;min-width:0">Send</button></div>`;
  $('#arena').appendChild(box);
  const log = box.querySelector('#bc-log');
  bchatUnsub = B.watchDoc(COL.chats, pairId(ME, foe), (d) => {
    const msgs = ((d && d.msgs) || []).slice().sort((a, c) => a.t - c.t).slice(-40);
    log.innerHTML = msgs.map((m) => `<div class="msg ${m.from === 'sys' ? 'sys' : m.from === ME ? 'me' : 'them'}">${esc(m.text)}</div>`).join('')
      || '<div class="msg sys">No messages yet</div>';
    log.scrollTop = log.scrollHeight;
  });
  const send = (txt) => { const v = (txt || box.querySelector('#bc-in').value).trim(); if (!v) return; box.querySelector('#bc-in').value = ''; chatSay(foe, v); };
  box.querySelector('#bc-send').onclick = () => send();
  box.querySelector('#bc-in').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  box.querySelectorAll('[data-say]').forEach((c) => (c.onclick = () => send(c.dataset.say)));
  box.querySelector('#bc-close').onclick = closeBattleChat;
}
function closeBattleChat() {
  if (bchatUnsub) { bchatUnsub(); bchatUnsub = null; }
  const el = $('#bchat'); if (el) el.remove();
  showMenu();
}

function closeBattleChatQuiet() {
  if (bchatUnsub) { bchatUnsub(); bchatUnsub = null; }
  const el = $('#bchat'); if (el) el.remove();
}

// ---------- admin practice battles ----------
function startTestBattle(kind) {
  closeSheet();
  const sm = statsFor(S);
  const foe = kind === 'monster'
    ? { name: 'Test Grizzly', looks: { emoji: '🐻' }, atk: sm.atk, def: Math.max(1, sm.def - 1), max: sm.max + 6, lvl: S.lvl }
    : { name: 'Test Rival', lvl: S.lvl, atk: sm.atk, def: sm.def, max: sm.max,
        looks: { look: { skin: '#c68642', hair: 'bob', hairColor: '#2b1a0e', shirt: '#e11d48', bg: '#2b2450', top: 'hoodie' },
                 equipped: { hat: 'cap', face: null, neck: null } } };
  // Give them a stand-in spot nearby so AR has something real to anchor to — same as
  // fighting an actual player. It drifts slightly so it doesn't feel glued in place.
  const testPos = myPos ? offsetLL(myPos, rand(15, 40), rand(0, 360)) : null;
  localB = {
    p: [AI, ME], teams: { [AI]: 1, [ME]: 2 }, ai: true, test: true, status: 'active',
    prize: 0, xp: 0, lossPct: 0, testPos,
    names: { [AI]: foe.name, [ME]: S.name },
    looks: { [AI]: foe.looks, [ME]: { look: S.look, equipped: S.equipped, photo: S.photo || null } },
    special: { [ME]: S.special || null },
    st: { [AI]: { atk: foe.atk, def: foe.def, max: foe.max, lvl: foe.lvl }, [ME]: sm },
    hp: { [AI]: foe.max, [ME]: Math.max(S.hp, Math.ceil(sm.max / 2)) },
    def: { [AI]: false, [ME]: false },
    turn: ME, truce: null, seq: 1, fx: null, result: null, specUsed: {},
    lines: [`Test battle: ${S.name} vs ${foe.name}.`, 'Nothing here counts — swing away.'],
  };
  if (testPos) {
    clearInterval(AR.testDrift);
    AR.testDrift = setInterval(() => {
      if (!localB || !localB.testPos) return clearInterval(AR.testDrift);
      localB.testPos = offsetLL(localB.testPos, rand(1, 4), rand(0, 360));
      if (AR.on) placeFoe();
    }, 2000);
  }
  battleId = 'local'; inBattle = true; curB = null; shownSeq = 0; animChain = Promise.resolve();
  $('#foes').innerHTML = ''; $('#mine').innerHTML = '';
  $('#battle').classList.remove('hidden'); document.body.classList.add('in-battle');
  onBattle(localB);
}

// ---------- notifications ----------
// iPhones only allow these for an app added to the home screen, and only through a
// service worker. Everything here is local: the phone alerts itself while Anderune is
// running. Alerts when the app is fully closed need a push server (see the README).
const NOTIFY = {
  reg: null,
  installed: () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
  supported: () => 'serviceWorker' in navigator && 'Notification' in window,
  state: () => (('Notification' in window) ? Notification.permission : 'unsupported'),
  async register() {
    if (!('serviceWorker' in navigator)) return null;
    try { this.reg = await navigator.serviceWorker.register('sw.js'); return this.reg; } catch (e) { console.warn(e); return null; }
  },
  async ask() {
    if (!this.supported()) return 'unsupported';
    const res = await Notification.requestPermission();
    if (res === 'granted') { await this.register(); this.show('🔔 Notifications on', 'This is what an alert looks like.'); }
    return res;
  },
  async show(title, body, tag) {
    if (this.state() !== 'granted') return;
    const reg = this.reg || (await this.register()) || (await navigator.serviceWorker.getRegistration());
    try {
      if (reg && reg.showNotification) await reg.showNotification(title, { body, tag: tag || 'anderune', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
      else new Notification(title, { body, tag, icon: 'icons/icon-192.png' });   // desktop fallback
    } catch (e) { console.warn(e); }
  },
};
if ('serviceWorker' in navigator) window.addEventListener('load', () => NOTIFY.register());

// ---------- sound ----------
// Everything here is synthesised on the fly — no audio files to download.
const SFX = {
  ctx: null, out: null, verb: null, comp: null,
  prefs: (() => {
    const d = { sfx: true, sfxVol: 0.7, music: false, musicVol: 0.5 };
    try { return { ...d, ...JSON.parse(localStorage.getItem('qm_sound') || '{}') }; } catch { return d; }
  })(),
  save() { try { localStorage.setItem('qm_sound', JSON.stringify(this.prefs)); } catch {} },
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    // master chain: a gentle compressor keeps everything round rather than spiky
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.knee.value = 24; this.comp.ratio.value = 3;
    this.out = this.ctx.createGain();
    this.out.gain.value = this.prefs.sfxVol;
    this.out.connect(this.comp); this.comp.connect(this.ctx.destination);
    // a small room, so notes bloom instead of stopping dead
    const sec = 1.1, n = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
    }
    const conv = this.ctx.createConvolver(); conv.buffer = buf;
    this.verb = this.ctx.createGain(); this.verb.gain.value = 0.32;
    this.verb.connect(conv); conv.connect(this.out);
  },
  setVol(v) { this.prefs.sfxVol = v; if (this.out) this.out.gain.value = v; this.save(); },
  // one warm voice: soft attack, filtered, optional vibrato and reverb send
  voice({ type = 'sine', f0, f1, dur = 0.3, vol = 0.2, delay = 0, attack = 0.012, cutoff = 4200, detune = 0, send = 0.3 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(cutoff, t); lp.Q.value = 0.6;
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * 0.9);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(g); g.connect(this.out);
    if (send > 0 && this.verb) { const sg = this.ctx.createGain(); sg.gain.value = send; g.connect(sg); sg.connect(this.verb); }
    o.start(t); o.stop(t + dur + 0.05);
  },
  // a bell-ish note: fundamental plus a quieter octave and fifth
  bell(f, dur = 0.5, vol = 0.16, delay = 0, send = 0.45) {
    this.voice({ type: 'sine', f0: f, dur, vol, delay, cutoff: 6000, send });
    this.voice({ type: 'sine', f0: f * 2, dur: dur * 0.6, vol: vol * 0.4, delay, cutoff: 7000, send });
    this.voice({ type: 'triangle', f0: f * 1.5, dur: dur * 0.35, vol: vol * 0.18, delay, cutoff: 5000, send });
  },
  // air: filtered noise for whooshes, impacts and shimmer
  air(dur = 0.25, vol = 0.2, f0 = 1800, f1 = 400, delay = 0, type = 'lowpass', q = 0.8, send = 0.25) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay, n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(80, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.out);
    if (send > 0 && this.verb) { const sg = this.ctx.createGain(); sg.gain.value = send; g.connect(sg); sg.connect(this.verb); }
    src.start(t); src.stop(t + dur + 0.05);
  },
  chord(freqs, { dur = 0.5, vol = 0.14, spread = 0.055, type = 'triangle' } = {}) {
    freqs.forEach((f, i) => {
      this.voice({ type, f0: f, dur, vol, delay: i * spread, cutoff: 5200, send: 0.4 });
      this.voice({ type: 'sine', f0: f * 2, dur: dur * 0.55, vol: vol * 0.3, delay: i * spread, send: 0.4 });
    });
  },
  play(name) {
    if (!this.prefs.sfx) return;
    this.init();
    if (!this.ctx) return;
    switch (name) {
      case 'tap':     this.voice({ type: 'sine', f0: 760, f1: 900, dur: 0.13, vol: 0.13, cutoff: 3200, send: 0.25 });
                      this.voice({ type: 'sine', f0: 1520, dur: 0.07, vol: 0.05, cutoff: 6000, send: 0.2 }); break;
      case 'sheet':   this.voice({ type: 'sine', f0: 420, f1: 660, dur: 0.24, vol: 0.1, cutoff: 2600, send: 0.4 });
                      this.air(0.26, 0.05, 900, 2600, 0, 'bandpass', 1.2, 0.4); break;
      case 'swing':   this.air(0.24, 0.22, 900, 260, 0, 'lowpass', 1.1, 0.2); break;
      case 'hit':     this.air(0.1, 0.2, 2200, 700, 0, 'bandpass', 1, 0.15);
                      this.voice({ type: 'sine', f0: 170, f1: 55, dur: 0.24, vol: 0.32, attack: 0.004, cutoff: 900, send: 0.15 });
                      this.voice({ type: 'triangle', f0: 320, f1: 140, dur: 0.16, vol: 0.14, attack: 0.004, cutoff: 1800, send: 0.2 }); break;
      case 'hurt':    this.voice({ type: 'triangle', f0: 240, f1: 80, dur: 0.34, vol: 0.26, attack: 0.005, cutoff: 1100, send: 0.3 });
                      this.air(0.2, 0.12, 600, 180, 0, 'lowpass', 1, 0.25); break;
      case 'shield':  this.chord([392, 523.25, 659.25], { dur: 0.7, vol: 0.12, spread: 0.07 });
                      this.air(0.6, 0.07, 1400, 4200, 0.04, 'bandpass', 1.6, 0.5); break;
      case 'special': this.chord([523.25, 659.25, 783.99, 1046.5], { dur: 0.75, vol: 0.12, spread: 0.075 });
                      this.bell(1568, 0.9, 0.1, 0.3); this.air(0.9, 0.08, 1800, 6000, 0.1, 'bandpass', 2, 0.6); break;
      case 'heal':    this.bell(880, 0.75, 0.13); this.bell(1318.5, 0.6, 0.08, 0.12); break;
      case 'coin':    this.bell(1318.5, 0.35, 0.12); this.bell(1975.5, 0.45, 0.1, 0.07); break;
      case 'win':     this.chord([523.25, 659.25, 783.99], { dur: 0.8, vol: 0.13, spread: 0.09 });
                      this.bell(1046.5, 1.1, 0.12, 0.28); break;
      case 'lose':    this.chord([440, 349.23, 277.18], { dur: 0.7, vol: 0.12, spread: 0.13, type: 'sine' }); break;
      case 'ping':    this.bell(1046.5, 0.4, 0.12); this.bell(1396.9, 0.5, 0.09, 0.1); break;
      case 'level':   this.chord([523.25, 659.25, 783.99, 1046.5, 1318.5], { dur: 0.7, vol: 0.12, spread: 0.075 });
                      this.air(0.8, 0.06, 2000, 6500, 0.15, 'bandpass', 2, 0.6); break;
    }
  },
};
// Any tap on a control clicks softly; the first tap also unlocks audio on iOS.
document.addEventListener('pointerdown', (e) => {
  SFX.init();
  const t = e.target.closest('button, .chip, .opt, .swatch, .slot, .item[data-see], [data-quest]');
  if (t && !t.disabled) SFX.play(t.closest('#bt-menu') ? 'tap' : 'tap');
}, true);

// ---------- settings ----------
function openSettings() {
  const p = SFX.prefs;
  openSheet(`
    <h2>⚙️ Settings</h2>
    <div class="set-row">
      <div><b>🔊 Sound effects</b><div class="sub">Hits, shields, coins, taps.</div></div>
      <button class="switch ${p.sfx ? 'on' : ''}" id="sfx-toggle" aria-label="Sound effects"><i></i></button>
    </div>
    <label class="field">Effects volume</label>
    <input class="range" id="sfx-vol" type="range" min="0" max="100" value="${Math.round(p.sfxVol * 100)}" ${p.sfx ? '' : 'disabled'}>
    <div class="set-row" style="margin-top:14px">
      <div><b>🎵 Music<span class="soon">not yet</span></b><div class="sub">No soundtrack in the game yet — this is here for when there is one.</div></div>
      <button class="switch ${p.music ? 'on' : ''}" id="mus-toggle" aria-label="Music"><i></i></button>
    </div>
    <label class="field">Music volume</label>
    <input class="range" id="mus-vol" type="range" min="0" max="100" value="${Math.round(p.musicVol * 100)}" ${p.music ? '' : 'disabled'}>
    <div class="set-row">
      <div><b>🔔 Notifications</b><div class="sub" id="notif-note">Get told when someone wants to talk, battle or party up.</div></div>
      <button class="btn" id="notif-btn" style="flex:none;min-width:0">Enable</button>
    </div>
    <h3>🗺️ Map style</h3>
    <div class="opts">
      <button class="opt ${MAP_PREFS.style === 'tidy' ? 'sel' : ''}" data-map="tidy">Anderune</button>
      <button class="opt ${MAP_PREFS.style === 'classic' ? 'sel' : ''}" data-map="classic">Classic</button>
    </div>
    <p class="sub">Anderune warms the map and hides sidewalk clutter. Classic is the plain street map.</p>
    <div class="btns"><button class="btn" id="sfx-test">▶️ Test sound</button><button class="btn primary" id="set-done">Done</button></div>
    <p class="sub" style="margin-top:12px">build ${BUILD}</p>
  `, 'settings');
  const sfxT = $('#sfx-toggle'), musT = $('#mus-toggle'), sfxV = $('#sfx-vol'), musV = $('#mus-vol');
  sfxT.onclick = () => {
    SFX.prefs.sfx = !SFX.prefs.sfx; SFX.save();
    sfxT.classList.toggle('on', SFX.prefs.sfx); sfxV.disabled = !SFX.prefs.sfx;
    if (SFX.prefs.sfx) SFX.play('tap');
  };
  sfxV.oninput = () => SFX.setVol(+sfxV.value / 100);
  sfxV.onchange = () => SFX.play('coin');
  musT.onclick = () => {
    SFX.prefs.music = !SFX.prefs.music; SFX.save();
    musT.classList.toggle('on', SFX.prefs.music); musV.disabled = !SFX.prefs.music;
    toast('Saved — there\'s no music yet, but it\'ll use this when there is.', null, 3500);
  };
  musV.oninput = () => { SFX.prefs.musicVol = +musV.value / 100; SFX.save(); };
  const nb = $('#notif-btn'), nn = $('#notif-note');
  const paintNotif = () => {
    const st = NOTIFY.state();
    if (!NOTIFY.supported()) { nb.textContent = 'Not supported'; nb.disabled = true; nn.textContent = 'This browser has no notification support.'; return; }
    if (st === 'granted') { nb.textContent = 'On'; nb.disabled = true; nn.textContent = 'Anderune can alert you while it\'s running.'; return; }
    if (st === 'denied') { nb.textContent = 'Blocked'; nb.disabled = true; nn.textContent = 'Turn notifications back on for Anderune in your phone settings.'; return; }
    nb.disabled = false; nb.textContent = 'Enable';
    nn.textContent = NOTIFY.installed()
      ? 'Get told when someone wants to talk, battle or party up.'
      : 'On iPhone, add Anderune to your home screen first (Share → Add to Home Screen), then enable.';
  };
  paintNotif();
  nb.onclick = async () => { await NOTIFY.ask(); paintNotif(); };
  sheetBody.querySelectorAll('[data-map]').forEach((b) => (b.onclick = () => {
    MAP_PREFS.style = b.dataset.map; saveMapPrefs(); applyMapTheme();
    sheetBody.querySelectorAll('[data-map]').forEach((o) => o.classList.toggle('sel', o === b));
  }));
  $('#sfx-test').onclick = () => { SFX.play('special'); setTimeout(() => SFX.play('win'), 500); };
  $('#set-done').onclick = closeSheet;
}

// ---------- bus stops: rest and repair ----------
// Real stops, pulled from OpenStreetMap around wherever you are, cached for a day.
const REST_RADIUS_M = 35;
const REST_COOLDOWN = 4 * 60 * 1000;
let restStops = [], restMarkers = {}, restedAt = {}, lastStopFetch = { t: 0, p: null };

function loadStopCache() {
  try {
    const c = JSON.parse(localStorage.getItem('qm_stops') || 'null');
    if (c && Date.now() - c.t < 24 * 3600 * 1000) { restStops = c.stops || []; return true; }
  } catch {}
  return false;
}
async function fetchStops(force) {
  if (!myPos || !inRegion(myPos)) return;
  if (!force && lastStopFetch.p && distM(lastStopFetch.p, myPos) < 1200 && Date.now() - lastStopFetch.t < 6 * 3600 * 1000) return;
  lastStopFetch = { t: Date.now(), p: { ...myPos } };
  const q = `[out:json][timeout:20];(node["highway"="bus_stop"](around:2000,${myPos.lat},${myPos.lng});` +
            `node["public_transport"="platform"]["bus"="yes"](around:2000,${myPos.lat},${myPos.lng}););out body 120;`;
  // the main Overpass server is often busy, so fall through a few mirrors
  const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter', 'https://overpass.osm.ch/api/interpreter'];
  try {
    let data = null;
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
        if (!res.ok) continue;
        data = await res.json();
        if (data) break;
      } catch (e) { /* try the next mirror */ }
    }
    if (!data) throw new Error('no overpass mirror answered');
    const seen = new Set();
    restStops = (data.elements || []).filter((e) => e.lat && e.lon).map((e) => ({
      id: 's' + e.id, lat: e.lat, lng: e.lon, name: (e.tags && (e.tags.name || e.tags.ref)) || 'Bus stop',
    })).filter((s) => { const k = s.lat.toFixed(5) + s.lng.toFixed(5); if (seen.has(k)) return false; seen.add(k); return true; });
    try { localStorage.setItem('qm_stops', JSON.stringify({ t: Date.now(), stops: restStops })); } catch {}
    renderStops();
  } catch (e) { console.warn('bus stops unavailable', e); }
}
function renderStops() {
  if (!myPos) return;
  // only the handful you could actually walk to, or the map turns into a wall of signs
  const near = restStops
    .filter((s) => distM(myPos, s) < 700)
    .sort((a, b) => distM(myPos, a) - distM(myPos, b))
    .slice(0, 10);
  near.forEach((s) => {
    if (restMarkers[s.id]) return;
    restMarkers[s.id] = marker(`<div class="mk mk-rest"><span class="rest-bus">🚏</span><span class="rest-cross">✚</span></div>`,
      s, { onClick: () => openRest(s) });
  });
  Object.keys(restMarkers).forEach((id) => {
    if (near.some((s) => s.id === id)) return;
    restMarkers[id].remove(); delete restMarkers[id];
  });
}
function openRest(s) {
  const d = distM(myPos, s), here = d <= REST_RADIUS_M;
  const cool = Math.max(0, (restedAt[s.id] || 0) + REST_COOLDOWN - Date.now());
  const full = S.hp >= maxHp();
  openSheet(`
    <div class="row"><div style="font-size:42px">🚏</div>
      <div><h2>${esc(s.name)}</h2>
      <span class="pill ${here ? 'ok' : 'far'}">${here ? 'You are here' : fmtDist(d) + ' away'}</span>
      <span class="pill">✚ Rest stop</span></div></div>
    <p>Sit down on the bench a minute. Resting here patches you all the way up.</p>
    <p class="sub">HP ${S.hp}/${maxHp()}${cool ? ` · rested recently, ready again in ${Math.ceil(cool / 60000)} min` : ''}</p>
    <div class="btns">
      <button class="btn primary" id="rest" ${here && !cool && !full ? '' : 'disabled'}>✚ ${full ? 'Already full' : 'Rest and repair'}</button>
      <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=walking">Directions</a>
    </div>
    ${here ? '' : '<p class="sub">Walk to the stop to rest.</p>'}
  `, 'rest', () => openRest(s));
  const r = $('#rest');
  if (r) r.onclick = () => {
    if (distM(myPos, s) > REST_RADIUS_M) return;
    restedAt[s.id] = Date.now();
    upd({ hp: maxHp() });
    SFX.play('heal');
    toast(`✚ Rested at ${esc(s.name)} — back to ${maxHp()}/${maxHp()} HP.`, null, 4000);
    closeSheet();
  };
}
const restNudged = new Set();
function checkRest() {
  if (!S || sheetKind || inBattle || S.hp >= maxHp()) return;
  const s = restStops.find((x) => distM(myPos, x) <= REST_RADIUS_M && !restNudged.has(x.id));
  if (!s) return;
  restNudged.add(s.id);
  toast(`🚏 A rest stop — patch yourself up here?`, [['✚ Rest', 'primary', () => openRest(s)], ['Later', '', null]], 8000);
}

// ---------- mining minigame ----------
// A Queens-style puzzle: one crown per row, column and colour, none touching.
// Generated from a known solution, so every seam can actually be cracked.
function makeMine(n) {
  const cols = [...Array(n).keys()];
  let sol = null;
  for (let tries = 0; tries < 800 && !sol; tries++) {
    const p = cols.slice();
    for (let i = p.length - 1; i > 0; i--) { const j = randi(0, i); [p[i], p[j]] = [p[j], p[i]]; }
    if (p.every((c, r) => r === 0 || Math.abs(c - p[r - 1]) > 1)) sol = p;
  }
  if (!sol) sol = cols.slice();                        // vanishingly rare; still solvable-ish
  // grow a colour region out from each crown until the board is covered
  const region = Array.from({ length: n }, () => Array(n).fill(-1));
  const frontier = sol.map((c, r) => { region[r][c] = r; return [[r, c]]; });
  let left = n * n - n;
  while (left > 0) {
    let moved = false;
    for (let g = 0; g < n && left > 0; g++) {
      const f = frontier[g];
      for (let attempt = 0; attempt < 6 && f.length; attempt++) {
        const [r, c] = f[randi(0, f.length - 1)];
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5);
        const step = dirs.find(([dr, dc]) => {
          const nr = r + dr, nc = c + dc;
          return nr >= 0 && nc >= 0 && nr < n && nc < n && region[nr][nc] === -1;
        });
        if (step) { const nr = r + step[0], nc = c + step[1]; region[nr][nc] = g; f.push([nr, nc]); left--; moved = true; break; }
      }
    }
    if (!moved) {   // stranded cell — hand it to any neighbour that has a colour
      outer: for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (region[r][c] !== -1) continue;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nc >= 0 && nr < n && nc < n && region[nr][nc] !== -1) { region[r][c] = region[nr][nc]; left--; break outer; }
        }
      }
    }
  }
  return { n, region, sol };
}
let mine = null;
const mineReady = () => Date.now() >= ((S && S.mineAt) || 0) + MINE_COOLDOWN;
function openMine(fresh) {
  if (fresh || !mine) mine = { ...makeMine(MINE_SIZE), cells: Array(MINE_SIZE * MINE_SIZE).fill(0), done: false, paid: !mineReady() };
  drawMine();
}
function mineProblems() {
  const { n, region, cells } = mine, crowns = [];
  cells.forEach((v, i) => { if (v === 2) crowns.push([Math.floor(i / n), i % n]); });
  const bad = new Set();
  crowns.forEach(([r, c], i) => crowns.forEach(([r2, c2], j) => {
    if (i === j) return;
    if (r === r2 || c === c2 || region[r][c] === region[r2][c2] || (Math.abs(r - r2) <= 1 && Math.abs(c - c2) <= 1)) {
      bad.add(r * n + c); bad.add(r2 * n + c2);
    }
  }));
  return { crowns, bad, solved: crowns.length === n && bad.size === 0 };
}
function drawMine() {
  const { n, region, cells } = mine;
  const { crowns, bad, solved } = mineProblems();
  const ready = mineReady();
  const wait = Math.ceil((((S && S.mineAt) || 0) + MINE_COOLDOWN - Date.now()) / 60000);
  openSheet(`
    <h2>⛏️ Mine a seam</h2>
    <p class="sub">One crown in every row, column and colour — and no two crowns touching, even corner to corner. Tap once to mark a dead cell, twice for a crown.</p>
    <div class="mine" style="grid-template-columns:repeat(${n},1fr)">
      ${cells.map((v, i) => {
        const r = Math.floor(i / n), c = i % n;
        return `<button class="mine-cell ${bad.has(i) ? 'bad' : ''}" data-cell="${i}"
          style="background:${MINE_COLORS[region[r][c] % MINE_COLORS.length]}">${v === 2 ? '👑' : v === 1 ? '·' : ''}</button>`;
      }).join('')}
    </div>
    <p class="${solved ? 'mine-win' : 'sub'}">${solved ? '💎 Seam cracked!' : `${crowns.length}/${n} crowns placed${bad.size ? ' — some are fighting' : ''}`}</p>
    ${mine.done ? `<p class="sub">Paid out. Next seam ${ready ? 'ready now' : `in ${wait} min`}.</p>` : ''}
    <div class="btns">
      <button class="btn" id="mine-clear">Clear</button>
      <button class="btn primary" id="mine-new">${mine.done ? 'Dig another' : 'New seam'}</button>
    </div>
    <p class="sub">Each cracked seam pays ${MINE_COINS[0]}–${MINE_COINS[1]} coins and ${MINE_SP} of a stat point${ready ? '' : ` — the next paying seam is in ${wait} min, but you can keep practising`}.</p>
  `, 'mine');
  sheetBody.querySelectorAll('[data-cell]').forEach((b) => (b.onclick = () => {
    if (mine.done) return;
    const i = +b.dataset.cell;
    mine.cells[i] = (mine.cells[i] + 1) % 3;
    SFX.play('tap');
    const after = mineProblems();
    if (after.solved) finishMine();
    else drawMine();
  }));
  $('#mine-clear').onclick = () => { mine.cells = Array(n * n).fill(0); mine.done = false; drawMine(); };
  $('#mine-new').onclick = () => openMine(true);
}
function finishMine() {
  mine.done = true;
  const paying = mineReady() && !mine.paid;
  if (paying) {
    const coins = randi(MINE_COINS[0], MINE_COINS[1]);
    const frac = ((S.spFrac || 0) + MINE_SP);
    const whole = Math.floor(frac);
    upd({ coins: B.inc(coins), spFrac: +(frac - whole).toFixed(2), mineAt: Date.now(), ...(whole ? { sp: (S.sp || 0) + whole } : {}) });
    SFX.play('coin'); setTimeout(() => SFX.play('win'), 220);
    toast(`💎 Seam cracked! +${coins} coins and +${MINE_SP} SP${whole ? ` — that's a whole stat point!` : ` (${Math.round(((S.spFrac || 0)) * 100)}% toward the next point)`}`, null, 6000);
  } else {
    SFX.play('win');
    toast('💎 Solved! No payout on a practice seam.', null, 4000);
  }
  drawMine();
}
