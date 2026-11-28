const fs = require('fs');
const path = require('path');
const isOwnerOrSudo = require('../lib/isOwner');
const { getOwnerDmJids } = require('./viewonce');

const STALKERS_FILE = path.join(process.cwd(), 'data', 'stalkers.json');
const SNIPER_FILE = path.join(process.cwd(), 'data', 'sniper.json');

const presenceAlertCooldown = new Map();
const sniperDedupIds = new Map();
let activePollTimer = null;

function ensureDataFile(filePath, defaultObj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultObj, null, 2));
  }
}

function loadStalkers() {
  try {
    ensureDataFile(STALKERS_FILE, { targets: {} });
    const parsed = JSON.parse(fs.readFileSync(STALKERS_FILE, 'utf8'));
    return parsed && typeof parsed.targets === 'object' ? parsed : { targets: {} };
  } catch (_) {
    return { targets: {} };
  }
}

function saveStalkers(data) {
  try {
    ensureDataFile(STALKERS_FILE, { targets: {} });
    fs.writeFileSync(STALKERS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[ShadowIntel] Error saving stalkers:', err.message);
  }
}

function loadSniper() {
  try {
    ensureDataFile(SNIPER_FILE, { enabled: true, keywords: [] });
    const parsed = JSON.parse(fs.readFileSync(SNIPER_FILE, 'utf8'));
    return {
      enabled: parsed?.enabled !== false,
      keywords: Array.isArray(parsed?.keywords) ? parsed.keywords : []
    };
  } catch (_) {
    return { enabled: true, keywords: [] };
  }
}

function saveSniper(data) {
  try {
    ensureDataFile(SNIPER_FILE, { enabled: true, keywords: [] });
    fs.writeFileSync(SNIPER_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[ShadowIntel] Error saving sniper:', err.message);
  }
}

function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const num = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!num) return null;
  return `${num}@s.whatsapp.net`;
}

function extractNumericId(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function formatDuration(ms) {
  const sec = Math.max(1, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

async function sendOwnerAlert(sock, payload) {
  const ownerJids = getOwnerDmJids(sock);
  for (const jid of ownerJids) {
    try {
      await sock.sendMessage(jid, payload);
    } catch (err) {
      console.error('[ShadowIntel] Failed to alert owner DM:', err.message);
    }
  }
}

async function fetchTargetSnapshot(sock, jid) {
  let dpUrl = null;
  let bio = null;
  try {
    dpUrl = await sock.profilePictureUrl(jid, 'image');
  } catch (_) {
    try {
      dpUrl = await sock.profilePictureUrl(jid, 'preview');
    } catch (_) {}
  }
  try {
    const statusData = await sock.fetchStatus(jid);
    if (statusData?.status !== undefined) bio = statusData.status;
  } catch (_) {}
  return { dpUrl, bio };
}

function extractTargetFromMessage(message, argsText = '') {
  const ctx = message?.message?.extendedTextMessage?.contextInfo;
  if (ctx?.mentionedJid?.length) {
    return normalizeJid(ctx.mentionedJid[0]);
  }
  if (ctx?.participant) {
    return normalizeJid(ctx.participant);
  }
  const digits = String(argsText || '').replace(/[^0-9]/g, '');
  if (digits.length >= 7 && digits.length <= 16) {
    return `${digits}@s.whatsapp.net`;
  }
  if (message?.key?.remoteJid?.endsWith('@s.whatsapp.net') && !message.key.fromMe) {
    return normalizeJid(message.key.remoteJid);
  }
  return null;
}

// ==========================================
// 1. LIVE GHOST STALKER (.stalk)
// ==========================================

async function stalkCommand(sock, chatId, message, rawText = '') {
  const sender = message.key.participant || message.key.remoteJid;
  const isOwner = message.key.fromMe || await isOwnerOrSudo(sender, sock, chatId);
  if (!isOwner) {
    return sock.sendMessage(chatId, {
      text: '❌ *Access Denied:* Only the bot owner can use `.stalk`.'
    }, { quoted: message });
  }

  const argsStr = String(rawText || '').replace(/^\.?stalk\s*/i, '').trim();
  const tokens = argsStr ? argsStr.split(/\s+/) : [];
  const first = (tokens[0] || '').toLowerCase();

  const data = loadStalkers();

  if (!argsStr || first === 'help') {
    const count = Object.keys(data.targets).length;
    const card = `╭━━━〔 👻 ɢʜᴏꜱᴛ ꜱᴛᴀʟᴋᴇʀ 〕━━━╮
┃
┃ 📡 *Active Targets* : ${count}
┃
┣━━〔 💡 ᴄᴏᴍᴍᴀɴᴅꜱ 〕━━┫
┃ ✦ *.stalk @user / <num>*      ➔ Start tracking
┃ ✦ *.stalk @user / <num> off*  ➔ Stop tracking
┃ ✦ *.stalk list*               ➔ Show all targets
┃ ✦ *.stalk clear*              ➔ Remove all targets
┃
┃ 🔔 *Tracks:* Online/Offline, Session Duration,
┃    Typing/Recording, DP Changes & Bio Changes!
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
    return sock.sendMessage(chatId, { text: card }, { quoted: message });
  }

  if (first === 'list') {
    const entries = Object.entries(data.targets);
    if (entries.length === 0) {
      return sock.sendMessage(chatId, { text: '👻 *Ghost Stalker:* No targets are currently tracked.' }, { quoted: message });
    }
    const lines = entries.map(([jid, info], i) => {
      const num = extractNumericId(jid);
      const state = info.lastPresence === 'available' ? '🟢 Online' : '⚫ Offline/Idle';
      return `${i + 1}. +${num} — ${state}`;
    });
    return sock.sendMessage(chatId, {
      text: `╭━━━〔 👻 ᴀᴄᴛɪᴠᴇ ꜱᴛᴀʟᴋ ᴛᴀʀɢᴇᴛꜱ 〕━━━╮\n\n${lines.join('\n')}\n\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
    }, { quoted: message });
  }

  if (first === 'clear') {
    data.targets = {};
    saveStalkers(data);
    return sock.sendMessage(chatId, { text: '🗑️ *Ghost Stalker:* All targets cleared.' }, { quoted: message });
  }

  const lastToken = tokens[tokens.length - 1]?.toLowerCase();
  const turnOff = lastToken === 'off' || lastToken === 'stop' || lastToken === 'remove' || first === 'off';
  const targetJid = extractTargetFromMessage(message, argsStr);

  if (!targetJid) {
    return sock.sendMessage(chatId, {
      text: '❌ Specify a valid target: `.stalk @user`, `.stalk 919876543210`, or reply to their message.'
    }, { quoted: message });
  }

  const num = extractNumericId(targetJid);

  if (turnOff) {
    if (!data.targets[targetJid]) {
      return sock.sendMessage(chatId, { text: `ℹ️ +${num} was not on the stalk list.` }, { quoted: message });
    }
    delete data.targets[targetJid];
    saveStalkers(data);
    return sock.sendMessage(chatId, { text: `🛑 Stopped stalking *+${num}*.` }, { quoted: message });
  }

  const snap = await fetchTargetSnapshot(sock, targetJid);
  data.targets[targetJid] = {
    addedAt: Date.now(),
    lastPresence: 'unknown',
    onlineSince: null,
    lastDpUrl: snap.dpUrl || null,
    lastBio: snap.bio || null
  };
  saveStalkers(data);

  try {
    await sock.presenceSubscribe(targetJid);
  } catch (_) {}

  return sock.sendMessage(chatId, {
    text: `👻 *Ghost Stalker Armed!*\n\n🎯 *Target:* @${num} (+${num})\n📡 *Tracking:* Online/Offline, Typing, Recording, DP & Bio changes\n📩 *Alerts:* Sent silently to Owner DM 24/7.`,
    mentions: [targetJid]
  }, { quoted: message });
}

async function handleStalkPresenceUpdate(sock, update) {
  try {
    if (!update || !update.presences) return;
    const data = loadStalkers();
    const targetEntries = Object.entries(data.targets);
    if (targetEntries.length === 0) return;

    const chatId = update.id || '';
    const isGroup = chatId.endsWith('@g.us');
    let chatLabel = 'Private Chat';
    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId).catch(() => null);
        chatLabel = meta?.subject || 'Group';
      } catch (_) {
        chatLabel = 'Group';
      }
    }

    for (const [participantJid, presenceObj] of Object.entries(update.presences)) {
      const pNum = extractNumericId(participantJid);
      if (!pNum) continue;

      const matchedEntry = targetEntries.find(([tJid]) => extractNumericId(tJid) === pNum);
      if (!matchedEntry) continue;

      const [targetJid, targetInfo] = matchedEntry;
      const status = presenceObj?.lastKnownPresence;
      if (!status) continue;

      const cooldownKey = `${pNum}:${status}:${chatId}`;
      const lastAlertAt = presenceAlertCooldown.get(cooldownKey) || 0;
      if (Date.now() - lastAlertAt < 5000) continue;

      const prevStatus = targetInfo.lastPresence;

      if (status === 'available' && prevStatus !== 'available') {
        targetInfo.lastPresence = 'available';
        targetInfo.onlineSince = Date.now();
        saveStalkers(data);
        presenceAlertCooldown.set(cooldownKey, Date.now());

        await sendOwnerAlert(sock, {
          text: `👻 *GHOST STALKER ALERT*\n\n🟢 *@${pNum} is ONLINE now!*\n🕒 *Time:* ${formatTime()}`,
          mentions: [targetJid]
        });
      } else if (status === 'unavailable' && prevStatus === 'available') {
        const duration = targetInfo.onlineSince ? formatDuration(Date.now() - targetInfo.onlineSince) : 'unknown';
        targetInfo.lastPresence = 'unavailable';
        targetInfo.onlineSince = null;
        saveStalkers(data);
        presenceAlertCooldown.set(cooldownKey, Date.now());

        await sendOwnerAlert(sock, {
          text: `👻 *GHOST STALKER ALERT*\n\n⚫ *@${pNum} went OFFLINE*\n⏱️ *Online Duration:* ${duration}\n🕒 *Time:* ${formatTime()}`,
          mentions: [targetJid]
        });
      } else if (status === 'composing' || status === 'recording') {
        presenceAlertCooldown.set(cooldownKey, Date.now());
        const actionLabel = status === 'recording' ? '🎙️ Recording a voice note' : '⌨️ Typing a message';
        await sendOwnerAlert(sock, {
          text: `👻 *GHOST STALKER ALERT*\n\n${actionLabel}\n🎯 *Target:* @${pNum}\n📍 *Where:* ${chatLabel}\n🕒 *Time:* ${formatTime()}`,
          mentions: [targetJid]
        });
      }
    }
  } catch (err) {
    console.error('[ShadowIntel] presence.update error:', err.message);
  }
}

async function pollStalkedProfiles(sock) {
  try {
    if (!sock?.user) return;
    const data = loadStalkers();
    const entries = Object.entries(data.targets);
    if (entries.length === 0) return;

    let changed = false;
    for (const [targetJid, info] of entries) {
      const num = extractNumericId(targetJid);
      const snap = await fetchTargetSnapshot(sock, targetJid);

      if (snap.dpUrl && info.lastDpUrl && snap.dpUrl !== info.lastDpUrl) {
        info.lastDpUrl = snap.dpUrl;
        changed = true;
        await sendOwnerAlert(sock, {
          image: { url: snap.dpUrl },
          caption: `👻 *GHOST STALKER: DP CHANGED!*\n\n🎯 *Target:* @${num}\n🕒 *Time:* ${formatTime()}`,
          mentions: [targetJid]
        });
      } else if (snap.dpUrl && !info.lastDpUrl) {
        info.lastDpUrl = snap.dpUrl;
        changed = true;
      }

      if (snap.bio !== null && info.lastBio !== null && snap.bio !== info.lastBio) {
        const oldBio = info.lastBio || '_empty_';
        info.lastBio = snap.bio;
        changed = true;
        await sendOwnerAlert(sock, {
          text: `👻 *GHOST STALKER: BIO CHANGED!*\n\n🎯 *Target:* @${num}\n📜 *Old Bio:* ${oldBio}\n✏️ *New Bio:* ${snap.bio || '_empty_'}\n🕒 *Time:* ${formatTime()}`,
          mentions: [targetJid]
        });
      } else if (snap.bio !== null && info.lastBio === null) {
        info.lastBio = snap.bio;
        changed = true;
      }
    }

    if (changed) saveStalkers(data);
  } catch (_) {}
}

function initStalkerSubscriptions(sock) {
  try {
    const data = loadStalkers();
    for (const targetJid of Object.keys(data.targets)) {
      sock.presenceSubscribe(targetJid).catch(() => {});
    }
    if (activePollTimer) clearInterval(activePollTimer);
    activePollTimer = setInterval(() => {
      const liveSock = global.activeSockets?.get('session1') || sock;
      pollStalkedProfiles(liveSock);
    }, 3 * 60 * 1000);
  } catch (_) {}
}

// ==========================================
// 2. 24/7 KEYWORD SNIPER (.snipe)
// ==========================================

async function snipeCommand(sock, chatId, message, rawText = '') {
  const sender = message.key.participant || message.key.remoteJid;
  const isOwner = message.key.fromMe || await isOwnerOrSudo(sender, sock, chatId);
  if (!isOwner) {
    return sock.sendMessage(chatId, {
      text: '❌ *Access Denied:* Only the bot owner can use `.snipe`.'
    }, { quoted: message });
  }

  const argsStr = String(rawText || '').replace(/^\.?snipe\s*/i, '').trim();
  const [subRaw, ...rest] = argsStr.split(/\s+/);
  const sub = (subRaw || '').toLowerCase();
  const payload = rest.join(' ').trim();

  const data = loadSniper();

  if (!argsStr || sub === 'help') {
    const card = `╭━━━〔 🎯 24/7 ᴋᴇʏᴡᴏʀᴅ ꜱɴɪᴘᴇʀ 〕━━━╮
┃
┃ 📡 *Status*   : ${data.enabled ? 'ON 🟢' : 'OFF 🔴'}
┃ 🔍 *Keywords* : ${data.keywords.length} tracked
┃
┣━━〔 💡 ᴄᴏᴍᴍᴀɴᴅꜱ 〕━━┫
┃ ✦ *.snipe add <word>*  ➔ Track secret keyword
┃ ✦ *.snipe del <word>*  ➔ Remove keyword
┃ ✦ *.snipe list*        ➔ Show tracked words
┃ ✦ *.snipe on / off*    ➔ Toggle sniper
┃ ✦ *.snipe clear*       ➔ Wipe all keywords
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
    return sock.sendMessage(chatId, { text: card }, { quoted: message });
  }

  if (sub === 'on' || sub === 'off') {
    data.enabled = sub === 'on';
    saveSniper(data);
    return sock.sendMessage(chatId, {
      text: `🎯 *Keyword Sniper* is now *${data.enabled ? 'ON 🟢' : 'OFF 🔴'}*.`
    }, { quoted: message });
  }

  if (sub === 'list') {
    if (data.keywords.length === 0) {
      return sock.sendMessage(chatId, { text: '🎯 *Keyword Sniper:* Watchlist is empty. Use `.snipe add <word>`.' }, { quoted: message });
    }
    const listText = data.keywords.map((k, i) => `${i + 1}. \`${k}\``).join('\n');
    return sock.sendMessage(chatId, {
      text: `🎯 *Sniper Watchlist (${data.enabled ? 'ON 🟢' : 'OFF 🔴'}):*\n\n${listText}`
    }, { quoted: message });
  }

  if (sub === 'clear') {
    data.keywords = [];
    saveSniper(data);
    return sock.sendMessage(chatId, { text: '🗑️ *Keyword Sniper:* All keywords cleared.' }, { quoted: message });
  }

  if (sub === 'add') {
    if (!payload) {
      return sock.sendMessage(chatId, { text: 'Usage: `.snipe add <keyword>`' }, { quoted: message });
    }
    const norm = payload.toLowerCase();
    if (!data.keywords.includes(norm)) {
      data.keywords.push(norm);
    }
    data.enabled = true;
    saveSniper(data);
    return sock.sendMessage(chatId, {
      text: `🎯 *Sniper Armed!* Now silently tracking \`${norm}\` across all groups & DMs.`
    }, { quoted: message });
  }

  if (sub === 'del' || sub === 'remove') {
    if (!payload) {
      return sock.sendMessage(chatId, { text: 'Usage: `.snipe del <keyword>`' }, { quoted: message });
    }
    const norm = payload.toLowerCase();
    data.keywords = data.keywords.filter(k => k !== norm);
    saveSniper(data);
    return sock.sendMessage(chatId, {
      text: `🗑️ Removed \`${norm}\` from sniper watchlist.`
    }, { quoted: message });
  }

  return sock.sendMessage(chatId, {
    text: 'Usage: `.snipe add <word>` | `.snipe del <word>` | `.snipe list` | `.snipe on/off`'
  }, { quoted: message });
}

async function checkSniperHit(sock, message, rawText = '') {
  try {
    if (!rawText || message?.key?.fromMe) return false;
    if (/^\.?snipe\b/i.test(rawText.trim())) return false;

    const msgId = message?.key?.id;
    if (msgId && sniperDedupIds.has(msgId)) return false;

    const data = loadSniper();
    if (!data.enabled || data.keywords.length === 0) return false;

    const lower = rawText.toLowerCase();
    const matched = data.keywords.find(kw => kw && lower.includes(kw));
    if (!matched) return false;

    if (msgId) {
      sniperDedupIds.set(msgId, Date.now());
      if (sniperDedupIds.size > 500) {
        const firstKey = sniperDedupIds.keys().next().value;
        sniperDedupIds.delete(firstKey);
      }
    }

    const chatId = message.key.remoteJid || '';
    const senderJid = message.key.participant || chatId;
    const senderNum = extractNumericId(senderJid) || 'Unknown';
    const pushName = message.pushName ? ` (${message.pushName})` : '';
    const isGroup = chatId.endsWith('@g.us');

    let chatLabel = '👤 Private DM';
    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId).catch(() => null);
        chatLabel = `👥 ${meta?.subject || 'Group'}`;
      } catch (_) {
        chatLabel = '👥 Group';
      }
    }

    const card = `╭━━━〔 🎯 ꜱɴɪᴘᴇʀ ʜɪᴛ ᴅᴇᴛᴇᴄᴛᴇᴅ 〕━━━╮
┃ 🔍 *Keyword* : \`${matched}\`
┃ 👤 *Sender*  : @${senderNum}${pushName}
┃ 📍 *Chat*    : ${chatLabel}
┃ 🕒 *Time*    : ${formatTime()}
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

💬 *Message:*
${rawText}`;

    await sendOwnerAlert(sock, {
      text: card,
      mentions: senderJid ? [senderJid] : []
    });
    return true;
  } catch (err) {
    console.error('[ShadowIntel] checkSniperHit error:', err.message);
    return false;
  }
}

// ==========================================
// 3. TIME-BOMB SELF-DESTRUCT (.bomb)
// ==========================================

async function bombCommand(sock, chatId, message, rawText = '') {
  const sender = message.key.participant || message.key.remoteJid;
  const isOwner = message.key.fromMe || await isOwnerOrSudo(sender, sock, chatId);
  if (!isOwner) {
    return sock.sendMessage(chatId, {
      text: '❌ *Access Denied:* Only the bot owner can use `.bomb`.'
    }, { quoted: message });
  }

  const match = String(rawText || '').trim().match(/^\.?bomb\s+(\d+)\s+([\s\S]+)/i);
  if (!match) {
    return sock.sendMessage(chatId, {
      text: '💣 *Usage:* `.bomb <seconds> <secret message>`\nExample: `.bomb 10 Meet me at 9pm`'
    }, { quoted: message });
  }

  const seconds = Math.min(300, Math.max(1, parseInt(match[1], 10)));
  const body = match[2].trim();

  // Attempt to delete the trigger command for stealth
  try {
    await sock.sendMessage(chatId, { delete: message.key });
  } catch (_) {}

  const sent = await sock.sendMessage(chatId, {
    text: `💣 *[SELF-DESTRUCT IN ${seconds}s]*\n\n${body}`
  });

  if (sent?.key) {
    setTimeout(async () => {
      try {
        await sock.sendMessage(chatId, { delete: sent.key });
      } catch (_) {}
    }, seconds * 1000);
  }
}

module.exports = {
  stalkCommand,
  handleStalkPresenceUpdate,
  initStalkerSubscriptions,
  snipeCommand,
  checkSniperHit,
  bombCommand
};
