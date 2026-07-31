import { hostAdapter } from "@physicalsim/common";
import { Esp32Adapter } from "./adapter.js";

hostAdapter(new Esp32Adapter());
