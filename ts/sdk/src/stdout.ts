// stdout carries only protocol frames. Importing the SDK first keeps it that way: whatever
// a harness or its extensions print, with console.log or process.stdout.write, goes to stderr.

const write = process.stdout.write.bind(process.stdout);

/** The real stdout, for protocol frames only. */
export const protocolOutput = {
  write(frame: string): boolean {
    return write(frame);
  },
};

const toStderr = (...values: unknown[]) => console.error(...values);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
  (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
