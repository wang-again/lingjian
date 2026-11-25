import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { officePython, officeToolDirectory } from '../../lib/runtime.mjs';

const directory = officeToolDirectory();
export const integrationMissing = existsSync(officePython())
  && ['server.py', 'tools/document_editing.py', 'tools/ocr_tools.py'].every(file => existsSync(join(directory, file)))
  ? false : '需要安装兼容的 Office 集成与 Python';
