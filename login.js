'use strict';

const $ = (s) => document.querySelector(s);
const panels = ['login', 'register', 'change', 'off'];
const params = new URLSearchParams(location.search);
const nextUrl = (() => {
  const raw = params.get('next') || '/';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
})();

let state = { mode: 'self', registrationOpen: false, inviteRequired: false, user: null };

/* 密码小眼睛 */
document.querySelectorAll('.eye').forEach((btn) => {
  btn.onclick = () => {
    const input = btn.parentElement.querySelector('input');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('on', show);
    btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    input.focus();
  };
});

/* 密码强度 */
const LABEL = ['', '偏弱', '还行', '很强'];
function strengthOf(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score += 1;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds >= 2) score += 1;
  if (pw.length >= 12 || kinds >= 3) score += 1;
  return Math.min(3, Math.max(1, score));
}
document.querySelectorAll('[data-strength]').forEach((bar) => {
  const scope = bar.parentElement;
  const input = scope ? scope.querySelector('input') : null;
  if (!input) return;
  const label = bar.querySelector('span');
  const update = () => {
    const score = strengthOf(input.value);
    bar.className = 'strength' + (score ? ' on s' + score : '');
    if (label) label.textContent = score ? LABEL[score] : '';
  };
  input.addEventListener('input', update);
  update();
});

function show(name) {
  panels.forEach(p => { $('#p-' + p).hidden = p !== name; });
  $('#err').classList.remove('on');
  const first = $('#' + panelId(name) + ' input');
  if (first) setTimeout(() => first.focus(), 60);
}
function panelId(name) { return { login: 'f-login', register: 'f-register', change: 'f-change', off: 'p-off' }[name]; }

function applyForced(forced) {
  $('#cur-field').hidden = !!forced;
  $('#forced-hint').hidden = !forced;
  const cur = $('#f-change').querySelector('[name="current"]');
  if (cur) cur.required = !forced;
}

const ERROR_MESSAGES = {
  invalid_credentials: '用户名或密码错误',
  account_disabled: '账号已被禁用，请联系管理员',
  too_many_attempts: '尝试次数过多，请 15 分钟后再试',
  missing_credentials: '请填写用户名和密码',
  weak_password: '密码至少 8 位',
  bad_username: '用户名只能是 3–32 位字母、数字或下划线',
  username_taken: '这个用户名已经被占用了',
  registration_closed: '这个实例当前没有开放注册',
  bad_invite_code: '邀请码不正确',
  anonymous_mode: '这个实例是匿名模式，不需要登录',
  wrong_password: '当前密码不正确',
  default_password: '不能把初始密码再设一遍',
  same_password: '新密码不能和当前密码相同',
  password_update_failed: '密码更新失败，请稍后重试',
  unauthenticated: '登录状态已失效，请重新登录',
  payload_too_large: '提交的内容太大',
  network: '网络连接失败，请检查网络后重试',
};

function messageOf(err) {
  const code = err && err.message ? err.message : String(err);
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (/^http_5/.test(code)) return '服务器出了点问题，请稍后重试';
  if (/^http_4/.test(code)) return '请求没有被服务器接受，请检查填写内容';
  return code;
}

function fail(message) {
  const el = $('#err');
  el.textContent = message;
  el.classList.add('on');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function call(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw new Error((data && data.error) || ('http_' + res.status));
  return data || {};
}

async function boot() {
  let me = null;
  try {
    const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
    me = await res.json();
  } catch { /* 后端没起来，走登录表单 */ }

  if (me) {
    state = me;
    if (me.mode === 'off') return show('off');
    if (me.user && !me.user.mustChangePassword) { location.replace(nextUrl); return; }
    if (me.user && me.user.mustChangePassword) { applyForced(true); show('change'); return; }
    $('#reg-switch').hidden = !me.registrationOpen;
    $('#invite-field').hidden = !me.inviteRequired;
    $('#default-hint').hidden = !me.defaultPasswordHint;
  }
  applyForced(false);
  show('login');
}

document.querySelectorAll('[data-go]').forEach(a => {
  a.onclick = () => show(a.dataset.go);
});

$('#f-login').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const out = await call('/api/v1/auth/login', {
      username: f.get('username'),
      password: f.get('password'),
      remember: f.get('remember') === 'on',
    });
    if (out.user && out.user.mustChangePassword) { applyForced(true); show('change'); }
    else location.replace(nextUrl);
  } catch (err) {
    fail(messageOf(err));
    btn.disabled = false;
  }
};

$('#f-register').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await call('/api/v1/auth/register', {
      username: f.get('username'),
      password: f.get('password'),
      invite: f.get('invite'),
    });
    location.replace(nextUrl);
  } catch (err) {
    fail(messageOf(err));
    btn.disabled = false;
  }
};

$('#f-change').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('next') !== f.get('repeat')) return fail('两次输入的新密码不一致');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await call('/api/v1/auth/password', { current: f.get('current') || '', next: f.get('next') });
    location.replace(nextUrl);
  } catch (err) {
    fail(messageOf(err));
    btn.disabled = false;
  }
};

boot();
