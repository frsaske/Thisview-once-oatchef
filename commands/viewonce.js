const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const isOwnerOrSudo = require('../lib/isOwner');
const { downloadContentFromMessage, downloadMediaMessage } = require('@whiskeysockets/baileys');

const CACHE_DIR = path.join(process.cwd(), 'tmp', 'viewonce_cache');
const UNAVAILABLE_INDEX_FILE = path.join(CACHE_DIR, '_unavailable.json');
const AUTO_VIEWONCE_CONFIG = path.join(process.cwd(), 'data', 'autoViewOnce.json');
const MAX_CACHE_ENTRIES = 300;
const REPLY_DEDUP_TTL_MS = 2 * 60 * 1000;

function isAutoViewOnceEnabled() {
  try {
    if (!fs.existsSync(AUTO_VIEWONCE_CONFIG)) return true;
    const data = JSON.parse(fs.readFileSync(AUTO_VIEWONCE_CONFIG, 'utf8'));
    return data.enabled !== false;
  } catch (_) {
    return true;
  }
}

function setAutoViewOnceEnabled(enabled) {
  try {
    const dir = path.dirname(AUTO_VIEWONCE_CONFIG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTO_VIEWONCE_CONFIG, JSON.stringify({ enabled: Boolean(enabled) }, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving autoViewOnce config:', err.message);
    return false;
  }
}

// In-memory cache for incoming view-once messages (keyed by message ID)
const viewOnceCache = new Map();
// Track view-once unavailability stubs / stripped payloads by message ID
const unavailableViewOnceMap = new Map();
// Deduplication guards
const inFlightCacheIds = new Set();
const inFlightReplyIds = new Set();
const processedReplyIds = new Map();
const autoForwardedIds = new Map();

function ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating viewonce cache directory:', err.message);
  }
}

function toSafeId(msgId) {
  return String(msgId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function hasValidMediaKey(mediaKey) {
  if (!mediaKey) return false;
  if (Buffer.isBuffer(mediaKey) || mediaKey instanceof Uint8Array) return mediaKey.length > 0;
  if (typeof mediaKey === 'string') return mediaKey.length > 0;
  if (typeof mediaKey === 'object') return Object.keys(mediaKey).length > 0;
  return false;
}

function hasDirectMediaLocation(source) {
  return Boolean(source?.url || source?.directPath);
}

function loadCacheFromDisk() {
  ensureCacheDir();
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json') && f !== '_unavailable.json');
    const loaded = [];
    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
        if (!meta?.id) continue;
        const binPath = meta.mediaFile ? path.join(CACHE_DIR, meta.mediaFile) : null;
        if (binPath && !fs.existsSync(binPath)) continue;
        loaded.push({
          ...meta,
          mediaFilePath: binPath,
          buffer: null,
          timestamp: meta.timestamp ? new Date(meta.timestamp) : new Date(0)
        });
      } catch (_) {}
    }

    loaded.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const recent = loaded.slice(-MAX_CACHE_ENTRIES);
    for (const entry of recent) {
      viewOnceCache.set(entry.id, entry);
    }

    // Prune older leftover cache files on disk
    if (loaded.length > MAX_CACHE_ENTRIES) {
      const toRemove = loaded.slice(0, loaded.length - MAX_CACHE_ENTRIES);
      for (const old of toRemove) {
        removeEntryFromDisk(old.id, old.mediaFile);
      }
    }
  } catch (err) {
    console.error('Error loading viewonce cache from disk:', err.message);
  }

  try {
    if (fs.existsSync(UNAVAILABLE_INDEX_FILE)) {
      const list = JSON.parse(fs.readFileSync(UNAVAILABLE_INDEX_FILE, 'utf8'));
      if (Array.isArray(list)) {
        for (const item of list.slice(-MAX_CACHE_ENTRIES)) {
          if (item?.id) unavailableViewOnceMap.set(item.id, item);
        }
      }
    }
  } catch (_) {}
}

function removeEntryFromDisk(msgId, mediaFile = null) {
  try {
    const safeId = toSafeId(msgId);
    const jsonPath = path.join(CACHE_DIR, `${safeId}.json`);
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    const binPath = mediaFile
      ? path.join(CACHE_DIR, mediaFile)
      : path.join(CACHE_DIR, `${safeId}.bin`);
    if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
  } catch (_) {}
}

function saveCacheEntryToDisk(entry, buffer) {
  ensureCacheDir();
  try {
    const safeId = toSafeId(entry.id);
    const mediaFile = buffer ? `${safeId}.bin` : null;
    const mediaFilePath = mediaFile ? path.join(CACHE_DIR, mediaFile) : null;

    if (buffer && mediaFilePath) {
      fs.writeFileSync(mediaFilePath, buffer);
    }

    const meta = {
      id: entry.id,
      mediaType: entry.mediaType,
      sender: entry.sender,
      chatName: entry.chatName,
      isGroup: entry.isGroup,
      remoteJid: entry.remoteJid,
      timestamp: entry.timestamp instanceof Date ? entry.timestamp.toISOString() : new Date().toISOString(),
      mediaFile
    };
    fs.writeFileSync(path.join(CACHE_DIR, `${safeId}.json`), JSON.stringify(meta));
    return mediaFilePath;
  } catch (err) {
    console.error('Error saving viewonce cache entry to disk:', err.message);
    return null;
  }
}

function saveUnavailableIndexToDisk() {
  ensureCacheDir();
  try {
    const list = Array.from(unavailableViewOnceMap.values()).slice(-MAX_CACHE_ENTRIES);
    fs.writeFileSync(UNAVAILABLE_INDEX_FILE, JSON.stringify(list));
  } catch (_) {}
}

loadCacheFromDisk();

function trackUnavailableStub(msg) {
  try {
    if (!msg || msg.message) return false;
    const msgId = msg.key?.id;
    const isViewOnce = Boolean(msg.key?.isViewOnce);
    const stubParams = Array.isArray(msg.messageStubParameters)
      ? msg.messageStubParameters.map(String)
      : [];
    const hasUnavailableParam = stubParams.some(p =>
      /Message absent from node|view_once_unavailable/i.test(p)
    );

    if (!isViewOnce && !hasUnavailableParam) return false;

    const record = {
      id: msgId || `unknown_${Date.now()}`,
      isViewOnce,
      stubParams,
      remoteJid: msg.key?.remoteJid || null,
      participant: msg.key?.participant || null,
      timestamp: Date.now()
    };

    if (msgId) {
      unavailableViewOnceMap.set(msgId, record);
      if (unavailableViewOnceMap.size > MAX_CACHE_ENTRIES) {
        const firstKey = unavailableViewOnceMap.keys().next().value;
        unavailableViewOnceMap.delete(firstKey);
      }
      saveUnavailableIndexToDisk();
    }

    console.warn(
      `⚠️ [ViewOnce] Received empty/unavailable stub (id=${record.id}, isViewOnce=${isViewOnce}, params=${stubParams.join(',') || 'none'}). ` +
      'If this session was paired as WEB or WhatsApp Business, delete sessions/session1 and re-pair as an Android companion.'
    );
    return true;
  } catch (err) {
    console.error('Error in trackUnavailableStub:', err.message);
    return false;
  }
}

function formatUnavailableReason(info) {
  const params = Array.isArray(info?.stubParams) ? info.stubParams : [];
  const isViewOnceFlag = Boolean(info?.isViewOnce) || params.some(p => /view_once_unavailable/i.test(p));
  const isAbsentNode = params.some(p => /Message absent from node/i.test(p));

  if (info?.reason === 'stripped_media_stub' || info?.reason === 'missing_media_key') {
    return (
      '❌ *View-Once Media Unavailable*\n\n' +
      'WhatsApp stripped the `url`, `directPath`, and `mediaKey` from this quoted view-once message, so it cannot be decrypted.\n\n' +
      '*Why this happens:*\n' +
      '• The session was originally paired as a *WEB* companion (delete `sessions/session1` and re-pair with Android mode)\n' +
      '• Or the sender/account is a *WhatsApp Business* account blocking view-once fanout\n' +
      '• Or the view-once expired / was already opened before caching.'
    );
  }

  if (isViewOnceFlag || isAbsentNode || info?.reason === 'empty_envelope') {
    const detail = isViewOnceFlag
      ? 'WhatsApp sent an empty view-once stub (`isViewOnce` / `view_once_unavailable`) with no media payload.'
      : 'WhatsApp sent a `"Message absent from node"` placeholder stub with no encrypted media payload.';

    return (
      '❌ *View-Once Could Not Be Fetched*\n\n' +
      `${detail}\n\n` +
      '*How to fix:*\n' +
      '1. If this bot session was paired before the Android companion fix (WEB identity), delete `sessions/session1` and re-pair from scratch.\n' +
      '2. Note that *WhatsApp Business* accounts may still restrict view-once delivery on companion devices.'
    );
  }

  return (
    '❌ *View-Once Download Failed*\n\n' +
    'Media keys were present, but WhatsApp rejected the download/re-upload request (the view-once media may have expired).'
  );
}

function formatRevealTime(date = new Date()) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hoursStr = String(hours).padStart(2, '0');
  return `${month} ${day}, ${hoursStr}:${minutes} ${ampm}`;
}

// WhatsApp can wrap a view-once message in ephemeralMessage and/or one of
// several viewOnce* envelope versions. Normalize all of those shapes before
// looking for media; otherwise recent Baileys payloads are silently missed.
function unwrapViewOnce(msg) {
  if (!msg) return null;
  let source = msg?.message || msg;
  for (let depth = 0; depth < 5 && source; depth += 1) {
    if (source.ephemeralMessage?.message) {
      source = source.ephemeralMessage.message;
      continue;
    }
    const envelope = source.viewOnceMessageV2 ||
      source.viewOnceMessage ||
      source.viewOnceMessageV2Extension;
    if (envelope?.message) {
      source = envelope.message;
      continue;
    }
    break;
  }
  return source || null;
}

function isViewOnceContent(msg) {
  if (!msg) return false;
  let source = msg?.message || msg;
  for (let depth = 0; depth < 5 && source; depth += 1) {
    if (source.viewOnceMessageV2 || source.viewOnceMessage || source.viewOnceMessageV2Extension) return true;
    if (source.imageMessage?.viewOnce || source.videoMessage?.viewOnce || source.audioMessage?.viewOnce) return true;
    if (source.ephemeralMessage?.message) {
      source = source.ephemeralMessage.message;
      continue;
    }
    break;
  }
  return false;
}

async function toBuffer(content, type) {
  try {
    if (!hasDirectMediaLocation(content) || !hasValidMediaKey(content?.mediaKey)) {
      return null;
    }
    const stream = await downloadContentFromMessage(content, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (err) {
    console.error('Error downloading media stream:', err.message);
    return null;
  }
}

// Some view-once payloads lose url/directPath after read/ack processing.
// Keep a full-message fallback while the original WebMessageInfo is available.
async function toBufferFromMessage(message, sock) {
  try {
    if (typeof downloadMediaMessage !== 'function') return null;
    return await downloadMediaMessage(
      message,
      'buffer',
      {},
      { reuploadRequest: sock?.updateMediaMessage }
    );
  } catch (err) {
    console.error('Error downloading full view-once message:', err.message);
    return null;
  }
}

// Automatically called for every incoming message to cache view-once media
async function cacheIncomingViewOnce(sock, message) {
  const msgId = message?.key?.id;
  try {
    if (!message?.message || !msgId) return;
    if (inFlightCacheIds.has(msgId)) return;

    const existing = viewOnceCache.get(msgId);
    if (existing && (existing.buffer || (existing.mediaFilePath && fs.existsSync(existing.mediaFilePath)))) {
      return;
    }

    if (!isViewOnceContent(message)) return;

    inFlightCacheIds.add(msgId);

    const unwrapped = unwrapViewOnce(message);
    if (!unwrapped) {
      unavailableViewOnceMap.set(msgId, {
        id: msgId,
        isViewOnce: true,
        stubParams: ['view_once_unavailable'],
        remoteJid: message.key?.remoteJid || null,
        participant: message.key?.participant || null,
        timestamp: Date.now()
      });
      saveUnavailableIndexToDisk();
      return;
    }

    let mediaType = null;
    let mediaSource = null;

    if (unwrapped.imageMessage) {
      mediaType = 'image';
      mediaSource = unwrapped.imageMessage;
    } else if (unwrapped.videoMessage) {
      mediaType = 'video';
      mediaSource = unwrapped.videoMessage;
    } else if (unwrapped.audioMessage) {
      mediaType = 'audio';
      mediaSource = unwrapped.audioMessage;
    }

    if (!mediaType || !mediaSource) return;

    const hasMediaKey = hasValidMediaKey(mediaSource.mediaKey);
    const hasUrlOrPath = hasDirectMediaLocation(mediaSource);

    if (!hasMediaKey) {
      unavailableViewOnceMap.set(msgId, {
        id: msgId,
        isViewOnce: true,
        reason: 'missing_media_key',
        remoteJid: message.key?.remoteJid || null,
        participant: message.key?.participant || null,
        timestamp: Date.now()
      });
      saveUnavailableIndexToDisk();
      return;
    }

    // Prefer the full WebMessageInfo: it can unwrap view-once envelopes and
    // re-upload media when the payload has no directPath.
    let buffer = await toBufferFromMessage(message, sock);
    if (!buffer && hasUrlOrPath) {
      buffer = await toBuffer(mediaSource, mediaType);
    }

    const sender = message.key.participant || message.key.remoteJid;
    const isGroup = Boolean(message.key.remoteJid?.endsWith('@g.us'));

    let chatName = 'DM';
    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(message.key.remoteJid).catch(() => null);
        chatName = meta?.subject || 'Gc';
      } catch (_) {
        chatName = 'Gc';
      }
    }

    const entry = {
      id: msgId,
      mediaType,
      mediaSource,
      buffer: buffer || null,
      sourceMessage: buffer ? null : message,
      sender,
      chatName,
      isGroup,
      remoteJid: message.key.remoteJid,
      timestamp: new Date(),
      mediaFilePath: null
    };

    entry.mediaFilePath = saveCacheEntryToDisk(entry, buffer);
    viewOnceCache.set(msgId, entry);

    // Prune oldest if cache grows over MAX_CACHE_ENTRIES
    if (viewOnceCache.size > MAX_CACHE_ENTRIES) {
      const firstKey = viewOnceCache.keys().next().value;
      const evicted = viewOnceCache.get(firstKey);
      viewOnceCache.delete(firstKey);
      removeEntryFromDisk(firstKey, evicted?.mediaFile);
    }

    // 24/7 Auto View-Once -> Owner DM (enabled by default; toggled via .fuck viewonce / .anti viewonce)
    if (buffer && isAutoViewOnceEnabled() && !message.key?.fromMe) {
      await autoForwardViewOnceToOwner(sock, message, entry, buffer, mediaSource?.caption || '');
    }
  } catch (err) {
    console.error('Error in cacheIncomingViewOnce:', err.message);
  } finally {
    if (msgId) inFlightCacheIds.delete(msgId);
  }
}

function getOwnerDmJids(sock, fallbackJid = null) {
  const numbers = new Set();
  const primary = String(settings.ownerNumber || '').split(':')[0].split('@')[0].replace(/\D/g, '');
  if (primary && primary !== '910000000000') numbers.add(primary);

  try {
    const ownersFile = path.join(process.cwd(), 'data', 'owners.json');
    if (fs.existsSync(ownersFile)) {
      const list = JSON.parse(fs.readFileSync(ownersFile, 'utf8'));
      if (Array.isArray(list)) {
        for (const n of list) {
          const clean = String(n || '').split(':')[0].split('@')[0].replace(/\D/g, '');
          if (clean && clean !== '910000000000') numbers.add(clean);
        }
      }
    }
  } catch (_) {}

  if (sock?.user?.id) {
    const botClean = String(sock.user.id).split(':')[0].split('@')[0].replace(/\D/g, '');
    if (botClean && (numbers.size === 0 || !numbers.has(botClean))) {
      numbers.add(botClean);
    }
  }

  const jids = Array.from(numbers).map(n => `${n}@s.whatsapp.net`);
  if (jids.length === 0 && fallbackJid) jids.push(fallbackJid);
  return jids;
}

async function sendRevealedMediaToOwner(sock, ownerJids, { mediaType, buffer, card, senderJid, captionText = '' }) {
  const mentions = senderJid ? [senderJid] : [];
  const fullCaption = captionText ? `${card}\n\n💬 *Caption:* ${captionText}` : card;

  for (const ownerJid of ownerJids) {
    if (mediaType === 'image') {
      await sock.sendMessage(ownerJid, {
        image: buffer,
        caption: fullCaption,
        mentions
      });
    } else if (mediaType === 'video') {
      await sock.sendMessage(ownerJid, {
        video: buffer,
        caption: fullCaption,
        mentions
      });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(ownerJid, { text: fullCaption, mentions });
      await sock.sendMessage(ownerJid, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        ptt: false
      });
    } else {
      await sock.sendMessage(ownerJid, {
        document: buffer,
        mimetype: 'application/octet-stream',
        fileName: `view_once_${Date.now()}`,
        caption: fullCaption,
        mentions
      });
    }
  }
}

async function autoForwardViewOnceToOwner(sock, message, entry, buffer, mediaCaption = '') {
  const msgId = entry?.id || message?.key?.id;
  if (!msgId || !buffer) return false;
  if (autoForwardedIds.has(msgId)) return false;

  autoForwardedIds.set(msgId, Date.now());
  if (autoForwardedIds.size > 500) {
    const firstKey = autoForwardedIds.keys().next().value;
    autoForwardedIds.delete(firstKey);
  }

  try {
    const senderJid = entry.sender || message.key?.participant || message.key?.remoteJid || '';
    const senderPhone = senderJid.split('@')[0].split(':')[0] || 'Unknown';
    const pushName = message.pushName ? ` (${message.pushName})` : '';
    const chatLabel = entry.isGroup ? `👥 ${entry.chatName || 'Group'}` : '👤 Private DM';
    const timeStr = formatRevealTime(entry.timestamp || new Date());

    const card = `╭━━━〔 🔓 ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ 24/7 〕━━━╮
┃ 👤 *From* : @${senderPhone}${pushName}
┃ 📍 *Chat* : ${chatLabel}
┃ 🕒 *Time* : ${timeStr}
┃ 📡 *Mode* : Auto-Intercept ON
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

    const ownerJids = getOwnerDmJids(sock, senderJid);
    await sendRevealedMediaToOwner(sock, ownerJids, {
      mediaType: entry.mediaType,
      buffer,
      card,
      senderJid,
      captionText: mediaCaption
    });
    return true;
  } catch (err) {
    console.error('Error in autoForwardViewOnceToOwner:', err.message);
    return false;
  }
}

// Helper to extract view-once info from a message or its quoted context
function getViewOnceQuoted(message, { requireViewOnceFlag = false } = {}) {
  const normalized = unwrapViewOnce(message);
  const context = normalized?.extendedTextMessage?.contextInfo ||
    normalized?.imageMessage?.contextInfo ||
    normalized?.videoMessage?.contextInfo ||
    normalized?.audioMessage?.contextInfo ||
    normalized?.documentMessage?.contextInfo ||
    message?.message?.extendedTextMessage?.contextInfo ||
    message?.message?.imageMessage?.contextInfo ||
    message?.message?.videoMessage?.contextInfo ||
    message?.message?.audioMessage?.contextInfo ||
    message?.message?.documentMessage?.contextInfo ||
    message?.extendedTextMessage?.contextInfo;

  const quoted = context?.quotedMessage;
  const stanzaId = context?.stanzaId;

  // Check cache first
  if (stanzaId && viewOnceCache.has(stanzaId)) {
    return { fromCache: true, cached: viewOnceCache.get(stanzaId), context, stanzaId };
  }

  // Check if this stanza was previously recorded as an unavailable stub
  if (stanzaId && unavailableViewOnceMap.has(stanzaId)) {
    return {
      unavailable: true,
      info: unavailableViewOnceMap.get(stanzaId),
      context,
      stanzaId
    };
  }

  if (!quoted) return null;

  const unwrapped = unwrapViewOnce(quoted);
  if (!unwrapped) {
    if (isViewOnceContent(quoted)) {
      return {
        unavailable: true,
        info: { id: stanzaId, isViewOnce: true, reason: 'empty_envelope' },
        context,
        stanzaId
      };
    }
    return null;
  }

  if (requireViewOnceFlag && !isViewOnceContent(quoted)) {
    return null;
  }

  let foundKey = null;
  if (unwrapped.imageMessage) {
    foundKey = 'imageMessage';
  } else if (unwrapped.videoMessage) {
    foundKey = 'videoMessage';
  } else if (unwrapped.audioMessage) {
    foundKey = 'audioMessage';
  }

  if (foundKey) {
    return {
      fromCache: false,
      key: foundKey,
      source: unwrapped[foundKey],
      quoted,
      context,
      stanzaId
    };
  }

  if (isViewOnceContent(quoted)) {
    return {
      unavailable: true,
      info: { id: stanzaId, isViewOnce: true, reason: 'empty_envelope' },
      context,
      stanzaId
    };
  }

  return null;
}

function cleanupProcessedReplies() {
  const now = Date.now();
  for (const [id, ts] of processedReplyIds.entries()) {
    if (now - ts > REPLY_DEDUP_TTL_MS) {
      processedReplyIds.delete(id);
    }
  }
  while (processedReplyIds.size > 500) {
    const firstKey = processedReplyIds.keys().next().value;
    processedReplyIds.delete(firstKey);
  }
}

async function processOwnerViewOnceReply(sock, message, chatId, replyText = '', { requireViewOnceFlag = true } = {}) {
  const replyMsgId = message?.key?.id;
  try {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = message.key.fromMe || await isOwnerOrSudo(senderId, sock, chatId);
    if (!isOwner) return { handled: false, reason: 'not_owner' };

    if (replyMsgId && (inFlightReplyIds.has(replyMsgId) || processedReplyIds.has(replyMsgId))) {
      return { handled: true, deduplicated: true };
    }

    const detected = getViewOnceQuoted(message, { requireViewOnceFlag });
    if (!detected) return { handled: false, reason: 'no_quoted_viewonce' };

    if (detected.unavailable) {
      if (replyMsgId) {
        cleanupProcessedReplies();
        processedReplyIds.set(replyMsgId, Date.now());
      }
      return {
        handled: false,
        unavailable: true,
        unavailableMessage: formatUnavailableReason(detected.info)
      };
    }

    if (replyMsgId) inFlightReplyIds.add(replyMsgId);

    let mediaType = '';
    let buffer = null;
    let senderJid = '';
    let chatName = 'Gc';
    let timeObj = new Date();

    if (detected.fromCache) {
      const c = detected.cached;
      mediaType = c.mediaType;
      buffer = c.buffer;
      if (!buffer && c.mediaFilePath && fs.existsSync(c.mediaFilePath)) {
        try {
          buffer = fs.readFileSync(c.mediaFilePath);
        } catch (_) {}
      }
      if (!buffer && c.sourceMessage) {
        const srcMsg = unwrapViewOnce(c.sourceMessage);
        const srcMedia = srcMsg?.imageMessage || srcMsg?.videoMessage || srcMsg?.audioMessage;
        if (hasValidMediaKey(srcMedia?.mediaKey)) {
          buffer = await toBufferFromMessage(c.sourceMessage, sock);
        }
      }
      senderJid = c.sender;
      chatName = c.isGroup ? `👥 ${c.chatName}` : '👤 DM';
      timeObj = c.timestamp;
    } else {
      mediaType = detected.key.replace('Message', '');
      const src = detected.source;
      const hasUrlOrPath = hasDirectMediaLocation(src);
      const hasMediaKey = hasValidMediaKey(src?.mediaKey);

      if (!hasMediaKey) {
        return {
          handled: false,
          unavailable: true,
          unavailableMessage: formatUnavailableReason({ reason: 'stripped_media_stub' })
        };
      }

      if (hasUrlOrPath) {
        buffer = await toBuffer(src, mediaType);
      }

      if (!buffer && hasMediaKey) {
        const quotedWebMsg = {
          key: {
            remoteJid: chatId,
            id: detected.stanzaId || undefined,
            participant: detected.context?.participant || undefined,
            fromMe: false
          },
          message: detected.quoted
        };
        buffer = await toBufferFromMessage(quotedWebMsg, sock);
      }

      if (!buffer) {
        return {
          handled: false,
          unavailable: true,
          unavailableMessage: formatUnavailableReason({
            reason: hasUrlOrPath ? 'download_failed' : 'stripped_media_stub'
          })
        };
      }

      senderJid = detected.context?.participant || detected.context?.remoteJid || senderId;
      const isGroup = chatId.endsWith('@g.us');
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(chatId).catch(() => null);
          chatName = `👥 ${meta?.subject || 'Gc'}`;
        } catch (_) {
          chatName = '👥 Gc';
        }
      } else {
        chatName = '👤 DM';
      }
    }

    if (!buffer) {
      return {
        handled: false,
        unavailable: true,
        unavailableMessage: formatUnavailableReason({ reason: 'download_failed' })
      };
    }

    const senderPhone = (senderJid || '').split('@')[0] || 'Unknown';
    const timeStr = formatRevealTime(timeObj);
    const cmdText = (replyText || '').trim() || '🥀';

    const card = `╭━━━〔 🔓 ᴠɪᴇᴡ-ᴏɴᴄᴇ ʀᴇᴠᴇᴀʟ 〕━━━╮
┃ 👤 *From* : @${senderPhone}
┃ 📍 *Chat* : ${chatName}
┃ 🕒 *Time* : ${timeStr}
┃ ⚡ *Cmd*  : ${cmdText}
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

    const configuredOwner = String(settings.ownerNumber || '').split(':')[0].split('@')[0].replace(/\D/g, '');
    const ownerJid = configuredOwner
      ? `${configuredOwner}@s.whatsapp.net`
      : (message.key.fromMe ? message.key.remoteJid : senderId);

    if (mediaType === 'image') {
      await sock.sendMessage(ownerJid, {
        image: buffer,
        caption: card,
        mentions: [senderJid]
      });
    } else if (mediaType === 'video') {
      await sock.sendMessage(ownerJid, {
        video: buffer,
        caption: card,
        mentions: [senderJid]
      });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(ownerJid, { text: card, mentions: [senderJid] });
      await sock.sendMessage(ownerJid, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        ptt: false
      });
    } else {
      await sock.sendMessage(ownerJid, {
        document: buffer,
        mimetype: 'application/octet-stream',
        fileName: `view_once_${Date.now()}`,
        caption: card,
        mentions: [senderJid]
      });
    }

    if (replyMsgId) {
      cleanupProcessedReplies();
      processedReplyIds.set(replyMsgId, Date.now());
    }

    // Reaction feedback to the owner's message
    try {
      await sock.sendMessage(chatId, {
        react: { text: '🔓', key: message.key }
      });
    } catch (_) {}

    return { handled: true };
  } catch (err) {
    console.error('Error in handleOwnerViewOnceReply:', err);
    return { handled: false, reason: 'error' };
  } finally {
    if (replyMsgId) inFlightReplyIds.delete(replyMsgId);
  }
}

/**
 * Handles view-once extraction when owner replies to any view-once message,
 * or when owner runs .vv / .wow.
 * Sends revealed media directly to the OWNER'S DM with the styled card!
 */
async function handleOwnerViewOnceReply(sock, message, chatId, replyText = '') {
  const result = await processOwnerViewOnceReply(sock, message, chatId, replyText, { requireViewOnceFlag: true });
  return Boolean(result.handled);
}

// Explicit command handler for .wow and .vv
async function viewOnceCommand(sock, chatId, message) {
  const senderId = message.key.participant || message.key.remoteJid;
  const isOwner = message.key.fromMe || await isOwnerOrSudo(senderId, sock, chatId);

  if (!isOwner) {
    return sock.sendMessage(chatId, {
      text: '❌ Only the bot owner can use this command.'
    }, { quoted: message });
  }

  const userText = message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    '.vv';

  const result = await processOwnerViewOnceReply(sock, message, chatId, userText, { requireViewOnceFlag: false });
  if (result.handled) return;

  if (result.unavailable && result.unavailableMessage) {
    return sock.sendMessage(chatId, {
      text: result.unavailableMessage
    }, { quoted: message });
  }

  return sock.sendMessage(chatId, {
    text: '❌ Kisi view-once photo, video ya audio message ko reply karke command bhejo, wo directly aapke DM mein aa jayega!'
  }, { quoted: message });
}

// Secret Admin/Owner toggle command: .fuck viewonce on/off | .anti viewonce on/off
async function autoViewOnceCommand(sock, chatId, message, userMessage = '') {
  try {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = message.key.fromMe || await isOwnerOrSudo(senderId, sock, chatId);

    if (!isOwner) {
      return sock.sendMessage(chatId, {
        text: '❌ *Permission Denied:* Only the bot owner/sudo can toggle Auto View-Once.'
      }, { quoted: message });
    }

    const match = String(userMessage || '').trim().match(/^\.(fuck|anti)\s*view\s*once(?:\s+(\S+))?/i);
    const cmdAlias = match ? `.${match[1].toLowerCase()} viewonce` : '.anti viewonce';
    const action = (match?.[2] || '').toLowerCase().trim();

    if (!action || action === 'status') {
      const enabled = isAutoViewOnceEnabled();
      const card = `╭━━━〔 🔓 ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ 24/7 〕━━━╮
┃
┃ 📡 *Status* : [ ${enabled ? 'ON 🟢 (24/7 ACTIVE)' : 'OFF 🔴'} ]
┃ 📩 *Target* : Owner DM (All DMs & Groups)
┃
┣━━〔 💡 ᴄᴏᴍᴍᴀɴᴅꜱ 〕━━┫
┃ ✦ *.fuck viewonce on*   ➔ Enable 24/7 capture
┃ ✦ *.fuck viewonce off*  ➔ Disable 24/7 capture
┃ ✦ *.anti viewonce on*   ➔ Enable 24/7 capture
┃ ✦ *.anti viewonce off*  ➔ Disable 24/7 capture
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
      return sock.sendMessage(chatId, { text: card }, { quoted: message });
    }

    if (!['on', 'off', 'enable', 'disable', '1', '0'].includes(action)) {
      return sock.sendMessage(chatId, {
        text: `Usage: \`${cmdAlias} on\` or \`${cmdAlias} off\``
      }, { quoted: message });
    }

    const turnOn = ['on', 'enable', '1'].includes(action);
    setAutoViewOnceEnabled(turnOn);

    const card = `╭━━━〔 🔓 ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ 24/7 〕━━━╮
┃
┃ ${turnOn ? '🟢' : '🔴'} *AUTO VIEW-ONCE ${turnOn ? 'ACTIVATED' : 'DEACTIVATED'}*
┃ 📡 *Mode* : [ ${turnOn ? 'ON 24/7 ✅' : 'OFF 🛑'} ]
┃ 📩 *DM*   : ${turnOn ? 'Every view-once from any chat will be sent to Owner DM!' : 'Auto-forwarding paused (.vv / .wow still work)'}
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
    return sock.sendMessage(chatId, { text: card }, { quoted: message });
  } catch (err) {
    console.error('Error in autoViewOnceCommand:', err);
    return sock.sendMessage(chatId, {
      text: '❌ Failed to update Auto View-Once setting.'
    }, { quoted: message });
  }
}

module.exports = viewOnceCommand;
module.exports.viewOnceCommand = viewOnceCommand;
module.exports.handleOwnerViewOnceReply = handleOwnerViewOnceReply;
module.exports.cacheIncomingViewOnce = cacheIncomingViewOnce;
module.exports.getViewOnceQuoted = getViewOnceQuoted;
module.exports.trackUnavailableStub = trackUnavailableStub;
module.exports.autoViewOnceCommand = autoViewOnceCommand;
module.exports.isAutoViewOnceEnabled = isAutoViewOnceEnabled;
module.exports.setAutoViewOnceEnabled = setAutoViewOnceEnabled;
module.exports.getOwnerDmJids = getOwnerDmJids;
