import { describe, expect, it } from "vitest";
import { CircuitPin, type PinClient } from "../circuit-pin.js";
import { Hd44780Decoder } from "./hd44780-decoder.js";

// Mirrors led-button.test.ts's own FakePinClient exactly.
class FakePinClient implements PinClient {
  values = new Map<string, number>();
  private pinChangeListeners = new Set<(pin: string, value: number) => void>();

  async call(method: string, params?: unknown): Promise<unknown> {
    if (method === "readPin") {
      const { pin } = params as { pin: string };
      return this.values.get(pin) ?? 0;
    }
    if (method === "writePin") {
      const { pin, value } = params as { pin: string; value: number };
      this.values.set(pin, value);
      for (const listener of this.pinChangeListeners) listener(pin, value);
      return undefined;
    }
    if (method === "subscribePin") return undefined;
    throw new Error(`unexpected method "${method}"`);
  }

  onPinChange(cb: (pin: string, value: number) => void): () => void {
    this.pinChangeListeners.add(cb);
    return () => this.pinChangeListeners.delete(cb);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Hd44780Decoder", () => {
  it("decodes the exact pulse sequence simulators/LiquidCrystal/src/LiquidCrystal.cpp produces", async () => {
    const client = new FakePinClient();
    const rs = new CircuitPin(client, "RS");
    const e = new CircuitPin(client, "E");
    const d4 = new CircuitPin(client, "D4");
    const d5 = new CircuitPin(client, "D5");
    const d6 = new CircuitPin(client, "D6");
    const d7 = new CircuitPin(client, "D7");

    let latest: Uint8Array | null = null;
    const decoder = new Hd44780Decoder({ rs, e, d4, d5, d6, d7 }, (chars) => {
      latest = chars;
    });
    await flush();

    // write4bits()'s exact effect: set the four data lines, then
    // pulseEnable() (E: low -> high -> low).
    async function pulseNibble(nibble: number): Promise<void> {
      await d4.write(nibble & 0x1 ? 1 : 0);
      await d5.write(nibble & 0x2 ? 1 : 0);
      await d6.write(nibble & 0x4 ? 1 : 0);
      await d7.write(nibble & 0x8 ? 1 : 0);
      await e.write(0);
      await e.write(1);
      await e.write(0);
    }

    // send()'s exact effect in 4-bit mode: RS once, then high nibble,
    // then low nibble.
    async function sendByte(byte: number, rsValue: number): Promise<void> {
      await rs.write(rsValue);
      await pulseNibble(byte >> 4);
      await pulseNibble(byte & 0x0f);
    }

    // begin()'s real 4-bit-mode reset dance: RS held low, four
    // standalone (unpaired) nibble pulses - 0x3, 0x3, 0x3, then 0x2.
    await rs.write(0);
    await pulseNibble(0x3);
    await pulseNibble(0x3);
    await pulseNibble(0x3);
    await pulseNibble(0x2);

    // begin()'s remaining setup, in the exact order it happens:
    // FUNCTION SET (4-bit, 2-line, 5x8), DISPLAY CONTROL (on), CLEAR,
    // ENTRY MODE SET (left/increment).
    await sendByte(0x28, 0);
    await sendByte(0x0c, 0);
    await sendByte(0x01, 0);
    await sendByte(0x06, 0);

    // lcd.print("Hi")
    await sendByte("H".charCodeAt(0), 1);
    await sendByte("i".charCodeAt(0), 1);

    expect(latest).not.toBeNull();
    const row0 = Array.from(latest!.slice(0, 2))
      .map((c) => String.fromCharCode(c))
      .join("");
    expect(row0).toBe("Hi");

    // lcd.setCursor(0, 1) -> SETDDRAMADDR | 0x40 (row 1's base address),
    // then lcd.print("!").
    await sendByte(0x80 | 0x40, 0);
    await sendByte("!".charCodeAt(0), 1);
    expect(String.fromCharCode(latest![16])).toBe("!");

    // lcd.clear()
    await sendByte(0x01, 0);
    expect(Array.from(latest!).every((c) => c === 0)).toBe(true);

    decoder.dispose();
  });

  it("blanks (but doesn't discard) the buffer while the display is off", async () => {
    const client = new FakePinClient();
    const rs = new CircuitPin(client, "RS");
    const e = new CircuitPin(client, "E");
    const d4 = new CircuitPin(client, "D4");
    const d5 = new CircuitPin(client, "D5");
    const d6 = new CircuitPin(client, "D6");
    const d7 = new CircuitPin(client, "D7");

    let latest: Uint8Array | null = null;
    const decoder = new Hd44780Decoder({ rs, e, d4, d5, d6, d7 }, (chars) => {
      latest = chars;
    });
    await flush();

    async function pulseNibble(nibble: number): Promise<void> {
      await d4.write(nibble & 0x1 ? 1 : 0);
      await d5.write(nibble & 0x2 ? 1 : 0);
      await d6.write(nibble & 0x4 ? 1 : 0);
      await d7.write(nibble & 0x8 ? 1 : 0);
      await e.write(0);
      await e.write(1);
      await e.write(0);
    }
    async function sendByte(byte: number, rsValue: number): Promise<void> {
      await rs.write(rsValue);
      await pulseNibble(byte >> 4);
      await pulseNibble(byte & 0x0f);
    }

    await sendByte(0x06, 0); // ENTRYMODESET (increment) - avoid relying on the class default
    await sendByte("A".charCodeAt(0), 1);
    expect(latest![0]).toBe("A".charCodeAt(0));

    await sendByte(0x08, 0); // DISPLAYCONTROL, D=0 (noDisplay())
    expect(latest!.every((c) => c === 0)).toBe(true);

    await sendByte(0x0c, 0); // DISPLAYCONTROL, D=1 (display())
    expect(latest![0]).toBe("A".charCodeAt(0));

    decoder.dispose();
  });
});
