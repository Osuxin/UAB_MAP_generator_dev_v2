import type { GeneratedMap, GeneratorConfig } from "./mapGenerator";
export function generateMapInWorker(config: GeneratorConfig): Promise<GeneratedMap> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./generateMap.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ map?: GeneratedMap; error?: string }>) => {
      worker.terminate();
      if (event.data.map) resolve(event.data.map);
      else reject(new Error(event.data.error ?? "生成に失敗しました。"));
    };
    worker.onerror = () => { worker.terminate(); reject(new Error("生成処理を実行できませんでした。再度お試しください。")); };
    worker.postMessage(config);
  });
}
