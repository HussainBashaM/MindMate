/* ============ MindMate — profile page logic ============ */
document.addEventListener("DOMContentLoaded", async () => {
  if (!requireAuth()) return;

  try {
    const data = await api("/api/profile");
    const p = data.profile;
    const initials = (p.fullName || "?").split(" ").map(x => x[0]).slice(0, 2).join("").toUpperCase();
    document.getElementById("profile-avatar").textContent = initials;
    document.getElementById("profile-name").textContent = p.fullName;
    document.getElementById("profile-email").textContent = p.email;
    document.getElementById("stat-conversations").textContent = p.totalConversations;
    document.getElementById("stat-messages").textContent = p.totalMessages;
    document.getElementById("stat-joined").textContent = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—";

    const form = document.getElementById("profile-form");
    form.fullName.value = p.fullName || "";
    form.email.value = p.email || "";
    form.phone.value = p.phone || "";

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        await api("/api/profile", { method: "PUT", body: { fullName: form.fullName.value, phone: form.phone.value } });
        const user = Auth.getUser();
        user.fullName = form.fullName.value;
        Auth.setUser(user);
        showToast("Profile updated.", "success");
        renderUserChip();
        document.getElementById("profile-name").textContent = form.fullName.value;
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false; btn.textContent = "Save Changes";
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
});
