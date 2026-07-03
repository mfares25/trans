import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Runs a one-shot prompt through the local Claude Code CLI (`claude -p`) instead
 * of the Anthropic API — uses the logged-in Claude Code session, no API key needed.
 */
export async function askClaude(systemPrompt, userPrompt, { model = 'haiku' } = {}) {
  const { stdout } = await execFileAsync('claude', [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--system-prompt', systemPrompt,
    '--disallowedTools', '*',
    '--no-session-persistence',
    userPrompt,
  ], {
    cwd: '/tmp',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });

  const parsed = JSON.parse(stdout);
  if (parsed.is_error) throw new Error(`claude CLI error: ${parsed.result}`);
  return parsed.result.trim();
}
