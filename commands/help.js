const fs = require('fs');
const path = require('path');
const { render, renderAdminSecretMenu } = require('./registry');
const isOwnerOrSudo = require('../lib/isOwner');
const isAdmin = require('../lib/isAdmin');
const { isAutoViewOnceEnabled } = require('./viewonce');

async function sendMenu(sock, chatId, message, categoryFilter = null) {
  const userName = message?.pushName || 'ꜱᴀꜱᴜᴋᴇX';
  const normFilter = categoryFilter ? String(categoryFilter).trim().toLowerCase() : null;

  let text;
  if (normFilter === 'admin') {
    const senderId = message?.key?.participant || message?.key?.remoteJid || '';
    const isOwner = Boolean(message?.key?.fromMe) || await isOwnerOrSudo(senderId, sock, chatId);
    let isGroupAdmin = false;
    if (!isOwner && chatId.endsWith('@g.us')) {
      try {
        const status = await isAdmin(sock, chatId, senderId);
        isGroupAdmin = Boolean(status?.isSenderAdmin);
      } catch (_) {}
    }

    if (!isOwner && !isGroupAdmin) {
      return sock.sendMessage(chatId, {
        text: '❌ *Access Denied:* `.menu admin` is a secret menu restricted to *Group Admins & Bot Owners* only.'
      }, { quoted: message });
    }

    text = renderAdminSecretMenu(userName, isAutoViewOnceEnabled());
  } else {
    text = render(userName, categoryFilter);
  }

  const imagePath = path.join(__dirname, '../assets/bot_image.jpg');
  const payload = fs.existsSync(imagePath)
    ? { image: fs.readFileSync(imagePath), caption: text }
    : { text };

  return sock.sendMessage(chatId, payload, { quoted: message });
}

async function helpCommand(sock, chatId, message, categoryFilter = null) {
  return sendMenu(sock, chatId, message, categoryFilter);
}

async function showAllCommand(sock, chatId, message) {
  return sendMenu(sock, chatId, message, null);
}

module.exports = helpCommand;
module.exports.helpCommand = helpCommand;
module.exports.showAllCommand = showAllCommand;
