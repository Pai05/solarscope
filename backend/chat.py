"""Help chat behind the site's chat widget.

Answers come from the built-in guide (help_kb) by default: offline, free, instant. If the server has Claude API
credentials (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN) and the `anthropic` package, questions are answered by
Claude grounded in the same guide, so free-form and follow-up questions work too. SOLARSCOPE_CHAT_AI=0 turns the
AI off. Any AI failure or refusal falls back to the guide answer, so the chat never breaks.
"""
from __future__ import annotations

import logging
import os

from backend import help_kb

log = logging.getLogger("solarscope.chat")

MODEL = "claude-opus-5-5"
PAGES = {"scan": "Phone scan", "image": "Image", "installers": "Installers", "home": "Home"}

SYSTEM_PROMPT = (
    "You are the help assistant inside SolarScope, a website that estimates rooftop solar for Indian homes. "
    "Answer the user's question about using the website from the guide below. Write for a home owner on a phone: "
    "short answers (usually under 120 words), numbered steps for anything they have to do, and the exact button "
    "and section names in **bold** as the guide writes them. Only describe features that are in the guide; if the "
    "guide does not cover something, say so and suggest the closest thing it does cover. For questions unrelated to "
    "SolarScope or rooftop solar, say briefly that you can only help with SolarScope. Plain text only, no tables "
    "or headings.\n\n# SolarScope guide\n\n" + help_kb.guide_text()
)

_client = None
_client_failed = False


def ai_enabled() -> bool:
    if os.environ.get("SOLARSCOPE_CHAT_AI", "1") == "0":
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _get_client():
    """Anthropic client, created once; None if the SDK is missing."""
    global _client, _client_failed
    if _client is None and not _client_failed:
        try:
            import anthropic
            _client = anthropic.Anthropic()
        except Exception as e:  # SDK not installed or misconfigured: stay on the guide
            log.warning("chat AI unavailable: %s", e)
            _client_failed = True
    return _client


def _ai_answer(message: str, page: str | None, history: list[dict]) -> str | None:
    """Claude's answer, or None to fall back to the guide."""
    client = _get_client()
    if client is None:
        return None
    import anthropic

    msgs = [{"role": h["role"], "content": h["text"]} for h in history]
    while msgs and msgs[0]["role"] != "user":  # the conversation must start with the user
        msgs.pop(0)
    where = PAGES.get(page or "")
    msgs.append({"role": "user", "content": (f"(I am on the {where} page.) " if where else "") + message})
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",  # on a safety decline the API retries on a suitable model in the same call
            output_config={"effort": "low"},  # short help answers do not need deep thinking
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=msgs,
        )
    except anthropic.RateLimitError:
        log.warning("chat AI rate limited; answering from the guide")
        return None
    except anthropic.APIStatusError as e:
        log.warning("chat AI error %s: %s", e.status_code, e.message)
        return None
    except anthropic.APIConnectionError:
        log.warning("chat AI unreachable; answering from the guide")
        return None
    if resp.stop_reason == "refusal":
        return None
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    return text or None


def _budget_reply(req: dict, page: str | None) -> dict:
    """The user stated a budget: the page sets it and recomputes the plan (action "set_budget")."""
    basis = "cost after subsidy" if req["basis"] == "net" else "full upfront cost"
    if page in ("scan", "image"):
        text = (f"Got it: I've set **My budget** to **₹{help_kb.inr(req['amount'])}** ({basis}). "
                "I'll plan the biggest system that fits it on your roof and update the report.")
    else:
        text = (f"Got it: your budget is **₹{help_kb.inr(req['amount'])}** ({basis}). Open the **Phone scan** or "
                "**Image** page, measure your roof and compute the report: the budget is already filled in there.")
    if req["basis"] == "net":
        text += " To count the full upfront price instead, say \"upfront\" or change **Budget covers**."
    return {"answer": text, "suggestions": ["Planning for your budget", "PM Surya Ghar subsidy"], "source": "guide",
            "action": {"type": "set_budget", "amount": req["amount"], "basis": req["basis"]}}


def reply(message: str, page: str | None = None, history: list[dict] | None = None) -> dict:
    """{"answer", "suggestions", "source"[, "action"]}; source is "ai" or "guide"."""
    budget_req = help_kb.budget_request(message)
    if budget_req:
        return _budget_reply(budget_req, page)
    guide = help_kb.answer(message)
    if ai_enabled():
        text = _ai_answer(message, page, history or [])
        if text:
            return {"answer": text, "suggestions": guide["suggestions"], "source": "ai"}
    return {"answer": guide["answer"], "suggestions": guide["suggestions"], "source": "guide"}
