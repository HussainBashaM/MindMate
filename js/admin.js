/* ============ MindMate — admin panel logic ============ */
document.addEventListener("DOMContentLoaded", async () => {
  if (!requireAdmin()) return;

  try {
    const stats = (await api("/api/admin/stats"));
    document.getElementById("stat-total-users").textContent = stats.totalUsers;
    document.getElementById("stat-active-users").textContent = stats.activeUsers;
    document.getElementById("stat-total-conversations").textContent = stats.totalConversations;
    document.getElementById("stat-total-messages").textContent = stats.totalMessages;

    const chart = document.getElementById("tools-chart");
    if (!stats.popularTools.length) {
      chart.innerHTML = `<p style="color:var(--text-faint);">No tool usage yet.</p>`;
    } else {
      const max = Math.max(...stats.popularTools.map(t => t.count));
      chart.innerHTML = stats.popularTools.map(t => `
        <div class="bar-col">
          <div class="bar" style="height:${Math.max(6, (t.count / max) * 140)}px;"></div>
          <div class="bar-label">${escapeHtml(t.tool)}<br>${t.count}</div>
        </div>`).join("");
    }
  } catch (err) {
    showToast(err.message, "error");
  }

  const usersTbody = document.getElementById("admin-users-tbody");
  if (usersTbody) {
    try {
      const data = await api("/api/admin/users");
      usersTbody.innerHTML = data.users.map(u => `
        <tr>
          <td>${escapeHtml(u.fullName)}</td>
          <td style="color:var(--text-dim);">${escapeHtml(u.email)}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-purple' : 'badge-teal'}">${u.role}</span></td>
          <td style="color:var(--text-dim);">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</td>
        </tr>`).join("");
    } catch (err) { showToast(err.message, "error"); }
  }

  const convosTbody = document.getElementById("admin-convos-tbody");
  if (convosTbody) {
    try {
      const data = await api("/api/admin/conversations");
      convosTbody.innerHTML = data.conversations.map(c => `
        <tr>
          <td style="font-weight:600;">${escapeHtml(c.title)}</td>
          <td style="color:var(--text-dim);">${escapeHtml(c.lastMessage || "—")}</td>
          <td style="color:var(--text-dim);">${c.updatedAt ? new Date(c.updatedAt).toLocaleString() : "—"}</td>
        </tr>`).join("");
    } catch (err) { showToast(err.message, "error"); }
  }
});
