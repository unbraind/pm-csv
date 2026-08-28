/**
 * Tokenises shell text into the commands it would actually run.
 *
 * A guard that decides "does any publish here omit `--provenance`" is only as
 * good as its idea of what a command is. The previous scan answered that
 * question with a regular expression: it blanked every quoted span so an
 * advisory `echo "npm publish"` could not read as an invocation, then split the
 * remainder on `&&`, `||`, `;` and a space-surrounded `|`.
 *
 * Both halves of that shortcut are wrong in the same direction -- they make the
 * gate report a pass it has not earned:
 *
 * - Blanking quoted spans deletes the argument being audited. `npm publish
 *   "--provenance"` runs with an attestation but scans as one without, and the
 *   reverse case is worse: `eval "npm publish"` and `bash -c 'npm publish'` are
 *   real unattested publishes that vanish entirely, leaving a conventional
 *   attested sibling elsewhere in the file to carry the audit to green.
 * - Splitting on three operators misses a backgrounding `&`, a pipe written
 *   without surrounding spaces (`true|npm publish`), and command substitution.
 *
 * So the text is tokenised the way a shell does it -- quotes resolved rather
 * than erased, operators recognised as operators, `$(...)`, backticks, `eval`
 * and `sh -c` payloads recursed into -- and each command records whether its
 * words were quoted. Nothing downstream has to guess.
 *
 * This is deliberately not a shell. It does not expand variables, globs or
 * arithmetic, and it does not track redirections. It exists to enumerate
 * candidate command invocations for auditing, where missing one is a security
 * failure and inventing one is merely noise.
 *
 * @packageDocumentation
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One word of a command, after quote resolution. */
export interface ShellToken {
  /** The word's text with its quoting removed. */
  value: string;
  /** True when any part of the word came from inside quotes. */
  quoted: boolean;
}

/** One simple command: the words it would run, in order. */
export type ShellCommand = ShellToken[];

/**
 * Words that precede a command without being the command.
 *
 * `env FOO=bar npm publish` runs npm, not env, so a scan that reads the first
 * word as the command name would classify it as an `env` invocation and let the
 * publish through unaudited.
 *
 * The package runners (`npx`, `bunx`, `pnpx`) belong here for the same reason,
 * and they bring their own options: `npx --yes npm publish` runs npm behind two
 * words, not one. Option words following a prefix are therefore skipped too --
 * see `skipCommandPrefix`, which is where that rule is applied and bounded.
 *
 * Runners spelled as two words live in `TWO_WORD_PREFIXES` instead, because
 * their head word is only a wrapper in combination with the word after it.
 */
const COMMAND_PREFIXES = new Set([
  "env",
  "exec",
  "nohup",
  "command",
  "builtin",
  "sudo",
  "doas",
  "nice",
  "ionice",
  "time",
  "stdbuf",
  "setsid",
  "xargs",
  "npx",
  "bunx",
  "pnpx",
]);

/**
 * Wrappers spelled as two words, mapped to the second word that completes them.
 *
 * `pnpm dlx npm publish` runs npm, but `pnpm publish` runs pnpm's own publish
 * and `pnpm install` runs no wrapper at all. Consuming the head word
 * unconditionally would therefore re-point an unrelated `pnpm` command at its
 * first argument, so the pair is only consumed when the second word matches.
 */
const TWO_WORD_PREFIXES = new Map([
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x", "run"])],
]);

/**
 * Reduce a program word to the name it runs.
 *
 * `/usr/local/bin/npm publish` runs npm, so a check against the whole word
 * would miss it. `String.prototype.split` always yields at least one element,
 * including for the empty string, so no fallback is needed or reachable here.
 *
 * @param word - The program word as written.
 * @returns The final path segment.
 */
function basename(word: string): string {
  const segments = word.split("/");
  return segments[segments.length - 1]!;
}

/** Commands whose string argument is itself shell text to be scanned. */
const SHELL_EVALUATORS = new Set(["eval", "bash", "sh", "dash", "zsh", "ksh"]);

/** True when the character ends a word outside of quotes. */
function isOperatorStart(character: string): boolean {
  return character === ";"
    || character === "&"
    || character === "|"
    || character === "\n"
    || character === "("
    || character === ")"
    || character === "{"
    || character === "}";
}

/**
 * Read a `$(...)` or backtick substitution and return its inner text.
 *
 * Nesting is counted so `$(echo $(npm publish))` yields the whole inner body
 * rather than stopping at the first `)`; a truncated body would drop the
 * invocation it contains.
 *
 * @param text - The full text being scanned.
 * @param start - Index of the character that opens the substitution.
 * @returns The inner text and the index just past the closing delimiter.
 */
function readSubstitution(text: string, start: number): { inner: string; end: number } {
  if (text[start] === "`") {
    const close = text.indexOf("`", start + 1);
    if (close === -1) return { inner: text.slice(start + 1), end: text.length };
    return { inner: text.slice(start + 1, close), end: close + 1 };
  }
  let depth = 1;
  let index = start + 2;
  while (index < text.length && depth > 0) {
    const character = text[index]!;
    if (character === "\\") index += 1;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth === 0) break;
    index += 1;
  }
  return { inner: text.slice(start + 2, index), end: index + 1 };
}

/**
 * Split shell text into the simple commands it contains.
 *
 * Command substitutions are scanned as well as the command containing them,
 * because `VERSION=$(npm publish)` runs a publish however unusual that is, and a
 * gate that only looked at the outer assignment would miss it.
 *
 * `eval`, `bash -c` and their siblings receive the same treatment one level
 * deeper: their string argument is re-tokenised, so a publish smuggled through
 * an interpreter is enumerated alongside a plain one. Recursion is bounded --
 * shell text that nests evaluators more than a handful of levels deep is not
 * something this repository writes, and an unbounded walk over hostile input is
 * a denial of service rather than a stronger audit.
 *
 * @param text - Shell text, typically one file or one manifest script body.
 * @param depth - Current evaluator recursion depth; callers pass nothing.
 * @returns Every simple command found, outermost first.
 */
export function tokenizeCommands(text: string, depth = 0): ShellCommand[] {
  if (depth > 8) return [];
  const commands: ShellCommand[] = [];
  const nested: string[] = [];
  let command: ShellCommand = [];
  let value = "";
  let quoted = false;
  let started = false;

  const endWord = (): void => {
    if (!started) return;
    command.push({ value, quoted });
    value = "";
    quoted = false;
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "#" && !started) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      endCommand();
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      index += 1;
      if (next === undefined) break;
      if (next === "\n") continue;
      value += next;
      started = true;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      value += text.slice(index + 1, end);
      quoted = true;
      started = true;
      index = end;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]!;
        if (inner === "\\") {
          const next = text[index + 1];
          if (next !== undefined) {
            if (next !== "\n") value += next;
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (inner === "`" || (inner === "$" && text[index + 1] === "(")) {
          const { inner: body, end } = readSubstitution(text, index);
          nested.push(body);
          index = end;
          continue;
        }
        value += inner;
        index += 1;
      }
      quoted = true;
      started = true;
      continue;
    }
    if (character === "`" || (character === "$" && text[index + 1] === "(")) {
      const { inner, end } = readSubstitution(text, index);
      nested.push(inner);
      index = end - 1;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      endWord();
      continue;
    }
    if (isOperatorStart(character)) {
      endCommand();
      continue;
    }
    value += character;
    started = true;
  }
  endCommand();

  for (const body of nested) commands.push(...tokenizeCommands(body, depth + 1));
  for (const found of [...commands]) {
    const name = commandName(found);
    if (name === undefined || !SHELL_EVALUATORS.has(name)) continue;
    for (const argument of found.slice(1)) {
      if (argument.value.startsWith("-")) continue;
      commands.push(...tokenizeCommands(argument.value, depth + 1));
    }
  }
  return commands;
}

/**
 * Walk past the words that precede the program a command runs.
 *
 * Three kinds of word are not the program: a leading `NAME=value` assignment, a
 * wrapper listed in `COMMAND_PREFIXES`, and -- only once a wrapper has been
 * seen -- that wrapper's own options. The last rule is what reaches the publish
 * in `npx --yes npm publish`; it stays behind the wrapper condition so that a
 * command whose own first word is an option is still reported as written rather
 * than silently re-pointed at one of its arguments.
 *
 * An option's separate value (`sudo -u root npm publish`) is not skipped,
 * because which options take a value differs per wrapper, and guessing wrong
 * would move the reported program rather than merely widen the search.
 *
 * @param command - One simple command's tokens.
 * @returns The index of the program word, or the command's length when there is none.
 */
function skipCommandPrefix(command: ShellCommand): number {
  let index = 0;
  let sawPrefix = false;
  while (index < command.length) {
    const token = command[index]!;
    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      index += 1;
      continue;
    }
    const base = basename(token.value);
    if (COMMAND_PREFIXES.has(base)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    const second = command[index + 1];
    if (second !== undefined && TWO_WORD_PREFIXES.get(base)?.has(second.value) === true) {
      sawPrefix = true;
      index += 2;
      continue;
    }
    if (sawPrefix && !token.quoted && token.value.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * Name the program a command runs, or nothing when it runs none.
 *
 * Leading `NAME=value` assignments and wrapper words are skipped, and a path is
 * reduced to its basename so `/usr/local/bin/npm publish` is recognised. The
 * distinction this exists to draw is command *position*: `echo npm publish`
 * prints three words and publishes nothing, while the previous scan searched
 * the whole line for the word `npm` and counted it as an invocation.
 *
 * @param command - One simple command's tokens.
 * @returns The program's basename, or undefined for an empty or assignment-only command.
 */
export function commandName(command: ShellCommand): string | undefined {
  const token = command[skipCommandPrefix(command)];
  return token === undefined ? undefined : basename(token.value);
}

/**
 * List a command's arguments -- everything after its program name.
 *
 * @param command - One simple command's tokens.
 * @returns The argument tokens, in order.
 */
export function commandArguments(command: ShellCommand): ShellToken[] {
  return command.slice(skipCommandPrefix(command) + 1);
}

/** A tracked file's path and contents. */
export interface SourceFile {
  /** Repository-relative path. */
  file: string;
  /** File contents. */
  text: string;
}

/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name mapped to the flag text it holds.
 */
export function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(([\s\S]*?)\)/g)) {
    arrays.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return arrays;
}

/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * An unknown name is left untouched rather than erased: silently dropping it
 * would turn "this scan does not understand the command" into "this command has
 * no flags", which reads as a pass.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
export function expandArrays(line: string, arrays: Map<string, string>): string {
  return line.replace(/"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/g, (whole, name: string) =>
    arrays.get(name) ?? whole);
}

/** The outcome of one verifier run. */
export interface VerifierResult {
  /** Reasons the run failed; empty means it passed. */
  failures: string[];
  /** Lines describing what was checked, for the operator. */
  notes: string[];
}

