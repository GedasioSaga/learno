/**
 * Os formulários que os botões desta pasta abrem — `CriarCartaoDeOrigem`
 * (cartão comum) e `CriarLacunaDeOrigem` (cartão de lacuna), os dois em
 * `src/features/cartoes/`. Este arquivo só é a ponte entre a store do
 * editor (`create-card-store.ts`) e o formulário que ela pediu.
 */
import { CriarCartaoDeOrigem } from "../../../cartoes/CriarCartaoDeOrigem";
import { CriarLacunaDeOrigem } from "../../../cartoes/CriarLacunaDeOrigem";
import { useCreateCardOverlayStore } from "./create-card-store";

export function CreateCardOverlay() {
  const open = useCreateCardOverlayStore((state) => state.open);
  const origem = useCreateCardOverlayStore((state) => state.origem);
  const lacuna = useCreateCardOverlayStore((state) => state.lacuna);
  const fechar = useCreateCardOverlayStore((state) => state.fechar);

  // Sem origem nenhuma ainda (nenhum clique nesta sessão do editor) não há
  // o que passar para formulário nenhum — cada um exige uma origem real.
  if (lacuna) return <CriarLacunaDeOrigem isOpen={open} origem={lacuna} onClose={fechar} />;
  if (origem) return <CriarCartaoDeOrigem isOpen={open} origem={origem} onClose={fechar} />;
  return null;
}
