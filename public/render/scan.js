import { stationLabels } from "../state.js";
import { escapeHtml } from "../utils.js";
import { renderOrderCard, renderOrderMeta } from "./orders.js";

export function renderScanScreen(station, orders) {
  return `
    <section class="panel stack">
      <div class="two-up">
        <div class="stack">
          <div>
            <div class="eyebrow">Станция сканирования</div>
            <h2>${escapeHtml(stationLabels[station])}</h2>
            <p class="muted">
              Сканируйте QR корзины. Корректный скан переводит корзину на следующий этап.
              Неверный маршрут отклоняется и записывается в лог.
            </p>
          </div>
          <label>
            QR-код корзины
            <input id="scan-input" data-scan-input-for="${station}" placeholder="QR:B-2402-1" />
          </label>
          <div class="action-row">
            <button data-run-scan="${station}" data-scan-input-id="scan-input">Провести скан</button>
          </div>
        </div>
        <div class="qr-preview">
          <div class="eyebrow">Примеры QR</div>
          <strong>Попробуйте эти коды</strong>
          <div><code>QR:B-2402-1</code></div>
          <div><code>QR:B-2402-2</code></div>
          ${station === "drying" ? `<div><code>QR:B-2403-1</code></div>` : ""}
          ${station === "ironing" ? `<div><code>QR:B-2403-1</code></div>` : ""}
          <p>Каждый успешный скан двигает корзину вперёд и приближает выдачу.</p>
        </div>
      </div>
      <div class="order-grid">
        ${
          orders.length
            ? orders.map(renderOrderCard).join("")
            : '<div class="card"><span class="muted">На этой станции нет заказов.</span></div>'
        }
      </div>
    </section>
  `;
}

export function renderSimpleScanMode(station, orders, recentScans) {
  return renderSimpleScanModeWithStatus(station, orders, recentScans, null);
}

function formatScanTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

function renderScanStatus(lastScan) {
  if (!lastScan) {
    return `
      <article class="scan-status idle">
        <div class="eyebrow">Результат скана</div>
        <strong>Ожидание</strong>
        <p class="muted">Сканируйте QR-код, чтобы увидеть результат проверки этапа.</p>
      </article>
    `;
  }

  const statusClass = lastScan.ok ? "ok" : "error";
  const label = lastScan.ok ? "Принято" : "Ошибка";
  return `
    <article class="scan-status ${statusClass}">
      <div class="eyebrow">Результат скана</div>
      <strong>${label}</strong>
      <p>${escapeHtml(lastScan.message || "")}</p>
      <div class="muted">
        ${lastScan.code ? `QR: ${escapeHtml(lastScan.code)} · ` : ""}
        ${formatScanTime(lastScan.createdAt)}
      </div>
    </article>
  `;
}

export function renderSimpleScanModeWithStatus(station, orders, recentScans, lastScan) {
  const stationLabel = stationLabels[station] || station;

  return `
    <section class="panel simple-scan-shell">
      <div class="kiosk-layout">
        <div>
          <div class="eyebrow">Скан-пост</div>
          <h2>${escapeHtml(stationLabel)}</h2>
          <p class="muted">Сканер работает как клавиатура: считайте QR и нажмите Enter.</p>
        </div>
        <div class="scan-kiosk-form">
          <label>
            QR-код корзины
            <input
              class="scan-large"
              id="simple-scan-input"
              data-scan-input-for="${station}"
              placeholder="QR:B-2402-1"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <div class="action-row">
            <button data-run-scan="${station}" data-scan-input-id="simple-scan-input">Проверить скан</button>
          </div>
          <div class="kiosk-meta">
            <span class="pill">${escapeHtml(stationLabel)}</span>
            <span class="pill ${orders.length ? "ok" : "warn"}">В работе: ${orders.length}</span>
          </div>
        </div>
        ${renderScanStatus(lastScan)}

        ${station === "pickup" ? `
          <div class="simple-pickup-list stack">
            <div class="eyebrow">Готовые к выдаче</div>
            ${orders.length
              ? orders.map((order) => `
                  <article class="card">
                    ${renderOrderMeta(order)}
                    <div class="action-row">
                      <button data-open-order="${order.id}">Открыть детали</button>
                      <button data-complete-pickup="${order.id}" ${order.ready_for_pickup ? "" : "disabled"}>Завершить выдачу</button>
                    </div>
                  </article>
                `).join("")
              : '<div class="card"><span class="muted">Нет заказов для выдачи.</span></div>'}
          </div>
        ` : ""}

        <div class="simple-recent stack">
          <div class="eyebrow">Последние сканы</div>
          ${recentScans.length
            ? recentScans.map((row) => `
                <div class="log-item">
                  <strong>${escapeHtml(row.order_public_id)} ${row.basket_code ? `· ${escapeHtml(row.basket_code)}` : ""}</strong>
                  <div class="muted">${new Date(row.created_at).toLocaleString()}</div>
                  <div class="pill ${row.result === "ok" ? "ok" : "error"}">${escapeHtml(row.result)}</div>
                  <div>${escapeHtml(row.message)}</div>
                </div>
              `).join("")
            : '<div class="log-item"><span class="muted">Сканов пока нет.</span></div>'}
        </div>
      </div>
    </section>
  `;
}
