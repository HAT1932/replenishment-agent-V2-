/**
 * gh-create-repo.mjs — 用本机已存储的 GitHub 凭据创建仓库（不打印任何 token）
 * 仅在需要新建远端仓库时执行一次；已有仓库则跳过。
 */
import { spawnSync } from 'node:child_process';

const NAME = process.env.REPO_NAME || 'replenishment-agent';
const PRIVATE = process.env.REPO_PRIVATE !== '0';

function storedCredential() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  const text = `${r.stdout ?? ''}`;
  const username = (text.match(/^username=(.*)$/m) ?? [])[1];
  const password = (text.match(/^password=(.*)$/m) ?? [])[1];
  if (!username || !password) throw new Error('未找到已存储的 GitHub 凭据');
  return { username, password };
}

const { username, password } = storedCredential();
const headers = {
  Authorization: `Bearer ${password}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'replenishment-agent-setup',
};

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const me = await api('/user');
if (me.status !== 200) {
  console.error('凭据无效或权限不足：', me.status, me.body?.message ?? '');
  process.exit(2);
}
const login = me.body.login;
console.log('已认证用户：', login);

const existing = await api(`/repos/${login}/${NAME}`);
if (existing.status === 200) {
  console.log('仓库已存在：', existing.body.html_url, '| private =', existing.body.private);
  process.exit(0);
}

const created = await api('/user/repos', {
  method: 'POST',
  body: JSON.stringify({
    name: NAME,
    description: '智能补货 Agent（v2）：确定性补货内核 + 可解释建议 + 人工审批闸门 + 审计留痕',
    private: PRIVATE,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  }),
});
if (created.status === 201) {
  console.log('已创建仓库：', created.body.html_url, '| private =', created.body.private);
  process.exit(0);
}
console.error('创建失败：', created.status, created.body?.message ?? '');
process.exit(1);
