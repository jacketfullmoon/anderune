/* Quest — real-world location LARP. Multiplayer via backend.js (Firebase). */

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

// ---------- backend + state ----------
const B = Backend;
const COL = { names: 'qm_usernames', players: 'qm_players', req: 'qm_requests', battles: 'qm_battles', chats: 'qm_chats' };
let ME = null;       // my uid
let S = null;        // my player doc
let others = {};     // uid -> other player docs
let myPos = null;
let realGps = false;
let unsubs = [];

const newPlayer = (name) => ({
  name, look: { skin: '#f1c27d', hair: 'short', hairColor: '#4a2a12', shirt: '#3b82f6' },
  equipped: { hat: null, face: null, neck: null }, bag: { potion: 2 },
  coins: 120, hp: 34, lvl: 5, xp: 0, claimed: [], friends: [],
  photo: null, lat: null, lng: null, seen: Date.now(), created: Date.now(),
});
function gear(p, k) { return Object.values(p.equipped || {}).reduce((t, id) => t + ((id && ITEMS[id] && ITEMS[id][k]) || 0), 0); }
const statsFor = (p) => ({ atk: 5 + Math.floor(p.lvl / 2) + gear(p, 'atk'), def: 1 + Math.floor(p.lvl / 3) + gear(p, 'def'), max: 24 + p.lvl * 2, lvl: p.lvl });
const maxHp = () => 24 + S.lvl * 2;
const count = (id, p = S) => (p && p.bag && p.bag[id]) || 0;
const isFriend = (uid) => !!(S && S.friends && S.friends.includes(uid));
const myAvatar = () => portrait(S);
const avatarOf = (p) => portrait(p);

// Apply locally right away, then save.
function upd(patch) { applyPatch(S, patch); onMyChange(); return B.update(COL.players, ME, patch).catch((e) => console.warn(e)); }

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView([START.lat, START.lng], 15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

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
  return p && p.photo ? `<img class="pic" src="${p.photo}" alt="">` : avatarSVG((p && p.look) || {}, (p && p.equipped) || {});
}
function trailLayer(uid, p, opts) {
  const g = L.layerGroup();
  const col = opts.me ? { solid: '#2f6fff', light: '#5b8dff' } : colorFor(uid);
  const pts = (p.trail || []).slice(-8);
  const path = pts.concat([{ lat: p.lat, lng: p.lng }]);
  for (let i = 0; i < pts.length; i++) {
    const op = (0.22 + 0.6 * (i / Math.max(1, pts.length - 1))).toFixed(2);
    const rot = bearing(path[i], path[i + 1]).toFixed(0);
    g.addLayer(L.marker([pts[i].lat, pts[i].lng], { interactive: false, zIndexOffset: -500,
      icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11],
        html: `<div class="foot" style="opacity:${op};transform:rotate(${rot}deg)">👣</div>` }) }));
  }
  g.addLayer(L.marker([p.lat, p.lng], { draggable: !!opts.draggable, zIndexOffset: opts.me ? 1000 : 500,
    icon: L.divIcon({ className: '', iconSize: [46, 46], iconAnchor: [23, 23],
      html: `<div class="mk ${opts.me ? 'mk-me' : ''} ${opts.friend ? 'mk-friend' : ''}" style="--c:${col.solid};--cl:${col.light}">
        <div class="mk-avatar">${portrait(p)}</div><div class="mk-label">${esc(p.name)}</div></div>` }) }));
  return g;
}

// Dark map after 7pm, back to daylight at 6am.
function updateNight() {
  const h = new Date().getHours();
  document.body.classList.toggle('night', h >= 19 || h < 6);
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
  meLayer = trailLayer(ME, p, { me: true, draggable: !realGps }).addTo(map);
  const head = meLayer.getLayers()[meLayer.getLayers().length - 1];
  head.on('click', openProfile);
  if (!realGps) head.on('dragend', () => { const q = head.getLatLng(); setPos({ lat: q.lat, lng: q.lng }, false); });
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
  pushPos(false);
  renderMe();
  if (pan) map.panTo([p.lat, p.lng]);
  checkProximity();
}

// treasures & shops
const treasureMarkers = {};
function chestIcon(t) {
  const claimed = S && (S.claimed || []).includes(t.id);
  return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mk-poi chest ${claimed ? 'claimed' : ''}">${CHEST_SVG}</div>` });
}
TREASURES.forEach((t) => { treasureMarkers[t.id] = L.marker([t.lat, t.lng], { icon: chestIcon(t) }).addTo(map).on('click', () => openTreasure(t)); });
let claimedKey = '';
function renderChests() {
  const k = (S.claimed || []).join();
  if (k === claimedKey) return; claimedKey = k;
  TREASURES.forEach((t) => treasureMarkers[t.id].setIcon(chestIcon(t)));
}
SHOPS.forEach((s) => {
  L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', iconSize: [36, 36], iconAnchor: [18, 18], html: `<div class="mk-poi">${s.ico}</div>` }) })
    .addTo(map).on('click', () => openShop(s));
});

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
    const layer = trailLayer(uid, p, { friend: isFriend(uid) }).addTo(map);
    layer.getLayers().forEach((l) => l.on('click', () => openPlayer(uid)));
    playerMarkers[uid] = { layer, key };
  }
  for (const uid of Object.keys(playerMarkers)) if (!others[uid]) { playerMarkers[uid].layer.remove(); delete playerMarkers[uid]; }
}
setInterval(() => ME && renderOthers(), 30000);

// ---------- GPS ----------
const locStatus = $('#loc-status');
let watchId = null;
function setStatus(txt) { locStatus.textContent = txt; locStatus.classList.toggle('hidden', !txt); }
function startGps(fromTap) {
  if (!navigator.geolocation || !window.isSecureContext) { setStatus('📍 Location unavailable — drag yourself to move'); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  setStatus('Finding you…');
  watchId = navigator.geolocation.watchPosition((p) => {
    const first = !realGps;
    realGps = true; setStatus('');
    setPos({ lat: p.coords.latitude, lng: p.coords.longitude }, first);
    if (first) map.setView([p.coords.latitude, p.coords.longitude], 16);
  }, (e) => {
    if (realGps && e.code !== e.PERMISSION_DENIED) return;
    navigator.geolocation.clearWatch(watchId); watchId = null;
    realGps = false; renderMe();
    setStatus('📍 Location off — drag yourself to move');
    if (e.code === e.PERMISSION_DENIED) {
      if (fromTap) showLocationHelp();
      else toast('📍 Location is blocked, so others can\'t see where you really are.', [['How to fix', 'primary', showLocationHelp], ['Later', '', null]]);
    } else if (fromTap) toast(e.code === e.TIMEOUT ? 'Location timed out. Try again outside.' : "Couldn't find your location.");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
$('#locate-btn').onclick = () => { if (realGps && myPos) map.setView([myPos.lat, myPos.lng], 16); else startGps(true); };
function showLocationHelp() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  openSheet(`
    <h2>📍 Location is blocked</h2>
    <p>Your ${ios ? 'iPhone' : 'browser'} is blocking this site from using your location. To turn it on:</p>
    ${ios ? `<ol style="padding-left:20px;line-height:1.6;font-size:14px;margin:0 0 12px">
      <li><b>Settings → Privacy &amp; Security → Location Services</b>: make sure it's <b>On</b>.</li>
      <li>On that same screen, scroll to <b>Safari Websites</b> (or <b>Chrome</b>) → <b>While Using the App</b>, and turn on <b>Precise Location</b>.</li>
      <li>In Safari, tap the <b>page menu</b> icon next to the address bar → <b>Website Settings</b> → <b>Location</b> → <b>Allow</b>.</li>
      <li>Reload this page.</li></ol>`
    : `<p>Click the icon next to the address bar, set <b>Location</b> to <b>Allow</b>, then reload.</p>`}
    <div class="btns"><button class="btn primary" id="reload">Reload page</button><button class="btn" id="stay">Not now</button></div>
  `, 'lochelp');
  $('#reload').onclick = () => location.reload();
  $('#stay').onclick = closeSheet;
}

// ---------- HUD ----------
function renderHud() {
  $('#btn-profile').innerHTML = myAvatar();
  $('#hud-coins').textContent = S.coins;
  const pct = Math.max(0, Math.min(100, S.hp / maxHp() * 100));
  $('#hud-hp').style.width = pct + '%';
  $('#hud-hp').style.background = pct < 25 ? '#ef4444' : pct < 50 ? '#f5b82e' : '';
}
$('#btn-profile').onclick = openProfile;
$('#btn-bag').onclick = openBag;
$('#btn-friends').onclick = openFriends;
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
  sheet.scrollTop = same ? y : 0;
}
function closeSheet() {
  sheet.classList.add('hidden'); backdrop.classList.add('hidden');
  sheetKind = null; sheetRefresh = null; sheetBody.dataset.kind = '';
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
}
backdrop.onclick = closeSheet;

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

  if (B.mode === 'unconfigured') { modal.classList.add('hidden'); $('#setup-modal').classList.remove('hidden'); return; }
  B.onAuth((uid) => {
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
      ['#side-btns', '#stat-pill', '#locate-btn'].forEach((s) => $(s).classList.remove('hidden'));
      myPos = S.lat != null ? { lat: S.lat, lng: S.lng } : { lat: START.lat, lng: START.lng };
      myTrail = Array.isArray(S.trail) ? S.trail : [];
      renderMe(); map.setView([myPos.lat, myPos.lng], 16);
      pushPos(true);
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
}
function endSession() {
  unsubs.forEach((u) => u && u()); unsubs = [];
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; ME = null; S = null; others = {}; realGps = false; incoming = [];
  Object.values(playerMarkers).forEach((m) => m.layer.remove());
  for (const k in playerMarkers) delete playerMarkers[k];
  if (meLayer) { meLayer.remove(); meLayer = null; meKey = ''; }
  myTrail = [];
  ['#side-btns', '#stat-pill', '#locate-btn'].forEach((s) => $(s).classList.add('hidden'));
  Object.values(reqToasts).forEach((el) => el.remove());
  setStatus(''); closeSheet();
}
let leveling = false;
function onMyChange() {
  if (!S) return;
  // Keep data tidy: level up at 100 XP, unequip items you no longer own.
  if (S.xp >= 100 && !leveling) {
    leveling = true; const lv = S.lvl + Math.floor(S.xp / 100);
    toast(`⭐ Level up! You're now Lv${lv}.`);
    upd({ xp: S.xp % 100, lvl: lv, hp: 24 + lv * 2 }); leveling = false;
  }
  for (const [slot, id] of Object.entries(S.equipped || {})) if (id && count(id) <= 0) upd({ ['equipped.' + slot]: null });
  renderHud(); renderMe(); renderChests();
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
  closeSheet();
  upd({ claimed: B.union(t.id), ['bag.' + t.item]: B.inc(1), coins: B.inc(t.coins), xp: B.inc(40) });
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
    map.flyTo([t.lat, t.lng], 15); closeSheet(); return;
  }
  if (S.hp >= maxHp()) return toast('HP is already full.');
  upd({ hp: Math.min(maxHp(), S.hp + it.heal), ['bag.' + id]: B.inc(-1) });
  toast(`${it.ico} +${it.heal} HP`, null, 2000);
}

// ---------- profile / character creator ----------
// Shrink an uploaded photo to a small square so it fits in the database and loads fast.
function pickPhoto() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 128, c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        let data = c.toDataURL('image/jpeg', 0.75);
        if (data.length > 200000) data = c.toDataURL('image/jpeg', 0.5);
        upd({ photo: data });
        toast('📸 Photo set as your icon', null, 2500);
        openProfile();
      };
      img.onerror = () => toast("Couldn't read that image.");
      img.src = reader.result;
    };
    reader.onerror = () => toast("Couldn't read that file.");
    reader.readAsDataURL(file);
  };
  input.click();
}

function openProfile() {
  if (!S) return;
  const opt = (key, vals, swatch) => vals.map((v) => swatch
    ? `<button class="swatch ${S.look[key] === v ? 'sel' : ''}" style="background:${v}" data-k="${key}" data-v="${v}" aria-label="${v}"></button>`
    : `<button class="opt ${S.look[key] === v ? 'sel' : ''}" data-k="${key}" data-v="${v}">${v}</button>`).join('');
  const gearOpts = ['hat', 'face', 'neck'].map((slot) => {
    const owned = Object.keys(S.bag || {}).filter((id) => ITEMS[id] && ITEMS[id].slot === slot && count(id) > 0);
    return `<button class="opt ${!S.equipped[slot] ? 'sel' : ''}" data-slot="${slot}" data-item="">No ${slot}</button>` +
      owned.map((id) => `<button class="opt ${S.equipped[slot] === id ? 'sel' : ''}" data-slot="${slot}" data-item="${id}">${ITEMS[id].ico} ${esc(ITEMS[id].name)}</button>`).join('');
  }).join('');
  const st = statsFor(S);
  openSheet(`
    <div class="row">
      <div class="big-avatar">${myAvatar()}</div>
      <div><h2>${esc(S.name)}</h2>
        <div class="sub">Lv${S.lvl} · XP ${S.xp}/100</div>
        <div class="sub">HP ${S.hp}/${st.max} · ATK ${st.atk} · DEF ${st.def}</div>
        <div class="sub">🪙 ${S.coins} · 🤝 ${(S.friends || []).length} friends</div></div>
    </div>
    <label class="field">Icon</label>
    <div class="photo-row">
      <button class="btn" id="photo-btn">📸 ${S.photo ? 'Change photo' : 'Use a photo'}</button>
      ${S.photo ? '<button class="btn" id="photo-clear">Use my character</button>' : ''}
    </div>
    <p class="sub" style="margin-top:8px">${S.photo ? 'Your photo is your map icon and battle portrait. Everyone playing can see it.' : 'Or build a character below.'}</p>
    <label class="field">Skin</label><div class="opts">${opt('skin', AVATAR_OPTIONS.skin, true)}</div>
    <label class="field">Hair</label><div class="opts">${opt('hair', AVATAR_OPTIONS.hair)}</div>
    <label class="field">Hair color</label><div class="opts">${opt('hairColor', AVATAR_OPTIONS.hairColor, true)}</div>
    <label class="field">Outfit</label><div class="opts">${opt('shirt', AVATAR_OPTIONS.shirt, true)}</div>
    <label class="field">Gear (from treasures &amp; shops)</label><div class="opts">${gearOpts}</div>
    <div class="btns"><button class="btn primary" id="done">Done</button></div>
    <div class="btns"><button class="btn" id="logout">Log out</button></div>
  `, 'profile');
  sheetBody.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { upd({ ['look.' + b.dataset.k]: b.dataset.v }); openProfile(); }));
  sheetBody.querySelectorAll('[data-slot]').forEach((b) => (b.onclick = () => { upd({ ['equipped.' + b.dataset.slot]: b.dataset.item || null }); openProfile(); }));
  $('#photo-btn').onclick = pickPhoto;
  const pc = $('#photo-clear'); if (pc) pc.onclick = () => { upd({ photo: null }); openProfile(); };
  $('#done').onclick = closeSheet;
  $('#logout').onclick = () => { closeSheet(); B.logOut(); };
}

// ---------- players & friends ----------
const online = (p) => p.lat != null && Date.now() - (p.seen || 0) < ONLINE_WINDOW_MS;
function openPlayer(uid) {
  const p = others[uid]; if (!p) return;
  const d = online(p) && myPos ? distM(myPos, p) : Infinity, near = d <= NEARBY_RADIUS_M, friend = isFriend(uid);
  const pendingFriend = incoming.find((r) => r.from === uid && r.kind === 'friend' && r.status === 'pending');
  openSheet(`
    <div class="row"><div class="big-avatar" style="width:90px;height:90px">${avatarOf(p)}</div>
      <div><h2>${esc(p.name)}</h2><div class="sub">Lv${p.lvl} · ${online(p) ? fmtDist(d) + ' away' : 'last seen ' + ago(p.seen || 0)}</div>
      <div style="margin-top:6px">${friend ? '<span class="pill ok">Friend</span>' : ''}<span class="pill ${near ? 'ok' : 'far'}">${near ? 'Nearby' : online(p) ? 'Too far to battle' : 'Offline'}</span></div></div></div>
    <p>${near ? 'Send a request. They choose whether to accept.' : friend ? `Friends can chat from anywhere. Get within ${NEARBY_RADIUS_M} m to battle.` : `Get within ${NEARBY_RADIUS_M} m to battle or talk.`}</p>
    <div class="btns">
      <button class="btn primary" id="rq-battle" ${near ? '' : 'disabled'}>⚔️ Battle?</button>
      <button class="btn blue" id="rq-talk" ${near || friend ? '' : 'disabled'}>💬 Talk?</button>
    </div>
    ${friend ? '' : pendingFriend ? '<div class="btns"><button class="btn" id="acc-friend">🤝 Accept friend request</button></div>'
      : '<div class="btns"><button class="btn" id="rq-friend">🤝 Add friend</button></div>'}
  `, 'player', () => openPlayer(uid));
  $('#rq-battle').onclick = () => sendRequest(uid, 'battle');
  $('#rq-talk').onclick = () => sendRequest(uid, 'talk');
  const f = $('#rq-friend'); if (f) f.onclick = () => sendRequest(uid, 'friend');
  const a = $('#acc-friend'); if (a) a.onclick = () => { closeSheet(); acceptRequest(pendingFriend); };
}
function openFriends() {
  const row = (p) => {
    const on = online(p), d = on && myPos ? distM(myPos, p) : null;
    return `<div class="item" data-see="${p.id}"><div class="mini">${avatarOf(p)}</div><div class="grow"><b>${esc(p.name)}</b>
      <span class="sub">Lv${p.lvl} · ${on ? '🟢 ' + fmtDist(d) : '⚪ ' + ago(p.seen || 0)}</span></div><button class="btn">View</button></div>`;
  };
  const all = Object.values(others);
  const friends = all.filter((p) => isFriend(p.id)).sort((a, b) => (b.seen || 0) - (a.seen || 0));
  const nearby = all.filter((p) => !isFriend(p.id) && online(p)).sort((a, b) => distM(myPos, a) - distM(myPos, b));
  const reqs = incoming.filter((r) => r.kind === 'friend' && r.status === 'pending');
  openSheet(`
    ${reqs.length ? `<h2>📨 Friend requests</h2><div class="list">${reqs.map((r) => `
      <div class="item"><div class="mini">${others[r.from] ? avatarOf(others[r.from]) : ''}</div><div class="grow"><b>${esc(r.fromName)}</b><span class="sub">wants to be friends</span></div>
      <button class="btn primary" data-acc="${r.id}">Accept</button><button class="btn" data-dec="${r.id}">✕</button></div>`).join('')}</div>` : ''}
    <h2>🤝 Friends</h2>
    ${friends.length ? `<div class="list">${friends.map(row).join('')}</div>` : '<div class="empty">No friends yet. Tap a player on the map and add them.</div>'}
    <h3>📡 Players online</h3>
    ${nearby.length ? `<div class="list">${nearby.map(row).join('')}</div>` : '<div class="empty">Nobody else is online right now. Send your friends the link!</div>'}
    <div class="btns"><button class="btn blue" id="share">🔗 Invite friends</button></div>
  `, 'friends', openFriends);
  sheetBody.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => { const p = others[b.dataset.see]; if (online(p)) map.panTo([p.lat, p.lng]); openPlayer(p.id); }));
  sheetBody.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => acceptRequest(incoming.find((r) => r.id === b.dataset.acc))));
  sheetBody.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => B.update(COL.req, b.dataset.dec, { status: 'declined' })));
  $('#share').onclick = async () => {
    const url = location.origin;
    try { if (navigator.share) await navigator.share({ title: 'Quest', text: 'Play Quest with me: make a character and find treasure around LA!', url }); else { await navigator.clipboard.writeText(url); toast('Link copied!', null, 2000); } } catch {}
  };
}

// ---------- requests ----------
const KIND = { battle: ['⚔️', 'battle'], talk: ['💬', 'talk'], friend: ['🤝', 'be friends'], trade: ['🔁', 'trade'] };
async function sendRequest(uid, kind, extra = {}) {
  const p = others[uid]; if (!p) return;
  if (kind === 'battle' && S.hp < 6) return toast('You\'re too hurt to battle. Drink something from your bag first.');
  if (!(kind === 'trade' && sheetKind === 'talk')) closeSheet();
  const id = await B.add(COL.req, { from: ME, fromName: S.name, to: uid, toName: p.name, kind, status: 'pending', created: Date.now(), ...extra });
  if (kind === 'friend') toast(`🤝 Friend request sent to ${esc(p.name)}`, null, 2500);
  const w = kind === 'friend' ? null : toast(`${KIND[kind][0]} Asked <b>${esc(p.name)}</b> to ${KIND[kind][1]}… waiting`, [['Cancel', '', () => B.update(COL.req, id, { status: 'cancelled' })]], 0);
  const timer = kind === 'friend' ? null : setTimeout(() => B.update(COL.req, id, { status: 'expired' }).catch(() => {}), 60000);
  let un = null, done = false;
  un = B.watchDoc(COL.req, id, (r) => {
    if (!r || r.status === 'pending' || done) return;
    done = true; setTimeout(() => un && un(), 0); clearTimeout(timer); w && w.remove();
    if (r.status === 'accepted') {
      if (kind === 'battle') openBattle(r.battleId);
      else if (kind === 'talk') openTalk(uid);
      else if (kind === 'friend') toast(`🤝 ${esc(p.name)} accepted your friend request!`);
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
  $('#friends-dot').classList.toggle('hidden', !pending.some((r) => r.kind === 'friend'));
  for (const [id, el] of Object.entries(reqToasts)) if (!pending.some((r) => r.id === id)) { el.remove(); delete reqToasts[id]; }
  pending.forEach((r) => {
    if (reqToasts[r.id] || r.shown) return;
    if (r.kind !== 'friend' && Date.now() - r.created > 90000) return;
    if (inBattle && r.kind === 'battle') return;
    const from = esc(r.fromName);
    const msg = r.kind === 'trade'
      ? `🔁 <b>${from}</b> offers ${ITEMS[r.give].ico} ${esc(ITEMS[r.give].name)} for your ${ITEMS[r.want].ico} ${esc(ITEMS[r.want].name)}`
      : r.kind === 'friend' ? `🤝 <b>${from}</b> sent you a friend request` : `${KIND[r.kind][0]} <b>${from}</b> wants to ${KIND[r.kind][1]}!`;
    reqToasts[r.id] = toast(msg, [['Accept', 'primary', () => { delete reqToasts[r.id]; acceptRequest(r); }],
      ['Decline', '', () => { delete reqToasts[r.id]; B.update(COL.req, r.id, { status: 'declined' }); }]], 0);
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

// ---------- battle ----------
let inBattle = false, battleId = null, battleUnsub = null, curB = null, shownSeq = 0, animChain = Promise.resolve(), animating = false, waitTimer = null, acting = false;
const bt = { text: $('#bt-text'), menu: $('#bt-menu') };
async function createBattle(oppId, opp) {
  const so = statsFor(opp), sm = statsFor(S), first = Math.random() < 0.5 ? oppId : ME;
  return B.add(COL.battles, {
    p: [oppId, ME], status: 'active', created: Date.now(), updated: Date.now(),
    names: { [oppId]: opp.name, [ME]: S.name },
    looks: { [oppId]: { look: opp.look, equipped: opp.equipped, photo: opp.photo || null }, [ME]: { look: S.look, equipped: S.equipped, photo: S.photo || null } },
    st: { [oppId]: so, [ME]: sm },
    hp: { [oppId]: Math.max(1, Math.min(opp.hp, so.max)), [ME]: Math.min(S.hp, sm.max) },
    def: { [oppId]: false, [ME]: false },
    turn: first, truce: null, seq: 1, fx: null, result: null,
    lines: [`${S.name} accepted ${opp.name}'s challenge!`, `${first === ME ? S.name : opp.name} goes first.`],
  });
}
function openBattle(id) {
  closeSheet();
  if (battleId && battleId !== id) exitBattle();
  inBattle = true; battleId = id; curB = null; shownSeq = 0; animChain = Promise.resolve();
  ['#bt-enemy-sprite', '#bt-me-sprite'].forEach((s) => ($(s).className = 'bt-sprite'));
  bt.text.textContent = 'Loading battle…'; bt.menu.innerHTML = '';
  $('#battle').classList.remove('hidden');
  battleUnsub = B.watchDoc(COL.battles, id, onBattle);
}
function exitBattle() {
  battleUnsub && battleUnsub(); battleUnsub = null; clearTimeout(waitTimer);
  $('#battle').classList.add('hidden'); inBattle = false; battleId = null; curB = null;
}
const oppOf = (b) => b.p.find((x) => x !== ME);
function onBattle(b) {
  if (!b) return;
  const first = !curB; curB = b;
  const o = oppOf(b);
  if (first) {
    $('#bt-enemy-name').textContent = b.names[o]; $('#bt-enemy-lv').textContent = 'Lv' + b.st[o].lvl;
    $('#bt-me-name').textContent = b.names[ME]; $('#bt-me-lv').textContent = 'Lv' + b.st[ME].lvl;
    $('#bt-enemy-sprite').innerHTML = portrait(b.looks[o]);
    $('#bt-me-sprite').innerHTML = portrait(b.looks[ME]);
    if (!b.looks[ME].photo) $('#bt-me-sprite').firstElementChild.style.transform = 'scaleX(-1)';
    renderBars(b);
  }
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
      if (snap.status === 'done' && snap.result && snap.result.loser) $(snap.result.loser === ME ? '#bt-me-sprite' : '#bt-enemy-sprite').classList.add('faint');
      animating = false; showMenu();
    });
  } else if (!animating) showMenu();
}
async function say(msg) {
  bt.text.textContent = '';
  for (const ch of msg) { bt.text.textContent += ch; await sleep(16); }
  await sleep(700);
}
function applyFx(fx) {
  if (!fx) return;
  const el = $(fx.t === ME ? '#bt-me-sprite' : '#bt-enemy-sprite');
  const cls = fx.k === 'hit' ? (fx.t === ME ? 'shake' : 'flash') : 'heal';
  el.classList.remove('shake', 'flash', 'heal'); void el.offsetWidth; el.classList.add(cls);
}
function renderBars(b) {
  const o = oppOf(b);
  const set = (el, cur, max) => { const pct = Math.max(0, cur / max * 100); el.style.width = pct + '%'; el.className = pct < 25 ? 'low' : pct < 50 ? 'mid' : ''; };
  set($('#bt-enemy-hp'), b.hp[o], b.st[o].max); set($('#bt-me-hp'), b.hp[ME], b.st[ME].max);
  $('#bt-me-hpnum').textContent = `${Math.max(0, b.hp[ME])}/${b.st[ME].max}`;
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
  const o = oppOf(b);
  if (b.status === 'done') {
    const r = b.result || {};
    bt.text.textContent = r.winner === ME ? '🏆 You won!' : r.loser === ME || (r.how === 'paid' && r.winner !== ME) ? 'You lost this one…' : r.how === 'truce' ? '🤝 Called it a draw.' : 'The battle is over.';
    return menu([['Back to map', exitBattle, 'b-blue']], true);
  }
  if (b.turn !== ME) {
    bt.text.textContent = `Waiting for ${b.names[o]}…`; bt.menu.innerHTML = '';
    waitTimer = setTimeout(() => menu([['🚪 Leave battle', () => act('leave'), 'b-gray']], true), 45000);
    return;
  }
  if (b.truce && b.truce !== ME) {
    bt.text.textContent = `${b.names[o]} offers a truce. End the battle?`;
    return menu([['🤝 Accept', () => act('truce-yes'), 'b-green'], ['✊ Refuse', () => act('truce-no'), 'b-red']]);
  }
  bt.text.textContent = `What will ${b.names[ME]} do?`;
  menu([['⚔️ Attack', () => act('attack'), 'b-red'], ['🛡️ Defend', () => act('defend'), 'b-blue'], ['✨ Act', actMenu, 'b-gold'], ['🏃 Run', () => act('run'), 'b-gray']]);
}
function actMenu() {
  const heal = ['bigpotion', 'potion', 'sunscreen'].find((id) => count(id) > 0);
  bt.text.textContent = 'Act how?';
  menu([
    ['🤝 Truce', () => act('truce'), 'b-green'],
    ['💖 Praise', () => act('praise'), 'b-purple'],
    ['🪙 Pay 30', () => act('pay'), 'b-gold', S.coins < 30],
    [heal ? `${ITEMS[heal].ico} Use item` : '🎒 No items', () => act('item', heal), 'b-blue', !heal],
    ['↩ Back', showMenu, 'b-gray'],
  ]);
}
async function act(kind, arg) {
  if (!battleId || acting) return;
  acting = true;
  try {
    const ok = await B.tx(COL.battles, battleId, (b) => resolveTurn(b, kind, arg));
    if (!ok) showMenu();
  } catch (e) { console.warn(e); toast('Connection hiccup — try again.'); showMenu(); }
  acting = false;
}
// Runs inside a transaction: returns the battle patch plus any player-doc updates.
function resolveTurn(b, kind, arg) {
  if (!b || b.status !== 'active') return null;
  if (kind !== 'leave' && b.turn !== ME) return null;
  const X = ME, Y = oppOf(b), n = b.names, st = b.st;
  const hp = { ...b.hp }, def = { ...b.def }, lines = [], patch = {};
  let done = null, fx = null, keepTurn = false;
  const extra = { [X]: {}, [Y]: {} };
  switch (kind) {
    case 'attack': {
      let dmg = Math.max(1, st[X].atk + randi(-2, 3) - st[Y].def);
      const crit = Math.random() < 0.12; if (crit) dmg = Math.round(dmg * 1.6);
      const blocked = def[Y]; if (blocked) dmg = Math.max(1, Math.floor(dmg / 2));
      hp[Y] = Math.max(0, hp[Y] - dmg); def[Y] = false;
      lines.push(`${n[X]} attacked! (−${dmg} HP)`);
      if (crit) lines.push('A critical hit!');
      if (blocked) lines.push(`${n[Y]}'s guard softened the blow.`);
      fx = { t: Y, k: 'hit' };
      if (hp[Y] <= 0) done = { how: 'ko', winner: X, loser: Y };
      break;
    }
    case 'defend':
      def[X] = true; hp[X] = Math.min(st[X].max, hp[X] + 2);
      lines.push(`${n[X]} raised their guard! (+2 HP)`); fx = { t: X, k: 'heal' }; break;
    case 'praise': {
      const line = ['Nice outfit!', 'Your gear is sick.', 'You hike fast!', 'Cool hat!'][randi(0, 3)];
      patch[`st.${Y}.atk`] = Math.max(2, st[Y].atk - 1);
      lines.push(`${n[X]}: "${line}"`, `${n[Y]} blushed. Their attack fell!`); break;
    }
    case 'truce': patch.truce = X; lines.push(`${n[X]} offered a truce.`); break;
    case 'truce-yes': done = { how: 'truce' }; lines.push(`${n[X]} accepted the truce. Good fight!`); break;
    case 'truce-no': patch.truce = null; keepTurn = true; lines.push(`${n[X]} refused the truce!`); break;
    case 'pay':
      if (S.coins < 30) return null;
      done = { how: 'paid', winner: Y };
      extra[X].coins = B.inc(-30); extra[Y].coins = B.inc(30);
      lines.push(`${n[X]} paid ${n[Y]} 30 coins to end the battle.`); break;
    case 'item': {
      const it = ITEMS[arg]; if (!it || count(arg) <= 0) return null;
      hp[X] = Math.min(st[X].max, hp[X] + it.heal); extra[X]['bag.' + arg] = B.inc(-1);
      lines.push(`${n[X]} used ${it.name}! (+${it.heal} HP)`); fx = { t: X, k: 'heal' }; break;
    }
    case 'run':
      if (Math.random() < 0.55) { done = { how: 'fled' }; lines.push(`${n[X]} got away safely!`); }
      else lines.push(`${n[X]} tried to run but couldn't get away!`);
      break;
    case 'leave': done = { how: 'left' }; lines.push(`${n[X]} left the battle.`); break;
    default: return null;
  }
  if (done) {
    patch.status = 'done'; patch.result = done;
    extra[X].hp = Math.max(1, hp[X]); extra[Y].hp = Math.max(1, hp[Y]);
    if (done.how === 'ko') {
      const pot = Math.floor(((others[Y] && others[Y].coins) || 0) * 0.25);
      lines.push(`${n[Y]} fainted!`, pot ? `${n[X]} won ${pot} coins from ${n[Y]}!` : `${n[X]} wins!`);
      extra[Y].coins = B.inc(-pot); extra[Y].hp = Math.ceil(st[Y].max / 2);
      extra[X].coins = B.inc(pot); extra[X].xp = B.inc(35);
    }
  }
  Object.assign(patch, { hp, def, lines, fx, seq: b.seq + 1, updated: Date.now(), turn: keepTurn || done ? X : Y });
  const ops = [X, Y].filter((u) => Object.keys(extra[u]).length).map((u) => ({ col: COL.players, id: u, patch: extra[u] }));
  return { patch, extra: ops };
}
