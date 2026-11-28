const fs = require('fs');
const path = require('path');
const axios = require('axios');
const isOwnerOrSudo = require('../lib/isOwner');

const CONFIG = path.join(process.cwd(), 'data', 'autoFeatures.json');
const AUTO_STATUS = path.join(process.cwd(), 'data', 'autoStatus.json');
const AUTO_READ = path.join(process.cwd(), 'data', 'autoread.json');

const defaults = { autoreact: false, autoseen: false, autoonline: false, autoreply: false };

// Rolling per-chat history for AI context (capped for low RAM)
const MAX_CHAT_HISTORY = 18;
const MAX_TRACKED_CHATS = 200;
const chatHistoryMap = new Map();
const repliedMsgIds = new Map();
const inFlightReplyChats = new Set();
const missingKeyNotifiedAt = new Map();
const MISSING_KEY_COOLDOWN_MS = 10 * 60 * 1000;

const SASUKE_TRIGGER_REGEX = /\b(sasukex?|saske|agent|bot)\b/i;

const AGENT_SASUKE_SYSTEM_PROMPT = `You are Agent Sasuke, a sharp, chill AI agent on WhatsApp with live access to the ongoing chat history.
Talk naturally like a real person texting on WhatsApp—match the user's language, slang, and vibe (English, Hindi, or Hinglish).
STRICT RULES:
- Reply in ONE short line only (maximum 1 to 1.5 lines, around 8-22 words).
- Never write paragraphs, bullet points, markdown formatting, or robotic AI disclaimers.
- Use the recent chat messages in history as context so your reply fits the conversation seamlessly.`;

function read() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) };
  } catch (_) {
    return { ...defaults };
  }
}

function save(data) {
  try {
    fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[autoFeatures] Error saving config:', err);
  }
}

// Sync companion files for seamless autoseen / autoread / autostatus
function syncAutoseen(enabled) {
  try {
    let statusCfg = { enabled: false, reactOn: false };
    if (fs.existsSync(AUTO_STATUS)) {
      try { statusCfg = JSON.parse(fs.readFileSync(AUTO_STATUS, 'utf8')); } catch (_) {}
    }
    statusCfg.enabled = enabled;
    fs.writeFileSync(AUTO_STATUS, JSON.stringify(statusCfg, null, 2));

    let readCfg = { enabled: false };
    if (fs.existsSync(AUTO_READ)) {
      try { readCfg = JSON.parse(fs.readFileSync(AUTO_READ, 'utf8')); } catch (_) {}
    }
    readCfg.enabled = enabled;
    fs.writeFileSync(AUTO_READ, JSON.stringify(readCfg, null, 2));
  } catch (err) {
    console.error('[autoFeatures] Error syncing autoseen config:', err);
  }
}

function getMissingAiEnvNotice() {
  return (
    '⚠️ *AI is not configured yet.*\n' +
    'Set `AI_API_KEY` (and optional `AI_BASE_URL`, default: `https://100milionseek.top/v1`) in your server Environment Variables / Hosting Panel Secrets, then restart the bot.'
  );
}

async function toggle(sock, chatId, message, feature, value) {
  const sender = message.key.participant || message.key.remoteJid;
  const isOwner = message.key.fromMe || (await isOwnerOrSudo(sender, sock, chatId));
  if (!isOwner) {
    return sock.sendMessage(chatId, { text: '❌ *Permission Denied*\nOnly the bot owner or sudo can toggle this feature!' }, { quoted: message });
  }

  const data = read();
  const normalizedValue = String(value || '').toLowerCase().trim();

  if (!['on', 'off', 'status', 'enable', 'disable', '1', '0'].includes(normalizedValue) && normalizedValue !== '') {
    return sock.sendMessage(chatId, { text: `Usage: .${feature} on/off` }, { quoted: message });
  }

  const aiCfg = getAiEndpointConfig();
  const aiReady = Boolean(aiCfg.apiKey);

  if (normalizedValue === 'status' || normalizedValue === '') {
    const curState = data[feature] ? 'ON 🟢' : 'OFF 🔴';
    const aiLine = feature === 'autoreply'
      ? `\n┃ 🤖 *AI Key*       : [ ${aiReady ? 'Configured ✅' : 'Missing ⚠️'} ]`
      : '';
    const card = `╭━━━〔 ⚡ ꜱᴀꜱᴜᴋᴇ-𝐗 〕━━━╮
┃
┃ ⚙️ *FEATURE STATUS: ${feature.toUpperCase()}*
┃ 📡 *Current Mode* : [ ${curState} ]${aiLine}
┃
┣━━〔 💡 ᴄᴏᴍᴍᴀɴᴅꜱ 〕━━┫
┃ ✦ *.${feature} on*  ➔ Enable feature
┃ ✦ *.${feature} off* ➔ Disable feature
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯${feature === 'autoreply' && !aiReady ? `\n\n${getMissingAiEnvNotice()}` : ''}`;
    return sock.sendMessage(chatId, { text: card }, { quoted: message });
  }

  const turnOn = ['on', 'enable', '1'].includes(normalizedValue);
  data[feature] = turnOn;
  save(data);

  if (feature === 'autoreact') {
    try {
      const reactions = require('../lib/reactions');
      reactions.setAutoReactionEnabled(turnOn);
    } catch (_) {}
  } else if (feature === 'autoseen') {
    syncAutoseen(turnOn);
  }

  const footerNote = feature === 'autoseen'
    ? (turnOn ? '👁️ Auto-Seen active: incoming messages and WhatsApp statuses will be marked as seen automatically.' : '🛑 Auto-Seen disabled: messages and statuses will not be auto-viewed.')
    : feature === 'autoreply'
      ? (turnOn
        ? (aiReady
          ? '🤖 Agent Sasuke AI Auto-Reply is ON: every message will get a natural 1-line context-aware reply.'
          : `🤖 Auto-Reply mode is ON, but AI cannot reply yet.\n\n${getMissingAiEnvNotice()}`)
        : '🛑 Auto-Reply all-messages paused (mentioning sasuke/saske/agent/bot still triggers Agent Sasuke).')
      : (turnOn ? `✅ *${feature}* is now turned ON.` : `🛑 *${feature}* is now turned OFF.`);

  const card = `╭━━━〔 ⚡ ꜱᴀꜱᴜᴋᴇ-𝐗 〕━━━╮
┃
┃ ${turnOn ? '🟢' : '🔴'} *${feature.toUpperCase()}*
┃
┣━━〔 📋 ᴅᴇᴛᴀɪʟꜱ 〕━━┫
┃ ⚙️ *Setting* : ${feature}
┃ 📡 *Status*  : [ ${turnOn ? 'ACTIVATED ✅' : 'DEACTIVATED 🛑'} ]
┃ 🕒 *Time*    : ${new Date().toLocaleTimeString()}
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
${footerNote}`;

  return sock.sendMessage(chatId, { text: card }, { quoted: message });
}

function getAiEndpointConfig() {
  let rawBase = (process.env.AI_BASE_URL || 'https://100milionseek.top/v1').trim();
  if (!/^https?:\/\//i.test(rawBase)) {
    rawBase = `https://${rawBase}`;
  }
  rawBase = rawBase.replace(/\/+$/, '');
  const url = rawBase.endsWith('/chat/completions') ? rawBase : `${rawBase}/chat/completions`;

  const apiKey = (process.env.AI_API_KEY || process.env.GROQ_API_KEY || '').trim();
  const primaryModel = (process.env.AI_MODEL || 'deepseek-v4.1-flash-free').trim();
  const fallbackModels = primaryModel === 'deepseek-v4.1-flash-free'
    ? ['deepseek-v4.1-flash-free', 'jev-1.13-free']
    : [primaryModel, 'deepseek-v4.1-flash-free'];

  return { url, baseUrl: rawBase, apiKey, models: fallbackModels };
}

function getSenderLabel(message) {
  const push = message?.pushName?.trim();
  const rawJid = message?.key?.participant || message?.key?.remoteJid || '';
  const num = rawJid.split('@')[0].split(':')[0];
  if (push && num) return `${push} (${num})`;
  return push || num || 'User';
}

function extractQuotedText(message) {
  const quoted = message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return '';
  return (
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    ''
  ).trim();
}

function pushChatHistory(chatId, role, content) {
  if (!chatId || !content) return;
  let list = chatHistoryMap.get(chatId);
  if (!list) {
    list = [];
    chatHistoryMap.set(chatId, list);
    if (chatHistoryMap.size > MAX_TRACKED_CHATS) {
      const oldestKey = chatHistoryMap.keys().next().value;
      chatHistoryMap.delete(oldestKey);
    }
  }
  list.push({ role, content });
  if (list.length > MAX_CHAT_HISTORY) {
    list.splice(0, list.length - MAX_CHAT_HISTORY);
  }
}

function recordChatContext(chatId, message, text) {
  if (!chatId || !text || !message?.key) return;
  if (chatId === 'status@broadcast' || chatId.endsWith('@status')) return;
  const trimmed = String(text).trim();
  if (!trimmed || trimmed.startsWith('.')) return;

  const senderLabel = message.key.fromMe ? 'Owner' : getSenderLabel(message);
  const quoted = extractQuotedText(message);
  const entryText = quoted
    ? `[${senderLabel} replying to "${quoted.slice(0, 80)}"]: ${trimmed}`
    : `[${senderLabel}]: ${trimmed}`;

  pushChatHistory(chatId, message.key.fromMe ? 'assistant' : 'user', entryText);
}

function hasSasukeTrigger(text) {
  if (!text) return false;
  return SASUKE_TRIGGER_REGEX.test(String(text));
}

function formatOneLineReply(rawReply) {
  if (!rawReply) return '';
  let clean = String(rawReply)
    .replace(/^(agent\s*sasuke|sasuke)\s*:\s*/i, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (clean.length > 165) {
    const cut = clean.slice(0, 162);
    const lastSpace = cut.lastIndexOf(' ');
    clean = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim() + '...';
  }
  return clean;
}

async function requestAiReply(chatId, message, text) {
  const { url, apiKey, models } = getAiEndpointConfig();
  if (!apiKey) return null;

  const history = chatHistoryMap.get(chatId) || [];
  const contextMessages = history.slice(-MAX_CHAT_HISTORY);

  // Ensure the current message is at the end if not already recorded
  const senderLabel = getSenderLabel(message);
  const currentFormatted = `[${senderLabel}]: ${String(text).trim()}`;
  const lastEntry = contextMessages[contextMessages.length - 1];
  const messagesPayload = [
    { role: 'system', content: AGENT_SASUKE_SYSTEM_PROMPT },
    ...contextMessages
  ];
  if (!lastEntry || !lastEntry.content.endsWith(String(text).trim())) {
    messagesPayload.push({ role: 'user', content: currentFormatted });
  }

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await axios.post(
          url,
          {
            model,
            messages: messagesPayload,
            max_tokens: 90,
            temperature: 0.75
          },
          {
            timeout: 20000,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`
            }
          }
        );

        const rawAnswer = response.data?.choices?.[0]?.message?.content;
        const formatted = formatOneLineReply(rawAnswer);
        if (formatted) return formatted;
      } catch (err) {
        const status = err?.response?.status;
        const code = err?.response?.data?.error?.code;
        if ((status === 429 || status === 503 || code === 'upstream_busy') && attempt === 0) {
          await new Promise(r => setTimeout(r, 1800));
          continue;
        }
        console.error(`[AgentSasuke AI] (${model}) error:`, err?.response?.data?.error?.message || err.message);
        break;
      }
    }
  }
  return null;
}

async function handleAutoReply(sock, chatId, message, text) {
  try {
    if (!chatId || !text || !message?.key) return false;
    if (message.key.fromMe) return false;
    if (chatId === 'status@broadcast' || chatId.endsWith('@status')) return false;

    const trimmed = String(text).trim();
    if (!trimmed || trimmed.startsWith('.') || /^\/(disconnect|sessions|makeowner)\b/i.test(trimmed)) {
      return false;
    }

    // Record every incoming message into chat context first
    recordChatContext(chatId, message, trimmed);

    const data = read();
    const triggeredByWord = hasSasukeTrigger(trimmed);
    const autoReplyOn = Boolean(data.autoreply);

    if (!triggeredByWord && !autoReplyOn) {
      return false;
    }

    const msgId = message.key.id;
    if (msgId && repliedMsgIds.has(msgId)) return false;
    if (inFlightReplyChats.has(chatId)) return false;

    if (msgId) {
      repliedMsgIds.set(msgId, Date.now());
      if (repliedMsgIds.size > 500) {
        const firstKey = repliedMsgIds.keys().next().value;
        repliedMsgIds.delete(firstKey);
      }
    }

    const { apiKey } = getAiEndpointConfig();
    if (!apiKey) {
      const sender = message.key.participant || message.key.remoteJid;
      const senderIsOwner = await isOwnerOrSudo(sender, sock, chatId);
      if (senderIsOwner) {
        const now = Date.now();
        const lastSent = missingKeyNotifiedAt.get(chatId) || 0;
        if (now - lastSent >= MISSING_KEY_COOLDOWN_MS) {
          missingKeyNotifiedAt.set(chatId, now);
          if (missingKeyNotifiedAt.size > 200) {
            const firstChat = missingKeyNotifiedAt.keys().next().value;
            missingKeyNotifiedAt.delete(firstChat);
          }
          await sock.sendMessage(chatId, { text: getMissingAiEnvNotice() }, { quoted: message });
        }
      }
      return false;
    }

    inFlightReplyChats.add(chatId);
    try {
      try {
        await sock.sendPresenceUpdate('composing', chatId);
      } catch (_) {}

      const answer = await requestAiReply(chatId, message, trimmed);
      if (!answer) return false;

      pushChatHistory(chatId, 'assistant', answer);
      await sock.sendMessage(chatId, { text: answer }, { quoted: message, skipFooter: true });
      return true;
    } finally {
      inFlightReplyChats.delete(chatId);
    }
  } catch (error) {
    console.error('[autoreply]', error.message);
    return false;
  }
}

async function handlePresence(sock, message) {
  try {
    if (!sock || !message?.key?.id) return;
    const data = read();

    // Handle autoseen (mark message as read)
    if (data.autoseen && !message.key.fromMe) {
      try {
        const key = {
          remoteJid: message.key.remoteJid,
          id: message.key.id,
          fromMe: false
        };
        if (message.key.remoteJid?.endsWith('@g.us') && message.key.participant) {
          key.participant = message.key.participant;
        }
        await sock.readMessages([key]);
      } catch (_) {}
    }

    // Handle autoonline (send presence)
    if (data.autoonline && message.key.remoteJid) {
      try {
        await sock.sendPresenceUpdate('available', message.key.remoteJid);
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = {
  read,
  toggle,
  handleAutoReply,
  handlePresence,
  syncAutoseen,
  recordChatContext,
  hasSasukeTrigger,
  formatOneLineReply,
  chatHistoryMap
};
