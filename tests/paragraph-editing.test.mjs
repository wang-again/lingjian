import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

const python = process.env.OFFICE_PYTHON || resolve('.venv-office',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('Word 段落结构修改真实保留样式和未改部件，保护域、书签、编号和分节，失败不保存', {skip: integrationMissing,timeout:60000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingjian-paragraph-'));
  t.after(async()=>{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('lingjian-paragraph-'));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const {stdout}=await promisify(execFile)(python,['-B',resolve('tests/fixtures/paragraph_regression.py'),directory],{windowsHide:true});
  assert.match(stdout,/atomic rejection passed/);
});
