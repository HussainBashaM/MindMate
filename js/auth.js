/* ============ MindMate — auth page logic ============ */

function togglePasswordField(inputId, btn) {
  const input = document.getElementById(inputId);
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  btn.textContent = isHidden ? "Hide" : "Show";
}

document.addEventListener("DOMContentLoaded", () => {
  // If already logged in, skip straight to chat
  if (Auth.isLoggedIn() && document.body.dataset.authPage) {
    window.location.href = "chat.html";
    return;
  }

  /* ---------------- LOGIN ---------------- */
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("auth-error");
      errEl.textContent = "";
      const btn = loginForm.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Logging in…";
      try {
        const data = await api("/api/auth/login", {
          method: "POST", auth: false,
          body: {
            email: loginForm.email.value.trim(),
            password: loginForm.password.value,
          },
        });
        Auth.setToken(data.token);
        Auth.setUser(data.user);
        window.location.href = "chat.html";
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = "Log In";
      }
    });
  }

  /* ---------------- REGISTER ---------------- */
  const registerForm = document.getElementById("register-form");
  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("auth-error");
      errEl.textContent = "";

      if (registerForm.password.value !== registerForm.confirmPassword.value) {
        errEl.textContent = "Passwords do not match.";
        return;
      }
      if (!registerForm.terms.checked) {
        errEl.textContent = "Please accept the Terms to continue.";
        return;
      }

      const btn = registerForm.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Creating account…";
      try {
        const data = await api("/api/auth/register", {
          method: "POST", auth: false,
          body: {
            fullName: registerForm.fullName.value.trim(),
            email: registerForm.email.value.trim(),
            phone: registerForm.phone.value.trim(),
            password: registerForm.password.value,
          },
        });
        Auth.setToken(data.token);
        Auth.setUser(data.user);
        showToast("Account created — welcome to MindMate!", "success");
        window.location.href = "chat.html";
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = "Create Account";
      }
    });
  }

  /* ---------------- FORGOT PASSWORD ---------------- */
  const forgotForm = document.getElementById("forgot-form");
  if (forgotForm) {
    forgotForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = forgotForm.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        await api("/api/auth/forgot-password", {
          method: "POST", auth: false,
          body: { email: forgotForm.email.value.trim() },
        });
        document.getElementById("forgot-success").style.display = "block";
        forgotForm.style.display = "none";
      } catch (err) {
        document.getElementById("auth-error").textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = "Send Reset Link";
      }
    });
  }

  /* ---------------- RESET PASSWORD ---------------- */
  const resetForm = document.getElementById("reset-form");
  if (resetForm) {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") || "";
    if (!token) {
      document.getElementById("auth-error").textContent = "Missing or invalid reset link.";
    }
    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("auth-error");
      errEl.textContent = "";
      if (resetForm.password.value !== resetForm.confirmPassword.value) {
        errEl.textContent = "Passwords do not match.";
        return;
      }
      const btn = resetForm.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Resetting…";
      try {
        await api("/api/auth/reset-password", {
          method: "POST", auth: false,
          body: { token, password: resetForm.password.value },
        });
        showToast("Password reset. Please log in.", "success");
        window.location.href = "login.html";
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = "Reset Password";
      }
    });
  }
});
