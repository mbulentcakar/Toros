const args = process.argv.slice(2);
console.log(`args:${JSON.stringify(args)}`);

/**
 * Node Core hands every run its whole start context as one JSON object on
 * stdin: the run credential, the conversation it belongs to, and any operator
 * clarification. None of it may appear in argv.
 */
async function readStartContext(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

if (args[0] === 'slow-job') {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  process.exitCode = 0;
} else {
  const context = await readStartContext();
  console.log(`context:${JSON.stringify({
    has_run_token: typeof context['run_token'] === 'string',
    has_conversation: typeof context['conversation_id'] === 'string',
  })}`);
  if (typeof context['operator_message'] === 'string') {
    console.log(`reply:${context['operator_message']}`);
    process.exitCode = 0;
  } else {
    console.log('Which bounded option should I use?');
    process.exitCode = 3;
  }
}

export {};
