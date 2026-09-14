import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// O padrão do `findBy*`/`waitFor` é 1 s, e várias telas gastam tempo REAL antes
// de renderizar (o debounce de 200 ms da busca, por exemplo). Com a suíte
// inteira disputando CPU, essa margem sumia e o teste falhava sem defeito
// nenhum — o flake do `SearchPalette`. Provado encurtando para 150 ms: os
// quatro testes que passam pelo debounce ficam vermelhos, os outros três não.
// Um defeito de verdade continua falhando; só demora mais para dizer.
configure({ asyncUtilTimeout: 5000 });
