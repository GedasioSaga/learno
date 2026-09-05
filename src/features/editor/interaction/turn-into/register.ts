/**
 * EDT-049: "Turn into" - registers the block-handle extension so the menu
 * is available in every real editor instance. Discovered automatically by
 * `core/discover-extensions.ts`'s `import.meta.glob`; nothing imports this
 * file directly. See `turn-into-handle.ts` for the actual behavior and its
 * DOM/CSS contract with `interaction/drag/`.
 */
import "./turn-into-handle.css";
import { registerBlockExtension } from "../../core/registry";
import { TurnIntoBlockHandle } from "./turn-into-handle";

registerBlockExtension(TurnIntoBlockHandle);
