import { api } from "../api.js";
import { app, applyRoleDefaults, state } from "../state.js";
import { escapeHtml } from "../utils.js";

export function renderLogin(renderApp, error) {
  app.innerHTML = `
    <section class="shell">
      <div class="hero login-grid">
        <div class="stack">
          <div>
            <div class="eyebrow">Green Lab / Демо MVP</div>
            <h1>QR-поток прачечной для демонстрации.</h1>
            <p class="lead">
              Эта версия специально сфокусирована: локальный вход, доступ по станциям,
              сортировка, сканирование этапов, выдача, детали заказа, SQLite,
              и заглушка синхронизации.
            </p>
          </div>
          <div class="badge-row">
            <div class="badge"><strong>7</strong><span class="muted">Демо-роли</span></div>
            <div class="badge"><strong>7</strong><span class="muted">Станции</span></div>
            <div class="badge"><strong>1</strong><span class="muted">Локальная SQLite БД</span></div>
          </div>
        </div>
        <div class="panel stack">
          <div>
            <div class="eyebrow">Вход</div>
            <h2>Вход в систему</h2>
          </div>
          ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}
          <label>
            Логин
            <input id="login-username" placeholder="sorting" value="sorting" />
          </label>
          <label>
            Пароль
            <input id="login-password" type="password" placeholder="demo123" value="demo123" />
          </label>
          <button id="login-submit">Войти</button>
        </div>
      </div>

      <section class="panel">
        <div class="eyebrow">Демо-учётки</div>
        <div class="demo-credentials">
          ${[
            ["sorting", "Оператор сортировки", "Сортировка + обзор"],
            ["washing", "Оператор стирки", "Стирка + обзор"],
            ["qc", "Оператор контроля качества", "QC + обзор"],
            ["drying", "Оператор сушки", "Сушка + обзор"],
            ["ironing", "Оператор глажки", "Глажка + обзор"],
            ["pickup", "Оператор выдачи", "Выдача + обзор"],
            ["manager", "Менеджер филиала", "Все экраны"]
          ]
            .map(
              ([username, role, access]) => `
                <div class="credential-row">
                  <strong>${username}</strong> / <code>demo123</code><br />
                  <span class="muted">${role} · ${access}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
    </section>
  `;

  async function submitLogin() {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;

    try {
      const payload = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      state.token = payload.token;
      localStorage.setItem("greenlab-demo-token", payload.token);
      state.user = payload.user;
      state.screen = "station-picker";
      state.currentStation = null;
      state.deniedStation = null;
      applyRoleDefaults();
      await renderApp();
    } catch (submitError) {
      renderLogin(renderApp, submitError.message);
    }
  }

  document.getElementById("login-submit").addEventListener("click", submitLogin);
  document.getElementById("login-password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitLogin();
  });
}
