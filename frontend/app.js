const API = "http://localhost:3000/api";
const state = {
  collections: [],
  readPage: 1
};
let leafletMap = null;
let geoMarkers = [];

function toast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const icons = {
    success: "fa-check-circle",
    error: "fa-exclamation-circle",
    warning: "fa-exclamation-triangle",
    info: "fa-info-circle"
  };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(40px)";
    el.style.transition = "all 0.3s";
  }, 3200);
  setTimeout(() => el.remove(), 3600);
}

function parseJsonSafe(value, fallback = {}) {
  if (!value || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON input");
  }
}

function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getSelectedCollection(id) {
  return document.getElementById(id).value;
}

function validateMongoConnectionString(connectionString) {
  const trimmed = (connectionString || "").trim();
  if (!trimmed) {
    return "Please enter a connection string.";
  }
  if (!/^mongodb(\+srv)?:\/\/.+/i.test(trimmed)) {
    return "Invalid format. Use mongodb:// (local/Compass) or mongodb+srv:// (Atlas), same as MongoDB Compass.";
  }
  return "";
}

async function api(method, path, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch (_err) {
    throw new Error("Failed to connect to backend. Ensure server is running.");
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${res.status})`);
  }
  return payload.data;
}

function showSection(section) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.section === section);
  });
  document.querySelectorAll(".content-section").forEach((item) => {
    item.classList.toggle("active", item.id === `sec-${section}`);
  });
}

function showCrudTab(tab) {
  document.querySelectorAll(".sub-tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.crudTab === tab);
  });
  document.querySelectorAll(".crud-panel").forEach((item) => {
    item.classList.toggle("active", item.id === `crud-${tab}`);
  });
}

function renderTable(targetId, rows) {
  const holder = document.getElementById(targetId);
  if (!rows || rows.length === 0) {
    holder.innerHTML = `<div class="empty-state"><i class="fas fa-inbox"></i><p>No data found</p></div>`;
    return;
  }

  const keys = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  const head = keys.map((key) => `<th>${key}</th>`).join("");
  const body = rows
    .map((row) => {
      const cols = keys
        .map((key) => {
          const val = row[key];
          if (key === "_id") {
            return `<td class="cell-id" title="Click to copy">${formatValue(val)}</td>`;
          }
          return `<td>${formatValue(val)}</td>`;
        })
        .join("");
      return `<tr>${cols}</tr>`;
    })
    .join("");

  holder.innerHTML = `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  holder.querySelectorAll(".cell-id").forEach((cell) => {
    cell.addEventListener("click", () => navigator.clipboard.writeText(cell.textContent || ""));
  });
}

function fillCollectionSelects() {
  const selectIds = [
    "crudCollection",
    "aggCollection",
    "geoCollection",
    "optCollection",
    "txCollection",
    "concCollection"
  ];
  const options =
    state.collections.length > 0
      ? state.collections.map((name) => `<option value="${name}">${name}</option>`).join("")
      : `<option value="">No collections</option>`;
  selectIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = options;
  });
}

async function connectDB() {
  const input = document.getElementById("connStr");
  const dbInput = document.getElementById("dbName");
  const errEl = document.getElementById("connError");
  const btn = document.getElementById("connectBtn");
  const connectionString = input.value.trim();
  const dbName = (dbInput && dbInput.value ? dbInput.value : "").trim();
  const validationError = validateMongoConnectionString(connectionString);
  if (validationError) {
    errEl.textContent = validationError;
    return;
  }

  errEl.textContent = "";
  btn.disabled = true;
  btn.innerHTML = "Connecting...";

  try {
    const data = await api("POST", "/connect", { connectionString, dbName });
    document.getElementById("connectionModal").style.display = "none";
    document.getElementById("app").classList.remove("hidden");
    document.getElementById("dbLabel").textContent = data.database;
    document.querySelector(".status-dot").classList.add("connected");
    await loadCollections();
    await loadDashboard();
    toast(`Connected to ${data.database}`);
    if (!dbName && Array.isArray(data.availableDatabases) && data.availableDatabases.length > 1) {
      toast(
        `Multiple databases found (${data.availableDatabases.join(", ")}). Enter Database Name to open the exact dataset.`,
        "warning"
      );
    }
  } catch (err) {
    errEl.textContent = err.message;
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-plug"></i> Connect to Database`;
  }
}

async function disconnectDB() {
  try {
    await api("POST", "/disconnect");
  } catch (_err) {
    // best effort disconnect
  }
  document.getElementById("connectionModal").style.display = "flex";
  document.getElementById("app").classList.add("hidden");
  document.getElementById("dbLabel").textContent = "Not connected";
  document.querySelector(".status-dot").classList.remove("connected");
}

async function loadCollections() {
  const names = await api("GET", "/collections");
  state.collections = names;
  fillCollectionSelects();
}

async function loadDashboard() {
  const data = await api("GET", "/dashboard");
  document.getElementById("dashStats").innerHTML = `
    <div class="stat-card"><div class="stat-icon green"><i class="fas fa-database"></i></div><div class="stat-value">${data.collectionsCount}</div><div class="stat-label">Collections</div></div>
    <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-file-lines"></i></div><div class="stat-value">${data.totalDocuments}</div><div class="stat-label">Documents</div></div>
    <div class="stat-card"><div class="stat-icon amber"><i class="fas fa-circle-nodes"></i></div><div class="stat-value">${data.database}</div><div class="stat-label">Database</div></div>
  `;
  renderTable("dashTable", data.overview);
}

async function crudCreate() {
  try {
    const collection = getSelectedCollection("crudCollection");
    const document = parseJsonSafe(document.getElementById("createJson").value);
    const result = await api("POST", "/crud/create", { collection, document });
    toast(`Inserted: ${result.insertedId}`);
    await loadDashboard();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function crudRead(page = 1) {
  try {
    state.readPage = page;
    const collection = getSelectedCollection("crudCollection");
    const filter = parseJsonSafe(document.getElementById("readFilter").value, {});
    const sort = parseJsonSafe(document.getElementById("readSort").value, {});
    const limit = Number(document.getElementById("readLimit").value) || 25;
    const data = await api("POST", "/crud/read", { collection, filter, sort, limit, page });
    document.getElementById("readCount").textContent = `${data.total} total`;
    renderTable("readTable", data.items);

    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    const pager = document.getElementById("readPagination");
    pager.innerHTML = "";
    for (let i = 1; i <= pages && i <= 10; i += 1) {
      const btn = document.createElement("button");
      btn.textContent = String(i);
      btn.classList.toggle("active", i === page);
      btn.onclick = () => crudRead(i);
      pager.appendChild(btn);
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

async function crudUpdate() {
  try {
    const collection = getSelectedCollection("crudCollection");
    const id = document.getElementById("updateId").value.trim();
    const update = parseJsonSafe(document.getElementById("updateJson").value);
    const result = await api("PUT", "/crud/update", { collection, id, update });
    toast(`Matched ${result.matchedCount}, modified ${result.modifiedCount}`, "info");
    await crudRead(state.readPage);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function crudDelete() {
  try {
    const collection = getSelectedCollection("crudCollection");
    const id = document.getElementById("deleteId").value.trim();
    const result = await api("DELETE", "/crud/delete", { collection, id });
    toast(`Deleted ${result.deletedCount} document(s)`, "warning");
    await crudRead(state.readPage);
  } catch (err) {
    toast(err.message, "error");
  }
}

function aggPreset(type) {
  let pipeline = [];
  if (type === "countByField") {
    const field = prompt("Field name to group by:", "country") || "country";
    pipeline = [{ $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 } }];
  } else if (type === "avgValue") {
    const field = prompt("Numeric field name:", "depth") || "depth";
    pipeline = [
      { $group: { _id: null, avg: { $avg: `$${field}` }, min: { $min: `$${field}` }, max: { $max: `$${field}` } } }
    ];
  } else if (type === "groupByYear") {
    pipeline = [{ $group: { _id: "$year", count: { $sum: 1 } } }, { $sort: { _id: 1 } }];
  } else if (type === "topN") {
    pipeline = [{ $sort: { year: -1 } }, { $limit: 10 }];
  }
  document.getElementById("aggPipeline").value = JSON.stringify(pipeline, null, 2);
}

async function runAggregation() {
  try {
    const collection = getSelectedCollection("aggCollection");
    const pipeline = parseJsonSafe(document.getElementById("aggPipeline").value, []);
    const data = await api("POST", "/aggregate", { collection, pipeline });
    renderTable("aggTable", data.items);
  } catch (err) {
    toast(err.message, "error");
  }
}

function getCoordinatesFromDoc(doc, fieldName) {
  const location = doc[fieldName];
  if (location && Array.isArray(location.coordinates) && location.coordinates.length >= 2) {
    return [Number(location.coordinates[1]), Number(location.coordinates[0])];
  }
  return null;
}

function ensureMap() {
  if (!leafletMap) {
    leafletMap = L.map("mapContainer").setView([27.1751, -80.1234], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(leafletMap);
  }
}

async function geoQuery(mode) {
  try {
    const collection = getSelectedCollection("geoCollection");
    const field = document.getElementById("geoField").value.trim() || "location";
    const lat = Number(document.getElementById("geoLat").value);
    const lng = Number(document.getElementById("geoLng").value);
    const radiusKm = Number(document.getElementById("geoRadius").value);
    const data = await api("POST", "/geospatial", { collection, field, lat, lng, radiusKm, mode });
    renderTable("geoTable", data.items);
    document.getElementById("geoResultCount").textContent = `(${data.items.length})`;

    ensureMap();
    geoMarkers.forEach((marker) => marker.remove());
    geoMarkers = [];
    leafletMap.setView([lat, lng], 5);
    const centerMarker = L.marker([lat, lng]).addTo(leafletMap).bindPopup("Query Center");
    geoMarkers.push(centerMarker);

    data.items.forEach((item) => {
      const coords = getCoordinatesFromDoc(item, field);
      if (!coords) return;
      const marker = L.marker(coords).addTo(leafletMap).bindPopup(formatValue(item._id));
      geoMarkers.push(marker);
    });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function createIndex() {
  try {
    const collection = getSelectedCollection("optCollection");
    const field = document.getElementById("indexField").value.trim();
    const type = document.getElementById("indexType").value;
    const data = await api("POST", "/index/create", { collection, field, type });
    toast(`Index created: ${data.indexName}`);
    await listIndexes();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function listIndexes() {
  try {
    const collection = getSelectedCollection("optCollection");
    const data = await api("GET", `/index/list?collection=${encodeURIComponent(collection)}`);
    renderTable("indexTable", data.indexes);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function runExplain() {
  try {
    const collection = getSelectedCollection("optCollection");
    const filter = parseJsonSafe(document.getElementById("explainFilter").value, {});
    const sort = parseJsonSafe(document.getElementById("explainSort").value, {});
    const data = await api("POST", "/explain", { collection, filter, sort });
    document.getElementById("explainResults").innerHTML = `
      <div class="explain-stat"><span class="label">Returned</span><span class="value">${data.nReturned ?? 0}</span></div>
      <div class="explain-stat"><span class="label">Docs Examined</span><span class="value">${data.totalDocsExamined ?? 0}</span></div>
      <div class="explain-stat"><span class="label">Keys Examined</span><span class="value">${data.totalKeysExamined ?? 0}</span></div>
      <div class="explain-stat"><span class="label">Execution (ms)</span><span class="value">${data.executionTimeMillis ?? 0}</span></div>
      <div class="explain-plan">${formatValue(data.winningPlan)}</div>
    `;
  } catch (err) {
    toast(err.message, "error");
  }
}

function appendLog(targetId, text, cssClass = "log-info") {
  const log = document.getElementById(targetId);
  log.innerHTML += `<div class="${cssClass}">${text}</div>`;
  log.scrollTop = log.scrollHeight;
}

async function runTransaction(mode) {
  const logId = "txLog";
  document.getElementById(logId).innerHTML = "";
  try {
    const collection = getSelectedCollection("txCollection");
    const doc1 = parseJsonSafe(document.getElementById("txDoc1").value);
    const doc2 = parseJsonSafe(document.getElementById("txDoc2").value);
    appendLog(logId, "Starting transaction...", "log-info");
    const data = await api("POST", "/advanced/transaction", { collection, doc1, doc2, mode });
    appendLog(logId, `Result: ${JSON.stringify(data)}`, "log-success");
  } catch (err) {
    appendLog(logId, err.message, "log-error");
  }
}

async function runConcurrent() {
  const logId = "concLog";
  document.getElementById(logId).innerHTML = "";
  try {
    const collection = getSelectedCollection("concCollection");
    const id = document.getElementById("concId").value.trim();
    const field = document.getElementById("concField").value.trim();
    const count = Number(document.getElementById("concCount").value) || 10;
    appendLog(logId, `Running ${count} concurrent increments...`, "log-info");
    const data = await api("POST", "/advanced/concurrent", { collection, id, field, count });
    appendLog(logId, `Completed ${data.operations} operations`, "log-success");
    appendLog(logId, `Updated document: ${JSON.stringify(data.updated)}`, "log-info");
  } catch (err) {
    appendLog(logId, err.message, "log-error");
  }
}

document.getElementById("connectBtn").addEventListener("click", connectDB);
document.getElementById("disconnectBtn").addEventListener("click", disconnectDB);
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    showSection(item.dataset.section);
  });
});
document.querySelectorAll(".sub-tab").forEach((item) => {
  item.addEventListener("click", () => showCrudTab(item.dataset.crudTab));
});