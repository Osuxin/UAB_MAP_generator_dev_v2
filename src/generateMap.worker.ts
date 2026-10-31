import { generateMap, type GeneratorConfig } from "./mapGenerator";
self.onmessage = (event: MessageEvent<GeneratorConfig>) => {
  try { self.postMessage({ map: generateMap(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "生成に失敗しました。" }); }
};
