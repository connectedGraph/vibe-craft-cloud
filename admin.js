'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ts) => ts ? new Date(ts).toLocaleString() : '—';

function toast(message, ok = true) {
  const el = ok ? $('#ok') : $('#err');
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 3000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  return data || {};
}

let me = null;

async function boot() {
  try {
    me = await api('GET', '/api/v1/auth/me');
  } catch { /* 未登录 */ }
  if (!me || !me.user) { location.href = '/login.html?next=%2Fadmin.html'; return; }
  if (me.user.role !== 'admin') { location.href = '/'; return; }
  $('#who-text').textContent = `${me.user.username} · 管理员`;

  await Promise.all([loadSettings(), loadUsers(), loadSessions(), loadTokens()]);
}

/* ───────── 设置 ───────── */

async function loadSettings() {
  const s = await api('GET', '/api/v1/admin/settings');
  $('#mode').value = s.mode;
  $('#reg-open').checked = !!s.registrationOpen;
  $('#invite').value = s.inviteCode || '';
  $('#invite').placeholder = s.inviteRequired ? '已启用邀请码' : '邀请码（可空）';
}

$('#save-settings').onclick = async () => {
  try {
    await api('POST', '/api/v1/admin/settings', {
      mode: $('#mode').value,
      registrationOpen: $('#reg-open').checked,
      inviteCode: $('#invite').value.trim(),
    });
    toast('设置已保存');
    await loadSettings();
  } catch (e) { toast('保存失败：' + e.message, false); }
};

/* ───────── 用户 ───────── */

async function loadUsers() {
  const { users } = await api('GET', '/api/v1/admin/users');
  $('#users').innerHTML = users.map(u => `
    <tr>
      <td class="mono">${esc(u.username)}</td>
      <td>${u.role === 'admin' ? '<span class="pill">admin</span>' : 'user'}</td>
      <td>${u.disabled ? '<span class="pill off">已禁用</span>' : '<span class="pill ok">正常</span>'}${u.mustChangePassword ? ' <span class="pill">待改密</span>' : ''}</td>
      <td class="hint">${fmt(u.lastLoginAt)}</td>
      <td>
        <div class="row">
          <button class="btn" data-reset="${esc(u.username)}">改密</button>
          <button class="btn ${u.disabled ? '' : 'danger'}" data-toggle="${esc(u.username)}" data-disabled="${u.disabled}">${u.disabled ? '启用' : '禁用'}</button>
          <button class="btn" data-sessions="${esc(u.username)}">会话</button>
        </div>
      </td>
    </tr>`).join('');

  $('#users').querySelectorAll('[data-reset]').forEach(b => {
    b.onclick = async () => {
      const pw = prompt(`为 ${b.dataset.reset} 设置新密码（至少 8 位）：`);
      if (!pw) return;
      try {
        await api('PATCH', '/api/v1/admin/users/' + encodeURIComponent(b.dataset.reset), { password: pw, mustChange: false });
        toast('密码已更新');
      } catch (e) { toast('失败：' + e.message, false); }
    };
  });
  $('#users').querySelectorAll('[data-toggle]').forEach(b => {
    b.onclick = async () => {
      const disabled = b.dataset.disabled === 'true';
      try {
        await api('PATCH', '/api/v1/admin/users/' + encodeURIComponent(b.dataset.toggle), { disabled: !disabled });
        toast(disabled ? '已启用' : '已禁用');
        await loadUsers();
      } catch (e) { toast('失败：' + e.message, false); }
    };
  });
  $('#users').querySelectorAll('[data-sessions]').forEach(b => {
    b.onclick = () => { $('#session-user').value = b.dataset.sessions; loadSessions(); };
  });
}

$('#create-user').onclick = async () => {
  const username = $('#new-user').value.trim();
  const password = $('#new-pass').value;
  const role = $('#new-role').value;
  if (!username || !password) return toast('用户名和密码都要填', false);
  try {
    await api('POST', '/api/v1/admin/users', { username, password, role });
    $('#new-user').value = '';
    $('#new-pass').value = '';
    toast('用户已创建');
    await loadUsers();
  } catch (e) { toast('创建失败：' + e.message, false); }
};

/* ───────── 会话 ───────── */

async function loadSessions() {
  const username = $('#session-user').value.trim() || (me.user && me.user.username);
  const { sessions } = await api('GET', '/api/v1/admin/sessions?username=' + encodeURIComponent(username));
  $('#sessions').innerHTML = sessions.length ? sessions.map(s => `
    <tr>
      <td class="mono" title="${esc(s.device)}">${esc((s.device || '未知设备').slice(0, 48))}</td>
      <td class="mono">${esc(s.ip)}</td>
      <td class="hint">${fmt(s.createdAt)}</td>
      <td class="hint">${fmt(s.lastSeenAt)}</td>
      <td>${s.revoked ? '<span class="pill off">已吊销</span>' : '<span class="pill ok">有效</span>'}</td>
      <td>${s.revoked ? '' : `<button class="btn danger" data-revoke="${s.id}">踢下线</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">没有会话</td></tr>';

  $('#sessions').querySelectorAll('[data-revoke]').forEach(b => {
    b.onclick = async () => {
      try {
        await api('DELETE', '/api/v1/admin/sessions/' + b.dataset.revoke);
        toast('已吊销');
        await loadSessions();
      } catch (e) { toast('失败：' + e.message, false); }
    };
  });
}

$('#load-sessions').onclick = () => loadSessions().catch(e => toast('加载失败：' + e.message, false));

/* ───────── 令牌 ───────── */

async function loadTokens() {
  const { tokens } = await api('GET', '/api/v1/admin/tokens');
  $('#tokens').innerHTML = tokens.length ? tokens.map(t => `
    <tr>
      <td>${esc(t.name)}</td>
      <td class="hint">${fmt(t.created_at)}</td>
      <td class="hint">${fmt(t.last_used_at)}</td>
      <td>${t.revoked_at ? '<span class="pill off">已吊销</span>' : '<span class="pill ok">有效</span>'}</td>
      <td>${t.revoked_at ? '' : `<button class="btn danger" data-token="${t.id}">吊销</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">还没有令牌</td></tr>';

  $('#tokens').querySelectorAll('[data-token]').forEach(b => {
    b.onclick = async () => {
      try {
        await api('DELETE', '/api/v1/admin/tokens/' + b.dataset.token);
        toast('已吊销');
        await loadTokens();
      } catch (e) { toast('失败：' + e.message, false); }
    };
  });
}

$('#create-token').onclick = async () => {
  const name = $('#token-name').value.trim() || 'script';
  try {
    const out = await api('POST', '/api/v1/admin/tokens', { name });
    $('#token-once').innerHTML = `<div class="token-once">${esc(out.token)}</div><div class="hint" style="margin-top:6px">只显示这一次，复制好再关页面。</div>`;
    $('#token-name').value = '';
    await loadTokens();
  } catch (e) { toast('创建失败：' + e.message, false); }
};

$('#logout').onclick = async () => {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.href = '/login.html';
};

boot().catch(e => toast('加载失败：' + e.message, false));
