"""PyThaiNLP wrapper: word segmentation (newmm) + POS tagging (orchid_ud) + number words."""
from __future__ import annotations

import re
import threading


class ThaiNLP:
    def __init__(self):
        self._lock = threading.Lock()
        self._ready = False
        self._error: str | None = None
        self.version = None

    def warmup(self):
        with self._lock:
            if self._ready or self._error:
                return
            try:
                import pythainlp
                from pythainlp import word_tokenize
                from pythainlp.tag import pos_tag

                word_tokenize("ทดสอบระบบ", engine="newmm")
                pos_tag(["ทดสอบ"], corpus="orchid_ud")
                self.version = getattr(pythainlp, "__version__", "?")
                self._ready = True
            except Exception as exc:  # pragma: no cover - depends on environment
                self._error = f"{type(exc).__name__}: {exc}"

    def info(self):
        self.warmup()
        if self._ready:
            return {"engine": f"PyThaiNLP {self.version} (newmm + orchid_ud POS)", "available": True}
        return {"engine": "unavailable", "available": False, "error": self._error}

    def analyze(self, text: str):
        self.warmup()
        if not self._ready:
            return {"available": False, "error": self._error, "tokens": [], "pos": []}
        from pythainlp import word_tokenize
        from pythainlp.tag import pos_tag
        from pythainlp.util import thaiword_to_num

        tokens = [t for t in word_tokenize(text, engine="newmm", keep_whitespace=False) if t.strip()]
        pos = pos_tag(tokens, corpus="orchid_ud")
        numbers = []
        for t in tokens:
            if re.fullmatch(r"[ก-๙]+", t):
                try:
                    numbers.append({"word": t, "value": thaiword_to_num(t)})
                except (ValueError, TypeError):
                    pass
        nouns = [w for w, tag in pos if tag in ("NOUN", "PROPN")]
        return {
            "available": True,
            "engine": f"PyThaiNLP {self.version}",
            "tokens": tokens,
            "pos": [{"w": w, "tag": tag} for w, tag in pos],
            "nouns": nouns,
            "numbers": numbers,
        }


NLP = ThaiNLP()
