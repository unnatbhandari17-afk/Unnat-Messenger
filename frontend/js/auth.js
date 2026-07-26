/**
 * Handles the login / register / forgot-password page (index.html).
 */
(function () {
  // Restore theme preference
  const savedTheme = localStorage.getItem("nimbus_theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  const themeToggle = document.getElementById("themeToggle");
  themeToggle.textContent = savedTheme === "dark" ? "☀️" : "🌙";
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("nimbus_theme", next);
    themeToggle.textContent = next === "dark" ? "☀️" : "🌙";
  });

  // If already logged in, go straight to the app
  if (Api.getToken()) {
    window.location.href = "chat.html";
    return;
  }

  const tabs = document.querySelectorAll(".auth-tab");
  const forms = { login: document.getElementById("loginForm"), register: document.getElementById("registerForm") };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      Object.values(forms).forEach((f) => f.classList.remove("active"));
      document.getElementById("forgotForm").classList.remove("active");
      forms[tab.dataset.tab].classList.add("active");
    });
  });

  document.getElementById("forgotLink").addEventListener("click", (e) => {
    e.preventDefault();
    Object.values(forms).forEach((f) => f.classList.remove("active"));
    document.getElementById("forgotForm").classList.add("active");
  });
  document.getElementById("backToLogin").addEventListener("click", () => {
    document.getElementById("forgotForm").classList.remove("active");
    forms.login.classList.add("active");
    tabs.forEach((t) => t.classList.remove("active"));
    tabs[0].classList.add("active");
  });

  document.getElementById("forgotForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const successEl = document.getElementById("forgotSuccess");
    successEl.textContent = "If an account exists for that email, a reset link has been sent.";
  });

  // ---------- Login ----------
  forms.login.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("loginError");
    errorEl.textContent = "";
    const identifier = document.getElementById("loginIdentifier").value.trim();
    const password = document.getElementById("loginPassword").value;
    const rememberMe = document.getElementById("rememberMe").checked;

    try {
      const data = await Api.post("/api/auth/login", {
        username_or_email: identifier,
        password,
        remember_me: rememberMe,
      });
      Api.setToken(data.access_token);
      Api.setUser(data.user);
      window.location.href = "chat.html";
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  // ---------- Register ----------
  const pwInput = document.getElementById("regPassword");
  const strengthBar = document.getElementById("strengthBar");
  const strengthLabel = document.getElementById("strengthLabel");
  pwInput.addEventListener("input", () => {
    const v = pwInput.value;
    let score = 0;
    if (v.length >= 8) score++;
    if (/[A-Z]/.test(v)) score++;
    if (/[0-9]/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const levels = [
      { width: "0%", color: "#ddd", label: "Password strength" },
      { width: "25%", color: "#FF5C7A", label: "Weak" },
      { width: "50%", color: "#FFB020", label: "Fair" },
      { width: "75%", color: "#00B4D8", label: "Good" },
      { width: "100%", color: "#17A673", label: "Strong" },
    ];
    const level = levels[score];
    strengthBar.style.width = level.width;
    strengthBar.style.background = level.color;
    strengthLabel.textContent = level.label;
  });

  forms.register.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("registerError");
    errorEl.textContent = "";
    const username = document.getElementById("regUsername").value.trim();
    const email = document.getElementById("regEmail").value.trim();
    const password = pwInput.value;

    try {
      const data = await Api.post("/api/auth/register", { username, email, password });
      Api.setToken(data.access_token);
      Api.setUser(data.user);
      window.location.href = "chat.html";
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
})();
