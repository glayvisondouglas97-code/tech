#!/bin/sh
# Backup diário dos bancos (evolution e central) e das mídias, na pasta ./backups do servidor.
# Roda todo dia no horário BACKUP_HOUR (padrão 03h, horário de Brasília) e apaga cópias com mais de BACKUP_KEEP_DAYS dias.
# Para fazer um backup na hora:  docker compose exec backup sh /backup.sh agora

export TZ='<-03>3' # horário de Brasília (UTC-3)
DIR=/backups

backup_now() {
  STAMP=$(date +%Y-%m-%d_%H%M)
  OK=1
  for DB in evolution central; do
    if pg_dump -Fc -d "$DB" -f "$DIR/.$DB.tmp"; then
      mv "$DIR/.$DB.tmp" "$DIR/${DB}_$STAMP.dump"
    else
      rm -f "$DIR/.$DB.tmp"; OK=0; echo "[backup] ERRO ao copiar o banco $DB"
    fi
  done
  if tar czf "$DIR/.midias.tmp" -C /midias .; then
    mv "$DIR/.midias.tmp" "$DIR/midias_$STAMP.tar.gz"
  else
    rm -f "$DIR/.midias.tmp"; OK=0; echo "[backup] ERRO ao copiar as mídias"
  fi
  find "$DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.tar.gz' \) -mtime +"${BACKUP_KEEP_DAYS:-7}" -delete
  [ "$OK" = 1 ] && echo "[backup] $STAMP concluído: $(ls -1 "$DIR" | grep -c "$STAMP") arquivos em ./backups"
}

if [ "$1" = "agora" ]; then
  backup_now
  exit 0
fi

echo "[backup] ativo: todo dia às ${BACKUP_HOUR:-03}h, mantendo ${BACKUP_KEEP_DAYS:-7} dias"
LAST=""
while true; do
  if [ "$(date +%H)" = "${BACKUP_HOUR:-03}" ] && [ "$(date +%F)" != "$LAST" ]; then
    backup_now
    LAST=$(date +%F)
  fi
  sleep 60
done
