// BLE UUIDs for SimpleProfile
// Service: 0xFFE0, Char2 (numPx): 0xFFE2, Char3 (sensor data): 0xFFE3
const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHAR_NUMPX_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb';
const CHAR_DATA_UUID = '0000ffe3-0000-1000-8000-00805f9b34fb';

let device = null;
let server = null;
let service = null;
let charNumPx = null;
let charData = null;
let numPx = 0;
let pollTimer = null;
let dataLog = [];
let csvHeader = [];
let tsBuffer = []; // array of { t: Date, values: number[] }
let tsMaxSamples = 300;
let heatMin = null;
let heatMax = null;

const el = {
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnDownloadCSV: document.getElementById('btnDownloadCSV'),
  btnClearLog: document.getElementById('btnClearLog'),
  pollInterval: document.getElementById('pollInterval'),
  status: document.getElementById('status'),
  devName: document.getElementById('devName'),
  numPx: document.getElementById('numPx'),
  grid: document.getElementById('grid'),
  sensorMulti: document.getElementById('sensorMulti'),
  tsCanvas: document.getElementById('timeseriesCanvas'),
  tsWindow: document.getElementById('tsWindow'),
};

let tsCtx = null;
function ensureTsCtx() {
  if (!tsCtx && el.tsCanvas) {
    tsCtx = el.tsCanvas.getContext('2d');
  }
}

function setStatus(msg) {
  el.status.textContent = msg;
}

function logError(err) {
  console.error(err);
  setStatus(`Error: ${err?.message || err}`);
}

function bestGrid(num) {
  // Try square-like grid
  let cols = Math.floor(Math.sqrt(num));
  while (cols > 1 && num % cols !== 0) cols--;
  if (cols <= 1) cols = Math.ceil(Math.sqrt(num));
  const rows = Math.ceil(num / cols);
  return { rows, cols };
}

function setupGrid(n) {
  el.grid.innerHTML = '';
  const { cols } = bestGrid(n);
  el.grid.style.setProperty('--cols', cols);
  // Mirror the grid columns for the timeseries checkbox list
  el.sensorMulti.style.setProperty('--multi-cols', cols);
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = '-';
    el.grid.appendChild(cell);
  }
  // Sensor multi-select
  el.sensorMulti.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const label = document.createElement('label');
    label.className = 'sensor-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(i);
    input.checked = i === 0; // default select first sensor
    input.addEventListener('change', drawTimeseries);
    label.appendChild(input);
    label.appendChild(document.createTextNode(`S${i}`));
    el.sensorMulti.appendChild(label);
  }
  // CSV header
  csvHeader = ['timestamp'];
  for (let i = 0; i < n; i++) csvHeader.push(`sensor_${i}`);
}

function renderValues(values) {
  if (!values || !values.length) return;
  const n = Math.min(values.length, numPx);
  // Update global color scale across all samples
  const sampleMin = Math.min(...values.slice(0, n));
  const sampleMax = Math.max(...values.slice(0, n));
  if (heatMin === null) heatMin = sampleMin; else heatMin = Math.min(heatMin, sampleMin);
  if (heatMax === null) heatMax = sampleMax; else heatMax = Math.max(heatMax, sampleMax);
  const cells = el.grid.querySelectorAll('.cell');
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let t = 0.5;
    if (heatMax !== null && heatMin !== null && heatMax !== heatMin) {
      t = (v - heatMin) / (heatMax - heatMin);
    }
    if (!isFinite(t)) t = 0.5;
    t = Math.max(0, Math.min(1, t));
    // Monochrome tone: HKUST blue hue, vary lightness
    const baseHue = 210; // blue tone
    const light = Math.max(20, Math.min(85, 20 + 65 * t));
    const bg = `hsl(${baseHue}, 70%, ${light}%)`;
    const cell = cells[i];
    if (cell) {
      cell.style.background = bg;
      cell.textContent = String(v);
      // Dynamic text color: darker text on bright cells, light text on dark cells
      cell.style.color = light >= 60 ? '#0b0b0b' : '#e5e7eb';
    }
  }
}

async function connect() {
  try {
    setStatus('Requesting device…');
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    device.addEventListener('gattserverdisconnected', onDisconnected);
    el.devName.textContent = device.name || '(unknown)';
    setStatus('Connecting…');
    server = await device.gatt.connect();
    service = await server.getPrimaryService(SERVICE_UUID);
    charNumPx = await service.getCharacteristic(CHAR_NUMPX_UUID);
    const numPxView = await charNumPx.readValue();
    numPx = numPxView.getUint8(0);
    el.numPx.textContent = String(numPx);
    setupGrid(numPx);
    charData = await service.getCharacteristic(CHAR_DATA_UUID);
    setStatus('Connected. Ready to poll.');
    el.btnDisconnect.disabled = false;
    el.btnStart.disabled = false;
    el.btnConnect.disabled = true;
    el.btnDownloadCSV.disabled = false;
    el.btnClearLog.disabled = false;
  } catch (err) {
    logError(err);
  }
}

async function disconnect() {
  try {
    stopPolling();
    if (device && device.gatt.connected) {
      device.gatt.disconnect();
    }
    setStatus('Disconnected');
  } catch (err) {
    logError(err);
  } finally {
    el.btnDisconnect.disabled = true;
    el.btnStart.disabled = true;
    el.btnStop.disabled = true;
    el.btnConnect.disabled = false;
    el.btnDownloadCSV.disabled = true;
    el.btnClearLog.disabled = true;
  }
}

function onDisconnected() {
  setStatus('Device disconnected');
  el.btnDisconnect.disabled = true;
  el.btnStart.disabled = true;
  el.btnStop.disabled = true;
  el.btnConnect.disabled = false;
}

async function readOnce() {
  if (!charData) return;
  try {
    const view = await charData.readValue();
    const bytes = new DataView(view.buffer);
    const count = Math.min(numPx, Math.floor(bytes.byteLength / 2));
    const values = new Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = bytes.getUint16(i * 2, false); // big-endian
    }
    renderValues(values);
    appendLog(values);
    updateTimeseries(values);
    setStatus(`Last update: ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    logError(err);
    stopPolling();
  }
}

function startPolling() {
  if (!charData) {
    setStatus('Not connected');
    return;
  }
  const interval = Math.max(100, Number(el.pollInterval.value) || 1000);
  if (pollTimer) clearInterval(pollTimer);
  readOnce();
  pollTimer = setInterval(readOnce, interval);
  el.btnStart.disabled = true;
  el.btnStop.disabled = false;
  setStatus(`Polling every ${interval} ms…`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
  setStatus('Polling stopped');
  }
}

function appendLog(values) {
  const ts = new Date().toISOString();
  const row = [ts, ...values.map(v => String(v))];
  dataLog.push(row);
}

function toCSV() {
  const lines = [];
  lines.push(csvHeader.join(','));
  for (const row of dataLog) {
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

// Format Date to "YYYYMMDD_hhmm" in local time
function formatYmdHm(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  return `${year}${month}${day}_${hour}${minute}`;
}

function downloadCSV() {
  try {
    const csv = toCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const sanitizeForFilename = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const dev = sanitizeForFilename(el.devName.textContent || 'device');
    // Web Bluetooth does not expose MAC addresses; use device.id as identifier if available
    const bleId = sanitizeForFilename(device?.id || 'id-unknown');
    a.href = url;
    // Determine start & end timestamps from the log
    let startStr = 'unknown';
    let endStr = 'unknown';
    if (dataLog.length > 0) {
      const start = new Date(dataLog[0][0]);
      const end = new Date(dataLog[dataLog.length - 1][0]);
      if (!isNaN(start)) startStr = formatYmdHm(start);
      if (!isNaN(end)) endStr = formatYmdHm(end);
    } else {
      const now = new Date();
      startStr = formatYmdHm(now);
      endStr = startStr;
    }
    a.download = `${dev}_${bleId}_sensor_log_${startStr}-${endStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    logError(err);
  }
}

function clearLog() {
  dataLog = [];
  setStatus('Log cleared');
}

function resizeTimeseriesCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = el.tsCanvas.getBoundingClientRect();
  el.tsCanvas.width = Math.round(rect.width * dpr);
  el.tsCanvas.height = Math.round(rect.height * dpr);
}

function updateTimeseries(values) {
  const t = new Date();
  // Store a shallow copy to preserve the snapshot
  tsBuffer.push({ t, values: values.slice() });
  if (tsBuffer.length > tsMaxSamples) tsBuffer.shift();
  drawTimeseries();
}

function drawTimeseries() {
  ensureTsCtx();
  if (!tsCtx) return;
  resizeTimeseriesCanvas();
  const ctx = tsCtx;
  const dpr = window.devicePixelRatio || 1;
  // Clear using identity transform to cover full device-pixel canvas
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.tsCanvas.width, el.tsCanvas.height);
  ctx.restore();
  // Draw in CSS pixel coordinates by scaling with DPR
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rect = el.tsCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  ctx.save();
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  // Axes
  ctx.beginPath();
  ctx.moveTo(40, 10);
  ctx.lineTo(40, h - 20);
  ctx.lineTo(w - 10, h - 20);
  ctx.stroke();
  // Plot area
  const pxL = 42, pxR = w - 12, pxT = 12, pxB = h - 22;
  const plotW = pxR - pxL;
  const plotH = pxB - pxT;
  const n = tsBuffer.length;
  if (n === 0) { ctx.restore(); return; }
  const selected = getSelectedSensors();
  const sensorsToPlot = selected.length ? selected : [0];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const vals = tsBuffer[k].values;
    for (const i of sensorsToPlot) {
      const v = vals[i];
      if (v !== undefined) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1; }
  if (yMax === yMin) yMax = yMin + 1;

  // Draw selected sensors lines
  for (const i of sensorsToPlot) {
    const hue = (i / Math.max(1, numPx)) * 300;
    ctx.strokeStyle = `hsl(${hue}, 80%, 60%)`;
    ctx.lineWidth = sensorsToPlot.length > 1 ? 2.5 : 3.5;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x = pxL + (k / Math.max(1, n - 1)) * plotW;
      const v = tsBuffer[k].values[i];
      const tt = v === undefined ? 0 : (v - yMin) / (yMax - yMin);
      const y = pxB - tt * plotH;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Labels
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '12px system-ui';
  ctx.fillText(`y: ${yMin.toFixed(0)} - ${yMax.toFixed(0)}`, pxL + 6, pxT + 14);
  ctx.restore();
}

// Wire UI
document.addEventListener('DOMContentLoaded', () => {
  // Re-grab elements in case the script executed before DOM ready
  el.btnConnect = document.getElementById('btnConnect');
  el.btnDisconnect = document.getElementById('btnDisconnect');
  el.btnStart = document.getElementById('btnStart');
  el.btnStop = document.getElementById('btnStop');
  el.btnDownloadCSV = document.getElementById('btnDownloadCSV');
  el.btnClearLog = document.getElementById('btnClearLog');
  el.sensorMulti = document.getElementById('sensorMulti');
  el.tsCanvas = document.getElementById('timeseriesCanvas');
  el.tsWindow = document.getElementById('tsWindow');
  // Auto-update footer year
  const footerYear = document.getElementById('footerYear');
  if (footerYear) footerYear.textContent = String(new Date().getFullYear());
  ensureTsCtx();
  if (el.btnConnect) el.btnConnect.addEventListener('click', () => {
    if (!navigator.bluetooth) {
      setStatus('Web Bluetooth not supported in this browser');
      return;
      }
    connect();
  });
  if (el.btnDisconnect) el.btnDisconnect.addEventListener('click', disconnect);
  if (el.btnStart) el.btnStart.addEventListener('click', startPolling);
  if (el.btnStop) el.btnStop.addEventListener('click', stopPolling);
  if (el.btnDownloadCSV) el.btnDownloadCSV.addEventListener('click', downloadCSV);
  if (el.btnClearLog) el.btnClearLog.addEventListener('click', clearLog);
  window.addEventListener('resize', drawTimeseries);
  if (el.tsWindow) {
    el.tsWindow.value = String(tsMaxSamples);
    el.tsWindow.addEventListener('change', onWindowSizeChange);
  }
});

function getSelectedSensors() {
  const inputs = el.sensorMulti.querySelectorAll('input[type="checkbox"]');
  const selected = [];
  inputs.forEach((input) => {
    if (input.checked) selected.push(Number(input.value));
  });
  return selected;
}

// Window size control
function onWindowSizeChange() {
  let val = Number(el.tsWindow.value);
  if (!Number.isFinite(val)) return;
  val = Math.max(10, Math.min(5000, Math.floor(val)));
  el.tsWindow.value = String(val);
  tsMaxSamples = val;
  while (tsBuffer.length > tsMaxSamples) tsBuffer.shift();
  drawTimeseries();
}

// Initialize immediately in case DOM is already ready
if (document.readyState !== 'loading') {
  const evt = new Event('DOMContentLoaded');
  document.dispatchEvent(evt);
}