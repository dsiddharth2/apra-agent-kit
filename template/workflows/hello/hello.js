// Your workflow body. It receives a context with Fleet primitives and returns
// a value. Nothing here spawns Fleet or manages members — main.mjs does that.
export const meta = { name: 'hello' };

export async function main(context) {
  const { command, agent, log, args } = context;
  const who = args?.name ?? 'world';

  log(`greeting ${who}`);

  // 'doer' and 'reviewer' are reserved keywords. The kit resolves them to the
  // worker pair this run leased. Never name a member directly — doing so
  // collides with other runs.
  const host = await command('hostname', { member_name: 'doer' });

  const greeting = await agent(
    `Say hello to ${who} in one short, friendly sentence.`,
    { member_name: 'doer' },
  );

  return { who, host, greeting };
}
