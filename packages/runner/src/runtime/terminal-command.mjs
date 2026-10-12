/**
 * Whether a session's shell is running a command, read off the marks the
 * shell writes around each one (terminal-bashrc): OSC 133, the FinalTerm
 * convention, `ESC ] 133 ; <mark> [; <params>]` ended by BEL or ST. C says a
 * command started; D, drawn with the next prompt, that it ended, with its
 * exit status. A D with no command before it (an empty line, Ctrl-C at the
 * prompt) ends nothing, as kitty reads it. A line the lane sends forgets the
 * last exit status: a line that starts no command (a comment, an unclosed
 * quote waiting at PS2) draws no C, and the status before it is not its own.
 *
 * The screen alone cannot say this: a program that goes quiet on a network
 * call reads the same as one waiting for input, and its half-printed output
 * the same as a finished one (a CLI's setup command silent for 940 ms, judged
 * on a screen cut before its last line). The marks reach the screen
 * and the recording as they came, and no emulator draws them.
 *
 * A PTY read may end inside a mark: the tail of each read, past the last
 * mark it completed, is read again with the next.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point.
const MARK = /\x1b\]133;([A-D])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/gu;
// Longer than any mark the shell writes: a mark split across reads starts in this tail.
const CARRY = 64;

export function createCommandState() {
  let pending = "";
  let running = false;
  let exitCode = null;
  return {
    /** @param {Buffer} chunk */
    write(chunk) {
      // latin1 maps each byte to one character: a mark is ASCII, and no
      // multibyte character a chunk splits can be mistaken for one.
      const text = pending + chunk.toString("latin1");
      let end = 0;
      for (const match of text.matchAll(MARK)) {
        end = match.index + match[0].length;
        if (match[1] === "C") running = true;
        if (match[1] === "D" && running) {
          running = false;
          const status = Number.parseInt(match[2] ?? "", 10);
          exitCode = Number.isSafeInteger(status) ? status : null;
        }
      }
      pending = text.slice(Math.max(end, text.length - CARRY));
    },
    /** The lane sent a line: until its C or D, no exit status is its own. */
    sent() {
      exitCode = null;
    },
    /** The shell has exited: nothing runs in it any more, and no D said how its last command ended. */
    end() {
      running = false;
      exitCode = null;
    },
    /**
     * Whether a command is running, and once none is, the exit status of the
     * last one that ended, when its D carried one.
     * @returns {{ running: boolean, exitCode?: number }}
     */
    read: () => (running || exitCode === null ? { running } : { running, exitCode }),
  };
}
