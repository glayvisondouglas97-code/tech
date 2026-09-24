// Fila única: as gravações no banco rodam uma de cada vez. Isso evita que dois webhooks
// simultâneos do mesmo lead criem o contato ou a conversa em duplicidade.
let tail: Promise<unknown> = Promise.resolve();

export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task);
  tail = result.catch(() => {});
  return result;
}
