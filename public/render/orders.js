import { escapeHtml } from "../utils.js";

export function renderOverview(orders) {
  return `
    <section class="panel stack">
      <div class="header-row">
        <div>
          <div class="eyebrow">Обзор</div>
          <h2>Список заказов филиала</h2>
        </div>
      </div>
      <div class="order-grid">
        ${orders.map(renderOrderCard).join("")}
      </div>
    </section>
  `;
}

export function renderSorting(orders) {
  return `
    <section class="panel stack">
      <div class="header-row">
        <div>
          <div class="eyebrow">Сортировка</div>
          <h2>Создание корзин и печать QR</h2>
        </div>
      </div>
      <div class="order-grid">
        ${
          orders.length
            ? orders
                .map(
                  (order) => `
                    <article class="card">
                      ${renderOrderMeta(order)}
                      <p class="muted">Базовый набор корзин: Белое, Цветное, Ручная стирка.</p>
                      <div class="action-row">
                        <button data-create-baskets="${order.id}">Создать корзины + печать QR</button>
                        <button class="secondary" data-open-order="${order.id}">Детали заказа</button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : '<div class="card"><span class="muted">Нет заказов на сортировке.</span></div>'
        }
      </div>
    </section>
  `;
}

export function renderPickup(orders) {
  return `
    <section class="panel stack">
      <div class="two-up">
        <div class="stack">
          <div>
            <div class="eyebrow">Выдача</div>
            <h2>Проверка корзины и завершение выдачи</h2>
            <p class="muted">
              Экран выдачи специально минимальный: скан, проверка готовности, завершение заказа.
            </p>
          </div>
          <label>
            QR-код корзины
            <input id="pickup-scan-input" data-scan-input-for="pickup" placeholder="QR:B-2403-1" />
          </label>
          <div class="action-row">
            <button data-run-scan="pickup" data-scan-input-id="pickup-scan-input">Проверить корзину</button>
          </div>
        </div>
        <div class="qr-preview">
          <div class="eyebrow">Пример для выдачи</div>
          <strong>Используйте</strong>
          <div><code>QR:B-2404-1</code></div>
          <p>Затем откройте карточку заказа ниже и завершите выдачу.</p>
        </div>
      </div>
      <div class="order-grid">
        ${
          orders.length
            ? orders
                .map(
                  (order) => `
                    <article class="card">
                      ${renderOrderMeta(order)}
                      <div class="action-row">
                        <button data-open-order="${order.id}">Открыть детали</button>
                        <button data-complete-pickup="${order.id}" ${order.ready_for_pickup ? "" : "disabled"}>
                          Завершить выдачу
                        </button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : '<div class="card"><span class="muted">Нет заказов, готовых к выдаче.</span></div>'
        }
      </div>
    </section>
  `;
}

export function renderOrderDetails(order) {
  if (!order) {
    return `
      <section class="panel">
        <div class="eyebrow">Детали заказа</div>
        <h2>Заказ не выбран</h2>
        <p class="muted">Откройте карточку заказа, чтобы увидеть корзины, сканы и текущий статус.</p>
      </section>
    `;
  }

  return `
    <section class="panel stack">
      <div class="header-row">
        <div>
          <div class="eyebrow">Детали заказа</div>
          <h2>${escapeHtml(order.public_id)} · ${escapeHtml(order.customer_name)}</h2>
        </div>
        <div class="meta">
          <span class="pill ok">${escapeHtml(order.status)}</span>
          <span class="pill">${escapeHtml(order.cleancloud_status)}</span>
        </div>
      </div>
      <div class="two-up">
        <div class="stack">
          <div class="basket-grid">
            ${
              order.baskets.length
                ? order.baskets
                    .map(
                      (basket) => `
                        <div class="basket-row">
                          <strong>${escapeHtml(basket.basket_code)} · ${escapeHtml(basket.basket_type)}</strong>
                          <span class="muted">${escapeHtml(basket.station)} · ${escapeHtml(basket.qr_code)}</span>
                        </div>
                      `
                    )
                    .join("")
                : '<div class="basket-row"><span class="muted">Корзины появятся после сортировки.</span></div>'
            }
          </div>
        </div>
        <div class="scan-log">
          ${
            order.scans.length
              ? order.scans
                  .map(
                    (scan) => `
                      <div class="log-item">
                        <strong>${escapeHtml(scan.station)}</strong>
                        <div class="muted">${escapeHtml(scan.actor)} · ${new Date(scan.created_at).toLocaleString()}</div>
                        <div class="pill ${scan.result === "ok" ? "ok" : "error"}">${escapeHtml(scan.result)}</div>
                        <div>${escapeHtml(scan.message)}</div>
                      </div>
                    `
                  )
                  .join("")
              : '<div class="log-item"><span class="muted">Событий сканирования пока нет.</span></div>'
          }
        </div>
      </div>
    </section>
  `;
}

export function renderSyncQueue(syncQueue) {
  const summary = syncQueue.summary || {};
  return `
    <section class="panel stack">
      <div class="header-row">
        <div>
          <div class="eyebrow">CleanCloud sync</div>
          <h2>Очередь синхронизации</h2>
        </div>
        <button class="secondary" data-run-sync-now>Запустить sync сейчас</button>
      </div>
      <div class="kiosk-meta">
        <span class="pill">pending: ${summary.pending || 0}</span>
        <span class="pill">processing: ${summary.processing || 0}</span>
        <span class="pill ok">processed: ${summary.processed || 0}</span>
        <span class="pill ${summary.failed ? "error" : ""}">failed: ${summary.failed || 0}</span>
      </div>
      <div class="scan-log">
        ${
          syncQueue.items.length
            ? syncQueue.items
                .map(
                  (item) => `
                    <div class="log-item">
                      <strong>${escapeHtml(item.action)}</strong>
                      <div class="muted">
                        Заказ ID ${item.order_id} · ${escapeHtml(item.status)} · попытки: ${item.attempts || 0}
                      </div>
                      ${item.last_error ? `<div class="pill error">${escapeHtml(item.last_error)}</div>` : ""}
                      <code>${escapeHtml(item.payload || "")}</code>
                    </div>
                  `
                )
                .join("")
            : '<div class="log-item"><span class="muted">Очередь пуста.</span></div>'
        }
      </div>
    </section>
  `;
}

export function renderOrderCard(order) {
  return `
    <article class="card">
      ${renderOrderMeta(order)}
      <div class="action-row">
        <button data-open-order="${order.id}">Открыть детали</button>
      </div>
    </article>
  `;
}

export function renderOrderMeta(order) {
  return `
    <div class="header-row">
      <div>
        <strong>${escapeHtml(order.public_id)}</strong>
        <div class="muted">${escapeHtml(order.customer_name)}</div>
      </div>
      <div class="meta">
        <span class="pill ${order.ready_for_pickup ? "ok" : "warn"}">${order.ready_for_pickup ? "Готов" : "В работе"}</span>
      </div>
    </div>
    <div class="muted">${escapeHtml(order.service_tier)} · CleanCloud: ${escapeHtml(order.cleancloud_status)}</div>
    <div class="muted">Текущая станция: ${escapeHtml(order.status)}</div>
  `;
}

