"""Banco de dados do 3DE: PostgreSQL (Supabase) com reserva em memória.

Com a variável de ambiente ``DATABASE_URL`` (a "connection string" do Supabase),
tudo vai para o PostgreSQL e sobrevive aos reinícios do servidor no Render:

- ``arquivos``: peças geradas pelo Digitalizador (.3de) e STL enviados ao editor,
  acessados por um token secreto e apagados depois de um tempo;
- ``projetos``: projetos salvos no editor, separados por "dono" (uma chave
  aleatória que cada navegador cria para si; o site não tem login).

Sem ``DATABASE_URL`` (no computador da equipe, nos testes) o mesmo contrato é
atendido em memória, como o site fazia antes do banco.
"""

from __future__ import annotations

import os
import re
import secrets
import threading
import time
import uuid
from collections import OrderedDict

SCHEMA = """
CREATE TABLE IF NOT EXISTS arquivos (
    token      TEXT PRIMARY KEY,
    tipo       TEXT NOT NULL,              -- 'projeto' (.3de) ou 'stl'
    nome       TEXT NOT NULL,
    dados      BYTEA NOT NULL,
    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arquivos_criado_em ON arquivos (criado_em);
CREATE TABLE IF NOT EXISTS projetos (
    id            UUID PRIMARY KEY,
    dono          TEXT NOT NULL,
    nome          TEXT NOT NULL,
    dados         TEXT NOT NULL,           -- o projeto .3de em JSON
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dono, nome)
);
CREATE INDEX IF NOT EXISTS projetos_dono ON projetos (dono, atualizado_em DESC);
"""

OWNER_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")
MAX_PROJECTS_PER_OWNER = 50


def valid_owner(owner: str | None) -> bool:
    return bool(owner and OWNER_RE.fullmatch(owner))


class MemoryStorage:
    """Reserva sem banco: dicionários protegidos por Lock (o servidor usa threads)."""

    backend = "memória"

    def __init__(self, ttl_seconds: float, max_file_bytes: int) -> None:
        self.ttl = ttl_seconds
        self.max_total = max_file_bytes
        self._files: OrderedDict[str, tuple[float, str, str, bytes]] = OrderedDict()
        self._projects: dict[str, dict[str, dict]] = {}
        self._lock = threading.Lock()

    # ---- arquivos temporários -------------------------------------------------
    def put_file(self, kind: str, name: str, data: bytes) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            now = time.time()
            for key in [k for k, e in self._files.items() if now - e[0] > self.ttl]:
                del self._files[key]
            total = sum(len(e[3]) for e in self._files.values())
            # Fila: enquanto faltar espaço, sai o arquivo mais antigo.
            while self._files and total + len(data) > self.max_total:
                _, old = self._files.popitem(last=False)
                total -= len(old[3])
            self._files[token] = (now, kind, name, data)
        return token

    def get_file(self, kind: str, token: str, name: str) -> bytes | None:
        with self._lock:
            entry = self._files.get(token)
        if entry is None or time.time() - entry[0] > self.ttl or entry[1] != kind or entry[2] != name:
            return None
        return entry[3]

    # ---- projetos salvos ------------------------------------------------------
    def save_project(self, owner: str, name: str, data: str) -> dict:
        with self._lock:
            mine = self._projects.setdefault(owner, {})
            old = next((p for p in mine.values() if p["nome"] == name), None)
            pid = old["id"] if old else str(uuid.uuid4())
            mine[pid] = {"id": pid, "nome": name, "dados": data, "atualizado_em": time.time()}
            for extra in sorted(mine.values(), key=lambda p: p["atualizado_em"])[:-MAX_PROJECTS_PER_OWNER]:
                del mine[extra["id"]]
            return _summary(mine[pid])

    def list_projects(self, owner: str) -> list[dict]:
        with self._lock:
            items = sorted(self._projects.get(owner, {}).values(), key=lambda p: -p["atualizado_em"])
            return [_summary(p) for p in items]

    def get_project(self, owner: str, pid: str) -> str | None:
        with self._lock:
            item = self._projects.get(owner, {}).get(pid)
        return item["dados"] if item else None

    def delete_project(self, owner: str, pid: str) -> bool:
        with self._lock:
            return self._projects.get(owner, {}).pop(pid, None) is not None


class PostgresStorage:
    """Mesmo contrato de MemoryStorage, gravando no PostgreSQL."""

    backend = "PostgreSQL"

    def __init__(self, url: str, ttl_seconds: float) -> None:
        import psycopg  # só é preciso quando há banco configurado

        self._psycopg = psycopg
        self.url = url
        self.ttl = ttl_seconds
        self._last_purge = 0.0
        with self._connect() as conn:
            conn.execute(SCHEMA)

    def _connect(self):
        # prepare_threshold=None: o "pooler" do Supabase (modo transaction) não
        # aceita comandos preparados no servidor.
        return self._psycopg.connect(self.url, autocommit=True, connect_timeout=10, prepare_threshold=None)

    def _purge(self, conn) -> None:
        if time.time() - self._last_purge > 600:     # no máximo a cada 10 minutos
            conn.execute("DELETE FROM arquivos WHERE criado_em < now() - make_interval(secs => %s)", (self.ttl,))
            self._last_purge = time.time()

    def put_file(self, kind: str, name: str, data: bytes) -> str:
        token = secrets.token_urlsafe(24)
        with self._connect() as conn:
            self._purge(conn)
            conn.execute("INSERT INTO arquivos (token, tipo, nome, dados) VALUES (%s, %s, %s, %s)",
                         (token, kind, name, data))
        return token

    def get_file(self, kind: str, token: str, name: str) -> bytes | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT dados FROM arquivos WHERE token = %s AND tipo = %s AND nome = %s "
                "AND criado_em >= now() - make_interval(secs => %s)", (token, kind, name, self.ttl)).fetchone()
        return bytes(row[0]) if row else None

    def save_project(self, owner: str, name: str, data: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "INSERT INTO projetos (id, dono, nome, dados) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (dono, nome) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now() "
                "RETURNING id, nome, atualizado_em", (uuid.uuid4(), owner, name, data)).fetchone()
            # Cada navegador guarda no máximo os 50 projetos mais recentes.
            conn.execute("DELETE FROM projetos WHERE dono = %s AND id NOT IN (SELECT id FROM projetos "
                         "WHERE dono = %s ORDER BY atualizado_em DESC LIMIT %s)",
                         (owner, owner, MAX_PROJECTS_PER_OWNER))
        return {"id": str(row[0]), "nome": row[1], "atualizado_em": row[2].timestamp()}

    def list_projects(self, owner: str) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id, nome, atualizado_em FROM projetos WHERE dono = %s "
                                "ORDER BY atualizado_em DESC", (owner,)).fetchall()
        return [{"id": str(r[0]), "nome": r[1], "atualizado_em": r[2].timestamp()} for r in rows]

    def get_project(self, owner: str, pid: str) -> str | None:
        try:
            pid = str(uuid.UUID(pid))
        except ValueError:
            return None
        with self._connect() as conn:
            row = conn.execute("SELECT dados FROM projetos WHERE dono = %s AND id = %s", (owner, pid)).fetchone()
        return row[0] if row else None

    def delete_project(self, owner: str, pid: str) -> bool:
        try:
            pid = str(uuid.UUID(pid))
        except ValueError:
            return False
        with self._connect() as conn:
            return conn.execute("DELETE FROM projetos WHERE dono = %s AND id = %s", (owner, pid)).rowcount > 0


def _summary(item: dict) -> dict:
    return {"id": item["id"], "nome": item["nome"], "atualizado_em": item["atualizado_em"]}


def open_storage(ttl_seconds: float, max_memory_bytes: int):
    """PostgreSQL se ``DATABASE_URL`` estiver definida; senão, memória."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return PostgresStorage(url, ttl_seconds)
    return MemoryStorage(ttl_seconds, max_memory_bytes)
