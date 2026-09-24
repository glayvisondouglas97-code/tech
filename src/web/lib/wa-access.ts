import { useCallback } from 'react';
import type { InstanceInfo } from '../../shared/conversations';
import { useSession } from './session';

/**
 * Quem apaga mensagens e conversas de um número (e exclui o número): o responsável por ele ou
 * dono/administrador. A mesma regra vale no servidor.
 */
export function useCanManageNumber() {
  const { me, can } = useSession();
  return useCallback(
    (instance: Pick<InstanceInfo, 'owner'> | undefined) =>
      can('manageNumbers') || (!!instance?.owner && instance.owner.id === me?.id),
    [me, can],
  );
}
