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
const roomControls = document.querySelector('#room-controls');
const joinedRoomsSelect = document.querySelector('#joined-rooms');
const roomDialog = document.querySelector('#room-dialog');
const availableRoomsSelect = document.querySelector('#available-rooms');
const roomCatalog = new Map();
const roomSessions = new Map();

let username = '';
let currentRoom = '';
let replyTarget = null;
let lastTypingSent = 0;

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

function renderMessage(message, session) {
  const messageId = String(message.id);
  const parentMessageMap = session.messageById;

  const item = document.createElement('li');
  item.className = 'message' + (message.username === username ? ' mine' : '');
  item.dataset.messageId = messageId;

  const meta = document.createElement('p');
  meta.className = 'message-meta';
  const date = new Date(message.created_at);
  meta.textContent = `${message.username} · ${Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const parent = message.reply_to || parentMessageMap.get(String(message.reply_to_id));
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
  messages.scrollTop = messages.scrollHeight;
}

function renderMessages(session) {
  messages.replaceChildren();
  session.messageById = new Map(session.history.map(message => [String(message.id), message]));
  session.history
    .slice()
    .sort((first, second) => Number(first.id) - Number(second.id))
    .forEach(message => renderMessage(message, session));
}

function addMessage(message, session) {
  const id = String(message.id);
  if (session.messageById.has(id)) return;
  session.messageById.set(id, message);
  session.history.push(message);
  if (session.history.length > 200) {
    const removed = session.history.shift();
    session.messageById.delete(String(removed.id));
  }
  if (session.room === currentRoom) {
    renderMessages(session);
  }
}

function sendTyping(isTyping, room = currentRoom) {
  const socket = roomSessions.get(room)?.socket;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'typing', is_typing: isTyping }));
  }
}

function roomTitle(room) {
  if (room === 'ai') return 'AI';
  return room.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function refreshRoomOptions() {
  const rooms = [...roomCatalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  roomSelect.replaceChildren(...rooms.map(room => {
    const option = document.createElement('option');
    option.value = room.name;
    option.textContent = roomTitle(room.name);
    return option;
  }));
  const available = rooms.filter(room => !roomSessions.has(room.name));
  availableRoomsSelect.replaceChildren(...available.map(room => {
    const option = document.createElement('option');
    option.value = room.name;
    option.textContent = `${roomTitle(room.name)} · up to ${room.capacity}`;
    return option;
  }));
  document.querySelector('#join-listed-room').disabled = !available.length;
  if (!available.length) document.querySelector('#available-room-info').textContent = 'You have joined every room.';
  else updateAvailableRoomInfo();
}

function updateAvailableRoomInfo() {
  const room = roomCatalog.get(availableRoomsSelect.value);
  document.querySelector('#available-room-info').textContent = room
    ? `${room.is_personal ? 'Personal room' : 'Public room'} · maximum ${room.capacity} people`
    : '';
}

function refreshJoinedRooms() {
  const sessions = [...roomSessions.values()];
  roomControls.hidden = sessions.length === 0;
  joinedRoomsSelect.replaceChildren(...sessions.map(session => {
    const option = document.createElement('option');
    option.value = session.room;
    option.textContent = roomTitle(session.room);
    return option;
  }));
  joinedRoomsSelect.value = currentRoom;
  refreshRoomOptions();
}

function renderActiveRoom() {
  const session = roomSessions.get(currentRoom);
  if (!session) return;
  welcome.hidden = true;
  messages.style.display = 'flex';
  composer.hidden = !session.joined;
  document.querySelector('#leave-button').hidden = !session.joined;
  document.querySelector('#room-heading').textContent = roomTitle(currentRoom);
  renderMessages(session);
  renderUsers(session.users);
  renderTyping(session);
  setConnected(session.joined);
}

function renderTyping(session) {
  typingLine.textContent = session.typingUsers.size
    ? `${[...session.typingUsers].join(', ')} ${session.typingUsers.size === 1 ? 'is' : 'are'} typing…`
    : '';
}

function showLobby() {
  currentRoom = '';
  welcome.hidden = false;
  messages.style.display = 'none';
  messages.replaceChildren();
  messageInput.value = '';
  document.querySelector('#char-count').textContent = '0 / 500';
  composer.hidden = true;
  document.querySelector('#leave-button').hidden = true;
  document.querySelector('#room-heading').textContent = 'Join a room';
  renderUsers([]);
  typingLine.textContent = '';
  setConnected(false);
  refreshJoinedRooms();
}

function activateRoom(room) {
  const session = roomSessions.get(room);
  if (!session) return;
  const previous = roomSessions.get(currentRoom);
  if (previous && currentRoom !== room) previous.draft = messageInput.value;
  currentRoom = room;
  joinedRoomsSelect.value = room;
  messageInput.value = session.draft || '';
  document.querySelector('#char-count').textContent = `${messageInput.value.length} / 500`;
  clearReplyTarget();
  renderActiveRoom();
}

function leaveRoom(room) {
  const session = roomSessions.get(room);
  if (!session) return;
  session.shouldReconnect = false;
  window.clearTimeout(session.reconnectTimer);
  window.clearTimeout(session.typingTimer);
  if (session.socket) session.socket.close();
  roomSessions.delete(room);
  refreshJoinedRooms();
  if (currentRoom !== room) return;
  clearReplyTarget();
  const nextRoom = roomSessions.keys().next().value;
  if (nextRoom) activateRoom(nextRoom);
  else showLobby();
}

function connectRoom(session) {
  if (!session.shouldReconnect) return;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const nextSocket = new WebSocket(`${scheme}//${location.host}/ws`);
  session.socket = nextSocket;
  if (session.room === currentRoom) setConnected(false);

  nextSocket.addEventListener('open', () => {
    if (nextSocket !== session.socket || !session.shouldReconnect) return;
    nextSocket.send(JSON.stringify({ type: 'join_room', username, room: session.room }));
  });

  nextSocket.addEventListener('message', event => {
    if (nextSocket !== session.socket) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'history') {
      session.history = data.messages || [];
      session.messageById = new Map(session.history.map(message => [String(message.id), message]));
      session.joined = true;
      session.reconnectDelay = 1000;
      if (session.room === currentRoom) renderActiveRoom();
    } else if (data.type === 'message') {
      if (data.client_message_id) session.pendingMessages.delete(data.client_message_id);
      addMessage(data, session);
      if (session.room === currentRoom && (data.mentions || []).some(name => name.toLocaleLowerCase() === username.toLocaleLowerCase())) {
        showNotice(`${data.username} mentioned you.`);
      }
    } else if (data.type === 'presence_update') {
      session.users = data.users || [];
      if (session.room === currentRoom) renderUsers(session.users);
    } else if (data.type === 'typing') {
      if (data.username === username) return;
      if (data.is_typing) session.typingUsers.add(data.username);
      else session.typingUsers.delete(data.username);
      if (session.room === currentRoom) renderTyping(session);
    } else if (data.type === 'ping') {
      nextSocket.send(JSON.stringify({ type: 'pong' }));
    } else if (data.type === 'error') {
      const pending = data.client_message_id ? session.pendingMessages.get(data.client_message_id) : null;
      if (data.client_message_id) session.pendingMessages.delete(data.client_message_id);
      if (session.room === currentRoom) showNotice(data.message);
      if (pending && session.room === currentRoom) {
        messageInput.value = messageInput.value
          ? `${pending.text}\n${messageInput.value}`.slice(0, 500)
          : pending.text;
        session.draft = messageInput.value;
        document.querySelector('#char-count').textContent = `${messageInput.value.length} / 500`;
        if (pending.replyTarget && !replyTarget) setReplyTarget(pending.replyTarget);
      }
      if (!session.joined) {
        session.shouldReconnect = false;
        nextSocket.close();
        roomSessions.delete(session.room);
        refreshJoinedRooms();
        if (session.room === currentRoom) {
          const nextRoom = roomSessions.keys().next().value;
          if (nextRoom) activateRoom(nextRoom);
          else showLobby();
          showNotice(data.message);
        }
      }
    }
  });

  nextSocket.addEventListener('close', () => {
    if (nextSocket !== session.socket || !session.shouldReconnect) return;
    if (session.room === currentRoom) {
      setConnected(false);
      showNotice('Connection interrupted. Reconnecting…');
    }
    session.reconnectTimer = window.setTimeout(() => connectRoom(session), session.reconnectDelay);
    session.reconnectDelay = Math.min(session.reconnectDelay * 2, 15000);
  });

  nextSocket.addEventListener('error', () => {
    if (session.room === currentRoom) showNotice('Could not connect to chat. Check the WebSocket deployment.');
  });
}

function joinRoom(room) {
  if (!room) return;
  if (!username) username = document.querySelector('#username').value.trim();
  if (!username || username.length > 20) {
    showNotice('Enter a name between 1 and 20 characters first.');
    return;
  }
  if (roomSessions.has(room)) {
    activateRoom(room);
    return;
  }
  const session = {
    room, socket: null, joined: false, shouldReconnect: true, reconnectDelay: 1000,
    reconnectTimer: null, history: [], messageById: new Map(), users: [],
    typingUsers: new Set(), pendingMessages: new Map(), draft: '',
  };
  roomSessions.set(room, session);
  refreshJoinedRooms();
  activateRoom(room);
  connectRoom(session);
}

async function loadRooms() {
  try {
    const response = await fetch('/rooms/catalog');
    if (!response.ok) throw new Error('Room list unavailable');
    const data = await response.json();
    roomCatalog.clear();
    data.rooms.forEach(room => roomCatalog.set(room.name, room));
    refreshRoomOptions();
  } catch {
    showNotice('Could not load rooms. Refresh and try again.');
  }
}

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  username = document.querySelector('#username').value.trim();
  if (!username || username.length > 20) return showNotice('Name must be between 1 and 20 characters.');
  joinRoom(roomSelect.value);
});

composer.addEventListener('submit', event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  const session = roomSessions.get(currentRoom);
  if (!text || session?.socket?.readyState !== WebSocket.OPEN) return;
  const clientMessageId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  session.pendingMessages.set(clientMessageId, { text, replyTarget });
  session.socket.send(JSON.stringify({
    type: 'send_message',
    text,
    reply_to_id: replyTarget?.id ?? null,
    client_message_id: clientMessageId,
  }));
  messageInput.value = '';
  session.draft = '';
  document.querySelector('#char-count').textContent = '0 / 500';
  clearReplyTarget();
  sendTyping(false);
});

messageInput.addEventListener('input', () => {
  document.querySelector('#char-count').textContent = `${messageInput.value.length} / 500`;
  const session = roomSessions.get(currentRoom);
  if (session) session.draft = messageInput.value;
  if (session?.socket?.readyState === WebSocket.OPEN && Date.now() - lastTypingSent > 800) {
    sendTyping(true);
    lastTypingSent = Date.now();
  }
  window.clearTimeout(session?.typingTimer);
  if (session) session.typingTimer = window.setTimeout(() => sendTyping(false, session.room), 1200);
});

document.querySelector('#cancel-reply').addEventListener('click', clearReplyTarget);

document.querySelector('#leave-button').addEventListener('click', () => {
  if (!window.confirm('Leave this room?')) return;
  leaveRoom(currentRoom);
});

joinedRoomsSelect.addEventListener('change', () => activateRoom(joinedRoomsSelect.value));
availableRoomsSelect.addEventListener('change', updateAvailableRoomInfo);
document.querySelector('#manage-rooms').addEventListener('click', () => {
  document.querySelector('#room-dialog-notice').textContent = '';
  refreshRoomOptions();
  roomDialog.showModal();
});
document.querySelector('#initial-create-room').addEventListener('click', () => {
  document.querySelector('#room-dialog-notice').textContent = '';
  refreshRoomOptions();
  roomDialog.showModal();
});
document.querySelector('#close-room-dialog').addEventListener('click', () => roomDialog.close());
document.querySelector('#join-listed-room').addEventListener('click', () => {
  const room = availableRoomsSelect.value;
  if (!room) return;
  roomDialog.close();
  joinRoom(room);
});

document.querySelector('#create-room-form').addEventListener('submit', async event => {
  event.preventDefault();
  const roomNameInput = document.querySelector('#new-room-name');
  const capacityInput = document.querySelector('#new-room-capacity');
  const noticeElement = document.querySelector('#room-dialog-notice');
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const capacity = Number(capacityInput.value);
  if (!roomNameInput.value.trim() || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
    noticeElement.textContent = 'Enter a room name and a capacity from 1 to 100.';
    return;
  }
  submitButton.disabled = true;
  noticeElement.textContent = 'Creating room…';
  try {
    const response = await fetch('/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roomNameInput.value, capacity }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Could not create the room.');
    roomCatalog.set(data.room.name, data.room);
    roomSelect.value = data.room.name;
    roomDialog.close();
    roomNameInput.value = '';
    capacityInput.value = '20';
    if (username || document.querySelector('#username').value.trim()) {
      joinRoom(data.room.name);
    } else {
      showNotice('Room created. Enter your name, then join it.');
    }
  } catch (error) {
    noticeElement.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

loadRooms();
