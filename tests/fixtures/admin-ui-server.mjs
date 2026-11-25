// Isolated admin UI fixture; never grants roles in the real .data directory.
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Accounts} from '../../lib/accounts.mjs';
import {setAdminRole} from '../../tools/manage-admin.mjs';
import {createApp} from '../../server.mjs';
const dataDir=await mkdtemp(join(tmpdir(),'lingjian-admin-ui-'));
const accounts=await new Accounts(dataDir).init();
for(const username of ['qa_owner','qa_reader'])await accounts.signIn({username,password:'qa-only-password-2026'},{register:true,address:'qa'});
accounts.close();
await setAdminRole({dataDir,username:'qa_owner',apply:true});
const app=await createApp({authMode:'accounts',port:3213,dataDir});
console.log(`Admin UI QA: ${app.url}\nUsername: qa_owner\nPassword: qa-only-password-2026`);
