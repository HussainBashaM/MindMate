/* ============ MindMate — history page logic ============ */
let allConversations = [];

function renderHistoryTable(items) {
  const tbody = document.getElementById("history-tbody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-faint);padding:30px;">No conversations found.</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(c => `
    <tr>
      <td><a href="chat.html?c=${c.id}" style="font-weight:600;">${escapeHtml(c.title)}</a></td>
      <td style="color:var(--text-dim);">${escapeHtml(c.lastMessage || "—")}</td>
      <td style="color:var(--text-dim);white-space:nowrap;">${c.updatedAt ? new Date(c.updatedAt).toLocaleString() : "—"}</td>
      <td>
        <button class="btn-secondary btn" style="padding:6px 12px;font-size:12px;" data-rename="${c.id}">Rename</button>
        <button class="btn-danger btn" style="padding:6px 12px;font-size:12px;" data-delete="${c.id}">Delete</button>
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-delete]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.delete;
    if (!confirm("Delete this conversation permanently?")) return;
    try {
      await api(`/api/conversations/${id}`, { method: "DELETE" });
      showToast("Conversation deleted.", "success");
      loadHistory();
    } catch (err) { showToast(err.message, "error"); }
  }));
  tbody.querySelectorAll("[data-rename]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.rename;
    const newTitle = prompt("New title:");
    if (!newTitle) return;
    try {
      await api(`/api/conversations/${id}`, { method: "PUT", body: { title: newTitle } });
      showToast("Renamed.", "success");
      loadHistory();
    } catch (err) { showToast(err.message, "error"); }
  }));
}

async function loadHistory() {
  const tbody = document.getElementById("history-tbody");
  tbody.innerHTML = `<tr><td colspan="4" style="padding:20px;"><div class="skeleton" style="height:20px;"></div></td></tr>`;
  try {
    const data = await api("/api/conversations");
    allConversations = data.conversations;
    renderHistoryTable(allConversations);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--red);text-align:center;padding:24px;">Unable to load your conversation. Please try again.</td></tr>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (!requireAuth()) return;
  loadHistory();

  let debounceTimer;
  document.getElementById("history-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    const q = e.target.value.toLowerCase();
    debounceTimer = setTimeout(() => {
      renderHistoryTable(allConversations.filter(c => c.title.toLowerCase().includes(q)));
    }, 250);
  });
});
