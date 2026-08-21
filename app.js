/* Board Game — ไคลเอนต์ Telegram Mini App
 *
 * มีสามเกมอยู่ในแอปเดียว ห้องบอกเองว่าเป็นเกมอะไรผ่านฟิลด์ game
 * จอที่ใช้ร่วมกันทุกเกม: หน้าแรก ล็อบบี้ แจกไพ่ นั่งรอ ผลรอบ
 * จอเฉพาะเกมอยู่ใน GAME_UI ข้างล่าง เกมใหม่เพิ่มที่นั่นที่เดียว
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
var LOCS = [];      // ชื่อสถานที่ทั้งหมด (ของ Spyfall)
var GAMES = [];     // รายชื่อเกมจากเซิร์ฟเวอร์ [{id,name,short,tagline,min,max}]
var MY_GAME = 'spyfall';   // เกมที่จะใช้ตอนกดสร้างห้อง
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
var warnedRound = '';  // เตือนเสียงนาทีสุดท้ายไปแล้วของช่วงไหน
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
  ['home', 'lobby', 'deal', 'game', 'vote', 'guess',
   'insider', 'hunt', 'clue', 'wait', 'result'].forEach(function (s) {
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

/* ---------- ข้อมูลของแต่ละเกมฝั่งไคลเอนต์ ----------
 *
 * ชื่อ/คำโปรย/จำนวนคนขั้นต่ำสูงสุด มาจากเซิร์ฟเวอร์ (GAMES) ไม่เก็บซ้ำที่นี่
 * ที่นี่เก็บเฉพาะสิ่งที่เป็นเรื่องของหน้าจอล้วน ๆ
 *   wordmark  ชื่อบนหน้าแรก
 *   rules     วิธีเล่นบนหน้าแรก
 *   dealFace  หน้าไพ่ตอนจั่ว
 *   render    วาดจอของเฟสเฉพาะเกม คืน true ถ้าวาดแล้ว
 *   clock     นาฬิกาของเฟสปัจจุบัน
 *   result    ข้อความสรุปผลรอบ
 */

var GAME_UI = {

  /* ================= Spyfall ================= */
  spyfall: {
    wordmark: ['SPY', 'FALL'],
    rules: [
      '<b>3–12 คน</b> ทุกคนได้สถานที่และบทบาทเหมือนกัน ยกเว้นสายลับ 1 คนที่ไม่รู้อะไรเลย',
      '<b>ผลัดกันถาม</b> คำถามที่พิสูจน์ว่าอีกฝ่ายรู้จักสถานที่ แต่ไม่เฉลยให้สายลับ',
      '<b>กล่าวหา</b> ได้คนละ 1 ครั้งต่อรอบ ถ้าเห็นด้วยเกินครึ่งและจับถูกตัว ผู้กล่าวหาได้ 2 คนโหวตถูกได้ 1',
      '<b>สายลับ</b> เปิดตัวทายสถานที่ได้ก่อนถูกกล่าวหา ทายถูกได้ 2 คะแนน · รอดจนหมดเวลาได้ 1'
    ],
    timeLabel: 'เวลาต่อรอบ',
    dealFace: function (c) {
      return c.spy
        ? { cls: 'spy', main: 'คุณคือสายลับ', sub: 'อย่าให้ใครจับได้' }
        : { main: c.location, sub: c.role };
    },
    render: function (v) {
      if (v.phase === 'playing' && v.round) { renderGame(v); return true; }
      if (v.phase === 'vote' && v.vote && v.round) { renderVote(v); return true; }
      if (v.phase === 'guessing' && v.guess) { renderGuess(v); return true; }
      return false;
    },
    clock: function (v) {
      if (v.phase === 'dealing' && v.deal) return ['deal-timer', 'deal-bar', v.deal.endsAt, 30000, 10];
      if (v.phase === 'playing' && v.round) return ['timer', 'timer-bar', v.round.endsAt, v.minutes * 60000, 60];
      if (v.phase === 'vote' && v.vote) return ['vote-timer', 'vote-bar', v.vote.endsAt, 60000, 10];
      if (v.phase === 'guessing' && v.guess) return ['guess-timer', 'guess-bar', v.guess.endsAt, 60000, 10];
      return null;
    },
    result: spyfallResult
  },

  /* ================= อินไซเดอร์ ================= */
  insider: {
    wordmark: ['IN', 'SIDER'],
    rules: [
      '<b>4–12 คน</b> มาสเตอร์ 1 คนรู้คำและเปิดตัวตั้งแต่ต้น · อินไซเดอร์ 1 คนแอบรู้คำด้วยแต่ไม่มีใครรู้ว่าเป็นใคร',
      '<b>ช่วยกันถาม</b> มาสเตอร์ตอบได้แค่ ใช่ / ไม่ใช่ / ไม่เกี่ยว จนกว่าจะมีคนพูดคำนั้นออกมาถูก',
      '<b>ทายไม่ทันเวลา แพ้กันทั้งวง</b> รวมอินไซเดอร์ด้วย เขาจึงต้องแอบพาให้ทุกคนทายถูก',
      '<b>ทายถูกแล้วหาตัว</b> เวลาคุยเท่ากับเวลาที่ใช้ถามไป · จับได้ทุกคนได้ 1 · จับไม่ได้ อินไซเดอร์ได้ 2'
    ],
    timeLabel: 'เวลาถามตอบ',
    dealFace: function (c) {
      if (c.role === 'master') {
        return { cls: 'master', main: c.word, sub: 'คุณคือมาสเตอร์ · ตอบได้แค่ ใช่ / ไม่ใช่ / ไม่เกี่ยว' };
      }
      if (c.role === 'insider') {
        return { cls: 'spy', main: c.word, sub: 'คุณคืออินไซเดอร์ · พาให้เขาทายถูกโดยไม่โดนจับ' };
      }
      return { main: 'คุณคือชาวบ้าน', sub: 'ยังไม่รู้คำ ต้องช่วยกันถามให้ออก' };
    },
    render: function (v) {
      if (v.phase === 'asking' && v.round) { renderInsider(v); return true; }
      if (v.phase === 'discuss' && v.vote && v.round) { renderInsiderVote(v); return true; }
      if (v.phase === 'hunt' && v.hunt) { renderHunt(v); return true; }
      if (v.phase === 'tiebreak' && v.tie) { renderTiebreak(v); return true; }
      return false;
    },
    clock: function (v) {
      if (v.phase === 'dealing' && v.deal) return ['deal-timer', 'deal-bar', v.deal.endsAt, 30000, 10];
      if (v.phase === 'asking' && v.round) return ['ins-timer', 'ins-bar', v.round.endsAt, v.minutes * 60000, 60];
      // เฟสคุยยาวไม่เท่ากันทุกรอบ (= เวลาที่ใช้ถามไป) เซิร์ฟเวอร์จึงส่งความยาวมาให้
      // ถ้าใช้ 60 วิตายตัว แถบจะเต็ม 100% ค้างอยู่จนเหลือนาทีสุดท้าย
      if (v.phase === 'discuss' && v.vote) {
        return ['vote-timer', 'vote-bar', v.vote.endsAt, v.vote.total || 60000, 10];
      }
      if (v.phase === 'hunt' && v.hunt) return ['hunt-timer', 'hunt-bar', v.hunt.endsAt, 60000, 10];
      if (v.phase === 'tiebreak' && v.tie) return ['hunt-timer', 'hunt-bar', v.tie.endsAt, 60000, 10];
      return null;
    },
    result: insiderResult
  },

  /* ================= Undercover ================= */
  undercover: {
    wordmark: ['UNDER', 'COVER'],
    rules: [
      '<b>4–12 คน</b> ทุกคนได้คำมาคนละคำ ชาวบ้านได้คำเดียวกันหมด สายลับได้คำที่คล้ายแต่ไม่เหมือน',
      '<b>ไม่มีใครรู้ว่าตัวเองเป็นฝ่ายไหน</b> ต้องฟังคำใบ้คนอื่นแล้วเดาเอาเองว่าคำของเราเป็นพวกมากหรือพวกน้อย',
      '<b>ผลัดกันพูดคำใบ้คนละคำ</b> ห้ามพูดคำของตัวเองตรง ๆ ห้ามพูดซ้ำคนอื่น แล้วโหวตคัดออกทีละคน',
      '<b>ชาวบ้านชนะ</b> เมื่อคัดสายลับออกได้หมด คนละ 1 คะแนน · <b>สายลับชนะ</b> เมื่อเหลือเท่าชาวบ้าน ได้ 2'
    ],
    timeLabel: 'เวลาต่อรอบคำใบ้',
    dealFace: function (c) {
      return { main: c.word, sub: 'ห้ามบอกใครว่าคำของคุณคืออะไร' };
    },
    render: function (v) {
      if (v.phase === 'clue' && v.round && v.vote) { renderClue(v); return true; }
      return false;
    },
    clock: function (v) {
      if (v.phase === 'dealing' && v.deal) return ['deal-timer', 'deal-bar', v.deal.endsAt, 30000, 10];
      if (v.phase === 'clue' && v.vote) return ['clue-timer', 'clue-bar', v.vote.endsAt, v.minutes * 60000, 60];
      return null;
    },
    result: undercoverResult
  }
};

/** โมดูลหน้าจอของห้องนี้ — ห้องเก่าที่ไม่มีฟิลด์ game ถือเป็น Spyfall */
function ui(v) {
  return GAME_UI[(v && v.game) || 'spyfall'] || GAME_UI.spyfall;
}

/** ข้อมูลเกมจากเซิร์ฟเวอร์ (ชื่อ จำนวนคน) — ยังไม่ได้โหลดก็คืนค่าพอใช้ได้ */
function metaOf(id) {
  for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i];
  return { id: id || 'spyfall', name: 'Spyfall', short: 'สายลับ', tagline: '', min: 3, max: 12 };
}

/* ---------- วาดหน้าจอ ---------- */

function render() {
  var v = VIEW;

  // คนที่เข้ามากลางเกมยังไม่มีข้อมูลรอบ ต้องดักก่อนทุกเฟส
  // ไม่งั้นจะตกไปที่ goHome() แล้วโดนเด้งออกจากห้องทั้งที่รออยู่ดี ๆ
  if (v.youAreWaiting) { renderWaiting(v); return; }

  // เฟสที่ทุกเกมมีเหมือนกัน วาดที่เดียว
  if (v.phase === 'lobby') { renderLobby(v); return; }
  if (v.phase === 'dealing' && v.deal) { renderDeal(v); return; }
  if (v.phase === 'reveal' && v.result) { renderResult(v); return; }

  // ข้อมูลรอบจะหายไปเมื่อเราไม่ได้อยู่ในห้องแล้ว (เช่นเพิ่งกดออก แล้ว broadcast ตามมา)
  // เกมวาดไม่ได้ก็แปลว่าไม่มีอะไรให้ดูแล้ว กลับหน้าแรก
  if (!ui(v).render(v)) goHome();
}

function renderLobby(v) {
  show('lobby');
  backButton(null);
  var g = metaOf(v.game);
  $('lobby-code').textContent = v.code;
  $('lobby-count').textContent = v.players.length + '/' + g.max;
  $('lobby-game').textContent = g.name + ' — ' + g.tagline;
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

  $('minutes-row').previousElementSibling.textContent = ui(v).timeLabel;
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

  var few = v.players.length < g.min;
  var label = few ? 'ต้องมีอย่างน้อย ' + g.min + ' คน (ตอนนี้ ' + v.players.length + ')'
                  : (v.roundNo > 0 ? 'เริ่มรอบที่ ' + (v.roundNo + 1) : 'เริ่มเกม');

  // ใครก็ได้ในห้องกดเริ่มได้ ไม่ต้องรอหัวห้อง
  $('lobby-wait').textContent = few ? '' : 'ใครก็ได้ในห้องกดเริ่มได้';
  $('btn-start').textContent = label;
  $('btn-start').disabled = few;
  $('btn-start').style.display = 'block';
  mainButton(label, startRound, few);
}

/** เฟสแจกไพ่ — ไพ่คว่ำเท่าจำนวนคน แตะได้ใบเดียว พลิกแล้วเปลี่ยนไม่ได้ */
var dealOpen = false;    // ใบของเราเปิดอยู่ไหมในเฟสแจกไพ่
var dealRound = -1;      // ใบเปิดค้างของรอบไหน

function renderDeal(v) {
  show('deal');
  backButton(null);
  mainButton(null);

  // ขึ้นรอบใหม่ = ใบของเราคว่ำกลับเสมอ
  if (dealRound !== v.roundNo) { dealRound = v.roundNo; dealOpen = false; }

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
  // หยิบแล้วไพ่ไม่เปิดเอง — คว่ำไว้ก่อน แล้วแตะพลิกเปิด/ปิดเองได้ตลอด
  // ใบของเราจึงยังกดได้เสมอ ต่างจากใบอื่นที่กดไม่ได้เมื่อมีคนถือหรือเราหยิบไปแล้ว
  card.className = 'deal-card' + (ownerId && !isMine ? ' taken' : '') +
                   (isMine ? ' mine' : '') + (isMine && dealOpen ? ' flipped' : '');
  card.disabled = isMine ? false : (!!ownerId || d.yours !== null);

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
  } else if (isMine) {
    var mine = document.createElement('div');
    mine.className = 'card-mine';
    mine.textContent = dealOpen ? 'แตะเพื่อปิด' : 'ใบของคุณ · แตะเพื่อดู';
    back.appendChild(mine);
  } else {
    var no = document.createElement('div');
    no.className = 'card-no';
    no.textContent = i + 1;
    back.appendChild(no);
  }

  var front = document.createElement('div');
  front.className = 'card-face card-front';
  if (isMine && d.card) {
    // หน้าไพ่เป็นเรื่องของแต่ละเกม ที่นี่รู้แค่ว่ามีบรรทัดใหญ่กับบรรทัดเล็ก
    var face = ui(v).dealFace(d.card);
    if (face.cls) front.className += ' ' + face.cls;
    var where = document.createElement('div');
    where.className = 'where';
    where.textContent = face.main;
    var role = document.createElement('div');
    role.className = 'role';
    role.textContent = face.sub;
    front.appendChild(where);
    front.appendChild(role);
  }

  inner.appendChild(back);
  inner.appendChild(front);
  card.appendChild(inner);

  if (isMine) {
    card.onclick = function () {
      haptic();
      dealOpen = !dealOpen;                   // เก็บไว้ที่ตัวแปร ไม่ใช่ที่ DOM
      card.classList.toggle('flipped', dealOpen);   // เพราะกริดถูกวาดใหม่ทุกครั้งที่มีคนหยิบ
      var lbl = card.querySelector('.card-mine');
      if (lbl) lbl.textContent = dealOpen ? 'แตะเพื่อปิด' : 'ใบของคุณ · แตะเพื่อดู';
    };
  } else if (!card.disabled) {
    card.onclick = function () {
      haptic('medium');
      act('pick', { code: CODE, cardIdx: i }).then(apply, fail);
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
  setNotice($('game-notice'), r.lastVote
    ? 'โหวตไม่ผ่าน — ' + nameOf(r.lastVote.targetId) + ' รอดไป (เห็นด้วย ' + r.lastVote.yes +
      ' / ไม่เห็นด้วย ' + r.lastVote.no + ')'
    : '');

  // การ์ดปิดไว้ก่อน เปิดดูเองได้ตอนลืม — ปิดกลับทุกครั้งที่ขึ้นรอบใหม่
  // เช็คด้วยเลขรอบ ไม่ใช่ทุกครั้งที่วาดจอ ไม่งั้นการ์ดจะหุบใส่หน้าคนที่กำลังอ่าน
  if (secretRound !== v.roundNo) { secretRound = v.roundNo; showSecret(false); }

  $('secret-front').classList.toggle('is-spy', r.youAreSpy);
  $('secret-main').textContent = r.youAreSpy ? 'คุณคือสายลับ' : r.location;
  $('secret-role').textContent = r.youAreSpy
    ? 'ฟังให้ดี แล้วเดาให้ออกว่าที่นี่คือที่ไหน'
    : 'บทบาท: ' + r.yourRole;

  $('first-asker').textContent = nameOf(r.firstAskerId) + ' เป็นคนถามก่อน';

  var grid = $('game-players');
  grid.innerHTML = '';
  v.players.forEach(function (p) {
    var b = document.createElement('button');
    b.className = 'pbtn' + (p.id === v.you ? ' self' : '');
    b.appendChild(avEl(p.name, false, p.av));
    var nm = document.createElement('span');
    nm.textContent = p.name;
    b.appendChild(nm);
    b.disabled = !r.canAccuse || p.id === v.you;
    b.onclick = function () {
      ask('กล่าวหา ' + p.name + ' ว่าเป็นสายลับ?', function () {
        haptic('medium');
        act('accuse', { code: CODE, targetId: p.id }).then(apply, fail);
      });
    };
    grid.appendChild(b);
  });
  $('accuse-hint').textContent = r.canAccuse
    ? 'กล่าวหาได้คนละ 1 ครั้งต่อรอบ'
    : 'คุณใช้สิทธิ์กล่าวหาไปแล้วในรอบนี้';

  $('btn-open-guess').style.display = r.youAreSpy ? 'block' : 'none';
  mainButton(r.youAreSpy ? 'เปิดตัว & ทายสถานที่' : null, revealSelf);
}

/**
 * โหวตกล่าวหา — ไม่เปิดเผยว่าใครเป็นคนกล่าวหา แสดงแค่คนที่ถูกกล่าวหา
 * ผ่านเมื่อเห็นด้วยเกินครึ่งของผู้มีสิทธิ์โหวต ใครไม่กดถือว่างดออกเสียง
 */
function renderVote(v) {
  show('vote');
  backButton(null);
  var vote = v.vote;
  var isTarget = (v.you === vote.targetId);
  var done = vote.youVoted || isTarget;

  var av = $('vote-av');
  av.innerHTML = '';
  av.appendChild(avOf(vote.targetId, true));

  $('vote-title').textContent = isTarget ? 'คุณถูกกล่าวหา' : nameOf(vote.targetId) + ' ถูกกล่าวหา';
  $('vote-sub').textContent = isTarget
    ? 'รอผลโหวต ถ้าเห็นด้วยเกินครึ่งจะถือว่าจับคุณได้'
    : done ? 'โหวตแล้ว รอคนอื่นให้ครบ'
           : 'เขาคือสายลับไหม? ต้องเห็นด้วย ' + vote.need + ' จาก ' + vote.eligible + ' เสียงถึงจะผ่าน';

  // จอนี้ใช้ร่วมกับอินไซเดอร์ซึ่งเปลี่ยนข้อความปุ่มไป ต้องตั้งกลับทุกครั้ง
  $('btn-vote-yes').textContent = 'ใช่ เขาคือสายลับ';
  $('btn-vote-yes').style.display = done ? 'none' : 'block';
  $('btn-vote-no').style.display = done ? 'none' : 'block';
  $('vote-progress').textContent = 'โหวตแล้ว ' + vote.voted + '/' + vote.eligible + ' คน';
  mainButton(done ? null : 'ใช่ เขาคือสายลับ', function () { castVote(true); });
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
    $('guess-title').textContent = iAmSpy ? 'คุณถูกจับได้' : 'จับได้! ' + spy + ' คือสายลับ';
    $('guess-sub').textContent = iAmSpy
      ? 'โอกาสสุดท้าย — ทายถูกได้ 1 คะแนน พลิกกลับมาชนะ · ผิดหรือไม่ทัน แพ้'
      : 'ยังไม่จบ ' + spy + ' ขอทายสถานที่แก้ตัว — ถ้าทายผิด ผู้กล่าวหาได้ 2 คนโหวตถูกได้ 1';
  } else {
    $('guess-title').textContent = iAmSpy ? 'คุณเปิดตัวแล้ว' : spy + ' เปิดตัวว่าเป็นสายลับ';
    $('guess-sub').textContent = iAmSpy
      ? 'ทายถูกได้ 2 คะแนน ชนะทันที · ผิดหรือเลือกไม่ทัน = แพ้'
      : 'เปิดตัวเองแล้ว กำลังเลือกสถานที่ — ถ้าทายผิด ผู้เล่นชนะ';
  }

  $('guess-pick').style.display = iAmSpy ? 'block' : 'none';
  if (iAmSpy) buildGuessList();
}

/* ================= อินไซเดอร์ ================= */

/**
 * เฟสถามตอบ — มาสเตอร์เปิดเผยตัวตั้งแต่ต้น
 * ปุ่มชี้ว่าใครทายคำถูกมีเฉพาะมาสเตอร์ เพราะมีเขาคนเดียวที่รู้ว่าคำนั้นถูกไหม
 */
function renderInsider(v) {
  show('insider');
  backButton(null);
  var r = v.round;

  if (secretRound !== v.roundNo) { secretRound = v.roundNo; insSecret(false); }

  var iAmMaster = r.youAreMaster;
  $('ins-front').classList.toggle('is-spy', r.youAreInsider);
  $('ins-front').classList.toggle('is-master', iAmMaster);
  $('ins-main').textContent = r.word || 'คุณคือชาวบ้าน';
  $('ins-role').textContent = iAmMaster
    ? 'คุณคือมาสเตอร์ · ตอบได้แค่ ใช่ / ไม่ใช่ / ไม่เกี่ยว'
    : r.youAreInsider
      ? 'คุณคืออินไซเดอร์ · พาให้เขาทายถูกโดยไม่โดนจับ'
      : 'ยังไม่รู้คำ ช่วยกันถามให้ออกก่อนหมดเวลา';

  $('ins-master').textContent = iAmMaster
    ? 'ทุกคนรู้แล้วว่าคุณคือมาสเตอร์'
    : nameOf(r.masterId) + ' คือมาสเตอร์ ถามเขาได้เลย';

  $('ins-found-card').style.display = iAmMaster ? 'block' : 'none';
  if (iAmMaster) {
    var grid = $('ins-found');
    grid.innerHTML = '';
    v.players.forEach(function (p) {
      if (p.id === r.masterId) return;          // มาสเตอร์รู้คำอยู่แล้ว
      var b = document.createElement('button');
      b.className = 'pbtn';
      b.appendChild(avEl(p.name, false, p.av));
      var nm = document.createElement('span');
      nm.textContent = p.name;
      b.appendChild(nm);
      b.onclick = function () {
        ask(p.name + ' ทายคำถูกใช่ไหม? กดแล้วจะเข้าสู่ช่วงหาอินไซเดอร์ทันที', function () {
          haptic('medium');
          act('found', { code: CODE, targetId: p.id }).then(apply, fail);
        });
      };
      grid.appendChild(b);
    });
  }

  $('ins-hint').textContent = 'ถ้าหมดเวลาโดยไม่มีใครทายถูก แพ้กันทั้งวง รวมอินไซเดอร์ด้วย';
  mainButton(null);
}

function insSecret(open) {
  $('ins-secret').classList.toggle('open', open);
}

/** โหวตรอบแรก — คนที่ทายคำถูกคืออินไซเดอร์หรือเปล่า ใช้จอโหวตร่วมกับ Spyfall */
function renderInsiderVote(v) {
  show('vote');
  backButton(null);
  var vote = v.vote;
  var isTarget = !vote.youMayVote;
  var done = vote.youVoted || isTarget;

  var av = $('vote-av');
  av.innerHTML = '';
  av.appendChild(avOf(vote.targetId, true));

  $('vote-title').textContent = isTarget
    ? 'คุณคือคนที่ทายคำถูก'
    : nameOf(vote.targetId) + ' ทายคำถูก';
  $('vote-sub').textContent = isTarget
    ? 'ตอนนี้ทุกคนกำลังตัดสินว่าคุณคืออินไซเดอร์หรือเปล่า'
    : done ? 'โหวตแล้ว รอคนอื่นให้ครบ'
           : 'เขาคืออินไซเดอร์ไหม? ต้องเห็นด้วย ' + vote.need + ' จาก ' + vote.eligible +
             ' เสียง · ไม่ถึงเกณฑ์แล้วจะได้ชี้ตัวกันต่อ';

  $('btn-vote-yes').textContent = 'ใช่ เขาคืออินไซเดอร์';
  $('btn-vote-yes').style.display = done ? 'none' : 'block';
  $('btn-vote-no').style.display = done ? 'none' : 'block';
  $('vote-progress').textContent = 'โหวตแล้ว ' + vote.voted + '/' + vote.eligible + ' คน';
  mainButton(done ? null : 'ใช่ เขาคืออินไซเดอร์', function () { castVote(true); });
}

/** ชี้ตัวอินไซเดอร์ — เสียงมากสุดชนะ ไม่ต้องเกินครึ่ง */
function renderHunt(v) {
  show('hunt');
  backButton(null);
  mainButton(null);
  var h = v.hunt;
  var done = !!h.yours;

  $('hunt-title').textContent = 'หาตัวอินไซเดอร์';
  $('hunt-sub').textContent = done
    ? 'เลือก ' + nameOf(h.yours) + ' แล้ว รอคนอื่นให้ครบ'
    : 'เสียงมากที่สุดถูกกล่าวหา ไม่ต้องเกินครึ่ง · ' +
      nameOf(v.round.masterId) + ' กับ ' + nameOf(v.round.guesserId) + ' เปิดไพ่ไปแล้ว จึงไม่อยู่ในตัวเลือก';
  $('hunt-label').textContent = 'เลือกคนที่คุณคิดว่าเป็นอินไซเดอร์';

  var grid = $('hunt-grid');
  grid.innerHTML = '';
  h.targets.forEach(function (id) {
    var p = playerById(id);
    var b = document.createElement('button');
    b.className = 'pbtn' + (h.yours === id ? ' picked' : '');
    b.appendChild(avEl(p ? p.name : nameOf(id), false, p ? p.av : 0));
    var nm = document.createElement('span');
    nm.textContent = p ? p.name : nameOf(id);
    b.appendChild(nm);
    b.disabled = done;
    b.onclick = function () {
      ask('ชี้ ' + (p ? p.name : nameOf(id)) + ' ว่าเป็นอินไซเดอร์?', function () {
        haptic('medium');
        act('hunt', { code: CODE, targetId: id }).then(apply, fail);
      });
    };
    grid.appendChild(b);
  });
  $('hunt-progress').textContent = 'ชี้แล้ว ' + h.voted + '/' + h.eligible + ' คน';
}

/** คะแนนเสมอ — คนที่ทายคำถูกเป็นผู้ตัดสิน ใช้จอเดียวกับการชี้ตัว */
function renderTiebreak(v) {
  show('hunt');
  backButton(null);
  mainButton(null);
  var t = v.tie;

  $('hunt-title').textContent = 'คะแนนเสมอกัน';
  $('hunt-sub').textContent = t.youDecide
    ? 'คุณคือคนที่ทายคำถูก คุณเป็นคนตัดสินว่าจะเอาใคร'
    : nameOf(t.deciderId) + ' เป็นคนตัดสิน เพราะเขาคือคนที่ทายคำถูก';
  $('hunt-label').textContent = t.youDecide ? 'เลือกหนึ่งคน' : 'ผู้เข้าชิง';

  var grid = $('hunt-grid');
  grid.innerHTML = '';
  t.candidates.forEach(function (id) {
    var p = playerById(id);
    var b = document.createElement('button');
    b.className = 'pbtn';
    b.appendChild(avEl(p ? p.name : nameOf(id), false, p ? p.av : 0));
    var nm = document.createElement('span');
    nm.textContent = p ? p.name : nameOf(id);
    b.appendChild(nm);
    b.disabled = !t.youDecide;
    b.onclick = function () {
      ask('ตัดสินว่า ' + (p ? p.name : nameOf(id)) + ' คืออินไซเดอร์?', function () {
        haptic('heavy');
        act('tiebreak', { code: CODE, targetId: id }).then(apply, fail);
      });
    };
    grid.appendChild(b);
  });
  $('hunt-progress').textContent = t.youDecide
    ? 'ไม่ตัดสินทันเวลา อินไซเดอร์จะรอดไป'
    : 'รอ ' + nameOf(t.deciderId) + ' ตัดสิน';
}

/* ================= Undercover ================= */

/** รอบคำใบ้ — คำของตัวเอง ลำดับพูด แล้วโหวตคัดออก */
function renderClue(v) {
  show('clue');
  backButton(null);
  mainButton(null);
  var r = v.round;
  var vote = v.vote;

  if (secretRound !== v.roundNo) { secretRound = v.roundNo; clueSecret(false); }

  $('clue-word').textContent = r.word;
  $('clue-turn').textContent = 'รอบที่ ' + r.turn;

  setNotice($('clue-notice'), r.lastOut
    ? nameOf(r.lastOut.id) + ' ถูกคัดออก' +
      (r.lastOut.byTie ? ' (คะแนนเสมอ จับสลาก)' : '') + ' — ' +
      (r.lastOut.wasUnder ? 'เขาคือสายลับ!' : 'เขาเป็นชาวบ้าน')
    : '');

  var ol = $('clue-order');
  ol.innerHTML = '';
  r.order.forEach(function (id, i) {
    var p = playerById(id);
    var li = document.createElement('li');
    var no = document.createElement('span');
    no.className = 'ord';
    no.textContent = (i + 1);
    li.appendChild(no);
    li.appendChild(avEl(p ? p.name : nameOf(id), false, p ? p.av : 0));
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p ? p.name : nameOf(id);
    li.appendChild(nm);
    if (id === v.you) li.appendChild(tagEl('คุณ', 'you'));
    ol.appendChild(li);
  });

  $('clue-vote-card').style.display = r.youAreOut ? 'none' : 'block';
  var grid = $('clue-grid');
  grid.innerHTML = '';
  if (!r.youAreOut) {
    r.order.forEach(function (id) {
      if (id === v.you) return;                  // โหวตตัวเองไม่ได้
      var p = playerById(id);
      var b = document.createElement('button');
      b.className = 'pbtn' + (vote.yours === id ? ' picked' : '');
      b.appendChild(avEl(p ? p.name : nameOf(id), false, p ? p.av : 0));
      var nm = document.createElement('span');
      nm.textContent = p ? p.name : nameOf(id);
      b.appendChild(nm);
      b.disabled = !!vote.yours;
      b.onclick = function () {
        ask('โหวตคัด ' + (p ? p.name : nameOf(id)) + ' ออก?', function () {
          haptic('medium');
          // ส่งเลขรอบไปด้วย ถ้ารอบปิดไปพอดีตอนกด เซิร์ฟเวอร์จะปฏิเสธแทนที่จะเอาไปนับในรอบใหม่
          act('vote', { code: CODE, targetId: id, turn: r.turn }).then(apply, fail);
        });
      };
      grid.appendChild(b);
    });
  }
  $('clue-hint').textContent = vote.yours
    ? 'โหวต ' + nameOf(vote.yours) + ' ไปแล้ว เปลี่ยนไม่ได้'
    : 'พูดคำใบ้ให้ครบทุกคนก่อน แล้วค่อยโหวต · เสมอกันจะจับสลาก';

  $('clue-progress').textContent = r.youAreOut
    ? 'คุณถูกคัดออกแล้ว ดูอย่างเดียวจนจบรอบ'
    : 'โหวตแล้ว ' + vote.voted + '/' + vote.eligible + ' คน · เหลือในเกม ' + r.alive + ' คน';
}

function clueSecret(open) {
  $('clue-secret').classList.toggle('open', open);
}

/** เข้ามากลางเกม — เห็นแค่ว่าใครเล่นอยู่ ไม่เห็นความลับอะไรทั้งนั้น */
function renderWaiting(v) {
  show('wait');
  backButton(null);

  $('wait-code').textContent = v.code;
  var ready = (v.phase === 'reveal' || v.phase === 'lobby');
  $('wait-sub').textContent = ready
    ? 'รอบนี้จบแล้ว กดเริ่มรอบต่อไปได้เลย คุณจะได้เล่นด้วย'
    : 'เกมกำลังเล่นอยู่ พอจบรอบนี้คุณจะได้เล่นรอบถัดไป';

  $('wait-count').textContent = v.players.length + ' คน';
  var ul = $('wait-players');
  ul.innerHTML = '';
  v.players.forEach(function (p) {
    var li = document.createElement('li');
    li.appendChild(avEl(p.name, false, p.av));
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    li.appendChild(nm);
    var pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = p.score;
    li.appendChild(pts);
    ul.appendChild(li);
  });

  // คนอื่นที่รออยู่ด้วยกัน ถ้ามีแค่เราคนเดียวก็ไม่ต้องโชว์การ์ดนี้
  var queue = (v.waiting || []).filter(function (p) { return p.id !== v.you; });
  $('wait-queue-card').style.display = queue.length ? 'block' : 'none';
  var q = $('wait-queue');
  q.innerHTML = '';
  queue.forEach(function (p) {
    var li = document.createElement('li');
    li.appendChild(avEl(p.name, false, p.av));
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    li.appendChild(nm);
    q.appendChild(li);
  });

  $('btn-wait-start').style.display = ready ? 'block' : 'none';
  mainButton(ready ? 'เริ่มรอบต่อไป' : null, startRound);
}

/* ---------- ผลรอบ ----------
 *
 * โครงจอเหมือนกันทุกเกม ต่างกันแค่ข้อความ ป้ายข้างชื่อ และใครชนะ
 * แต่ละเกมคืน { side, title, sub, tag, iWon }
 *   side  'players' = ฝ่ายคนเยอะชนะ · 'spy' = ฝ่ายที่ซ่อนอยู่ชนะ · 'none' = ไม่มีใครชนะ
 *   iWon  ผู้เล่นคนนี้ชนะไหม ใช้เลือกเสียง ไม่ใช่ดูจากฝั่งอย่างเดียว
 *         เพราะสายลับที่รอดต้องได้ยินเสียงชนะ ทั้งที่ "ผู้เล่น" แพ้
 */

function spyfallResult(v, res) {
  var spy = nameOf(res.spyId);
  var t = {
    spy_caught:       ['players', 'ผู้เล่นชนะ', 'จับสายลับได้ และ ' + spy +
                       (res.guess ? ' ทายแก้ตัวผิด (ทาย ' + res.guess + ')' : ' ทายแก้ตัวไม่ทัน') +
                       ' · สถานที่คือ ' + res.location],
    wrong_accusation: ['spy', 'สายลับชนะ', 'โหวตผ่านแต่จับผิดคน ' + nameOf(res.targetId) +
                       ' ไม่ใช่สายลับ — สายลับคือ ' + spy + ' · สถานที่คือ ' + res.location],
    spy_survived:     ['spy', 'สายลับรอด', 'หมดเวลาโดยไม่ถูกจับ — สายลับคือ ' + spy +
                       ' · สถานที่คือ ' + res.location],
    spy_guessed:      res.comeback
      ? ['spy', 'สายลับพลิกกลับมาชนะ', spy + ' โดนจับได้ แต่ทายถูก: ' + res.location]
      : ['spy', 'สายลับชนะ', spy + ' เปิดตัวเองแล้วทายถูก: ' + res.location],
    spy_wrong_guess:  ['players', 'ผู้เล่นชนะ', spy + ' เปิดตัวเองแล้วทายผิด (ทาย ' + res.guess +
                       ') — ที่จริงคือ ' + res.location],
    spy_no_guess:     ['players', 'ผู้เล่นชนะ', spy + ' เปิดตัวเองแล้วทายไม่ทัน — สถานที่คือ ' + res.location]
  }[res.type] || ['none', 'จบรอบ', ''];

  var iAmSpy = (res.spyId === v.you);
  return {
    side: t[0], title: t[1], sub: t[2],
    iWon: (t[0] !== 'players') === iAmSpy,
    tag: function (p) { return p.id === res.spyId ? [['สายลับ', 'spy']] : []; }
  };
}

function insiderResult(v, res) {
  var ins = nameOf(res.insiderId);
  var guesser = nameOf(res.guesserId);
  var tail = ' · คำคือ ' + res.word;
  var t;

  if (res.type === 'no_answer') {
    t = ['none', 'แพ้กันทั้งวง', 'หมดเวลาโดยไม่มีใครทายคำถูก — อินไซเดอร์คือ ' + ins + tail];
  } else if (res.type === 'insider_caught') {
    t = ['players', 'ชาวบ้านชนะ', {
      vote1:    'โหวตรอบแรกเกินครึ่ง และ ' + guesser + ' คืออินไซเดอร์จริง' + tail,
      hunt:     'ชี้ตัวถูก อินไซเดอร์คือ ' + ins + tail,
      tiebreak: 'คะแนนเสมอ แล้ว ' + guesser + ' ตัดสินถูก อินไซเดอร์คือ ' + ins + tail
    }[res.by] || ('จับอินไซเดอร์ได้ — ' + ins + tail)];
  } else {
    t = ['spy', 'อินไซเดอร์ชนะ', {
      vote1:           'โหวตเกินครึ่งแต่กล่าวหาผิดคน ' + guesser + ' เป็นชาวบ้าน — อินไซเดอร์คือ ' + ins + tail,
      guesser_slipped: guesser + ' ทายคำถูกและเป็นอินไซเดอร์จริง แต่เสียงโหวตไม่ถึงเกินครึ่ง เลยรอดไป' + tail,
      hunt:            'ชี้ตัวผิด อินไซเดอร์คือ ' + ins + tail,
      tiebreak:        'คะแนนเสมอ แล้ว ' + guesser + ' ตัดสินผิด อินไซเดอร์คือ ' + ins + tail,
      tie_timeout:     'คะแนนเสมอแต่ ' + guesser + ' ตัดสินไม่ทัน อินไซเดอร์คือ ' + ins + tail,
      no_hunt:         'ไม่มีใครชี้ตัวเลย อินไซเดอร์คือ ' + ins + tail
    }[res.by] || ('จับอินไซเดอร์ไม่ได้ — ' + ins + tail)];
  }

  var iAmInsider = (res.insiderId === v.you);
  return {
    side: t[0], title: t[1], sub: t[2],
    iWon: res.type === 'insider_caught' ? !iAmInsider
        : res.type === 'insider_escaped' ? iAmInsider
        : false,                               // ไม่มีใครทายคำได้ = แพ้กันหมด
    tag: function (p) {
      var out = [];
      if (p.id === res.masterId) out.push(['มาสเตอร์', 'host']);
      if (p.id === res.insiderId) out.push(['อินไซเดอร์', 'spy']);
      if (p.id === res.guesserId) out.push(['ทายคำถูก', 'you']);
      return out;
    }
  };
}

function undercoverResult(v, res) {
  var names = res.underIds.map(nameOf).join(' และ ');
  var tail = ' · ชาวบ้าน "' + res.civWord + '" · สายลับ "' + res.underWord + '"';
  var t = res.type === 'civ_win'
    ? ['players', 'ชาวบ้านชนะ', 'คัดสายลับออกได้หมด — สายลับคือ ' + names + tail]
    : ['spy', 'สายลับชนะ', (res.by === 'no_vote'
        ? 'ไม่มีใครโหวตเลยจนหมดเวลา สายลับเลยรอด — '
        : 'เหลือคนน้อยจนสายลับไล่ทันชาวบ้าน — ') + 'สายลับคือ ' + names + tail];

  var iAmUnder = res.underIds.indexOf(v.you) >= 0;
  return {
    side: t[0], title: t[1], sub: t[2],
    iWon: (res.type === 'civ_win') !== iAmUnder,
    tag: function (p) {
      var out = [];
      if (res.underIds.indexOf(p.id) >= 0) out.push(['สายลับ', 'spy']);
      if (res.out.indexOf(p.id) >= 0) out.push(['ถูกคัดออก', 'out']);
      return out;
    }
  };
}

function renderResult(v) {
  show('result');
  backButton(null);
  var res = v.result;
  var t = ui(v).result(v, res);

  var badge = $('result-emoji');
  badge.className = 'verdict-badge ' + t.side;
  badge.textContent = t.side === 'players' ? '\u2713' : t.side === 'spy' ? '\u2715' : '\u2013';
  $('result-title').textContent = t.title;
  $('result-sub').textContent = t.sub;

  var ul = $('result-scores');
  ul.innerHTML = '';
  v.players.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (p) {
    var li = document.createElement('li');
    li.appendChild(avEl(p.name, false, p.av));
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    li.appendChild(nm);
    t.tag(p).forEach(function (pair) { li.appendChild(tagEl(pair[0], pair[1])); });
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

  // เสียงแพ้ชนะ ครั้งเดียวต่อรอบ ตัดสินจากมุมของผู้เล่นคนนี้เอง
  if (soundedRound !== v.roundNo) {
    soundedRound = v.roundNo;
    if (t.iWon) winSound(); else loseSound();
  }

  var label = 'เริ่มรอบที่ ' + (v.roundNo + 1);
  var queued = (v.waiting || []).length;
  $('result-wait').textContent = queued
    ? 'มีคนรอเล่นอยู่ ' + queued + ' คน — กดเริ่มรอบต่อไปแล้วเขาจะได้ลงเล่นด้วย'
    : 'ใครก็ได้ในห้องกดเริ่มรอบต่อไป';
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
  // แต่ละเกมบอกเองว่าเฟสนี้ต้องจับเวลาอะไรไปแสดงที่ไหน [elId, barId, endsAt, total, warnSec]
  var c = ui(VIEW).clock(VIEW);
  if (!c) return;
  var left = paintClock($(c[0]), $(c[1]), c[2], c[3], c[4]);

  // เตือนนาทีสุดท้ายเฉพาะช่วงเล่นยาว ๆ ไม่ใช่หน้าต่างตัดสินใจสั้น ๆ
  // Undercover มีหลายรอบในหนึ่งเกม จึงนับแยกรายรอบคำใบ้ด้วย
  if (c[4] < 60) return;
  var key = VIEW.roundNo + ':' + ((VIEW.round && VIEW.round.turn) || 0);
  if (left <= 60 && left > 0 && warnedRound !== key) {
    warnedRound = key;
    lastMinuteWarning();
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

/* ---------- ตัวเลือกเกมบนหน้าแรก ----------
 * มีผลตอนสร้างห้องใหม่เท่านั้น การเข้าร่วมห้องใช้เกมของห้องนั้นเสมอ
 */

function buildGamePicker() {
  var box = $('game-picker');
  box.innerHTML = '';
  GAMES.forEach(function (g) {
    var b = document.createElement('button');
    b.className = 'game-chip' + (g.id === MY_GAME ? '' : ' off');
    var nm = document.createElement('span');
    nm.className = 'g-name';
    nm.textContent = g.short || g.name;
    var sub = document.createElement('span');
    sub.className = 'g-min';
    sub.textContent = g.min + '–' + g.max + ' คน';
    b.appendChild(nm);
    b.appendChild(sub);
    b.onclick = function () {
      haptic();
      MY_GAME = g.id;
      try { localStorage.setItem('sf_game', g.id); } catch (e) {}
      buildGamePicker();
      paintHomeGame();
      syncHomeButton();
    };
    box.appendChild(b);
  });
}

/** ชื่อ คำโปรย และวิธีเล่นบนหน้าแรก เปลี่ยนตามเกมที่เลือก */
function paintHomeGame() {
  var g = metaOf(MY_GAME);
  var u = GAME_UI[MY_GAME] || GAME_UI.spyfall;
  $('wordmark').innerHTML = '';
  $('wordmark').appendChild(document.createTextNode(u.wordmark[0]));
  var em = document.createElement('span');
  em.textContent = u.wordmark[1];
  $('wordmark').appendChild(em);
  $('tagline').textContent = g.tagline;

  var ol = $('home-rules');
  ol.innerHTML = '';
  u.rules.forEach(function (html) {
    var li = document.createElement('li');
    li.innerHTML = html;      // ข้อความคงที่ในไฟล์นี้เอง ไม่ได้มาจากผู้ใช้หรือเซิร์ฟเวอร์
    ol.appendChild(li);
  });
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
  act('create', { game: MY_GAME }).then(enter, fail);
}

function joinRoom(code) {
  if (!myName()) return;
  code = cleanCode(code || $('input-code').value);
  if (code.length !== 4) { toast('รหัสห้องมี 4 ตัวอักษร'); return; }
  haptic();
  act('join', { code: code }).then(enter, fail);
}

function castVote(yes) {
  haptic(yes ? 'medium' : 'light');
  act('vote', { code: CODE, yes: yes }).then(apply, fail);
}

/** ถามยืนยันก่อนเริ่มเสมอ เพราะระหว่างรอเริ่มมีคนเข้าออกห้องได้ กดพลาดแล้วตัดคนที่กำลังจะเข้า */
function startRound() {
  var n = VIEW ? VIEW.players.length : 0;
  var q = VIEW && VIEW.waiting ? VIEW.waiting.length : 0;
  ask('เริ่ม' + metaOf(VIEW && VIEW.game).name + 'เลยไหม? ตอนนี้มี ' + (n + q) + ' คนในห้อง', function () {
    haptic('medium');
    act('start', { code: CODE }).then(apply, fail);
  });
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
  var text = 'มาเล่น ' + metaOf(VIEW && VIEW.game).name + ' กัน! รหัสห้อง ' + CODE;
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
$('btn-vote-yes').onclick = function () { castVote(true); };
$('btn-vote-no').onclick = function () { castVote(false); };
$('btn-open-guess').onclick = revealSelf;
$('secret').onclick = function () {
  haptic();
  showSecret(!$('secret').classList.contains('open'));
};
$('ins-secret').onclick = function () {
  haptic();
  insSecret(!$('ins-secret').classList.contains('open'));
};
$('clue-secret').onclick = function () {
  haptic();
  clueSecret(!$('clue-secret').classList.contains('open'));
};
$('btn-cancel-deal').onclick = function () {
  ask('ยกเลิกการแจกไพ่ กลับไปล็อบบี้?', function () {
    act('canceldeal', { code: CODE }).then(apply, fail);
  });
};
$('btn-leave').onclick = $('btn-leave-game').onclick = $('btn-leave-result').onclick =
  $('btn-leave-wait').onclick = $('btn-leave-ins').onclick = $('btn-leave-clue').onclick = leaveRoom;
$('btn-wait-start').onclick = startRound;
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
  try { MY_GAME = localStorage.getItem('sf_game') || 'spyfall'; } catch (e) {}

  api('hello', {
    initData: (tg && tg.initData) || '',
    uid: saved && saved.uid,
    sig: saved && saved.sig,
    name: $('input-name').value
  }).then(function (res) {
    if (!res || !res.ok) { fail(res && res.error); goHome(); return; }
    ME = res.me;
    LOCS = res.locations;
    GAMES = res.games || [];
    INVITE = res.invite || '';
    // เซิร์ฟเวอร์ไม่รู้จักเกมที่เคยเลือกไว้ (เช่นถูกถอดออก) ให้กลับไปเกมแรก
    if (!GAMES.some(function (g) { return g.id === MY_GAME; })) {
      MY_GAME = GAMES.length ? GAMES[0].id : 'spyfall';
    }
    buildGamePicker();
    paintHomeGame();
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
