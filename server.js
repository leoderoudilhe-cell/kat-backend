// ═══════════════════════════════════════
//  KAT SERVER v3 — final clean version
// ═══════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const webpush = require('web-push');

// VAPID keys for Web Push
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BFj2fRxIbJPviw6ek-ePKX5tNIqhObeco3N4AcMtThMNgRaJDo7nBvV59U7FPsSiyjcsuWxUhO-KYW68wv5z5kA';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'nxAwS9GO872i7LOt8W-ScK37y9HiWuiePmd762SKwXc';
webpush.setVapidDetails('mailto:kat@app.com', VAPID_PUBLIC, VAPID_PRIVATE);

let _pushSubs = [];

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kat.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadPushSubs() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      _pushSubs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      console.log(`📲 Loaded ${_pushSubs.length} push subscription(s)`);
    }
  } catch(e) { _pushSubs = []; }
}

function savePushSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(_pushSubs)); } catch(e) {}
}

const DEFAULT = {
  events:{}, todos:{}, journal:{}, settings:{},
  cats:[
    {id:'work',   name:'Travail',   color:'#007AFF',emoji:'💼'},
    {id:'sport',  name:'Sport',     color:'#34C759',emoji:'🏃'},
    {id:'perso',  name:'Personnel', color:'#8B5CF6',emoji:'👤'},
    {id:'leisure',name:'Loisirs',   color:'#FF9500',emoji:'🎮'},
    {id:'health', name:'Santé',     color:'#FF3B30',emoji:'❤️'},
    {id:'social', name:'Social',    color:'#5AC8FA',emoji:'👥'},
  ],
};

let _cachedData = null;
function loadData() {
  if (_cachedData) return _cachedData;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      _cachedData = d;
      return d;
    }
  } catch(e) { console.warn('load error:', e.message); }
  _cachedData = JSON.parse(JSON.stringify(DEFAULT));
  return _cachedData;
}

// Debounce GitHub persistence (avoid too many API calls)
let _ghPersistTimer = null;
function saveData(d) {
  try {
    d._pushSubs = _pushSubs;
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  } catch(e) { console.warn('save error:', e.message); }
  updateGithubICS(d.events || {}).catch(() => {});
  // Debounced GitHub data persistence (every 10s max)
  clearTimeout(_ghPersistTimer);
  _ghPersistTimer = setTimeout(() => persistDataToGitHub(d).catch(()=>{}), 10000);
}

// GitHub credentials for static iCal hosting
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = 'leoderoudilhe-cell';
const GH_REPO  = 'kat-backend';
const GH_ICS_PATH = 'public/kat.ics';
let _icsSha = null; // cached SHA for updates

function ghPut(filePath, content, sha) {
  return new Promise((resolve, reject) => {
    if (!GH_TOKEN) return resolve(null);
    const body = JSON.stringify({
      message: 'KAT calendar update',
      content: Buffer.from(content).toString('base64'),
      ...(sha ? { sha } : {}),
    });
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
      method: 'PUT',
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'KAT/3.0',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getIcsSha() {
  if (_icsSha) return _icsSha;
  try {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_ICS_PATH}`,
      method: 'GET',
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'KAT/3.0',
      },
    };
    const res = await new Promise((resolve, reject) => {
      const req = https.request(opts, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve({ status: r.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: r.statusCode, body: {} }); } });
      });
      req.on('error', reject);
      req.end();
    });
    if (res.status === 200 && res.body.sha) {
      _icsSha = res.body.sha;
      return _icsSha;
    }
  } catch(e) {}
  return null;
}

async function updateGithubICS(events) {
  if (!GH_TOKEN) return;
  const icsContent = buildICS(events);
  const sha = await getIcsSha();
  const result = await ghPut(GH_ICS_PATH, icsContent, sha);
  if (result && (result.status === 200 || result.status === 201)) {
    _icsSha = result.body?.content?.sha || sha;
    console.log('✅ GitHub kat.ics updated');
  } else {
    console.warn('GitHub ICS update failed:', result?.status);
    _icsSha = null;
  }
}

// Persist ALL app data to GitHub (survives Render restarts)
const GH_DATA_PATH = 'data/app.json';
let _dataSha = null;

async function persistDataToGitHub(data) {
  if (!GH_TOKEN) return;
  try {
    // Get current SHA
    if (!_dataSha) {
      const r = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.github.com',
          path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_PATH}`,
          method: 'GET',
          headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'KAT/3.0' }
        }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({s:res.statusCode,b:JSON.parse(d)});}catch{resolve({s:res.statusCode,b:{}}); }}); });
        req.on('error', reject);
        req.end();
      });
      if (r.s === 200) _dataSha = r.b.sha;
    }
    // Upload data (strip photos to keep size manageable)
    const clean = { ...data };
    if (clean.journal) {
      clean.journal = Object.fromEntries(Object.entries(clean.journal).map(([k,v])=>[k,{...v,photos:undefined}]));
    }
    delete clean._pushSubs;
    const body = JSON.stringify({ message: 'KAT data', content: Buffer.from(JSON.stringify(clean)).toString('base64'), ..._dataSha ? {sha: _dataSha} : {} });
    const result = await new Promise((resolve, reject) => {
      const b = Buffer.from(body);
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_PATH}`,
        method: 'PUT',
        headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'KAT/3.0', 'Content-Type': 'application/json', 'Content-Length': b.length }
      }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({s:res.statusCode,b:JSON.parse(d)});}catch{resolve({s:res.statusCode,b:{}}); }}); });
      req.on('error', reject);
      req.write(b);
      req.end();
    });
    if (result.s === 200 || result.s === 201) {
      _dataSha = result.b.content?.sha || _dataSha;
      console.log('✅ Data persisted to GitHub');
    } else if (result.s === 409 || result.s === 422) {
      // SHA conflict — reset and retry once
      _dataSha = null;
      console.warn('GitHub data conflict, resetting SHA...');
    }
  } catch(e) { console.warn('GitHub persist error:', e.message); }
}

// Load data from GitHub on startup (before reading file)
async function loadFromGitHub() {
  if (!GH_TOKEN) return null;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_PATH}`,
        method: 'GET',
        headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'KAT/3.0' }
      }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({s:res.statusCode,b:JSON.parse(d)});}catch{resolve({s:res.statusCode,b:{}});}});}); 
      req.on('error', reject);
      req.end();
    });
    if (r.s === 200 && r.b.content) {
      const data = JSON.parse(Buffer.from(r.b.content, 'base64').toString('utf8'));
      _dataSha = r.b.sha;
      console.log('✅ Data loaded from GitHub');
      return data;
    }
  } catch(e) { console.warn('GitHub load error:', e.message); }
  return null;
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Force fresh HTML — prevents stale app on mobile
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── Cat head SVG icon ──
const CAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#8B5CF6"/>
  <polygon points="18,42 12,16 36,34" fill="#A78BFA"/>
  <polygon points="82,42 88,16 64,34" fill="#A78BFA"/>
  <polygon points="20,40 15,20 34,34" fill="#DDD6FE"/>
  <polygon points="80,40 85,20 66,34" fill="#DDD6FE"/>
  <circle cx="50" cy="60" r="30" fill="white"/>
  <ellipse cx="38" cy="54" rx="5.5" ry="6.5" fill="#1a0533"/>
  <ellipse cx="62" cy="54" rx="5.5" ry="6.5" fill="#1a0533"/>
  <circle cx="40" cy="52" r="1.8" fill="white"/>
  <circle cx="64" cy="52" r="1.8" fill="white"/>
  <ellipse cx="50" cy="65" rx="2.5" ry="2" fill="#F9A8D4"/>
  <path d="M46 69 Q50 73 54 69" stroke="#E9D5FF" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <line x1="14" y1="62" x2="36" y2="63" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
  <line x1="14" y1="67" x2="36" y2="66" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
  <line x1="64" y1="63" x2="86" y2="62" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
  <line x1="64" y1="66" x2="86" y2="67" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
</svg>`;

app.get('/icon.svg', (_, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(CAT_SVG);
});

app.get('/manifest.json', (_, res) => {
  const iconDataUri = 'data:image/svg+xml,' + encodeURIComponent(CAT_SVG);
  res.json({
    name: 'KAT',
    short_name: 'KAT',
    description: 'Agenda personnel de KAT 🐱',
    start_url: '/',
    display: 'standalone',
    background_color: '#8B5CF6',
    theme_color: '#8B5CF6',
    orientation: 'portrait',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: iconDataUri, sizes: '192x192', type: 'image/svg+xml' },
      { src: iconDataUri, sizes: '512x512', type: 'image/svg+xml' }
    ]
  });
});


let _dataModifiedTs = Date.now();
app.get('/api/ping', (_, res) => res.json({ ok: true, ts: _dataModifiedTs }));

app.get('/api/data', (_, res) => {
  const d = loadData();
  if (!d._updatedAt) d._updatedAt = _dataModifiedTs;
  res.json(d);
});

app.post('/api/data', (req, res) => {
  try {
    const d = loadData(), b = req.body;
    // Détection des events supprimés avant merge
    let deletedIds = [];
    if (b.events !== undefined) {
      const prevEvents = d.events || {};
      const prevIds = new Set();
      for (const evs of Object.values(prevEvents)) {
        if (Array.isArray(evs)) evs.forEach(ev => { if (ev.id) prevIds.add(ev.id); });
      }
      const newIds = new Set();
      for (const evs of Object.values(b.events || {})) {
        if (Array.isArray(evs)) evs.forEach(ev => { if (ev.id) newIds.add(ev.id); });
      }
      for (const id of prevIds) {
        if (!newIds.has(id)) deletedIds.push(id);
      }
    }
    if (b.events  !== undefined) {
      d.events = b.events;
      // Schedule event reminders via Web Push
      setTimeout(() => scheduleEventReminders(d.events), 100);
    }
    if (b.todos   !== undefined) d.todos   = b.todos;
    if (b.cats    !== undefined) d.cats    = b.cats;
    // Ne jamais écraser des données existantes avec une liste vide
    if (b.courses !== undefined) {
      const incomingItems = (b.courses.items || []).length;
      const existingItems = (d.courses && d.courses.items || []).length;
      if (incomingItems > 0 || existingItems === 0) d.courses = b.courses;
    }
    if (b.ptodos !== undefined) {
      if (b.ptodos.length > 0 || !d.ptodos || d.ptodos.length === 0) d.ptodos = b.ptodos;
    }
    if (b.settings !== undefined) d.settings = b.settings;
    if (b.journal !== undefined && b.journal !== null) {
      for (const [k, v] of Object.entries(b.journal))
        d.journal[k] = { mood: v.mood, text: v.text, date: v.date };
        // Include photos (max 500KB per entry to avoid giant files)
        if (Array.isArray(v.photos) && v.photos.length) {
          let photosStr = JSON.stringify(v.photos);
          d.journal[k].photos = photosStr.length < 500000 ? v.photos : v.photos.slice(0,2);
        }
    }
    saveData(d);
    // Batch CalDAV — debounced 3s to group rapid changes
    if (b.events !== undefined) {
      clearTimeout(app._icloudTimer);
      const eventsSnapshot = d.events;
      const deletedSnapshot = [...deletedIds];
      app._icloudTimer = setTimeout(() => {
        syncToiCloud(eventsSnapshot).catch(e => console.warn('iCloud sync failed:', e.message));
        deletedSnapshot.forEach(id => deleteFromiCloud(id).catch(() => {}));
        if (deletedSnapshot.length) console.log(`🗑️ iCloud delete: ${deletedSnapshot.join(', ')}`);
      }, 3000);
      setTimeout(() => scheduleEventReminders(d.events), 500);

      // Notification silencieuse aux autres appareils pour qu'ils synchent
      // (le SW va faire un fetch /api/data au reçu)
      if (_pushSubs.length > 0) {
        sendPushToAll('__sync__', 'sync', { tag: 'sync-' + Date.now(), silent: true }).catch(()=>{});
      }
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apple Calendar iCal feed
app.get('/ical', (_, res) => {
  const d = loadData();
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(buildICS(d.events || {}));
});

function esc(s) {
  return (s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\\;').replace(/\n/g,'\\n');
}
function toD(dk, t) {
  const [y,m,d] = dk.split('-').map(Number);
  const [h,mi]  = (t||'09:00').split(':').map(Number);
  const p = n => String(n).padStart(2,'0');
  return `${y}${p(m)}${p(d)}T${p(h)}${p(mi)}00`;
}
function nowStamp() {
  const n = new Date();
  const p = x => String(x).padStart(2,'0');
  return `${n.getUTCFullYear()}${p(n.getUTCMonth()+1)}${p(n.getUTCDate())}T${p(n.getUTCHours())}${p(n.getUTCMinutes())}${p(n.getUTCSeconds())}Z`;
}

// RFC 5545 line folding: max 75 octets per line
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let pos = 0;
  while (pos < bytes.length) {
    const limit = pos === 0 ? 75 : 74; // first line 75, continuation 74 (space takes 1)
    // Find a safe UTF-8 boundary
    let end = Math.min(pos + limit, bytes.length);
    while (end > pos && (bytes[end] & 0xC0) === 0x80) end--; // don't split multi-byte char
    parts.push((pos > 0 ? ' ' : '') + bytes.slice(pos, end).toString('utf8'));
    pos = end;
  }
  return parts.join('\r\n');
}

function buildICS(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KAT App//KAT Agenda//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:KAT',
  ];

  const push = (line) => lines.push(fold(line));

  const allEvs = [];
  for (const [dk, evs] of Object.entries(events)) {
    if (!Array.isArray(evs)) continue;
    evs.forEach(ev => { if (ev.title) allEvs.push({dk, ev}); });
  }

  // Placeholder — future event, proper UID format
  if (allEvs.length === 0) {
    push('BEGIN:VEVENT');
    push('UID:kat-agenda-init-2027@kat-app.onrender.com');
    push(`DTSTAMP:${nowStamp()}`);
    push('DTSTART:20270101T100000Z');
    push('DTEND:20270101T110000Z');
    push('SUMMARY:KAT Agenda');
    push('END:VEVENT');
  }

  for (const {dk, ev} of allEvs) {
    // Convert local Paris time to UTC (Paris = UTC+1 winter, UTC+2 summer)
    const [y,m,d] = dk.split('-').map(Number);
    const [h,mi] = (ev.time||'09:00').split(':').map(Number);
    const dur = parseInt(ev.duration) || 60;
    // Determine UTC offset for Paris (simple: +1 Oct-Mar, +2 Apr-Sep)
    const utcOffset = (m >= 4 && m <= 9) ? 2 : 1;
    const utcH = h - utcOffset;
    const startDate = new Date(Date.UTC(y, m-1, d, utcH, mi, 0));
    const endDate   = new Date(startDate.getTime() + dur * 60000);
    const fmtUTC = dt => {
      const p = x => String(x).padStart(2,'0');
      return `${dt.getUTCFullYear()}${p(dt.getUTCMonth()+1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00Z`;
    };
    push('BEGIN:VEVENT');
    push(`UID:${ev.id||(dk+"-"+(ev.title||"").slice(0,6).replace(/[^a-z0-9]/gi,""))}@kat`);
    push(`DTSTAMP:${nowStamp()}`);
    push(`DTSTART:${fmtUTC(startDate)}`);
    push(`DTEND:${fmtUTC(endDate)}`);
    push(`SUMMARY:${esc(ev.title)}`);
    if (ev.location) push(`LOCATION:${esc(ev.location)}`);
    if (ev.notes)    push(`DESCRIPTION:${esc(ev.notes)}`);
    const rm = {daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
    if (ev.recurrence&&ev.recurrence!=='none') push(`RRULE:FREQ=${rm[ev.recurrence]}`);
    (ev.reminders||[]).forEach(min => {
      if (min>0) {
        push('BEGIN:VALARM');
        push(`TRIGGER:-PT${min}M`);
        push('ACTION:DISPLAY');
        push(`DESCRIPTION:Rappel`);
        push('END:VALARM');
      }
    });
    push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ── Sync depuis iCloud → KAT ──
app.get('/api/sync-from-icloud', async (req, res) => {
  if (!ICLOUD_CAL_URL || !ICLOUD_EMAIL || !ICLOUD_PASSWORD) {
    return res.status(503).json({ error: 'iCloud credentials non configurés' });
  }
  try {
    // PROPFIND pour lister les .ics
    const propfindBody = `<?xml version="1.0" encoding="UTF-8"?>\
<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getcontenttype/></D:prop></D:propfind>`;
    const listResp = await caldavRequest('PROPFIND', ICLOUD_CAL_URL, propfindBody, {
      'Depth': '1',
      'Content-Type': 'application/xml; charset=utf-8',
    });
    if (!listResp || listResp.status >= 400) {
      return res.status(502).json({ error: 'PROPFIND failed: ' + (listResp && listResp.status) });
    }
    // Parse hrefs des .ics
    const hrefMatches = listResp.body.match(/<[^:]*:?href[^>]*>([^<]+\.ics[^<]*)<\/[^:]*:?href>/gi) || [];
    const hrefs = hrefMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(h => h.endsWith('.ics'));

    const events = [];
    for (const href of hrefs) {
      try {
        const parsedBase = new URL(ICLOUD_CAL_URL);
        const fullUrl = href.startsWith('http') ? href : `${parsedBase.protocol}//${parsedBase.host}${href}`;
        const evResp = await caldavRequest('GET', fullUrl, null, {});
        if (!evResp || evResp.status !== 200) continue;
        const ics = evResp.body;
        // Parse minimal iCal
        const get = (field) => {
          const m = ics.match(new RegExp(field + '[^:]*:([^\\r\\n]+)'));
          return m ? m[1].replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\;/g, ';').trim() : '';
        };
        const uid = get('UID');
        const summary = get('SUMMARY');
        const dtstart = get('DTSTART');
        const dtend   = get('DTEND');
        const location= get('LOCATION');
        const desc    = get('DESCRIPTION');
        if (!uid || !summary) continue;
        // Parse DTSTART → date + time
        let dateKey = '', time = '';
        const dtClean = dtstart.replace(/TZID=[^:]+:/, '');
        if (dtClean.length >= 8) {
          const y = dtClean.slice(0,4), mo = dtClean.slice(4,6), dy = dtClean.slice(6,8);
          dateKey = `${y}-${mo}-${dy}`;
          if (dtClean.length >= 13 && dtClean[8] === 'T') {
            const h = dtClean.slice(9,11), mi2 = dtClean.slice(11,13);
            time = `${h}:${mi2}`;
          }
        }
        // Duration
        let duration = 60;
        if (dtend) {
          const endClean = dtend.replace(/TZID=[^:]+:/, '');
          if (endClean.length >= 13 && dtClean.length >= 13) {
            const sMin = parseInt(dtClean.slice(9,11))*60 + parseInt(dtClean.slice(11,13));
            const eMin = parseInt(endClean.slice(9,11))*60 + parseInt(endClean.slice(11,13));
            if (eMin > sMin) duration = eMin - sMin;
          }
        }
        events.push({ id: uid.replace(/@.*/, ''), title: summary, date: dateKey, time, duration, location, notes: desc });
      } catch(e2) { /* skip malformed */ }
    }
    console.log(`📥 iCloud → KAT: ${events.length} event(s) parsés`);
    res.json({ ok: true, events });
  } catch(e) {
    console.error('sync-from-icloud error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ WEB PUSH ENDPOINTS ═══

// Return VAPID public key (frontend needs it to subscribe)
app.get('/api/push-key', (_, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Save push subscription from a device
app.post('/api/push-subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  _pushSubs = _pushSubs.filter(s => s.endpoint !== sub.endpoint);
  _pushSubs.push({ ...sub, ts: Date.now() });
  // Save to dedicated subs file immediately
  savePushSubs();
  console.log(`📲 Push subscription saved (total: ${_pushSubs.length})`);
  res.json({ ok: true, count: _pushSubs.length });
});

// Remove push subscription (unsubscribe)
app.post('/api/push-unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  _pushSubs = _pushSubs.filter(s => s.endpoint !== endpoint);
  savePushSubs();
  res.json({ ok: true });
});

// Send a push notification to all subscriptions
async function sendPushToAll(title, body, opts = {}) {
  const payload = JSON.stringify({ title, body, tag: opts.tag || 'kat', persist: opts.persist });
  const dead = [];
  for (const sub of [..._pushSubs]) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
      else console.warn('Push failed:', e.message);
    }
  }
  // Remove dead subscriptions
  if (dead.length) {
    _pushSubs = _pushSubs.filter(s => !dead.includes(s.endpoint));
    saveData(loadData());
  }
}

// ═══ SCHEDULED PUSH REMINDERS ═══
function scheduleDailyJournalReminder() {
  const now = new Date();
  // 18h Paris time = 16h UTC (summer) or 17h UTC (winter)
  const nowDate = new Date();
  const isSummer = (nowDate.getMonth() + 1) >= 4 && (nowDate.getMonth() + 1) <= 10;
  const parisOffset = isSummer ? 2 : 1;
  const target18hUTC = new Date();
  target18hUTC.setUTCHours(18 - parisOffset, 0, 0, 0);
  const target = target18hUTC;
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();

  setTimeout(async () => {
    // Check if any device already filled journal today
    const d = loadData();
    const today = target.toISOString().slice(0, 10);
    const filled = d.journal && d.journal[today] && (d.journal[today].text || (d.journal[today].photos && d.journal[today].photos.length));
    if (!filled) {
      console.log('📢 Sending 18h journal reminder push...');
      await sendPushToAll(
        'KAT 🐱 — Ta note du jour !',
        "Tu n\'as pas encore rempli ton journal ni posté ta photo du jour 📸",
        { tag: 'journal-reminder', persist: true }
      );
      // Repeat every 30 min if still not filled
      let repeat = setInterval(async () => {
        const d2 = loadData();
        const todayNow = new Date().toISOString().slice(0, 10);
        const filledNow = d2.journal && d2.journal[todayNow] && (d2.journal[todayNow].text || (d2.journal[todayNow].photos && d2.journal[todayNow].photos.length));
        if (filledNow) { clearInterval(repeat); return; }
        await sendPushToAll('KAT 🐱', "N\'oublie pas ton journal ! 📔", { tag: 'journal-reminder' });
      }, 30 * 60 * 1000);
    }
    // Schedule next day
    scheduleDailyJournalReminder();
  }, delay);
  console.log(`📅 Journal reminder scheduled in ${Math.round(delay/60000)} minutes`);
}

// ═══ EVENT REMINDERS VIA WEB PUSH ═══
// Called when events are updated — schedule push for each reminder
let _scheduledPushes = {};
// Convert Paris local time to UTC ms
function parisToUTC(dk, timeStr) {
  const [y,mo,d] = dk.split('-').map(Number);
  const [h,mi] = (timeStr||'09:00').split(':').map(Number);
  const isSummer = mo >= 4 && mo <= 10;
  return Date.UTC(y, mo-1, d, h - (isSummer ? 2 : 1), mi, 0);
}

// Keep track of already-sent reminders to avoid duplicates
const _sentReminders = new Set();

// Cron-based reminder check — runs every minute
// Much more reliable than setTimeout (survives restarts since it re-checks each minute)
function checkEventReminders() {
  if (!_pushSubs.length) return;
  const events = loadData().events || {};
  const now = Date.now();
  const windowMs = 90 * 1000; // fire within 90s window to handle timing drift

  for (const [dk, evs] of Object.entries(events)) {
    if (!Array.isArray(evs)) continue;
    for (const ev of evs) {
      if (!ev.title || !ev.time) continue;
      const rems = ev.reminders || ev.rems || [];
      if (!rems.length) continue;

      const evTimeUTC = parisToUTC(dk, ev.time);

      for (const remMin of rems) {
        const fireTime = evTimeUTC - (remMin || 0) * 60000;
        const diff = now - fireTime; // positive = we're past the fire time

        // Fire if we're within the 90s window after the scheduled time
        if (diff >= 0 && diff < windowMs) {
          const key = `${ev.id}_${remMin}_${dk}`;
          if (_sentReminders.has(key)) continue; // already sent
          _sentReminders.add(key);
          const msg = remMin > 0 ? `Dans ${remMin} min` : "C'est l'heure !";
          console.log(`🔔 Firing reminder: ${ev.title} (${msg})`);
          sendPushToAll(
            `⏰ ${ev.title}`,
            `${msg}${ev.time ? ' · ' + ev.time : ''}${ev.location ? '\n📍 ' + ev.location : ''}`,
            { tag: key, persist: true }
          ).catch(e => console.warn('Push failed:', e.message));
        }
      }
    }
  }
  // Clean old entries from sent set (keep only last hour)
  if (_sentReminders.size > 1000) _sentReminders.clear();
}

// Legacy — kept for backward compatibility
function scheduleEventReminders(events) {
  console.log('📅 scheduleEventReminders called — using cron-based system instead');
}

// Test push — send immediate notification to all devices
app.post('/api/push-test', async (req, res) => {
  if (!_pushSubs.length) return res.status(404).json({ error: 'No subscriptions', count: 0 });
  const { title = 'KAT 🐱', body = 'Test notification !' } = req.body || {};
  await sendPushToAll(title, body, { tag: 'test-' + Date.now() });
  res.json({ ok: true, sent_to: _pushSubs.length });
});

// Debug: how many subscriptions
app.get('/api/push-count', (_, res) => {
  res.json({ count: _pushSubs.length, subs: _pushSubs.map(s => ({ endpoint: s.endpoint.slice(0,60), ts: s.ts })) });
});

// Delete a specific event from iCloud CalDAV
app.post('/api/delete-event', async (req, res) => {
  const { evId } = req.body || {};
  if (!evId) return res.status(400).json({ error: 'evId required' });
  try {
    await deleteFromiCloud(evId);
    console.log('🗑 Deleted from iCloud:', evId);
    res.json({ ok: true });
  } catch(e) {
    console.warn('Delete from iCloud failed:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app._icloudTimer = null;
const server = app.listen(PORT, () => {
  console.log(`🐱 KAT v3 on :${PORT}`);
  // Restore data from GitHub on startup
  // Load push subscriptions from dedicated file
  loadPushSubs();
  // Start cron: check event reminders every 60 seconds
  setInterval(checkEventReminders, 60 * 1000);
  console.log('⏰ Reminder cron started (every 60s)');
  // Start daily journal push reminder at 18h Paris
  scheduleDailyJournalReminder();
});

// ═══════════════════════════════════════════════
//  iCLOUD CALDAV SYNC — Auto-sync to Apple Calendar
// ═══════════════════════════════════════════════
const ICLOUD_EMAIL    = process.env.ICLOUD_EMAIL;
const ICLOUD_PASSWORD = process.env.ICLOUD_PASSWORD;
const ICLOUD_CAL_URL  = process.env.ICLOUD_CAL_URL;

function caldavRequest(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!ICLOUD_EMAIL || !ICLOUD_PASSWORD || !ICLOUD_CAL_URL) return resolve(null);
    const creds = Buffer.from(`${ICLOUD_EMAIL}:${ICLOUD_PASSWORD}`).toString('base64');
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method,
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'text/calendar; charset=utf-8',
        'User-Agent': 'KAT-App/3.0',
        ...extraHeaders,
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildEventICS(dk, ev) {
  const CRLF = '\r\n';
  const esc = s => (s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\;').replace(/\n/g,'\\n');
  const toD = (dateKey, t) => {
    const [y,m,d] = dateKey.split('-').map(Number);
    const [h,mi] = (t||'09:00').split(':').map(Number);
    const p = x => String(x).padStart(2,'0');
    return `${y}${p(m)}${p(d)}T${p(h)}${p(mi)}00`;
  };
  const dur = parseInt(ev.duration) || 60;
  const [h,mi] = (ev.time||'09:00').split(':').map(Number);
  const tm = h*60+mi+dur;
  const endT = `${String(Math.floor(tm/60)).padStart(2,'0')}:${String(tm%60).padStart(2,'0')}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KAT App//KAT Agenda//FR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.id}@kat-app`,
    `DTSTAMP:${nowStamp()}`,
    `DTSTART:${toD(dk, ev.time)}`,
    `DTEND:${toD(dk, endT)}`,
    `SUMMARY:${esc(ev.title)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
  if (ev.notes)    lines.push(`DESCRIPTION:${esc(ev.notes)}`);
  const rm = {daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
  if (ev.recurrence && ev.recurrence !== 'none') lines.push(`RRULE:FREQ=${rm[ev.recurrence]}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join(CRLF);
}

async function syncToiCloud(events) {
  if (!ICLOUD_CAL_URL) return;
  const allEvs = [];
  for (const [dk, evs] of Object.entries(events || {})) {
    if (!Array.isArray(evs)) continue;
    evs.forEach(ev => { if (ev.id && ev.title) allEvs.push({ dk, ev }); });
  }
  // Upsert all events
  for (const { dk, ev } of allEvs) {
    try {
      const ics = buildEventICS(dk, ev);
      const url = ICLOUD_CAL_URL + ev.id + '.ics';
      const r = await caldavRequest('PUT', url, ics, { 'If-Match': '*' });
      // If event doesn't exist yet (412 = precondition failed), create it
      if (r && r.status === 412) {
        await caldavRequest('PUT', url, ics, { 'If-None-Match': '*' });
      }
    } catch(e) { console.warn('iCloud sync error:', ev.id, e.message); }
  }
  console.log(`✅ iCloud sync: ${allEvs.length} event(s)`);
}

async function deleteFromiCloud(evId) {
  if (!ICLOUD_CAL_URL || !evId) return;
  try {
    const url = ICLOUD_CAL_URL + evId + '.ics';
    await caldavRequest('DELETE', url, null, {});
  } catch(e) {}
}

// ═══ AUTO-SYNC iCloud → KAT toutes les 5 minutes ═══
async function autoSyncFromiCloud() {
  if (!ICLOUD_CAL_URL || !ICLOUD_EMAIL || !ICLOUD_PASSWORD) return;
  try {
    const propfindBody = `<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`;
    const listResp = await caldavRequest('PROPFIND', ICLOUD_CAL_URL, propfindBody,
      { 'Depth': '1', 'Content-Type': 'application/xml' });
    if (!listResp || listResp.status >= 400) return;

    const hrefMatches = listResp.body.match(/<[^:]*:?href[^>]*>([^<]+\.ics[^<]*)<\/[^:]*:?href>/gi) || [];
    const hrefs = hrefMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(h => h.endsWith('.ics'));

    const data = loadData();
    const allKatIds = new Set(Object.values(data.events).flat().map(e => e.id));
    let changed = false;

    for (const href of hrefs) {
      try {
        const parsedBase = new URL(ICLOUD_CAL_URL);
        const fullUrl = href.startsWith('http') ? href : `${parsedBase.protocol}//${parsedBase.host}${href}`;
        const evResp = await caldavRequest('GET', fullUrl, null, {});
        if (!evResp || evResp.status !== 200) continue;
        const ics = evResp.body;
        const get = f => { const m = ics.match(new RegExp(f + '[^:]*:([^\\r\\n]+)')); return m ? m[1].trim() : ''; };
        const uid = get('UID'), summary = get('SUMMARY'), dtstart = get('DTSTART');
        if (!uid || !summary || !dtstart) continue;
        // Don't skip @kat-app events — they need to come back if KAT lost its data
        const evId = uid.replace(/@.*/,'').slice(0,40);
        if (allKatIds.has(evId)) continue; // already in KAT

        const dtc = dtstart.replace(/TZID=[^:]+:/,'').replace('Z','');
        if (dtc.length < 8) continue;
        const dk = `${dtc.slice(0,4)}-${dtc.slice(4,6)}-${dtc.slice(6,8)}`;
        const time = dtc.length >= 13 ? `${dtc.slice(9,11)}:${dtc.slice(11,13)}` : '09:00';
        if (!data.events[dk]) data.events[dk] = [];
        data.events[dk].push({ id: evId, title: summary, time, duration: 60, catId: 'work', done: false, fromApple: true });
        allKatIds.add(evId);
        changed = true;
      } catch(e2) {}
    }

    if (changed) {
      saveData(data);
      console.log('✅ Auto-sync: nouveaux events Apple Calendar importés dans KAT');
    }
  } catch(e) { console.warn('autoSyncFromiCloud error:', e.message); }
}

// Lancer au démarrage (après 10s) puis toutes les 5 minutes
setTimeout(() => {
  autoSyncFromiCloud();
  setInterval(autoSyncFromiCloud, 5 * 60 * 1000);
}, 10000);
