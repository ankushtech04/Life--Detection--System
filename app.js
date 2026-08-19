'use strict';

/* ── CONSTANTS ── */
const N        = 60;   // rolling window size
const DEMO_INT = 500;  // demo interval ms

/* ── STATE ── */
let mwArr  = Array(N).fill(0);
let pirArr = Array(N).fill(0);
let srvArr = Array(N).fill(0);
let altArr = Array(N).fill(0);

let ws          = null;
let demoOn      = true;
let demoTimer   = null;
let servoAngle  = 0;
let servoDir    = 1;
let detCount    = 0;
let sampleCount = 0;
let startTime   = Date.now();
let csvRows     = [['timestamp','microwave','pir','servo','alert']];
let alertTO     = null;
let radarTrail  = [];

/* ── BOOT SEQUENCE ── */
const bootMessages = [
  'Initialising system...',
  'Loading sensor drivers...',
  'Configuring WebSocket server...',
  'Calibrating radar module...',
  'Starting demo simulation...',
  'MetaMinds is ready.'
];

window.addEventListener('DOMContentLoaded', () => {
  let step = 0;
  const fill   = document.getElementById('bootFill');
  const status = document.getElementById('bootStatus');
  const boot   = document.getElementById('bootScreen');

  const interval = setInterval(() => {
    step++;
    fill.style.width   = (step / bootMessages.length * 100) + '%';
    status.textContent = bootMessages[step] || bootMessages[bootMessages.length - 1];
    if (step >= bootMessages.length) {
      clearInterval(interval);
      setTimeout(() => {
        boot.classList.add('hidden');
        setTimeout(() => boot.remove(), 700);
        initApp();
      }, 400);
    }
  }, 280);
});

/* ── INIT ── */
function initApp() {
  initCharts();
  initRadar();
  startClock();
  startDemo();
  addLog('MetaMinds v2.0 — System online', 'ok');
  addLog('ESP32 DevKit V1 · 32-bit · 4MB Flash · 520KB SRAM', 'info');
  addLog('Demo simulation active — connect real ESP32 below', 'warn');
}

/* ── CLOCK + UPTIME ── */
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toTimeString().slice(0, 8);
    const up = Math.floor((Date.now() - startTime) / 1000);
    document.getElementById('uptimeDisp').textContent =
      up < 60 ? up + 's' : Math.floor(up / 60) + 'm ' + (up % 60) + 's';
  }
  tick();
  setInterval(tick, 1000);
}

/* ═══════════════════════════════════════════════
   CHART.JS SETUP
═══════════════════════════════════════════════ */
let mainChart, mcMW, mcPIR, mcSRV;
const LABS = Array.from({ length: N }, (_, i) => i);

function initCharts() {
  Chart.defaults.color          = '#4A7A9B';
  Chart.defaults.borderColor    = 'rgba(26,63,98,0.5)';
  Chart.defaults.font.family    = "'JetBrains Mono', monospace";
  Chart.defaults.font.size      = 10;

  /* Main telemetry chart */
  const mCtx = document.getElementById('mainChart').getContext('2d');
  mainChart = new Chart(mCtx, {
    type: 'line',
    data: {
      labels: [...LABS],
      datasets: [
        makeDS('Microwave', [...mwArr],  '#00E5FF', 'rgba(0,229,255,0.07)'),
        makeDS('PIR',       [...pirArr], '#00FF88', 'rgba(0,255,136,0.07)'),
        { label:'Servo', data: srvArr.map(v => v / 180), borderColor:'#FFAB00',
          backgroundColor:'transparent', borderWidth:1.5, tension:.45,
          pointRadius:0, fill:false },
        makeDS('Alert', [...altArr], '#FF2D55', 'rgba(255,45,85,0.1)', 0),
      ]
    },
    options: chartOpts(1.15)
  });

  /* Mini charts */
  mcMW  = mkMini('mc-mw',  '#00E5FF', 1);
  mcPIR = mkMini('mc-pir', '#00FF88', 1);
  mcSRV = mkMini('mc-srv', '#FFAB00', 180);

  /* Resize observer */
  const ro = new ResizeObserver(() => {
    [mainChart, mcMW, mcPIR, mcSRV].forEach(c => c && c.resize());
  });
  ro.observe(document.getElementById('main'));
}

function makeDS(label, data, color, bg, tension=0.45) {
  return { label, data, borderColor: color, backgroundColor: bg,
    borderWidth: 1.8, tension, pointRadius: 0, fill: true };
}

function mkMini(id, color, yMax) {
  return new Chart(document.getElementById(id).getContext('2d'), {
    type: 'line',
    data: { labels: [...LABS], datasets: [makeDS('', Array(N).fill(0), color, color.replace(')',',0.12)').replace('rgb(','rgba('))] },
    options: {
      responsive: false, animation: { duration: 0 },
      plugins: { legend:{ display:false }, tooltip:{ enabled:false } },
      scales: { x:{ display:false }, y:{ min:0, max:yMax, display:false } }
    }
  });
}

function chartOpts(yMax) {
  return {
    responsive: false, animation: { duration: 0 },
    interaction: { mode:'index', intersect:false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(6,20,34,0.97)',
        borderColor: 'rgba(26,63,98,0.8)', borderWidth: 1,
        titleFont:{ family:"'Space Grotesk'", size:12, weight:600 },
        bodyFont:{ family:"'JetBrains Mono'", size:11 },
        titleColor:'#00E5FF', bodyColor:'#EDF5FF', padding: 12
      }
    },
    scales: {
      x: { display:false },
      y: { min:0, max:yMax,
        grid: { color:'rgba(26,63,98,0.4)' },
        ticks: { color:'#4A7A9B', font:{ size:9 }, maxTicksLimit:5 }
      }
    }
  };
}

/* ═══════════════════════════════════════════════
   ARC GAUGES
═══════════════════════════════════════════════ */
function drawGauge(id, value, max, color, label) {
  const cv  = document.getElementById(id);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.offsetWidth || 200;
  const H = cv.offsetHeight || 90;
  cv.width  = W;
  cv.height = H;
  const cx = W / 2, cy = H - 12, R = Math.min(cx - 14, H - 18);

  ctx.clearRect(0, 0, W, H);

  /* track */
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, 0);
  ctx.strokeStyle = 'rgba(26,63,98,0.6)';
  ctx.lineWidth = 9; ctx.lineCap = 'round';
  ctx.stroke();

  /* value arc */
  const pct = Math.min(Math.max(value / max, 0), 1);
  if (pct > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.PI, Math.PI + pct * Math.PI);
    ctx.strokeStyle = color;
    ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /* tick marks */
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + i * Math.PI / 10;
    const r0 = R - 13, r1 = R - 7;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.strokeStyle = 'rgba(26,63,98,0.5)';
    ctx.lineWidth = 0.8; ctx.lineCap = 'butt';
    ctx.stroke();
  }

  /* centre dot */
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

/* ═══════════════════════════════════════════════
   RADAR SWEEP
═══════════════════════════════════════════════ */
let radarAnimFrame;
function initRadar() {
  resizeRadar();
  window.addEventListener('resize', resizeRadar);
}
function resizeRadar() {
  const cv  = document.getElementById('radarCv');
  const box = cv.parentElement;
  cv.width  = box.clientWidth;
  cv.height = Math.max(box.clientHeight - 70, 140);
  drawRadar(servoAngle);
}

function drawRadar(angle) {
  const cv  = document.getElementById('radarCv');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const cx = W / 2, cy = H - 8;
  const R  = Math.min(W / 2 - 12, H - 16);

  ctx.clearRect(0, 0, W, H);

  /* bg glow */
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grd.addColorStop(0, 'rgba(0,229,255,0.04)');
  grd.addColorStop(1, 'rgba(0,229,255,0)');
  ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, 0); ctx.closePath();
  ctx.fillStyle = grd; ctx.fill();

  /* rings */
  [1, 2, 3, 4].forEach(i => {
    ctx.beginPath();
    ctx.arc(cx, cy, R * i / 4, Math.PI, 0);
    ctx.strokeStyle = `rgba(26,63,98,${0.25 + i * 0.08})`;
    ctx.lineWidth = 0.8; ctx.stroke();
  });

  /* spokes */
  for (let a = 0; a <= 180; a += 30) {
    const rad = (180 - a) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * R, cy - Math.sin(rad) * R);
    ctx.strokeStyle = 'rgba(26,63,98,0.4)'; ctx.lineWidth = 0.5; ctx.stroke();

    ctx.font = "9px 'JetBrains Mono'"; ctx.fillStyle = 'rgba(74,122,155,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(a + '°', cx + Math.cos(rad) * (R + 12), cy - Math.sin(rad) * (R + 12));
  }

  /* trail */
  radarTrail.push(angle);
  if (radarTrail.length > 28) radarTrail.shift();
  radarTrail.forEach((a, i) => {
    const rad = (180 - a) * Math.PI / 180;
    const alpha = (i / radarTrail.length) * 0.22;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, -(rad + 0.05), -(rad - 0.05));
    ctx.closePath();
    ctx.fillStyle = `rgba(255,171,0,${alpha})`;
    ctx.fill();
  });

  /* sweep line */
  const sweepRad = (180 - angle) * Math.PI / 180;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepRad) * R, cy - Math.sin(sweepRad) * R);
  ctx.strokeStyle = '#FFAB00'; ctx.lineWidth = 2;
  ctx.shadowColor = '#FFAB00'; ctx.shadowBlur = 8;
  ctx.stroke(); ctx.shadowBlur = 0;

  /* tip dot */
  ctx.beginPath();
  ctx.arc(cx + Math.cos(sweepRad) * (R - 4), cy - Math.sin(sweepRad) * (R - 4), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#FFAB00';
  ctx.shadowColor = '#FFAB00'; ctx.shadowBlur = 12;
  ctx.fill(); ctx.shadowBlur = 0;

  /* base line */
  ctx.beginPath();
  ctx.moveTo(cx - R - 4, cy); ctx.lineTo(cx + R + 4, cy);
  ctx.strokeStyle = 'rgba(26,63,98,0.6)'; ctx.lineWidth = 1; ctx.stroke();

  /* centre */
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#00E5FF';
  ctx.shadowColor = '#00E5FF'; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;

  document.getElementById('radarDeg').textContent = Math.round(angle) + '°';
}

/* ═══════════════════════════════════════════════
   INGEST DATA — single source of truth
═══════════════════════════════════════════════ */
function ingest(d) {
  const mw  = parseFloat(d.microwave) || 0;
  const pir = parseFloat(d.pir)  || 0;
  const srv = parseFloat(d.servo) || 0;
  const alt = d.alert ? 1 : 0;

  sampleCount++;
  document.getElementById('samplesDisp').textContent = sampleCount;

  /* rolling arrays */
  mwArr.shift();  mwArr.push(mw);
  pirArr.shift(); pirArr.push(pir);
  srvArr.shift(); srvArr.push(srv);
  altArr.shift(); altArr.push(alt);
  csvRows.push([new Date().toISOString(), mw, pir, srv, alt]);

  /* main chart */
  mainChart.data.datasets[0].data = [...mwArr];
  mainChart.data.datasets[1].data = [...pirArr];
  mainChart.data.datasets[2].data = srvArr.map(v => v / 180);
  mainChart.data.datasets[3].data = [...altArr];
  mainChart.update('none');

  /* mini charts */
  mcMW.data.datasets[0].data  = [...mwArr];  mcMW.update('none');
  mcPIR.data.datasets[0].data = [...pirArr]; mcPIR.update('none');
  mcSRV.data.datasets[0].data = [...srvArr]; mcSRV.update('none');

  /* tiles */
  document.getElementById('tv-mw').textContent  = mw.toFixed(2);
  document.getElementById('tb-mw').style.width  = (mw * 100) + '%';
  document.getElementById('ts-mw').textContent  = mw > 0.5 ? 'MOTION DETECTED · GPIO 13' : 'IDLE · GPIO 13';
  document.getElementById('mm-mw').textContent  = mw.toFixed(2);

  document.getElementById('tv-pir').textContent = pir > 0.5 ? 'HIGH' : 'LOW';
  document.getElementById('tb-pir').style.width = (pir * 100) + '%';
  document.getElementById('ts-pir').textContent = pir > 0.5 ? 'HEAT DETECTED · GPIO 21' : 'NO HEAT · GPIO 21';
  document.getElementById('mm-pir').textContent = pir.toFixed(0);

  document.getElementById('tv-srv').textContent = Math.round(srv) + '°';
  document.getElementById('tb-srv').style.width = (srv / 180 * 100) + '%';
  document.getElementById('mm-srv').textContent = Math.round(srv) + '°';

  /* radar */
  drawRadar(srv);

  /* gauges */
  drawGauge('gaugeMW',   mw,  1,   '#00E5FF');
  drawGauge('gaugePIR',  pir, 1,   '#00FF88');
  const conf = Math.round((mw * 0.5 + pir * 0.5) * 100);
  const confColor = conf > 70 ? '#FF2D55' : conf > 40 ? '#FFAB00' : '#4A7A9B';
  drawGauge('gaugeConf', conf, 100, confColor);

  document.getElementById('gv-mw').textContent   = mw.toFixed(2);
  document.getElementById('gs-mw').textContent   = mw > 0.5 ? 'Active' : 'Idle';
  document.getElementById('gv-pir').textContent  = pir.toFixed(0);
  document.getElementById('gs-pir').textContent  = pir > 0.5 ? 'Triggered' : 'Clear';
  document.getElementById('gv-conf').textContent = conf + '%';
  document.getElementById('gs-conf').textContent = conf > 70 ? 'Life likely' : conf > 40 ? 'Possible' : 'Monitoring';

  /* alert */
  if (alt) {
    detCount++;
    document.getElementById('tv-det').textContent = detCount;
    document.getElementById('tb-det').style.width = Math.min(detCount * 10, 100) + '%';
    document.getElementById('ts-det').textContent = '⚠ LIFE DETECTED';
    document.getElementById('detsDisp').textContent = detCount;
    document.getElementById('tile-det').classList.add('alarmed');
    triggerAlert(`LIFE DETECTED at ${Math.round(srv)}° — MW:${mw.toFixed(2)} PIR:${pir}`);
    addLog(`⚠ LIFE DETECTED @ ${Math.round(srv)}° — MW:${mw.toFixed(2)} PIR:${pir}`, 'crit');
    setTimeout(() => document.getElementById('tile-det').classList.remove('alarmed'), 3000);
  } else {
    document.getElementById('ts-det').textContent = detCount > 0 ? `${detCount} TOTAL` : 'ALL CLEAR';
  }
}

/* ── ALERT BANNER ── */
function triggerAlert(msg) {
  const b = document.getElementById('alertBanner');
  document.getElementById('alertText').textContent = msg;
  b.classList.add('visible');
  clearTimeout(alertTO);
  alertTO = setTimeout(dismissAlert, 5000);
}
function dismissAlert() {
  document.getElementById('alertBanner').classList.remove('visible');
}

/* ═══════════════════════════════════════════════
   LOG
═══════════════════════════════════════════════ */
function addLog(msg, type = 'info') {
  const t  = new Date().toTimeString().slice(0, 8);
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = `<span class="log-t">${t}</span><span class="log-${type}">${msg}</span>`;
  const scroll = document.getElementById('logScroll');
  scroll.prepend(el);
  while (scroll.children.length > 100) scroll.lastChild.remove();
}
function clearLog() {
  document.getElementById('logScroll').innerHTML = '';
  addLog('Log cleared', 'warn');
}

/* ═══════════════════════════════════════════════
   DEMO ENGINE
═══════════════════════════════════════════════ */
function startDemo() {
  demoOn    = true;
  demoTimer = setInterval(runDemo, DEMO_INT);
  setBadge('demo');
}

function runDemo() {
  servoAngle += servoDir * 2;
  if (servoAngle >= 180) { servoAngle = 180; servoDir = -1; }
  if (servoAngle <= 0)   { servoAngle = 0;   servoDir = 1;  }

  const mw  = Math.random() > 0.72 ? 0.65 + Math.random() * 0.35 : Math.random() * 0.25;
  const pir = Math.random() > 0.82 ? 1 : 0;
  ingest({ microwave: mw, pir, servo: servoAngle, alert: mw > 0.6 && pir > 0 });
}

function toggleDemo() {
  const btn = document.getElementById('demoBtn');
  if (demoOn) {
    clearInterval(demoTimer);
    demoOn = false;
    btn.textContent = '▶ Resume Demo';
    addLog('Demo paused', 'warn');
  } else {
    demoTimer = setInterval(runDemo, DEMO_INT);
    demoOn = true;
    btn.textContent = '⏸ Pause Demo';
    addLog('Demo resumed', 'info');
  }
}

/* ═══════════════════════════════════════════════
   WEBSOCKET
═══════════════════════════════════════════════ */
function connectWS() {
  const ip   = document.getElementById('espIp').value.trim();
  const port = document.getElementById('wsPort').value.trim() || '81';
  connectToIP(ip, port);
}

function connectFromModal() {
  const ip   = document.getElementById('modalIp').value.trim();
  const port = document.getElementById('modalPort').value.trim() || '81';
  document.getElementById('modalStatus').textContent = 'Connecting to ws://' + ip + ':' + port + '...';
  connectToIP(ip, port);
}

function connectToIP(ip, port) {
  if (ws) { ws.close(); ws = null; }
  const url = `ws://${ip}:${port}`;
  addLog(`Connecting → ${url}`, 'warn');

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      setBadge('live', ip);
      clearInterval(demoTimer); demoOn = false;
      document.getElementById('demoBtn').textContent = '▶ Start Demo';
      document.getElementById('modalStatus').textContent = '✓ Connected to ' + ip;
      document.getElementById('espIp').value = ip;
      addLog(`Connected · ${ip}:${port}`, 'ok');
    };

    ws.onmessage = e => {
      try { ingest(JSON.parse(e.data)); }
      catch { addLog('Parse error: ' + e.data.slice(0, 40), 'warn'); }
    };

    ws.onclose = () => {
      setBadge('demo');
      addLog('WebSocket disconnected', 'warn');
    };

    ws.onerror = () => {
      setBadge('error');
      addLog('Connection failed — check IP & same WiFi network', 'crit');
      document.getElementById('modalStatus').textContent = '✕ Connection failed';
    };
  } catch (e) {
    addLog('Invalid IP address', 'crit');
  }
}

function setBadge(state, ip = '') {
  const b = document.getElementById('connBadge');
  const l = document.getElementById('connLabel');
  b.className = 'conn-badge ' + state;
  l.textContent = state === 'live'  ? 'Live · ' + ip
                : state === 'error' ? 'Error'
                : 'Demo Mode';
}

/* ── MODAL ── */
function openConnModal() {
  document.getElementById('modalBg').classList.add('open');
  document.getElementById('modalIp').value = document.getElementById('espIp').value;
  document.getElementById('modalPort').value = document.getElementById('wsPort').value;
}
function closeConnModal() {
  document.getElementById('modalBg').classList.remove('open');
}

/* ── CSV EXPORT ── */
function exportCSV() {
  const csv = csvRows.map(r => r.join(',')).join('\n');
  const a   = document.createElement('a');
  a.href     = 'data:text/csv,' + encodeURIComponent(csv);
  a.download = `metaminds_${Date.now()}.csv`;
  a.click();
  addLog(`CSV exported · ${csvRows.length - 1} records`, 'ok');
}
