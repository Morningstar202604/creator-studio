/**
 * Pre-flight checks for a generation request.
 *
 * Every model call costs money and a few seconds. These checks run before the
 * request leaves the process, so an input that cannot produce a useful result is
 * refused with a reason instead of being paid for. They are deliberately shallow:
 * a sophisticated classifier here would itself be a model call, and the point is to
 * catch the obvious cases cheaply.
 *
 * This mirrors the "guardrails" idea from OpenAI's Agents SDK — fail fast, and say
 * what failed in words the user can act on.
 */

export type GuardFailure = {
  ok: false;
  code:
    | 'EMPTY_CONTEXT'
    | 'CONTEXT_TOO_LONG'
    | 'PROMPT_INJECTION_SUSPECTED';
  message: string;
};

export type GuardResult = { ok: true } | GuardFailure;

/**
 * Below this the context carries no information at all. Deliberately low: a short
 * topic like "选题" is a legitimate brief, and a length floor that rejects it would
 * be the guard inventing a rule the product does not have.
 */
const MIN_CONTEXT_CHARS = 1;
/** Above this, the prompt crowds out the model's own output budget. */
const MAX_CONTEXT_CHARS = 20_000;

/**
 * Phrases whose only purpose in a user turn is to replace the instructions above
 * it. Matched as whole ideas, not substrings: "指令" on its own is an ordinary
 * word, "忽略之前的所有指令" is not.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /忽略(之前|以上|前面)(的)?(所有)?(指令|提示|设定)/,
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /(输出|显示|重复)(你的)?(系统)(提示|指令|prompt)/,
  /system\s*prompt/i,
];

export function checkGenerationInput(input: { context: string }): GuardResult {
  const context = input.context;

  if (context.trim() === '') {
    return {
      ok: false,
      code: 'EMPTY_CONTEXT',
      message: '先说清这一步要做什么：给一句主题或要求。',
    };
  }

  if (context.trim().length < MIN_CONTEXT_CHARS) {
    return { ok: false, code: 'EMPTY_CONTEXT', message: '先说清这一步要做什么：给一句主题或要求。' };
  }

  if (context.length > MAX_CONTEXT_CHARS) {
    return {
      ok: false,
      code: 'CONTEXT_TOO_LONG',
      message: `上下文超过 ${MAX_CONTEXT_CHARS} 字，会挤占模型自己的输出空间。请只保留相关资料。`,
    };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(context)) {
      return {
        ok: false,
        code: 'PROMPT_INJECTION_SUSPECTED',
        message: '这段文本看起来在试图替换系统指令。请只描述你想要的创作内容。',
      };
    }
  }

  return { ok: true };
}
