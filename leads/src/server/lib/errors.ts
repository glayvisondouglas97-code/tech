/** Erro com mensagem já pronta para mostrar ao usuário (em português). */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = 'erro',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new AppError(400, msg, 'requisicao_invalida', details);
export const unauthorized = (msg = 'Sua sessão expirou. Entre de novo.') =>
  new AppError(401, msg, 'nao_autenticado');
export const forbidden = (msg = 'Você não tem permissão para fazer isso.') =>
  new AppError(403, msg, 'sem_permissao');
export const notFound = (msg = 'Não encontrado.') => new AppError(404, msg, 'nao_encontrado');
export const conflict = (msg: string, details?: Record<string, unknown>) =>
  new AppError(409, msg, 'conflito', details);
export const tooMany = (msg: string) => new AppError(429, msg, 'muitas_tentativas');
