/* ============ MindMate — shared frontend helpers ============ */

const API_BASE = ""; // same-origin: Flask serves both frontend and /api/*

const Auth = {
  getToken() { return localStorage.getItem("mindmate_token"); },
  setToken(t) { localStorage.setItem("mindmate_token", t); },
  clear() { localStorage.removeItem("mindmate_token"); localStorage.removeItem("mindmate_user"); },
  getUser() {
    const raw = localStorage.getItem("mindmate_user");
    return raw ? JSON.parse(raw) : null;
  },
  setUser(u) { localStorage.setItem("mindmate_user", JSON.stringify(u)); },
  isLoggedIn() { return !!this.getToken(); },
  logout() { this.clear(); window.location.href = "login.html"; },
};

/** Redirect to login if not authenticated. Call at top of protected pages. */
function requireAuth() {
  if (!Auth.isLoggedIn()) {
    window.location.href = "login.html";
    return false;
  }
  return true;
}

/** Redirect away from admin pages if user isn't an admin. */
function requireAdmin() {
  if (!requireAuth()) return false;
  const user = Auth.getUser();
  if (!user || user.role !== "admin") {
    window.location.href = "chat.html";
    return false;
  }
  return true;
}

async function api(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && Auth.getToken()) headers["Authorization"] = "Bearer " + Auth.getToken();

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error("Connection lost. Check your internet connection.");
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("Unexpected server response.");
  }

  if (res.status === 401 && auth) {
    Auth.clear();
    window.location.href = "login.html";
    throw new Error(json.message || "Session expired.");
  }

  if (!json.success) {
    throw new Error(json.message || "Something went wrong.");
  }
  return json.data;
}

/* ---------------- Toasts ---------------- */
function ensureToastContainer() {
  let c = document.querySelector(".toast-container");
  if (!c) {
    c = document.createElement("div");
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, type = "info", duration = 3800) {
  const container = ensureToastContainer();
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, duration);
}

/* ---------------- Online/offline banner ---------------- */
window.addEventListener("offline", () => showToast("Connection lost. Check your internet connection.", "error"));
window.addEventListener("online", () => showToast("Back online.", "success"));

/* ---------------- Mobile sidebar toggle (used on dashboard/chat pages) ---------------- */
function initSidebarToggle() {
  const hamburger = document.querySelector(".hamburger");
  const sidebar = document.querySelector(".sidebar");
  if (!hamburger || !sidebar) return;

  let overlay = document.querySelector(".sidebar-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "sidebar-overlay";
    document.body.appendChild(overlay);
  }

  const close = () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); };
  hamburger.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("show");
  });
  overlay.addEventListener("click", close);
}

/* ---------------- Populate shared user chip (sidebar) ---------------- */
function renderUserChip() {
  const chip = document.querySelector("[data-user-chip]");
  if (!chip) return;
  const user = Auth.getUser();
  if (!user) return;
  const initials = (user.fullName || "?").split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase();
  chip.innerHTML = `
    <div class="avatar-circle">${initials}</div>
    <div>
      <div class="user-chip-name">${escapeHtml(user.fullName || "User")}</div>
      <div class="user-chip-email">${escapeHtml(user.email || "")}</div>
    </div>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", () => {
  initSidebarToggle();
  renderUserChip();
  document.querySelectorAll("[data-logout]").forEach(btn =>
    btn.addEventListener("click", (e) => { e.preventDefault(); Auth.logout(); })
  );
});
