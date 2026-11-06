// 7TV Emote Redeem Bot
// Twitch Channel-Point-Redeem -> 7TV-Link in der Nachricht -> Emote wird zum Kanal-Emote-Set hinzugefügt.
// Max. N Emotes (Standard 5), das älteste vom Bot hinzugefügte wird automatisch entfernt (FIFO).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(DIR, 'config.json');
// Auf dem Server: DATA_DIR auf ein persistentes Volume zeigen lassen (z. B. /data)
const DATA_DIR = process.env.DATA_DIR || DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' }), ...a);
const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

// Config: Umgebungsvariablen (Hosting) haben Vorrang vor config.json (lokal)
const env = process.env;
const fileCfg = readJson(CONFIG_FILE, {});
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));
const cfg = {
  twitchClientId: env.TWITCH_CLIENT_ID || fileCfg.twitchClientId,
  sevenTvToken: env.SEVENTV_TOKEN || fileCfg.sevenTvToken,
  emoteSetId: env.EMOTE_SET_ID || fileCfg.emoteSetId || '',
  rewardTitle: env.REWARD_TITLE || fileCfg.rewardTitle || '7TV Emote hinzufügen',
  rewardCost: Number(env.REWARD_COST || fileCfg.rewardCost || 5000),
  rewardPrompt: env.REWARD_PROMPT || fileCfg.rewardPrompt || 'Schick einen 7TV-Emote-Link (https://7tv.app/emotes/...)',
  maxEmotes: Number(env.MAX_EMOTES || fileCfg.maxEmotes || 5),
  chatAnnounce: bool(env.CHAT_ANNOUNCE, fileCfg.chatAnnounce ?? true),
  blockUnsafeEmotes: bool(env.BLOCK_UNSAFE_EMOTES, fileCfg.blockUnsafeEmotes ?? true),
};

// Kleiner Health-Endpoint, falls der Host einen offenen Port verlangt
if (env.PORT) {
  http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(env.PORT));
}

const MAX_EMOTES = cfg.maxEmotes;
const SCOPES = ['channel:manage:redemptions'];
if (cfg.chatAnnounce) SCOPES.push('user:write:chat');

// 7TV Emote-Flags (v3): Sexual = 1<<16, TwitchDisallowed = 1<<24
const FLAG_SEXUAL = 1 << 16;
const FLAG_TWITCH_DISALLOWED = 1 << 24;

// https://7tv.app/emotes/<id>  oder  https://cdn.7tv.app/emote/<id>/...
const LINK_RE = /(?:7tv\.app\/emotes\/|cdn\.7tv\.app\/emote\/)([0-9A-Za-z]{20,26})/i;

let tokens = readJson(TOKEN_FILE, null);
// Optional: Start mit vorhandenem Refresh-Token statt Login im Log
if (!tokens && env.TWITCH_REFRESH_TOKEN) tokens = { access_token: '', refresh_token: env.TWITCH_REFRESH_TOKEN };
let state = readJson(STATE_FILE, { emotes: [] }); // vom Bot hinzugefügte Emotes, älteste zuerst
const saveState = () => writeJson(STATE_FILE, state);
const saveTokens = () => writeJson(TOKEN_FILE, tokens);

let setId = null;
let rewardId = null;

/* ------------------------------------------------------------------ */
/* Twitch Auth (Device Code Flow, kein Client Secret nötig)            */
/* ------------------------------------------------------------------ */

async function form(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function deviceLogin() {
  const d = await form('https://id.twitch.tv/oauth2/device', {
    client_id: cfg.twitchClientId,
    scopes: SCOPES.join(' '),
  });
  if (d.status !== 200) throw new Error('Device-Login fehlgeschlagen: ' + JSON.stringify(d.body));

  console.log('\n==================================================');
  console.log(' LOGIN nötig (mit dem STREAMER-Account einloggen):');
  console.log(' ' + d.body.verification_uri);
  console.log(' Code: ' + d.body.user_code);
  console.log('==================================================\n');

  const deadline = Date.now() + d.body.expires_in * 1000;
  const interval = (d.body.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await form('https://id.twitch.tv/oauth2/token', {
      client_id: cfg.twitchClientId,
      scopes: SCOPES.join(' '),
      device_code: d.body.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.status === 200) {
      tokens = { access_token: t.body.access_token, refresh_token: t.body.refresh_token };
      saveTokens();
      log('Login erfolgreich.');
      return;
    }
    if (t.body.message !== 'authorization_pending') {
      throw new Error('Login fehlgeschlagen: ' + JSON.stringify(t.body));
    }
  }
  throw new Error('Login abgelaufen – Bot neu starten.');
}

async function refreshToken() {
  const t = await form('https://id.twitch.tv/oauth2/token', {
    client_id: cfg.twitchClientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  if (t.status !== 200) {
    log('Token-Refresh fehlgeschlagen, neuer Login nötig.');
    await deviceLogin();
    return;
  }
  tokens = { ...tokens, access_token: t.body.access_token, refresh_token: t.body.refresh_token };
  saveTokens();
}

async function validate(retry = true) {
  const r = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${tokens.access_token}` },
  });
  if (r.status === 401 && retry) { await refreshToken(); return validate(false); }
  if (!r.ok) throw new Error('Twitch-Token ungültig (HTTP ' + r.status + ')');
  const j = await r.json();
  if (!SCOPES.every((s) => j.scopes.includes(s))) {
    if (!retry) throw new Error('Fehlende Scopes: ' + SCOPES.join(', '));
    await deviceLogin();
    return validate(false);
  }
  tokens.user_id = j.user_id;
  tokens.login = j.login;
  saveTokens();
}

async function helix(method, pathAndQuery, body, retry = true) {
  const r = await fetch('https://api.twitch.tv/helix' + pathAndQuery, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Client-Id': cfg.twitchClientId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) {
    await refreshToken();
    return helix(method, pathAndQuery, body, false);
  }
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

/* ------------------------------------------------------------------ */
/* Reward                                                              */
/* ------------------------------------------------------------------ */

async function ensureReward() {
  const uid = tokens.user_id;
  const list = await helix('GET', `/channel_points/custom_rewards?broadcaster_id=${uid}&only_manageable_rewards=true`);
  if (list.status !== 200) {
    throw new Error('Rewards laden fehlgeschlagen: ' + JSON.stringify(list.body) + ' (Channel Points nur für Affiliate/Partner)');
  }
  const found = list.body.data.find((r) => r.title === cfg.rewardTitle);
  if (found) return found.id;

  const c = await helix('POST', `/channel_points/custom_rewards?broadcaster_id=${uid}`, {
    title: cfg.rewardTitle,
    cost: cfg.rewardCost,
    prompt: cfg.rewardPrompt,
    is_user_input_required: true,
    should_redemptions_skip_request_queue: false, // nötig, damit der Bot Punkte zurückgeben kann
  });
  if (c.status !== 200) {
    throw new Error(
      'Reward erstellen fehlgeschlagen: ' + JSON.stringify(c.body) +
      '\nFalls ein Reward mit gleichem Titel manuell existiert: löschen oder REWARD_TITLE ändern.'
    );
  }
  log('Reward erstellt:', cfg.rewardTitle);
  return c.body.data[0].id;
}

async function setStatus(ev, status) {
  const r = await helix(
    'PATCH',
    `/channel_points/custom_rewards/redemptions?id=${ev.id}&broadcaster_id=${tokens.user_id}&reward_id=${ev.reward.id}`,
    { status }
  );
  if (r.status !== 200) log('Status-Update fehlgeschlagen:', status, r.status, r.body.message || '');
}

async function say(msg) {
  if (!cfg.chatAnnounce) return;
  const r = await helix('POST', '/chat/messages', {
    broadcaster_id: tokens.user_id,
    sender_id: tokens.user_id,
    message: msg.slice(0, 480),
  });
  if (r.status !== 200) log('Chat-Nachricht fehlgeschlagen:', r.status, r.body.message || '');
}

/* ------------------------------------------------------------------ */
/* 7TV                                                                 */
/* ------------------------------------------------------------------ */

const CHANGE_EMOTES = `
mutation ChangeEmotes($id: ObjectID!, $action: ListItemAction!, $emote_id: ObjectID!, $name: String) {
  emoteSet(id: $id) {
    id
    emotes(id: $emote_id, action: $action, name: $name) { id name }
  }
}`;

async function gql(query, variables) {
  const r = await fetch('https://7tv.io/v3/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.sevenTvToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) {
    const msg = j.errors?.[0]?.message || `7TV HTTP ${r.status}`;
    if (/auth|token|privilege|permission/i.test(msg)) log('Hinweis: 7TV-Token abgelaufen oder keine Editor-Rechte im Emote-Set?');
    throw new Error(msg);
  }
  return j.data;
}

const addEmote = (emoteId, name) => gql(CHANGE_EMOTES, { id: setId, action: 'ADD', emote_id: emoteId, name });
const removeEmote = (emoteId) => gql(CHANGE_EMOTES, { id: setId, action: 'REMOVE', emote_id: emoteId });

async function getSet() {
  const r = await fetch(`https://7tv.io/v3/emote-sets/${setId}`);
  if (!r.ok) throw new Error('Emote-Set laden fehlgeschlagen (HTTP ' + r.status + ')');
  return r.json();
}

async function getEmote(id) {
  const r = await fetch(`https://7tv.io/v3/emotes/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Emote laden fehlgeschlagen (HTTP ' + r.status + ')');
  return r.json();
}

async function findSetId() {
  if (cfg.emoteSetId) return cfg.emoteSetId;
  const r = await fetch(`https://7tv.io/v3/users/twitch/${tokens.user_id}`);
  if (!r.ok) throw new Error('Kein 7TV-Account zu diesem Twitch-Kanal gefunden (HTTP ' + r.status + '). EMOTE_SET_ID setzen.');
  const j = await r.json();
  const id = j.emote_set_id || j.emote_set?.id;
  if (!id) throw new Error('Kein aktives 7TV-Emote-Set gefunden. EMOTE_SET_ID setzen.');
  return id;
}

function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base.slice(0, 95)}${i}`;
    if (!taken.has(n)) return n;
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Redemption-Logik                                                    */
/* ------------------------------------------------------------------ */

async function handleRedemption(ev) {
  const user = ev.user_name;
  log(`Redeem von ${user}: ${ev.user_input}`);

  const fail = async (reason) => {
    log('✗', reason);
    await setStatus(ev, 'CANCELED'); // Punkte zurück
    await say(`@${user} ${reason} – Punkte zurück.`);
  };

  const m = (ev.user_input || '').match(LINK_RE);
  if (!m) return fail('Kein gültiger 7TV-Link gefunden');
  const emoteId = m[1];

  let emote;
  try { emote = await getEmote(emoteId); } catch (e) { return fail('7TV nicht erreichbar'); }
  if (!emote) return fail('Emote nicht gefunden');
  if (cfg.blockUnsafeEmotes && (emote.flags & (FLAG_SEXUAL | FLAG_TWITCH_DISALLOWED))) {
    return fail('Dieses Emote ist nicht erlaubt');
  }

  let set;
  try { set = await getSet(); } catch (e) { return fail('Emote-Set nicht erreichbar'); }
  const inSet = new Set(set.emotes.map((e) => e.id));
  if (inSet.has(emoteId)) return fail('Emote ist schon im Kanal');

  // State mit echtem Set abgleichen (manuell entfernte Emotes raus; frische Einträge wegen Cache behalten)
  state.emotes = state.emotes.filter((e) => inSet.has(e.id) || Date.now() - e.addedAt < 120000);

  // FIFO: ältestes entfernen, bis Platz ist
  const removedIds = new Set();
  const removedNames = [];
  while (state.emotes.length >= MAX_EMOTES) {
    const old = state.emotes[0];
    try {
      await removeEmote(old.id);
    } catch (e) {
      saveState();
      return fail('7TV-Fehler beim Entfernen des ältesten Emotes');
    }
    state.emotes.shift();
    removedIds.add(old.id);
    removedNames.push(old.name);
    log('– entfernt:', old.name);
  }

  const taken = new Set(set.emotes.filter((e) => !removedIds.has(e.id)).map((e) => e.name));
  const name = uniqueName(emote.name, taken);

  try {
    await addEmote(emoteId, name);
  } catch (e) {
    saveState();
    return fail('7TV hat das Emote abgelehnt: ' + e.message.slice(0, 120));
  }

  state.emotes.push({ id: emoteId, name, user, addedAt: Date.now() });
  saveState();
  log('+ hinzugefügt:', name);

  await setStatus(ev, 'FULFILLED');
  await say(
    `✅ ${name} wurde von @${user} hinzugefügt` +
    (removedNames.length ? ` (entfernt: ${removedNames.join(', ')})` : '')
  );
}

/* ------------------------------------------------------------------ */
/* EventSub WebSocket                                                  */
/* ------------------------------------------------------------------ */

let queue = Promise.resolve(); // Redeems nacheinander abarbeiten
const seen = new Set();
let currentWs = null;

async function subscribe(sessionId) {
  const r = await helix('POST', '/eventsub/subscriptions', {
    type: 'channel.channel_points_custom_reward_redemption.add',
    version: '1',
    condition: { broadcaster_user_id: tokens.user_id, reward_id: rewardId },
    transport: { method: 'websocket', session_id: sessionId },
  });
  if (r.status === 202) log('Redeem-Listener aktiv. Warte auf Redeems …');
  else log('EventSub-Subscription fehlgeschlagen:', r.status, JSON.stringify(r.body));
}

function connectEventSub(url = 'wss://eventsub.wss.twitch.tv/ws', isReconnect = false, oldWs = null) {
  const ws = new WebSocket(url);
  let timeoutSec = 10;

  const arm = () => {
    clearTimeout(ws._ka);
    ws._ka = setTimeout(() => { log('Keepalive-Timeout → Reconnect'); ws.terminate(); }, (timeoutSec + 5) * 1000);
  };

  ws.on('open', () => log('EventSub verbunden.'));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    arm();
    const type = msg.metadata?.message_type;

    if (type === 'session_welcome') {
      timeoutSec = msg.payload.session.keepalive_timeout_seconds || 10;
      arm();
      if (!isReconnect) await subscribe(msg.payload.session.id);
      currentWs = ws;
      if (oldWs) {
        oldWs.removeAllListeners('close');
        clearTimeout(oldWs._ka);
        oldWs.close();
      }
    } else if (type === 'session_reconnect') {
      connectEventSub(msg.payload.session.reconnect_url, true, ws);
    } else if (type === 'notification') {
      if (msg.payload.subscription.type !== 'channel.channel_points_custom_reward_redemption.add') return;
      const ev = msg.payload.event;
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      queue = queue
        .then(() => handleRedemption(ev))
        .catch(async (e) => {
          log('Unerwarteter Fehler:', e.message);
          await setStatus(ev, 'CANCELED').catch(() => {});
        });
    } else if (type === 'revocation') {
      log('Subscription widerrufen:', msg.payload.subscription.status, '– Bot bitte neu starten.');
    }
  });

  ws.on('close', () => {
    clearTimeout(ws._ka);
    if (ws === currentWs || !currentWs) {
      log('Verbindung getrennt – neuer Versuch in 5s');
      currentWs = null;
      setTimeout(() => connectEventSub(), 5000);
    }
  });

  ws.on('error', (e) => log('WebSocket-Fehler:', e.message));
}

/* ------------------------------------------------------------------ */

async function main() {
  if (!cfg.twitchClientId || cfg.twitchClientId.startsWith('DEINE')) throw new Error('TWITCH_CLIENT_ID fehlt (Env-Variable oder config.json).');
  if (!cfg.sevenTvToken || cfg.sevenTvToken.startsWith('DEIN')) throw new Error('SEVENTV_TOKEN fehlt (Env-Variable oder config.json).');

  if (!tokens) await deviceLogin();
  await validate();
  log(`Twitch: eingeloggt als ${tokens.login}`);

  setId = await findSetId();
  log('7TV Emote-Set:', setId);

  rewardId = await ensureReward();
  log('Reward-ID:', rewardId);

  connectEventSub();
}

main().catch((e) => { console.error('\nFEHLER:', e.message); process.exit(1); });
