import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell, utilityProcess } from 'electron';

// see docs/desktop.md
const HOST = '127.0.0.1';
const TOKEN = randomBytes(32).toString('hex');
const TOKEN_COOKIE = 'slurp-token';
const READY_TIMEOUT = 20_000;
const READY_POLL = 100;
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];

const configFile = () => join(app.getPath('userData'), 'config.json');
const readConfig = () => {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
};
const archiveRoot = () => readConfig().archiveRoot ?? join(app.getPath('userData'), 'archives');

let server = null;
let origin = null;
let win = null;

const freePort = () =>
  new Promise((ok, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', fail);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });

async function waitForServer(url) {
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, READY_POLL));
  }
  throw new Error(`Slurp's server didn't answer at ${url} within ${READY_TIMEOUT / 1000}s`);
}

async function startServer() {
  const root = archiveRoot();
  mkdirSync(root, { recursive: true });
  const port = await freePort();
  server = utilityProcess.fork(join(app.getAppPath(), 'dist/server/entry.mjs'), [], {
    serviceName: 'Slurp server',
    stdio: 'pipe',
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      SLURP_ARCHIVES: root,
      SLURP_TOKEN: TOKEN,
      PATH: [...EXTRA_PATH, process.env.PATH].join(':'),
    },
  });
  server.stdout?.on('data', (d) => process.stdout.write(d));
  server.stderr?.on('data', (d) => process.stderr.write(d));
  origin = `http://${HOST}:${port}`;
  await session.defaultSession.cookies.set({ url: origin, name: TOKEN_COOKIE, value: TOKEN, httpOnly: true, sameSite: 'strict' });
  await waitForServer(`${origin}/`);
}

// see docs/desktop.md#updating-on-launch
async function updateAllOnLaunch() {
  try {
    await fetch(`${origin}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
      body: JSON.stringify({ mode: 'update-all', media: false }),
    });
  } catch {}
}

function stopServer() {
  server?.kill();
  server = null;
}

const isOurs = (url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

const openOutside = (url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 375,
    show: false,
    title: 'Slurp',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) win.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOurs(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  win.loadURL(`${origin}/`);
}

async function chooseArchiveFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose where Slurp keeps archives',
    defaultPath: archiveRoot(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return;
  writeFileSync(configFile(), JSON.stringify({ ...readConfig(), archiveRoot: filePaths[0] }, null, 2));
  stopServer();
  await startServer();
  win?.loadURL(`${origin}/accounts`);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          { label: 'Choose Archive Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => chooseArchiveFolder() },
          { label: 'Show Archive Folder', click: () => shell.openPath(archiveRoot()) },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
    buildMenu();
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('Slurp could not start', String(err?.message ?? err));
      app.quit();
      return;
    }
    createWindow();
    updateAllOnLaunch();
    app.on('activate', () => {
      if (!win) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', stopServer);
}
