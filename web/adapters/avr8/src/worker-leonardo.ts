import { hostAdapter } from "@physicalsim/common";
import { Avr8Adapter } from "./adapter.js";
import { ATMEGA32U4 } from "./chip.js";

hostAdapter(new Avr8Adapter(ATMEGA32U4));
