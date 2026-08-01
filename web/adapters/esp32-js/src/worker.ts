import { hostAdapter } from "@physicalsim/common";
import { Esp32JsAdapter } from "./adapter.js";

hostAdapter(new Esp32JsAdapter());
