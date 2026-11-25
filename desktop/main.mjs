import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createApp } from '../server.mjs';
import { configuredPort, loadProjectEnv } from '../lib/runtime.mjs';

const title = '灵笺 · 文档工作台';
let backend;
let mainWindow;
let shuttingDown = false;
let exitCode = 0;

function openExternal(url) {
  if (['http:', 'https:'].includes(url.protocol)) {
    shell.openExternal(url.href).catch(error => console.error(error));
  }
}

function protectWindow(window, origin, isMainWindow) {
  const contents = window.webContents;
  contents.on('will-frame-navigate', event => {
    const target = new URL(event.url);
    if (target.origin !== origin) {
      event.preventDefault();
      if (event.isMainFrame) openExternal(target);
    }
  });
  contents.on('will-redirect', event => {
    if (new URL(event.url).origin !== origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (isMainWindow && target.origin === origin && target.pathname === '/api/office/file'
        && target.searchParams.get('inline') === '1') {
      return { action: 'allow', overrideBrowserWindowOptions: { parent: window, autoHideMenuBar: true } };
    }
    if (target.origin !== origin) openExternal(target);
    return { action: 'deny' };
  });
}

async function start() {
  loadProjectEnv();
  // A stable origin keeps desktop preferences and recovery drafts across restarts.
  backend = await createApp({ port: configuredPort(), listenHost: '127.0.0.1', publicOrigin: '' });
  const origin = new URL(backend.url).origin;
  mainWindow = new BrowserWindow({
    title,
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  protectWindow(mainWindow, origin, true);
  mainWindow.webContents.on('did-create-window', window => protectWindow(window, origin, false));
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === mainWindow?.webContents && permission === 'clipboard-sanitized-write');
  });
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      message: '当前有未完成的编辑或任务，仍要关闭工作台吗？',
      buttons: ['继续编辑', '关闭'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });
  const isWorkspaceFrame = event => event.sender === mainWindow?.webContents
    && event.senderFrame && event.senderFrame === event.sender.mainFrame
    && new URL(event.senderFrame.url).origin === origin;
  ipcMain.handle('desktop:editor-menu', (event, hasSelection, canRewrite, language) => {
    if (!isWorkspaceFrame(event)) return false;
    const english = language === 'en';
    const items = resolve => [
      ...(canRewrite === true ? [
        { label: english ? 'Rewrite selection with AI' : 'AI 修改选区', click: () => resolve(true) },
        { type: 'separator' },
      ] : []),
      { label: english ? 'Cut' : '剪切', role: 'cut', enabled: hasSelection === true },
      { label: english ? 'Copy' : '复制', role: 'copy', enabled: hasSelection === true },
      { label: english ? 'Paste' : '粘贴', role: 'paste' },
      { label: english ? 'Select all' : '全选', role: 'selectAll' },
    ];
    return new Promise(resolve => {
      Menu.buildFromTemplate(items(resolve)).popup({
        window: mainWindow,
        frame: event.senderFrame,
        callback: () => resolve(false),
      });
    });
  });
  ipcMain.handle('desktop:save-pdf', async (event, name, language) => {
    if (!isWorkspaceFrame(event)) {
      throw new Error('无法从当前页面导出 PDF。');
    }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: language === 'en' ? 'Save PDF' : '保存 PDF',
      defaultPath: join(app.getPath('documents'), `${basename(String(name)) || '未命名文档'}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled) return false;
    const pdf = await event.sender.printToPDF({ preferCSSPageSize: true, printBackground: true });
    await writeFile(filePath, pdf);
    return true;
  });
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  await mainWindow.loadURL(backend.url);
  mainWindow.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('will-quit', event => {
    if (!backend || shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    backend.close().then(() => app.exit(exitCode), error => {
      console.error(error);
      app.exit(1);
    });
  });
  app.whenReady().then(start).catch(error => {
    console.error(error);
    const message = error.code === 'EADDRINUSE'
      ? `端口 ${error.port} 已被占用。请关闭占用该端口的程序，或在 .env 中更改 PORT。`
      : error.message;
    dialog.showErrorBox(title, message);
    exitCode = 1;
    if (backend) app.quit();
    else app.exit(exitCode);
  });
}
