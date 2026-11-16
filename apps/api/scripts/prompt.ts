/**
 * A secret for a script: from the environment if set, otherwise typed with hidden input. Typing it
 * at the prompt keeps it out of shell history (privacy review M6).
 */
import { stdin, stdout } from 'node:process';

export async function secret(name: string, label: string): Promise<string> {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (!stdin.isTTY) throw new Error(`Set ${name}, or run this in a terminal to type it.`);
  stdout.write(`${label}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
