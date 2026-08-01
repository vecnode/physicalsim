import { hostAdapter } from "@physicalsim/common";
import { Rp2040JsAdapter } from "./adapter.js";

hostAdapter(new Rp2040JsAdapter());
