"""
Limpador de DMs do Instagram.

Servidor local (Flask) que conecta na sua conta do Instagram, lista todas as
conversas da caixa de entrada e dos pedidos de mensagem e permite excluir
várias de uma vez. Também mostra quem não te segue de volta (para deixar de
seguir) e quem você não segue de volta (para seguir ou remover).

Rode no SEU computador:  python app.py
O app abre em http://127.0.0.1:8765
"""

import functools
import json
import logging
import os
import queue
import random
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory
from instagrapi import Client
from instagrapi.exceptions import (
    BadPassword,
    ChallengeRequired,
    ClientError,
    ClientNotFoundError,
    FeedbackRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    RateLimitError,
    TwoFactorRequired,
)

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
BASE_DIR = Path(__file__).resolve().parent
if getattr(sys, "frozen", False):
    # Rodando como .exe: a interface vem embutida no programa e o login/histórico
    # ficam numa pasta do usuário (o .exe pode estar em Downloads, por exemplo).
    STATIC_DIR = Path(sys._MEIPASS) / "static"
    USER_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "LimpadorDeDMs"
    USER_DIR.mkdir(parents=True, exist_ok=True)
else:
    STATIC_DIR = BASE_DIR / "static"
    USER_DIR = BASE_DIR
SESSION_FILE = USER_DIR / "session.json"

# Pausa (segundos) entre cada exclusão, para não parecer robô para o Instagram.
DELETE_DELAY = (
    float(os.environ.get("DELETE_DELAY_MIN", "1.5")),
    float(os.environ.get("DELETE_DELAY_MAX", "3.5")),
)

# Pausa extra entre cada mensagem com envio cancelado (além da pausa normal
# de 1-2 s que toda chamada ao Instagram já tem).
UNSEND_DELAY = (
    float(os.environ.get("UNSEND_DELAY_MIN", "0.5")),
    float(os.environ.get("UNSEND_DELAY_MAX", "1.5")),
)

# Seguir/deixar de seguir em massa é o que mais gera bloqueio no Instagram,
# então a pausa entre essas ações é bem maior.
FOLLOW_DELAY = (
    float(os.environ.get("FOLLOW_DELAY_MIN", "12")),
    float(os.environ.get("FOLLOW_DELAY_MAX", "25")),
)

RATE_LIMIT_ERRORS = (PleaseWaitFewMinutes, FeedbackRequired, RateLimitError)

log = logging.getLogger("dm-cleaner")
app = Flask(__name__, static_folder=None)


class PasswordChangeRequired(Exception):
    pass


# --------------------------------------------------------------------------- #
# Estado global (um único usuário, rodando localmente)
# --------------------------------------------------------------------------- #

class State:
    def __init__(self):
        self.lock = threading.Lock()  # protege os campos abaixo
        self.api_lock = threading.Lock()  # uma chamada ao Instagram por vez
        self.client: Client | None = None
        self.login = {"status": "logged_out", "username": None, "error": None, "challenge": None}
        self.pending_credentials: tuple[str, str] | None = None  # só em memória, para o 2FA
        self.challenge_codes: queue.Queue[str] = queue.Queue()
        self.job: dict | None = None
        self.analysis: dict | None = None  # análise de publicações em andamento
        self.cancel_job = threading.Event()

    def set_login(self, **kwargs):
        with self.lock:
            self.login.update(kwargs)


state = State()


def new_client() -> Client:
    cl = Client()
    cl.delay_range = [1, 2]
    cl.challenge_code_handler = _challenge_code_handler
    cl.change_password_handler = _change_password_handler
    return cl


def _challenge_code_handler(username, choice):
    """Chamado pelo instagrapi quando o Instagram envia um código por e-mail/SMS.
    Espera o usuário digitar o código na interface web."""
    while not state.challenge_codes.empty():
        state.challenge_codes.get_nowait()
    channel = getattr(choice, "name", str(choice)).lower()
    state.set_login(status="need_challenge", challenge=channel, error=None)
    try:
        code = state.challenge_codes.get(timeout=300)
    except queue.Empty:
        code = ""
    state.set_login(status="working", challenge=None)
    return code


def _change_password_handler(username):
    raise PasswordChangeRequired(
        "O Instagram está pedindo para trocar a senha. Troque pelo app oficial e tente de novo."
    )


def save_session(cl: Client):
    cl.dump_settings(SESSION_FILE)
    try:
        SESSION_FILE.chmod(0o600)
    except OSError:
        pass


def friendly_error(exc: Exception) -> str:
    if isinstance(exc, BadPassword):
        return "Usuário ou senha incorretos."
    if isinstance(exc, RATE_LIMIT_ERRORS):
        return "O Instagram limitou as requisições. Espere alguns minutos e tente de novo."
    if isinstance(exc, ChallengeRequired):
        return (
            "O Instagram pediu uma verificação de segurança que não deu para completar aqui. "
            "Abra o app oficial do Instagram, confirme que foi você e tente de novo."
        )
    if isinstance(exc, LoginRequired):
        return "Sua sessão expirou. Entre de novo."
    message = str(exc).strip() or exc.__class__.__name__
    return message


# --------------------------------------------------------------------------- #
# Login
# --------------------------------------------------------------------------- #

def _login_worker(username: str, password: str, code: str = ""):
    cl = new_client()
    if SESSION_FILE.exists():
        # Reaproveita o "aparelho" da última vez (o Instagram estranha menos),
        # mas faz um login novo de verdade.
        try:
            old = cl.load_settings(SESSION_FILE)
            if (old.get("username") or "").lower() == username.lower() and old.get("uuids"):
                cl = new_client()
                cl.set_uuids(old["uuids"])
            else:
                cl = new_client()
        except Exception:  # noqa: BLE001
            cl = new_client()
    try:
        cl.login(username, password, verification_code=code)
    except TwoFactorRequired:
        state.pending_credentials = (username, password)
        state.set_login(status="need_2fa", username=username, error=None)
        return
    except Exception as exc:  # noqa: BLE001 - mostramos qualquer erro na tela
        log.exception("Falha no login")
        state.pending_credentials = None
        state.set_login(status="logged_out", error=friendly_error(exc), challenge=None)
        return

    state.pending_credentials = None
    save_session(cl)
    state.client = cl
    state.set_login(status="logged_in", username=cl.username or username, error=None, challenge=None)


def _restore_session():
    """Tenta reaproveitar a sessão salva para não precisar logar toda vez."""
    if not SESSION_FILE.exists():
        return
    state.set_login(status="working")
    cl = new_client()
    try:
        settings = cl.load_settings(SESSION_FILE)
        username = settings.get("username") or ""
        cl.username = username
        if not cl.user_id:
            raise LoginRequired("sem sessão")
        info = cl.account_info()
        state.client = cl
        state.set_login(status="logged_in", username=info.username or username, error=None)
    except Exception as exc:  # noqa: BLE001
        log.info("Não deu para restaurar a sessão salva: %s", exc)
        state.set_login(status="logged_out", error=None)


@app.post("/api/login")
def api_login():
    data = request.get_json(force=False) or {}
    username = (data.get("username") or "").strip().lstrip("@")
    password = data.get("password") or ""
    if not username or not password:
        return jsonify(error="Informe usuário e senha."), 400
    with state.lock:
        if state.login["status"] == "working":
            return jsonify(error="Já existe um login em andamento."), 409
        state.login.update(status="working", username=username, error=None, challenge=None)
    threading.Thread(target=_login_worker, args=(username, password), daemon=True).start()
    return jsonify(ok=True)


@app.post("/api/login/code")
def api_login_code():
    data = request.get_json(force=False) or {}
    code = "".join(ch for ch in str(data.get("code") or "") if ch.isdigit())
    if not code:
        return jsonify(error="Digite o código."), 400
    status = state.login["status"]
    if status == "need_challenge":
        state.challenge_codes.put(code)
        return jsonify(ok=True)
    if status == "need_2fa" and state.pending_credentials:
        username, password = state.pending_credentials
        state.set_login(status="working", error=None)
        threading.Thread(target=_login_worker, args=(username, password, code), daemon=True).start()
        return jsonify(ok=True)
    return jsonify(error="Nenhum código está sendo esperado agora."), 409


@app.post("/api/logout")
def api_logout():
    with state.lock:
        if state.job and state.job["status"] == "running":
            return jsonify(error="Espere a ação em andamento terminar ou pare antes de sair."), 409
    state.client = None
    state.pending_credentials = None
    SESSION_FILE.unlink(missing_ok=True)
    state.set_login(status="logged_out", username=None, error=None, challenge=None)
    return jsonify(ok=True)


@app.get("/api/status")
def api_status():
    with state.lock:
        return jsonify(
            login=dict(state.login),
            job=dict(state.job) if state.job else None,
            delays={kind: sum(action[1]) / 2 for kind, action in JOB_ACTIONS.items()},
        )


# --------------------------------------------------------------------------- #
# Conversas
# --------------------------------------------------------------------------- #

ITEM_LABELS = {
    "media": "📷 Foto ou vídeo",
    "raw_media": "📷 Foto ou vídeo",
    "visual_media": "📷 Foto ou vídeo temporária",
    "media_share": "📎 Publicação compartilhada",
    "clip": "🎬 Reel",
    "felix_share": "🎬 Vídeo",
    "story_share": "📖 Story",
    "reel_share": "📖 Resposta ao story",
    "voice_media": "🎤 Áudio",
    "animated_media": "GIF",
    "like": "❤️",
    "link": "🔗 Link",
    "xma_media_share": "📎 Publicação compartilhada",
    "xma_clip": "🎬 Reel",
    "xma_story_share": "📖 Story",
    "xma_reel_share": "📖 Resposta ao story",
    "profile": "👤 Perfil compartilhado",
    "location": "📍 Localização",
    "video_call_event": "📞 Chamada de vídeo",
    "action_log": "Atividade na conversa",
    "placeholder": "Mensagem indisponível",
}


def describe_message(msg) -> str:
    if msg is None:
        return ""
    if msg.text:
        return msg.text
    if msg.link and getattr(msg.link, "text", None):
        return msg.link.text
    return ITEM_LABELS.get(msg.item_type or "", f"[{msg.item_type or 'mensagem'}]")


def serialize_thread(t, folder: str, me_id: str) -> dict:
    users = [
        {
            "username": u.username,
            "full_name": u.full_name or "",
            "pic": str(u.profile_pic_url) if u.profile_pic_url else None,
        }
        for u in t.users
    ]
    title = t.thread_title or ", ".join(u["username"] for u in users) or "(conversa sem participantes)"
    last = t.messages[0] if t.messages else None
    from_me = None
    if last is not None:
        from_me = bool(last.is_sent_by_viewer) or (str(last.user_id) == me_id)
    last_at = t.last_activity_at or (last.timestamp if last else None)
    return {
        "id": t.id,
        "title": title,
        "users": users,
        "is_group": bool(t.is_group or len(users) > 1),
        "folder": folder,
        "last_activity": last_at.isoformat() if last_at else None,
        "preview": describe_message(last),
        "last_from_me": from_me,
        "muted": bool(t.muted),
    }


def require_client() -> Client:
    cl = state.client
    if cl is None:
        raise LoginRequired("Faça login primeiro.")
    return cl


def instagram_errors(view):
    """Transforma os erros do Instagram em respostas JSON com mensagem amigável."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        try:
            return view(*args, **kwargs)
        except LoginRequired as exc:
            state.client = None
            state.set_login(status="logged_out", error=friendly_error(exc))
            return jsonify(error=friendly_error(exc)), 401
        except RATE_LIMIT_ERRORS as exc:
            return jsonify(error=friendly_error(exc)), 429
        except ClientError as exc:
            log.exception("Erro falando com o Instagram")
            return jsonify(error=friendly_error(exc)), 502

    return wrapper


@app.get("/api/threads")
@instagram_errors
def api_threads():
    folder = request.args.get("folder", "inbox")
    cursor = request.args.get("cursor") or None
    if folder not in ("inbox", "pending"):
        return jsonify(error="Pasta inválida."), 400
    cl = require_client()
    with state.api_lock:
        if folder == "inbox":
            threads, next_cursor = cl.direct_threads_chunk(thread_message_limit=1, cursor=cursor)
        else:
            threads, next_cursor = cl.direct_pending_chunk(cursor=cursor)

    me_id = str(cl.user_id)
    # O Instagram às vezes devolve o mesmo cursor no fim da lista.
    if next_cursor == cursor:
        next_cursor = None
    return jsonify(
        threads=[serialize_thread(t, folder, me_id) for t in threads],
        cursor=next_cursor,
    )


# --------------------------------------------------------------------------- #
# Seguidores / seguindo
# --------------------------------------------------------------------------- #

PEOPLE_PAGE_SIZE = 200


def serialize_user(u) -> dict:
    return {
        "id": str(u.pk),
        "username": u.username,
        "full_name": u.full_name or "",
        "pic": str(u.profile_pic_url) if u.profile_pic_url else None,
        "is_private": bool(u.is_private),
        "is_verified": bool(u.is_verified),
    }


@app.get("/api/people")
@instagram_errors
def api_people():
    which = request.args.get("list")
    cursor = request.args.get("cursor") or ""
    if which not in ("followers", "following"):
        return jsonify(error="Lista inválida."), 400
    cl = require_client()
    me = str(cl.user_id)
    total = None
    with state.api_lock:
        if not cursor:
            # Só para mostrar o progresso ("350 de 1.200"); se falhar, tudo bem.
            try:
                info = cl.user_info_v1(me)
                total = info.follower_count if which == "followers" else info.following_count
            except Exception:  # noqa: BLE001
                total = None
        fetch = cl.user_followers_v1_chunk if which == "followers" else cl.user_following_v1_chunk
        users, next_cursor = fetch(me, max_amount=PEOPLE_PAGE_SIZE, max_id=cursor)

    if next_cursor == cursor:
        next_cursor = None
    return jsonify(users=[serialize_user(u) for u in users], cursor=next_cursor or None, total=total)


# --------------------------------------------------------------------------- #
# Ações em lote (excluir conversas, deixar de seguir, seguir, remover seguidor)
# --------------------------------------------------------------------------- #

class JobCancelled(Exception):
    pass


class UnsendIncomplete(Exception):
    pass


# Itens do histórico que não são mensagens de verdade e não dá para cancelar.
NOT_UNSENDABLE = {"action_log", "video_call_event", "placeholder"}


def _set_detail(job: dict, text: str | None):
    with state.lock:
        job["detail"] = text


def _my_message_ids(cl: Client, thread_id: str, job: dict) -> list[str]:
    """Percorre o histórico inteiro da conversa e junta as mensagens que você enviou."""
    me = str(cl.user_id)
    ids: list[str] = []
    seen_ids: set[str] = set()
    read = 0
    cursor = None
    while True:
        if state.cancel_job.is_set():
            raise JobCancelled()
        params = {"visual_message_return_type": "unseen", "direction": "older", "seq_id": "40065", "limit": "20"}
        if cursor:
            params["cursor"] = cursor
        with state.api_lock:
            result = cl.private_request(f"direct_v2/threads/{thread_id}/", params=params)
        thread = result.get("thread") or {}
        items = thread.get("items") or []
        for item in items:
            read += 1
            item_id = str(item.get("item_id") or "")
            if (
                item_id
                and item_id not in seen_ids
                and str(item.get("user_id")) == me
                and item.get("item_type") not in NOT_UNSENDABLE
            ):
                seen_ids.add(item_id)
                ids.append(item_id)
        _set_detail(job, f"Lendo o histórico… {read} mensagens lidas, {len(ids)} enviadas por você")
        next_cursor = thread.get("oldest_cursor")
        if not items or thread.get("has_older") is False or not next_cursor or next_cursor == cursor:
            return ids
        cursor = next_cursor


def _delete_thread(cl: Client, thread_id: str, job: dict) -> bool:
    if job["options"].get("unsend"):
        ids = _my_message_ids(cl, thread_id, job)
        failed = 0
        for n, message_id in enumerate(ids, 1):
            if state.cancel_job.is_set():
                raise JobCancelled()
            try:
                with state.api_lock:
                    ok = cl.direct_message_unsend(thread_id, message_id)
            except ClientNotFoundError:
                ok = True  # já tinha sumido
            except (*RATE_LIMIT_ERRORS, LoginRequired):
                raise
            except Exception:  # noqa: BLE001
                log.exception("Erro cancelando o envio de %s em %s", message_id, thread_id)
                ok = False
            with state.lock:
                if ok:
                    job["unsent"] += 1
                else:
                    failed += 1
                job["detail"] = f"Cancelando o envio das suas mensagens: {n} de {len(ids)}"
            state.cancel_job.wait(random.uniform(*UNSEND_DELAY))
        if failed:
            raise UnsendIncomplete(
                f"{failed} de {len(ids)} mensagem(ns) sua(s) não tiveram o envio cancelado. "
                "A conversa não foi excluída; tente de novo."
            )
        _set_detail(job, "Excluindo a conversa…")
    with state.api_lock:
        return cl.direct_thread_hide(thread_id)


def _locked(fn):
    def run(cl, item_id, job):
        with state.api_lock:
            return fn(cl, item_id)

    return run


def _follow(cl: Client, user_id: str) -> bool:
    if cl.user_follow(user_id):
        return True
    # Conta privada: o Instagram só registra o pedido para seguir.
    status = (cl.last_json or {}).get("friendship_status") or {}
    return bool(status.get("outgoing_request"))


# tipo -> (função, pausa entre ações, texto do resultado)
JOB_ACTIONS = {
    "delete_threads": (_delete_thread, DELETE_DELAY, "conversa(s) excluída(s)"),
    "unfollow": (_locked(lambda cl, i: cl.user_unfollow(i)), FOLLOW_DELAY, "pessoa(s) deixada(s) de seguir"),
    "follow": (_locked(_follow), FOLLOW_DELAY, "pessoa(s) seguida(s)"),
    "remove_follower": (
        _locked(lambda cl, i: cl.user_remove_follower(i)), FOLLOW_DELAY, "seguidor(es) removido(s)"
    ),
}


def _job_worker(kind: str, item_ids: list[str]):
    action, delay, done_text = JOB_ACTIONS[kind]
    cl = state.client
    job = state.job

    def summary() -> str:
        text = f"{len(job['succeeded'])} {done_text}"
        if job["unsent"]:
            text += f", {job['unsent']} mensagem(ns) com envio cancelado"
        return text

    def cancelled():
        with state.lock:
            job.update(status="cancelled", detail=None, message=f"Parado. {summary()} antes de parar.")

    for index, item_id in enumerate(item_ids):
        if state.cancel_job.is_set():
            cancelled()
            return
        with state.lock:
            job["current"] = item_id
            job["detail"] = None
        try:
            ok = action(cl, item_id, job)
            if ok and kind == "remove_follower":
                note_removed_by_me(str(cl.user_id), item_id)
            with state.lock:
                if ok:
                    job["succeeded"].append(item_id)
                else:
                    job["failed"].append({"id": item_id, "error": "O Instagram não confirmou a ação."})
        except JobCancelled:
            cancelled()
            return
        except RATE_LIMIT_ERRORS as exc:
            with state.lock:
                job.update(status="stopped", detail=None, message=f"{friendly_error(exc)} ({summary()} até aqui.)")
            return
        except LoginRequired as exc:
            state.client = None
            state.set_login(status="logged_out", error=friendly_error(exc))
            with state.lock:
                job.update(status="stopped", detail=None, message=friendly_error(exc))
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("Erro em %s de %s", kind, item_id)
            with state.lock:
                job["failed"].append({"id": item_id, "error": friendly_error(exc)})
        finally:
            with state.lock:
                job["done"] = len(job["succeeded"]) + len(job["failed"])

        if index < len(item_ids) - 1:
            # Espera um pouco entre ações; sai antes se cancelarem.
            state.cancel_job.wait(random.uniform(*delay))

    with state.lock:
        failed = len(job["failed"])
        job.update(
            status="finished",
            current=None,
            detail=None,
            message=summary() + (f", {failed} com erro." if failed else "."),
        )


def start_job(kind: str, ids, options: dict | None = None):
    if not isinstance(ids, list) or not all(isinstance(i, str) and i.isdigit() for i in ids):
        return jsonify(error="Lista inválida."), 400
    ids = list(dict.fromkeys(ids))  # remove duplicadas mantendo a ordem
    if not ids:
        return jsonify(error="Selecione pelo menos um item."), 400
    if state.client is None:
        return jsonify(error="Faça login primeiro."), 401
    with state.lock:
        if state.job and state.job["status"] == "running":
            return jsonify(error="Já existe uma ação em andamento. Espere terminar ou pare antes."), 409
        state.cancel_job.clear()
        state.job = {
            "kind": kind,
            "status": "running",
            "total": len(ids),
            "done": 0,
            "succeeded": [],
            "failed": [],
            "message": None,
            "options": options or {},
            "current": None,
            "detail": None,
            "unsent": 0,
        }
    threading.Thread(target=_job_worker, args=(kind, ids), daemon=True).start()
    return jsonify(ok=True)


@app.post("/api/delete")
def api_delete():
    data = request.get_json(force=False) or {}
    return start_job("delete_threads", data.get("thread_ids") or [], {"unsend": bool(data.get("unsend"))})


@app.post("/api/people/action")
def api_people_action():
    data = request.get_json(force=False) or {}
    kind = data.get("action")
    if kind not in ("unfollow", "follow", "remove_follower"):
        return jsonify(error="Ação inválida."), 400
    return start_job(kind, data.get("user_ids") or [])


@app.post("/api/delete/cancel")
def api_delete_cancel():
    state.cancel_job.set()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Análise do perfil (histórico salvo só neste computador)
# --------------------------------------------------------------------------- #

DATA_DIR = USER_DIR / "dados"
MAX_HISTORY = 500
MAX_EVENTS = 300
# Quantos "deixou de seguir" conferimos um a um com o Instagram a cada análise.
MAX_VERIFY = 40
USER_FIELDS = ("id", "username", "full_name", "pic", "is_private", "is_verified")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _analytics_path(user_id: str) -> Path:
    return DATA_DIR / f"analise-{user_id}.json"


def load_analytics(user_id: str) -> dict:
    path = _analytics_path(user_id)
    data = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            log.exception("Arquivo de análise ilegível, começando de novo")
    data.setdefault("last_followers", {})
    data.setdefault("history", [])
    data.setdefault("events", [])
    data.setdefault("engagement", None)
    data.setdefault("stories", None)
    data.setdefault("removed_by_me", [])
    return data


def save_analytics(user_id: str, data: dict):
    DATA_DIR.mkdir(exist_ok=True)
    path = _analytics_path(user_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def note_removed_by_me(me: str, user_id: str):
    """Quem você removeu não deve aparecer depois como "deixou de seguir"."""
    with state.lock:
        data = load_analytics(me)
        if user_id not in data["removed_by_me"]:
            data["removed_by_me"].append(user_id)
            save_analytics(me, data)


def public_analytics(data: dict) -> dict:
    """O que a tela precisa (sem a lista completa de seguidores)."""
    return {
        "history": data["history"],
        "events": data["events"],
        "engagement": data["engagement"],
        "stories": data["stories"],
        "has_baseline": bool(data["last_followers"]),
    }


def _clean_user(raw: dict) -> dict | None:
    if not isinstance(raw, dict) or not str(raw.get("id", "")).isdigit():
        return None
    return {k: raw.get(k) for k in USER_FIELDS}


@app.get("/api/analytics")
@instagram_errors
def api_analytics():
    cl = require_client()
    with state.lock:
        data = load_analytics(str(cl.user_id))
    return jsonify(public_analytics(data))


@app.post("/api/analytics/snapshot")
@instagram_errors
def api_analytics_snapshot():
    """Recebe a lista completa de seguidores já carregada na tela e compara com a anterior."""
    cl = require_client()
    me = str(cl.user_id)
    body = request.get_json(force=False) or {}
    followers = {}
    for raw in body.get("followers") or []:
        u = _clean_user(raw)
        if u:
            followers[u["id"]] = u
    following_count = int(body.get("following_count") or 0)

    with state.lock:
        data = load_analytics(me)
    previous = data["last_followers"]
    change = {"at": _now(), "lost": [], "gained": [], "first": not previous}

    if previous:
        removed = set(data["removed_by_me"])
        lost_ids = [i for i in previous if i not in followers and i not in removed]
        gained = [followers[i] for i in followers if i not in previous]
        # Confere com o Instagram se a pessoa deixou mesmo de seguir: às vezes a lista
        # vem incompleta e alguém "some" sem ter deixado de seguir.
        confirmed, false_alarms, checked = [], 0, 0
        for uid in lost_ids[:MAX_VERIFY]:
            checked += 1
            user = dict(previous[uid])
            try:
                with state.api_lock:
                    rel = cl.user_friendship_v1(uid)
                if rel.followed_by:
                    false_alarms += 1
                    followers[uid] = previous[uid]  # continua seguindo
                    continue
            except ClientNotFoundError:
                user["gone"] = True  # conta apagada ou desativada
            confirmed.append(user)
        unverified = [previous[i] for i in lost_ids[MAX_VERIFY:]]
        # Muitos alarmes falsos = a lista veio incompleta. Poucos (alguém que o Instagram
        # sempre deixa de fora) já foram resolvidos acima, sem barrar a análise.
        if false_alarms >= 5 and false_alarms > checked / 2:
            return jsonify(
                error="O Instagram entregou uma lista de seguidores incompleta, então a comparação daria "
                "resultado errado. Nada foi salvo. Clique em Recarregar e tente de novo daqui a pouco."
            ), 409
        change["lost"] = confirmed + unverified
        change["gained"] = gained

    history = data["history"]
    point = {"at": change["at"], "followers": len(followers), "following": following_count}
    # Um ponto por hora no máximo, para o gráfico não virar um amontoado.
    if history and (datetime.fromisoformat(change["at"]) - datetime.fromisoformat(history[-1]["at"])).total_seconds() < 3600:
        history[-1] = point
    else:
        history.append(point)
    data["history"] = history[-MAX_HISTORY:]
    if change["lost"] or change["gained"]:
        data["events"].append({"at": change["at"], "lost": change["lost"], "gained": change["gained"]})
        data["events"] = data["events"][-MAX_EVENTS:]
    data["last_followers"] = followers
    data["removed_by_me"] = [i for i in data["removed_by_me"] if i in followers]

    with state.lock:
        save_analytics(me, data)
    return jsonify(analytics=public_analytics(data), change=change)


def _engagement_worker(cl: Client, posts_wanted: int):
    me = str(cl.user_id)
    task = state.analysis
    try:
        with state.api_lock:
            medias = cl.user_medias_v1(me, amount=posts_wanted)
        with state.lock:
            task.update(total=len(medias), done=0)
        posts, people = [], {}

        def bump(u, field):
            uid = str(u.pk)
            if uid == me:
                return
            entry = people.setdefault(uid, {**serialize_user(u), "likes": 0, "comments": 0})
            entry[field] += 1

        for m in medias:
            with state.api_lock:
                likers = cl.media_likers(m.pk)
            with state.api_lock:
                comments = cl.media_comments(m.pk, amount=100) if m.comment_count else []
            for u in likers:
                bump(u, "likes")
            commenters = set()
            for c in comments:
                if c.user and c.user.pk not in commenters:
                    commenters.add(c.user.pk)
                    bump(c.user, "comments")
            posts.append({
                "code": m.code,
                "taken_at": m.taken_at.isoformat() if m.taken_at else None,
                "likes": m.like_count or len(likers),
                "comments": m.comment_count or 0,
                "likers_listed": len(likers),
                "thumb": str(m.thumbnail_url) if m.thumbnail_url else None,
                "caption": (m.caption_text or "")[:80],
            })
            with state.lock:
                task["done"] += 1

        result = {"at": _now(), "posts": posts, "people": list(people.values())}
        with state.lock:
            data = load_analytics(me)
            data["engagement"] = result
            save_analytics(me, data)
            task.update(status="done", result=result)
    except Exception as exc:  # noqa: BLE001
        log.exception("Erro na análise de engajamento")
        with state.lock:
            task.update(status="error", message=friendly_error(exc))


@app.post("/api/analytics/engagement")
def api_engagement_start():
    cl = state.client
    if cl is None:
        return jsonify(error="Faça login primeiro."), 401
    body = request.get_json(force=False) or {}
    posts = max(1, min(int(body.get("posts") or 12), 50))
    with state.lock:
        if state.analysis and state.analysis["status"] == "running":
            return jsonify(error="A análise já está rodando."), 409
        state.analysis = {"status": "running", "done": 0, "total": 0, "message": None, "result": None}
    threading.Thread(target=_engagement_worker, args=(cl, posts), daemon=True).start()
    return jsonify(ok=True)


@app.get("/api/analytics/engagement")
def api_engagement_status():
    with state.lock:
        task = dict(state.analysis) if state.analysis else {"status": "idle"}
    return jsonify(task)


@app.get("/api/analytics/stories")
@instagram_errors
def api_story_viewers():
    cl = require_client()
    me = str(cl.user_id)
    with state.api_lock:
        stories = cl.user_stories(me)
    viewers = {}
    for story in stories:
        with state.api_lock:
            seen = cl.story_viewers(story.pk)
        for v in seen:
            entry = viewers.setdefault(str(v.pk), {**serialize_user(v), "views": 0, "liked": 0})
            entry["views"] += 1
            if v.has_liked:
                entry["liked"] += 1
    result = {"at": _now(), "stories": len(stories), "viewers": list(viewers.values())}
    with state.lock:
        data = load_analytics(me)
        data["stories"] = result
        save_analytics(me, data)
    return jsonify(result)


# --------------------------------------------------------------------------- #
# Proteções simples: só aceita requisições do próprio navegador local
# --------------------------------------------------------------------------- #

ALLOWED_HOSTS = {f"{HOST}:{PORT}", f"localhost:{PORT}"}


@app.before_request
def only_local():
    if request.host not in ALLOWED_HOSTS:
        abort(403)
    origin = request.headers.get("Origin")
    if origin and origin.split("://", 1)[-1] not in ALLOWED_HOSTS:
        abort(403)


@app.get("/favicon.ico")
def favicon():
    return "", 204


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC_DIR, name)


def _already_running() -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=0.5):
            return True
    except OSError:
        return False


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url = f"http://{HOST}:{PORT}"
    open_browser = os.environ.get("NO_BROWSER") != "1"
    if _already_running():
        # Abriu o app de novo: só mostra a janela que já está rodando.
        print(f"\n  O Limpador de DMs já está aberto em {url}\n")
        if open_browser:
            webbrowser.open(url)
        return
    threading.Thread(target=_restore_session, daemon=True).start()
    print(f"\n  Limpador de DMs rodando em {url}\n  (feche esta janela ou aperte Ctrl+C para parar)\n")
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, debug=False, threaded=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        log.exception("O app parou com um erro")
        if getattr(sys, "frozen", False):
            # No .exe a janela fecharia na hora e ninguém veria o erro.
            input("\nDeu erro (veja acima). Aperte Enter para fechar...")
        raise
