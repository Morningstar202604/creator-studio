/**
 * Some OpenAI-compatible providers ignore `response_format` and keep answering with
 * prose. Appending a strict output contract to the last user message is the most
 * portable nudge: every adapter forwards messages verbatim.
 */
export function jsonInstruction(raw: string): string {
  return `${raw}

【输出契约】只输出一个 JSON 对象，第一个字符必须是 {，最后一个字符必须是 }。
不要 Markdown 围栏，不要前后解释，不要使用未转义的换行。`;
}
