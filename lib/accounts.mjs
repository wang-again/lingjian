import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from './providers.mjs';

const scrypt = promisify(derive);
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
async function jsonOr(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function credentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('账号信息格式不正确。');
  const username = typeof input.username === 'string' ? input.username.trim().normalize('NFKC').toLowerCase() : '';
  if (!/^[\p{L}\p{N}_-]{3,40}$/u.test(username)) throw new UserError('用户名需为 3–40 位文字、数字、下划线或短横线。');
  if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new UserError('密码需为 12–128 个字符。');
  return { username, password: input.password };
}
const hashPassword = (password, salt) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export const publicUser = user => ({id:user.id,username:user.username,role:user.role==='admin'?'admin':'user'});

export class Accounts {
  constructor(directory, { registration = true, inviteCode = '', sessionMs = 8 * 3600_000, idleMs = 30 * 60_000, now = Date.now } = {}) {
    this.directory = directory; this.file = join(directory, 'accounts.json');
    this.registration = registration; this.inviteCode = inviteCode;
    this.sessionMs = sessionMs; this.idleMs = idleMs; this.now = now;
    this.sessions = new Map(); this.attempts = new Map(); this.pendingAuth = 0; this.tail = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    this.users = await jsonOr(this.file, []);
    if (!Array.isArray(this.users) || this.users.some(user => !/^[a-f0-9-]{36}$/.test(user.id) || !user.username || !/^[a-f0-9]{128}$/.test(user.hash) || !/^[a-f0-9]{32}$/.test(user.salt))) throw new Error('账号数据格式错误，请保留原文件并检查。');
    this.timer = setInterval(() => this.sweep(), 60_000); this.timer.unref(); return this;
  }
  sweep() {
    const now = this.now();
    for (const [key, session] of this.sessions) if (now >= session.expires || now - session.touched >= this.idleMs) this.remove(key);
    for (const [key, limit] of this.attempts) if (now >= limit.until) this.attempts.delete(key);
  }
  remove(key) {
    const session = this.sessions.get(key);
    if (session) { session.keys.clear(); session.abort.abort(); this.sessions.delete(key); }
  }
  close() { clearInterval(this.timer); for (const key of this.sessions.keys()) this.remove(key); }
  limit(key, count, period) {
    const now = this.now(); let entry = this.attempts.get(key);
    if (!entry || entry.until <= now) {
      if (this.attempts.size >= 10000) this.sweep();
      if (this.attempts.size >= 10000) throw new UserError('请求过多，请稍后再试。', 429);
      entry = { count: 0, until: now + period }; this.attempts.set(key, entry);
    }
    if (++entry.count > count) throw new UserError('请求过于频繁，请稍后再试。', 429);
  }
  async signIn(input, { register = false, address = '' } = {}) {
    this.limit(`auth:${address}`, 15, 15 * 60_000);
    const { username, password } = credentials(input);
    this.limit(`user:${username}`, 15, 15 * 60_000);
    if (register && (!this.registration || (this.inviteCode && !equal(String(input.inviteCode || ''), this.inviteCode)))) throw new UserError('注册未开放或邀请码不正确。', 403);
    if (this.pendingAuth >= 4) throw new UserError('登录请求较多，请稍后再试。', 429);
    this.pendingAuth++;
    try {
      let user = this.users.find(user => user.username === username);
      const salt = register || !user ? randomBytes(16).toString('hex') : user.salt;
      const hash = (await hashPassword(password, salt)).toString('hex');
      if (register) {
        const task = this.tail.catch(() => {}).then(async () => {
          if (this.users.some(user => user.username === username)) throw new UserError('此用户名不可用。', 409);
          if (this.users.length >= 1000) throw new UserError('测试平台账号数量已达上限。', 403);
          user = { id: randomUUID(), username, salt, hash, createdAt: new Date(this.now()).toISOString() };
          const next = [...this.users, user]; await atomicJson(this.file, next); this.users = next;
        });
        this.tail = task; await task;
      } else if (!user || !equal(user.hash, hash)) throw new UserError('用户名或密码不正确。', 401);
      user=this.users.find(item=>item.id===user.id);
      if(user.disabled===true)throw new UserError('该账号已停用，请联系管理员。',403);
      this.sweep();
      const own = [...this.sessions].filter(([, session]) => session.user.id === user.id);
      while (own.length >= 5) this.remove(own.shift()[0]);
      if (this.sessions.size >= 1000) throw new UserError('在线会话已达上限，请稍后再试。', 429);
      const cookie = randomBytes(32).toString('hex'), now = this.now();
      const session = { user: publicUser(user), token: randomBytes(32).toString('hex'), keys: new Map(), touched: now, expires: now + this.sessionMs, abort: new AbortController(), active: 0 };
      this.sessions.set(digest(cookie), session);
      return { cookie, session };
    } finally { this.pendingAuth--; }
  }
  authenticate(cookieHeader) {
    const cookie = String(cookieHeader || '').split(';').map(item => item.trim()).find(item => item.startsWith('lingjian_session='))?.slice('lingjian_session='.length);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return null;
    const key = digest(cookie), session = this.sessions.get(key), now = this.now();
    if (!session) return null;
    const user=this.users.find(item=>item.id===session.user.id);
    if(!user||user.disabled===true){this.remove(key);return null;}
    session.user=publicUser(user);
    if (now >= session.expires || now - session.touched >= this.idleMs) { this.remove(key); return null; }
    session.touched = now; return session;
  }
  logout(session) { for (const [key, value] of this.sessions) if (value === session) this.remove(key); }
  requireAdmin(session) {
    const actor=this.users.find(item=>item.id===session?.user?.id);
    if(!actor||actor.disabled===true||actor.role!=='admin')throw new UserError('此操作需要管理员权限。',403);
    return actor;
  }
  setDisabled(session,id,disabled) {
    const task=this.tail.catch(()=>{}).then(async()=>{
      const actor=this.requireAdmin(session),target=this.users.find(item=>item.id===id);
      if(typeof disabled!=='boolean')throw new UserError('账号状态必须为布尔值。');
      if(!target)throw new UserError('账号不存在。',404);
      if(disabled&&target.id===actor.id)throw new UserError('不能停用当前管理员账号。',409);
      if(disabled&&target.role==='admin'&&this.users.filter(item=>item.role==='admin'&&item.disabled!==true).length<=1)throw new UserError('至少须保留一个启用的管理员。',409);
      if(Boolean(target.disabled)===disabled)return publicUser(target);
      const event={id:randomUUID(),at:new Date(this.now()).toISOString(),actor:actor.username,target:target.username,action:disabled?'disable':'enable'};
      const next=this.users.map(item=>item.id===id?{...item,disabled,adminHistory:[...(item.adminHistory||[]),event].slice(-20)}:item);
      await atomicJson(this.file,next);this.users=next;
      if(disabled)for(const [key,value] of this.sessions)if(value.user.id===id)this.remove(key);
      return publicUser(next.find(item=>item.id===id));
    });
    this.tail=task;return task;
  }
  forgetKey(userId, providerId) { for (const session of this.sessions.values()) if (session.user.id === userId) session.keys.delete(providerId); }
}

export class KeyVault {
  constructor(file, userId, master) { this.file = file; this.userId = userId; this.master = master; this.tail = Promise.resolve(); }
  async init() { this.entries = await jsonOr(this.file, {}); return this; }
  has(id) { return Boolean(this.master && Object.hasOwn(this.entries, id)); }
  get(id, origin) {
    const entry = Object.hasOwn(this.entries, id) ? this.entries[id] : null;
    if (!this.master || !entry || entry.origin !== origin) return '';
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.master, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${this.userId}:${id}:${origin}`)); decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new UserError('已保存密钥无法解密，请重新填写密钥并保存。', 409); }
  }
  async set(id, key, origin) {
    if (key && !this.master) throw new UserError('管理员尚未配置密钥加密，当前仅支持会话内保存。');
    const task = this.tail.catch(() => {}).then(async () => {
      const next = { ...this.entries }; delete next[id];
      if (key) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.master, iv);
        cipher.setAAD(Buffer.from(`${this.userId}:${id}:${origin}`));
        const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
        next[id] = { origin, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      }
      await atomicJson(this.file, next); this.entries = next;
    });
    this.tail = task; return task;
  }
}
