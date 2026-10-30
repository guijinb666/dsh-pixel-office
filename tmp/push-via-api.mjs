/**
 * 用 GitHub Git Data API 把本地提交推上去。
 *
 * 为什么需要这个：本机到 github.com:443 连不通（api.github.com 与
 * objects.githubusercontent.com 都通），git push 重试三次全是
 * "Failed to connect ... after 21000ms"。REST API 走的是另一个域名，可以正常用。
 *
 * 做的事：读本地 HEAD 相对父提交的变动文件 → 逐个建 blob（删除记 sha:null）
 * → 在远程 base tree 上建新 tree → 用本地提交原本的 author/committer 与时间
 * 建 commit（保持 SHA 与本地一致）→ 把 heads/master 指过去。
 *
 * 前置条件：远程 master 必须正好是本地 HEAD 的父提交，否则脚本直接报错退出，
 * 不做任何强推。
 *
 * 用法：node tmp/push-via-api.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = 'guijinb666/dsh-pixel-office';
const BRANCH = 'master';
const TOKEN_PATH = process.env.TEMP + '\\ghtok.txt';

const tok = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const H = {
  Authorization: 'token ' + tok,
  'User-Agent': 'dsh-pixel-office',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json'
};

async function api(method, path, body) {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + text.slice(0, 500));
  return text ? JSON.parse(text) : null;
}

const git = (cmd) => execSync('git ' + cmd, { encoding: 'utf8' }).trim();

const head = git('rev-parse HEAD');
// 不能用 HEAD^：execSync 在 Windows 上走 cmd.exe，^ 是转义符会被吃掉，
// 结果 HEAD^ 变成 HEAD，父提交与 HEAD 相同、diff 为空。
const parent = git('rev-parse HEAD~1');

const info = {
  authorName: git('log -1 --pretty=%an'),
  authorEmail: git('log -1 --pretty=%ae'),
  authorDate: git('log -1 --pretty=%aI'),
  committerName: git('log -1 --pretty=%cn'),
  committerEmail: git('log -1 --pretty=%ce'),
  committerDate: git('log -1 --pretty=%cI'),
  message: execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).replace(/\s+$/, '')
};

const changed = execSync('git diff --name-status ' + parent + '..' + head, { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const parts = line.split('\t');
    return { status: parts[0][0], path: parts[parts.length - 1] };
  });

console.log('本地 HEAD', head.slice(0, 7), '父', parent.slice(0, 7), '变更', changed.length, '个文件');

const ref = await api('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH);
const remoteSha = ref.object.sha;
console.log('远程 master =', remoteSha.slice(0, 7));
if (remoteSha !== parent) {
  throw new Error('远程 master 与本地父提交不一致，停止（不做强推）');
}
const remoteCommit = await api('GET', '/repos/' + REPO + '/git/commits/' + remoteSha);

const entries = [];
for (const f of changed) {
  if (f.status === 'D') {
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
    console.log('  删除', f.path);
    continue;
  }
  const buf = fs.readFileSync(f.path);
  const blob = await api('POST', '/repos/' + REPO + '/git/blobs', {
    content: buf.toString('base64'),
    encoding: 'base64'
  });
  const mode = git('ls-files -s -- "' + f.path + '"').split(' ')[0];
  entries.push({ path: f.path, mode, type: 'blob', sha: blob.sha });
  console.log('  ' + (f.status === 'A' ? '新增' : '修改'), f.path, buf.length + 'B');
}

const tree = await api('POST', '/repos/' + REPO + '/git/trees', {
  base_tree: remoteCommit.tree.sha,
  tree: entries
});

const commit = await api('POST', '/repos/' + REPO + '/git/commits', {
  message: info.message,
  tree: tree.sha,
  parents: [remoteSha],
  author: { name: info.authorName, email: info.authorEmail, date: info.authorDate },
  committer: { name: info.committerName, email: info.committerEmail, date: info.committerDate }
});

console.log('新远程 commit =', commit.sha.slice(0, 7), '本地', head.slice(0, 7));

await api('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false });
console.log(
  'heads/' + BRANCH + ' 已指向 ' + commit.sha.slice(0, 7),
  commit.sha === head ? '（SHA 与本地一致）' : '（SHA 不同）'
);
