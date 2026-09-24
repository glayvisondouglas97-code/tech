/**
 * Limite de tentativas de login por e-mail (além do limite por IP da rota).
 * 5 erros em 15 minutos bloqueiam o e-mail até a janela passar.
 * Fica em memória: basta para um servidor só. Com vários servidores, trocar por uma tabela ou Redis.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

interface Entry {
  failures: number[];
}

export class LoginLimiter {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly max = MAX_FAILURES,
    private readonly windowMs = WINDOW_MS,
  ) {}

  private recent(key: string): number[] {
    const e = this.entries.get(key);
    if (!e) return [];
    const now = Date.now();
    e.failures = e.failures.filter((t) => now - t < this.windowMs);
    if (!e.failures.length) this.entries.delete(key);
    return e.failures;
  }

  /** Minutos até liberar, ou 0 se pode tentar. */
  blockedFor(key: string): number {
    const f = this.recent(key);
    if (f.length < this.max) return 0;
    const oldest = f[0] ?? Date.now();
    return Math.max(1, Math.ceil((oldest + this.windowMs - Date.now()) / 60_000));
  }

  fail(key: string): void {
    const f = this.recent(key);
    f.push(Date.now());
    this.entries.set(key, { failures: f });
    if (this.entries.size > 10_000) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}
