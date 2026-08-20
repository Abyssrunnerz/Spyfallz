/* Spyfall — ไคลเอนต์ Telegram Mini App
 *
 * แก้บรรทัดเดียวนี้ถ้าย้ายแบ็กเอนด์
 * URL ของ Cloudflare Worker (ลงท้ายด้วย /)
 */
var API = 'https://spyfall-api.j4ck-manop.workers.dev/';
/* ไม่ต้องแก้อะไรใต้บรรทัดนี้ */

(function () {
'use strict';

if (window.API_BASE) API = window.API_BASE;   // dev server ใส่ค่าให้เอง

var POLL_MS = 15000;   // ตาข่ายกันพลาดเท่านั้น สถานะจริงมาทาง WebSocket
var tg = window.Telegram && window.Telegram.WebApp;
var inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');

var ME = null;      // {uid, name, sig}
var LOCS = [];      // ชื่อสถานที่ทั้งหมด
var INVITE = '';    // ลิงก์ฐานสำหรับชวนเพื่อน (t.me/<bot>/<app>)
var VIEW = null;    // สถานะห้องล่าสุด
var CODE = '';      // รหัสห้องที่อยู่
var SKEW = 0;       // เวลาเซิร์ฟเวอร์ - เวลาเครื่อง
var lastKey = '';   // ลายเซ็นของสิ่งที่วาดไปแล้ว กันวาดซ้ำ
var polling = null;
var SOCK = null;       // WebSocket ที่ใช้อยู่
var wsRetry = null;    // ตัวจับเวลาต่อใหม่
var wsTries = 0;       // ต่อไม่ติดมากี่ครั้งแล้ว ใช้ถ่วงเวลาแบบทวีคูณ
var MY_AV = 0;         // รูปประจำตัวที่เลือกไว้ 0 = ใช้วงกลมตัวอักษร
var AVATARS = 27;      // จำนวนรูปใน web/av/
var warnedRound = -1;  // เตือนเสียงนาทีสุดท้ายไปแล้วในรอบไหน
var soundedRound = -1; // เล่นเสียงผลรอบไปแล้วในรอบไหน

var $ = function (id) { return document.getElementById(id); };

/* ---------- Telegram SDK ----------
 * ข้อมูลจากงานค้น: MainButton ไม่มี version gate เรียกได้เลย
 * แต่ showAlert/showConfirm (6.2+) จะ throw บนเวอร์ชันเก่า ต้องกันไว้
 * และ setHeaderColor รับสี hex อิสระได้ตั้งแต่ 6.9 เท่านั้น ต่ำกว่านั้นรับแต่คีย์เวิร์ด
 */

function boot() {
  if (!tg) return;
  try {
    tg.ready();     // ซ่อน placeholder ของ Telegram ให้เร็วที่สุด
    tg.expand();
    if (tg.isVersionAtLeast('6.9')) tg.setHeaderColor('#111827');
    else tg.setHeaderColor('bg_color');
    if (tg.isVersionAtLeast('6.1')) tg.setBackgroundColor('#111827');
    if (tg.isVersionAtLeast('7.10')) tg.setBottomBarColor('#111827');
  } catch (e) {}
  if (inTelegram) document.body.classList.add('tg');
}

function haptic(kind) {
  try { tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {}
}

/** ถามยืนยัน — ใช้ป็อปอัปของ Telegram ถ้ารองรับ ไม่งั้นใช้ของเบราว์เซอร์ */
function ask(text, cb) {
  if (tg && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) {
    try { tg.showConfirm(text, function (ok) { if (ok) cb(); }); return; } catch (e) {}
  }
  if (window.confirm(text)) cb();
}

/* MainButton: ผูก onClick ครั้งเดียวตลอดอายุหน้า แล้วสลับ "งานปัจจุบัน" แทน
 * ถ้าผูก closure ใหม่ทุกครั้งที่วาดจอ handler จะทับถมกันและยิงพร้อมกันหมดตอนกดครั้งเดียว */
var mainAction = null;
if (tg && tg.MainButton) {
  tg.MainButton.onClick(function () { if (mainAction) mainAction(); });
}

function mainButton(text, action, disabled) {
  if (!tg || !tg.MainButton) return;
  var mb = tg.MainButton;
  if (!text || !action) { mainAction = null; mb.hide(); return; }
  mainAction = action;
  mb.setText(String(text).substring(0, 64));   // ข้อความว่างหรือเกิน 64 ตัว = throw
  if (disabled) mb.disable(); else mb.enable();
  mb.show();
}

function backButton(action) {
  if (!tg || !tg.BackButton) return;
  if (backButton._bound) { tg.BackButton.offClick(backButton._bound); backButton._bound = null; }
  if (!action) { tg.BackButton.hide(); return; }
  backButton._bound = action;
  tg.BackButton.onClick(action);
  tg.BackButton.show();
}

/* ---------- API ----------
 * initData ส่งเฉพาะตอน hello ครั้งเดียว แล้วใช้ลายเซ็นสั้นของเซิร์ฟเวอร์ต่อ
 * จะได้ไม่ต้องแนบข้อมูลตัวตนก้อนใหญ่ไปกับทุกคำขอ
 */
function api(action, payload) {
  var p = payload || {};
  if (ME) { p.uid = ME.uid; p.name = ME.name; p.sig = ME.sig; p.av = MY_AV; }
  var url = API + '?api=' + encodeURIComponent(action) + '&p=' + encodeURIComponent(JSON.stringify(p));
  return fetchOnce(url).catch(function () {
    // ลองซ้ำครั้งเดียวเมื่อพลาดระดับ transport เท่านั้น (เน็ตสะดุด/คำขอแรกหลัง deploy)
    // ถ้าเซิร์ฟเวอร์ตอบ ok:false มาแล้ว จะไม่ลองซ้ำ เพราะนั่นคือคำตอบจริง
    return new Promise(function (r) { setTimeout(r, 700); }).then(function () { return fetchOnce(url); });
  });
}

function fetchOnce(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('เชื่อมต่อไม่ได้ (' + r.status + ')');
    return r.json();
  });
}

/** ตอบสนองการแตะทันทีโดยไม่รอเซิร์ฟเวอร์ กันผู้เล่นกดซ้ำเพราะคิดว่าไม่ติด */
function busy(on) {
  document.body.classList.toggle('busy', on);
  try {
    if (on) tg.MainButton.showProgress();
    else tg.MainButton.hideProgress();   // ปลดล็อกปุ่มด้วยเสมอ — render รอบถัดไปจะตั้งสถานะจริงให้เอง
  } catch (e) {}
}

function act(action, payload) {
  busy(true);
  return api(action, payload).then(function (res) {
    busy(false);
    if (res && res.me) ME = res.me;
    if (!res || !res.ok) throw new Error((res && res.error) || 'เชื่อมต่อไม่ได้');
    return res;
  }, function (err) {
    busy(false);
    // hideProgress ปลดล็อกปุ่มหลักเสมอ ถ้าไม่วาดใหม่ ปุ่มที่ควรถูกปิดอยู่จะกดได้
    if (VIEW) { lastKey = ''; render(); }
    throw err;
  });
}

function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 2800);
}

function fail(err) { toast(String((err && err.message) || err)); }

/* ---------- หน้าจอ ---------- */

function show(name) {
  ['home', 'lobby', 'deal', 'game', 'vote', 'guess', 'result'].forEach(function (s) {
    $('screen-' + s).classList.toggle('active', s === name);
  });
  window.scrollTo(0, 0);
}

function nameOf(id) {
  if (!VIEW) return '';
  var hit = VIEW.players.filter(function (p) { return p.id === id; });
  return hit.length ? hit[0].name : 'ผู้เล่นที่ออกไปแล้ว';
}

function setNotice(el, text) {
  el.textContent = text || '';
  el.classList.toggle('show', !!text);
}

function tagEl(text, cls) {
  var s = document.createElement('span');
  s.className = 'tag ' + cls;
  s.textContent = text;
  return s;
}

/** วงกลมประจำตัว — ใช้รูปที่เลือกไว้ ถ้าไม่ได้เลือกก็ใช้ตัวอักษรแรกบนสีที่มาจากชื่อ
 *  (ผู้เล่นคนเดิมได้สีเดิมเสมอ) */
var AV_HUES = [0, 28, 45, 155, 190, 265, 320];
function avEl(name, big, av) {
  var d = document.createElement('div');
  d.className = 'av' + (big ? ' lg' : '');
  if (av) {
    d.className += ' pic';
    var img = document.createElement('img');
    img.src = avSrc(av);
    img.alt = '';
    d.appendChild(img);
    return d;
  }
  var h = 0;
  for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  var hue = AV_HUES[h % AV_HUES.length];
  d.style.background = 'hsla(' + hue + ',85%,60%,.22)';
  d.style.color = 'hsl(' + hue + ',85%,72%)';
  d.textContent = (name.trim().charAt(0) || '?').toUpperCase();
  return d;
}

function avSrc(n) {
  return './av/a' + (n < 10 ? '0' + n : n) + '.webp';
}

function playerById(id) {
  if (!VIEW) return null;
  var hit = VIEW.players.filter(function (p) { return p.id === id; });
  return hit.length ? hit[0] : null;
}

/** วงกลมประจำตัวของผู้เล่นคนนั้น หาเองจาก id */
function avOf(id, big) {
  var p = playerById(id);
  return avEl(p ? p.name : nameOf(id), big, p ? p.av : 0);
}

/* ---------- เสียงเตือน ----------
 * สร้างเสียงเองด้วย WebAudio ไม่ต้องโหลดไฟล์เสียง
 * เบราว์เซอร์ห้ามเล่นเสียงก่อนผู้ใช้แตะจอ จึงปลุก AudioContext ตอนแตะครั้งแรก
 */
var actx = null;
function audio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch (e) { return null; }
}
document.addEventListener('pointerdown', function once() {
  audio();
  document.removeEventListener('pointerdown', once);
}, { once: true });

function beep(freq, ms, delay) {
  var c = audio();
  if (!c) return;
  var t = c.currentTime + (delay || 0);
  var o = c.createOscillator();
  var g = c.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g);
  g.connect(c.destination);
  o.start(t);
  o.stop(t + ms / 1000 + 0.05);
}

/** เตือนว่าเหลือเวลาอีก 1 นาที */
function lastMinuteWarning() {
  beep(880, 150, 0);
  beep(660, 240, 0.2);
  try { tg.HapticFeedback.notificationOccurred('warning'); } catch (e) {}
}

/** ชนะ — ไล่เสียงขึ้น */
function winSound() {
  beep(523, 130, 0);
  beep(659, 130, 0.12);
  beep(784, 150, 0.24);
  beep(1047, 300, 0.38);
  try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
}

/** แพ้ — ไล่เสียงลง เบากว่าและยาวกว่า */
function loseSound() {
  beep(392, 190, 0);
  beep(311, 210, 0.17);
  beep(233, 420, 0.36);
  try { tg.HapticFeedback.notificationOccurred('error'); } catch (e) {}
}

/* ---------- รับสถานะแบบ push ----------
 * เซิร์ฟเวอร์ส่งสถานะมาให้ทันทีที่มีอะไรเปลี่ยน ไม่ต้องถามซ้ำ ๆ
 * poll ที่เหลือไว้เป็นตาข่ายกันพลาดเผื่อ WebSocket ต่อไม่ได้ (เน็ตบางที่บล็อก)
 * ห่าง 15 วิ จึงกินโควตาแค่ 1 ใน 6 ของเดิม
 */

function startPolling() {
  stopPolling();
  connectWS();
  polling = setInterval(function () {
    if (document.hidden || !CODE) return;
    // WebSocket ยังเปิดอยู่ก็ไม่ต้องถาม สถานะถูกส่งมาให้อยู่แล้ว
    // ถามซ้ำ = เปลือง 1 คำขอ Worker + 1 คำขอ Durable Object โดยได้ข้อมูลเดิม
    if (SOCK && SOCK.readyState === 1) return;
    refresh();
  }, POLL_MS);
}

function stopPolling() {
  if (polling) { clearInterval(polling); polling = null; }
  closeWS();
}

function closeWS() {
  if (wsRetry) { clearTimeout(wsRetry); wsRetry = null; }
  if (SOCK) {
    var s = SOCK;
    SOCK = null;
    try { s.close(); } catch (e) {}
  }
}

function connectWS() {
  if (!CODE || !ME || !window.WebSocket) return;
  closeWS();
  var url = API.replace(/^http/, 'ws').replace(/\/$/, '') +
    '/ws?code=' + encodeURIComponent(CODE) +
    '&uid=' + encodeURIComponent(ME.uid) +
    '&sig=' + encodeURIComponent(ME.sig);

  var sock;
  try { sock = new WebSocket(url); } catch (e) { return; }
  SOCK = sock;

  sock.onopen = function () { wsTries = 0; };
  sock.onmessage = function (e) {
    var view;
    try { view = JSON.parse(e.data); } catch (err) { return; }
    if (view && view.ok) apply(view);
  };
  sock.onclose = function () {
    if (SOCK !== sock) return;   // เราปิดเอง ไม่ต้องต่อใหม่
    SOCK = null;
    if (!CODE) return;
    // อย่าต่อใหม่ตอนแท็บถูกซ่อน จะไปต่อตอนกลับมาดู (ดู visibilitychange)
    if (document.hidden) return;
    // ถ่วงเวลาแบบทวีคูณ 1→2→4…สูงสุด 30 วิ + สุ่มเล็กน้อย
    // ของเดิมลองใหม่ทุก 3 วิไม่มีที่สิ้นสุด ถ้าเซิร์ฟเวอร์ล่มคือยิงรัวไม่หยุด
    var delay = Math.min(30000, 1000 * Math.pow(2, wsTries++)) + Math.random() * 500;
    wsRetry = setTimeout(connectWS, delay);
  };
  sock.onerror = function () { try { sock.close(); } catch (e) {} };
}

function refresh() {
  return api('state', { code: CODE }).then(function (res) {
    if (res && res.me) ME = res.me;
    if (!res || !res.ok) {          // ห้องหมดอายุหรือถูกลบ
      goHome();
      if (res && res.error) toast(res.error);
      return;
    }
    apply(res);
  }, function () { /* เน็ตสะดุด ปล่อยให้รอบหน้าลองใหม่ */ });
}

function apply(view) {
  VIEW = view;
  CODE = view.code;
  SKEW = view.now - Date.now();
  var key = view.version + '|' + view.phase + '|' + (view.vote ? view.vote.voted : 0);
  if (key === lastKey) return;
  lastKey = key;
  render();
}

function enter(res) { apply(res); startPolling(); }

function goHome() {
  stopPolling();
  CODE = ''; VIEW = null; lastKey = '';
  mainButton(null);
  backButton(null);
  show('home');
  syncHomeButton();
}

/* ---------- วาดหน้าจอ ---------- */

function render() {
  var v = VIEW;

  // ข้อมูลรอบจะหายไปเมื่อเราไม่ได้อยู่ในห้องแล้ว (เช่นเพิ่งกดออก แล้ว broadcast ตามมา)
  // ถ้าวาดต่อจะ throw เพราะ v.round เป็น undefined
  if (v.phase === 'lobby') renderLobby(v);
  else if (v.phase === 'dealing' && v.deal) renderDeal(v);
  else if (v.phase === 'playing' && v.round) renderGame(v);
  else if (v.phase === 'vote' && v.vote && v.round) renderVote(v);
  else if (v.phase === 'guessing' && v.guess) renderGuess(v);
  else if (v.phase === 'reveal' && v.result) renderResult(v);
  else goHome();
}

function renderLobby(v) {
  show('lobby');
  backButton(null);
  $('lobby-code').textContent = v.code;
  $('lobby-count').textContent = v.players.length + '/12';
  setNotice($('lobby-notice'), v.notice);

  var isHost = (v.you === v.hostId);
  var ul = $('lobby-players');
  ul.innerHTML = '';
  v.players.forEach(function (p) {
    var li = document.createElement('li');
    li.appendChild(avEl(p.name, false, p.av));
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    li.appendChild(nm);
    if (p.id === v.hostId) li.appendChild(tagEl('หัวห้อง', 'host'));
    if (p.id === v.you) li.appendChild(tagEl('คุณ', 'you'));
    if (v.roundNo > 0) {
      var pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = p.score;
      li.appendChild(pts);
    }
    ul.appendChild(li);
  });

  var row = $('minutes-row');
  row.innerHTML = '';
  [4, 6, 8, 10].forEach(function (m) {
    var b = document.createElement('button');
    b.className = 'loc' + (m === v.minutes ? '' : ' off');
    b.textContent = m + ' นาที';
    b.disabled = !isHost;
    b.onclick = function () { haptic(); act('minutes', { code: CODE, minutes: m }).then(apply, fail); };
    row.appendChild(b);
  });

  var few = v.players.length < 3;
  var label = few ? 'ต้องมีอย่างน้อย 3 คน (ตอนนี้ ' + v.players.length + ')'
                  : (v.roundNo > 0 ? 'เริ่มรอบที่ ' + (v.roundNo + 1) : 'เริ่มเกม');

  // ใครก็ได้ในห้องกดเริ่มได้ ไม่ต้องรอหัวห้อง
  $('lobby-wait').textContent = few ? '' : 'ใครก็ได้ในห้องกดเริ่มได้';
  $('btn-start').textContent = label;
  $('btn-start').disabled = few;
  $('btn-start').style.display = 'block';
  mainButton(label, startRound, few);
}

/** เฟสแจกไพ่ — ไพ่คว่ำเท่าจำนวนคน แตะได้ใบเดียว พลิกแล้วเปลี่ยนไม่ได้ */
function renderDeal(v) {
  show('deal');
  backButton(null);
  mainButton(null);

  var d = v.deal;
  var picked = Object.keys(d.taken).length;
  $('deal-status').textContent = 'หยิบแล้ว ' + picked + '/' + v.players.length + ' คน';
  $('deal-note').textContent = d.yours === null
    ? 'เลือกได้ใบเดียว เลือกแล้วเปลี่ยนไม่ได้'
    : 'รอเพื่อนที่เหลือหยิบให้ครบ แล้วเกมจะเริ่มเอง';
  $('btn-cancel-deal').style.display = (v.you === v.hostId) ? 'block' : 'none';

  var grid = $('deal-grid');
  grid.innerHTML = '';
  for (var i = 0; i < d.n; i++) {
    grid.appendChild(dealCard(v, d, i));
  }
}

function dealCard(v, d, i) {
  var ownerId = d.taken[String(i)] || null;
  var isMine = (d.yours === i);

  var card = document.createElement('button');
  card.type = 'button';
  card.className = 'deal-card' + (ownerId ? ' taken' : '') + (isMine ? ' flipped' : '');
  card.disabled = !!ownerId || d.yours !== null;

  var inner = document.createElement('div');
  inner.className = 'card-inner';

  var back = document.createElement('div');
  back.className = 'card-face card-back';
  if (ownerId && !isMine) {
    var who = document.createElement('div');
    who.className = 'card-owner';
    var p = playerById(ownerId);
    who.appendChild(avEl(p ? p.name : nameOf(ownerId), false, p ? p.av : 0));
    var nm = document.createElement('span');
    nm.textContent = p ? p.name : nameOf(ownerId);
    who.appendChild(nm);
    back.appendChild(who);
  } else {
    var no = document.createElement('div');
    no.className = 'card-no';
    no.textContent = i + 1;
    back.appendChild(no);
  }

  var front = document.createElement('div');
  front.className = 'card-face card-front';
  if (isMine && d.card) {
    var where = document.createElement('div');
    where.className = 'where';
    var role = document.createElement('div');
    role.className = 'role';
    if (d.card.spy) {
      front.className += ' spy';
      where.textContent = 'คุณคือสายลับ';
      role.textContent = 'อย่าให้ใครจับได้';
    } else {
      where.textContent = d.card.location;
      role.textContent = d.card.role;
    }
    front.appendChild(where);
    front.appendChild(role);
  }

  inner.appendChild(back);
  inner.appendChild(front);
  card.appendChild(inner);

  if (!card.disabled) {
    card.onclick = function () {
      haptic('medium');
      card.classList.add('flipped');          // พลิกทันที ไม่รอเซิร์ฟเวอร์
      act('pick', { code: CODE, cardIdx: i }).then(apply, function (err) {
        card.classList.remove('flipped');     // เซิร์ฟเวอร์ปฏิเสธ พลิกกลับ
        fail(err);
      });
    };
  }
  return card;
}

var secretRound = -1;

function showSecret(open) {
  $('secret').classList.toggle('open', open);
  $('secret').setAttribute('aria-label', open ? 'แตะเพื่อปิดการ์ด' : 'แตะเพื่อดูการ์ดของคุณ');
}

function renderGame(v) {
  show('game');
  backButton(null);
  var r = v.round;

  // การ์ดปิดไว้ก่อน เปิดดูเองได้ตอนลืม — ปิดกลับทุกครั้งที่ขึ้นรอบใหม่
  // เช็คด้วยเลขรอบ ไม่ใช่ทุกครั้งที่วาดจอ ไม่งั้นการ์ดจะหุบใส่หน้าคนที่กำลังอ่าน
  if (secretRound !== v.roundNo) { secretRound = v.roundNo; showSecret(false); }

  $('secret-front').classList.toggle('is-spy', r.youAreSpy);
  $('secret-main').textContent = r.youAreSpy ? 'คุณคือสายลับ' : r.location;
  $('secret-role').textContent = r.youAreSpy
    ? 'ฟังให้ดี แล้วเดาให้ออกว่าที่นี่คือที่ไหน'
    : 'บทบาท: ' + r.yourRole;

  $('first-asker').textContent = nameOf(r.firstAskerId) + ' เป็นคนถามก่อน';
  $('game-hint').textContent = r.youAreSpy
    ? 'เปิดตัวทายสถานที่ได้ตลอดเวลา ทายถูกก่อนหมดเวลาได้ 2 คะแนน'
    : 'หมดเวลาแล้วทุกคนจะโหวตพร้อมกันว่าใครคือสายลับ';

  $('btn-open-guess').style.display = r.youAreSpy ? 'block' : 'none';
  mainButton(r.youAreSpy ? 'เปิดตัว & ทายสถานที่' : null, revealSelf);
}

/**
 * โหวตตอนหมดเวลา — ทุกคนที่ไม่ใช่สายลับเลือกหนึ่งคน กดได้ครั้งเดียว
 * ไม่โชว์ว่าใครโหวตใคร โชว์แค่จำนวน ไม่งั้นคนกดทีหลังจะโหวตตามคนแรก
 */
function renderVote(v) {
  show('vote');
  backButton(null);
  mainButton(null);
  var vote = v.vote;
  var done = !!vote.yourVote;

  $('vote-title').textContent = vote.youAreVoter ? 'ใครคือสายลับ?' : 'คุณคือสายลับ';
  $('vote-sub').textContent = !vote.youAreVoter
    ? 'รอดูว่าเสียงส่วนใหญ่จะชี้มาที่คุณไหม ถ้าโหวตผิดคน คุณได้ 1 คะแนน'
    : done ? 'คุณโหวต ' + nameOf(vote.yourVote) + ' ไปแล้ว รอคนอื่นให้ครบ'
           : 'หมดเวลาแล้ว เลือกคนที่คิดว่าเป็นสายลับ เลือกได้ครั้งเดียว';

  var picking = vote.youAreVoter && !done;
  $('vote-pick').style.display = picking ? 'block' : 'none';
  if (picking) {
    var grid = $('vote-players');
    grid.innerHTML = '';
    v.players.forEach(function (p) {
      if (p.id === v.you) return;              // โหวตตัวเองไม่ได้
      var b = document.createElement('button');
      b.className = 'pbtn';
      b.appendChild(avEl(p.name, false, p.av));
      var nm = document.createElement('span');
      nm.textContent = p.name;
      b.appendChild(nm);
      b.onclick = function () {
        ask('โหวต ' + p.name + ' ว่าเป็นสายลับ? เปลี่ยนไม่ได้', function () {
          haptic('medium');
          act('vote', { code: CODE, targetId: p.id }).then(apply, fail);
        });
      };
      grid.appendChild(b);
    });
  }

  $('vote-progress').textContent = 'โหวตแล้ว ' + vote.voted + '/' + vote.total + ' คน';
}

/**
 * สายลับกำลังทายสถานที่ — ทุกคนในห้องเห็นจอนี้พร้อมกัน
 * ไม่มีปุ่มถอย ไม่มี MainButton เพราะถึงจุดนี้แล้วย้อนกลับไม่ได้ทั้งสองทาง
 * เข้ามาได้สองทาง เปิดตัวเอง หรือโดนโหวตจับได้ ข้อความต่างกันเพราะเดิมพันต่างกัน
 */
function renderGuess(v) {
  show('guess');
  backButton(null);
  mainButton(null);

  var iAmSpy = (v.you === v.guess.spyId);
  var caught = !!v.guess.caught;
  var spy = nameOf(v.guess.spyId);
  var av = $('guess-av');
  av.innerHTML = '';
  av.appendChild(avOf(v.guess.spyId, true));

  if (caught) {
    $('guess-title').textContent = iAmSpy ? 'โหวตจับคุณได้' : 'โหวตถูก! ' + spy + ' คือสายลับ';
    $('guess-sub').textContent = iAmSpy
      ? 'โอกาสสุดท้าย — ทายถูกได้ 1 คะแนน พลิกกลับมาชนะ · ผิดหรือไม่ทัน แพ้'
      : 'ยังไม่จบ ' + spy + ' ขอทายสถานที่แก้ตัว — ถ้าทายผิด คนที่โหวตถูกได้คนละ 1 คะแนน';
  } else {
    $('guess-title').textContent = iAmSpy ? 'คุณเปิดตัวแล้ว' : spy + ' เปิดตัวว่าเป็นสายลับ';
    $('guess-sub').textContent = iAmSpy
      ? 'ทายถูกได้ 2 คะแนน ชนะทันที · ผิดหรือเลือกไม่ทัน = แพ้'
      : 'เปิดตัวเองแล้ว กำลังเลือกสถานที่ — ถ้าทายผิด ผู้เล่นชนะ';
  }

  $('guess-pick').style.display = iAmSpy ? 'block' : 'none';
  if (iAmSpy) buildGuessList();
}

function renderResult(v) {
  show('result');
  backButton(null);
  var res = v.result;
  var spy = nameOf(res.spyId);
  // ฝั่งไหนชนะ ใช้บอกสีและสัญลักษณ์ ไม่ใช้ emoji
  var t = {
    spy_caught:       ['players', 'ผู้เล่นชนะ', 'โหวตจับสายลับได้ และ ' + spy +
                       (res.guess ? ' ทายแก้ตัวผิด (ทาย ' + res.guess + ')' : ' ทายแก้ตัวไม่ทัน') +
                       ' · สถานที่คือ ' + res.location],
    spy_survived:     ['spy', 'สายลับรอด', (res.votedId
                       ? 'เสียงส่วนใหญ่โหวต ' + nameOf(res.votedId) + ' ซึ่งไม่ใช่สายลับ'
                       : 'เสียงแตก ไม่มีใครโดนโหวตมากที่สุดคนเดียว') +
                       ' — สายลับคือ ' + spy + ' · สถานที่คือ ' + res.location],
    spy_guessed:      res.comeback
      ? ['spy', 'สายลับพลิกกลับมาชนะ', spy + ' โดนโหวตจับได้ แต่ทายถูก: ' + res.location]
      : ['spy', 'สายลับชนะ', spy + ' เปิดตัวเองแล้วทายถูก: ' + res.location],
    spy_wrong_guess:  ['players', 'ผู้เล่นชนะ', spy + ' เปิดตัวเองแล้วทายผิด (ทาย ' + res.guess +
                       ') — ที่จริงคือ ' + res.location],
    spy_no_guess:     ['players', 'ผู้เล่นชนะ', spy + ' เปิดตัวเองแล้วทายไม่ทัน — สถานที่คือ ' + res.location]
  }[res.type] || ['none', 'จบรอบ', ''];

  var badge = $('result-emoji');
  badge.className = 'verdict-badge ' + t[0];
  badge.textContent = t[0] === 'players' ? '✓' : t[0] === 'spy' ? '✕' : '–';
  $('result-title').textContent = t[1];
  $('result-sub').textContent = t[2];

  var ul = $('result-scores');
  ul.innerHTML = '';
  v.players.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (p) {
    var li = document.createElement('li');
    li.appendChild(avEl(p.name, false, p.av));
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    li.appendChild(nm);
    if (p.id === res.spyId) li.appendChild(tagEl('สายลับ', 'spy'));
    if (res.gained[p.id]) {
      var g = document.createElement('span');
      g.className = 'gain';
      g.textContent = '+' + res.gained[p.id];
      li.appendChild(g);
    }
    var pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = p.score;
    li.appendChild(pts);
    ul.appendChild(li);
  });

  // เสียงแพ้ชนะ ครั้งเดียวต่อรอบ และตัดสินจากมุมของผู้เล่นคนนี้เอง
  // สายลับที่รอดต้องได้ยินเสียงชนะ ทั้งที่ "ผู้เล่น" แพ้
  if (soundedRound !== v.roundNo) {
    soundedRound = v.roundNo;
    var spyWon = (t[0] !== 'players');   // ใช้คำตัดสินเดียวกับตราผล ไม่เก็บรายชื่อผลไว้สองที่
    var iAmSpy = (res.spyId === v.you);
    if (spyWon === iAmSpy) winSound(); else loseSound();
  }

  var label = 'เริ่มรอบที่ ' + (v.roundNo + 1);
  $('result-wait').textContent = 'ใครก็ได้ในห้องกดเริ่มรอบต่อไป';
  $('btn-next').textContent = label;
  $('btn-next').style.display = 'block';
  mainButton(label, startRound);
}

/* ---------- รายชื่อสถานที่ ----------
 * เห็นได้ที่เดียว คือแผงเดาของสายลับ ระหว่างเล่นไม่มีรายชื่อโผล่ที่ไหนอีก */

function buildGuessList() {
  var box = $('guess-list');
  box.innerHTML = '';
  LOCS.forEach(function (name, i) {
    var b = document.createElement('button');
    b.className = 'loc';
    b.textContent = name;
    b.onclick = function () {
      ask('เดาว่าเป็น "' + name + '" ใช่ไหม? ผิดแล้วแพ้ทันที', function () {
        haptic('heavy');
        act('guess', { code: CODE, locIdx: i }).then(apply, fail);
      });
    };
    box.appendChild(b);
  });
}

/** เปิดตัว — ประกาศให้ทั้งห้องรู้ทันที และย้อนกลับไม่ได้ จึงถามยืนยันก่อน */
function revealSelf() {
  ask('เปิดตัวเลยไหม? ทุกคนจะรู้ทันทีว่าคุณคือสายลับ และย้อนกลับไม่ได้', function () {
    haptic('heavy');
    act('reveal', { code: CODE }).then(apply, fail);
  });
}

/* ---------- นาฬิกา ---------- */

var firedAt = 0;      // เวลาที่ขอผลครั้งล่าสุด กันยิงรัวทุก 250ms
var jitter = Math.random() * 1500;   // เหลื่อมเวลาระหว่างผู้เล่น กันทุกคนยิงพร้อมกัน

setInterval(function () {
  if (!VIEW) return;
  if (VIEW.phase === 'dealing' && VIEW.deal) {
    paintClock($('deal-timer'), $('deal-bar'), VIEW.deal.endsAt, 30000, 10);
  } else if (VIEW.phase === 'playing' && VIEW.round) {
    var left = paintClock($('timer'), $('timer-bar'), VIEW.round.endsAt, VIEW.minutes * 60000, 60);
    // เตือนครั้งเดียวต่อรอบ ตอนเข้าสู่นาทีสุดท้าย
    if (left <= 60 && left > 0 && warnedRound !== VIEW.roundNo) {
      warnedRound = VIEW.roundNo;
      lastMinuteWarning();
    }
  } else if (VIEW.phase === 'vote' && VIEW.vote) {
    paintClock($('vote-timer'), $('vote-bar'), VIEW.vote.endsAt, 60000, 10);
  } else if (VIEW.phase === 'guessing' && VIEW.guess) {
    paintClock($('guess-timer'), $('guess-bar'), VIEW.guess.endsAt, 60000, 10);
  }
}, 250);

function paintClock(el, bar, endsAt, totalMs, warnSec) {
  var leftMs = Math.max(0, endsAt - (Date.now() + SKEW));
  var left = Math.round(leftMs / 1000);
  var m = Math.floor(left / 60), s = left % 60;
  el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
  el.classList.toggle('warn', left <= warnSec);
  bar.style.width = Math.min(100, (leftMs / totalMs) * 100) + '%';
  // ปกติเซิร์ฟเวอร์ตั้งนาฬิกาปลุกของตัวเองแล้วส่งผลมาทาง WebSocket
  // อันนี้เป็นตาข่ายกันพลาด จึงต้องยิง "หลัง" เส้นตายจริงเท่านั้น
  // ของเดิมใช้วินาทีที่ปัดแล้วจึงยิงก่อนถึงเวลาได้ถึงครึ่งวินาที เซิร์ฟเวอร์ยังไม่มีอะไรให้ แล้วล็อกไม่ยอมลองอีก
  var t = Date.now();
  if (leftMs <= -jitter && t - firedAt > 3000) {
    firedAt = t;
    refresh();
  }
  return left;
}

/* ---------- การกระทำ ---------- */

function buildAvPicker() {
  var box = $('av-picker');
  box.innerHTML = '';
  for (var i = 0; i <= AVATARS; i++) {
    (function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'av-opt' + (n === MY_AV ? ' on' : '');
      b.title = n ? 'รูปที่ ' + n : 'ใช้ตัวอักษรแรกของชื่อ';
      if (n) {
        var img = document.createElement('img');
        img.src = avSrc(n);
        img.alt = '';
        img.loading = 'lazy';
        b.appendChild(img);
      } else {
        var t = document.createElement('span');
        t.className = 'letter';
        t.textContent = 'ก';
        b.appendChild(t);
      }
      b.onclick = function () {
        MY_AV = n;
        try { localStorage.setItem('sf_av', String(n)); } catch (e) {}
        haptic();
        var all = box.querySelectorAll('.av-opt');
        for (var k = 0; k < all.length; k++) all[k].classList.remove('on');
        b.classList.add('on');
      };
      box.appendChild(b);
    })(i);
  }
}

function myName() {
  var n = $('input-name').value.trim();
  if (!n) { toast('ใส่ชื่อก่อนนะ'); return null; }
  try { localStorage.setItem('sf_name', n); } catch (e) {}
  if (ME) ME.name = n;
  return n;
}

function createRoom() {
  if (!myName()) return;
  haptic();
  act('create', {}).then(enter, fail);
}

function joinRoom(code) {
  if (!myName()) return;
  code = cleanCode(code || $('input-code').value);
  if (code.length !== 4) { toast('รหัสห้องมี 4 ตัวอักษร'); return; }
  haptic();
  act('join', { code: code }).then(enter, fail);
}

function startRound() {
  haptic('medium');
  act('start', { code: CODE }).then(apply, fail);
}

function leaveRoom() {
  ask('ออกจากห้อง?', function () {
    api('leave', { code: CODE }).then(goHome, function () { goHome(); });
  });
}

/** ปุ่มหลักของหน้าแรกเปลี่ยนตามว่ากรอกรหัสห้องไว้หรือยัง */
/** รหัสห้องที่ใช้ได้จริงจากสิ่งที่พิมพ์มา — A-Z 0-9 ตัวพิมพ์ใหญ่ ยาวไม่เกิน 4 */
function cleanCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

/**
 * ปุ่มหลักของหน้าแรกต้องขยับตั้งแต่ตัวอักษรแรก
 * ของเดิมสลับเป็น "เข้าร่วมห้อง" ต่อเมื่อครบ 4 ตัวเป๊ะ ระหว่างพิมพ์จึงยังเป็น "สร้างห้องใหม่"
 * นอกจากไม่มีอะไรตอบสนอง ถ้าเผลอกดตอนรหัสยังไม่ครบจะกลายเป็นสร้างห้องใหม่ทันที
 */
function syncHomeButton() {
  if (CODE) return;
  var box = $('input-code');
  var code = cleanCode(box.value);
  if (box.value !== code) box.value = code;      // ให้สิ่งที่เห็นตรงกับสิ่งที่จะส่งจริง
  if (!code) mainButton('สร้างห้องใหม่', createRoom);
  else if (code.length < 4) mainButton('ใส่รหัสห้องให้ครบ 4 ตัว', function () { joinRoom(); }, true);
  else mainButton('เข้าร่วมห้อง ' + code, function () { joinRoom(); });
}

function share() {
  var text = 'มาเล่น Spyfall กัน! รหัสห้อง ' + CODE;
  if (!INVITE) { toast(text); return; }
  var link = INVITE + '?startapp=' + CODE;
  var url = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
  // window.open ใช้ไม่ได้ใน webview ของ Telegram ต้องผ่าน openTelegramLink เท่านั้น
  // และต้องเป็นรูปแบบ /share/url ไม่ใช่ /share เพราะแบบหลังแอปอ่านผิดเป็นชื่อผู้ใช้
  if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, '_blank');
}

/* ---------- ผูกปุ่มในหน้า (ใช้ตอนอยู่นอก Telegram) ---------- */

$('btn-create').onclick = createRoom;
$('btn-join').onclick = function () { joinRoom(); };
$('btn-start').onclick = $('btn-next').onclick = startRound;
$('btn-share').onclick = share;
$('btn-open-guess').onclick = revealSelf;
$('secret').onclick = function () {
  haptic();
  showSecret(!$('secret').classList.contains('open'));
};
$('btn-cancel-deal').onclick = function () {
  ask('ยกเลิกการแจกไพ่ กลับไปล็อบบี้?', function () {
    act('canceldeal', { code: CODE }).then(apply, fail);
  });
};
$('btn-leave').onclick = $('btn-leave-game').onclick = $('btn-leave-result').onclick = leaveRoom;
$('input-code').addEventListener('input', syncHomeButton);

document.addEventListener('visibilitychange', function () {
  if (document.hidden || !CODE) return;
  refresh();
  if (!SOCK) { wsTries = 0; connectWS(); }
});

/* ---------- เริ่มทำงาน ---------- */

boot();

if (API.indexOf('PASTE_') === 0) {
  show('home');
  toast('ยังไม่ได้ตั้งค่า API — แก้บรรทัดแรกของ app.js');
} else {
  var start = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
  if (!start) {
    var q = location.search.match(/[?&]room=([A-Za-z0-9]{4})/);
    if (q) start = q[1];
  }
  start = start.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 4);

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('sf_me') || 'null'); } catch (e) {}
  try { $('input-name').value = localStorage.getItem('sf_name') || ''; } catch (e) {}
  // ยังไม่เคยเลือกรูป = สุ่มให้หนึ่งรูป แล้วจำไว้ จะได้ไม่เปลี่ยนหน้าทุกครั้งที่เปิดแอป
  // ต้องเช็ค null ตรง ๆ เพราะ "ไม่เคยเลือก" กับ "เลือกวงกลมตัวอักษร" ต่างเก็บค่าอ่านได้เป็น 0 เหมือนกัน
  var savedAv = null;
  try { savedAv = localStorage.getItem('sf_av'); } catch (e) {}
  if (savedAv === null) {
    MY_AV = 1 + Math.floor(Math.random() * AVATARS);
    try { localStorage.setItem('sf_av', String(MY_AV)); } catch (e) {}
  } else {
    MY_AV = parseInt(savedAv, 10) || 0;
  }
  buildAvPicker();

  api('hello', {
    initData: (tg && tg.initData) || '',
    uid: saved && saved.uid,
    sig: saved && saved.sig,
    name: $('input-name').value
  }).then(function (res) {
    if (!res || !res.ok) { fail(res && res.error); goHome(); return; }
    ME = res.me;
    LOCS = res.locations;
    INVITE = res.invite || '';
    try { localStorage.setItem('sf_me', JSON.stringify({ uid: ME.uid, sig: ME.sig })); } catch (e) {}
    if (!$('input-name').value) $('input-name').value = ME.name;

    if (start) {
      $('input-code').value = start;
      act('join', { code: start }).then(enter, function (err) { fail(err); goHome(); });
    } else {
      goHome();
    }
  }, function (err) {
    goHome();
    fail(err);
  });
}

})();
