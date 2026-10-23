import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ScriptedTurn =
  | { kind: 'text'; text: string; usage?: { input: number; output: number } }
  | { kind: 'tool_call'; id: string; name: string; args: unknown; usage?: { input: number; output: number } }
  | { kind: 'tool_calls'; calls: Array<{ id: string; name: string; args: unknown }>; usage?: { input: number; output: number } }
  | { kind: 'status'; status: number; body: string };

export type RecordedRequest = {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * A real HTTP server that speaks the OpenAI streaming protocol. It serves one
 * scripted turn per request, in order, so a multi-step agent loop can be
 * exercised over an actual socket instead of a stubbed fetch.
 */
export class FakeOpenAiServer {
  private turns: ScriptedTurn[] = [];
  private server = createServer((req, res) => this.handle(req, res));
  private cursor = 0;

  readonly requests: RecordedRequest[] = [];
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  script(turns: ScriptedTurn[]): void {
    this.turns = turns;
    this.cursor = 0;
  }

  reset(): void {
    this.turns = [];
    this.cursor = 0;
    this.requests.length = 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    this.requests.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers });

    const turn = this.turns[this.cursor];
    this.cursor += 1;

    if (turn === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no scripted turn left' }));
      return;
    }

    if (turn.kind === 'status') {
      res.writeHead(turn.status, { 'content-type': 'application/json' });
      res.end(turn.body);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    if (turn.kind === 'text') {
      for (const piece of splitText(turn.text)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    } else {
      const calls = turn.kind === 'tool_call' ? [{ id: turn.id, name: turn.name, args: turn.args }] : turn.calls;
      for (const [index, call] of calls.entries()) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        const json = JSON.stringify(call.args);
        for (const piece of splitText(json)) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index, function: { arguments: piece } }],
                  },
                },
              ],
            })}\n\n`,
          );
        }
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    }

    const usage = turn.usage ?? { input: 20, output: 8 };
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  }
}

function splitText(text: string): string[] {
  if (text.length <= 3) return [text];
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}
