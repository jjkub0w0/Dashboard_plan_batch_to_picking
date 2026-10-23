/**
 * ==============================================================================
 * Plan Batch to Picking - Unified Server & Frontend Runner
 * ==============================================================================
 *
 * 1. Serve Frontend Web App บน Port 1727 (Express, production build)
 * 2. รัน Backend API Service บน Port 1726 (ผ่าน tsx backend/src/server.ts)
 * 3. Reverse Proxy /api บน Port 1727 -> 1726
 * 4. Development mode: node server.js --dev
 *
 * STAB-FIX (runner):
 * - Backend child process ล่ม -> auto-restart ด้วย backoff (สูงสุด MAX_RESTARTS ครั้ งใน 10 นาที)
 * - Ctrl+C -> ฆ่า process tree ทังหมด (taskkill /T บน Windows) กัน process ลูกค้าง
 * - Proxy: request timeout + error ของ upstream + cleanup เมื่อ client ตัดการเชื่อมต่อ
 * - Frontend listen: จัดการ EADDRINUSE ให้อ่านง่าย แทน uncaught crash
 * ==============================================================================
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '1727', 10);
const BACKEND_PORT = parseInt(process.env.PORT || process.env.BACKEND_PORT || '1726', 10);
const HOST = process.env.HOST || '0.0.0.0';
const isDevMode = process.argv.includes('--dev');
process.env.SERVED_BY_RUNNER = 'true';

const MAX_RESTARTS = 10;          // จำนวนครั้ ง restart ก่อนยอมแพ้
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_BASE_DELAY_MS = 2000;

// ตั้งชื่อหน้าต่าง CMD ให้ตรงกับชื่องาน และล็อกชื่อไว้ตลอดเวลา
const APP_TITLE = isDevMode ? 'Plan Batch to Picking [DEV]' : 'Plan Batch to Picking';

function setConsoleTitle() {
  process.title = APP_TITLE;
  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${APP_TITLE}\x07`);
  }
}

setConsoleTitle();
setInterval(setConsoleTitle, 1000).unref();

// ดึง IPv4 ของเครื่องในระบบ LAN
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const SERVER_IP = getLocalIpAddress();
const backendDir = __dirname;
const rootDir = path.resolve(__dirname, '..');
// โฟลเดอร์ผลลัพท์ Angular build ( Angular 22: dist/<project>/browser )
const distPath = path.join(rootDir, 'dist', 'plan-batch-to-picking', 'browser');

let backendProcess = null;
let frontendDevProcess = null;
let shuttingDown = false;
let restartCount = 0;
let restartWindowStart = Date.now();

function ts() {
  return new Date().toISOString();
}

// ฆ่า child พร้อม process tree ทั้งหมด (บน Windows cmd.exe/npm spawn หลานไว้อีกทอด
// ถ้า .kill() เฉพาะพ่อ -> tsx/node หลานจะค้างยึดพอร์ต = zombie server)
function killTree(child, mode = 'force') {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T${mode === 'force' ? ' /F' : ''}`, { stdio: 'ignore' });
    } else {
      child.kill(mode === 'grace' ? 'SIGTERM' : 'SIGKILL');
    }
  } catch (e) {
    if (mode === 'force') {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nกำลังปิดการทำงานของระบบ Plan Batch to Picking...');
  // GRACE-FIX: /F used to fire immediately, racing the child's own graceful
  // shutdown from Ctrl+C (a snapshot JSON mid-write could be truncated).
  // Give it 1.5s, then force-kill anything still alive.
  killTree(backendProcess, 'grace');
  killTree(frontendDevProcess, 'grace');
  setTimeout(() => {
    killTree(backendProcess, 'force');
    killTree(frontendDevProcess, 'force');
    setTimeout(() => process.exit(0), 300);
  }, 1500);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ตรวจสอบว่าพอร์ตถูกใช้งานอยู่หรือไม่
function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = http.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => {
        tester.once('close', () => resolve(false)).close();
      })
      .listen(port, '0.0.0.0');
  });
}

// RECLAIM-FIX: the classic "start.bat does not work" is an ORPHAN OF THIS VERY APP
// (console closed with X, crashed runner, or a second double-click) still holding
// 1726/1727. The old code just waited - forever - because nothing frees those ports
// on its own. Identify the listener PIDs; when the command line is unmistakably
// this app (old runner / old tsx backend) kill them before starting. A foreign
// program that legitimately owns the port is reported and left alone.
function findPortOwnerPids(ports) {
  const out = new Set();
  if (process.platform !== 'win32') return out;
  try {
    const net = execSync('netstat -ano -p tcp', { windowsHide: true, encoding: 'utf8' });
    for (const line of net.split('\n')) {
      if (!/LISTENING/i.test(line)) continue;
      for (const port of ports) {
        if (new RegExp(':' + port + '\\s').test(line)) {
          const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
          if (Number.isFinite(pid) && pid > 4 && pid !== process.pid) out.add(pid);
        }
      }
    }
  } catch { /* netstat unavailable - skip reclaim, old behavior remains */ }
  return out;
}

function commandLineOf(pid) {
  try {
    return String(execSync(
      `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { windowsHide: true, encoding: 'utf8', timeout: 10_000 }
    )).trim();
  } catch { return ''; }
}

// start.bat launches the runner as `node backend\server.js` (relative path in the
// command line); tsx children carry the absolute project path / server.ts / cli.mjs.
function isOurAppProcess(cmdLine) {
  if (!cmdLine) return false;
  return /plan_batch_to_picking/i.test(cmdLine)
    || /(^|["'\\/\s])backend[\\/]+server\.js/i.test(cmdLine)
    || (/tsx/i.test(cmdLine) && /server\.ts/i.test(cmdLine));
}

async function reclaimStaleInstances(ports) {
  if (process.platform !== 'win32') return;
  const pids = findPortOwnerPids(ports);
  if (!pids.size) return;
  let killed = false;
  for (const pid of pids) {
    const cmd = commandLineOf(pid);
    if (isOurAppProcess(cmd)) {
      console.log(`[Reclaim] PID ${pid} is an old instance of this app holding ${ports.join('/')} - closing it: ${cmd.slice(0, 120)}`);
      try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); killed = true; } catch { /* already gone */ }
    } else if (cmd) {
      console.warn(`[Reclaim] ${ports.join('/')} is held by another program (PID ${pid}: ${cmd.slice(0, 120)}) - leaving it alone`);
    }
  }
  if (killed) {
    // wait for the OS to actually release the sockets (up to ~3s)
    for (let i = 0; i < 10; i++) {
      let busy = false;
      for (const port of ports) if (await isPortInUse(port)) busy = true;
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

function runCommand(cmd, args, cwd) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/c', `title ${APP_TITLE} & ${cmd}`, ...args], { cwd, stdio: 'inherit' });
  }
  return spawn(cmd, args, { cwd, stdio: 'inherit' });
}

// RESTART-FIX: shared scheduler so BOTH 'exit' and 'error' feed the same retry
// policy (spawn failure fires 'error' with no 'exit' when npx/tsx is missing), and
// exhausting MAX_RESTARTS no longer goes permanently dark - it degrades to one
// retry per 10-min window, so a 30-min SQL maintenance blip self-heals.
function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (Date.now() - restartWindowStart > RESTART_WINDOW_MS) {
    restartWindowStart = Date.now();
    restartCount = 0;
  }
  restartCount++;
  let delay;
  if (restartCount > MAX_RESTARTS) {
    delay = RESTART_WINDOW_MS;
    console.error(`[Backend] ${reason} - failed ${restartCount - 1}x within the restart window; backing off to 1 retry per ${Math.round(RESTART_WINDOW_MS / 60000)} min (check backend/.env if this repeats)`);
  } else {
    delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** (restartCount - 1), 30_000);
    console.log(`[Backend] ${reason} - restart attempt ${restartCount}/${MAX_RESTARTS} in ${Math.round(delay / 1000)}s...`);
  }
  setTimeout(() => {
    if (!shuttingDown) startBackend();
  }, delay).unref();
}

function startBackend() {
  // รัน npx tsx โดยตรงแทน npm run เพื่อไม่ให้ npm script รีเซ็ตชื่อหน้าต่าง CMD
  const backendCmd = isDevMode ? ['tsx', 'watch', 'src/server.ts'] : ['tsx', 'src/server.ts'];
  backendProcess = runCommand('npx', backendCmd, backendDir);

  backendProcess.on('error', (err) => {
    console.error(`[ERROR] [Backend] ${ts()} เกิดข้อผิดพลาดในการรัน Backend:`, err.message);
    scheduleRestart(`spawn error: ${err.message}`);
  });

  backendProcess.on('exit', (code, sig) => {
    if (shuttingDown) return;
    console.warn(`[Backend] ${ts()} process exited (code=${code}, signal=${sig})`);
    scheduleRestart(`process exited (code=${code})`);
  });
}

async function startSystem() {
  console.log('================================================================');
  console.log('       Plan Batch to Picking - Unified Server Runner        ');
  console.log('================================================================');
  console.log(`[Config] IP เครื่องเซิร์ฟเวอร์ : ${SERVER_IP}`);
  console.log(`[Config] พอร์ต Frontend      : ${FRONTEND_PORT}`);
  console.log(`[Config] พอร์ต Backend API   : ${BACKEND_PORT}`);
  console.log(`[Config] โหมดการทำงาน        : ${isDevMode ? 'Development (Hot Reload)' : 'Production (Fast & Lightweight)'}`);
  console.log('----------------------------------------------------------------');

  // 0. RECLAIM-FIX: close orphaned instances of THIS app that would block both
  // ports forever (that is exactly what made start.bat "stop working" after an
  // unclean exit) before checking/starting anything.
  await reclaimStaleInstances([BACKEND_PORT, FRONTEND_PORT]);

  // 1. เริ่มทำงาน Backend Service (Port 1726)
  const backendAlreadyRunning = await isPortInUse(BACKEND_PORT);
  if (backendAlreadyRunning) {
    console.log(`[Backend] ตรวจพบ Backend ทำงานอยู่แล้วบนพอร์ต ${BACKEND_PORT}`);
    // RECLAIM-FIX: used to skip forever - when the squatter later exits, the SPA
    // sat on permanent 502s. Re-check every 60s and take the port when it frees.
    const recheck = setInterval(async () => {
      if (shuttingDown || backendProcess) { clearInterval(recheck); return; }
      if (!(await isPortInUse(BACKEND_PORT))) {
        clearInterval(recheck);
        console.log(`[Backend] port ${BACKEND_PORT} is free now - starting our own backend`);
        startBackend();
      }
    }, 60_000);
    recheck.unref();
  } else {
    console.log(`[Backend] กำลังเริ่ม Backend API Service บนพอร์ต ${BACKEND_PORT}...`);
    startBackend();
  }

  // 2. จัดการ Frontend (Port 1727)
  if (isDevMode) {
    console.log(`[Frontend] กำลังเริ่ม Frontend โหมด Dev (ng serve บนพอร์ต ${FRONTEND_PORT})...`);
    frontendDevProcess = runCommand('npx', ['ng', 'serve', '--host', '0.0.0.0', '--port', String(FRONTEND_PORT)], rootDir);
    frontendDevProcess.on('error', (err) => console.error('[ERROR] [Frontend] dev process error:', err.message));
    return;
  }

  // Production: serve ผ่าน Express ทันที
  if (!fs.existsSync(path.join(distPath, 'index.html'))) {
    console.log('[Frontend] ไม่พบไฟล์ build ใน dist/ กำลัง compile ให้อัตโนมัติ (ครั้งแรกเท่านั้น)...');
    execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
  }

  const frontendApp = express();

  // CORS & No-cache for HTML files
  frontendApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.path.endsWith('.html') || req.path === '/') {
      res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });

  // Reverse Proxy /api -> Backend (Port 1726)
  frontendApp.use('/api', (req, res) => {
    const options = {
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: `/api${req.url}`,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      // ถ้า upstream stream พังกลางคัน -> ปิด response ให้ client รับ error ชัดเจน
      proxyRes.on('error', (err) => {
        console.error('[Proxy] upstream response error:', err.message);
        res.destroy();
      });
    });

    // STAB-FIX: timeout กัน proxy ค้างถาวรเมื่อ backend freeze (เดิมไม่มี timeout)
    // SSE-FIX: /api/events legitimately idles >5 min (syncs run every 30) - the
    // idle-destroy cut every proxied EventSource every 5 min (reconnect loops).
    if (!req.url.startsWith('/events')) {
      proxyReq.setTimeout(5 * 60 * 1000, () => {
        console.warn('[Proxy] upstream timeout (5 นาที) — ยกเลิกคำขอ');
        proxyReq.destroy(new Error('upstream timeout'));
      });
    }

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: `ไม่สามารถเชื่อมต่อ Backend บนพอร์ต ${BACKEND_PORT} ได้ (กำลังรอเซิร์ฟเวอร์พร้อม...)`,
          details: err.message,
        });
      } else {
        res.destroy();
      }
      // STAB-FIX: the upstream is gone, so nothing is draining the inbound request
      // anymore. An unfinished upload body used to stay buffered in memory here -
      // and if the client then aborted, the 'error' event on `req` had no listener,
      // which would take this whole supervisor process down (see req.on('error')).
      if (!req.readableEnded) req.destroy();
    });

    // STAB-FIX: socket errors on the inbound streams are EXPECTED here (user hits F5
    // mid-request, browser closes a keep-alive socket, backend restarts under a POST).
    // Node throws on an 'error' event with no listener, and pipe() does NOT forward or
    // swallow those - so a plain aborted request was able to crash the runner that
    // supervises backend + frontend. Log and drop instead (graceful degradation).
    req.on('error', (err) => {
      console.warn(`[Proxy] inbound request error (client aborted?): ${err.message}`);
      proxyReq.destroy();
    });
    res.on('error', (err) => {
      console.warn(`[Proxy] outbound response error (client gone?): ${err.message}`);
      proxyReq.destroy();
    });

    // client ปิด connection กลางคัน (user refresh) -> ยกเลิก upstream ให้ resource ถูกคืน
    req.on('aborted', () => proxyReq.destroy());
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
    });

    req.pipe(proxyReq);
  });

  // Serve static Angular build
  frontendApp.use(express.static(distPath));

  // SPA fallback -> index.html
  frontendApp.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  const frontendServer = frontendApp.listen(FRONTEND_PORT, HOST, () => {
    console.log('----------------------------------------------------------------');
    console.log('[OK] ระบบ Plan Batch to Picking พร้อมใช้งานแล้ว!');
    console.log(`Local : http://127.0.0.1:${FRONTEND_PORT}`);
    console.log(`LAN   : http://${SERVER_IP}:${FRONTEND_PORT}`);
    console.log(`API   : http://127.0.0.1:${BACKEND_PORT}/api`);
    console.log('----------------------------------------------------------------');
    console.log('กด Ctrl + C เพื่อปิดระบบทั้งหมด');
    console.log('================================================================');
  });

  // FIX: เดิม EADDRINUSE -> process runner crash (uncaught)
  frontendServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ERROR] [Frontend] พอร์ต ${FRONTEND_PORT} ถูกใช้งานอยู่แล้ว — ปิดโปรแกรมเดิมก่อนรันใหม่`);
    } else {
      console.error('[ERROR] [Frontend] server error:', err);
    }
  });
}

startSystem().catch((err) => {
  console.error('[ERROR] startSystem ล้มเหลว:', err);
  process.exit(1);
});
