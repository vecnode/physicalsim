import { hostAdapter } from "@physicalsim/common";
import { Avr8JsAttiny85Adapter } from "./adapter-attiny85.js";

hostAdapter(new Avr8JsAttiny85Adapter());
