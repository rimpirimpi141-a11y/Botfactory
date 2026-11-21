/**
 * BOT FACTORY — Centralized Multi-Tenant Force Join Parser, Resolver & Verifier.
 *
 * Fixes the critical private invite URL bug (never prepends "@" to URLs!) and supports:
 * - Public channels & groups: @username, https://t.me/username, https://t.me/username/123
 * - Private channels & groups: https://t.me/+INVITECODE, https://t.me/joinchat/INVITECODE
 * - Numeric chat IDs (-100...) and explicit pair (-100... | https://t.me/+INVITE)
 * - Honest Telegram Bot API private-chat linking via real `my_chat_member` / `chat_member` updates
 * - Real Telegram `getChat` + `getChatMember` administrator verification before saving
 * - Accurate membership checking for creator, administrator, member, restricted (is_member), left, kicked
 * - Backward compatibility with legacy string entries (e.g. "@MyChannel") stored in D1 JSON
 */

import { buildInlineKeyboard, BUTTON_STYLES, inlineButton } from '../utils/keyboards.js';
import { escapeHtml } from '../utils/validation.js';

const RESERVED_TG_PATHS = new Set([
  'addstickers',
  'addemoji',
  'addtheme',
  'addlist',
  'bg',
  'boost',
  'c',
  'contact',
  'confirmphone',
  'iv',
  'login',
  'nft',
  'proxy',
  's',
  'setlanguage',
  'share',
  'socks',
  'stars',
]);

const VALID_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
const VALID_INVITE_CODE_RE = /^[a-zA-Z0-9_-]{6,64}$/;
const NUMERIC_CHAT_ID_RE = /^-100\d{5,20}$|^-\d{5,20}$/;
const TELEGRAM_HOST_RE = /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)$/i;

/**
 * Safely parses any Force Join input into a structured descriptor.
 * NEVER prepends "@" to a URL. Rejects malformed or non-Telegram URLs clearly.
 */
export function parseForceJoinInput(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Please enter a Telegram @username, public link (https://t.me/channel), or private invite link (https://t.me/+CODE).',
    };
  }

  // Support explicit manual pairing: "-1001234567890 | https://t.me/+INVITECODE"
  if (trimmed.includes('|')) {
    const [leftRaw, rightRaw] = trimmed.split('|').map((s) => s.trim());
    const leftParsed = parseForceJoinInput(leftRaw);
    const rightParsed = parseForceJoinInput(rightRaw);

    if (leftParsed.ok && leftParsed.kind === 'chat_id' && rightParsed.ok && rightParsed.kind === 'private_invite') {
      return {
        ok: true,
        kind: 'chat_id_with_invite',
        chatId: leftParsed.chatId,
        inviteUrl: rightParsed.inviteUrl,
        inviteCode: rightParsed.inviteCode,
      };
    }
    if (rightParsed.ok && rightParsed.kind === 'chat_id' && leftParsed.ok && leftParsed.kind === 'private_invite') {
      return {
        ok: true,
        kind: 'chat_id_with_invite',
        chatId: rightParsed.chatId,
        inviteUrl: leftParsed.inviteUrl,
        inviteCode: leftParsed.inviteCode,
      };
    }
    return {
      ok: false,
      error: 'Invalid pairing format. Use: -1001234567890 | https://t.me/+INVITECODE',
    };
  }

  // Catch accidental "@https://..." or "@t.me/..." pasted by users
  if (/^@(?:https?:\/\/|t\.me\/|telegram\.me\/|telegram\.dog\/)/i.test(trimmed)) {
    return {
      ok: false,
      error: 'Do not put "@" in front of a Telegram URL. Send the URL directly (e.g. https://t.me/+INVITECODE or https://t.me/channel).',
    };
  }

  // Numeric Telegram chat ID (channels/supergroups start with -100, legacy groups start with -)
  if (NUMERIC_CHAT_ID_RE.test(trimmed)) {
    return {
      ok: true,
      kind: 'chat_id',
      chatId: trimmed,
      inviteUrl: null,
    };
  }

  // Detect any URL or t.me / telegram.me / telegram.dog reference
  const looksLikeUrl =
    /^https?:\/\//i.test(trimmed) ||
    /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\b/i.test(trimmed) ||
    trimmed.includes('://') ||
    trimmed.includes('/');

  if (looksLikeUrl) {
    const candidateUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let parsedUrl;
    try {
      parsedUrl = new URL(candidateUrl);
    } catch {
      return {
        ok: false,
        error: 'Malformed link. Send a valid Telegram link such as https://t.me/username or https://t.me/+INVITECODE.',
      };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        ok: false,
        error: 'Only https:// Telegram links are supported.',
      };
    }

    if (!TELEGRAM_HOST_RE.test(parsedUrl.hostname)) {
      return {
        ok: false,
        error: `Unsupported domain "${parsedUrl.hostname}". Only official Telegram links (t.me / telegram.me) are allowed.`,
      };
    }

    const segments = parsedUrl.pathname
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);

    if (segments.length === 0) {
      return {
        ok: false,
        error: 'Incomplete Telegram link. Provide a channel/group username or private invite code after t.me/.',
      };
    }

    const first = segments[0];

    // Private invite link: https://t.me/+INVITECODE
    if (first.startsWith('+')) {
      const inviteCode = first.slice(1);
      if (!VALID_INVITE_CODE_RE.test(inviteCode)) {
        return {
          ok: false,
          error: 'Malformed private invite link. Expected format: https://t.me/+INVITECODE',
        };
      }
      return {
        ok: true,
        kind: 'private_invite',
        inviteUrl: `https://t.me/+${inviteCode}`,
        inviteCode,
      };
    }

    // Legacy private invite link: https://t.me/joinchat/INVITECODE
    if (first.toLowerCase() === 'joinchat') {
      const inviteCode = segments[1] || '';
      if (!VALID_INVITE_CODE_RE.test(inviteCode)) {
        return {
          ok: false,
          error: 'Malformed joinchat invite link. Expected format: https://t.me/joinchat/INVITECODE',
        };
      }
      return {
        ok: true,
        kind: 'private_invite',
        inviteUrl: `https://t.me/joinchat/${inviteCode}`,
        inviteCode,
      };
    }

    // Private message link: https://t.me/c/1234567890/12 — cannot be used as invite URL alone
    if (first.toLowerCase() === 'c') {
      return {
        ok: false,
        error: 't.me/c/... is an internal private message link, not a joinable invite link. Copy the channel/group Invite Link (https://t.me/+CODE) instead.',
      };
    }

    if (RESERVED_TG_PATHS.has(first.toLowerCase())) {
      return {
        ok: false,
        error: `This Telegram link (/${first}) is not a channel or group link.`,
      };
    }

    // Public channel/group link (optionally with post ID: https://t.me/channelusername/123)
    const username = first.replace(/^@/, '');
    if (!VALID_USERNAME_RE.test(username) || username.endsWith('_')) {
      return {
        ok: false,
        error: 'Invalid Telegram username in link. Usernames must be 4–32 letters, numbers, or underscores.',
      };
    }

    // If a second segment exists, it must be a numeric message ID (e.g. /123)
    if (segments.length > 1 && !/^\d+$/.test(segments[1])) {
      return {
        ok: false,
        error: 'Malformed Telegram URL path. Send https://t.me/username or @username.',
      };
    }

    return {
      ok: true,
      kind: 'public',
      username,
      handle: `@${username}`,
      joinUrl: `https://t.me/${username}`,
    };
  }

  // Public @username or plain username
  const cleanedUsername = trimmed.replace(/^@/, '');
  if (!VALID_USERNAME_RE.test(cleanedUsername) || cleanedUsername.endsWith('_')) {
    return {
      ok: false,
      error:
        'Invalid channel/group format. Enter @username, https://t.me/username, https://t.me/+INVITECODE, or a numeric chat ID (-100...).',
    };
  }

  return {
    ok: true,
    kind: 'public',
    username: cleanedUsername,
    handle: `@${cleanedUsername}`,
    joinUrl: `https://t.me/${cleanedUsername}`,
  };
}

/**
 * Normalizes either a legacy string ("@channel" / "-1001234") or structured object
 * into a unified Force Join destination object.
 */
export function normalizeForceJoinDestination(entry) {
  if (!entry) return null;

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    if (NUMERIC_CHAT_ID_RE.test(trimmed)) {
      return {
        id: trimmed,
        chatId: trimmed,
        title: trimmed,
        username: null,
        inviteUrl: null,
        chatType: 'channel',
        isPrivate: true,
        verified: false,
        verifiedAt: null,
        botStatus: 'unknown',
        canCheckMembers: false,
      };
    }
    const parsed = parseForceJoinInput(trimmed);
    if (parsed.ok && parsed.kind === 'public') {
      return {
        id: parsed.handle,
        chatId: parsed.handle,
        title: parsed.handle,
        username: parsed.username,
        inviteUrl: parsed.joinUrl,
        chatType: 'channel',
        isPrivate: false,
        verified: false,
        verifiedAt: null,
        botStatus: 'unknown',
        canCheckMembers: false,
      };
    }
    return null;
  }

  if (typeof entry === 'object') {
    const chatId = String(entry.chatId || entry.chat_id || entry.id || '').trim();
    const username = entry.username ? String(entry.username).replace(/^@/, '').trim() : null;
    const isPrivate =
      typeof entry.isPrivate === 'boolean' ? entry.isPrivate : !username;
    const inviteUrl =
      entry.inviteUrl || entry.invite_url || (username ? `https://t.me/${username}` : null);

    if (!chatId && !username) return null;

    const effectiveChatId = chatId || `@${username}`;
    return {
      id: String(entry.id || effectiveChatId),
      chatId: effectiveChatId,
      title: String(entry.title || (username ? `@${username}` : effectiveChatId)),
      username,
      inviteUrl,
      chatType: String(entry.chatType || entry.chat_type || 'channel'),
      isPrivate,
      verified: Boolean(entry.verified),
      verifiedAt: entry.verifiedAt || entry.verified_at || null,
      botStatus: String(entry.botStatus || entry.bot_status || (entry.verified ? 'administrator' : 'unknown')),
      canCheckMembers: Boolean(entry.canCheckMembers ?? entry.verified),
    };
  }

  return null;
}

export function normalizeForceJoinList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const norm = normalizeForceJoinDestination(item);
    if (!norm) continue;
    const key = String(norm.chatId).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

export function getDestinationJoinUrl(dest) {
  const norm = normalizeForceJoinDestination(dest);
  if (!norm) return null;
  if (!norm.isPrivate && norm.username) {
    return `https://t.me/${norm.username}`;
  }
  if (norm.inviteUrl && /^https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\//i.test(norm.inviteUrl)) {
    return norm.inviteUrl;
  }
  if (norm.username) {
    return `https://t.me/${norm.username}`;
  }
  return null;
}

export function formatDestinationLabel(dest) {
  const norm = normalizeForceJoinDestination(dest);
  if (!norm) return 'Unknown Chat';
  if (norm.title && norm.username && norm.title !== `@${norm.username}`) {
    return `${norm.title} (@${norm.username})`;
  }
  if (norm.username) return `@${norm.username}`;
  return norm.title || norm.chatId;
}

/**
 * Checks whether a Telegram getChatMember response represents an active member.
 * Handles all 6 Telegram member statuses:
 * - creator, administrator, member -> true
 * - restricted -> true ONLY when is_member === true
 * - left, kicked -> false
 */
export function isMemberStatusActive(memberResponse) {
  const member = memberResponse?.result ?? memberResponse;
  const status = String(member?.status || '').toLowerCase();
  if (status === 'creator' || status === 'administrator' || status === 'member') {
    return { joined: true, status };
  }
  if (status === 'restricted') {
    return { joined: member?.is_member === true, status, isMember: member?.is_member === true };
  }
  return { joined: false, status: status || 'unknown' };
}

/**
 * Checks whether a bot's getChatMember result proves administrator status
 * sufficient to inspect chat membership.
 */
export function evaluateBotAdminStatus(memberResponse) {
  const member = memberResponse?.result ?? memberResponse;
  const status = String(member?.status || '').toLowerCase();
  const isAdmin = status === 'administrator' || status === 'creator';
  return {
    isAdmin,
    status: status || 'unknown',
    canCheckMembers: isAdmin,
  };
}

/**
 * Resolves and verifies a public chat or numeric chat_id via real Telegram `getChat` + `getChatMember`.
 * For private invite links (`t.me/+...` or `t.me/joinchat/...`), honestly returns `pendingPrivateLink: true`
 * with step-by-step instructions to add the bot as Administrator so `my_chat_member` captures the real chat_id.
 */
export async function resolveAndVerifyForceJoinDestination({
  telegram,
  token,
  rawInput,
  botUsername = '',
}) {
  const parsed = parseForceJoinInput(rawInput);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  let resolvedBotUsername = botUsername ? String(botUsername).replace(/^@/, '') : '';
  let botId = null;

  try {
    const me = await telegram.getMe(token);
    botId = me?.result?.id || null;
    if (!resolvedBotUsername && me?.result?.username) {
      resolvedBotUsername = me.result.username;
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to query bot identity via Telegram getMe: ${err?.message || 'Telegram API error'}`,
    };
  }

  const botMention = resolvedBotUsername ? `@${resolvedBotUsername}` : 'this bot';

  // Private invite link: Telegram Bot API does NOT resolve invite links via getChat!
  if (parsed.kind === 'private_invite') {
    return {
      ok: false,
      pendingPrivateLink: true,
      inviteUrl: parsed.inviteUrl,
      inviteCode: parsed.inviteCode,
      botUsername: resolvedBotUsername,
      instructions: [
        `🔐 <b>Private Invite Link Detected — Action Required</b>`,
        `Invite Link: <code>${escapeHtml(parsed.inviteUrl)}</code>`,
        '',
        'Telegram does not allow bots to look up a private channel/group ID from an invite link alone. Complete linking in 2 steps:',
        `1. Open your private channel or group and add <b>${escapeHtml(botMention)}</b> as an <b>Administrator</b>.`,
        '2. As soon as you promote the bot, BOT FACTORY automatically receives Telegram\'s <code>my_chat_member</code> update, verifies admin permissions, links the numeric Chat ID to this invite link, and confirms here!',
        '',
        `<i>Already an admin in that private chat? Send:</i>\n<code>-100YOUR_CHAT_ID | ${escapeHtml(parsed.inviteUrl)}</code>`,
      ].join('\n'),
    };
  }

  const lookupTarget = parsed.kind === 'public' ? parsed.handle : parsed.chatId;

  let chat;
  try {
    const chatRes = await telegram.getChat(token, lookupTarget);
    chat = chatRes?.result;
  } catch (err) {
    const reason = err?.message || 'Chat not accessible';
    return {
      ok: false,
      error: `Telegram could not access "${lookupTarget}" (${reason}). Verify the username/ID is correct and add ${botMention} as an Administrator first.`,
    };
  }

  if (!chat || !chat.id) {
    return {
      ok: false,
      error: `Telegram returned empty chat metadata for "${lookupTarget}".`,
    };
  }

  const chatType = String(chat.type || '').toLowerCase();
  if (!['channel', 'group', 'supergroup'].includes(chatType)) {
    return {
      ok: false,
      error: `Force Join only supports channels, groups, and supergroups (received "${chatType || 'unknown'}").`,
    };
  }

  // Verify bot administrator status using the REAL numeric chat.id!
  let botMember;
  try {
    botMember = await telegram.getChatMember(token, chat.id, botId);
  } catch (err) {
    return {
      ok: false,
      needsAdmin: true,
      chatId: String(chat.id),
      title: chat.title || lookupTarget,
      error: [
        `Could not verify ${botMention}'s administrator permissions in "${chat.title || lookupTarget}" (${err?.message || 'access denied'}).`,
        `Add ${botMention} to the ${chatType} and promote it to Administrator, then retry.`,
      ].join(' '),
    };
  }

  const adminCheck = evaluateBotAdminStatus(botMember);
  if (!adminCheck.isAdmin) {
    return {
      ok: false,
      needsAdmin: true,
      chatId: String(chat.id),
      title: chat.title || lookupTarget,
      botStatus: adminCheck.status,
      error: [
        `${botMention} is currently "${adminCheck.status}" in "${chat.title || lookupTarget}", not an Administrator.`,
        `Open ${chatType} Settings -> Administrators -> Add ${botMention} as Administrator, then try again. Destination was NOT saved.`,
      ].join(' '),
    };
  }

  const publicUsername = chat.username ? String(chat.username).replace(/^@/, '') : null;
  const isPrivate = !publicUsername;
  const inviteUrl = isPrivate
    ? parsed.inviteUrl || chat.invite_link || null
    : `https://t.me/${publicUsername}`;

  if (isPrivate && !inviteUrl) {
    return {
      ok: false,
      needsInviteUrl: true,
      chatId: String(chat.id),
      title: chat.title || String(chat.id),
      error: `Verified admin access in private ${chatType} "${chat.title || chat.id}", but no invite link was provided. Send both together so users get a Join button:\n${chat.id} | https://t.me/+YOUR_INVITE_CODE`,
    };
  }

  const destination = {
    id: String(chat.id),
    chatId: String(chat.id),
    title: String(chat.title || (publicUsername ? `@${publicUsername}` : chat.id)),
    username: publicUsername,
    inviteUrl,
    chatType,
    isPrivate,
    verified: true,
    verifiedAt: new Date().toISOString(),
    botStatus: adminCheck.status,
    canCheckMembers: true,
  };

  return { ok: true, destination };
}

/**
 * Processes Telegram `my_chat_member` (and bot-targeted `chat_member`) updates
 * to automatically link a pending private invite link to the real numeric `chat.id`.
 */
export async function handleForceJoinChatMemberUpdate({
  telegram,
  token,
  update,
  pendingLink = null,
  existingDestinations = [],
  botUsername = '',
}) {
  const event = update?.my_chat_member || update?.chat_member || null;
  if (!event || !event.chat || !event.new_chat_member) {
    return { handled: false };
  }

  const chat = event.chat;
  const chatType = String(chat.type || '').toLowerCase();
  if (!['channel', 'group', 'supergroup'].includes(chatType)) {
    return { handled: false };
  }

  // For chat_member (not my_chat_member), only process if the subject is the bot itself
  let me;
  try {
    me = await telegram.getMe(token);
  } catch {
    return { handled: false };
  }
  const botId = me?.result?.id;
  const resolvedBotUsername = botUsername || me?.result?.username || '';
  const targetUserId = event.new_chat_member?.user?.id;

  if (!update.my_chat_member && botId && String(targetUserId) !== String(botId)) {
    return { handled: false };
  }

  const newStatus = String(event.new_chat_member?.status || '').toLowerCase();
  const normalizedList = normalizeForceJoinList(existingDestinations);
  const numericChatId = String(chat.id);
  const existingMatch = normalizedList.find((d) => String(d.chatId) === numericChatId);

  // If bot was demoted/removed from an already-configured Force Join chat, notify!
  if (existingMatch && !['administrator', 'creator'].includes(newStatus)) {
    const updatedList = normalizedList.map((d) =>
      String(d.chatId) === numericChatId
        ? { ...d, verified: false, botStatus: newStatus, canCheckMembers: false }
        : d
    );
    return {
      handled: true,
      action: 'demoted',
      chatId: numericChatId,
      title: chat.title || existingMatch.title,
      botStatus: newStatus,
      destinations: updatedList,
      notifyChatId: pendingLink?.chatId || pendingLink?.requestedBy || null,
      message: `⚠️ <b>Force Join Alert</b>\n@${escapeHtml(resolvedBotUsername || 'bot')} status changed to <b>${escapeHtml(newStatus)}</b> in <b>${escapeHtml(chat.title || existingMatch.title)}</b> (<code>${escapeHtml(numericChatId)}</code>). Re-promote the bot to Administrator so Force Join checks keep working.`,
    };
  }

  // Only auto-link a new chat if there is an active pending private link!
  if (!pendingLink || !pendingLink.inviteUrl) {
    return { handled: false };
  }

  // Expire stale pending links older than 30 minutes
  if (pendingLink.requestedAt) {
    const ageMs = Date.now() - new Date(pendingLink.requestedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000) {
      return { handled: false, expired: true };
    }
  }

  const notifyChatId = pendingLink.chatId || pendingLink.requestedBy || event.from?.id || null;

  // Bot was added as regular member (common in private groups before promotion)
  if (!['administrator', 'creator'].includes(newStatus)) {
    if (newStatus === 'member') {
      return {
        handled: true,
        action: 'needs_promotion',
        chatId: numericChatId,
        title: chat.title || numericChatId,
        notifyChatId,
        message: [
          `⏳ <b>Almost Done — Promote Bot to Administrator</b>`,
          `Detected <b>${escapeHtml(chat.title || numericChatId)}</b> (<code>${escapeHtml(numericChatId)}</code>), but @${escapeHtml(resolvedBotUsername || 'bot')} was added as a regular member.`,
          '',
          `Promote @${escapeHtml(resolvedBotUsername || 'bot')} to <b>Administrator</b> in this ${escapeHtml(chatType)} to automatically finish linking <code>${escapeHtml(pendingLink.inviteUrl)}</code>.`,
        ].join('\n'),
      };
    }
    return { handled: false };
  }

  // Verify admin status explicitly via Telegram getChatMember before saving!
  let verifiedCheck = { isAdmin: false, status: newStatus };
  try {
    const memberRes = await telegram.getChatMember(token, chat.id, botId);
    verifiedCheck = evaluateBotAdminStatus(memberRes);
  } catch (err) {
    return {
      handled: true,
      action: 'verification_failed',
      chatId: numericChatId,
      notifyChatId,
      message: `❌ Detected promotion in <b>${escapeHtml(chat.title || numericChatId)}</b>, but Telegram <code>getChatMember</code> verification failed: ${escapeHtml(err?.message || 'API error')}. Please retry.`,
    };
  }

  if (!verifiedCheck.isAdmin) {
    return {
      handled: true,
      action: 'needs_promotion',
      chatId: numericChatId,
      title: chat.title || numericChatId,
      notifyChatId,
      message: `⚠️ Telegram still reports bot status as <b>${escapeHtml(verifiedCheck.status)}</b> in <b>${escapeHtml(chat.title || numericChatId)}</b>. Ensure administrator rights are granted.`,
    };
  }

  const publicUsername = chat.username ? String(chat.username).replace(/^@/, '') : null;
  const isPrivate = !publicUsername;
  const destination = {
    id: numericChatId,
    chatId: numericChatId,
    title: String(chat.title || (publicUsername ? `@${publicUsername}` : numericChatId)),
    username: publicUsername,
    inviteUrl: isPrivate ? pendingLink.inviteUrl : `https://t.me/${publicUsername}`,
    chatType,
    isPrivate,
    verified: true,
    verifiedAt: new Date().toISOString(),
    botStatus: verifiedCheck.status,
    canCheckMembers: true,
  };

  const updatedDestinations = upsertForceJoinDestination(normalizedList, destination);

  return {
    handled: true,
    action: 'linked',
    destination,
    destinations: updatedDestinations,
    notifyChatId,
    message: [
      `✅ <b>Private ${escapeHtml(chatType.charAt(0).toUpperCase() + chatType.slice(1))} Linked & Verified!</b>`,
      `• <b>Name:</b> ${escapeHtml(destination.title)}`,
      `• <b>Chat ID:</b> <code>${escapeHtml(destination.chatId)}</code>`,
      `• <b>Invite Link:</b> <code>${escapeHtml(destination.inviteUrl)}</code>`,
      `• <b>Bot Status:</b> ${escapeHtml(destination.botStatus.toUpperCase())} (Verified via <code>getChatMember</code>)`,
      '',
      'Force Join enforcement is now active for this destination.',
    ].join('\n'),
  };
}

export function upsertForceJoinDestination(existingList, destination) {
  const list = normalizeForceJoinList(existingList);
  const norm = normalizeForceJoinDestination(destination);
  if (!norm) return list;

  const idx = list.findIndex(
    (d) =>
      String(d.chatId).toLowerCase() === String(norm.chatId).toLowerCase() ||
      (norm.username && d.username && d.username.toLowerCase() === norm.username.toLowerCase()) ||
      (norm.inviteUrl && d.inviteUrl && d.inviteUrl.toLowerCase() === norm.inviteUrl.toLowerCase())
  );

  if (idx >= 0) {
    const next = [...list];
    next[idx] = norm;
    return next;
  }
  return [...list, norm];
}

export function removeForceJoinDestination(existingList, query) {
  const list = normalizeForceJoinList(existingList);
  const raw = String(query || '').trim();
  if (!raw) return { removed: null, destinations: list };

  const parsed = parseForceJoinInput(raw);
  const lower = raw.toLowerCase();
  const numericIdx = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;

  let removed = null;
  const remaining = list.filter((d, idx) => {
    const matchesIndex = numericIdx >= 0 && idx === numericIdx;
    const matchesChatId = String(d.chatId).toLowerCase() === lower;
    const matchesUsername =
      d.username &&
      (`@${d.username.toLowerCase()}` === lower ||
        d.username.toLowerCase() === lower ||
        (parsed.ok && parsed.kind === 'public' && d.username.toLowerCase() === parsed.username.toLowerCase()));
    const matchesInvite =
      d.inviteUrl &&
      (d.inviteUrl.toLowerCase() === lower ||
        (parsed.ok && parsed.inviteUrl && d.inviteUrl.toLowerCase() === parsed.inviteUrl.toLowerCase()));
    const matchesTitle = d.title && d.title.toLowerCase() === lower;

    if (!removed && (matchesIndex || matchesChatId || matchesUsername || matchesInvite || matchesTitle)) {
      removed = d;
      return false;
    }
    return true;
  });

  return { removed, destinations: remaining };
}

/**
 * Checks whether a Telegram user is a member of all configured Force Join destinations.
 * ALWAYS calls `getChatMember` with the resolved numeric `chatId` (or public `@username` for legacy entries).
 * NEVER calls `getChatMember` with a private invite URL.
 */
export async function checkUserForceJoin({ telegram, token, destinations = [], userId }) {
  const list = normalizeForceJoinList(destinations);
  if (list.length === 0) {
    return { passed: true, missing: [], checkedCount: 0, results: [] };
  }

  const missing = [];
  const results = [];

  for (const dest of list) {
    // Guard against ever sending a URL to Telegram getChatMember
    if (/^https?:\/\//i.test(String(dest.chatId)) || String(dest.chatId).includes('t.me/')) {
      results.push({ destination: dest, joined: false, status: 'invalid_destination', error: 'Unresolved invite link' });
      missing.push(dest);
      continue;
    }

    try {
      const res = await telegram.getChatMember(token, dest.chatId, userId);
      const check = isMemberStatusActive(res);
      results.push({ destination: dest, joined: check.joined, status: check.status, isMember: check.isMember });
      if (!check.joined) {
        missing.push(dest);
      }
    } catch (err) {
      results.push({
        destination: dest,
        joined: false,
        status: 'error',
        error: err?.message || 'Telegram check failed',
      });
      missing.push(dest);
    }
  }

  return {
    passed: missing.length === 0,
    missing,
    checkedCount: list.length,
    results,
  };
}

/**
 * Re-verifies administrator status & chat metadata for all saved destinations.
 */
export async function reverifyForceJoinDestinations({ telegram, token, destinations = [] }) {
  const list = normalizeForceJoinList(destinations);
  if (list.length === 0) {
    return { destinations: [], summary: [] };
  }

  const me = await telegram.getMe(token);
  const botId = me?.result?.id;

  const updated = [];
  const summary = [];

  for (const dest of list) {
    try {
      const chatRes = await telegram.getChat(token, dest.chatId);
      const chat = chatRes?.result || {};
      const memberRes = await telegram.getChatMember(token, chat.id || dest.chatId, botId);
      const adminCheck = evaluateBotAdminStatus(memberRes);
      const publicUsername = chat.username ? String(chat.username).replace(/^@/, '') : dest.username;
      const isPrivate = !publicUsername;

      const refreshed = {
        ...dest,
        id: String(chat.id || dest.chatId),
        chatId: String(chat.id || dest.chatId),
        title: String(chat.title || dest.title),
        username: publicUsername || null,
        inviteUrl: isPrivate ? dest.inviteUrl || chat.invite_link || null : `https://t.me/${publicUsername}`,
        chatType: String(chat.type || dest.chatType),
        isPrivate,
        verified: adminCheck.isAdmin,
        verifiedAt: adminCheck.isAdmin ? new Date().toISOString() : dest.verifiedAt,
        botStatus: adminCheck.status,
        canCheckMembers: adminCheck.canCheckMembers,
      };
      updated.push(refreshed);
      summary.push({
        destination: refreshed,
        ok: adminCheck.isAdmin,
        status: adminCheck.status,
        error: adminCheck.isAdmin ? null : `Bot status is "${adminCheck.status}" (promote to Administrator)`,
      });
    } catch (err) {
      const degraded = {
        ...dest,
        verified: false,
        botStatus: 'unreachable',
        canCheckMembers: false,
      };
      updated.push(degraded);
      summary.push({
        destination: degraded,
        ok: false,
        status: 'unreachable',
        error: err?.message || 'Chat unreachable',
      });
    }
  }

  return { destinations: updated, summary };
}

/**
 * Builds colourful inline Join buttons + Verify button for missing Force Join destinations.
 */
export function buildForceJoinGateKeyboard(missingDestinations = [], verifyCallbackData = 'fj:verify') {
  const rows = [];
  for (const rawDest of missingDestinations) {
    const dest = normalizeForceJoinDestination(rawDest);
    if (!dest) continue;
    const url = getDestinationJoinUrl(dest);
    const label = dest.isPrivate
      ? `🔐 Join ${dest.title}`
      : `📢 Join ${dest.username ? `@${dest.username}` : dest.title}`;
    if (url) {
      rows.push([
        inlineButton({
          text: label.slice(0, 60),
          url,
          style: BUTTON_STYLES.PRIMARY,
        }),
      ]);
    }
  }
  rows.push([
    inlineButton({
      text: '✅ I Joined — Verify Membership',
      callbackData: verifyCallbackData,
      style: BUTTON_STYLES.SUCCESS,
    }),
  ]);
  return buildInlineKeyboard(rows);
}

/**
 * Renders a readable HTML summary of all configured Force Join destinations + pending private link.
 */
export function formatForceJoinSummaryHtml(destinations = [], pendingLink = null) {
  const list = normalizeForceJoinList(destinations);
  const lines = [];

  if (list.length === 0) {
    lines.push('<i>No Force Join channels or groups configured.</i>');
  } else {
    list.forEach((d, idx) => {
      const statusIcon = d.verified ? '✅' : '⚠️';
      const privacyBadge = d.isPrivate ? '🔐 Private' : '🌐 Public';
      const typeLabel = d.chatType || 'channel';
      const linkInfo = d.isPrivate
        ? d.inviteUrl || 'No invite link'
        : d.username
          ? `@${d.username}`
          : d.chatId;
      lines.push(
        `${idx + 1}. ${statusIcon} <b>${escapeHtml(d.title)}</b> (${privacyBadge} ${escapeHtml(typeLabel)})\n` +
          `   • ID: <code>${escapeHtml(d.chatId)}</code> · Link: <code>${escapeHtml(linkInfo)}</code> · Bot: <b>${escapeHtml(d.botStatus)}</b>`
      );
    });
  }

  if (pendingLink?.inviteUrl) {
    lines.push(
      '',
      `⏳ <b>Pending Private Link (Awaiting Bot Admin Promotion):</b>`,
      `• <code>${escapeHtml(pendingLink.inviteUrl)}</code>`,
      '<i>Add the bot to your private channel/group and promote it to Administrator to complete linking.</i>'
    );
  }

  return lines.join('\n');
}
