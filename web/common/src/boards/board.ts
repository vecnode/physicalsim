// Maps a board's logical pin names (e.g. "D13", printed on the silkscreen)
// to the adapter-specific pin id a SimulatorAdapter actually understands
// (e.g. avr8's "B5"). One map per board; same shape regardless of which
// adapter kind backs it.
export type BoardPinMap = Record<string, string>;

export function resolvePin(board: BoardPinMap, name: string): string {
  const resolved = board[name];
  if (resolved === undefined) {
    throw new Error(`Unknown pin "${name}" for this board`);
  }
  return resolved;
}
