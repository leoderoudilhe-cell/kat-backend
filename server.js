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
  persistSubsToGitHub(); // persiste aussi sur GitHub (survit aux redémarrages Render)
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
  // Try main file
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      _cachedData = d;
      return d;
    }
  } catch(e) {
    console.warn('Main data file corrupted:', e.message);
  }
  // Fallback: try backup
  try {
    const backupFile = DATA_FILE + '.backup';
    if (fs.existsSync(backupFile)) {
      console.log('🔄 Loading from backup');
      const d = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      _cachedData = d;
      // Restore main file from backup
      try { fs.copyFileSync(backupFile, DATA_FILE); } catch(e){}
      return d;
    }
  } catch(e) { console.warn('Backup also corrupted:', e.message); }
  // Last resort: defaults
  _cachedData = JSON.parse(JSON.stringify(DEFAULT));
  return _cachedData;
}

// Debounce GitHub persistence (avoid too many API calls)
let _ghPersistTimer = null;
function saveData(d) {
  try {
    delete d._pushSubs; // jamais dans le fichier de données (exposé via /api/data sinon)
    d._updatedAt = Date.now();
    _dataModifiedTs = d._updatedAt; // FIX B1: signale aux autres appareils qu'il y a du nouveau
    // Write atomically: tmp file puis rename (évite corruption en cas de crash)
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    // Backup rotatif toutes les 10 saves
    _saveCounter = (_saveCounter || 0) + 1;
    if (_saveCounter % 10 === 0) {
      try {
        const backupFile = DATA_FILE + '.backup';
        fs.copyFileSync(DATA_FILE, backupFile);
      } catch(e) {}
    }
  } catch(e) {
    console.warn('save error:', e.message);
    // Tenter de restaurer depuis backup
    try {
      const backupFile = DATA_FILE + '.backup';
      if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, DATA_FILE);
        console.log('🔄 Restored from backup');
      }
    } catch(e2) {}
  }
  updateGithubICS(d.events || {}).catch(() => {});
  clearTimeout(_ghPersistTimer);
  _ghPersistTimer = setTimeout(() => persistDataToGitHub(d).catch(()=>{}), 10000);
}
let _saveCounter = 0;

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

// ═══ PERSISTANCE GITHUB DES SOUSCRIPTIONS PUSH (survit aux redémarrages) ═══
const GH_SUBS_PATH = 'data/push-subs.json';
let _subsSha = null;

function ghGet(path) {
  return new Promise((resolve) => {
    if (!GH_TOKEN) return resolve(null);
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
      method: 'GET',
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'KAT/3.0' }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({s:res.statusCode,b:JSON.parse(d)});}catch{resolve({s:res.statusCode,b:{}});} }); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function ghPutJSON(path, obj, sha) {
  return new Promise((resolve) => {
    if (!GH_TOKEN) return resolve(null);
    const body = JSON.stringify({
      message: 'KAT push subs',
      content: Buffer.from(JSON.stringify(obj)).toString('base64'),
      ...(sha ? { sha } : {})
    });
    const b = Buffer.from(body);
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
      method: 'PUT',
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'KAT/3.0', 'Content-Type': 'application/json', 'Content-Length': b.length }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({s:res.statusCode,b:JSON.parse(d)});}catch{resolve({s:res.statusCode,b:{}});} }); });
    req.on('error', () => resolve(null));
    req.write(b);
    req.end();
  });
}

let _subsPersistTimer = null;
function persistSubsToGitHub() {
  // Debounce léger pour grouper plusieurs souscriptions rapprochées
  clearTimeout(_subsPersistTimer);
  _subsPersistTimer = setTimeout(async () => {
    if (!GH_TOKEN) return;
    try {
      if (!_subsSha) { const r = await ghGet(GH_SUBS_PATH); if (r && r.s === 200) _subsSha = r.b.sha; }
      const payload = { subs: _pushSubs, sent: [..._sentReminders].slice(-500) };
      const res = await ghPutJSON(GH_SUBS_PATH, payload, _subsSha);
      if (res && (res.s === 200 || res.s === 201)) {
        _subsSha = res.b.content?.sha || _subsSha;
        console.log(`✅ Push subs persisted to GitHub (${_pushSubs.length})`);
      } else if (res && (res.s === 409 || res.s === 422)) {
        _subsSha = null; // conflit → reset, réessaiera au prochain save
      }
    } catch(e) { console.warn('GitHub subs persist error:', e.message); }
  }, 2000);
}

async function loadSubsFromGitHub() {
  if (!GH_TOKEN) return;
  try {
    const r = await ghGet(GH_SUBS_PATH);
    if (r && r.s === 200 && r.b.content) {
      const data = JSON.parse(Buffer.from(r.b.content, 'base64').toString('utf8'));
      _subsSha = r.b.sha;
      if (Array.isArray(data.subs)) {
        _pushSubs = data.subs;
        console.log(`✅ Loaded ${_pushSubs.length} push sub(s) from GitHub`);
      }
      if (Array.isArray(data.sent)) {
        data.sent.forEach(k => _sentReminders.add(k));
        console.log(`✅ Loaded ${data.sent.length} sent-reminder marker(s) from GitHub`);
      }
    }
  } catch(e) { console.warn('GitHub subs load error:', e.message); }
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
  <rect width="100" height="100" rx="22" fill="#F472B6"/>
  <polygon points="18,42 12,16 36,34" fill="#F9A8D4"/>
  <polygon points="82,42 88,16 64,34" fill="#F9A8D4"/>
  <polygon points="20,40 15,20 34,34" fill="#FECDD3"/>
  <polygon points="80,40 85,20 66,34" fill="#FECDD3"/>
  <circle cx="50" cy="60" r="30" fill="white"/>
  <ellipse cx="38" cy="54" rx="5.5" ry="6.5" fill="#1a0533"/>
  <ellipse cx="62" cy="54" rx="5.5" ry="6.5" fill="#1a0533"/>
  <circle cx="40" cy="52" r="1.8" fill="white"/>
  <circle cx="64" cy="52" r="1.8" fill="white"/>
  <ellipse cx="50" cy="65" rx="2.5" ry="2" fill="#DB2777"/>
  <path d="M46 69 Q50 73 54 69" stroke="#FECDD3" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <line x1="14" y1="62" x2="36" y2="63" stroke="#FECDD3" stroke-width="1.2" opacity="0.8"/>
  <line x1="14" y1="67" x2="36" y2="66" stroke="#FECDD3" stroke-width="1.2" opacity="0.8"/>
  <line x1="64" y1="63" x2="86" y2="62" stroke="#FECDD3" stroke-width="1.2" opacity="0.8"/>
  <line x1="64" y1="66" x2="86" y2="67" stroke="#FECDD3" stroke-width="1.2" opacity="0.8"/>
</svg>`;

const ICON_PNG = Buffer.from('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', 'base64');
app.get('/icon-180.png', (_, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(ICON_PNG);
});

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
    background_color: '#F472B6',
    theme_color: '#F472B6',
    orientation: 'portrait',
    icons: [
      { src: '/icon-180.png', sizes: '180x180', type: 'image/png', purpose: 'any maskable' },
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
  delete d._pushSubs; // anciens fichiers pouvaient en contenir
  if (!d._updatedAt) d._updatedAt = _dataModifiedTs;
  res.json(d);
});

// Save customization choices
app.post('/api/customize', (req, res) => {
  try {
    const customFile = path.join(DATA_DIR, 'customize.json');
    fs.writeFileSync(customFile, JSON.stringify(req.body, null, 2));
    console.log('🎨 Customization saved:', JSON.stringify(req.body));
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Read customization
app.get('/api/customize', (_, res) => {
  try {
    const customFile = path.join(DATA_DIR, 'customize.json');
    if (fs.existsSync(customFile)) {
      res.json(JSON.parse(fs.readFileSync(customFile, 'utf8')));
    } else {
      res.json({});
    }
  } catch(e) {
    res.json({});
  }
});

// Manual full backup download — pour téléchargement assurance
app.get('/api/backup', (_, res) => {
  const d = loadData();
  delete d._pushSubs;
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="kat-backup-${Date.now()}.json"`);
  res.send(JSON.stringify(d, null, 2));
});

// Stats — voir ce qui est sur le serveur
app.get('/api/stats', (_, res) => {
  const d = loadData();
  const evCount = Object.values(d.events||{}).reduce((a,v) => a + (Array.isArray(v)?v.length:0), 0);
  const todoCount = Object.values(d.todos||{}).reduce((a,v) => a + (Array.isArray(v)?v.length:0), 0);
  const courseCount = (d.courses?.items||[]).length;
  const ptodoCount = (d.ptodos||[]).length;
  const journalCount = Object.keys(d.journal||{}).length;
  res.json({
    events: evCount,
    todos: todoCount,
    courses: courseCount,
    ptodos: ptodoCount,
    journal: journalCount,
    cats: (d.cats||[]).length,
    subs: _pushSubs.length,
    lastUpdate: d._updatedAt || 0
  });
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
    if (b.events !== undefined) {
      const incomingCount = Object.values(b.events).reduce((a,v) => a + (Array.isArray(v) ? v.length : 0), 0);
      const existingCount = Object.values(d.events || {}).reduce((a,v) => a + (Array.isArray(v) ? v.length : 0), 0);
      // Protection : ne pas écraser si serveur a des events et incoming est suspicieusement vide
      // Sauf si client a >= serveur (suppression légitime)
      if (incomingCount > 0 || existingCount === 0 || incomingCount >= existingCount * 0.5) {
        d.events = b.events;
        setTimeout(() => scheduleEventReminders(d.events), 100);
      } else {
        console.warn(`⚠️ Refused empty events overwrite: server=${existingCount} incoming=${incomingCount}`);
      }
    }
    if (b.todos !== undefined) {
      const incomingCount = Object.values(b.todos).reduce((a,v) => a + (Array.isArray(v) ? v.length : 0), 0);
      const existingCount = Object.values(d.todos || {}).reduce((a,v) => a + (Array.isArray(v) ? v.length : 0), 0);
      // Accepte si: incoming a des données, OU serveur vide, OU incoming >= moitié (suppression légitime)
      if (incomingCount > 0 || existingCount === 0 || incomingCount >= existingCount * 0.5) {
        d.todos = b.todos;
      }
    }
    if (b.cats !== undefined && Array.isArray(b.cats) && b.cats.length > 0) {
      d.cats = b.cats;
    }
    // Ne jamais écraser des données existantes avec une liste vide
    if (b.courses !== undefined) {
      const incomingItems = (b.courses.items || []).length;
      const existingItems = (d.courses && d.courses.items || []).length;
      if (incomingItems > 0 || existingItems === 0) d.courses = b.courses;
    }
    if (b.ptodos !== undefined) {
      if (b.ptodos.length > 0 || !d.ptodos || d.ptodos.length === 0) d.ptodos = b.ptodos;
    }
    if (b.settings !== undefined) {
      // Merge: ne pas perdre les settings serveur non envoyés par le client
      d.settings = { ...(d.settings || {}), ...b.settings };
    }
    if (b.journal !== undefined && b.journal !== null) {
      if (!d.journal) d.journal = {};
      for (const [k, v] of Object.entries(b.journal)) {
        const existing = d.journal[k] || {};
        // Merge par timestamp (cohérent avec le client): le plus récent gagne.
        // Permet de corriger/effacer du texte (l'ancien merge "par longueur" l'empêchait).
        const lts = existing._ts || 0, rts = v._ts || 0;
        const winner = rts >= lts ? v : existing;
        const merged = {
          mood: winner.mood || existing.mood || '',
          text: (winner.text !== undefined && winner.text !== null) ? winner.text : (existing.text || ''),
          date: winner.date || existing.date || v.date,
          _ts: Math.max(lts, rts),
          sections: (winner.sections && Object.keys(winner.sections).length) ? winner.sections : (existing.sections || v.sections || {}),
        };
        // Photos: prend le plus grand des deux (client OU serveur)
        const clientPhotos = Array.isArray(v.photos) ? v.photos : [];
        const serverPhotos = Array.isArray(existing.photos) ? existing.photos : [];
        if (clientPhotos.length >= serverPhotos.length && clientPhotos.length > 0) {
          let photosStr = JSON.stringify(clientPhotos);
          merged.photos = photosStr.length < 500000 ? clientPhotos : clientPhotos.slice(0,2);
        } else if (serverPhotos.length > 0) {
          merged.photos = serverPhotos;
        }
        d.journal[k] = merged;
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
      // NOTE: plus de push silencieux '__sync__' — iOS révoque la souscription
      // quand un push n'affiche pas de notification. Le polling 10s + sync au
      // focus assurent déjà la propagation entre appareils.
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
    const utcOffset = parisIsDST(y, m, d) ? 2 : 1;
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
    savePushSubs();
  }
}

// ═══ SCHEDULED PUSH REMINDERS ═══
// Date du jour en heure de Paris (pas UTC — sinon mauvaise clé journal après minuit/18h)
function parisDateKey() {
  const now = new Date();
  const offset = parisIsDST(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate()) ? 2 : 1;
  return new Date(now.getTime() + offset * 3600 * 1000).toISOString().slice(0, 10);
}
function parisHour() {
  const now = new Date();
  const offset = parisIsDST(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate()) ? 2 : 1;
  return (now.getUTCHours() + offset) % 24;
}
function journalFilled(dk) {
  const d = loadData();
  const e = d.journal && d.journal[dk];
  if (!e) return false;
  const hasSection = e.sections && Object.values(e.sections).some(v => v && String(v).trim());
  return !!(e.text || e.mood || (e.photos && e.photos.length) || hasSection);
}
let _journalRepeatTimer = null;
function scheduleDailyJournalReminder() {
  const now = new Date();
  const parisOffset = parisIsDST(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate()) ? 2 : 1;
  const target = new Date();
  target.setUTCHours(18 - parisOffset, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();

  setTimeout(async () => {
    const today = parisDateKey(); // date réelle au moment du tir, en heure de Paris
    if (!journalFilled(today)) {
      console.log('📢 Sending 18h journal reminder push...');
      await sendPushToAll(
        'KAT 🐱 — Ta note du jour !',
        "Tu n'as pas encore rempli ton journal ni posté ta photo du jour 📸",
        { tag: 'journal-reminder', persist: true }
      ).catch(()=>{});
      // Relance toutes les 30 min, mais jamais après 22h, et un seul timer actif
      clearInterval(_journalRepeatTimer);
      _journalRepeatTimer = setInterval(async () => {
        const dk = parisDateKey();
        if (journalFilled(dk) || parisHour() >= 22 || parisHour() < 18) {
          clearInterval(_journalRepeatTimer); _journalRepeatTimer = null; return;
        }
        await sendPushToAll('KAT 🐱', "N'oublie pas ton journal ! 📔", { tag: 'journal-reminder' }).catch(()=>{});
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
function parisIsDST(y, m, d) {
  // Heure d'été UE: du dernier dimanche de mars au dernier dimanche d'octobre
  function lastSunday(year, month) { // month 1-12
    const last = new Date(Date.UTC(year, month, 0)); // dernier jour du mois
    return last.getUTCDate() - last.getUTCDay();
  }
  if (m < 3 || m > 10) return false;
  if (m > 3 && m < 10) return true;
  if (m === 3) return d >= lastSunday(y, 3);
  if (m === 10) return d < lastSunday(y, 10);
  return false;
}
function parisToUTC(dk, timeStr) {
  const [y,m,d] = dk.split('-').map(Number);
  const [h,mi] = (timeStr||'09:00').split(':').map(Number);
  const offset = parisIsDST(y, m, d) ? 2 : 1;
  return Date.UTC(y, m-1, d, h - offset, mi, 0);
}

// Keep track of already-sent reminders to avoid duplicates
const _sentReminders = new Set();

// Cron-based reminder check — runs every minute
// Much more reliable than setTimeout (survives restarts since it re-checks each minute)
let _lastReminderCheck = 0;
function checkEventReminders() {
  if (!_pushSubs.length) return;
  const events = loadData().events || {};
  const now = Date.now();
  // Si le serveur a dormi (gap > 5min depuis le dernier check), on élargit la fenêtre
  // à 30min pour rattraper les rappels manqués pendant le sommeil (ex: elle ouvre l'app le matin).
  const gap = now - _lastReminderCheck;
  const windowMs = (_lastReminderCheck > 0 && gap > 5 * 60 * 1000) ? 30 * 60 * 1000 : 90 * 1000;
  _lastReminderCheck = now;

  // Occurrences à vérifier: la date d'origine + l'occurrence du jour pour les récurrents
  const todayDk = parisDateKey();
  const occurrences = [];
  for (const [dk, evs] of Object.entries(events)) {
    if (!Array.isArray(evs)) continue;
    for (const ev of evs) {
      if (!ev.title || !ev.time) continue;
      occurrences.push({ dk, ev });
      if (ev.recurrence && ev.recurrence !== 'none' && dk !== todayDk && dk < todayDk) {
        const [oy, om, od] = dk.split('-').map(Number);
        const [ty, tm, td] = todayDk.split('-').map(Number);
        const orig = new Date(Date.UTC(oy, om-1, od));
        const tgt  = new Date(Date.UTC(ty, tm-1, td));
        const match =
          ev.recurrence === 'daily' ? true :
          ev.recurrence === 'weekly' ? orig.getUTCDay() === tgt.getUTCDay() :
          ev.recurrence === 'monthly' ? od === td :
          ev.recurrence === 'yearly' ? (od === td && om === tm) : false;
        if (match) occurrences.push({ dk: todayDk, ev });
      }
    }
  }
  for (const { dk, ev } of occurrences) {
    {
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
          persistSubsToGitHub(); // sauvegarde le marqueur pour ne pas re-notifier après restart
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
  // Éviction douce: on garde le set borné sans tout vider (évite re-déclenchement)
  if (_sentReminders.size > 2000) {
    const arr = [..._sentReminders];
    _sentReminders.clear();
    arr.slice(-1000).forEach(k => _sentReminders.add(k)); // garde les 1000 plus récents
  }
}

// Legacy — kept for backward compatibility
function scheduleEventReminders(events) {
  console.log('📅 scheduleEventReminders called — using cron-based system instead');
}

// ═══ ENDPOINT CRON EXTERNE ═══
// Appelé par un service externe (cron-job.org / UptimeRobot) toutes les minutes.
// Garde Render éveillé 24/7 ET déclenche le check des rappels même si l'app n'est jamais ouverte.
app.get('/api/cron', (_, res) => {
  try { checkEventReminders(); } catch(e) { console.warn('cron check err:', e.message); }
  res.json({ ok: true, ts: Date.now(), subs: _pushSubs.length, up: Math.round(process.uptime()) });
});
app.head('/api/cron', (_, res) => res.status(200).end());

// ═══ ACTUALITÉ DU JOUR (Google News RSS FR) — titres + liens vers l'article ═══
let _newsCache = { ts: 0, items: [] };
function fetchGoogleNews() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'news.google.com',
      path: '/rss?hl=fr&gl=FR&ceid=FR:fr',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (KAT/3.0)' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const items = [];
          const re = /<item>([\s\S]*?)<\/item>/g;
          let m;
          while ((m = re.exec(d)) && items.length < 12) {
            const block = m[1];
            const grab = (tag) => {
              const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
              if (!r) return '';
              return r[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
            };
            let title = grab('title');
            const link = grab('link');
            const source = grab('source');
            const pub = grab('pubDate');
            // Google News titre = "Titre - Source" → on retire la source en double
            if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
            if (title && link) items.push({ title, link, source, pub });
          }
          resolve(items);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(7000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}
app.get('/api/news', async (_, res) => {
  // Cache 15 min pour ne pas marteler Google
  if (Date.now() - _newsCache.ts < 15 * 60 * 1000 && _newsCache.items.length) {
    return res.json({ items: _newsCache.items, cached: true });
  }
  const items = await fetchGoogleNews();
  if (items.length) _newsCache = { ts: Date.now(), items };
  res.json({ items: _newsCache.items, cached: false });
});

// ═══ REMONTÉE DE BUGS (Camille signale → Léo révise) ═══
const BUGS_FILE = path.join(DATA_DIR, 'bugs.json');
const GH_BUGS_PATH = 'data/bugs.json';
let _bugs = [];
let _bugsSha = null;
function loadBugs() {
  try { if (fs.existsSync(BUGS_FILE)) _bugs = JSON.parse(fs.readFileSync(BUGS_FILE, 'utf8')); } catch(e) { _bugs = []; }
}
let _bugsPersistTimer = null;
function saveBugs() {
  try { fs.writeFileSync(BUGS_FILE, JSON.stringify(_bugs, null, 2)); } catch(e) {}
  // Persiste sur GitHub (survit aux redémarrages Render)
  clearTimeout(_bugsPersistTimer);
  _bugsPersistTimer = setTimeout(async () => {
    if (!GH_TOKEN) return;
    try {
      if (!_bugsSha) { const r = await ghGet(GH_BUGS_PATH); if (r && r.s === 200) _bugsSha = r.b.sha; }
      const res = await ghPutJSON(GH_BUGS_PATH, _bugs, _bugsSha);
      if (res && (res.s === 200 || res.s === 201)) _bugsSha = res.b.content?.sha || _bugsSha;
      else if (res && (res.s === 409 || res.s === 422)) _bugsSha = null;
    } catch(e) {}
  }, 1500);
}
async function loadBugsFromGitHub() {
  if (!GH_TOKEN) return;
  try {
    const r = await ghGet(GH_BUGS_PATH);
    if (r && r.s === 200 && r.b.content) {
      _bugs = JSON.parse(Buffer.from(r.b.content, 'base64').toString('utf8'));
      _bugsSha = r.b.sha;
      console.log(`🐛 Loaded ${_bugs.length} bug report(s) from GitHub`);
    }
  } catch(e) {}
}

// Camille envoie un signalement
app.post('/api/bug-report', (req, res) => {
  const { text, context } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'empty' });
  _bugs.unshift({
    id: Date.now().toString(36),
    text: String(text).slice(0, 1000),
    context: context || {},
    ts: Date.now(),
    resolved: false,
  });
  if (_bugs.length > 500) _bugs = _bugs.slice(0, 500);
  saveBugs();
  console.log('🐛 Bug signalé:', String(text).slice(0, 80));
  res.json({ ok: true });
});

// Léo révise la liste — page HTML lisible (ouvrir kat-app.onrender.com/api/bugs)
app.get('/api/bugs', (req, res) => {
  if (req.query.format === 'json') return res.json({ bugs: _bugs });
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const open = _bugs.filter(b => !b.resolved);
  const rows = _bugs.map(b => {
    const d = new Date(b.ts);
    const when = d.toLocaleString('fr-FR', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    const ctx = b.context || {};
    return `<div style="background:#fff;border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 2px 10px rgba(0,0,0,0.06);${b.resolved?'opacity:0.5':''}">
      <div style="font-size:15px;line-height:1.5;color:#1c1c1e;white-space:pre-wrap">${esc(b.text)}</div>
      <div style="font-size:12px;color:#9b7280;margin-top:8px">📅 ${esc(when)}${ctx.tab?` · onglet <b>${esc(ctx.tab)}</b>`:''}${ctx.date?` · ${esc(ctx.date)}`:''}</div>
    </div>`;
  }).join('') || '<p style="color:#9b7280">Aucun signalement pour le moment 🎉</p>';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bugs KAT</title></head>
  <body style="font-family:-apple-system,sans-serif;background:#FCEEF3;margin:0;padding:20px;max-width:680px;margin:auto">
    <h1 style="color:#DB2777;font-size:24px">🐛 Bugs signalés par Camille</h1>
    <p style="color:#9b7280;font-size:14px">${open.length} en attente · ${_bugs.length} au total</p>
    ${rows}
  </body></html>`);
});

// Test push — send immediate notification to all devices
app.post('/api/push-test', async (req, res) => {
  if (!_pushSubs.length) return res.status(404).json({ error: 'No subscriptions', count: 0 });
  const { title = 'KAT 🐱', body = 'Test notification !' } = req.body || {};
  await sendPushToAll(title, body, { tag: 'test-' + Date.now() });
  res.json({ ok: true, sent_to: _pushSubs.length });
});

// Message personnalisé — GET /api/push-custom?title=...&body=...&secret=kat2024
app.get('/api/push-custom', async (req, res) => {
  const { title = 'KAT 🐱', body = '', secret } = req.query;
  if (secret !== 'kat2024') return res.status(403).json({ error: 'Forbidden' });
  if (!_pushSubs.length) return res.status(404).json({ error: 'No subscriptions', count: 0 });
  if (!body) return res.status(400).json({ error: 'body param required' });
  await sendPushToAll(title, body, { tag: 'custom-' + Date.now() });
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
const server = app.listen(PORT, async () => {
  console.log(`🐱 KAT v3 on :${PORT}`);
  // Try to restore data from GitHub if local files are missing/empty
  if (!fs.existsSync(DATA_FILE)) {
    try {
      const ghData = await loadFromGitHub();
      if (ghData) {
        _cachedData = ghData;
        fs.writeFileSync(DATA_FILE, JSON.stringify(ghData, null, 2));
        const evCount = Object.values(ghData.events||{}).reduce((a,v)=>a+(Array.isArray(v)?v.length:0),0);
        console.log(`✅ Restored from GitHub: ${evCount} events`);
      }
    } catch(e) { console.warn('GitHub restore failed:', e.message); }
  }
  loadPushSubs(); // fichier local (peut être vide après restart)
  await loadSubsFromGitHub(); // GitHub = source persistante des souscriptions
  loadBugs();
  await loadBugsFromGitHub(); // signalements de bugs persistés
  // Cron rappels toutes les 60s
  setInterval(checkEventReminders, 60 * 1000);
  console.log('⏰ Reminder cron started (every 60s)');
  scheduleDailyJournalReminder();
  // Re-persister les marqueurs "déjà envoyé" sur GitHub périodiquement (anti-doublon après restart)
  setInterval(() => { if (_pushSubs.length) persistSubsToGitHub(); }, 10 * 60 * 1000);

  // ═══ SELF-KEEPALIVE 24/7 ═══
  // Render free s'endort après 15 min sans requête ENTRANTE → le cron des rappels
  // ne tourne plus → notifs ratées. Le cron GitHub Actions est throttlé (runs espacés
  // de plusieurs heures). Solution: le serveur se ping lui-même via son URL PUBLIQUE
  // (passe par le load balancer Render = trafic entrant) toutes les 4 min.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || (process.env.RENDER ? 'https://kat-app.onrender.com' : null);
  if (SELF_URL) {
    setInterval(() => {
      try { https.get(SELF_URL + '/api/ping', r => r.resume()).on('error', () => {}); } catch(e) {}
    }, 4 * 60 * 1000);
    console.log('🫀 Self-keepalive actif →', SELF_URL);
  }
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
