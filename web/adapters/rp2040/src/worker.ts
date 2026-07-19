import { hostAdapter } from "@physicalsim/common";
import { Rp2040Adapter } from "./adapter.js";

hostAdapter(new Rp2040Adapter());
