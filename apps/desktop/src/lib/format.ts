export const STAGES: Array<{ key: string; label: string; short: string }> = [
  { key: 'topic', label: '选题', short: '选题' },
  { key: 'research', label: '资料', short: '资料' },
  { key: 'script', label: '脚本', short: '脚本' },
  { key: 'shotlist', label: '分镜', short: '分镜' },
  { key: 'package', label: '包装', short: '包装' },
  { key: 'published', label: '发布', short: '发布' },
  { key: 'review', label: '复盘', short: '复盘' },
];

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
  image: '图片',
  audio: '音频',
  other: '其他',
};

export function stageIndex(stage: string): number {
  return STAGES.findIndex((entry) => entry.key === stage);
}

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

export function stageLink(projectId: string, stage: string): string {
  if (stage === 'published') return `/p/${projectId}/publish`;
  if (stage === 'review') return `/p/${projectId}/review`;
  return `/p/${projectId}/${stage}`;
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
