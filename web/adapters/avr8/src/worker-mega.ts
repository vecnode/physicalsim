import { hostAdapter } from "@physicalsim/common";
import { Avr8Adapter } from "./adapter.js";
import { ATMEGA2560 } from "./chip.js";

hostAdapter(new Avr8Adapter(ATMEGA2560));
