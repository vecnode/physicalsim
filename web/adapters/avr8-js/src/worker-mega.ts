import { hostAdapter } from "@physicalsim/common";
import { Avr8JsAdapter } from "./adapter.js";

// Arduino Mega 2560's pin shape (54 digital + 16 analog) - see
// adapter.ts's own Avr8JsPinShape/UNO_PIN_SHAPE doc comments for why
// this needs its own worker entry point rather than sharing worker.ts's
// default-shaped instance.
hostAdapter(new Avr8JsAdapter({ digitalPinCount: 54, analogPinCount: 16 }));
