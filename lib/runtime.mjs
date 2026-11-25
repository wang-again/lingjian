import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadProjectEnv() {
  try {
    process.loadEnvFile(join(projectRoot, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function configuredPort() {
  const value = process.env.PORT || '3210';
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error('PORT 必须是 1–65535 之间的整数。请检查环境变量或项目的 .env。');
  }
  return port;
}

export const officeSetupMessage = '请按 README 安装可选 Office 工具（office-tool）及 Python 依赖。';

export function officeToolDirectory() {
  return resolve(projectRoot, process.env.OFFICE_TOOL_DIR || '.vendor/office-tool');
}

export async function officeToolInstalled(directory = officeToolDirectory()) {
  try { return (await stat(join(directory, 'server.py'))).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

export function officePython() {
  return process.env.OFFICE_PYTHON
    || join(projectRoot, '.venv-office', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}
