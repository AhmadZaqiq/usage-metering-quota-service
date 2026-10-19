import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

/** Thrown by input helpers when stdin reaches EOF (piped or Ctrl-D). */
export class EofError extends Error {
  constructor() {
    super('stdin closed');
  }
}

export interface Prompter {
  yesNo(prompt: string, defaultYes?: boolean): Promise<boolean>;
}

/**
 * The input surface SimContext depends on: everything prompts need, minus
 * Menu's lifecycle methods. Keeping SimContext on this interface (rather than
 * the Menu class) lets tests supply a deterministic fake — Menu's private
 * readline state makes it structurally impossible to fake otherwise.
 */
export interface MenuInput extends Prompter {
  text(prompt: string): Promise<string>;
  choice(prompt: string, min: number, max: number): Promise<number>;
  positiveInt(prompt: string): Promise<string>;
}

/**
 * Menu input over readline. Lines are consumed sequentially; when stdin is a
 * pipe the input line is echoed after the prompt so the transcript stays
 * readable (a terminal echoes keystrokes itself). EOF is surfaced as
 * EofError instead of hanging, so scripted runs terminate cleanly.
 */
export class Menu implements MenuInput {
  private readonly rl: readline.Interface;
  private readonly queue: string[] = [];
  private readonly waiters: ((line: string | null) => void)[] = [];
  private ended = false;
  private readonly echoInput: boolean;

  constructor() {
    this.echoInput = !input.isTTY;
    this.rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.queue.push(line);
        return;
      }
      if (this.echoInput) output.write(`${line}\n`);
      waiter(line);
    });
    this.rl.on('close', () => {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /** Returns null on EOF; callers surface it as EofError. */
  private async ask(prompt: string): Promise<string | null> {
    output.write(prompt);
    const queued = this.queue.shift();
    if (queued !== undefined) {
      if (this.echoInput) output.write(`${queued}\n`);
      return queued;
    }
    if (this.ended) return null;
    return new Promise<string | null>((resolve) => this.waiters.push(resolve));
  }

  private async askRequired(prompt: string): Promise<string> {
    const line = await this.ask(prompt);
    if (line === null) throw new EofError();
    return line;
  }

  async text(prompt: string): Promise<string> {
    return (await this.askRequired(prompt)).trim();
  }

  async choice(prompt: string, min: number, max: number): Promise<number> {
    for (;;) {
      const raw = await this.askRequired(prompt);
      const n = Number(raw.trim());
      if (Number.isInteger(n) && n >= min && n <= max) return n;
      output.write(`  Please enter a number between ${min} and ${max}.\n`);
    }
  }

  async positiveInt(prompt: string): Promise<string> {
    for (;;) {
      const raw = (await this.askRequired(prompt)).trim();
      if (/^[1-9]\d*$/.test(raw)) return raw;
      output.write('  Please enter a positive whole number.\n');
    }
  }

  async yesNo(prompt: string, defaultYes = false): Promise<boolean> {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    for (;;) {
      const raw = (await this.askRequired(`${prompt} ${hint} `)).trim().toLowerCase();
      if (raw === '') return defaultYes;
      if (raw === 'y' || raw === 'yes') return true;
      if (raw === 'n' || raw === 'no') return false;
      output.write('  Please answer y or n.\n');
    }
  }

  close(): void {
    this.rl.close();
  }
}
