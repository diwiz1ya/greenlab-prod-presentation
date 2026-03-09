import { state } from "./state.js";

export async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function downloadScanExport(format, orderId = null) {
  const params = new URLSearchParams({ format });
  if (orderId) {
    params.set("orderId", String(orderId));
  }

  const response = await fetch(`/api/export/scans?${params.toString()}`, {
    headers: {
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
    }
  });

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    throw new Error(payload.error || `Ошибка экспорта (${response.status})`);
  }

  let blob;
  let extension;

  if (format === "json") {
    const data = await response.json();
    blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    extension = "json";
  } else {
    const text = await response.text();
    blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    extension = "csv";
  }

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const scope = orderId ? `order-${orderId}` : "all";
  const fileName = `scan-log-${scope}-${stamp}.${extension}`;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
