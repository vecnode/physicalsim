import { hostAdapter } from "@physicalsim/common";
import { Avr8Adapter } from "./adapter.js";
import { ATTINY85 } from "./chip.js";

hostAdapter(new Avr8Adapter(ATTINY85));
