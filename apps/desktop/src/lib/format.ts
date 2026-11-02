export const PLATFORM_LABELS: Record<string, string> = {
  bilibili: 'B 站',
  youtube: 'YouTube',
  xiaohongshu: '小红书',
  generic: '通用',
};

export const ARTIFACT_LABELS: Record<string, string> = {
  'topic-card': '选题卡',
  'research-notes': '资料卡',
  script: '脚本',
  'shot-list': '分镜表',
  subtitle: '字幕',
  'publish-pack': '发布包',
  'review-report': '复盘报告',
  outline: '大纲',
  chapter: '章节',
  image: '图片',
  audio: '音频',
  other: '其他',
};

export type StageLike = { key: string; label: string };

/** Stage index inside a scenario pack; -1 when the stage is not part of it. */
export function stageIndexIn(stages: StageLike[], stage: string): number {
  return stages.findIndex((entry) => entry.key === stage);
}

export type RoutableStage = StageLike & {
  view?: string;
  entityType?: string;
  board?: unknown;
};

/**
 * Route for a stage, decided by the view the pack declares.
 *
 * A stage key alone is not enough: `chapter` is a card board in one pack and a
 * writing surface in another, and a custom pack may invent `premise` or `scene`.
 * Keying on the view means a new scenario works without touching the router, while
 * the video keys keep their dedicated URLs.
 */
export function stageHref(projectId: string, stage: RoutableStage): string {
  if (stage.view === 'document' && stage.entityType !== undefined) {
    return `/p/${projectId}/write/${stage.entityType}`;
  }
  if ((stage.view === 'entities' || stage.view === 'board') && stage.entityType !== undefined) {
    return `/p/${projectId}/cards/${stage.entityType}${stage.board === undefined ? '' : '?board=1'}`;
  }
  if (stage.view === 'publish') return `/p/${projectId}/publish`;
  if (stage.view === 'review') return `/p/${projectId}/review`;
  if (stage.key === 'published') return `/p/${projectId}/publish`;
  if (stage.key === 'review') return `/p/${projectId}/review`;
  if (VIDEO_STAGE_ROUTES.has(stage.key)) return `/p/${projectId}/${stage.key}`;
  // Any other generate stage gets the generic stage page, which resolves the
  // artifact kind from the pack at runtime.
  return `/p/${projectId}/stage/${stage.key}`;
}

const VIDEO_STAGE_ROUTES = new Set(['topic', 'research', 'script', 'shotlist', 'package']);

export function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatCny(value: number): string {
  if (value === 0) return '¥0';
  if (value < 0.01) return `¥${value.toFixed(4)}`;
  if (value < 1) return `¥${value.toFixed(3)}`;
  return `¥${value.toFixed(2)}`;
}

export function formatNumber(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

export const INTERVAL_PRESETS: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: '每小时' },
  { minutes: 360, label: '每 6 小时' },
  { minutes: 720, label: '每 12 小时' },
  { minutes: 1440, label: '每天' },
  { minutes: 10080, label: '每周' },
];

export function intervalLabel(minutes: number): string {
  const preset = INTERVAL_PRESETS.find((entry) => entry.minutes === minutes);
  if (preset !== undefined) return preset.label;
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes < 1440) return `每 ${Math.round(minutes / 60)} 小时`;
  return `每 ${Math.round(minutes / 1440)} 天`;
}
