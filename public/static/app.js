const roomSelect = document.querySelector('#room');
const joinForm = document.querySelector('#join-form');
const welcome = document.querySelector('#welcome');
const messages = document.querySelector('#messages');
const composer = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const notice = document.querySelector('#notice');
const typingLine = document.querySelector('#typing-line');
const usersList = document.querySelector('#users');
const connection = document.querySelector('.connection');
const replyPreview = document.querySelector('#reply-preview');
const replyAuthor = document.querySelector('#reply-author');
const replyText = document.querySelector('#reply-text');

let socket = null;
let username = '';
let currentRoom = '';
let typingTimer = null;
let reconnectTimer = null;
let replyTarget = null;
let joined = false;
let shouldReconnect = false;
let reconnectDelay = 1000;
let typingUsers = new Set();
let lastTypingSent = 0;
const messageById = new Map();
const pendingMessages = new Map();

function showNotice(text) {
  notice.textContent = text;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { notice.textContent = ''; }, 5000);
}

function setConnected(connected) {
  connection.classList.toggle('online', connected);
  document.querySelector('#connection-label').textContent = connected ? 'Connected' : 'Disconnected';
}

function renderUsers(names) {
  document.querySelector('#user-count').textContent = names.length;
  usersList.replaceChildren();
  if (!names.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-users';
    empty.textContent = 'No one is here yet';
    usersList.append(empty);
    return;
  }

  names.forEach(name => {
    const item = document.createElement('li');
    const avatar = document.createElement('span');
    const tagButton = document.createElement('button');
    avatar.className = 'avatar';
    avatar.textContent = name.slice(0, 1).toUpperCase();
    tagButton.className = 'user-tag-button';
    tagButton.type = 'button';
    tagButton.textContent = name + (name === username ? ' (you)' : '');
    tagButton.title = `Mention ${name}`;
    tagButton.addEventListener('click', () => insertMention(name));
    item.append(avatar, tagButton);
    usersList.append(item);
  });
}

function insertMention(name) {
  const token = /\s/.test(name) ? `@"${name}"` : `@${name}`;
  const prefix = messageInput.value && !messageInput.value.endsWith(' ') ? ' ' : '';
  messageInput.value += `${prefix}${token} `;
  messageInput.dispatchEvent(new Event('input', { bubbles: true }));
  messageInput.focus();
}

function renderMessageText(container, text) {
  const matcher = /(?<![\w@])@(?:"([^"\r\n]{1,20})"|([^\s@,.:;!?()]+))/g;
  let cursor = 0;
  let match;
  while ((match = matcher.exec(text)) !== null) {
    container.append(document.createTextNode(text.slice(cursor, match.index)));
    const tag = document.createElement('span');
    tag.className = 'mention-token';
    tag.textContent = match[0];
    container.append(tag);
    cursor = matcher.lastIndex;
  }
  container.append(document.createTextNode(text.slice(cursor)));
}

function setReplyTarget(message) {
  replyTarget = message;
  replyAuthor.textContent = `Replying to ${message.username}`;
  replyText.textContent = message.text;
  replyPreview.hidden = false;
  messageInput.focus();
}

function clearReplyTarget() {
  replyTarget = null;
  replyPreview.hidden = true;
  replyAuthor.textContent = '';
  replyText.textContent = '';
}

function scrollToMessage(id) {
  const target = messages.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('message-highlight');
    window.setTimeout(() => target.classList.remove('message-highlight'), 1300);
  }
}

function addMessage(message) {
  const messageId = String(message.id);
  if (messageById.has(messageId)) return;

  const item = document.createElement('li');
  item.className = 'message' + (message.username === username ? ' mine' : '');
  item.dataset.messageId = messageId;

  const meta = document.createElement('p');
  meta.className = 'message-meta';
  const date = new Date(message.created_at);
  meta.textContent = `${message.username} · ${Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const parent = message.reply_to || messageById.get(String(message.reply_to_id));
  if (message.reply_to_id) {
    const reference = document.createElement('button');
    reference.type = 'button';
    reference.className = 'reply-reference';
    reference.textContent = parent ? `↳ ${parent.username}: ${parent.text}` : `↳ Reply to message #${message.reply_to_id}`;
    reference.title = 'Jump to the original message';
    reference.addEventListener('click', () => scrollToMessage(message.reply_to_id));
    item.append(meta, reference);
  } else {
    item.append(meta);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  renderMessageText(bubble, message.text);
  item.append(bubble);

  const replyButton = document.createElement('button');
  replyButton.type = 'button';
  replyButton.className = 'reply-button';
  replyButton.textContent = 'Reply';
  replyButton.addEventListener('click', () => setReplyTarget(message));
  item.append(replyButton);

  messages.append(item);
  messageById.set(messageId, message);
  [...messages.children]
    .sort((first, second) => Number(first.dataset.messageId) - Number(second.dataset.messageId))
    .forEach(node => messages.append(node));
  messages.scrollTop = messages.scrollHeight;
}

function sendTyping(isTyping) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'typing', is_typing: isTyping }));
  }
}

function closeRoom() {
  shouldReconnect = false;
  joined = false;
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(typingTimer);
  const oldSocket = socket;
  socket = null;
  if (oldSocket) oldSocket.close();
  setConnected(false);
  renderUsers([]);
  typingUsers.clear();
  typingLine.textContent = '';
}

function connect() {
  if (!shouldReconnect) return;
  joined = false;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const nextSocket = new WebSocket(`${scheme}//${location.host}/ws`);
  socket = nextSocket;
  setConnected(false);

  nextSocket.addEventListener('open', () => {
    if (nextSocket !== socket) return;
    nextSocket.send(JSON.stringify({ type: 'join_room', username, room: currentRoom }));
  });

  nextSocket.addEventListener('message', event => {
    if (nextSocket !== socket) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'history') {
      messages.replaceChildren();
      messageById.clear();
      data.messages.forEach(addMessage);
      welcome.hidden = true;
      messages.style.display = 'flex';
      composer.hidden = false;
      document.querySelector('#leave-button').hidden = false;
      document.querySelector('#room-heading').textContent = currentRoom[0].toUpperCase() + currentRoom.slice(1);
      joined = true;
      setConnected(true);
      reconnectDelay = 1000;
    } else if (data.type === 'message') {
      if (data.client_message_id) pendingMessages.delete(data.client_message_id);
      addMessage(data);
      if ((data.mentions || []).some(name => name.toLocaleLowerCase() === username.toLocaleLowerCase())) {
        showNotice(`${data.username} mentioned you.`);
      }
    } else if (data.type === 'presence_update') {
      renderUsers(data.users);
    } else if (data.type === 'typing') {
      if (data.username === username) return;
      if (data.is_typing) typingUsers.add(data.username);
      else typingUsers.delete(data.username);
      typingLine.textContent = typingUsers.size
        ? `${[...typingUsers].join(', ')} ${typingUsers.size === 1 ? 'is' : 'are'} typing…`
        : '';
    } else if (data.type === 'ping') {
      nextSocket.send(JSON.stringify({ type: 'pong' }));
    } else if (data.type === 'error') {
      const pending = data.client_message_id ? pendingMessages.get(data.client_message_id) : null;
      if (data.client_message_id) pendingMessages.delete(data.client_message_id);
      showNotice(data.message);
      if (pending) {
        messageInput.value = messageInput.value
          ? `${pending.text}\n${messageInput.value}`.slice(0, 500)
          : pending.text;
        document.querySelector('#char-count').textContent = `${messageInput.value.length} / 500`;
        if (pending.replyTarget && !replyTarget) setReplyTarget(pending.replyTarget);
      }
      if (!joined) {
        shouldReconnect = false;
        nextSocket.close();
      }
    }
  });

  nextSocket.addEventListener('close', () => {
    if (nextSocket !== socket) return;
    setConnected(false);
    if (shouldReconnect) {
      showNotice('Connection interrupted. Reconnecting…');
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    } else if (welcome.hidden) {
      composer.hidden = true;
      document.querySelector('#leave-button').hidden = true;
      showNotice('Disconnected from chat. Join again to continue.');
    }
  });

  nextSocket.addEventListener('error', () => showNotice('Could not connect to chat. Check the WebSocket deployment.'));
}

async function loadRooms() {
  try {
    const response = await fetch('/rooms');
    if (!response.ok) throw new Error('Room list unavailable');
    const data = await response.json();
    roomSelect.replaceChildren(...data.rooms.map(room => {
      const option = document.createElement('option');
      option.value = room;
      option.textContent = room[0].toUpperCase() + room.slice(1);
      return option;
    }));
  } catch {
    showNotice('Could not load rooms. Refresh and try again.');
  }
}

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  username = document.querySelector('#username').value.trim();
  currentRoom = roomSelect.value;
  if (!username || username.length > 20) return showNotice('Name must be between 1 and 20 characters.');
  closeRoom();
  messages.replaceChildren();
  messageById.clear();
  clearReplyTarget();
  shouldReconnect = true;
  connect();
});

composer.addEventListener('submit', event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || socket?.readyState !== WebSocket.OPEN) return;
  const clientMessageId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  pendingMessages.set(clientMessageId, { text, replyTarget });
  socket.send(JSON.stringify({
    type: 'send_message',
    text,
    reply_to_id: replyTarget?.id ?? null,
    client_message_id: clientMessageId,
  }));
  messageInput.value = '';
  document.querySelector('#char-count').textContent = '0 / 500';
  clearReplyTarget();
  sendTyping(false);
});

messageInput.addEventListener('input', () => {
  document.querySelector('#char-count').textContent = `${messageInput.value.length} / 500`;
  if (socket?.readyState === WebSocket.OPEN && Date.now() - lastTypingSent > 800) {
    sendTyping(true);
    lastTypingSent = Date.now();
  }
  window.clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => sendTyping(false), 1200);
});

document.querySelector('#cancel-reply').addEventListener('click', clearReplyTarget);

document.querySelector('#leave-button').addEventListener('click', () => {
  if (!window.confirm('Leave this room?')) return;
  closeRoom();
  welcome.hidden = false;
  messages.style.display = 'none';
  messages.replaceChildren();
  messageById.clear();
  composer.hidden = true;
  clearReplyTarget();
  document.querySelector('#leave-button').hidden = true;
  document.querySelector('#room-heading').textContent = 'Join a room';
});

loadRooms();
