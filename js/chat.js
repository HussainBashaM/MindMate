/* ============ MindMate — chat app logic ============ */

let currentConversationId = null;
let isSending = false;
let pendingAttachments = []; // [{id, filename, mimeType, previewUrl?}]
let isRecording = false;
let recognition = null;

/* Minimal, safe markdown-ish renderer: escapes HTML first, then applies a
   small set of Markdown transforms. Good enough for chat text without
   pulling in a heavy library. */
function renderMarkdown(raw) {
  let text = escapeHtml(raw);

  // fenced code blocks ```code```
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  // inline code `code`
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // links [text](url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // bare urls
  text = text.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  // unordered list lines starting with "- "
  text = text.replace(/(^|\n)-\s(.+)/g, "$1• $2");
  // line breaks
  text = text.replace(/\n/g, "<br>");

  return text;
}

function renderAttachments(attachments) {
  if (!attachments || !attachments.length) return "";
  const items = attachments.map(a => {
    const url = `/api/attachments/${a.id}`;
    if ((a.mimeType || "").startsWith("image/")) {
      return `<img class="msg-attachment-image" src="${url}" alt="${escapeHtml(a.filename || "attachment")}" onclick="window.open('${url}','_blank')">`;
    }
    return `<a class="msg-attachment-file" href="${url}" target="_blank" rel="noopener">📄 ${escapeHtml(a.filename || "file")}</a>`;
  }).join("");
  return `<div class="msg-attachments">${items}</div>`;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scrollToBottom() {
  const area = document.getElementById("messages-area");
  area.scrollTop = area.scrollHeight;
}

function appendMessage(msg, { animate = true } = {}) {
  const inner = document.getElementById("messages-inner");
  document.getElementById("empty-state")?.remove();

  const row = document.createElement("div");
  row.className = `msg-row ${msg.role}`;
  const avatar = msg.role === "user" ? "🧑" : "✨";

  row.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-bubble-wrap">
      <div class="msg-bubble">
        ${renderAttachments(msg.attachments)}
        ${msg.content ? renderMarkdown(msg.content) : ""}
      </div>
      <div class="msg-meta">
        <span>${formatTime(msg.timestamp)}</span>
        <div class="msg-actions">
          <button class="msg-action-btn" data-copy title="Copy">Copy</button>
          ${msg.role === "user" ? '<button class="msg-action-btn" data-edit title="Edit">Edit</button>' : '<button class="msg-action-btn" data-regenerate title="Regenerate">Regenerate</button>'}
          <button class="msg-action-btn" data-delete title="Delete">Delete</button>
        </div>
      </div>
    </div>`;

  row.querySelector("[data-copy]").addEventListener("click", () => {
    navigator.clipboard.writeText(msg.content);
    showToast("Copied to clipboard.", "success", 1800);
  });
  row.querySelector("[data-delete]").addEventListener("click", () => {
    row.remove(); // Client-side removal; full message-level delete API can be added alongside conversations.
  });
  if (msg.role === "user") {
    row.querySelector("[data-edit]").addEventListener("click", () => {
      const composer = document.getElementById("composer-input");
      composer.value = msg.content;
      composer.focus();
      autoResize(composer);
    });
  } else {
    row.querySelector("[data-regenerate]").addEventListener("click", () => {
      const lastUser = [...inner.querySelectorAll(".msg-row.user")].pop();
      if (lastUser) sendMessage(lastUser.querySelector(".msg-bubble").textContent, { regenerating: true });
    });
  }

  inner.appendChild(row);
  if (animate) scrollToBottom();
}

function showTypingIndicator() {
  const inner = document.getElementById("messages-inner");
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  row.id = "typing-row";
  row.innerHTML = `
    <div class="msg-avatar">✨</div>
    <div class="msg-bubble-wrap">
      <div class="msg-bubble">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:4px;">MindMate is thinking…</div>
      </div>
    </div>`;
  inner.appendChild(row);
  scrollToBottom();
}

function removeTypingIndicator() {
  document.getElementById("typing-row")?.remove();
}

async function sendMessage(text, { regenerating = false } = {}) {
  const attachmentsToSend = regenerating ? [] : pendingAttachments.map(a => ({ id: a.id, filename: a.filename, mimeType: a.mimeType }));
  if (!text.trim() && !attachmentsToSend.length) return;
  if (isSending) return;
  isSending = true;
  document.getElementById("send-btn").disabled = true;

  if (!regenerating) {
    appendMessage({
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      attachments: attachmentsToSend,
    });
    clearAttachmentChips();
  }
  showTypingIndicator();

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: { message: text, conversationId: currentConversationId, attachments: attachmentsToSend },
    });
    removeTypingIndicator();
    currentConversationId = data.conversationId;
    appendMessage(data.message);
    await loadConversationList(); // refresh sidebar (title/order may have changed)
    highlightActiveConversation();
  } catch (err) {
    removeTypingIndicator();
    appendMessage({
      role: "assistant",
      content: "Sorry, I'm having trouble connecting right now. Please try again.",
      timestamp: new Date().toISOString(),
    });
    showToast(err.message, "error");
  } finally {
    isSending = false;
    document.getElementById("send-btn").disabled = false;
  }
}

/* ---------------- Attachments (real upload to backend) ---------------- */
function renderAttachmentChips() {
  const wrap = document.getElementById("attachment-chips");
  wrap.innerHTML = pendingAttachments.map((a, i) => `
    <div class="attachment-chip ${a.uploading ? "uploading" : ""}" data-index="${i}">
      ${a.previewUrl ? `<img src="${a.previewUrl}">` : `<div class="file-icon">📄</div>`}
      <span class="chip-name">${a.uploading ? "Uploading…" : escapeHtml(a.filename)}</span>
      <button type="button" class="chip-remove" data-remove="${i}">✕</button>
    </div>`).join("");

  wrap.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      pendingAttachments.splice(Number(btn.dataset.remove), 1);
      renderAttachmentChips();
      updateSendButtonState();
    });
  });
}

function clearAttachmentChips() {
  pendingAttachments = [];
  document.getElementById("attachment-chips").innerHTML = "";
}

function updateSendButtonState() {
  const textarea = document.getElementById("composer-input");
  document.getElementById("send-btn").disabled = !textarea.value.trim() && pendingAttachments.length === 0;
}

async function handleFileSelection(files) {
  const MAX_FILES = 3;
  const MAX_SIZE = 8 * 1024 * 1024; // matches backend limit

  for (const file of Array.from(files).slice(0, MAX_FILES - pendingAttachments.length)) {
    if (file.size > MAX_SIZE) {
      showToast(`"${file.name}" is over 8MB and was skipped.`, "error");
      continue;
    }

    const placeholder = { filename: file.name, uploading: true, previewUrl: null };
    if (file.type.startsWith("image/")) {
      placeholder.previewUrl = URL.createObjectURL(file);
    }
    pendingAttachments.push(placeholder);
    renderAttachmentChips();

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Authorization": "Bearer " + Auth.getToken() },
        body: formData,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);

      const idx = pendingAttachments.indexOf(placeholder);
      if (idx !== -1) {
        pendingAttachments[idx] = {
          id: json.data.id,
          filename: json.data.filename,
          mimeType: json.data.mimeType,
          previewUrl: placeholder.previewUrl,
        };
        renderAttachmentChips();
        updateSendButtonState();
      }
    } catch (err) {
      pendingAttachments = pendingAttachments.filter(a => a !== placeholder);
      renderAttachmentChips();
      showToast(err.message || "Upload failed.", "error");
    }
  }
}

/* ---------------- Voice input (Web Speech API — real browser speech-to-text) ---------------- */
function initVoiceInput() {
  const voiceBtn = document.getElementById("voice-btn");
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognitionCtor) {
    voiceBtn.addEventListener("click", () => {
      showToast("Voice input needs a Chrome or Edge browser — it isn't supported here yet.", "info");
    });
    return;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  const textarea = document.getElementById("composer-input");
  let baseText = "";

  recognition.addEventListener("start", () => {
    isRecording = true;
    baseText = textarea.value ? textarea.value + " " : "";
    voiceBtn.classList.add("recording");
  });

  recognition.addEventListener("result", (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
    textarea.value = baseText + transcript;
    autoResize(textarea);
    updateSendButtonState();
  });

  recognition.addEventListener("end", () => {
    isRecording = false;
    voiceBtn.classList.remove("recording");
  });

  recognition.addEventListener("error", (e) => {
    isRecording = false;
    voiceBtn.classList.remove("recording");
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      showToast("Microphone access was blocked. Allow it in your browser settings to use voice input.", "error");
    } else if (e.error !== "no-speech" && e.error !== "aborted") {
      showToast("Voice input error. Please try again.", "error");
    }
  });

  voiceBtn.addEventListener("click", () => {
    if (isRecording) {
      recognition.stop();
    } else {
      try { recognition.start(); } catch { /* already started */ }
    }
  });
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function showEmptyState() {
  const inner = document.getElementById("messages-inner");
  inner.innerHTML = `
    <div class="empty-state" id="empty-state">
      <div class="logo-mark">✨</div>
      <h2>How can I help you today?</h2>
      <p>Ask me anything, or try one of these:</p>
      <div class="suggestion-grid">
        <button class="btn btn-secondary suggestion-chip" data-suggest>Explain machine learning simply</button>
        <button class="btn btn-secondary suggestion-chip" data-suggest>What's the weather in Hyderabad?</button>
        <button class="btn btn-secondary suggestion-chip" data-suggest>Plan a 3-day trip to Hyderabad</button>
        <button class="btn btn-secondary suggestion-chip" data-suggest>What is 128 × 42?</button>
      </div>
    </div>`;
  inner.querySelectorAll("[data-suggest]").forEach(btn =>
    btn.addEventListener("click", () => {
      document.getElementById("composer-input").value = btn.textContent;
      document.getElementById("composer-form").requestSubmit();
    })
  );
}

async function loadConversation(id) {
  currentConversationId = id;
  const inner = document.getElementById("messages-inner");
  inner.innerHTML = `<div class="skeleton" style="height:60px;border-radius:16px;"></div>`;
  try {
    const data = await api(`/api/conversations/${id}`);
    inner.innerHTML = "";
    if (!data.conversation.messages.length) {
      showEmptyState();
    } else {
      data.conversation.messages.forEach(m => appendMessage(m, { animate: false }));
      scrollToBottom();
    }
    document.getElementById("conversation-title").textContent = data.conversation.title;
    highlightActiveConversation();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function startNewChat() {
  currentConversationId = null;
  document.getElementById("conversation-title").textContent = "New Chat";
  showEmptyState();
  highlightActiveConversation();
  if (window.innerWidth <= 768) {
    document.querySelector(".sidebar")?.classList.remove("open");
    document.querySelector(".sidebar-overlay")?.classList.remove("show");
  }
}

function highlightActiveConversation() {
  document.querySelectorAll(".history-item").forEach(el => {
    el.classList.toggle("active", el.dataset.id === currentConversationId);
  });
}

async function loadConversationList() {
  const list = document.getElementById("history-list");
  try {
    const data = await api("/api/conversations");
    if (!data.conversations.length) {
      list.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--text-faint);">No conversations yet.</div>`;
      return;
    }
    list.innerHTML = "";
    data.conversations.forEach(c => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.dataset.id = c.id;
      item.innerHTML = `<span>${escapeHtml(c.title)}</span><button class="del-btn" title="Delete">✕</button>`;
      item.addEventListener("click", (e) => {
        if (e.target.closest(".del-btn")) return;
        loadConversation(c.id);
      });
      item.querySelector(".del-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${c.title}"?`)) return;
        try {
          await api(`/api/conversations/${c.id}`, { method: "DELETE" });
          if (currentConversationId === c.id) startNewChat();
          loadConversationList();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
      list.appendChild(item);
    });
    highlightActiveConversation();
  } catch (err) {
    list.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--red);">Unable to load your conversation. Please try again.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (!requireAuth()) return;

  showEmptyState();
  loadConversationList();

  document.getElementById("new-chat-btn").addEventListener("click", startNewChat);

  const form = document.getElementById("composer-form");
  const textarea = document.getElementById("composer-input");
  const sendBtn = document.getElementById("send-btn");
  const fileInput = document.getElementById("file-input");
  const attachBtn = document.getElementById("attach-btn");

  textarea.addEventListener("input", () => {
    autoResize(textarea);
    updateSendButtonState();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sendBtn.disabled) return;
    const text = textarea.value;
    textarea.value = "";
    autoResize(textarea);
    sendBtn.disabled = true;
    sendMessage(text);
  });

  // Real file attachments: click the paperclip → open the OS file picker → upload immediately
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFileSelection(fileInput.files);
    fileInput.value = ""; // allow selecting the same file again later
  });

  // Real voice input via the browser's built-in speech recognition
  initVoiceInput();
});
