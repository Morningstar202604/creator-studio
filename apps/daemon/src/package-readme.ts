/**
 * The README that goes inside an exported package.
 *
 * Split out of `server.ts` because it is pure formatting — given artifacts, produce
 * Markdown — and pure functions are the easiest thing to test and the easiest thing
 * to read away from a 2,700-line file.
 */

const KIND_LABELS: Record<string, string> = {
  'topic-card': '选题',
  'research-notes': '资料',
  script: '脚本',
  'shot-list': '分镜',
  subtitle: '字幕',
  'publish-pack': '包装',
  outline: '大纲',
  chapter: '章节',
  'review-report': '复盘',
};

/** Display name for an artifact kind; unknown kinds keep their key rather than guess. */
export function labelOf(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The order artifacts appear in a package README: pipeline order, not alphabetical. */
const PACKAGE_ORDER = [
  'topic-card',
  'research-notes',
  'outline',
  'script',
  'chapter',
  'shot-list',
  'subtitle',
  'publish-pack',
  'review-report',
];

export function buildPublishSummary(artifacts: Array<{ kind: string; path: string }>): string | null {
  const lines: string[] = ['# 发布包', '', '本发布包由稿台 Creator Studio 生成。', ''];
  for (const kind of PACKAGE_ORDER) {
    const found = artifacts.find((artifact) => artifact.kind === kind);
    if (found === undefined) continue;
    lines.push(`## ${labelOf(kind)}`, '', `- 文件：${found.path}`, '');
  }
  lines.push('生成时间：' + new Date().toISOString());
  return lines.join('\n');
}
