import { randomInt } from 'node:crypto';
import { createApp } from '../../server.mjs';

// On Windows, listen(0) can select ports such as 6000 that fetch blocks.
// Use a safe range and retry ports that are busy or reserved by Windows.
async function onHttpPort(start) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { return await start(randomInt(20000, 60000)); }
    catch (error) {
      const unavailable = error.code === 'EADDRINUSE' || (process.platform === 'win32' && error.code === 'EACCES');
      if (!unavailable || attempt === 19) throw error;
    }
  }
}

export function createTestApp(options) {
  return onHttpPort(port => createApp({ authMode: 'local', ...options, port }));
}

export function listenHttp(server) {
  return onHttpPort(port => new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  }));
}
