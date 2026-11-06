import type { ServerResponse } from 'node:http';

export const MODEL = 'gpt-6.1-sol';
export const exec = (input: string, callId = 'call-exec') => ({
  type: 'custom_tool_call',
  id: `item-${callId}`,
  call_id: callId,
  namespace: 'functions',
  name: 'exec',
  input,
  status: 'completed',
});
export const spawn = {
  type: 'function_call',
  id: 'item-spawn',
  call_id: 'call-spawn',
  namespace: 'collaboration',
  name: 'spawn_agent',
  arguments: '{"task_name":"forbidden","message":"must never launch"}',
};
export const message = {
  type: 'message',
  id: 'message-final',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Synthetic terminal response.', annotations: [] }],
};
export const terminal = (id = 'response-1', output: any[] = [message]) => ({
  id,
  object: 'response',
  model: MODEL,
  status: 'completed',
  output,
  usage: {
    input_tokens: 100,
    total_tokens: 110,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});
export function stream(response: ServerResponse, value: any, transient: any[] = value.output) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...value, status: 'in_progress', output: [] } },
    ...transient.flatMap((item) => [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
    ]),
    { type: 'response.completed', response: value },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
