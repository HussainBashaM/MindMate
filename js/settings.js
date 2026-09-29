/* ============ MindMate — settings page logic ============ */
document.addEventListener("DOMContentLoaded", async () => {
  if (!requireAuth()) return;

  const form = document.getElementById("settings-form");

  try {
    const data = await api("/api/settings");
    const s = data.settings;
    form.theme.value = s.theme || "dark";
    form.language.value = s.language || "en";
    form.responseStyle.value = s.responseStyle || "balanced";
    form.emailNotifications.checked = !!s.emailNotifications;
    form.chatNotifications.checked = !!s.chatNotifications;
  } catch (err) {
    showToast(err.message, "error");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          theme: form.theme.value,
          language: form.language.value,
          responseStyle: form.responseStyle.value,
          emailNotifications: form.emailNotifications.checked,
          chatNotifications: form.chatNotifications.checked,
        },
      });
      showToast("Settings saved.", "success");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false; btn.textContent = "Save Settings";
    }
  });

  document.getElementById("clear-history-btn").addEventListener("click", async () => {
    if (!confirm("This will permanently delete all your conversations. Continue?")) return;
    try {
      await api("/api/settings/clear-history", { method: "POST" });
      showToast("Conversation history cleared.", "success");
    } catch (err) { showToast(err.message, "error"); }
  });

  document.getElementById("delete-account-btn").addEventListener("click", async () => {
    if (!confirm("This will permanently delete your account and all data. This cannot be undone. Continue?")) return;
    if (!confirm("Are you absolutely sure?")) return;
    try {
      await api("/api/settings/delete-account", { method: "POST" });
      Auth.clear();
      window.location.href = "index.html";
    } catch (err) { showToast(err.message, "error"); }
  });
});
