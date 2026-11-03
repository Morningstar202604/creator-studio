/**
 * Pushes the local repository to a GitHub repo using the Git Data API.
 *
 * Why not `git push`: github.com:443 is unreachable from this network (the git
 * transport connects to the main host, which is blocked), while api.github.com
 * works. The Git Data API exposes the same primitives git uses over HTTP — blobs,
 * trees, commits, refs — so the push is possible without the git protocol.
 *
 * It preserves history: the previous remote tip becomes the parent of a new
 * commit whose tree is this working copy's tree. Nothing is force-overwritten.
 *
 * Usage: node scripts/gh-push.mjs <owner/repo> <token> [branch]
 */

import { execFileSync } from 'node:child_process';

const [repo, token, branch = 'main'] = process.argv.slice(2);
if (!repo || !token) {
  console.error('usage: node scripts/gh-push.mjs <owner/repo> <token> [branch]');
  process.exit(2);
}

const API = 'https://api.github.com';
const headers = {
  // `token` scheme, not `Bearer`: the classic PAT is rejected by the blob endpoint
  // under Bearer even though /user accepts it.
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'creator-studio-sync',
  'Content-Type': 'application/json',
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${String(text).slice(0, 300)}`);
  }
  return data;
}

const localHead = git('rev-parse', 'HEAD');
const localMessage = git('log', '-1', '--format=%s%n%n%b');
const authorName = git('log', '-1', '--format=%an');
const authorEmail = git('log', '-1', '--format=%ae');
const authorDate = git('log', '-1', '--format=%aI');

console.log(`local HEAD ${localHead.slice(0, 7)} → ${repo} (${branch})`);

// Current remote tip, if any. Its tree is reused only for the parent link.
let parentSha = null;
try {
  const ref = await call('GET', `/repos/${repo}/git/ref/heads/${branch}`);
  parentSha = ref.object.sha;
  console.log(`remote tip ${parentSha.slice(0, 7)}`);
} catch {
  console.log('remote branch does not exist yet; creating it');
}

/**
 * Reuses blobs the remote already has.
 *
 * A full upload of 354 files is 354 round trips and takes minutes; most of them
 * are unchanged. The remote tree is read once, and any file whose local git blob
 * hash matches the remote entry is skipped entirely. Git's blob id is a SHA-1 of
 * the same content, so the comparison is exact, not a heuristic.
 */
const remoteBlobs = new Map();
if (parentSha !== null) {
  const parentCommit = await call('GET', `/repos/${repo}/git/commits/${parentSha}`);
  const rootTree = await call('GET', `/repos/${repo}/git/trees/${parentCommit.tree.sha}?recursive=1`);
  for (const entry of rootTree.tree ?? []) {
    if (entry.type === 'blob') remoteBlobs.set(entry.path, entry.sha);
  }
  console.log(`remote already has ${remoteBlobs.size} blobs`);
}

const blobCache = new Map();
let uploaded = 0;

async function uploadBlob(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  // Local blob id: identical content means the remote already stores this byte for
  // byte, so no upload is needed.
  const localSha = git('rev-parse', `HEAD:${path}`);
  if (remoteBlobs.get(path) === localSha) {
    blobCache.set(path, localSha);
    return localSha;
  }
  const content = execFileSync('git', ['show', `HEAD:${path}`], { maxBuffer: 1 << 28 });
  const blob = await call('POST', `/repos/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  uploaded += 1;
  blobCache.set(path, blob.sha);
  return blob.sha;
}

const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);
console.log(`${files.length} files to upload`);

/** Builds the tree for one directory level from a flat list of paths. */
async function buildTree(prefix) {
  const entries = [];
  const subdirs = new Set();

  for (const path of files) {
    if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
    const rest = prefix === '' ? path : path.slice(prefix.length + 1);
    if (rest === '') continue;
    if (rest.includes('/')) {
      subdirs.add(rest.split('/')[0]);
      continue;
    }
    const sha = await uploadBlob(path);
    entries.push({ path: rest, mode: '100644', type: 'blob', sha });
  }

  for (const dir of subdirs) {
    const sha = await buildTree(prefix === '' ? dir : `${prefix}/${dir}`);
    entries.push({ path: dir, mode: '040000', type: 'tree', sha });
  }

  // A nested tree must be created and its sha returned; only the root caller wants
  // the raw entry list.
  if (prefix === '') return entries;
  const created = await call('POST', `/repos/${repo}/git/trees`, { tree: entries });
  return created.sha;
}

const rootEntries = await buildTree('');
const tree = await call('POST', `/repos/${repo}/git/trees`, { tree: rootEntries });
console.log(`tree ${tree.sha.slice(0, 7)} — ${uploaded} blobs uploaded, ${files.length - uploaded} reused`);

const commit = await call('POST', `/repos/${repo}/git/commits`, {
  message: localMessage,
  tree: tree.sha,
  parents: parentSha === null ? [] : [parentSha],
  author: { name: authorName, email: authorEmail, date: authorDate },
  committer: { name: authorName, email: authorEmail, date: authorDate },
});
console.log(`commit ${commit.sha.slice(0, 7)}`);

if (parentSha === null) {
  await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
} else {
  await call('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
}
console.log(`updated ${branch} → ${commit.sha.slice(0, 7)}`);
