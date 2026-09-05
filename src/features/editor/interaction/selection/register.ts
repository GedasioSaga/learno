/**
 * Ponto de registro da seleção múltipla de blocos e suas ações
 * (EDT-053/054/055/057/058/059). Um único registro: tudo aqui é
 * comportamento de interação (teclado, mouse, clipboard), não um tipo de
 * bloco, item de menu ou painel flutuante - só o ponto 1 do README
 * (`registerBlockExtension`) se aplica.
 */
import { registerBlockExtension } from "../../core/registry";
import { BlockSelectionExtension } from "./selection-extension";
import "./selection.css";

registerBlockExtension(BlockSelectionExtension);
