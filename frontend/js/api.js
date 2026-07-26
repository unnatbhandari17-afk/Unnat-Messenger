/**
 * Thin wrapper around fetch() that attaches the JWT token,
 * automatically connects to the FastAPI backend,
 * and handles JSON parsing / errors.
 */

// Automatically use the same IP as the page, but backend on port 8000
const API_BASE = window.location.origin;

const Api = {
  getToken() {
    return localStorage.getItem("nimbus_token");
  },

  setToken(token) {
    localStorage.setItem("nimbus_token", token);
  },

  clearToken() {
    localStorage.removeItem("nimbus_token");
    localStorage.removeItem("nimbus_user");
  },

  getUser() {
    const raw = localStorage.getItem("nimbus_user");
    return raw ? JSON.parse(raw) : null;
  },

  setUser(user) {
    localStorage.setItem("nimbus_user", JSON.stringify(user));
  },

  async request(method, path, body = undefined, isFormData = false) {
    const headers = {};

    const token = this.getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (!isFormData) {
      headers["Content-Type"] = "application/json";
    }

    const options = {
      method,
      headers,
    };

    if (body !== undefined) {
      options.body = isFormData ? body : JSON.stringify(body);
    }

    const response = await fetch(API_BASE + path, options);

    let data = null;

    const text = await response.text();

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (response.status === 401) {
      this.clearToken();

      if (
        !window.location.pathname.endsWith("index.html") &&
        window.location.pathname !== "/"
      ) {
        window.location.href = "index.html";
      }

      throw new Error("Session expired. Please log in again.");
    }

    if (!response.ok) {
      const detail =
        data && data.detail
          ? typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail)
          : response.statusText;

      throw new Error(detail);
    }

    return data;
  },

  get(path) {
    return this.request("GET", path);
  },

  post(path, body) {
    return this.request("POST", path, body);
  },

  put(path, body) {
    return this.request("PUT", path, body);
  },

  del(path) {
    return this.request("DELETE", path);
  },

  postForm(path, formData) {
    return this.request("POST", path, formData, true);
  },
};