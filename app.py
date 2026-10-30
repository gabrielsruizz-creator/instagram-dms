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
import logging
import os
import queue
import random
import threading
import time
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory
from instagrapi import Client
from instagrapi.exceptions import (
    BadPassword,
    ChallengeRequired,
    ClientError,
    FeedbackRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    RateLimitError,
    TwoFactorRequired,
)

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
BASE_DIR = Path(__file__).resolve().parent
SESSION_FILE = BASE_DIR / "session.json"
STATIC_DIR = BASE_DIR / "static"

# Pausa (segundos) entre cada exclusão, para não parecer robô para o Instagram.
DELETE_DELAY = (
    float(os.environ.get("DELETE_DELAY_MIN", "1.5")),
    float(os.environ.get("DELETE_DELAY_MAX", "3.5")),
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

def _follow(cl: Client, user_id: str) -> bool:
    if cl.user_follow(user_id):
        return True
    # Conta privada: o Instagram só registra o pedido para seguir.
    status = (cl.last_json or {}).get("friendship_status") or {}
    return bool(status.get("outgoing_request"))


# tipo -> (função, pausa entre ações, texto do resultado)
JOB_ACTIONS = {
    "delete_threads": (lambda cl, i: cl.direct_thread_hide(i), DELETE_DELAY, "conversa(s) excluída(s)"),
    "unfollow": (lambda cl, i: cl.user_unfollow(i), FOLLOW_DELAY, "pessoa(s) deixada(s) de seguir"),
    "follow": (_follow, FOLLOW_DELAY, "pessoa(s) seguida(s)"),
    "remove_follower": (lambda cl, i: cl.user_remove_follower(i), FOLLOW_DELAY, "seguidor(es) removido(s)"),
}


def _job_worker(kind: str, item_ids: list[str]):
    action, delay, done_text = JOB_ACTIONS[kind]
    cl = state.client
    job = state.job
    for index, item_id in enumerate(item_ids):
        if state.cancel_job.is_set():
            with state.lock:
                job.update(
                    status="cancelled",
                    message=f"Parado. {len(job['succeeded'])} {done_text} antes de parar.",
                )
            return
        try:
            with state.api_lock:
                ok = action(cl, item_id)
            with state.lock:
                if ok:
                    job["succeeded"].append(item_id)
                else:
                    job["failed"].append({"id": item_id, "error": "O Instagram não confirmou a ação."})
        except RATE_LIMIT_ERRORS as exc:
            with state.lock:
                job.update(status="stopped", message=friendly_error(exc))
            return
        except LoginRequired as exc:
            state.client = None
            state.set_login(status="logged_out", error=friendly_error(exc))
            with state.lock:
                job.update(status="stopped", message=friendly_error(exc))
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
            message=f"{len(job['succeeded'])} {done_text}" + (f", {failed} com erro." if failed else "."),
        )


def start_job(kind: str, ids):
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
        }
    threading.Thread(target=_job_worker, args=(kind, ids), daemon=True).start()
    return jsonify(ok=True)


@app.post("/api/delete")
def api_delete():
    data = request.get_json(force=False) or {}
    return start_job("delete_threads", data.get("thread_ids") or [])


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


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC_DIR, name)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    threading.Thread(target=_restore_session, daemon=True).start()
    url = f"http://{HOST}:{PORT}"
    print(f"\n  Limpador de DMs rodando em {url}\n  (feche esta janela ou aperte Ctrl+C para parar)\n")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
