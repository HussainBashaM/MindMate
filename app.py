"""
MindMate AI — Flask backend
----------------------------
Real authentication (bcrypt + JWT), real MongoDB persistence, real LLM calls
(Anthropic API) with conversation memory, real (optional) weather/news tools,
and a protected admin panel.

Run locally:
    pip install -r requirements.txt
    python app.py

See README.md for full setup instructions.
"""

import os
import re
import json
import base64
import jwt
import bcrypt
import requests
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import Flask, request, jsonify, g, Response
from flask_cors import CORS
from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/mindmate")
AI_API_KEY = os.environ.get("AI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "claude-sonnet-5")
WEATHER_API_KEY = os.environ.get("WEATHER_API_KEY", "")
NEWS_API_KEY = os.environ.get("NEWS_API_KEY", "")
JWT_EXP_DAYS = 7

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)

client = MongoClient(MONGO_URI)
db = client.get_default_database()
users_col = db["users"]
conversations_col = db["conversations"]
settings_col = db["settings"]
password_resets_col = db["password_resets"]
tool_usage_col = db["tool_usage"]
attachments_col = db["attachments"]

# Files are stored as base64 inside MongoDB (fine for a small app / demo scale).
# For a production app with heavy attachment traffic, swap this for GridFS or S3.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024  # 8 MB per file
TEXT_ATTACHMENT_EXTENSIONS = (".txt", ".md", ".csv", ".json", ".log", ".py", ".js", ".html", ".css")

users_col.create_index("email", unique=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def ok(data=None, message="", status=200):
    return jsonify({"success": True, "message": message, "data": data or {}}), status


def fail(message="Something went wrong", status=400):
    return jsonify({"success": False, "message": message}), status


def oid(id_str):
    try:
        return ObjectId(id_str)
    except (InvalidId, TypeError):
        return None


def serialize_user(u):
    return {
        "id": str(u["_id"]),
        "fullName": u.get("fullName"),
        "email": u.get("email"),
        "phone": u.get("phone"),
        "role": u.get("role", "user"),
        "createdAt": u.get("createdAt").isoformat() if u.get("createdAt") else None,
        "avatar": u.get("avatar", ""),
    }


def serialize_conversation(c, include_messages=True):
    out = {
        "id": str(c["_id"]),
        "title": c.get("title", "New Chat"),
        "createdAt": c.get("createdAt").isoformat() if c.get("createdAt") else None,
        "updatedAt": c.get("updatedAt").isoformat() if c.get("updatedAt") else None,
        "lastMessage": (c.get("messages") or [{}])[-1].get("content", "")[:120]
        if c.get("messages") else "",
    }
    if include_messages:
        out["messages"] = c.get("messages", [])
    return out


def make_token(user_id, role):
    payload = {
        "sub": str(user_id),
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXP_DAYS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def auth_required(admin_only=False):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            auth_header = request.headers.get("Authorization", "")
            token = auth_header.replace("Bearer ", "") if auth_header else None
            if not token:
                return fail("Authentication required.", 401)
            try:
                payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            except jwt.ExpiredSignatureError:
                return fail("Session expired. Please log in again.", 401)
            except jwt.InvalidTokenError:
                return fail("Invalid authentication token.", 401)

            user = users_col.find_one({"_id": oid(payload["sub"])})
            if not user:
                return fail("User not found.", 401)
            if admin_only and user.get("role") != "admin":
                return fail("Admin access required.", 403)
            g.user = user
            return fn(*args, **kwargs)
        return wrapper
    return decorator


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------------------------------------------------------------------------
# AUTH ROUTES
# ---------------------------------------------------------------------------
@app.route("/api/auth/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    full_name = (data.get("fullName") or "").strip()
    email = (data.get("email") or "").strip().lower()
    phone = (data.get("phone") or "").strip()
    password = data.get("password") or ""

    if not full_name or len(full_name) < 2:
        return fail("Please enter your full name.")
    if not EMAIL_RE.match(email):
        return fail("Please enter a valid email address.")
    if len(password) < 8:
        return fail("Password must be at least 8 characters.")
    if users_col.find_one({"email": email}):
        return fail("An account with this email already exists.", 409)

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
    user_doc = {
        "fullName": full_name,
        "email": email,
        "phone": phone,
        "passwordHash": hashed,
        "role": "user",
        "avatar": "",
        "createdAt": datetime.now(timezone.utc),
    }
    result = users_col.insert_one(user_doc)
    settings_col.insert_one({
        "userId": result.inserted_id,
        "theme": "dark",
        "language": "en",
        "responseStyle": "balanced",
        "emailNotifications": True,
        "chatNotifications": True,
        "aiModel": AI_MODEL,
    })
    token = make_token(result.inserted_id, "user")
    user_doc["_id"] = result.inserted_id
    return ok({"token": token, "user": serialize_user(user_doc)}, "Account created successfully.", 201)


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = users_col.find_one({"email": email})
    if not user or not bcrypt.checkpw(password.encode("utf-8"), user["passwordHash"]):
        return fail("Invalid email or password.", 401)

    token = make_token(user["_id"], user.get("role", "user"))
    return ok({"token": token, "user": serialize_user(user)}, "Logged in successfully.")


@app.route("/api/auth/logout", methods=["POST"])
@auth_required()
def logout():
    # JWTs are stateless; the frontend discards the token. Nothing server-side to clear.
    return ok(message="Logged out successfully.")


@app.route("/api/auth/me", methods=["GET"])
@auth_required()
def me():
    return ok({"user": serialize_user(g.user)})


@app.route("/api/auth/forgot-password", methods=["POST"])
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    user = users_col.find_one({"email": email})
    # Always return success to avoid leaking which emails are registered.
    if user:
        import secrets
        reset_token = secrets.token_urlsafe(32)
        password_resets_col.insert_one({
            "userId": user["_id"],
            "token": reset_token,
            "createdAt": datetime.now(timezone.utc),
            "expiresAt": datetime.now(timezone.utc) + timedelta(hours=1),
            "used": False,
        })
        # NOTE: Actually emailing this link requires an email provider (e.g. SendGrid,
        # AWS SES, or SMTP). Wire one up here and send `reset_token` in a link like:
        # https://yourapp.com/reset-password.html?token=<reset_token>
        # For now the token is returned in dev so the flow is testable end-to-end.
        return ok({"devResetToken": reset_token} if app.debug else {},
                   "If that email exists, a reset link has been sent.")
    return ok(message="If that email exists, a reset link has been sent.")


@app.route("/api/auth/reset-password", methods=["POST"])
def reset_password():
    data = request.get_json(silent=True) or {}
    token = data.get("token") or ""
    new_password = data.get("password") or ""
    if len(new_password) < 8:
        return fail("Password must be at least 8 characters.")

    record = password_resets_col.find_one({"token": token, "used": False})
    if not record or record["expiresAt"] < datetime.now(timezone.utc):
        return fail("This reset link is invalid or has expired.", 400)

    hashed = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt())
    users_col.update_one({"_id": record["userId"]}, {"$set": {"passwordHash": hashed}})
    password_resets_col.update_one({"_id": record["_id"]}, {"$set": {"used": True}})
    return ok(message="Password reset successfully. You can now log in.")


# ---------------------------------------------------------------------------
# TOOL ROUTING — decide whether a message needs a real tool or the LLM
# ---------------------------------------------------------------------------
CALC_RE = re.compile(r"^[\s\d\.\+\-\*\/\(\)%]+$")


def try_calculator(text):
    """Only triggers on genuinely arithmetic-looking input; returns None otherwise."""
    stripped = text.strip().rstrip("?").strip()
    candidate = stripped.lower().replace("what is", "").replace("what's", "").strip()
    candidate = candidate.replace("x", "*").replace("×", "*").replace("÷", "/")
    if not candidate or not CALC_RE.match(candidate):
        return None
    try:
        # Safe eval: only digits/operators allowed by the regex above.
        result = eval(candidate, {"__builtins__": {}}, {})
        return f"{candidate.strip()} = {result}"
    except Exception:
        return None


def call_weather_api(location):
    if not WEATHER_API_KEY:
        return {"configured": False,
                "message": "Weather lookups need a free OpenWeatherMap API key. "
                            "Add WEATHER_API_KEY to your .env file to enable this."}
    try:
        resp = requests.get(
            "https://api.openweathermap.org/data/2.5/weather",
            params={"q": location, "appid": WEATHER_API_KEY, "units": "metric"},
            timeout=8,
        )
        if resp.status_code != 200:
            return {"configured": True, "error": True,
                    "message": f"Couldn't find weather for '{location}'."}
        d = resp.json()
        return {
            "configured": True, "error": False,
            "location": d.get("name", location),
            "tempC": d["main"]["temp"],
            "feelsLikeC": d["main"]["feels_like"],
            "condition": d["weather"][0]["description"],
            "humidity": d["main"]["humidity"],
        }
    except requests.RequestException:
        return {"configured": True, "error": True, "message": "Weather service is unreachable right now."}


def call_news_api(topic="technology"):
    if not NEWS_API_KEY:
        return {"configured": False,
                "message": "News lookups need a free NewsAPI.org key. "
                            "Add NEWS_API_KEY to your .env file to enable this."}
    try:
        resp = requests.get(
            "https://newsapi.org/v2/top-headlines",
            params={"category": topic if topic in
                    ("business", "entertainment", "general", "health", "science",
                     "sports", "technology") else "general",
                    "language": "en", "pageSize": 5, "apiKey": NEWS_API_KEY},
            timeout=8,
        )
        if resp.status_code != 200:
            return {"configured": True, "error": True, "message": "Couldn't fetch news right now."}
        articles = resp.json().get("articles", [])
        return {"configured": True, "error": False,
                "headlines": [{"title": a["title"], "source": a["source"]["name"], "url": a["url"]}
                               for a in articles[:5]]}
    except requests.RequestException:
        return {"configured": True, "error": True, "message": "News service is unreachable right now."}


def detect_tool(message):
    """Very lightweight intent detection. Returns (tool_name, extra) or (None, None)."""
    lower = message.lower().strip()

    calc_result = try_calculator(message)
    if calc_result:
        return "calculator", calc_result

    if any(k in lower for k in ["weather in", "weather today", "temperature in", "how hot is it in", "forecast for"]):
        m = re.search(r"(?:weather in|temperature in|forecast for|hot is it in)\s+([a-zA-Z\s,]+)", lower)
        location = m.group(1).strip().rstrip("?.,") if m else None
        return "weather", location

    if any(k in lower for k in ["news", "headlines", "what's happening in the world"]):
        return "news", None

    return None, None


# ---------------------------------------------------------------------------
# AI CALL — real LLM request with conversation memory
# ---------------------------------------------------------------------------
def call_llm(messages, system_prompt=None):
    """messages: list of {'role': 'user'|'assistant', 'content': str | list[block]}
    A 'content' list lets a single turn mix text and image blocks (real vision support)."""
    if not AI_API_KEY:
        return None, ("AI is not configured yet. Add AI_API_KEY to your .env file "
                       "(an Anthropic API key from console.anthropic.com) to enable real responses.")
    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": AI_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": AI_MODEL,
                "max_tokens": 1024,
                "system": system_prompt or "You are MindMate, a helpful, friendly AI assistant.",
                "messages": messages,
            },
            timeout=30,
        )
        if resp.status_code != 200:
            return None, "Sorry, I'm having trouble connecting right now. Please try again."
        data = resp.json()
        text_parts = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
        return "".join(text_parts).strip() or "…", None
    except requests.RequestException:
        return None, "Sorry, I'm having trouble connecting right now. Please try again."


# ---------------------------------------------------------------------------
# ATTACHMENTS — real upload/storage, used by chat for real image vision
# ---------------------------------------------------------------------------
@app.route("/api/upload", methods=["POST"])
@auth_required()
def upload_attachment():
    if "file" not in request.files:
        return fail("No file provided.")
    f = request.files["file"]
    if not f.filename:
        return fail("No file selected.")

    raw = f.read()
    if len(raw) > MAX_ATTACHMENT_BYTES:
        return fail(f"File too large. Max size is {MAX_ATTACHMENT_BYTES // (1024*1024)}MB.", 413)

    mime_type = f.mimetype or "application/octet-stream"
    doc = {
        "userId": g.user["_id"],
        "filename": f.filename,
        "mimeType": mime_type,
        "size": len(raw),
        "dataB64": base64.b64encode(raw).decode("ascii"),
        "createdAt": datetime.now(timezone.utc),
    }
    inserted = attachments_col.insert_one(doc)
    return ok({
        "id": str(inserted.inserted_id),
        "filename": f.filename,
        "mimeType": mime_type,
        "size": len(raw),
    }, "File uploaded.", 201)


@app.route("/api/attachments/<aid>", methods=["GET"])
def get_attachment(aid):
    # Deliberately not auth-gated: this lets <img src="..."> tags load directly
    # in the browser without custom headers. The ObjectId itself acts as an
    # unguessable share link — fine for a small app, but note this trade-off
    # if you add sensitive attachments later.
    att = attachments_col.find_one({"_id": oid(aid)})
    if not att:
        return fail("Attachment not found.", 404)
    raw = base64.b64decode(att["dataB64"])
    return Response(raw, mimetype=att.get("mimeType", "application/octet-stream"), headers={
        "Content-Disposition": f'inline; filename="{att.get("filename","file")}"'
    })


def build_current_turn_content(message_text, attachment_refs):
    """Builds the content for the CURRENT user turn only. Images become real
    vision blocks; small text files get their text inlined; other file types
    get an honest note instead of pretending to have read them."""
    if not attachment_refs:
        return message_text

    blocks = []
    extra_text_notes = []

    for ref in attachment_refs:
        att = attachments_col.find_one({"_id": oid(ref.get("id")), "userId": g.user["_id"]})
        if not att:
            continue
        mime = att.get("mimeType", "")
        filename = att.get("filename", "file")

        if mime.startswith("image/"):
            blocks.append({
                "type": "image",
                "source": {"type": "base64", "media_type": mime, "data": att["dataB64"]},
            })
        elif mime.startswith("text/") or filename.lower().endswith(TEXT_ATTACHMENT_EXTENSIONS):
            try:
                text_content = base64.b64decode(att["dataB64"]).decode("utf-8", errors="replace")
            except Exception:
                text_content = ""
            extra_text_notes.append(f"[Attached file: {filename}]\n{text_content[:6000]}")
        else:
            extra_text_notes.append(
                f"[Attached file: {filename} ({mime}) — this file type can't be read as text yet, "
                f"so its contents weren't included. Paste the relevant text directly if you need me "
                f"to look at it.]"
            )

    full_text = message_text
    if extra_text_notes:
        full_text = (full_text + "\n\n" if full_text else "") + "\n\n".join(extra_text_notes)

    if not blocks:
        return full_text  # plain string — no images, keep it simple

    blocks.append({"type": "text", "text": full_text or "(see attached image)"})
    return blocks


# ---------------------------------------------------------------------------
# CHAT ROUTES
# ---------------------------------------------------------------------------
@app.route("/api/chat", methods=["POST"])
@auth_required()
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    conversation_id = data.get("conversationId")
    attachment_refs = data.get("attachments") or []  # [{id, filename, mimeType}, ...]

    if not message and not attachment_refs:
        return fail("Message cannot be empty.")

    # Load or create conversation
    convo = None
    if conversation_id:
        convo = conversations_col.find_one({"_id": oid(conversation_id), "userId": g.user["_id"]})
    if not convo:
        title = (message[:50] + "…") if len(message) > 50 else message
        new_doc = {
            "userId": g.user["_id"],
            "title": title,
            "messages": [],
            "createdAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
        inserted = conversations_col.insert_one(new_doc)
        convo = conversations_col.find_one({"_id": inserted.inserted_id})

    now = datetime.now(timezone.utc)
    user_msg = {
        "role": "user",
        "content": message,
        "timestamp": now.isoformat(),
        "attachments": [
            {"id": r.get("id"), "filename": r.get("filename"), "mimeType": r.get("mimeType")}
            for r in attachment_refs
        ],
    }

    # --- Tool routing (skipped when the user attached a file — that always goes to the LLM) ---
    tool_name, extra = (None, None) if attachment_refs else detect_tool(message)
    ai_text = None
    tool_used = None

    if tool_name == "calculator":
        ai_text = f"That's **{extra}**"
        tool_used = "calculator"
    elif tool_name == "weather":
        location = extra or "your area"
        result = call_weather_api(location)
        if not result.get("configured"):
            ai_text = result["message"]
        elif result.get("error"):
            ai_text = result["message"]
        else:
            ai_text = (f"Right now in {result['location']}: {result['tempC']}°C "
                       f"(feels like {result['feelsLikeC']}°C), {result['condition']}, "
                       f"{result['humidity']}% humidity.")
        tool_used = "weather"
    elif tool_name == "news":
        result = call_news_api()
        if not result.get("configured"):
            ai_text = result["message"]
        elif result.get("error"):
            ai_text = result["message"]
        else:
            lines = [f"- {h['title']} ({h['source']})" for h in result["headlines"]]
            ai_text = "Here are today's top headlines:\n" + "\n".join(lines)
        tool_used = "news"

    if tool_used:
        tool_usage_col.insert_one({"userId": g.user["_id"], "tool": tool_used, "timestamp": now})

    # --- LLM fallback with full conversation memory ---
    if ai_text is None:
        history = convo.get("messages", [])[-20:]  # last 20 messages for context window
        # Prior turns are sent as plain text (their attachments aren't re-sent as
        # images, to keep the context window small); only the CURRENT turn gets
        # real multimodal content if it has attachments.
        llm_messages = [{"role": m["role"], "content": m["content"]} for m in history]
        current_content = build_current_turn_content(message, attachment_refs)
        llm_messages.append({"role": "user", "content": current_content})
        ai_text, err = call_llm(llm_messages)
        if err:
            ai_text = err

    ai_msg = {"role": "assistant", "content": ai_text, "timestamp": datetime.now(timezone.utc).isoformat()}

    conversations_col.update_one(
        {"_id": convo["_id"]},
        {"$push": {"messages": {"$each": [user_msg, ai_msg]}},
         "$set": {"updatedAt": datetime.now(timezone.utc)}},
    )

    return ok({
        "conversationId": str(convo["_id"]),
        "title": convo.get("title"),
        "message": ai_msg,
    })


@app.route("/api/conversations", methods=["GET"])
@auth_required()
def list_conversations():
    convos = conversations_col.find({"userId": g.user["_id"]}).sort("updatedAt", DESCENDING)
    return ok({"conversations": [serialize_conversation(c, include_messages=False) for c in convos]})


@app.route("/api/conversations", methods=["POST"])
@auth_required()
def create_conversation():
    now = datetime.now(timezone.utc)
    doc = {"userId": g.user["_id"], "title": "New Chat", "messages": [], "createdAt": now, "updatedAt": now}
    inserted = conversations_col.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return ok({"conversation": serialize_conversation(doc)}, "Conversation created.", 201)


@app.route("/api/conversations/<cid>", methods=["GET"])
@auth_required()
def get_conversation(cid):
    convo = conversations_col.find_one({"_id": oid(cid), "userId": g.user["_id"]})
    if not convo:
        return fail("Conversation not found.", 404)
    return ok({"conversation": serialize_conversation(convo)})


@app.route("/api/conversations/<cid>", methods=["PUT"])
@auth_required()
def rename_conversation(cid):
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return fail("Title cannot be empty.")
    result = conversations_col.update_one(
        {"_id": oid(cid), "userId": g.user["_id"]}, {"$set": {"title": title}}
    )
    if result.matched_count == 0:
        return fail("Conversation not found.", 404)
    return ok(message="Conversation renamed.")


@app.route("/api/conversations/<cid>", methods=["DELETE"])
@auth_required()
def delete_conversation(cid):
    result = conversations_col.delete_one({"_id": oid(cid), "userId": g.user["_id"]})
    if result.deleted_count == 0:
        return fail("Conversation not found.", 404)
    return ok(message="Conversation deleted.")


# ---------------------------------------------------------------------------
# PROFILE
# ---------------------------------------------------------------------------
@app.route("/api/profile", methods=["GET"])
@auth_required()
def get_profile():
    total_conversations = conversations_col.count_documents({"userId": g.user["_id"]})
    pipeline = [
        {"$match": {"userId": g.user["_id"]}},
        {"$project": {"count": {"$size": "$messages"}}},
        {"$group": {"_id": None, "total": {"$sum": "$count"}}},
    ]
    agg = list(conversations_col.aggregate(pipeline))
    total_messages = agg[0]["total"] if agg else 0
    profile = serialize_user(g.user)
    profile["totalConversations"] = total_conversations
    profile["totalMessages"] = total_messages
    return ok({"profile": profile})


@app.route("/api/profile", methods=["PUT"])
@auth_required()
def update_profile():
    data = request.get_json(silent=True) or {}
    updates = {}
    if "fullName" in data and data["fullName"].strip():
        updates["fullName"] = data["fullName"].strip()
    if "phone" in data:
        updates["phone"] = data["phone"].strip()
    if "avatar" in data:
        updates["avatar"] = data["avatar"]
    if updates:
        users_col.update_one({"_id": g.user["_id"]}, {"$set": updates})
    return ok(message="Profile updated.")


# ---------------------------------------------------------------------------
# SETTINGS
# ---------------------------------------------------------------------------
@app.route("/api/settings", methods=["GET"])
@auth_required()
def get_settings():
    s = settings_col.find_one({"userId": g.user["_id"]})
    if not s:
        s = {"theme": "dark", "language": "en", "responseStyle": "balanced",
             "emailNotifications": True, "chatNotifications": True, "aiModel": AI_MODEL}
    else:
        s.pop("_id", None)
        s.pop("userId", None)
    return ok({"settings": s})


@app.route("/api/settings", methods=["PUT"])
@auth_required()
def update_settings():
    data = request.get_json(silent=True) or {}
    allowed = {"theme", "language", "responseStyle", "emailNotifications",
               "chatNotifications", "aiModel"}
    updates = {k: v for k, v in data.items() if k in allowed}
    settings_col.update_one({"userId": g.user["_id"]}, {"$set": updates}, upsert=True)
    return ok(message="Settings saved.")


@app.route("/api/settings/clear-history", methods=["POST"])
@auth_required()
def clear_history():
    conversations_col.delete_many({"userId": g.user["_id"]})
    return ok(message="Conversation history cleared.")


@app.route("/api/settings/delete-account", methods=["POST"])
@auth_required()
def delete_account():
    conversations_col.delete_many({"userId": g.user["_id"]})
    settings_col.delete_many({"userId": g.user["_id"]})
    users_col.delete_one({"_id": g.user["_id"]})
    return ok(message="Account deleted.")


# ---------------------------------------------------------------------------
# TOOLS (direct endpoints, in addition to chat auto-routing)
# ---------------------------------------------------------------------------
@app.route("/api/tools/weather", methods=["POST"])
@auth_required()
def tool_weather():
    data = request.get_json(silent=True) or {}
    location = (data.get("location") or "").strip()
    if not location:
        return fail("Please provide a location.")
    result = call_weather_api(location)
    tool_usage_col.insert_one({"userId": g.user["_id"], "tool": "weather", "timestamp": datetime.now(timezone.utc)})
    return ok(result)


@app.route("/api/tools/news", methods=["POST"])
@auth_required()
def tool_news():
    data = request.get_json(silent=True) or {}
    topic = (data.get("topic") or "technology").strip().lower()
    result = call_news_api(topic)
    tool_usage_col.insert_one({"userId": g.user["_id"], "tool": "news", "timestamp": datetime.now(timezone.utc)})
    return ok(result)


@app.route("/api/tools/calculator", methods=["POST"])
@auth_required()
def tool_calculator():
    data = request.get_json(silent=True) or {}
    expr = (data.get("expression") or "").strip()
    if not CALC_RE.match(expr.replace("x", "*").replace("×", "*").replace("÷", "/")):
        return fail("Only basic arithmetic (+ - * / % and parentheses) is supported.")
    try:
        result = eval(expr.replace("x", "*").replace("×", "*").replace("÷", "/"),
                      {"__builtins__": {}}, {})
    except Exception:
        return fail("Couldn't evaluate that expression.")
    tool_usage_col.insert_one({"userId": g.user["_id"], "tool": "calculator", "timestamp": datetime.now(timezone.utc)})
    return ok({"expression": expr, "result": result})


# ---------------------------------------------------------------------------
# ADMIN
# ---------------------------------------------------------------------------
@app.route("/api/admin/stats", methods=["GET"])
@auth_required(admin_only=True)
def admin_stats():
    total_users = users_col.count_documents({})
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    active_users = conversations_col.distinct("userId", {"updatedAt": {"$gte": week_ago}})
    total_conversations = conversations_col.count_documents({})
    pipeline = [{"$project": {"count": {"$size": "$messages"}}},
                {"$group": {"_id": None, "total": {"$sum": "$count"}}}]
    agg = list(conversations_col.aggregate(pipeline))
    total_messages = agg[0]["total"] if agg else 0

    tool_pipeline = [{"$group": {"_id": "$tool", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}]
    popular_tools = list(tool_usage_col.aggregate(tool_pipeline))

    return ok({
        "totalUsers": total_users,
        "activeUsers": len(active_users),
        "totalConversations": total_conversations,
        "totalMessages": total_messages,
        "popularTools": [{"tool": t["_id"], "count": t["count"]} for t in popular_tools],
    })


@app.route("/api/admin/users", methods=["GET"])
@auth_required(admin_only=True)
def admin_users():
    users = users_col.find().sort("createdAt", DESCENDING).limit(100)
    return ok({"users": [serialize_user(u) for u in users]})


@app.route("/api/admin/conversations", methods=["GET"])
@auth_required(admin_only=True)
def admin_conversations():
    convos = conversations_col.find().sort("updatedAt", DESCENDING).limit(100)
    return ok({"conversations": [serialize_conversation(c, include_messages=False) for c in convos]})


# ---------------------------------------------------------------------------
# ERROR HANDLERS
# ---------------------------------------------------------------------------
@app.errorhandler(PyMongoError)
def handle_mongo_error(e):
    return fail("Unable to load your conversation. Please try again.", 500)


@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith("/api/"):
        return fail("Endpoint not found.", 404)
    return app.send_static_file("index.html")


# ---------------------------------------------------------------------------
# STATIC FILE SERVING (single-server deploy: Flask serves the frontend too)
# ---------------------------------------------------------------------------
@app.route("/")
def serve_index():
    return app.send_static_file("index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG", "0") == "1")
